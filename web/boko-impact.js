// boko-impact.js — SELF-CONTAINED "App Impact" module — PHASE 1: AOV Improvement. (v3)
//
// v3: attribution now matches the "widget performance" black bar EXACTLY —
// same 4 slots (pdp rail, cart drawer, Selected-For-You page/menu) and the
// same price math (original line total minus ALL discount allocations).
// The card and the black bar therefore count the identical items and agree
// at every period. Data is rebuilt into fresh v3 keys; v1/v2 keys are left
// intact for instant rollback.
//
// ── To REMOVE this feature ─────────────────────────────────────────────────
//   1. delete this file
//   2. in server.js: delete the `import { mountImpact, impactCardHtml, impactScript } …`
//      line, the `mountImpact(app, {…})` call, and the two dashboard placeholders
//      __BOKO_IMPACT_CARD__ / __BOKO_IMPACT_SCRIPT__ (+ their .replace() calls).
// ───────────────────────────────────────────────────────────────────────────

import Database from "@replit/database";

// ── Show / hide the dashboard UI (all backend keeps working when false) ──
const SHOW_IMPACT_UI = true;

// Lazy, defensive DB client — never throws at import time.
let _idb = null;
function db() {
  if (_idb === null) {
    try { _idb = new Database(); } catch (e) { _idb = false; }
  }
  return _idb || null;
}
async function dbGet(key) {
  try {
    const d = db(); if (!d) return null;
    const r = await d.get(key);
    return (r && typeof r === "object" && "ok" in r) ? (r.ok ? r.value : null) : r;
  } catch (e) { return null; }
}
async function dbSet(key, val) { try { const d = db(); if (d) await d.set(key, val); } catch (e) {} }

const DEFAULT_K = 0.7;                      // incrementality factor (honesty correction)
const BACKFILL_DAYS = 90;                   // history pulled on first load
const MIN_ORDERS = 30;                      // don't headline a lift below this sample

const sh = (shop) => String(shop || "").toLowerCase();
const dayKey = (shop, date) => "boko_daily_v3:" + sh(shop) + ":" + date;
const metaKey = (shop) => "boko_impact_meta_v3:" + sh(shop);
const cfgKey = (shop) => "boko_impact_cfg:" + sh(shop);
const normId = (id) => { const m = String(id == null ? "" : id).match(/(\d+)(?!.*\d)/); return m ? m[1] : String(id); };
const oidKey = (shop, id) => "boko_oid_v3:" + sh(shop) + ":" + normId(id);

function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

// ── Attribution — MIRRORS loadStats() in server.js exactly ────────────────
// A line counts ONLY if it maps to one of the black bar's 4 widget slots:
//   _boko_reco   === "pdp"                    → pdp (product-page rail)
//   _boko_reco   === "cart_drawer"            → cart_drawer
//   _boko_source === "selected-for-you-page"  → sfy_page
//   _boko_source === "selected-for-you-menu"  → sfy_menu
// Accepts webhook props ({name,value}) and GraphQL customAttributes ({key,value}).
function attributedSlot(props) {
  let reco = null, source = null;
  const arr = Array.isArray(props) ? props : [];
  for (const p of arr) {
    if (!p) continue;
    const k = String(p.key || p.name || "");
    if (k === "_boko_reco") reco = p.value;
    if (k === "_boko_source") source = p.value;
  }
  if (reco === "pdp") return "pdp";
  if (reco === "cart_drawer") return "cart_drawer";
  if (source === "selected-for-you-page") return "sfy_page";
  if (source === "selected-for-you-menu") return "sfy_menu";
  return null;
}
function isAttributedLine(props) { return attributedSlot(props) !== null; }

// Parse a webhook (REST/JSON) order → {id, date, revenue, attributed, influenced}
// Price math mirrors the black bar: gross line total minus ALL discount allocations.
function parseWebhookOrder(order) {
  const items = order.line_items || [];
  let attributed = 0, influenced = false;
  for (const it of items) {
    if (isAttributedLine(it.properties)) {
      influenced = true;
      const gross = num(it.price) * (it.quantity || 1);
      const allocs = (it.discount_allocations || []).reduce(function (x, da) { return x + num(da && da.amount); }, 0);
      const alloc = allocs || num(it.total_discount);
      attributed += Math.max(0, gross - alloc);
    }
  }
  const revenue = num(order.subtotal_price != null ? order.subtotal_price : order.total_price);
  return { id: String(order.id), date: isoDay(order.created_at || Date.now()), revenue, attributed, influenced };
}

// Record ONE order into its daily bucket, deduped by order id.
async function recordOrder(shop, o) {
  if (!o || !o.id) return false;
  if (await dbGet(oidKey(shop, o.id))) return false;     // already counted
  await dbSet(oidKey(shop, o.id), 1);
  const key = dayKey(shop, o.date);
  const row = (await dbGet(key)) || { orders: 0, revenue: 0, influenced_orders: 0, attributed_revenue: 0 };
  row.orders += 1;
  row.revenue += o.revenue;
  if (o.influenced) row.influenced_orders += 1;
  row.attributed_revenue += o.attributed;
  await dbSet(key, row);
  return true;
}

// ── Backfill via Admin GraphQL, in RESUMABLE CHUNKS ────────────────────────
// The deployed app cannot run long background jobs (they are killed after the
// HTTP response), so history is built inline: each call processes up to
// maxPages pages (100 orders each) from a saved cursor and returns
// { seen, cursor, done }. Query + price math mirror loadStats().
async function backfillChunk(shop, token, deps, days, startCursor, maxPages) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  let cursor = startCursor || null, pages = 0, seen = 0, done = false;
  const q = `query($q:String!,$after:String){ orders(first:100, query:$q, sortKey:CREATED_AT, after:$after){
      edges{ cursor node{ id createdAt
        subtotalPriceSet{ shopMoney{ amount } } totalPriceSet{ shopMoney{ amount } }
        lineItems(first:100){ edges{ node{ quantity
          originalTotalSet{ shopMoney{ amount } }
          discountAllocations{ allocatedAmountSet{ shopMoney{ amount } } }
          customAttributes{ key value } } } } } }
      pageInfo{ hasNextPage endCursor } } }`;
  while (pages < maxPages) {
    const data = await deps.gql(shop, token, q, { q: "created_at:>=" + since, after: cursor });
    const conn = data && data.data && data.data.orders;
    if (!conn) {
      // A stale/expired cursor makes Shopify error out — restart the scan from
      // the beginning (dedupe makes re-scanning cheap) instead of wrongly
      // declaring the backfill complete.
      if (pages === 0 && cursor) return { seen: 0, cursor: null, done: false };
      done = true; break;
    }
    for (const edge of (conn.edges || [])) {
      const n = edge.node; if (!n) continue;
      const items = (n.lineItems && n.lineItems.edges) || [];
      let attributed = 0, influenced = false;
      for (const le of items) {
        const li = le.node; if (!li) continue;
        if (isAttributedLine(li.customAttributes)) {
          influenced = true;
          const orig = num(li.originalTotalSet && li.originalTotalSet.shopMoney && li.originalTotalSet.shopMoney.amount);
          const alloc = (li.discountAllocations || []).reduce(function (x, da) {
            return x + num(da && da.allocatedAmountSet && da.allocatedAmountSet.shopMoney && da.allocatedAmountSet.shopMoney.amount);
          }, 0);
          attributed += Math.max(0, orig - alloc);
        }
      }
      const revenue = num(n.subtotalPriceSet && n.subtotalPriceSet.shopMoney && n.subtotalPriceSet.shopMoney.amount)
        || num(n.totalPriceSet && n.totalPriceSet.shopMoney && n.totalPriceSet.shopMoney.amount);
      if (await recordOrder(shop, { id: String(n.id), date: isoDay(n.createdAt), revenue, attributed, influenced })) seen++;
      cursor = edge.cursor;
    }
    pages++;
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) { done = true; break; }
    cursor = conn.pageInfo.endCursor;
  }
  return { seen: seen, cursor: cursor, done: done };
}

// Full backfill to completion (for the shell / manual POST route).
async function backfill(shop, token, deps, days) {
  let cur = null, total = 0;
  for (let i = 0; i < 15; i++) {   // 15 × 5 pages = up to 7500 orders
    const r = await backfillChunk(shop, token, deps, days, cur, 5);
    total += r.seen; cur = r.cursor;
    if (r.done) break;
  }
  return total;
}

// Ensure the orders/create webhook exists (idempotent; ignores "already exists").
async function ensureWebhook(shop, token, deps, meta) {
  if (meta && meta.hook) return meta;
  try {
    await deps.gql(shop, token,
      `mutation($u:URL!){ webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription:{ callbackUrl:$u, format: JSON }){ userErrors{ message } } }`,
      { u: deps.host + "/webhooks/orders_create" });
  } catch (e) {}
  const m = Object.assign({}, meta, { hook: true });
  await dbSet(metaKey(shop), m);
  return m;
}

// ── LIVE compute: scan Shopify orders for the range and build the payload ──
// Same query, attribution and price math as backfillChunk/loadStats.
async function computeImpactLive(shop, token, deps, rangeDays) {
  const cfg = (await dbGet(cfgKey(shop))) || {};
  const k = typeof cfg.k === "number" ? cfg.k : DEFAULT_K;
  const since = new Date(Date.now() - rangeDays * 864e5).toISOString();
  const q = `query($q:String!,$after:String){ orders(first:100, query:$q, sortKey:CREATED_AT, after:$after){
      edges{ cursor node{ id createdAt
        subtotalPriceSet{ shopMoney{ amount } } totalPriceSet{ shopMoney{ amount } }
        lineItems(first:100){ edges{ node{ quantity
          originalTotalSet{ shopMoney{ amount } }
          discountAllocations{ allocatedAmountSet{ shopMoney{ amount } } }
          customAttributes{ key value } } } } } }
      pageInfo{ hasNextPage endCursor } } }`;
  let cursor = null, pages = 0, orders = 0, revenue = 0, influenced = 0, attributed = 0, go = true;
  while (go && pages < 60) {
    const data = await deps.gql(shop, token, q, { q: "created_at:>=" + since, after: cursor });
    const conn = data && data.data && data.data.orders;
    if (!conn) break;
    for (const edge of (conn.edges || [])) {
      const n = edge.node; if (!n) continue;
      orders++;
      revenue += num(n.subtotalPriceSet && n.subtotalPriceSet.shopMoney && n.subtotalPriceSet.shopMoney.amount)
        || num(n.totalPriceSet && n.totalPriceSet.shopMoney && n.totalPriceSet.shopMoney.amount);
      let att = 0, hit = false;
      for (const le of ((n.lineItems && n.lineItems.edges) || [])) {
        const li = le.node; if (!li) continue;
        if (isAttributedLine(li.customAttributes)) {
          hit = true;
          const orig = num(li.originalTotalSet && li.originalTotalSet.shopMoney && li.originalTotalSet.shopMoney.amount);
          const alloc = (li.discountAllocations || []).reduce(function (x, da) {
            return x + num(da && da.allocatedAmountSet && da.allocatedAmountSet.shopMoney && da.allocatedAmountSet.shopMoney.amount);
          }, 0);
          att += Math.max(0, orig - alloc);
        }
      }
      if (hit) influenced++;
      attributed += att;
    }
    pages++;
    if (conn.pageInfo && conn.pageInfo.hasNextPage) { cursor = conn.pageInfo.endCursor; } else { go = false; }
  }
  const baseline = Math.max(0, revenue - attributed);
  const aovWith = orders ? revenue / orders : 0;
  const aovWithout = orders ? baseline / orders : 0;
  const upliftPct = baseline > 0 ? (attributed / baseline) * 100 : 0;
  return {
    range_days: rangeDays,
    k,
    live: true,
    enough_data: orders >= MIN_ORDERS,
    min_orders: MIN_ORDERS,
    totals: { orders, revenue: round2(revenue), influenced_orders: influenced, attributed_revenue: round2(attributed) },
    aov: {
      with_app: round2(aovWith),
      without_app: round2(aovWithout),
      uplift_pct: round2(upliftPct),
      uplift_pct_incr: round2(upliftPct * k),
      added_per_order: round2(aovWith - aovWithout),
      added_per_order_incr: round2((orders ? attributed / orders : 0) * k),
      attributed_revenue: round2(attributed),
      influenced_share: orders ? round2((influenced / orders) * 100) : 0,
    },
  };
}

// ── Compute the AOV-impact payload for a date range ──
async function computeImpact(shop, rangeDays) {
  const cfg = (await dbGet(cfgKey(shop))) || {};
  const k = typeof cfg.k === "number" ? cfg.k : DEFAULT_K;
  const days = [];
  for (let i = 0; i < rangeDays; i++) {
    const d = isoDay(Date.now() - i * 864e5);
    days.push(d);
  }
  let orders = 0, revenue = 0, influenced = 0, attributed = 0;
  const series = [];
  for (const d of days) {
    const row = (await dbGet(dayKey(shop, d))) || null;
    const o = row ? row.orders : 0, r = row ? row.revenue : 0,
      inf = row ? row.influenced_orders : 0, att = row ? row.attributed_revenue : 0;
    orders += o; revenue += r; influenced += inf; attributed += att;
    series.push({ date: d, orders: o, revenue: round2(r), attributed_revenue: round2(att) });
  }
  series.reverse();
  const baseline = Math.max(0, revenue - attributed);
  const aovWith = orders ? revenue / orders : 0;
  const aovWithout = orders ? baseline / orders : 0;
  const upliftPct = baseline > 0 ? (attributed / baseline) * 100 : 0;
  return {
    range_days: rangeDays,
    k,
    enough_data: orders >= MIN_ORDERS,
    min_orders: MIN_ORDERS,
    totals: { orders, revenue: round2(revenue), influenced_orders: influenced, attributed_revenue: round2(attributed) },
    aov: {
      with_app: round2(aovWith),
      without_app: round2(aovWithout),
      uplift_pct: round2(upliftPct),
      uplift_pct_incr: round2(upliftPct * k),
      added_per_order: round2(aovWith - aovWithout),
      added_per_order_incr: round2((orders ? attributed / orders : 0) * k),
      attributed_revenue: round2(attributed),
      influenced_share: orders ? round2((influenced / orders) * 100) : 0,
    },
    series,
  };
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ── Routes ──
export function mountImpact(app, deps) {
  const authShop = async (req, res) => {
    const idToken = (req.headers.authorization || "").replace(/^Bearer /, "");
    const shop = deps.shopFromToken(idToken);
    if (!shop) { res.status(401).send(JSON.stringify({ error: "unauthorized" })); return null; }
    let token = await deps.getToken(shop);
    if (!token && deps.tokenExchange) token = await deps.tokenExchange(shop, idToken);
    return { shop, token };
  };

  // Dashboard data (GET) — computed LIVE from Shopify orders on every call,
  // exactly like loadStats()/the black bar. NO database dependency: Replit
  // deployments cannot write to the Repl DB (verified: write_ok=false), so any
  // stored-aggregate design silently fails in production. Live compute uses
  // the same API, the same attribution and the same price math as the black
  // bar, at the same moment — the two widgets cannot disagree.
  // A small in-memory cache (2 min) keeps repeat loads fast.
  const LIVE_CACHE = {};
  app.get("/impact", async (req, res) => {
    res.set("Content-Type", "application/json");
    try {
      const a = await authShop(req, res); if (!a) return;
      const { shop, token } = a;
      if (!token) return res.status(200).send(JSON.stringify({ error: "not installed" }));
      const range = Math.min(365, Math.max(1, parseInt(req.query.range || "30", 10)));
      const ck = sh(shop) + ":" + range;
      const hit = LIVE_CACHE[ck];
      if (hit && Date.now() - hit.t < 120000) {
        return res.status(200).send(JSON.stringify(hit.data));
      }
      const payload = await computeImpactLive(shop, token, deps, range);
      LIVE_CACHE[ck] = { t: Date.now(), data: payload };
      res.status(200).send(JSON.stringify(payload));
    } catch (e) {
      res.status(200).send(JSON.stringify({ error: e.message }));
    }
  });

  // TEMP diagnostic (read-only + one throwaway write test; secret-gated).
  // Remove after the rebuild is verified.
  app.get("/proxy/impactdbg", async (req, res) => {
    res.set("Content-Type", "application/json");
    try {
      if (String(req.query.key || "") !== "bk7391x") { res.status(404).end(); return; }
      const shop = String(req.query.s || "venomemilio.myshopify.com");
      const meta = await dbGet(metaKey(shop));
      let orders = 0, attr = 0, days = 0;
      for (let i = 0; i < 90; i++) {
        const r = await dbGet(dayKey(shop, isoDay(Date.now() - i * 864e5)));
        if (r) { days++; orders += r.orders; attr += r.attributed_revenue; }
      }
      const stamp = Date.now();
      await dbSet("boko_dbg_w", stamp);
      const rb = await dbGet("boko_dbg_w");
      res.status(200).send(JSON.stringify({
        meta: meta, day_rows: days, orders: orders, attr: Math.round(attr * 100) / 100,
        write_ok: rb === stamp, now: stamp,
      }));
    } catch (e) { res.status(200).send(JSON.stringify({ error: e.message })); }
  });

  // Manual re-backfill (optional; authed).
  app.post("/impact/backfill", async (req, res) => {
    res.set("Content-Type", "application/json");
    try {
      const a = await authShop(req, res); if (!a) return;
      const { shop, token } = a;
      if (!token) return res.status(200).send(JSON.stringify({ error: "not installed" }));
      const days = Math.min(365, Math.max(1, parseInt((req.query.days || BACKFILL_DAYS), 10)));
      const n = await backfill(shop, token, deps, days);
      const meta = (await dbGet(metaKey(shop))) || {}; meta.backfilledAt = Date.now(); meta.bfDone = true; await dbSet(metaKey(shop), meta);
      res.status(200).send(JSON.stringify({ ok: true, recorded: n }));
    } catch (e) { res.status(200).send(JSON.stringify({ ok: false, error: e.message })); }
  });

  // orders/create webhook — raw body already provided by app.use("/webhooks", express.raw(...)).
  app.post("/webhooks/orders_create", async (req, res) => {
    try {
      const hmac = req.get("X-Shopify-Hmac-Sha256") || "";
      const digest = cryptoHmac(deps.apiSecret, req.body);
      let ok = false;
      try { ok = timingEqual(digest, hmac); } catch (e) {}
      if (!ok) return res.status(401).send("bad hmac");
      const shop = req.get("X-Shopify-Shop-Domain");
      const order = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "{}"));
      await recordOrder(shop, parseWebhookOrder(order));
      res.status(200).send("ok");
    } catch (e) { res.status(200).send("ok"); }
  });
}

// test-only exports (harmless in prod).
export const __test = {
  parseWebhookOrder, isAttributedLine, attributedSlot, recordOrder, computeImpact, backfill,
  setDb: (mock) => { _idb = mock; },
};

import crypto from "crypto";
function cryptoHmac(secret, rawBuf) {
  return crypto.createHmac("sha256", secret || "").update(rawBuf || Buffer.from("")).digest("base64");
}
function timingEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ── Dashboard UI ──
export function impactCardHtml() {
  if (!SHOW_IMPACT_UI) return "";
  return (
    '<div id="bkImpact" class="card" style="margin:0 0 20px">' +
    '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">' +
    '<div style="font-weight:600;font-size:15px">App Impact — AOV Improvement</div>' +
    '<select id="bkImpactRange" style="margin-left:auto;min-width:130px">' +
    '<option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option>' +
    '<option value="90">Last 90 days</option><option value="365">Last 12 months</option></select>' +
    '</div>' +
    '<div id="bkImpactBody" class="sub" style="margin:0">Loading…</div>' +
    '<div id="bkImpactExplain"></div>' +
    '<div id="bkImpactNote" class="sub" style="margin:8px 0 0;font-size:12px;color:#8a8a8a"></div>' +
    '</div>'
  );
}
export function impactScript() {
  if (!SHOW_IMPACT_UI) return "";
  return [
    "(function(){",
    "  var body=document.getElementById('bkImpactBody'), note=document.getElementById('bkImpactNote'), exp=document.getElementById('bkImpactExplain'), sel=document.getElementById('bkImpactRange');",
    "  if(!body) return;",
    "  var hasTiles=false;",
    "  function money(n){try{return (window.Shopify&&Shopify.currency&&Shopify.currency.active?Shopify.currency.active+' ':'$')+Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});}catch(e){return '$'+Number(n||0).toFixed(2);}}",
    "  function tile(label,val,sub){return \"<div style='flex:1 1 150px;min-width:150px;border:1px solid #e6e6e6;border-radius:10px;padding:14px'><div style='font-size:12px;color:#8a8a8a'>\"+label+\"</div><div style='font-size:22px;font-weight:700;margin-top:4px'>\"+val+\"</div>\"+(sub?\"<div style='font-size:12px;color:#8a8a8a;margin-top:2px'>\"+sub+\"</div>\":\"\")+\"</div>\";}",
    "  function row(name,formula,result){return \"<tr><td style='padding:4px 10px 4px 0;font-weight:600;white-space:nowrap;vertical-align:top'>\"+name+\"</td><td style='padding:4px 0;color:#555'>\"+formula+\" = <b>\"+result+\"</b></td></tr>\";}",
    "  async function bkAuth(){var h={Accept:'application/json'};try{if(window.shopify&&shopify.idToken){h.Authorization='Bearer '+(await shopify.idToken());}}catch(e){}return h;}",
    "  async function load(){",
    "    if(hasTiles===false){ body.innerHTML='Loading…'; note.textContent=''; if(exp) exp.innerHTML=''; }",
    "    try{ var h=await bkAuth(); var d=await fetch('/impact?range='+(sel?sel.value:'30'),{headers:h}).then(function(r){return r.json();});",
    "      if(d.error==='not installed'){body.innerHTML='Connect the app to see impact.';return;}",
    "      if(d.error){body.innerHTML='Could not load impact ('+d.error+').';return;}",
    "      if(!d.enough_data){ body.innerHTML=\"<div style='color:#8a8a8a'>Gathering data — impact shows once there are at least \"+d.min_orders+\" orders in range (\"+(d.totals?d.totals.orders:0)+\" so far).</div>\"; }",
    "      var a=d.aov||{}; var t=d.totals||{}; var kpct=Math.round((d.k||0.7)*100);",
    "      var html=\"<div style='display:flex;gap:12px;flex-wrap:wrap'>\";",
    "      html+=tile('AOV improvement', (a.uplift_pct_incr>=0?'+':'')+ (a.uplift_pct_incr||0).toFixed(1)+'%', 'estimated');",
    "      html+=tile('Added per order', '+'+money(a.added_per_order_incr), 'from recommendations');",
    "      html+=tile('Revenue from AI Product Recommendations', money(a.attributed_revenue), t.influenced_orders+' orders influenced');",
    "      html+=tile('AOV with / without', money(a.with_app)+' / '+money(a.without_app), (a.influenced_share||0).toFixed(0)+'% of orders influenced');",
    "      html+=\"</div>\"; body.innerHTML=html; hasTiles=true;",
    "      if(exp){",
    "        var base=Math.max(0,(t.revenue||0)-(a.attributed_revenue||0));",
    "        var eh=\"<details style='margin-top:12px'><summary style='cursor:pointer;font-size:13px;color:#444;font-weight:600'>How these numbers are calculated</summary>\";",
    "        eh+=\"<div style='font-size:12px;color:#555;line-height:1.7;margin-top:8px'>\";",
    "        eh+=\"<div style='margin-bottom:8px'>Counts only items customers added through an AI Product Recommendations widget — Product Rail (product page), Cart Drawer, or Selected For You page/menu — priced at what was actually paid after discounts. These are the <b>same items and the same prices</b> as the widget-performance bar below, so both agree over the same period.</div>\";",
    "        eh+=\"<table style='border-collapse:collapse'>\";",
    "        eh+=row('Revenue from AI Product Recommendations','sum of AI Product Recommendations-added items in the last '+d.range_days+' days ('+t.influenced_orders+' of '+t.orders+' orders contained one)',money(a.attributed_revenue));",
    "        eh+=row('AOV improvement','AI Product Recommendations revenue ÷ other revenue × '+kpct+'% → '+money(a.attributed_revenue)+' ÷ '+money(base)+' × 0.'+kpct,(a.uplift_pct_incr>=0?'+':'')+(a.uplift_pct_incr||0).toFixed(1)+'%');",
    "        eh+=row('Added per order','AI Product Recommendations revenue ÷ all orders × '+kpct+'% → '+money(a.attributed_revenue)+' ÷ '+t.orders+' × 0.'+kpct,'+'+money(a.added_per_order_incr));",
    "        eh+=row('AOV with','all revenue ÷ orders → '+money(t.revenue)+' ÷ '+t.orders,money(a.with_app));",
    "        eh+=row('AOV without','revenue excluding AI Product Recommendations items ÷ orders → '+money(base)+' ÷ '+t.orders,money(a.without_app));",
    "        eh+=\"</table>\";",
    "        eh+=\"<div style='margin-top:8px'>Why \"+kpct+\"%? Some shoppers would have bought these items anyway, so we only claim \"+kpct+\"% of attributed revenue as truly added (the uncorrected figure is \"+(a.uplift_pct||0).toFixed(1)+\"%). The bar below shows items in <i>recently scanned orders</i>; this card groups the same items by <i>order date</i>, so day-boundary timing can shift a few dollars between periods.</div>\";",
    "        eh+=\"</div></details>\";",
    "        exp.innerHTML=eh;",
    "      }",
    "      note.textContent='Counts the same widget-added items as the bar below (product rail, cart drawer, Selected For You), at prices after discounts. \\u201cEstimated\\u201d applies a '+kpct+'% incrementality factor. Based on '+ (t.orders||0) +' orders.';",
    "    }catch(e){ body.innerHTML='Could not load impact.'; }",
    "  }",
    "  if(sel) sel.addEventListener('change', load);",
    "  load();",
    "})();",
  ].join("\n");
}
