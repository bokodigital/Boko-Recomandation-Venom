// BOKO KLAVIYO CARD — Step 7: "App Impact — Email Recommendations" dashboard card
// + /klaviyo/impact data endpoint. Additive and self-contained; safe to remove
// (delete this file + the wired lines in server.js). Reads only bkl_* keys.
import { kvGet } from "./boko-klaviyo.js";

export function mountKlaviyoImpact(app, deps) {
  const shopFromToken = deps && deps.shopFromToken;

  // Dashboard data (admin, session-token authed like /crlift).
  app.get("/klaviyo/impact", async (req, res) => {
    res.set("Content-Type", "application/json");
    try {
      const idToken =
        String(req.get("Authorization") || "").replace(/^Bearer\s+/i, "") ||
        String(req.query.id_token || "");
      const shop = shopFromToken ? shopFromToken(idToken) : null;
      if (!shop) return res.status(401).send(JSON.stringify({ error: "unauthorized" }));
      const days = Math.max(1, Math.min(90, parseInt(req.query.range, 10) || 30));
      let total = 0;
      const mod = {};
      const daily = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const v = await kvGet("bkl_click:" + shop + ":" + d);
        const t = (v && v.total) || 0;
        if (t) {
          total += t;
          const m = (v && v.mod) || {};
          for (const k in m) mod[k] = (mod[k] || 0) + m[k];
          daily.push({ day: d, total: t });
        }
      }
      const status = await kvGet("bkl_status:" + shop);
      const attrib = await kvGet("bkl_attrib:" + shop);
      res.send(JSON.stringify({ ok: true, days: days, total: total, mod: mod, daily: daily, cache: status || null, orders: null, attrib: attrib || null }));
    } catch (e) {
      res.status(200).send(JSON.stringify({ error: e.message }));
    }
  });
}

// ---- Dashboard UI (matches the App Impact / Conversion Lift card pattern) ----
export function klaviyoCardHtml() {
  return (
    '<div id="bkKlv" class="card" style="margin:0 0 20px">' +
    '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">' +
    '<div style="font-weight:600;font-size:15px">App Impact — Email Recommendations</div>' +
    '<span style="font-size:11px;border:1px solid #e6e6e6;border-radius:99px;padding:2px 10px">Klaviyo</span>' +
    '<select id="bkKlvRange" style="margin-left:auto;min-width:130px">' +
    '<option value="7">Last 7 days</option>' +
    '<option value="30" selected>Last 30 days</option>' +
    '<option value="90">Last 90 days</option>' +
    "</select>" +
    "</div>" +
    '<div id="bkKlvBody" class="sub" style="margin:0">Loading…</div>' +
    '<div id="bkKlvExplain"></div>' +
    '<div id="bkKlvNote" class="sub" style="margin:8px 0 0;font-size:12px;color:#8a8a8a"></div>' +
    "</div>"
  );
}

export function klaviyoScript() {
  return [
    "(function(){",
    "  var sel=document.getElementById('bkKlvRange'), body=document.getElementById('bkKlvBody'), exp=document.getElementById('bkKlvExplain'), note=document.getElementById('bkKlvNote');",
    "  if(!body) return;",
    "  function tile(l,b,s){ return \"<div style='flex:1 1 150px;min-width:150px;border:1px solid #e6e6e6;border-radius:10px;padding:12px'><div style='font-size:12px;color:#8a8a8a'>\"+l+\"</div><div style='font-size:22px;font-weight:700;margin:2px 0'>\"+b+\"</div><div style='font-size:12px;color:#8a8a8a'>\"+s+\"</div></div>\"; }",
    "  async function bkKlvAuth(){ var h={Accept:'application/json'}; try{ if(window.shopify&&shopify.idToken){ h.Authorization='Bearer '+await shopify.idToken(); } }catch(e){} return h; }",
    "  async function load(){",
    "    body.innerHTML='Loading\\u2026'; note.textContent='';",
    "    try{",
    "      var h=await bkKlvAuth();",
    "      var d=await fetch('/klaviyo/impact?range='+(sel?sel.value:'30'),{headers:h}).then(function(r){return r.json();});",
    "      if(d.error){ body.innerHTML='Could not load email recommendations ('+d.error+').'; return; }",
    "      var m=d.mod||{}; var ctl=m.ctl||0; var sfy=(m.sfy||0)+(m.best||0); var other=(d.total||0)-ctl-sfy;",
    "      if(!d.total){",
    "        body.innerHTML=\"<div style='color:#8a8a8a'>Waiting for the first email recommendation clicks \\u2014 they appear here as soon as a Klaviyo campaign or flow using the AI Product Recommendations blocks goes out.</div>\";",
    "      } else {",
    "        var html=\"<div style='display:flex;gap:12px;flex-wrap:wrap'>\";",
    "        html+=tile('Email clicks', (d.total||0).toLocaleString(), 'tracked recommendation clicks');",
    "        html+=tile('Complete the Look', ctl.toLocaleString(), 'clicks from CTL blocks');",
    "        html+=tile('Selected For You', (sfy+other).toLocaleString(), 'clicks from SFY / best-seller blocks');",
    "        var ar=d.attrib||null;",
    "        if(ar&&ar.attributed_orders>0){html+=tile('Orders & revenue', ar.attributed_orders.toLocaleString()+' / $'+Math.round(ar.attributed_revenue||0).toLocaleString(), 'orders within 7 days of an email click');}",
    "        else{html+=tile('Orders & revenue', '\\u2014', 'no email-attributed orders yet');}",
    "        html+=\"</div>\";",
    "        body.innerHTML=html;",
    "      }",
    "      var eh=\"<details style='margin-top:12px'><summary style='cursor:pointer;font-size:13px;color:#555'>How these numbers are calculated</summary>\";",
    "      eh+=\"<div style='font-size:12px;color:#555;line-height:1.7;margin-top:8px'>\";",
    "      eh+=\"Every product link inside the AI Product Recommendations email blocks (Klaviyo) points at a signed tracking link. When a shopper clicks one, the click is counted here \\u2014 with its module and position \\u2014 and the shopper is sent straight to the product page with UTM tags (utm_source=boko-reco).<br><br>\";",
    "      eh+=\"<b>Complete the Look</b> counts clicks from blocks anchored to a specific product; <b>Selected For You</b> counts clicks from the personalised / best-seller blocks. The recommendations themselves are precomputed nightly by the same engine that powers the on-site widgets.<br><br>\";",
    "eh+=\"<b>Orders &amp; revenue</b> counts orders placed within 7 days of that customer clicking an email recommendation (identity-tracked links). Orders already credited by the on-site App Impact widgets are flagged in the stored data, so combined reporting never double-counts revenue.\";",
    "      eh+=\"</div></details>\";",
    "      exp.innerHTML=eh;",
    "      note.textContent='Based on '+(d.total||0).toLocaleString()+' tracked email link clicks in the last '+d.days+' days'+((d.cache&&d.cache.at)?(' \\u00b7 recommendations cache refreshed '+String(d.cache.at).slice(0,10)):'')+'.';",
    "    }catch(e){ body.innerHTML='Could not load email recommendations.'; }",
    "  }",
    "  if(sel) sel.addEventListener('change', load);",
    "  load();",
    "})();",
  ].join("\n");
}
