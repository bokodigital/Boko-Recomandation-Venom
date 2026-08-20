// BOKO KLAVIYO MODULE — Step 1: recommendation cache + recompute endpoint.
//                       Step 2: redirect service /r/:token (302 + click log + UTMs).
// Additive and self-contained; safe to remove. Wired via mountKlaviyo(app, deps) in server.js.
// Storage: existing boko_kv Postgres table, key prefixes bkl_* only.
// Never touches /stats, funnels, Repl KV, boko-impact or boko-cr.
import pg from "pg";
import crypto from "crypto";

let pool = null;
function db() {
  if (!pool) {
    const url = process.env.DATABASE_URL || "";
    pool = url ? new pg.Pool({ connectionString: url, max: 3 }) : null;
  }
  return pool;
}
async function ensure() {
  const p = db();
  if (!p) return false;
  await p.query("CREATE TABLE IF NOT EXISTS boko_kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)");
  return true;
}
export async function kvSet(k, v) {
  const p = db();
  if (!p) return;
  await p.query("INSERT INTO boko_kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=$2", [k, v]);
}
export async function kvGet(k) {
  const p = db();
  if (!p) return null;
  const r = await p.query("SELECT v FROM boko_kv WHERE k=$1", [k]);
  return r.rows[0] ? r.rows[0].v : null;
}

const SECRET = process.env.BOKO_KLAVIYO_KEY || "bkl7391x";

// ---------- Step 2: signed redirect tokens ----------
function b64u(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString("utf8");
}
export function sign(payloadB64) {
  return b64u(crypto.createHmac("sha256", SECRET).update(payloadB64).digest()).slice(0, 22);
}
export function mintToken(payload) {
  const p = b64u(JSON.stringify(payload));
  return p + "." + sign(p);
}
function readToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  let expected;
  try { expected = sign(parts[0]); } catch (e) { return null; }
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[1]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(unb64u(parts[0])); } catch (e) { return null; }
}

function pid(p) {
  return String((p && p.id) || "").split("/").pop();
}
function toItem(shop, p) {
  return {
    id: pid(p),
    title: p.title || "",
    handle: p.handle || "",
    price: p.price || 0,
    image: p.img || "",
    url: "https://" + shop + "/products/" + (p.handle || ""),
    category: p.category || "",
    vendor: p.vendor || "",
  };
}

export function mountKlaviyo(app, deps) {
  const { getToken, loadProducts, recommend, complementaryPool } = deps;

  async function computeShop(shop, opts) {
    const o = opts || {};
    const token = await getToken(shop);
    if (!token) throw new Error("no token for " + shop);
    const products = await loadProducts(shop, token, 100);
    const maxAnchors = Math.min(products.length, o.maxAnchors || 60);
    const perAnchor = o.perAnchor || 4;
    let done = 0;
    let skipped = 0;
    for (const anchor of products.slice(0, maxAnchors)) {
      try {
        const anum = pid(anchor);
        let picks = [];
        const cp = complementaryPool(products, anchor.category, anum);
        if (cp && cp.length) {
          picks = await recommend({ products: cp, anchor: null, limit: perAnchor, useLLM: false });
        }
        if (!picks || !picks.length) { skipped++; continue; }
        await kvSet("bkl_ctl:" + shop + ":" + anum, {
          anchor: toItem(shop, anchor),
          items: picks.slice(0, perAnchor).map((p) => toItem(shop, p)),
          algo: "ctl-v1-complement",
          at: new Date().toISOString(),
        });
        done++;
      } catch (e) { skipped++; }
    }
    const best = await recommend({ products, anchor: null, limit: 8, useLLM: false });
    await kvSet("bkl_best:" + shop, {
      items: (best || []).map((p) => toItem(shop, p)),
      algo: "best-v1",
      at: new Date().toISOString(),
    });
    const summary = {
      shop,
      products: products.length,
      ctl_cached: done,
      ctl_skipped: skipped,
      at: new Date().toISOString(),
    };
    await kvSet("bkl_status:" + shop, summary);
    return summary;
  }

  // Recompute the cache for one shop. Secret-keyed; GET allowed so a scheduled job can hit it.
  app.all("/klaviyo/recompute", async (req, res) => {
    try {
      if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
      if (!(await ensure())) return res.status(503).json({ error: "no database" });
      const shop = String(req.query.shop || "");
      if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) return res.status(400).json({ error: "bad shop" });
      const summary = await computeShop(shop, {
        maxAnchors: parseInt(req.query.max, 10) || 60,
        perAnchor: parseInt(req.query.per, 10) || 4,
      });
      res.json(Object.assign({ ok: true }, summary));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/klaviyo/health", async (req, res) => {
    try {
      const shop = String(req.query.shop || "");
      const st = shop ? await kvGet("bkl_status:" + shop) : null;
      res.json({ ok: true, db: !!db(), status: st });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ---------- Step 2: redirect service ----------
  // Click log: read-modify-write on a per-shop-per-day key. Fine at email volumes.
  async function logClick(p) {
    try {
      if (!(await ensure())) return;
      const day = new Date().toISOString().slice(0, 10);
      const k = "bkl_click:" + (p.s || "unknown") + ":" + day;
      const cur = (await kvGet(k)) || { total: 0, mod: {}, events: [] };
      cur.total = (cur.total || 0) + 1;
      const m = p.m || "unknown";
      cur.mod = cur.mod || {};
      cur.mod[m] = (cur.mod[m] || 0) + 1;
      cur.events = cur.events || [];
      cur.events.push({
        t: new Date().toISOString(),
        m: m, a: p.a || "", i: p.i || "", n: p.n || 0,
        c: p.c || "", p: p.p || "", g: p.g || "",
      });
      if (cur.events.length > 300) cur.events = cur.events.slice(-300);
      await kvSet(k, cur);
      if (globalThis.__bklClickHook) { try { globalThis.__bklClickHook(p); } catch (e) {} }
    } catch (e) { /* never block or fail the redirect on logging */ }
  }

  // Public redirect: verify token, 302 to the product with UTMs, log async.
  // Cache/DB-free on the hot path — destination comes entirely from the token.
  app.get("/r/:token", (req, res) => {
    const p = readToken(req.params.token);
    if (!p || !/^[a-z0-9-]+\.myshopify\.com$/.test(p.s || "")) {
      return res.status(404).send("link expired");
    }
    const path = p.h ? "/products/" + encodeURIComponent(p.h) : "/collections/all";
    const utm =
      "utm_source=boko-reco&utm_medium=email" +
      "&utm_campaign=" + encodeURIComponent(p.c || p.m || "boko") +
      "&utm_content=" + encodeURIComponent((p.m || "rec") + "-pos" + (p.n || 0));
    logClick(p); // fire and forget
    res.redirect(302, "https://" + p.s + path + "?" + utm);
  });

  // Secret-keyed token mint — used by later steps (feeds/blocks) and for testing.
  app.get("/klaviyo/token", (req, res) => {
    if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
    const q = req.query;
    const payload = {
      s: String(q.shop || ""), h: String(q.handle || ""),
      m: String(q.m || "ctl"), a: String(q.a || ""), i: String(q.i || ""),
      n: parseInt(q.n, 10) || 0, g: String(q.g || "v1"),
      c: String(q.c || ""), p: String(q.p || ""),
    };
    const token = mintToken(payload);
    res.json({ token: token, url: "/r/" + token });
  });

  // Secret-keyed click counters read-back.
  app.get("/klaviyo/clicks", async (req, res) => {
    try {
      if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
      const shop = String(req.query.shop || "");
      const day = String(req.query.day || new Date().toISOString().slice(0, 10));
      const v = await kvGet("bkl_click:" + shop + ":" + day);
      res.json({ shop: shop, day: day, clicks: v || { total: 0, mod: {}, events: [] } });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Secret-keyed read-back used by later steps (feeds, sync worker) and for verification.
  app.get("/klaviyo/peek", async (req, res) => {
    try {
      if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
      const v = await kvGet(String(req.query.k || ""));
      res.json({ k: String(req.query.k || ""), v });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
