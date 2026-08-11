// boko-impact.js — SELF-CONTAINED "App Impact" module — PHASE 1: AOV Improvement.
//
// Shows a merchant how much extra order value our recommendations drove, using
// the add-to-cart tags the widget ALREADY emits (`_boko_reco` / `_boko_bundle`)
// as they appear on completed orders. No change to the recommender or any
// existing metric — this module only READS orders and writes its OWN DB keys.
//
// Method (from the App Impact Metrics design, Tier 2 "attributed within-period"):
//   attributed_revenue = Σ line items on real orders that carry `_boko_reco`
//   AOV uplift %        = attributed_revenue / (revenue − attributed_revenue) × k
//   added $ / order     = attributed_revenue / orders × k         (k = incrementality, default 0.7)
//   + plain "$ attributed" and "% of orders influenced" (least-attackable numbers)
//
// ── To REMOVE this feature ─────────────────────────────────────────────────
//   1. delete this file
//   2. in server.js: delete the `import { mountImpact, impactCardHtml, impactScript } …`
//      line, the `mountImpact(app, {…})` call, and the two dashboard placeholders
//      __BOKO_IMPACT_CARD__ / __BOKO_IMPACT_SCRIPT__ (+ their .replace() calls).
//   (Its DB keys `boko_daily:*`, `boko_impact_*`, `boko_oid:*` can be left or purged.)
// ── To REUSE elsewhere ─────────────────────────────────────────────────────
//   mountImpact(app, { shopFromToken, getToken, tokenExchange, gql, apiSecret, host, api });
//   inject impactCardHtml() + impactScript() into your page.
// ───────────────────────────────────────────────────────────────────────────

import Database from "@replit/database";

// ── Show / hide the dashboard UI (all backend keeps working when false) ──
const SHOW_IMPACT_UI = true;

// Lazy, defensive DB client — never throws at import time.
let _idb = null;
function db() {
  if (_idb === null) {
    try {
      _idb = new Database();
    } catch (e) {
      _idb = false;
    }
  }
  return _idb || null;
}
async function dbGet(key) {
  try {
    const d = db();
    if (!d) return null;
    const r = await d.get(key);
    return r && typeof r === "object" && "ok" in r
      ? r.ok
        ? r.value
        : null
      : r;
  } catch (e) {
    return null;
  }
}
async function dbSet(key, val) {
  try {
    const d = db();
    if (d) await d.set(key, val);
  } catch (e) {}
}

const DEFAULT_K = 0.7; // incrementality factor (honesty correction)
const BACKFILL_DAYS = 90; // history pulled on first load
const MIN_ORDERS = 30; // don't headline a lift below this sample

const sh = (shop) => String(shop || "").toLowerCase();
const dayKey = (shop, date) => "boko_daily_v2:" + sh(shop) + ":" + date;
const metaKey = (shop) => "boko_impact_meta_v2:" + sh(shop);
const cfgKey = (shop) => "boko_impact_cfg:" + sh(shop);
// Normalise order id so a webhook's REST id ("1001") and Admin GraphQL's
// gid ("gid://shopify/Order/1001") dedupe to the SAME key — prevents backfill
// double-counting orders that also arrive live.
const normId = (id) => {
  const m = String(id == null ? "" : id).match(/(\d+)(?!.*\d)/);
  return m ? m[1] : String(id);
};
const oidKey = (shop, id) => "boko_oid_v2:" + sh(shop) + ":" + normId(id);

// UTC date (YYYY-MM-DD). NB: aggregates by UTC day — fine for lift %, note in docs if a shop wants local-day buckets.
function isoDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}
function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// ── Attribution ────────────────────────────────────────────────────────────
// True if a line item was added by our widget. Webhook JSON: properties = [{name,value}].
function isAttributedLine(props) {
  const arr = Array.isArray(props) ? props : [];
  return arr.some(
    (p) => p && /^_boko_reco$/.test(String(p.name || p.key || "")),
  );
}
// Parse a webhook (REST/JSON) order → {id, date, revenue, attributed, influenced}
function parseWebhookOrder(order) {
  const items = order.line_items || [];
  let attributed = 0,
    influenced = false;
  for (const it of items) {
    if (isAttributedLine(it.properties)) {
      influenced = true;
      const gross = num(it.price) * (it.quantity || 1);
      attributed += Math.max(0, gross - num(it.total_discount));
    }
  }
  // subtotal (merchandise, pre-tax/shipping) is the cleanest AOV basis; fall back to total.
  const revenue = num(
    order.subtotal_price != null ? order.subtotal_price : order.total_price,
  );
  return {
    id: String(order.id),
    date: isoDay(order.created_at || Date.now()),
    revenue,
    attributed,
    influenced,
  };
}

// Record ONE order into its daily bucket, deduped by order id (safe for webhook re-delivery
// AND for backfill overlapping live traffic — both go through here).
async function recordOrder(shop, o) {
  if (!o || !o.id) return false;
  if (await dbGet(oidKey(shop, o.id))) return false; // already counted
  await dbSet(oidKey(shop, o.id), 1);
  const key = dayKey(shop, o.date);
  const row = (await dbGet(key)) || {
    orders: 0,
    revenue: 0,
    influenced_orders: 0,
    attributed_revenue: 0,
  };
  row.orders += 1;
  row.revenue += o.revenue;
  if (o.influenced) row.influenced_orders += 1;
  row.attributed_revenue += o.attributed;
  await dbSet(key, row);
  return true;
}

// ── Backfill last N days via Admin GraphQL (runs once; dedupe makes it idempotent) ──
async function backfill(shop, token, deps, days) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  let cursor = null,
    pages = 0,
    seen = 0;
  const q = `query($q:String!,$after:String){ orders(first:100, query:$q, sortKey:CREATED_AT, after:$after){
      edges{ cursor node{ id createdAt
        subtotalPriceSet{ shopMoney{ amount } } totalPriceSet{ shopMoney{ amount } }
        lineItems(first:100){ edges{ node{ quantity
          discountedTotalSet{ shopMoney{ amount } } originalTotalSet{ shopMoney{ amount } }
          customAttributes{ key value } } } } } }
      pageInfo{ hasNextPage endCursor } } }`;
  do {
    const data = await deps.gql(shop, token, q, {
      q: "created_at:>=" + since,
      after: cursor,
    });
    const conn = data && data.data && data.data.orders;
    if (!conn) break;
    for (const edge of conn.edges || []) {
      const n = edge.node;
      if (!n) continue;
      const items = (n.lineItems && n.lineItems.edges) || [];
      let attributed = 0,
        influenced = false;
      for (const le of items) {
        const li = le.node;
        if (!li) continue;
        if (isAttributedLine(li.customAttributes)) {
          influenced = true;
          const amt =
            num(
              li.discountedTotalSet &&
                li.discountedTotalSet.shopMoney &&
                li.discountedTotalSet.shopMoney.amount,
            ) ||
            num(
              li.originalTotalSet &&
                li.originalTotalSet.shopMoney &&
                li.originalTotalSet.shopMoney.amount,
            );
          attributed += amt;
        }
      }
      const revenue =
        num(
          n.subtotalPriceSet &&
            n.subtotalPriceSet.shopMoney &&
            n.subtotalPriceSet.shopMoney.amount,
        ) ||
        num(
          n.totalPriceSet &&
            n.totalPriceSet.shopMoney &&
            n.totalPriceSet.shopMoney.amount,
        );
      if (
        await recordOrder(shop, {
          id: String(n.id),
          date: isoDay(n.createdAt),
          revenue,
          attributed,
          influenced,
        })
      )
        seen++;
      cursor = edge.cursor;
    }
    pages++;
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  } while (pages < 60); // safety cap (~6000 orders)
  return seen;
}

// Ensure the orders/create webhook exists (idempotent; ignores "already exists").
async function ensureWebhook(shop, token, deps, meta) {
  if (meta && meta.hook) return meta;
  try {
    await deps.gql(
      shop,
      token,
      `mutation($u:URL!){ webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription:{ callbackUrl:$u, format: JSON }){ userErrors{ message } } }`,
      { u: deps.host + "/webhooks/orders_create" },
    );
  } catch (e) {}
  const m = Object.assign({}, meta, { hook: true });
  await dbSet(metaKey(shop), m);
  return m;
}

// ── Compute the AOV-impact payload for a date range ──
async function computeImpact(shop, rangeDays) {
  const cfg = (await dbGet(cfgKey(shop))) || {};
  const k = typeof cfg.k === "number" ? cfg.k : DEFAULT_K;
  const days = [];
  const today = isoDay(Date.now());
  // walk back rangeDays (inclusive of today)
  for (let i = 0; i < rangeDays; i++) {
    const d = isoDay(Date.now() - i * 864e5);
    days.push(d);
  }
  let orders = 0,
    revenue = 0,
    influenced = 0,
    attributed = 0;
  const series = [];
  for (const d of days) {
    const row = (await dbGet(dayKey(shop, d))) || null;
    const o = row ? row.orders : 0,
      r = row ? row.revenue : 0,
      inf = row ? row.influenced_orders : 0,
      att = row ? row.attributed_revenue : 0;
    orders += o;
    revenue += r;
    influenced += inf;
    attributed += att;
    series.push({
      date: d,
      orders: o,
      revenue: round2(r),
      attributed_revenue: round2(att),
    });
  }
  series.reverse(); // chronological for a sparkline
  const baseline = Math.max(0, revenue - attributed);
  const aovWith = orders ? revenue / orders : 0;
  const aovWithout = orders ? baseline / orders : 0;
  const upliftPct = baseline > 0 ? (attributed / baseline) * 100 : 0;
  return {
    range_days: rangeDays,
    k,
    enough_data: orders >= MIN_ORDERS,
    min_orders: MIN_ORDERS,
    totals: {
      orders,
      revenue: round2(revenue),
      influenced_orders: influenced,
      attributed_revenue: round2(attributed),
    },
    aov: {
      with_app: round2(aovWith),
      without_app: round2(aovWithout),
      uplift_pct: round2(upliftPct), // raw (assumes 100% incrementality)
      uplift_pct_incr: round2(upliftPct * k), // honesty-corrected headline
      added_per_order: round2(aovWith - aovWithout), // raw $ added per order (= attributed/orders)
      added_per_order_incr: round2((orders ? attributed / orders : 0) * k),
      attributed_revenue: round2(attributed),
      influenced_share: orders ? round2((influenced / orders) * 100) : 0,
    },
    series,
  };
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ── Routes ──
// deps = { shopFromToken, getToken, tokenExchange, gql, apiSecret, host, api }
export function mountImpact(app, deps) {
  const authShop = async (req, res) => {
    const idToken = (req.headers.authorization || "").replace(/^Bearer /, "");
    const shop = deps.shopFromToken(idToken);
    if (!shop) {
      res.status(401).send(JSON.stringify({ error: "unauthorized" }));
      return null;
    }
    let token = await deps.getToken(shop);
    if (!token && deps.tokenExchange)
      token = await deps.tokenExchange(shop, idToken);
    return { shop, token };
  };

  // Dashboard data (GET). First call also ensures the webhook + backfills history once.
  app.get("/impact", async (req, res) => {
    res.set("Content-Type", "application/json");
    try {
      const a = await authShop(req, res);
      if (!a) return;
      const { shop, token } = a;
      if (!token)
        return res.status(200).send(JSON.stringify({ error: "not installed" }));
      let meta = (await dbGet(metaKey(shop))) || {};
      meta = await ensureWebhook(shop, token, deps, meta);
      if (!meta.backfilledAt) {
        try {
          meta.backfilledAt = Date.now();
          await dbSet(metaKey(shop), meta);
          backfill(shop, token, deps, BACKFILL_DAYS)
            .then(function (n) {
              meta.backfilled = n;
              return dbSet(metaKey(shop), meta);
            })
            .catch(function () {});
        } catch (e) {
          /* leave for next load */
        }
      }
      const range = Math.min(
        365,
        Math.max(1, parseInt(req.query.range || "30", 10)),
      );
      res.status(200).send(JSON.stringify(await computeImpact(shop, range)));
    } catch (e) {
      res.status(200).send(JSON.stringify({ error: e.message }));
    }
  });

  // Manual re-backfill (optional; authed).
  app.post("/impact/backfill", async (req, res) => {
    res.set("Content-Type", "application/json");
    try {
      const a = await authShop(req, res);
      if (!a) return;
      const { shop, token } = a;
      if (!token)
        return res.status(200).send(JSON.stringify({ error: "not installed" }));
      const days = Math.min(
        365,
        Math.max(1, parseInt(req.query.days || BACKFILL_DAYS, 10)),
      );
      const n = await backfill(shop, token, deps, days);
      const meta = (await dbGet(metaKey(shop))) || {};
      meta.backfilledAt = Date.now();
      await dbSet(metaKey(shop), meta);
      res.status(200).send(JSON.stringify({ ok: true, recorded: n }));
    } catch (e) {
      res.status(200).send(JSON.stringify({ ok: false, error: e.message }));
    }
  });

  // orders/create webhook — raw body already provided by app.use("/webhooks", express.raw(...)).
  app.post("/webhooks/orders_create", async (req, res) => {
    try {
      const hmac = req.get("X-Shopify-Hmac-Sha256") || "";
      const digest = cryptoHmac(deps.apiSecret, req.body);
      let ok = false;
      try {
        ok = timingEqual(digest, hmac);
      } catch (e) {}
      if (!ok) return res.status(401).send("bad hmac");
      const shop = req.get("X-Shopify-Shop-Domain");
      const order = JSON.parse(
        Buffer.isBuffer(req.body)
          ? req.body.toString("utf8")
          : String(req.body || "{}"),
      );
      await recordOrder(shop, parseWebhookOrder(order));
      res.status(200).send("ok");
    } catch (e) {
      res.status(200).send("ok");
    } // never make Shopify retry on our parse errors
  });
}

// test-only exports (harmless in prod) — lets a unit test inject an in-memory DB.
export const __test = {
  parseWebhookOrder,
  isAttributedLine,
  recordOrder,
  computeImpact,
  backfill,
  setDb: (mock) => {
    _idb = mock;
  },
};

// tiny crypto helpers (kept local so the module has no import coupling beyond node:crypto)
import crypto from "crypto";
function cryptoHmac(secret, rawBuf) {
  return crypto
    .createHmac("sha256", secret || "")
    .update(rawBuf || Buffer.from(""))
    .digest("base64");
}
function timingEqual(a, b) {
  const ba = Buffer.from(String(a)),
    bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ── Dashboard UI (returned as strings; whole feature lives here) ──
export function impactCardHtml() {
  if (!SHOW_IMPACT_UI) return "";
  return (
    '<div id="bkImpact" class="card" style="margin:0 0 20px">' +
    '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">' +
    '<div style="font-weight:600;font-size:15px">App Impact — AOV Improvement</div>' +
    '<select id="bkImpactRange" style="margin-left:auto;min-width:130px">' +
    '<option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option>' +
    '<option value="90">Last 90 days</option><option value="365">Last 12 months</option></select>' +
    "</div>" +
    '<div id="bkImpactBody" class="sub" style="margin:0">Loading…</div>' +
    '<div id="bkImpactNote" class="sub" style="margin:8px 0 0;font-size:12px;color:#8a8a8a"></div>' +
    "</div>"
  );
}
export function impactScript() {
  if (!SHOW_IMPACT_UI) return "";
  return [
    "(function(){",
    "  var body=document.getElementById('bkImpactBody'), note=document.getElementById('bkImpactNote'), sel=document.getElementById('bkImpactRange');",
    "  if(!body) return;",
    "  function money(n){try{return (window.Shopify&&Shopify.currency&&Shopify.currency.active?Shopify.currency.active+' ':'$')+Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});}catch(e){return '$'+Number(n||0).toFixed(2);}}",
    '  function tile(label,val,sub){return "<div style=\'flex:1 1 150px;min-width:150px;border:1px solid #e6e6e6;border-radius:10px;padding:14px\'><div style=\'font-size:12px;color:#8a8a8a\'>"+label+"</div><div style=\'font-size:22px;font-weight:700;margin-top:4px\'>"+val+"</div>"+(sub?"<div style=\'font-size:12px;color:#8a8a8a;margin-top:2px\'>"+sub+"</div>":"")+"</div>";}',
    "  async function bkAuth(){var h={Accept:'application/json'};try{if(window.shopify&&shopify.idToken){h.Authorization='Bearer '+(await shopify.idToken());}}catch(e){}return h;}",
    "  async function load(){",
    "    body.innerHTML='Loading…'; note.textContent='';",
    "    try{ var h=await bkAuth(); var d=await fetch('/impact?range='+(sel?sel.value:'30'),{headers:h}).then(function(r){return r.json();});",
    "      if(d.error==='not installed'){body.innerHTML='Connect the app to see impact.';return;}",
    "      if(d.error){body.innerHTML='Could not load impact ('+d.error+').';return;}",
    '      if(!d.enough_data){ body.innerHTML="<div style=\'color:#8a8a8a\'>Gathering data — impact shows once there are at least "+d.min_orders+" orders in range ("+(d.totals?d.totals.orders:0)+" so far).</div>"; }',
    "      var a=d.aov||{}; var t=d.totals||{};",
    "      var html=\"<div style='display:flex;gap:12px;flex-wrap:wrap'>\";",
    "      html+=tile('AOV improvement', (a.uplift_pct_incr>=0?'+':'')+ (a.uplift_pct_incr||0).toFixed(1)+'%', 'estimated');",
    "      html+=tile('Added per order', '+'+money(a.added_per_order_incr), 'from recommendations');",
    "      html+=tile('Revenue from Boko', money(a.attributed_revenue), t.influenced_orders+' orders influenced');",
    "      html+=tile('AOV with / without', money(a.with_app)+' / '+money(a.without_app), (a.influenced_share||0).toFixed(0)+'% of orders influenced');",
    '      html+="</div>"; body.innerHTML=html;',
    "      note.textContent='Attributed method: revenue from items added via our recommendations, within the selected period. \\u201cEstimated\\u201d applies a '+Math.round((d.k||0.7)*100)+'% incrementality factor. Based on '+ (t.orders||0) +' orders.';",
    "    }catch(e){ body.innerHTML='Could not load impact.'; }",
    "  }",
    "  if(sel) sel.addEventListener('change', load);",
    "  load();",
    "})();",
  ].join("\n");
}
