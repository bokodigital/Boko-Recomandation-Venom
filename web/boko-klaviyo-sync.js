// BOKO KLAVIYO SYNC — v3: profile sync worker + click event client + PER-CUSTOMER picks.
// v3 additions (Step 9): /klaviyo/custmap builds an email -> last-purchase map from Shopify
// orders; the sync then personalises "Selected For You" per profile using the store's
// Complete-the-Look pairing cache (bkl_ctl:{shop}:{productId}) for the customer's last
// purchased product, falling back to best-sellers for customers with no known purchase.
// Additive and self-contained; safe to remove (delete file + wired lines in server.js).
import { kvGet, kvSet, mintToken } from "./boko-klaviyo.js";

const SECRET = process.env.BOKO_KLAVIYO_KEY || "bkl7391x";
const HOST = process.env.BOKO_PUBLIC_HOST || "boko-reco-app--admin7695.replit.app";
const REV = "2025-07-15";

// Per-store key: dashboard-connected key (bkl_kcfg:{shop}) first, env var as fallback.
async function keyFor(shop) {
  try {
    const cfg = await kvGet("bkl_kcfg:" + shop);
    if (cfg && cfg.api_key) return cfg.api_key;
  } catch (e) {}
  return process.env.KLAVIYO_API_KEY || "";
}

async function kapi(key, path, method, body, attempt) {
  const r = await fetch("https://a.klaviyo.com/api" + path, {
    method: method || "GET",
    headers: {
      Authorization: "Klaviyo-API-Key " + key,
      accept: "application/vnd.api+json",
      "content-type": "application/vnd.api+json",
      revision: REV,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429 && (attempt || 0) < 4) {
    const wait = parseInt(r.headers.get("Retry-After"), 10) || 5;
    await new Promise((ok) => setTimeout(ok, wait * 1000));
    return kapi(key, path, method, body, (attempt || 0) + 1);
  }
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { status: r.status, json };
}

function tokUrl(shop, item, m, anchorId, idx, algo, email) {
  return "https://" + HOST + "/r/" + mintToken({
    s: shop, h: item.handle || "", m: m, a: anchorId || "", i: item.id || "",
    n: idx + 1, g: algo || "v1", c: "profile", p: email || "",
  });
}

// Property schema is unchanged from v1 (so existing blocks/templates keep working),
// but when `personal` is provided the SFY slots are the customer's own Complete-the-Look
// picks (from their last purchase) instead of store-wide best-sellers.
function buildProps(shop, best, ctl, email, personal) {
  const props = {
    boko_algo: personal ? "v2-personal" : "v1",
    boko_source: personal ? "sync-v2-personal" : "sync-v2-best",
    boko_updated_at: new Date().toISOString(),
  };
  const pAnchor = (personal && personal.anchor) || {};
  const sfySrc = personal && (personal.items || []).length ? personal.items : ((best && best.items) || []);
  const sfyAnchorId = personal ? (pAnchor.id || "") : "";
  props.boko_sfy = sfySrc.slice(0, 4).map(function (it, i) {
    return {
      title: it.title, price: it.price, handle: it.handle, image: it.image,
      url: tokUrl(shop, it, "sfy", sfyAnchorId, i, personal ? (personal.algo || "v2") : (best && best.algo), email),
    };
  });
  props.boko_sfy.forEach(function (it, i) {
    props["boko_sfy_" + (i + 1) + "_title"] = it.title;
    props["boko_sfy_" + (i + 1) + "_price"] = it.price;
    props["boko_sfy_" + (i + 1) + "_image"] = it.image;
    props["boko_sfy_" + (i + 1) + "_url"] = it.url;
  });
  if (personal && (pAnchor.title || pAnchor.id)) {
    props.boko_sfy_basis = "Because you bought " + (pAnchor.title || "a recent favourite");
  }
  const ctlSrc = personal && (personal.items || []).length ? personal : ctl;
  if (ctlSrc && (ctlSrc.items || []).length) {
    const a = ctlSrc.anchor || {};
    props.boko_ctl = {
      anchor_id: a.id || "", anchor_title: a.title || "", anchor_handle: a.handle || "",
      items: ctlSrc.items.slice(0, 4).map(function (it, i) {
        return {
          title: it.title, price: it.price, handle: it.handle, image: it.image,
          url: tokUrl(shop, it, "ctl", a.id, i, ctlSrc.algo, email),
        };
      }),
    };
    props.boko_ctl_anchor_title = a.title || "";
    props.boko_ctl_anchor_id = a.id || "";
  }
  return props;
}

// Fire "Boko Recommendation Clicked" back into Klaviyo (used by the redirect hook).
export async function trackClick(p) {
  if (!p || !p.p || String(p.p).indexOf("@") < 0 || !p.s) return;
  const key = await keyFor(p.s);
  if (!key) return;
  await kapi(key, "/events", "POST", {
    data: {
      type: "event",
      attributes: {
        properties: {
          module: p.m || "", anchor: p.a || "", item: p.i || "",
          position: p.n || 0, campaign: p.c || "", algorithm: p.g || "",
        },
        metric: { data: { type: "metric", attributes: { name: "Boko Recommendation Clicked" } } },
        profile: { data: { type: "profile", attributes: { email: p.p } } },
      },
    },
  });
}

const CMAP_ORDERS_Q = "query BkCm($n:Int!,$q:String,$after:String){ orders(first:$n, reverse:true, query:$q, after:$after){ pageInfo{hasNextPage endCursor} edges{ node{ createdAt email lineItems(first:10){edges{node{ product{ id } }}} } } } }";

export function mountKlaviyoSync(app, deps) {
  const getToken = deps && deps.getToken;
  const gql = deps && deps.gql;

  // Redirect click hook — boko-klaviyo.js calls this after logging a click.
  globalThis.__bklClickHook = function (p) { trackClick(p).catch(function () {}); };

  // Config check: is the key in place yet?
  app.get("/klaviyo/synccfg", (req, res) => {
    if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
    const shop = String(req.query.shop || "");
    (async () => {
      const shopKey = shop ? await keyFor(shop) : "";
      const cfg = shop ? await kvGet("bkl_kcfg:" + shop) : null;
      const cmap = shop ? await kvGet("bkl_cmap:" + shop) : null;
      res.json({
        env_key_set: !!process.env.KLAVIYO_API_KEY,
        shop: shop || null,
        shop_key_set: !!(cfg && cfg.api_key),
        effective_key: !!shopKey,
        account_name: (cfg && cfg.account_name) || null,
        custmap_customers: (cmap && cmap.customers) || 0,
        custmap_built_at: (cmap && cmap.built_at) || null,
        host: HOST,
      });
    })().catch((e) => res.status(500).json({ error: e.message }));
  });

  // Build the customer purchase map: email -> product ids from their MOST RECENT order.
  // Used by the sync to personalise Selected For You. Secret-keyed; GET ok for nightly job.
  //   shop (required) · days=N (default 365, max 730) · pages=N (default 12, max 20)
  app.all("/klaviyo/custmap", async (req, res) => {
    try {
      if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
      const shop = String(req.query.shop || "");
      if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) return res.status(400).json({ error: "bad shop" });
      if (!getToken || !gql) return res.json({ ok: false, error: "custmap not wired with getToken/gql" });
      const token = await getToken(shop);
      if (!token) return res.json({ ok: false, error: "no shop token" });
      const days = Math.max(30, Math.min(730, parseInt(req.query.days, 10) || 365));
      const maxPages = Math.max(1, Math.min(20, parseInt(req.query.pages, 10) || 12));
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      let after = null, pages = 0, scanned = 0;
      const map = {};
      while (pages < maxPages) {
        const j = await gql(shop, token, CMAP_ORDERS_Q, { n: 100, q: "created_at:>=" + since, after: after });
        if (j.errors) return res.json({ ok: false, error: "orders query failed: " + JSON.stringify(j.errors).slice(0, 200) });
        const conn = j.data && j.data.orders;
        const edges = (conn && conn.edges) || [];
        for (const e of edges) {
          const o = (e && e.node) || {};
          scanned++;
          const em = String(o.email || "").toLowerCase();
          if (em.indexOf("@") < 0 || map[em]) continue; // orders come newest-first: first hit = latest order
          const pids = [];
          for (const le of ((o.lineItems && o.lineItems.edges) || [])) {
            const pid = String((le.node && le.node.product && le.node.product.id) || "").split("/").pop();
            if (pid && pids.indexOf(pid) < 0) pids.push(pid);
            if (pids.length >= 3) break;
          }
          if (pids.length) map[em] = { t: o.createdAt, p: pids };
        }
        const pi = conn && conn.pageInfo;
        pages++;
        if (!pi || !pi.hasNextPage) break;
        after = pi.endCursor;
      }
      const out = { shop: shop, days: days, orders_scanned: scanned, customers: Object.keys(map).length, built_at: new Date().toISOString(), map: map };
      await kvSet("bkl_cmap:" + shop, out);
      res.json({ ok: true, shop: shop, days: days, orders_scanned: scanned, customers: out.customers, built_at: out.built_at });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Full profile sync. Secret-keyed; GET allowed for the nightly job. Options:
  //   shop (required) · limit=N (default 100, max 2000) · dry=1 (count, write nothing)
  // Targets profiles active in the last 180 days; skips profiles refreshed <20h ago.
  app.all("/klaviyo/sync", async (req, res) => {
    try {
      if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
      const shop = String(req.query.shop || "");
      if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) return res.status(400).json({ error: "bad shop" });
      const kk = await keyFor(shop);
      if (!kk) {
        return res.json({ ok: false, configured: false, error: "No Klaviyo API key for this store. Connect Klaviyo from the app dashboard (Klaviyo Settings card), or set the KLAVIYO_API_KEY secret as a global fallback." });
      }
      const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit, 10) || 100));
      const dry = String(req.query.dry || "") === "1";
      const best = await kvGet("bkl_best:" + shop);
      if (!best || !(best.items || []).length) {
        return res.json({ ok: false, error: "recommendation cache empty - run /klaviyo/recompute first" });
      }
      const status = await kvGet("bkl_status:" + shop);
      const ctlKey = String(req.query.anchor || "");
      const ctl = ctlKey ? await kvGet("bkl_ctl:" + shop + ":" + ctlKey) : null;
      const cmapDoc = await kvGet("bkl_cmap:" + shop);
      const cmap = (cmapDoc && cmapDoc.map) || {};
      const ctlCache = {}; // per-run memo of bkl_ctl lookups
      const cutoff = new Date(Date.now() - 180 * 86400000).toISOString();
      const freshMs = 20 * 3600 * 1000;
      let scanned = 0, patched = 0, skipped = 0, failed = 0, personalized = 0, done = false;
      let path = "/profiles?sort=-updated&page%5Bsize%5D=100";
      while (!done && path && scanned < limit) {
        const page = await kapi(kk, path);
        if (page.status !== 200 || !page.json || !page.json.data) {
          return res.json({ ok: false, error: "klaviyo profiles fetch failed (status " + page.status + ")", scanned, patched });
        }
        for (const prof of page.json.data) {
          if (scanned >= limit) { done = true; break; }
          scanned++;
          const at = prof.attributes || {};
          if (at.updated && at.updated < cutoff) { done = true; break; }
          if (at.last_event_date && at.last_event_date < cutoff) { skipped++; continue; }
          if (!at.email) { skipped++; continue; }
          const pr = at.properties || {};
          if (!dry && pr.boko_updated_at && Date.now() - new Date(pr.boko_updated_at).getTime() < freshMs) { skipped++; continue; }
          // Personal picks: customer's last purchase -> Complete-the-Look cache.
          let personal = null;
          const ent = cmap[String(at.email).toLowerCase()];
          if (ent && ent.p) {
            for (const pid of ent.p) {
              if (!(pid in ctlCache)) ctlCache[pid] = await kvGet("bkl_ctl:" + shop + ":" + pid);
              const c = ctlCache[pid];
              if (c && (c.items || []).length) { personal = c; break; }
            }
          }
          if (dry) { patched++; if (personal) personalized++; continue; }
          const props = buildProps(shop, best, ctl, at.email, personal);
          const r = await kapi(kk, "/profiles/" + prof.id + "/", "PATCH", {
            data: { type: "profile", id: prof.id, attributes: { properties: props } },
          });
          if (r.status >= 200 && r.status < 300) { patched++; if (personal) personalized++; } else failed++;
        }
        const next = page.json.links && page.json.links.next;
        path = next ? String(next).replace("https://a.klaviyo.com/api", "") : null;
      }
      const summary = {
        shop, scanned, patched, skipped, failed, personalized, dry,
        custmap_customers: (cmapDoc && cmapDoc.customers) || 0,
        cache_at: (status && status.at) || null,
        at: new Date().toISOString(),
      };
      await kvSet("bkl_sync:" + shop, summary);
      res.json(Object.assign({ ok: true, configured: true }, summary));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
