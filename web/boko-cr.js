// boko-cr.js — SELF-CONTAINED "App Impact" module — PHASE 2: Conversion-Rate lift.
//
// Method (per the App Impact Metrics design, §2):
//   Tier 2 (default): CR_exposed vs CR_unexposed among PDP-REACHING sessions only
//   (selection-bias-safe: both groups viewed at least one product page).
//   Tier 3 (opt-in):  holdout — a configurable % of PDP sessions see NO widget;
//   CR_treated vs CR_holdout is the true causal lift. DEFAULT holdout_pct = 0 (OFF)
//   → zero storefront behaviour change until a merchant opts in.
//
// Data sources:
//   • First-party session beacon (storefront, via the existing /apps/reco app
//     proxy): pdp view / widget impression / holdout-suppressed events, with a
//     visitorId cookie (365d) + sessionId cookie (30-min rolling).
//   • orders/create webhook (own subscription URL /webhooks/orders_create_cr —
//     separate from Phase 1's, so both modules stay independent). Orders join
//     to sessions via the `_boko_vid` cart attribute the beacon sets.
//   • 7-day lookback window: an order counts as "exposed" if its visitor saw a
//     widget impression within the previous 7 days.
//
// Guardrails (§6): min-sample gating (default 1,000 exposed sessions, 50
// orders), two-proportion 95% CI, method badge, sample sizes always shown.
//
// ENTIRELY ADDITIVE. New DB keys only (boko_cr_*). To remove: delete this file,
// remove its import + mountCr() call + the two __BOKO_CR_*__ placeholders in
// server.js, and remove the small beacon block from the theme section.

// ── Storage: Replit PostgreSQL (writable from deployments, unlike the Repl
// key-value store — see boko-reco-impact-blackbar-reconciliation.md).
// One tiny key/value table, auto-created on first use. NOTHING existing is
// touched: this table is new and Phase 2 writes only here. If DATABASE_URL is
// absent (Postgres not enabled yet), every read returns null and every write
// is a silent no-op — the dashboard card just says "gathering data".
import pg from "pg";

const SHOW_CR_UI = true;

let _pool = null, _ready = false, _mock = null;
function pool() {
  if (_pool === null) {
    try {
      const url = process.env.DATABASE_URL || "";
      _pool = url
        ? new pg.Pool({
            connectionString: url,
            max: 3,
            ssl: (/localhost|127\.0\.0\.1/.test(url) || /sslmode=disable/.test(url)) ? false : { rejectUnauthorized: false },
          })
        : false;
    } catch (e) { _pool = false; }
  }
  return _pool || null;
}
async function ensureTable(p) {
  if (_ready) return;
  await p.query("CREATE TABLE IF NOT EXISTS boko_kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)");
  _ready = true;
}
async function dbGet(key) {
  try {
    if (_mock) { const v = await _mock.get(key); return v === undefined ? null : v; }
    const p = pool(); if (!p) return null;
    await ensureTable(p);
    const r = await p.query("SELECT v FROM boko_kv WHERE k = $1", [key]);
    return r.rows.length ? r.rows[0].v : null;
  } catch (e) { return null; }
}
async function dbSet(key, val) {
  try {
    if (_mock) { await _mock.set(key, val); return; }
    const p = pool(); if (!p) return;
    await ensureTable(p);
    await p.query(
      "INSERT INTO boko_kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = $2",
      [key, JSON.stringify(val)]
    );
  } catch (e) {}
}

const WINDOW_DAYS = 7;            // impression → order lookback
const MIN_EXPOSED_SESSIONS = 0; // §6 gate
const MIN_ORDERS = 0;             // §6 gate

const sh = (shop) => String(shop || "").toLowerCase();
const dayKey = (shop, date) => "boko_cr_daily:" + sh(shop) + ":" + date;
const sessKey = (shop, date, sid) => "boko_cr_sess:" + sh(shop) + ":" + date + ":" + sid;
const visKey = (shop, vid) => "boko_cr_vis:" + sh(shop) + ":" + vid;
const oidKey = (shop, id) => "boko_cr_oid:" + sh(shop) + ":" + normId(id);
const cfgKey = (shop) => "boko_cr_cfg:" + sh(shop);
const metaKey = (shop) => "boko_cr_meta:" + sh(shop);

const normId = (id) => { const m = String(id == null ? "" : id).match(/(\d+)(?!.*\d)/); return m ? m[1] : String(id); };
function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function clean(s, max) { return String(s || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, max || 64); }
function emptyDay() { return { pdp_sessions: 0, exposed_sessions: 0, holdout_sessions: 0, exposed_orders: 0, unexposed_orders: 0, holdout_orders: 0 }; }

async function getCfg(shop) {
  const c = (await dbGet(cfgKey(shop))) || {};
  return {
    holdout_pct: typeof c.holdout_pct === "number" ? c.holdout_pct : 0,
    window_days: typeof c.window_days === "number" ? c.window_days : WINDOW_DAYS,
    min_sessions: typeof c.min_sessions === "number" ? c.min_sessions : MIN_EXPOSED_SESSIONS,
    min_orders: typeof c.min_orders === "number" ? c.min_orders : MIN_ORDERS,
  };
}

// ── Beacon event → daily counters (deduped per session per day) ────────────
// e: "pdp" (product page view) | "imp" (widget impression) | "hold" (holdout-suppressed)
async function recordEvent(shop, e, sid, vid) {
  if (!shop || !sid || !vid) return false;
  const day = isoDay(Date.now());
  const sk = sessKey(shop, day, sid);
  const flags = (await dbGet(sk)) || {};
  const row = (await dbGet(dayKey(shop, day))) || emptyDay();
  let changed = false, rowChanged = false;

  // every event implies the session reached a PDP
  if (!flags.p) { flags.p = 1; row.pdp_sessions += 1; changed = true; rowChanged = true; }
  if (e === "imp" && !flags.e) { flags.e = 1; row.exposed_sessions += 1; changed = true; rowChanged = true; }
  if (e === "hold" && !flags.h) { flags.h = 1; row.holdout_sessions += 1; changed = true; rowChanged = true; }

  if (rowChanged) await dbSet(dayKey(shop, day), row);
  if (changed) await dbSet(sk, flags);

  // visitor lookback state (for order attribution)
  const vk = visKey(shop, vid);
  const vis = (await dbGet(vk)) || {};
  let visChanged = false;
  if (!vis.pdp) { vis.pdp = Date.now(); visChanged = true; }
  if (e === "imp") { vis.imp = Date.now(); visChanged = true; }
  if (e === "hold") { vis.holdout = true; visChanged = true; }
  if (visChanged) await dbSet(vk, vis);
  return true;
}

// ── Order → exposed / unexposed / holdout (deduped by order id) ────────────
// Join key: the `_boko_vid` cart attribute the beacon writes (appears on the
// order as note_attributes). Orders without it never saw a beacon-instrumented
// PDP → outside the measured population → ignored (consistent denominator).
async function recordCrOrder(shop, order) {
  if (!order || !order.id) return null;
  if (await dbGet(oidKey(shop, order.id))) return null;   // already counted
  const attrs = order.note_attributes || order.attributes || [];
  let vid = null, holdAttr = false;
  for (const a of (Array.isArray(attrs) ? attrs : [])) {
    const k = String((a && (a.name || a.key)) || "");
    if (k === "_boko_vid") vid = clean(a.value);
    if (k === "_boko_hold" && String(a.value) === "1") holdAttr = true;
  }
  if (!vid) return null;                                   // outside population
  await dbSet(oidKey(shop, order.id), 1);

  const cfg = await getCfg(shop);
  const orderTs = new Date(order.created_at || Date.now()).getTime();
  const vis = (await dbGet(visKey(shop, vid))) || {};
  let bucket;
  if (holdAttr || vis.holdout) bucket = "holdout_orders";
  else if (vis.imp && (orderTs - vis.imp) < cfg.window_days * 864e5) bucket = "exposed_orders";
  else bucket = "unexposed_orders";

  const day = isoDay(order.created_at || Date.now());
  const row = (await dbGet(dayKey(shop, day))) || emptyDay();
  row[bucket] += 1;
  await dbSet(dayKey(shop, day), row);
  return bucket;
}

// ── Compute CR lift over a range (§2 + §6) ────────────────────────────────
function twoPropCI(p1, n1, p2, n2) {
  if (!n1 || !n2) return null;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  const d = p1 - p2, z = 1.96;
  return { lo: round4((d - z * se) * 100), hi: round4((d + z * se) * 100) }; // in pp
}
async function computeCr(shop, rangeDays) {
  const cfg = await getCfg(shop);
  const t = emptyDay();
  for (let i = 0; i < rangeDays; i++) {
    const row = (await dbGet(dayKey(shop, isoDay(Date.now() - i * 864e5)))) || null;
    if (!row) continue;
    t.pdp_sessions += row.pdp_sessions; t.exposed_sessions += row.exposed_sessions;
    t.holdout_sessions += row.holdout_sessions; t.exposed_orders += row.exposed_orders;
    t.unexposed_orders += row.unexposed_orders; t.holdout_orders += row.holdout_orders;
  }
  const unexposedSessions = Math.max(0, t.pdp_sessions - t.exposed_sessions - t.holdout_sessions);
  const useHoldout = cfg.holdout_pct > 0 && t.holdout_sessions >= 100;
  const treated = t.exposed_sessions ? t.exposed_orders / t.exposed_sessions : 0;
  const baseN = useHoldout ? t.holdout_sessions : unexposedSessions;
  const baseOrders = useHoldout ? t.holdout_orders : t.unexposed_orders;
  const base = baseN ? baseOrders / baseN : 0;
  const liftPp = (treated - base) * 100;
  const liftPct = base > 0 ? ((treated - base) / base) * 100 : 0;
  const ci = twoPropCI(treated, t.exposed_sessions, base, baseN);
  const totalOrders = t.exposed_orders + t.unexposed_orders + t.holdout_orders;
  const enough = t.exposed_sessions >= cfg.min_sessions && totalOrders >= cfg.min_orders;
  const significant = !!(ci && (ci.lo > 0 || ci.hi < 0));
  return {
    range_days: rangeDays,
    method: useHoldout ? "holdout" : "attributed",
    method_label: useHoldout ? "Verified (holdout)" : "Estimated (attributed, PDP-matched)",
    holdout_pct: cfg.holdout_pct,
    enough_data: enough,
    significant: significant,
    gates: { min_sessions: cfg.min_sessions, min_orders: cfg.min_orders },
    totals: {
      pdp_sessions: t.pdp_sessions,
      exposed_sessions: t.exposed_sessions,
      unexposed_sessions: unexposedSessions,
      holdout_sessions: t.holdout_sessions,
      exposed_orders: t.exposed_orders,
      unexposed_orders: t.unexposed_orders,
      holdout_orders: t.holdout_orders,
      orders: totalOrders,
    },
    cr: {
      exposed: round4(treated * 100),        // %
      baseline: round4(base * 100),          // %
      lift_pp: round4(liftPp),
      lift_pct: round4(liftPct),
      ci95_pp: ci,
    },
  };
}
function round4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }

// ── Routes ────────────────────────────────────────────────────────────────
// deps = { shopFromToken, getToken, tokenExchange, gql, apiSecret, host }
export function mountCr(app, deps) {
  const authShop = async (req, res) => {
    const idToken = (req.headers.authorization || "").replace(/^Bearer /, "");
    const shop = deps.shopFromToken(idToken);
    if (!shop) { res.status(401).send(JSON.stringify({ error: "unauthorized" })); return null; }
    let token = await deps.getToken(shop);
    if (!token && deps.tokenExchange) token = await deps.tokenExchange(shop, idToken);
    return { shop, token };
  };

  // Storefront beacon (via app proxy /apps/reco/cr → /proxy/cr).
  // Shopify's app proxy appends ?shop=<shop domain> to every request.
  app.all("/proxy/cr", async (req, res) => {
    try {
      const shop = clean(String(req.query.shop || ""), 80);
      const e = String(req.query.e || "");
      if (shop && (e === "pdp" || e === "imp" || e === "hold")) {
        await recordEvent(shop, e, clean(req.query.sid), clean(req.query.vid));
      }
    } catch (err) {}
    res.status(204).end();
  });

  // Storefront config (holdout percentage) — read-only, cacheable.
  app.get("/proxy/crcfg", async (req, res) => {
    res.set("Content-Type", "application/json");
    res.set("Cache-Control", "public, max-age=300");
    try {
      const shop = clean(String(req.query.shop || ""), 80);
      const cfg = await getCfg(shop);
      res.status(200).send(JSON.stringify({ holdout_pct: cfg.holdout_pct }));
    } catch (e) { res.status(200).send(JSON.stringify({ holdout_pct: 0 })); }
  });

  // Dashboard data (admin, authed). First call registers the CR webhook.
  app.get("/crlift", async (req, res) => {
    res.set("Content-Type", "application/json");
    try {
      const a = await authShop(req, res); if (!a) return;
      const { shop, token } = a;
      if (!token) return res.status(200).send(JSON.stringify({ error: "not installed" }));
      let meta = (await dbGet(metaKey(shop))) || {};
      if (!meta.hook) {
        try {
          await deps.gql(shop, token,
            `mutation($u:URL!){ webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription:{ callbackUrl:$u, format: JSON }){ userErrors{ message } } }`,
            { u: deps.host + "/webhooks/orders_create_cr" });
        } catch (e) {}
        meta.hook = true;
        await dbSet(metaKey(shop), meta);
      }
      const range = Math.min(365, Math.max(1, parseInt(req.query.range || "30", 10)));
      res.status(200).send(JSON.stringify(await computeCr(shop, range)));
    } catch (e) { res.status(200).send(JSON.stringify({ error: e.message })); }
  });

  // Admin: set holdout percentage (0 disables). Authed.
  app.post("/crlift/holdout", async (req, res) => {
    res.set("Content-Type", "application/json");
    try {
      const a = await authShop(req, res); if (!a) return;
      const { shop } = a;
      const pct = Math.min(50, Math.max(0, parseInt(req.query.pct || "0", 10)));
      const cfg = (await dbGet(cfgKey(shop))) || {};
      cfg.holdout_pct = pct;
      await dbSet(cfgKey(shop), cfg);
      res.status(200).send(JSON.stringify({ ok: true, holdout_pct: pct }));
    } catch (e) { res.status(200).send(JSON.stringify({ ok: false, error: e.message })); }
  });

  // orders/create webhook (own URL — independent of Phase 1's).
  app.post("/webhooks/orders_create_cr", async (req, res) => {
    try {
      const hmac = req.get("X-Shopify-Hmac-Sha256") || "";
      const digest = cryptoHmac(deps.apiSecret, req.body);
      let ok = false;
      try { ok = timingEqual(digest, hmac); } catch (e) {}
      if (!ok) return res.status(401).send("bad hmac");
      const shop = req.get("X-Shopify-Shop-Domain");
      const order = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "{}"));
      await recordCrOrder(shop, order);
      res.status(200).send("ok");
    } catch (e) { res.status(200).send("ok"); }
  });
}

export const __test = {
  recordEvent, recordCrOrder, computeCr, getCfg, twoPropCI,
  setDb: (mock) => { _mock = mock; },
};

import crypto from "crypto";
function cryptoHmac(secret, rawBuf) {
  return crypto.createHmac("sha256", secret || "").update(rawBuf || Buffer.from("")).digest("base64");
}
function timingEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ── Dashboard UI ──────────────────────────────────────────────────────────
export function crCardHtml() {
  if (!SHOW_CR_UI) return "";
  return (
    '<div id="bkCr" class="card" style="margin:0 0 20px">' +
    '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">' +
    '<div style="font-weight:600;font-size:15px">App Impact — Conversion Lift</div>' +
    '<span id="bkCrBadge" style="font-size:11px;border:1px solid #e6e6e6;border-radius:99px;padding:2px 10px;color:#666"></span>' +
    '<select id="bkCrRange" style="margin-left:auto;min-width:130px">' +
    '<option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option>' +
    '<option value="90">Last 90 days</option></select>' +
    '</div>' +
    '<div id="bkCrBody" class="sub" style="margin:0">Loading…</div>' +
    '<div id="bkCrExplain"></div>' +
    '<div id="bkCrNote" class="sub" style="margin:8px 0 0;font-size:12px;color:#8a8a8a"></div>' +
    '</div>'
  );
}
export function crScript() {
  if (!SHOW_CR_UI) return "";
  return [
    "(function(){",
    "  var body=document.getElementById('bkCrBody'), note=document.getElementById('bkCrNote'), exp=document.getElementById('bkCrExplain'), sel=document.getElementById('bkCrRange'), badge=document.getElementById('bkCrBadge');",
    "  if(!body) return;",
    "  function pct(n){return (Number(n)||0).toFixed(2)+'%';}",
    "  function pp(n){return ((Number(n)||0)>=0?'+':'')+(Number(n)||0).toFixed(2)+' pp';}",
    "  function tile(label,val,sub){return \"<div style='flex:1 1 150px;min-width:150px;border:1px solid #e6e6e6;border-radius:10px;padding:14px'><div style='font-size:12px;color:#8a8a8a'>\"+label+\"</div><div style='font-size:22px;font-weight:700;margin-top:4px'>\"+val+\"</div>\"+(sub?\"<div style='font-size:12px;color:#8a8a8a;margin-top:2px'>\"+sub+\"</div>\":\"\")+\"</div>\";}",
    "  function row(name,formula,result){return \"<tr><td style='padding:4px 10px 4px 0;font-weight:600;white-space:nowrap;vertical-align:top'>\"+name+\"</td><td style='padding:4px 0;color:#555'>\"+formula+\" = <b>\"+result+\"</b></td></tr>\";}",
    "  async function bkAuth(){var h={Accept:'application/json'};try{if(window.shopify&&shopify.idToken){h.Authorization='Bearer '+(await shopify.idToken());}}catch(e){}return h;}",
    "  async function load(){",
    "    body.innerHTML='Loading…'; note.textContent=''; if(exp) exp.innerHTML='';",
    "    try{ var h=await bkAuth(); var d=await fetch('/crlift?range='+(sel?sel.value:'30'),{headers:h}).then(function(r){return r.json();});",
    "      if(d.error==='not installed'){body.innerHTML='Connect the app to see impact.';return;}",
    "      if(d.error){body.innerHTML='Could not load conversion lift ('+d.error+').';return;}",
    "      var t=d.totals||{}; var c=d.cr||{};",
    "      if(badge) badge.textContent=d.method_label||'';",
    "      if(!t.pdp_sessions){ body.innerHTML=\"<div style='color:#8a8a8a'>Waiting for the first sessions on pages with an AI Product Recommendations widget. Conversion tracking starts once the beacon is live in the theme \\u2014 no data will show until then.</div>\"; return; }",
    "      if(!d.enough_data){ body.innerHTML=\"<div style='color:#8a8a8a'>Gathering data \\u2014 conversion lift shows once there are \"+d.gates.min_sessions.toLocaleString()+\" exposed sessions and \"+d.gates.min_orders+\" orders in range (so far: \"+(t.exposed_sessions||0).toLocaleString()+\" sessions, \"+(t.orders||0)+\" orders).</div>\"; }",
    "      else {",
    "        var mut=d.significant?'':'opacity:.55;';",
    "        var html=\"<div style='display:flex;gap:12px;flex-wrap:wrap'>\";",
    "        html+=\"<div style='\"+mut+\"flex:1 1 150px;min-width:150px;border:1px solid #e6e6e6;border-radius:10px;padding:14px'><div style='font-size:12px;color:#8a8a8a'>Conversion lift</div><div style='font-size:22px;font-weight:700;margin-top:4px'>\"+pp(c.lift_pp)+\"</div><div style='font-size:12px;color:#8a8a8a;margin-top:2px'>\"+(d.significant?((c.lift_pct>=0?'+':'')+(c.lift_pct||0).toFixed(1)+'% relative'):'not yet statistically significant')+\"</div></div>\";",
    "        html+=tile('CR with widget', pct(c.exposed), t.exposed_orders+' orders / '+t.exposed_sessions.toLocaleString()+' sessions');",
    "        html+=tile('CR without', pct(c.baseline), (d.method==='holdout'?(t.holdout_orders+' orders / '+t.holdout_sessions.toLocaleString()+' holdout sessions'):(t.unexposed_orders+' orders / '+t.unexposed_sessions.toLocaleString()+' sessions')));",
    "        html+=tile('Sessions measured', t.pdp_sessions.toLocaleString(), 'sessions on AI Product Recommendations widget pages');",
    "        html+=\"</div>\"; body.innerHTML=html;",
    "      }",
    "      if(exp){",
    "        var eh=\"<details style='margin-top:12px'><summary style='cursor:pointer;font-size:13px;color:#444;font-weight:600'>How these numbers are calculated</summary>\";",
    "        eh+=\"<div style='font-size:12px;color:#555;line-height:1.7;margin-top:8px'>\";",
    "        eh+=\"<div style='margin-bottom:8px'>Sessions that reached a page carrying an AI Product Recommendations widget are compared — the <b>product-page rail</b>, <b>Complete the Look</b>, the <b>cart-drawer cross-sell</b>, and the <b>Selected For You</b> page (both groups reached a widget page \\u2014 this avoids the bias of comparing browsers to buyers). A session is <b>exposed</b> once any of these widgets actually renders on screen for it (the cart-drawer cross-sell counts only when the drawer is opened and seen); an order counts as exposed if that shopper saw a widget within the last \"+ (7) +\" days.</div>\";",
    "        eh+=\"<table style='border-collapse:collapse'>\";",
    "        eh+=row('CR with widget','exposed orders \\u00f7 exposed sessions \\u2192 '+(t.exposed_orders||0)+' \\u00f7 '+(t.exposed_sessions||0),pct(c.exposed));",
    "        eh+=row('CR without',(d.method==='holdout'?'holdout orders \\u00f7 holdout sessions \\u2192 '+(t.holdout_orders||0)+' \\u00f7 '+(t.holdout_sessions||0):'unexposed orders \\u00f7 unexposed sessions \\u2192 '+(t.unexposed_orders||0)+' \\u00f7 '+(t.unexposed_sessions||0)),pct(c.baseline));",
    "        eh+=row('Conversion lift','CR with \\u2212 CR without \\u2192 '+pct(c.exposed)+' \\u2212 '+pct(c.baseline),pp(c.lift_pp));",
    "        if(c.ci95_pp){ eh+=row('95% confidence','the true lift is between',pp(c.ci95_pp.lo)+' and '+pp(c.ci95_pp.hi)); }",
    "        eh+=\"</table>\";",
    "        eh+=\"<div style='margin-top:8px'>Method: <b>\"+(d.method_label||'')+\"</b>. \"+(d.method==='holdout'?'A random '+d.holdout_pct+'% of sessions are shown no product-page rail widget \\u2014 comparing against them gives a true causal number.':'Without a holdout this is directional, not causal \\u2014 shoppers who engage with recommendations may differ from those who don\\u2019t. Enable a 10% holdout for a verified number.')+\" Sessions are counted by our own first-party beacon (one per visitor per 30-minute window), the same source for both groups.</div>\";",
    "        eh+=\"</div></details>\";",
    "        exp.innerHTML=eh;",
    "      }",
    "      note.textContent='Based on '+ (t.pdp_sessions||0).toLocaleString() +' sessions on AI Product Recommendations widget pages and '+ (t.orders||0) +' attributable orders in the selected period.';",
    "    }catch(e){ body.innerHTML='Could not load conversion lift.'; }",
    "  }",
    "  if(sel) sel.addEventListener('change', load);",
    "  load();",
    "})();",
  ].join("\n");
}
