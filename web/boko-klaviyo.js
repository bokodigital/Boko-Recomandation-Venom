// BOKO KLAVIYO MODULE — Step 1: recommendation cache + recompute endpoint.
// Additive and self-contained; safe to remove. Wired via mountKlaviyo(app, deps) in server.js.
// Storage: existing boko_kv Postgres table, key prefixes bkl_* only.
// Never touches /stats, funnels, Repl KV, boko-impact or boko-cr.
import pg from "pg";

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
async function kvSet(k, v) {
  const p = db();
  if (!p) return;
  await p.query("INSERT INTO boko_kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=$2", [k, v]);
}
async function kvGet(k) {
  const p = db();
  if (!p) return null;
  const r = await p.query("SELECT v FROM boko_kv WHERE k=$1", [k]);
  return r.rows[0] ? r.rows[0].v : null;
}

const SECRET = process.env.BOKO_KLAVIYO_KEY || "bkl7391x";

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
