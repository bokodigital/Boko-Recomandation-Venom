// boko-industry.js — SELF-CONTAINED "Store category / industry" module.
//
// Lets a merchant tag their store's vertical (Beauty / Fashion / Travel / ...)
// from the app dashboard. The value is stored per-shop in Replit DB and can later
// be read to tune recommendations. Kept in ONE file so the whole feature can be
// removed or reused elsewhere easily.
//
// ── To REMOVE this feature ─────────────────────────────────────────────────
//   1. delete this file
//   2. in server.js: delete the `import { mountIndustry, ... } from "./boko-industry.js"`
//      line, the `mountIndustry(app, {...})` call, and the two dashboard placeholders
//      __BOKO_INDUSTRY_CARD__ / __BOKO_INDUSTRY_SCRIPT__ (+ their .replace() calls).
// ── To REUSE elsewhere ─────────────────────────────────────────────────────
//   import and call mountIndustry(app, { shopFromToken, expressJson }); inject
//   industryCardHtml() + industryScript() into your page. That's the whole API.
// ───────────────────────────────────────────────────────────────────────────

import Database from "@replit/database";

// Lazy, defensive DB client — never throws at import time even if the DB URL
// isn't set, so this module is safe to drop into any app.
let _idb = null;
function db() {
  if (_idb === null) {
    try {
      _idb = new Database();
    } catch (e) {
      _idb = false; // mark as unavailable
    }
  }
  return _idb || null;
}

// ── Show / hide the dashboard UI ────────────────────────────────────────────
// Set to false to HIDE the "Store category" card + dropdown from the dashboard
// while we finalise how the category drives recommendations. All backend code,
// routes and stored values stay intact — flip this back to `true` to show it
// again instantly (no re-wiring, no redeploy of anything else needed).
const SHOW_INDUSTRY_UI = false;

const KEY = (shop) => "boko_industry:" + String(shop || "").toLowerCase();

// The selectable categories. Add/remove here — the dropdown and validation follow.
export const INDUSTRIES = [
  "Beauty",
  "Fashion",
  "Travel",
  "Home & Living",
  "Electronics",
  "Health & Wellness",
  "Food & Beverage",
  "Jewellery & Accessories",
  "Other",
];

async function getIndustry(shop) {
  try {
    const d = db();
    if (!d) return "";
    const r = await d.get(KEY(shop));
    const v = r && typeof r === "object" && "ok" in r ? (r.ok ? r.value : null) : r;
    return v || "";
  } catch (e) {
    return "";
  }
}

async function setIndustry(shop, val) {
  const d = db();
  if (!d) throw new Error("store unavailable");
  await d.set(KEY(shop), val);
}

// Public read helper — other code (e.g. the recommender) can call this later.
export async function getStoreIndustry(shop) {
  return getIndustry(shop);
}

// ── Dashboard UI (returned as strings so the whole feature lives in this file) ──
export function industryCardHtml() {
  if (!SHOW_INDUSTRY_UI) return ""; // hidden until the recommendation logic is finalised
  const opts =
    '<option value="">Select category…</option>' +
    INDUSTRIES.map((i) => '<option value="' + i + '">' + i + "</option>").join("");
  return (
    '<div id="bkIndustry" class="card" style="margin:0 0 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">' +
    '<div><div style="font-weight:600;font-size:15px">Store category</div>' +
    '<div class="sub" style="margin:0">Tell the app your store&rsquo;s industry so recommendations can be tuned to it.</div></div>' +
    '<select id="bkIndustrySel" style="margin-left:auto;min-width:200px">' + opts + "</select>" +
    '<span id="bkIndustrySaved" class="sub" style="margin:0;min-width:70px;text-align:right;color:#1f7a45"></span>' +
    "</div>"
  );
}

// Runs inside the dashboard page scope (can reuse the page's window.shopify App Bridge).
export function industryScript() {
  if (!SHOW_INDUSTRY_UI) return ""; // hidden until the recommendation logic is finalised
  return [
    "(function(){",
    "  var sel=document.getElementById('bkIndustrySel'), saved=document.getElementById('bkIndustrySaved');",
    "  if(!sel) return;",
    "  async function bkAuthHeaders(extra){ var h=extra||{}; try{ if(window.shopify&&shopify.idToken){ var t=await shopify.idToken(); h.Authorization='Bearer '+t; } }catch(e){} return h; }",
    "  (async function(){ try{ var h=await bkAuthHeaders({Accept:'application/json'}); var d=await fetch('/settings/industry',{headers:h}).then(function(r){return r.json();}); if(d&&d.industry){ sel.value=d.industry; } }catch(e){} })();",
    "  sel.addEventListener('change', async function(){",
    "    var v=sel.value; saved.textContent='Saving…';",
    "    try{ var h=await bkAuthHeaders({'Content-Type':'application/json'});",
    "      var r=await fetch('/settings/industry',{method:'POST',headers:h,body:JSON.stringify({industry:v})}).then(function(x){return x.json();});",
    "      saved.textContent=(r&&r.ok)?'Saved \\u2713':'Save failed'; }",
    "    catch(e){ saved.textContent='Save failed'; }",
    "    setTimeout(function(){ saved.textContent=''; }, 2500);",
    "  });",
    "})();",
  ].join("\n");
}

// ── Backend routes ──
// deps.shopFromToken(idToken) -> shop (reuses the host app's session-token auth)
// deps.expressJson            -> an express.json() middleware instance for the POST body
export function mountIndustry(app, deps) {
  const shopFromToken = deps.shopFromToken;
  const jsonMw = deps.expressJson;

  app.get("/settings/industry", async (req, res) => {
    res.set("Content-Type", "application/json");
    try {
      const idToken = (req.headers.authorization || "").replace(/^Bearer /, "");
      const shop = shopFromToken(idToken);
      if (!shop)
        return res.status(401).send(JSON.stringify({ error: "unauthorized", options: INDUSTRIES }));
      const industry = await getIndustry(shop);
      res.status(200).send(JSON.stringify({ industry, options: INDUSTRIES }));
    } catch (e) {
      res.status(200).send(JSON.stringify({ industry: "", options: INDUSTRIES, error: e.message }));
    }
  });

  app.post("/settings/industry", jsonMw, async (req, res) => {
    res.set("Content-Type", "application/json");
    try {
      const idToken = (req.headers.authorization || "").replace(/^Bearer /, "");
      const shop = shopFromToken(idToken);
      if (!shop) return res.status(401).send(JSON.stringify({ ok: false, error: "unauthorized" }));
      let v = String((req.body && req.body.industry) || "").trim();
      if (v && !INDUSTRIES.includes(v)) v = "Other";
      await setIndustry(shop, v);
      res.status(200).send(JSON.stringify({ ok: true, industry: v }));
    } catch (e) {
      res.status(200).send(JSON.stringify({ ok: false, error: e.message }));
    }
  });
}
