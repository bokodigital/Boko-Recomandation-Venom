// BOKO KLAVIYO SETTINGS — per-store Klaviyo connection, managed from the app dashboard.
// Multi-tenant: each shop saves its OWN private API key (validated live against Klaviyo,
// stored server-side in boko_kv as bkl_kcfg:{shop}, masked afterwards, never echoed back).
// Additive and self-contained; safe to remove (delete file + wired lines in server.js).
import { kvGet, kvSet } from "./boko-klaviyo.js";

const REV = "2025-07-15";

async function kacct(apiKey) {
  const r = await fetch("https://a.klaviyo.com/api/accounts", {
    headers: {
      Authorization: "Klaviyo-API-Key " + apiKey,
      accept: "application/vnd.api+json",
      revision: REV,
    },
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { status: r.status, json };
}

function mask(k) {
  const s = String(k || "");
  return s.length > 6 ? "••••••" + s.slice(-6) : "••••••";
}

export function mountKlaviyoSettings(app, deps) {
  const shopFromToken = deps && deps.shopFromToken;
  function authShop(req) {
    const idToken = String(req.get("Authorization") || "").replace(/^Bearer\s+/i, "") || String(req.query.id_token || "");
    return shopFromToken ? shopFromToken(idToken) : null;
  }

  // Connection status for the embedded dashboard (session-token authed). Never returns the key.
  app.get("/klaviyo/settings", async (req, res) => {
    try {
      const shop = authShop(req);
      if (!shop) return res.status(401).json({ error: "unauthorized" });
      const cfg = await kvGet("bkl_kcfg:" + shop);
      res.json({
        connected: !!(cfg && cfg.api_key),
        account_name: (cfg && cfg.account_name) || null,
        account_id: (cfg && cfg.account_id) || null,
        masked: cfg && cfg.api_key ? mask(cfg.api_key) : null,
        set_at: (cfg && cfg.set_at) || null,
        env_fallback: !!process.env.KLAVIYO_API_KEY,
        prov: (await kvGet("bkl_prov:" + shop)) || null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Save (validates the key against Klaviyo first) or disconnect.
  app.post("/klaviyo/settings", async (req, res) => {
    try {
      const shop = authShop(req);
      if (!shop) return res.status(401).json({ error: "unauthorized" });
      const body = req.body || {};
      if (body.disconnect) {
        await kvSet("bkl_kcfg:" + shop, {});
        return res.json({ ok: true, connected: false });
      }
      const apiKey = String(body.api_key || "").trim();
      if (!/^pk_[A-Za-z0-9_-]{10,}$/.test(apiKey)) {
        return res.status(400).json({ ok: false, error: "That does not look like a Klaviyo Private API key (it should start with pk_)." });
      }
      const acct = await kacct(apiKey);
      if (acct.status !== 200 || !acct.json || !acct.json.data || !acct.json.data.length) {
        return res.status(400).json({ ok: false, error: "Klaviyo rejected this key (status " + acct.status + "). Make sure it is a Private API key with Full Access." });
      }
      const a = acct.json.data[0];
      const info = (a.attributes && a.attributes.contact_information) || {};
      const name = info.organization_name || a.id;
      await kvSet("bkl_kcfg:" + shop, {
        api_key: apiKey,
        account_id: a.id,
        account_name: name,
        set_at: new Date().toISOString(),
      });
      try { if (globalThis.__bklProvisionHook) globalThis.__bklProvisionHook(shop); } catch (e) {} // BOKO KLAVIYO PROVISION auto-setup
      res.json({ ok: true, connected: true, account_name: name, account_id: a.id, masked: mask(apiKey) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

// Dashboard card (script included inline, so it needs only ONE injection point).
export function klvSettingsCardHtml() {
  return (
    '<div id="bkKset" class="card" style="margin:0 0 20px">' +
    '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px">' +
    '<div style="font-weight:600;font-size:15px">Klaviyo Settings</div>' +
    '<span id="bkKsetBadge" style="font-size:11px;border:1px solid #e6e6e6;border-radius:99px;padding:2px 10px">checking…</span>' +
    "</div>" +
    '<div class="sub" style="margin:0 0 10px">Connect this store’s Klaviyo account to activate email recommendations — nightly profile sync, tracked product links and click events. Paste a <b>Private API key</b> (Klaviyo → Settings → API keys → Create Private API Key, Full Access). The key is validated, stored securely for this store only, and never shown again.</div>' +
    '<div id="bkKsetBody" class="sub" style="margin:0">Loading…</div>' +
    "</div>" +
    "<script>(function(){" +
    "var body=document.getElementById('bkKsetBody'), badge=document.getElementById('bkKsetBadge');" +
    "if(!body)return;" +
    "async function auth(){var h={Accept:'application/json','Content-Type':'application/json'};try{if(window.shopify&&shopify.idToken){h.Authorization='Bearer '+await shopify.idToken();}}catch(e){}return h;}" +
    "function esc(s){return String(s==null?'':s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c];});}" +
    "async function post(payload){var h=await auth();return fetch('/klaviyo/settings',{method:'POST',headers:h,body:JSON.stringify(payload)}).then(function(r){return r.json();});}" +
    "function formHtml(err){" +
    "return \"<div style='display:flex;gap:8px;flex-wrap:wrap;align-items:center'>\"+" +
    "\"<input id='bkKsetKey' type='password' placeholder='pk_...' autocomplete='off' style='flex:1 1 260px;min-width:220px;border:1px solid #d9d9d9;border-radius:8px;padding:9px 12px;font-size:13px'>\"+" +
    "\"<button id='bkKsetSave' style='background:#111;color:#fff;border:0;border-radius:8px;padding:9px 18px;font-size:13px;cursor:pointer'>Connect</button>\"+" +
    "\"</div>\"+(err?\"<div style='color:#b42318;font-size:12px;margin-top:8px'>\"+esc(err)+\"</div>\":\"\");}" +
    "function connectedHtml(d){" +
    "return \"<div style='display:flex;gap:8px;flex-wrap:wrap;align-items:center'>\"+" +
    "\"<div style='flex:1 1 260px;font-size:13px'>Connected to <b>\"+esc(d.account_name||'Klaviyo')+\"</b> <span style='color:#8a8a8a'>(\"+esc(d.masked||'')+\")</span></div>\"+" +
    "\"<button id='bkKsetOff' style='background:#fff;color:#111;border:1px solid #d9d9d9;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer'>Disconnect</button>\"+" +
    "\"</div>\"+bkProv(d);}" +
    "function bkProv(d){var p=d&&d.prov;if(!p)return \"<div style='flex-basis:100%;font-size:12px;color:#8a8a8a;margin-top:6px'>Auto-setup runs right after connecting \u2014 refresh in a minute to see status.</div>\";function t(x){return x?'\u2713 done':'pending';}return \"<div style='flex-basis:100%;font-size:12px;color:#556655;margin-top:6px'>Auto-setup \u2014 web feeds: \"+t(p.feeds&&p.feeds.best)+\" \u00b7 email blocks: \"+t(p.blocks&&p.blocks.ctl&&p.blocks.sfy)+\" \u00b7 starter template: \"+t(p.template_id)+\"</div>\";}" +
    "function wire(d,err){" +
    "if(d&&d.connected){badge.textContent='Connected';badge.style.borderColor='#b7e2c0';badge.style.color='#1b7a35';body.innerHTML=connectedHtml(d);" +
    "var off=document.getElementById('bkKsetOff');if(off){off.onclick=async function(){off.disabled=true;off.textContent='Disconnecting\\u2026';var r=await post({disconnect:true});load();};}}" +
    "else{badge.textContent='Not connected';badge.style.borderColor='#e6e6e6';badge.style.color='#8a8a8a';body.innerHTML=formHtml(err);" +
    "var btn=document.getElementById('bkKsetSave'),inp=document.getElementById('bkKsetKey');" +
    "if(btn){btn.onclick=async function(){var v=(inp&&inp.value||'').trim();if(!v){wire(null,'Paste your Klaviyo Private API key first.');return;}" +
    "btn.disabled=true;btn.textContent='Validating\\u2026';" +
    "try{var r=await post({api_key:v});if(r&&r.ok){load();}else{wire(null,(r&&r.error)||'Could not save the key.');}}catch(e){wire(null,'Could not reach the server.');}};}}" +
    "}" +
    "async function load(){try{var h=await auth();var d=await fetch('/klaviyo/settings',{headers:h}).then(function(r){return r.json();});" +
    "if(d&&d.error==='unauthorized'){body.textContent='Open this page inside the Shopify admin to manage settings.';badge.textContent='\\u2014';return;}" +
    "wire(d,null);}catch(e){body.textContent='Could not load Klaviyo settings.';}}" +
    "load();})();</scr" + "ipt>"
  );
}
