// BOKO KLAVIYO PROVISION — Step 8: zero-touch setup when a store connects Klaviyo.
// When a merchant saves their key on the dashboard, this module automatically:
//   1. registers the two web feeds (boko_best / boko_ctl) via the Klaviyo Web Feeds API,
//   2. creates the two Universal Content email blocks (Complete the Look + Selected For You),
//   3. clones the starter email template (from bkl_tpl:global, branded per store),
//   4. kicks off the first cache recompute -> customer map -> profile sync chain.
// Idempotent: re-running adopts anything that already exists (matched by name) and only
// creates what is missing. Results/status stored in bkl_prov:{shop}.
// Additive and self-contained; safe to remove (delete file + wired lines in server.js).
import { kvGet, kvSet } from "./boko-klaviyo.js";

const SECRET = process.env.BOKO_KLAVIYO_KEY || "bkl7391x";
const HOST = process.env.BOKO_PUBLIC_HOST || "boko-reco-app--admin7695.replit.app";
const REV = "2025-07-15";

const FEED_BEST = "boko_best";
const FEED_CTL = "boko_ctl";
const BLOCK_CTL_NAME = "Boko — Complete the Look (web feed block)";
const BLOCK_SFY_NAME = "Boko — Selected For You (profile properties block)";
const TEMPLATE_NAME = "Boko — AI Product Recommendations starter";

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

function selfUrl(path) { return "https://" + HOST + path; }

async function selfGet(path) {
  try {
    const r = await fetch(selfUrl(path));
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { return null; }
  } catch (e) { return null; }
}

// ---- Email block HTML (shop-agnostic: feed names + person lookups) ----
const BLOCK_CTL_HTML = [
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
  '{% if feeds.boko_ctl.items.0 %}',
  '<tr><td align="center" colspan="2" style="padding:20px 10px 4px 10px;font-family:Arial,Helvetica,sans-serif;font-size:18px;letter-spacing:2px;color:#111111;">COMPLETE THE LOOK</td></tr>',
  '<tr><td align="center" colspan="2" style="padding:0 10px 12px 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#666666;">Styled with {{ feeds.boko_ctl.anchor.title }}</td></tr>',
  "<tr>", ctlCell(0), ctlCell(1), "</tr>",
  "<tr>", ctlCell(2), ctlCell(3), "</tr>",
  "{% endif %}",
  "</table>",
].join("\n");

function ctlCell(i) {
  const p = "feeds.boko_ctl.items." + i;
  return '{% if ' + p + ' %}<td align="center" valign="top" width="50%" style="padding:10px;"><a href="{{ ' + p + '.url }}" style="text-decoration:none;color:#111111;"><img src="{{ ' + p + '.image }}" width="260" alt="{{ ' + p + '.title }}" style="width:100%;max-width:260px;height:auto;display:block;border:0;"><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111111;padding-top:8px;">{{ ' + p + '.title }}</div><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#111111;padding-top:2px;">${{ ' + p + '.price|floatformat:2 }}</div></a></td>{% endif %}';
}

function sfyCell(i, guard) {
  const t = "person|lookup:'boko_sfy_" + i + "_title'";
  const cell = '<td align="center" valign="top" width="50%" style="padding:10px;"><a href="{{ person|lookup:\'boko_sfy_' + i + '_url\' }}" style="text-decoration:none;color:#111111;"><img src="{{ person|lookup:\'boko_sfy_' + i + '_image\' }}" width="260" alt="{{ ' + t + ' }}" style="width:100%;max-width:260px;height:auto;display:block;border:0;"><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111111;padding-top:8px;">{{ ' + t + ' }}</div><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#111111;padding-top:2px;">${{ person|lookup:\'boko_sfy_' + i + "_price'|floatformat:2 }}</div></a></td>";
  return guard ? "{% if " + t + " %}" + cell + "{% endif %}" : cell;
}

const BLOCK_SFY_HTML = [
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
  "{% if person|lookup:'boko_sfy_1_title' %}",
  '<tr><td align="center" colspan="2" style="padding:20px 10px 12px 10px;font-family:Arial,Helvetica,sans-serif;font-size:18px;letter-spacing:2px;color:#111111;">SELECTED FOR YOU</td></tr>',
  "<tr>", sfyCell(1, false), sfyCell(2, true), "</tr>",
  "<tr>", sfyCell(3, true), sfyCell(4, true), "</tr>",
  "{% endif %}",
  "</table>",
].join("\n");

// ---- Provisioning steps ----
async function ensureFeeds(key, shop, log) {
  const out = {};
  const list = await kapi(key, "/web-feeds");
  const have = {};
  if (list.status === 200 && list.json && list.json.data) {
    for (const d of list.json.data) have[(d.attributes && d.attributes.name) || ""] = d.id;
  } else {
    log.push("feed list failed status " + list.status);
  }
  // Anchor for the CTL feed: the store's current top seller (always cached by recompute).
  const best = await kvGet("bkl_best:" + shop);
  const anchor = best && best.items && best.items[0] ? String(best.items[0].id || "") : "";
  const urls = await selfGet("/klaviyo/feedurl?key=" + encodeURIComponent(SECRET) + "&shop=" + encodeURIComponent(shop) + (anchor ? "&anchor=" + encodeURIComponent(anchor) : ""));
  const bestUrl = urls && (urls.best || urls.best_url);
  const ctlUrl = urls && (urls.ctl || urls.ctl_url);
  async function ensure(name, url) {
    if (have[name]) { log.push("feed " + name + " exists (" + have[name] + ")"); return { id: have[name], adopted: true }; }
    if (!url) { log.push("feed " + name + " skipped - no url (cache empty?)"); return null; }
    const r = await kapi(key, "/web-feeds", "POST", {
      data: { type: "web-feed", attributes: { name: name, url: url, request_method: "get", content_type: "json" } },
    });
    if (r.status >= 200 && r.status < 300 && r.json && r.json.data) {
      log.push("feed " + name + " created (" + r.json.data.id + ")");
      return { id: r.json.data.id, created: true, url: url };
    }
    if (r.status === 409) { log.push("feed " + name + " exists (409, adopted)"); return { adopted: true }; }
    log.push("feed " + name + " create failed status " + r.status + " " + JSON.stringify((r.json && r.json.errors) || "").slice(0, 160));
    return null;
  }
  out.best = await ensure(FEED_BEST, bestUrl);
  out.ctl = await ensure(FEED_CTL, ctlUrl);
  out.anchor = anchor || null;
  return out;
}

async function ensureBlocks(key, log) {
  const out = {};
  const list = await kapi(key, "/template-universal-content?page%5Bsize%5D=100");
  const have = {};
  if (list.status === 200 && list.json && list.json.data) {
    for (const d of list.json.data) have[(d.attributes && d.attributes.name) || ""] = d.id;
  }
  async function ensure(name, html) {
    if (have[name]) { log.push("block exists: " + name); return { id: have[name], adopted: true }; }
    const r = await kapi(key, "/template-universal-content", "POST", {
      data: {
        type: "template-universal-content",
        attributes: { name: name, definition: { content_type: "block", type: "html", data: { content: html, display_options: {} } } },
      },
    });
    if (r.status >= 200 && r.status < 300 && r.json && r.json.data) {
      log.push("block created: " + name);
      return { id: r.json.data.id, created: true };
    }
    log.push("block create failed (" + name + ") status " + r.status);
    return null;
  }
  out.ctl = await ensure(BLOCK_CTL_NAME, BLOCK_CTL_HTML);
  out.sfy = await ensure(BLOCK_SFY_NAME, BLOCK_SFY_HTML);
  return out;
}

function bestCell(i) {
  const p = "feeds.boko_best.items." + i;
  return '{% if ' + p + ' %}<td align="center" class="stack" valign="top" width="50%" style="padding:10px;"><a href="{{ ' + p + '.url }}" style="text-decoration:none;color:#111111;"><img src="{{ ' + p + '.image }}" width="260" alt="{{ ' + p + '.title }}" style="width:100%;max-width:260px;height:auto;display:block;border:0;"><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111111;padding-top:8px;">{{ ' + p + '.title }}</div><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#111111;padding-top:2px;">${{ ' + p + '.price|floatformat:2 }}</div></a></td>{% endif %}';
}

function buildTemplateHtml(brand, shopUrl) {
  const up = String(brand).toUpperCase();
  const divider = '<tr><td style="padding:16px 20px 0 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #e5e5e5;font-size:0;line-height:0;"> </td></tr></table></td></tr>';
  return [
    "<html>", "<head>", '<meta charset="utf-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>',
    "<title>" + brand + "</title>",
    "<style>@media only screen and (max-width: 480px) { .stack { display: block !important; width: 100% !important; max-width: 100% !important } .wrap { width: 100% !important } }</style>",
    "</head>", '<body style="margin:0;padding:0;background-color:#f5f5f5;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f5f5;">',
    '<tr><td align="center" style="padding:20px 10px;">',
    '<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;">',
    '<tr><td align="center" style="padding:28px 20px 8px 20px;font-family:Georgia,\'Times New Roman\',serif;font-size:26px;letter-spacing:6px;color:#111111;">' + up + "</td></tr>",
    '<tr><td align="center" style="padding:0 20px 18px 20px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:3px;color:#888888;">CURATED BY AI PRODUCT RECOMMENDATIONS</td></tr>',
    '<tr><td style="padding:0 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #e5e5e5;font-size:0;line-height:0;"> </td></tr></table></td></tr>',
    "{% if feeds.boko_ctl.items.0 %}",
    '<tr><td align="center" style="padding:26px 20px 4px 20px;font-family:Arial,Helvetica,sans-serif;font-size:18px;letter-spacing:2px;color:#111111;">COMPLETE THE LOOK</td></tr>',
    '<tr><td align="center" style="padding:0 20px 16px 20px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#666666;">Styled with {{ feeds.boko_ctl.anchor.title }}</td></tr>',
    '<tr><td style="padding:0 10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
    "<tr>", ctlCell(0), ctlCell(1), "</tr>", "<tr>", ctlCell(2), ctlCell(3), "</tr>",
    "</table></td></tr>", "{% endif %}",
    "{% if person|lookup:'boko_sfy_1_title' %}", divider,
    '<tr><td align="center" style="padding:26px 20px 16px 20px;font-family:Arial,Helvetica,sans-serif;font-size:18px;letter-spacing:2px;color:#111111;">SELECTED FOR YOU</td></tr>',
    "{% if person|lookup:'boko_sfy_basis' %}<tr><td align=\"center\" style=\"padding:0 20px 12px 20px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#666666;\">{{ person|lookup:'boko_sfy_basis' }}</td></tr>{% endif %}",
    '<tr><td style="padding:0 10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
    "<tr>", sfyCell(1, false), sfyCell(2, true), "</tr>", "<tr>", sfyCell(3, true), sfyCell(4, true), "</tr>",
    "</table></td></tr>",
    "{% elif feeds.boko_best.items.0 %}", divider,
    '<tr><td align="center" style="padding:26px 20px 16px 20px;font-family:Arial,Helvetica,sans-serif;font-size:18px;letter-spacing:2px;color:#111111;">SELECTED FOR YOU</td></tr>',
    '<tr><td style="padding:0 10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
    "<tr>", bestCell(0), bestCell(1), "</tr>", "<tr>", bestCell(2), bestCell(3), "</tr>",
    "</table></td></tr>", "{% endif %}",
    '<tr><td align="center" style="padding:28px 20px 10px 20px;"><a href="' + shopUrl + '/collections/all?utm_source=boko-reco&amp;utm_medium=email&amp;utm_campaign=starter&amp;utm_content=shop-all" style="display:inline-block;background-color:#111111;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:13px;letter-spacing:2px;text-decoration:none;padding:14px 34px;">SHOP ALL</a></td></tr>',
    '<tr><td align="center" style="padding:18px 20px 30px 20px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#999999;">' + brand + "<br/><br/>{% unsubscribe 'Unsubscribe' %}</td></tr>",
    "</table>", "</td></tr>", "</table>", "</body>", "</html>",
  ].join("\n");
}

async function ensureTemplate(key, shop, log) {
  const list = await kapi(key, "/templates?filter=equals(name,%22" + encodeURIComponent(TEMPLATE_NAME) + "%22)");
  if (list.status === 200 && list.json && list.json.data) {
    for (const d of list.json.data) {
      if (d.attributes && d.attributes.name === TEMPLATE_NAME) { log.push("template exists (" + d.id + ")"); return { id: d.id, adopted: true }; }
    }
  }
  const cfg = await kvGet("bkl_kcfg:" + shop);
  const brand = (cfg && cfg.account_name) || shop.replace(".myshopify.com", "");
  const html = buildTemplateHtml(brand, "https://" + shop);
  const r = await kapi(key, "/templates", "POST", {
    data: { type: "template", attributes: { name: TEMPLATE_NAME, editor_type: "CODE", html: html } },
  });
  if (r.status >= 200 && r.status < 300 && r.json && r.json.data) {
    log.push("template created (" + r.json.data.id + ")");
    return { id: r.json.data.id, created: true };
  }
  log.push("template create failed status " + r.status);
  return null;
}

export async function provisionKlaviyo(shop) {
  const log = [];
  const key = await keyFor(shop);
  if (!key) return { ok: false, error: "no klaviyo key for shop" };

  // Make sure the recommendation cache exists BEFORE registering feeds (Klaviyo
  // validates the feed URL on create; an empty cache still returns valid JSON,
  // but a fresh cache means the feed previews with real products immediately).
  let best = await kvGet("bkl_best:" + shop);
  if (!best || !(best.items || []).length) {
    log.push("cache empty - running recompute first");
    await selfGet("/klaviyo/recompute?key=" + encodeURIComponent(SECRET) + "&shop=" + encodeURIComponent(shop) + "&max=150");
    best = await kvGet("bkl_best:" + shop);
  }

  const feeds = await ensureFeeds(key, shop, log);
  const blocks = await ensureBlocks(key, log);
  const template = await ensureTemplate(key, shop, log);

  const prov = {
    shop: shop,
    feeds: feeds, blocks: blocks, template_id: (template && template.id) || null,
    at: new Date().toISOString(), log: log,
  };
  await kvSet("bkl_prov:" + shop, prov);

  // Fire-and-forget: build the customer purchase map, then run an initial profile
  // sync so Selected For You data appears without waiting for the nightly job.
  (async () => {
    try {
      await selfGet("/klaviyo/custmap?key=" + encodeURIComponent(SECRET) + "&shop=" + encodeURIComponent(shop) + "&days=365");
      await selfGet("/klaviyo/sync?key=" + encodeURIComponent(SECRET) + "&shop=" + encodeURIComponent(shop) + "&limit=200");
    } catch (e) {}
  })();

  return Object.assign({ ok: true }, prov);
}

export function mountKlaviyoProvision(app) {
  // Called by the settings module right after a key is saved (fire-and-forget).
  globalThis.__bklProvisionHook = function (shop) { provisionKlaviyo(shop).catch(function () {}); };

  // Manual (re-)provision + status. Secret-keyed.
  app.all("/klaviyo/provision", async (req, res) => {
    try {
      if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
      const shop = String(req.query.shop || "");
      if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) return res.status(400).json({ error: "bad shop" });
      res.json(await provisionKlaviyo(shop));
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Module source export (secret-keyed) - lets sibling apps pull the canonical files.
  app.get("/klaviyo/src", async (req, res) => {
    try {
      if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
      const fname = String(req.query.f || "");
      if (!/^boko-klaviyo[a-z-]*\.js$/.test(fname)) return res.status(400).json({ error: "bad file" });
      const fs = await import("fs");
      res.type("text/plain").send(fs.readFileSync(new URL("./" + fname, import.meta.url), "utf8"));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get("/klaviyo/provstatus", async (req, res) => {
    try {
      if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
      const shop = String(req.query.shop || "");
      res.json((await kvGet("bkl_prov:" + shop)) || { provisioned: false });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Admin KV write (used once to seed bkl_tpl:global with the starter template HTML).
  app.post("/klaviyo/kvput", async (req, res) => {
    try {
      if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
      const body = req.body || {};
      const k = String(body.k || "");
      if (k.indexOf("bkl_") !== 0) return res.status(400).json({ error: "key must start with bkl_" });
      if (JSON.stringify(body.v || null).length > 300000) return res.status(400).json({ error: "value too large" });
      await kvSet(k, body.v);
      res.json({ ok: true, k: k });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}
