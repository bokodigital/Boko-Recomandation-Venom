// BOKO KLAVIYO ATTRIB — Step 6: joins email recommendation clicks to Shopify orders.
// Additive and self-contained; safe to remove (delete file + wired lines in server.js).
// Attribution rule: an order counts when the SAME customer email clicked a tracked email
// recommendation link within the 7 days before the order. Orders that also carry the on-site
// _boko_vid cart attribute (already credited by App Impact) are flagged as overlap so combined
// reporting never double-counts revenue. Results stored in bkl_kv as bkl_attrib:{shop}.
import { kvGet, kvSet } from "./boko-klaviyo.js";

const SECRET = process.env.BOKO_KLAVIYO_KEY || "bkl7391x";
const WINDOW_MS = 7 * 86400000;

const ORDERS_Q = "query BkA($n:Int!,$q:String,$after:String){ orders(first:$n, reverse:true, query:$q, after:$after){ pageInfo{hasNextPage endCursor} edges{ node{ id name createdAt email totalPriceSet{shopMoney{amount}} customAttributes{key value} lineItems(first:50){edges{node{ quantity discountedTotalSet{shopMoney{amount}} product{ id } }}} } } } }";

export function mountKlaviyoAttrib(app, deps) {
  const getToken = deps && deps.getToken;
  const gql = deps && deps.gql;

  // Secret-keyed; GET allowed for the nightly job. Options: shop (required) · days=N (1-30, default 7)
  app.all("/klaviyo/attrib", async (req, res) => {
    try {
      if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
      const shop = String(req.query.shop || "");
      if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) return res.status(400).json({ error: "bad shop" });
      const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 7));
      const token = await getToken(shop);
      if (!token) return res.json({ ok: false, error: "no shop token" });

      // 1. Identity clicks from the click log (only events carrying the recipient email).
      const clicks = new Map();
      let clickCount = 0;
      for (let i = 0; i <= days; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const v = await kvGet("bkl_click:" + shop + ":" + d);
        const evs = (v && v.events) || [];
        for (const e of evs) {
          const em = String(e.p || "").toLowerCase();
          if (em.indexOf("@") < 0) continue;
          if (!clicks.has(em)) clicks.set(em, []);
          clicks.get(em).push({ t: e.t, i: String(e.i || "") });
          clickCount++;
        }
      }

      // 2. Recent orders (same gql plumbing the stats bar uses).
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      let after = null;
      let pages = 0;
      let orders = [];
      while (pages < 6) {
        const j = await gql(shop, token, ORDERS_Q, { n: 100, q: "created_at:>=" + since, after: after });
        if (j.errors) {
          return res.json({ ok: false, error: "orders query failed: " + JSON.stringify(j.errors).slice(0, 300) });
        }
        const conn = j.data && j.data.orders;
        orders = orders.concat((conn && conn.edges) || []);
        const pi = conn && conn.pageInfo;
        pages++;
        if (!pi || !pi.hasNextPage) break;
        after = pi.endCursor;
      }

      // 3. Join clicks -> orders, with on-site overlap dedupe flag.
      let attributed = 0, revenue = 0, itemRevenue = 0, overlap = 0, overlapRevenue = 0, emailsSeen = 0;
      const samples = [];
      for (const edge of orders) {
        const o = (edge && edge.node) || {};
        const em = String(o.email || "").toLowerCase();
        if (em.indexOf("@") >= 0) emailsSeen++;
        const cl = clicks.get(em);
        if (!cl || !cl.length) continue;
        const ot = new Date(o.createdAt).getTime();
        const hits = cl.filter(function (c) {
          const ct = new Date(c.t).getTime();
          return ct <= ot && ot - ct <= WINDOW_MS;
        });
        if (!hits.length) continue;
        attributed++;
        const total = parseFloat((o.totalPriceSet && o.totalPriceSet.shopMoney && o.totalPriceSet.shopMoney.amount) || 0) || 0;
        revenue += total;
        const clickedIds = new Set(hits.map(function (h) { return h.i; }).filter(Boolean));
        const les = (o.lineItems && o.lineItems.edges) || [];
        for (const le of les) {
          const li = (le && le.node) || {};
          const pid = String((li.product && li.product.id) || "").split("/").pop();
          if (clickedIds.has(pid)) {
            itemRevenue += parseFloat((li.discountedTotalSet && li.discountedTotalSet.shopMoney && li.discountedTotalSet.shopMoney.amount) || 0) || 0;
          }
        }
        const attrs = o.customAttributes || [];
        const onsite = attrs.some(function (a) { return a && a.key === "_boko_vid"; });
        if (onsite) { overlap++; overlapRevenue += total; }
        if (samples.length < 10) samples.push({ order: o.name, total: total, onsite: onsite });
      }

      const summary = {
        shop: shop, days: days,
        clicks_identity: clickCount, clickers: clicks.size,
        orders_scanned: orders.length, orders_with_email: emailsSeen,
        attributed_orders: attributed,
        attributed_revenue: Math.round(revenue * 100) / 100,
        clicked_item_revenue: Math.round(itemRevenue * 100) / 100,
        overlap_with_onsite_orders: overlap,
        overlap_with_onsite_revenue: Math.round(overlapRevenue * 100) / 100,
        email_incremental_revenue: Math.round((revenue - overlapRevenue) * 100) / 100,
        samples: samples,
        at: new Date().toISOString(),
      };
      await kvSet("bkl_attrib:" + shop, summary);
      res.json(Object.assign({ ok: true }, summary));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
