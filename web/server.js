// server.mt.js — Boko AI Recommendations: MULTI-TENANT OAuth app.
// One deployment serves many stores. Each store installs via OAuth and gets its own
// access token stored in the key-value DB (keyed by shop domain) — fully isolated:
// installing/uninstalling one store never touches another.
//
// Endpoints:
//   GET  /                        → health / entry (redirects to /auth or /dashboard)
//   GET  /auth                    → start OAuth (redirect to Shopify consent)
//   GET  /auth/callback           → verify + exchange code → store token → register webhook
//   GET  /proxy/recommend         → storefront recommendations (Shopify App Proxy, signed)
//   GET  /stats                   → dashboard data (Authorization: Bearer <session id_token>)
//   GET  /dashboard               → embedded Admin dashboard (App Bridge + session token)
//   POST /webhooks/app_uninstalled→ delete that shop's token (HMAC verified)
//
// Secrets required: SHOPIFY_API_KEY (client id), SHOPIFY_API_SECRET (client secret),
//   HOST (this app's base URL, e.g. https://boko-reco-app--admin7695.replit.app),
//   SCOPES (default read_products,read_orders), optional SHOPIFY_API_VERSION, LLM_*.

import express from "express";
import crypto from "crypto";
import Database from "@replit/database";
import { recommend } from "./recommendations.js";
import { track, funnelCounts } from "./boko-tracker.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const API_KEY = process.env.SHOPIFY_API_KEY || "";
const API_SECRET = process.env.SHOPIFY_API_SECRET || "";
const SCOPES = process.env.SCOPES || "read_products,read_orders";
const HOST = (process.env.HOST || "").replace(/\/+$/, "");
const API = process.env.SHOPIFY_API_VERSION || "2024-10";
const db = new Database();

// ---- token store (per shop) — handles both @replit/database return styles ----
const k = (shop) => "shop:" + shop;
async function getToken(shop) {
  const r = await db.get(k(shop));
  if (r && typeof r === "object" && "ok" in r) return r.ok ? r.value : null;
  return r || null;
}
async function setToken(shop, token) { await db.set(k(shop), token); }
async function delToken(shop) { try { await db.delete(k(shop)); } catch (e) {} }

const validShop = (s) => /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(s || "");

async function gql(shop, token, query, variables) {
  const r = await fetch(`https://${shop}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

const app = express();
// Raw body only for webhooks (needed for HMAC); JSON for everything else.
app.use("/webhooks", express.raw({ type: "*/*" }));
app.use(express.json());
app.use((req, res, next) => { res.set("Access-Control-Allow-Origin", "*"); res.set("Access-Control-Allow-Methods", "GET,OPTIONS"); next(); });

// ---------- OAuth ----------
app.get("/auth", (req, res) => {
  const shop = req.query.shop;
  if (!validShop(shop)) return res.status(400).send("Missing or invalid ?shop");
  const redirectUri = HOST + "/auth/callback";
  const state = crypto.randomBytes(16).toString("hex");
  const url = `https://${shop}/admin/oauth/authorize?client_id=${API_KEY}` +
    `&scope=${encodeURIComponent(SCOPES)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { shop, hmac, code } = req.query;
    if (!validShop(shop)) return res.status(400).send("Invalid shop");
    // Verify HMAC over the query (excluding hmac/signature)
    const params = { ...req.query };
    delete params.hmac; delete params.signature;
    const message = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&");
    const digest = crypto.createHmac("sha256", API_SECRET).update(message).digest("hex");
    if (digest !== hmac) return res.status(400).send("HMAC validation failed");
    // Exchange the code for a permanent access token
    const tok = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: API_KEY, client_secret: API_SECRET, code }),
    }).then((r) => r.json());
    if (!tok.access_token) return res.status(500).send("Token exchange failed");
    await setToken(shop, tok.access_token);
    // Register the uninstall webhook so we clean up this shop's token automatically
    try {
      await gql(shop, tok.access_token,
        `mutation($u:URL!){ webhookSubscriptionCreate(topic: APP_UNINSTALLED, webhookSubscription:{ callbackUrl:$u, format: JSON }){ userErrors{ message } } }`,
        { u: HOST + "/webhooks/app_uninstalled" });
    } catch (e) {}
    // Open the embedded app in admin
    res.redirect(`https://${shop}/admin/apps/${API_KEY}`);
  } catch (e) {
    res.status(500).send("Auth error: " + e.message);
  }
});

// ---------- Storefront recommendations via Shopify App Proxy ----------
function verifyProxy(query) {
  const { signature, ...rest } = query;
  if (!signature) return false;
  const message = Object.keys(rest).sort()
    .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(",") : rest[key]}`).join("");
  const digest = crypto.createHmac("sha256", API_SECRET).update(message).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(signature))); }
  catch (e) { return false; }
}

async function loadProducts(shop, token, limit = 100, productType = "") {
  const safe = productType.replace(/[^a-zA-Z0-9 &-]/g, "");
  const qstr = safe ? `status:active product_type:${safe}` : "status:active";
  const query = `query($n:Int!){ products(first:$n, query:"${qstr}", sortKey: PUBLISHED_AT, reverse: true){ edges{ node{ id title handle productType vendor tags publishedAt createdAt isGiftCard collections(first:20){ edges{ node{ handle } } } options{ name values } featuredImage{url} variants(first:100){ edges{ node{ id title price availableForSale selectedOptions{ name value } } } } } } } }`;
  const j = await gql(shop, token, query, { n: limit });
  const edges = (j.data && j.data.products && j.data.products.edges) || [];
  return edges.map((e, i) => {
    const n = e.node;
    const varEdges = (n.variants && n.variants.edges) || [];
    const v = varEdges[0] && varEdges[0].node;
    const rawOpts = n.options || [];
    const options = rawOpts
      .filter((o) => !(o.name === "Title" && o.values.length === 1 && o.values[0] === "Default Title"))
      .map((o) => ({ name: o.name, values: o.values }));
    const variants = varEdges.map((ve) => {
      const vn = ve.node;
      const m = String(vn.id).match(/(\d+)$/);
      return {
        id: m ? m[1] : vn.id,
        title: vn.title,
        price: parseFloat(vn.price),
        available: !!vn.availableForSale,
        options: options.map((o) => {
          const so = (vn.selectedOptions || []).find((s) => s.name === o.name);
          return so ? so.value : null;
        }),
      };
    });
    const collHandles = ((n.collections && n.collections.edges) || []).map((ce) => (ce.node.handle || "").toLowerCase());
    const tags = (n.tags || []).map((t) => String(t).toLowerCase());
    const isGift = n.isGiftCard === true
      || (n.productType || "").toLowerCase().includes("gift")
      || tags.some((t) => t.includes("gift"))
      || collHandles.some((h) => h.includes("gift"));
    if (isGift) return null;
    return { id: n.id, handle: n.handle, variantId: v && v.id, available: !!(v && v.availableForSale),
      title: n.title, vendor: n.vendor, tags: n.tags || [], category: (n.productType || "").toLowerCase(),
      price: v ? parseFloat(v.price) : 0, img: (n.featuredImage && n.featuredImage.url) || "",
      options, variants, createdAt: n.publishedAt || n.createdAt || null,
      orders: Math.max(0, limit - i) * 3, views: 0 };
  }).filter((p) => p && p.variantId && p.available);
}

app.get("/proxy/recommend", async (req, res) => {
  res.set("Content-Type", "application/json");
  try {
    if (!verifyProxy(req.query)) return res.status(401).send(JSON.stringify({ items: [], error: "bad signature" }));
    const shop = req.query.shop;
    const token = await getToken(shop);
    if (!token) return res.status(200).send(JSON.stringify({ items: [], error: "app not installed for shop" }));
    const limit = Math.min(parseInt(req.query.limit || "8", 10), 24);
    const atype = (req.query.atype || "").trim();
    const anum = (req.query.anchor || "").trim();
    let products = await loadProducts(shop, token, 250);
    const found = anum ? products.find((p) => p.id.endsWith(anum)) : null;
    const anchor = found || ((atype || req.query.atitle) ? {
      id: "anchor:" + anum,
      title: req.query.atitle || "",
      category: atype.toLowerCase(),
      tags: (req.query.atags || "").split(",").map((s) => s.trim()).filter(Boolean),
      price: parseFloat(req.query.aprice || "0") || 0,
    } : null);
    if (anum) products = products.filter((p) => !p.id.endsWith(anum));
    const items = await recommend({ products, anchor, limit });
    res.status(200).send(JSON.stringify({ items }));
  } catch (e) {
    res.status(200).send(JSON.stringify({ items: [], error: e.message }));
  }
});

// ---------- Embedded dashboard data (session-token authenticated) ----------
function shopFromSessionToken(idToken) {
  try {
    const [h, p, s] = (idToken || "").split(".");
    if (!h || !p || !s) return null;
    const expected = crypto.createHmac("sha256", API_SECRET).update(h + "." + p).digest("base64url");
    if (expected !== s) return null;
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    if (payload.aud !== API_KEY) return null;
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    const shop = (payload.dest || "").replace(/^https?:\/\//, "");
    return validShop(shop) ? shop : null;
  } catch (e) { return null; }
}

async function tokenExchange(shop, idToken) {
  try {
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: API_KEY, client_secret: API_SECRET,
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: idToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
      }),
    }).then((x) => x.json());
    if (!r || !r.access_token) return null;
    await setToken(shop, r.access_token);
    try {
      await gql(shop, r.access_token,
        `mutation($u:URL!){ webhookSubscriptionCreate(topic: APP_UNINSTALLED, webhookSubscription:{ callbackUrl:$u, format: JSON }){ userErrors{ message } } }`,
        { u: HOST + "/webhooks/app_uninstalled" });
    } catch (e) {}
    return r.access_token;
  } catch (e) { return null; }
}

async function loadStats(shop, token, days) {
  const since = new Date(Date.now() - (days || 90) * 864e5).toISOString().slice(0, 10);
  const query = `query($n:Int!,$q:String){ orders(first:$n, reverse:true, query:$q){ edges{ node{ lineItems(first:50){ edges{ node{ title quantity discountedTotalSet{ shopMoney{ amount currencyCode } } originalTotalSet{ shopMoney{ amount currencyCode } } discountAllocations{ allocatedAmountSet{ shopMoney{ amount } } } customAttributes{ key value } } } } } } } }`;
  const j = await gql(shop, token, query, { n: 100, q: "created_at:>=" + since });
  if (j.errors) return { error: JSON.stringify(j.errors), pdp: { total: 0, revenue: 0, items: [] }, cart_drawer: { total: 0, revenue: 0, items: [] } };
  const orders = (j.data && j.data.orders && j.data.orders.edges) || [];
  const src = { pdp: { items: {}, rev: 0 }, cart_drawer: { items: {}, rev: 0 }, sfy_page: { items: {}, rev: 0 }, sfy_menu: { items: {}, rev: 0 } };
  let currency = "";
  orders.forEach((o) => (o.node.lineItems.edges || []).forEach((le) => {
    const li = le.node; let tag = null;
    let reco=null,source=null;(li.customAttributes || []).forEach((a) => { if (a.key === "_boko_reco") reco = a.value; if (a.key === "_boko_source") source = a.value; });if(reco==="pdp")tag="pdp";else if(reco==="cart_drawer")tag="cart_drawer";else if(source==="selected-for-you-page")tag="sfy_page";else if(source==="selected-for-you-menu")tag="sfy_menu";
    if (tag && src[tag]) {
      const orig = li.originalTotalSet && li.originalTotalSet.shopMoney; const alloc=(li.discountAllocations||[]).reduce(function(x,da){return x+parseFloat((da.allocatedAmountSet&&da.allocatedAmountSet.shopMoney&&da.allocatedAmountSet.shopMoney.amount)||0);},0); const amt=Math.max(0,(orig?parseFloat(orig.amount):0)-alloc);
      if (orig && orig.currencyCode) currency = orig.currencyCode;
      const it = src[tag].items[li.title] || { count: 0, rev: 0 };
      it.count += li.quantity; it.rev += amt; src[tag].items[li.title] = it; src[tag].rev += amt;
    }
  }));
  const pack = (s) => {
    const items = Object.keys(s.items).map((key) => ({ title: key, count: s.items[key].count, revenue: Math.round(s.items[key].rev * 100) / 100 })).sort((a, b) => b.count - a.count);
    return { total: items.reduce((x, i) => x + i.count, 0), revenue: Math.round(s.rev * 100) / 100, items };
  };
  const pdp = pack(src.pdp), cd = pack(src.cart_drawer), sfyPage = pack(src.sfy_page), sfyMenu = pack(src.sfy_menu);
  return { ordersScanned: orders.length, since, currency, totalRevenue: Math.round((pdp.revenue + cd.revenue + sfyPage.revenue + sfyMenu.revenue) * 100) / 100, totalItems: pdp.total + cd.total + sfyPage.total + sfyMenu.total, pdp, cart_drawer: cd, sfy_page: sfyPage, sfy_menu: sfyMenu };
}

app.get("/stats", async (req, res) => {
  res.set("Content-Type", "application/json");
  try {
    const idToken = (req.headers.authorization || "").replace(/^Bearer /, "");
    const shop = shopFromSessionToken(idToken);
    if (!shop) return res.status(401).send(JSON.stringify({ error: "unauthorized" }));
    let token = await getToken(shop);
    if (!token) token = await tokenExchange(shop, idToken);
    if (!token) return res.status(200).send(JSON.stringify({ error: "not installed", pdp: { total: 0, revenue: 0, items: [] }, cart_drawer: { total: 0, revenue: 0, items: [] } }));
    const days = Math.min(parseInt(req.query.days || "90", 10), 365);
    res.status(200).send(JSON.stringify(await loadStats(shop, token, days)));
  } catch (e) {
    res.status(200).send(JSON.stringify({ error: e.message, pdp: { total: 0, revenue: 0, items: [] }, cart_drawer: { total: 0, revenue: 0, items: [] } }));
  }
});

// storefront beacon — reached via the /apps/reco/track app proxy (proxy forwards /apps/reco/<x> -> /proxy/<x>)
app.post("/proxy/track", express.json({ type: () => true, limit: "2kb" }), (req, res) => {
  try { const b = req.body || {}; track(b.event, b.source); } catch (e) {}
  res.status(204).end();
});

// funnel data for the dashboard
app.get("/funnel", async (req, res) => {
  res.set("Content-Type", "application/json");
  try {
    const idToken = (req.headers.authorization || "").replace(/^Bearer /, "");
    const shop = shopFromSessionToken(idToken);
    if (!shop) return res.status(401).send(JSON.stringify({ error: "unauthorized" }));
    let token = await getToken(shop);
    if (!token) token = await tokenExchange(shop, idToken);
    const days = parseInt(req.query.days, 10) || 90;
    const clicks = funnelCounts(days);
    const buys = { pdp: { count: 0, rev: 0 }, cart_drawer: { count: 0, rev: 0 }, sfy: { count: 0, rev: 0 } };
    let currency = "";
    if (token) {
      try {
        const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
        const q = `query($n:Int!,$q:String){ orders(first:$n,reverse:true,query:$q){ edges{ node{ lineItems(first:50){ edges{ node{ quantity discountedTotalSet{ shopMoney{ amount currencyCode } } customAttributes{ key value } } } } } } } }`;
        const j = await gql(shop, token, q, { n: 100, q: "created_at:>=" + since });
        const orders = (j.data && j.data.orders && j.data.orders.edges) || [];
        orders.forEach((o) => (o.node.lineItems.edges || []).forEach((le) => {
          const li = le.node; let s = null;
          (li.customAttributes || []).forEach((a) => {
            if (a.key === "_boko_reco" && (a.value === "pdp" || a.value === "cart_drawer")) s = a.value;
            if (a.key === "_boko_source" && String(a.value).indexOf("selected-for-you") > -1) s = "sfy";
          });
          if (s) {
            const m = li.discountedTotalSet && li.discountedTotalSet.shopMoney;
            buys[s].count += li.quantity;
            buys[s].rev += m ? parseFloat(m.amount) : 0;
            if (m && m.currencyCode) currency = m.currencyCode;
          }
        }));
      } catch (e) {}
    }
    const pack = (s) => ({ clicks: clicks[s].click, adds: clicks[s].add, purchases: buys[s].count, revenue: Math.round(buys[s].rev * 100) / 100 });
    res.status(200).send(JSON.stringify({ days, currency, sfy: pack("sfy"), pdp: pack("pdp"), cart_drawer: pack("cart_drawer") }));
  } catch (e) {
    res.status(200).send(JSON.stringify({ error: e.message, sfy: { clicks: 0, adds: 0, purchases: 0, revenue: 0 }, pdp: { clicks: 0, adds: 0, purchases: 0, revenue: 0 }, cart_drawer: { clicks: 0, adds: 0, purchases: 0, revenue: 0 } }));
  }
});

const DASHBOARD = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
__APP_BRIDGE__
<title>Boko Recommendations — Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Jost:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--ink:#1f1f1f;--muted:#6b7280;--line:#e6e6e6;--lime:#BFFC00;--bg:#f0f2f5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);font-family:"Jost",-apple-system,sans-serif;color:var(--ink)}
.wrap{max-width:980px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:24px;font-weight:600;margin:0 0 4px}.sub{color:var(--muted);font-size:14px;margin:0 0 22px}
.row{display:flex;gap:8px;align-items:center;margin-bottom:18px}
select{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:#fff}
.hero{background:#0a0a0a;color:#fff;border-radius:14px;padding:22px 24px;margin-bottom:16px;display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
.hero .v{font-size:40px;font-weight:700;letter-spacing:-1px}.hero .lime{color:var(--lime)}.hero .x{color:#bdbdbd;font-size:14px}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:720px){.cards{grid-template-columns:1fr}}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px;box-shadow:0 2px 16px rgba(0,0,0,.05)}
.big{font-size:34px;font-weight:700;letter-spacing:-1px;margin:0}.rev{font-size:15px;color:#1f7a45;font-weight:600;margin:2px 0 0}
.pill{display:inline-block;background:var(--lime);color:#0a0a0a;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;padding:3px 10px;border-radius:99px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}
th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:600}td.n{text-align:right;font-weight:600}td.r{text-align:right;color:#1f7a45}
.empty{color:var(--muted);font-size:13px;padding:14px 0}.err{background:#fdeceb;border:1px solid #f6cdc8;color:#7a1d13;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:16px}
.foot{color:var(--muted);font-size:12px;margin-top:20px;text-align:center}
</style></head><body><div class="wrap">
<h1>Boko AI Recommendations — Performance</h1>
<p class="sub">Items and revenue from products added via your recommendation widgets.</p>
<style>
  .how-to{border:1px solid #e3e3e3;border-radius:12px;background:#fff;margin:0 0 20px;overflow:hidden}
  .how-to>summary{list-style:none;cursor:pointer;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:15px;color:#1a1a1a}
  .how-to>summary::-webkit-details-marker{display:none}
  .how-to>summary .chev{transition:transform .2s ease;font-size:13px;color:#888}
  .how-to[open]>summary .chev{transform:rotate(180deg)}
  .how-to__body{padding:4px 18px 18px;border-top:1px solid #f0f0f0;font-size:14px;line-height:1.55;color:#333}
  .how-to__body h4{margin:16px 0 6px;font-size:14px;color:#1a1a1a}
  .how-to__body ol{margin:6px 0 6px 18px;padding:0}
  .how-to__body li{margin:4px 0}
  .how-to__body code{background:#f4f4f4;border-radius:4px;padding:1px 5px;font-size:13px}
  .how-to__body .muted{color:#777;font-size:13px}
</style>
<details class="how-to">
  <summary>How to use AI Recommendations <span class="chev">&#9660;</span></summary>
  <div class="how-to__body"><p>AI Recommendations shows AI-picked products in four places: the <strong>product page rail</strong>, the <strong>cart drawer</strong>, a full <strong>&ldquo;Selected for you&rdquo; page</strong>, and a <strong>&ldquo;Selected for you&rdquo; mega-menu</strong>. Shoppers pick a variant and add to cart; on the product page they can also tick items and <strong>Add bundle to cart</strong> for a 10% discount.</p><h4>1. Start your subscription</h4><ol><li>Open the app from <strong>Apps</strong> and approve permissions.</li><li>Start the plan (14-day free trial). Recommendations show while the trial/subscription is active.</li></ol><h4>2. Add the product-page rail</h4><ol><li>Go to <strong>Online Store &rarr; Themes &rarr; Customize</strong>.</li><li>Choose a <strong>Products</strong> template in the top dropdown.</li><li>Under the product section click <strong>&#65291; Add block &rarr; AI Recommendations</strong> (under Apps).</li><li>Drag it into place and <strong>Save</strong>.</li></ol><h4>3. Turn on the cart-drawer carousel</h4><ol><li>Still in <strong>Customize</strong>, open <strong>App embeds</strong> (puzzle-piece icon).</li><li>Enable the Boko cart-drawer embed and <strong>Save</strong>.</li></ol><h4>4. Add the &ldquo;Selected for you&rdquo; page</h4><ol><li><strong>Edit code &rarr; Sections</strong>: add the <strong>boko-selected-for-you</strong> section.</li><li><strong>Online Store &rarr; Pages &rarr; Add page</strong> &ldquo;Selected for you&rdquo; and set its theme template to <strong>selected-for-you</strong>. Live at <strong>/pages/selected-for-you</strong>.</li></ol><h4>5. Add the &ldquo;Selected for you&rdquo; mega menu</h4><ol><li><strong>Edit code &rarr; Snippets</strong>: add the <strong>boko-selected-for-you-megamenu</strong> snippet so it renders in your header. It attaches to the top nav and shows 4 items.</li></ol><h4>6. Set up the bundle discount</h4><ol><li>Open <strong>Discount Bot &rarr; Create discount &rarr; Super discount</strong>; set <strong>Method: Automatic</strong>, title <strong>Bundle 10% Off</strong>.</li><li>Add a <strong>Product</strong> discount of <strong>10%</strong>.</li><li>Enable <strong>Add cart line attribute condition</strong>: key <strong>_boko_bundle</strong>, <strong>Does Match 1</strong>, and set <strong>Minimum quantity 2</strong>. Save.</li><li>Only the product-page <strong>Add bundle to cart</strong> button tags items with <strong>_boko_bundle=1</strong>, so the 10% applies to genuine bundles only.</li></ol><h4>Performance</h4><p>The cards below show items purchased and <strong>net revenue</strong> (after discounts) for each of the four surfaces, for the period you select.</p><p class="muted">Need help? Contact Boko at admin@boko.com.au.</p>
  </div>
</details>
<div class="row"><label class="sub" style="margin:0">Period</label>
<select id="days"><option value="30">Last 30 days</option><option value="90" selected>Last 90 days</option><option value="365">Last 12 months</option></select>
<span id="meta" class="sub" style="margin:0 0 0 auto"></span></div>
<div id="err"></div>
<div class="hero"><div><div class="v lime" id="revTotal">–</div><div class="x">total revenue from recommendations</div></div>
<div style="margin-left:auto"><div class="v" id="itemTotal">–</div><div class="x">items purchased</div></div></div>
<div class="cards">
  <div class="card"><span class="pill">Product page rail</span><div class="big" id="pdpTotal">–</div><div class="rev" id="pdpRev"></div>
    <table><thead><tr><th>Product</th><th style="text-align:right">Qty</th><th style="text-align:right">Revenue</th></tr></thead><tbody id="pdpRows"></tbody></table></div>
  <div class="card"><span class="pill">Cart drawer carousel</span><div class="big" id="cdTotal">–</div><div class="rev" id="cdRev"></div>
    <table><thead><tr><th>Product</th><th style="text-align:right">Qty</th><th style="text-align:right">Revenue</th></tr></thead><tbody id="cdRows"></tbody></table></div><div class="card" style="grid-column:1/-1;"><span class="pill">Selected For You collection</span><div class="big" id="spTotal">-</div><div class="rev" id="spRev"></div><table><thead><tr><th>Product</th><th style="text-align:right">Qty</th><th style="text-align:right">Revenue</th></tr></thead><tbody id="spRows"></tbody></table></div>
</div><p class="foot" id="foot"></p>
<div id="bkFunnel" style="margin-top:28px;font-family:'Poppins',system-ui,sans-serif">
  <div style="margin-bottom:14px">
    <div style="font-size:18px;font-weight:600">User Flow by Component</div>
    <div style="font-size:12px;color:#6b7280;margin-top:2px">Clicks &rarr; Add to cart &rarr; Purchases &middot; attributed to the source component</div>
  </div>
  <div id="bkFunnelGrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px"></div>
</div>
</div>
<style>
  #bkFunnel .bkc{background:#fff;border:1px solid #ececf2;border-radius:14px;padding:16px}
  #bkFunnel .bkh{display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px;font-weight:600}
  #bkFunnel .bkdot{width:9px;height:9px;border-radius:3px;background:#BFFC00;box-shadow:0 0 0 3px rgba(191,252,0,.18)}
  #bkFunnel .bkrow{display:flex;justify-content:space-between;align-items:baseline}
  #bkFunnel .bkl{font-size:12px;color:#6b7280;font-weight:500}
  #bkFunnel .bkn{font-size:18px;font-weight:600}
  #bkFunnel .bkbar{height:9px;background:#F1F2F7;border-radius:6px;overflow:hidden;margin-top:5px}
  #bkFunnel .bkfill{height:100%;background:#BFFC00;border-radius:6px}
  #bkFunnel .bkfill.dark{background:#111}
  #bkFunnel .bkconv{font-size:11px;color:#9aa0ab;margin:7px 0 10px}
  #bkFunnel .bkconv b{color:#111;font-weight:600}
  #bkFunnel .bkfoot{display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding-top:12px;border-top:1px dashed #ececf2}
  #bkFunnel .bkfoot .l{font-size:11px;color:#6b7280}
  #bkFunnel .bkfoot .v{font-size:15px;font-weight:600}
  @media(max-width:760px){#bkFunnelGrid{grid-template-columns:1fr!important}}
</style>
<script>
var CUR="";
function fmt(n){try{return new Intl.NumberFormat(undefined,{style:"currency",currency:CUR||"USD"}).format(n||0);}catch(e){return "$"+(Number(n||0)).toFixed(2);}}
function rows(tb,items){tb.innerHTML=(items&&items.length)?items.map(function(i){return "<tr><td>"+i.title+"</td><td class='n'>"+i.count+"</td><td class='r'>"+fmt(i.revenue)+"</td></tr>";}).join(""):"<tr><td colspan='3' class='empty'>No purchases yet from this source.</td></tr>";}
function bkFunnel(days){
  days = days || 90;
  authedFetch("/funnel?days=" + days).then(function(d){
    var cur = d.currency || "";
    var defs = [
      { key:"sfy",         name:"Selected For You" },
      { key:"pdp",         name:"Product Rail (PDP)" },
      { key:"cart_drawer", name:"Cart Drawer" }
    ];
    function pct(a,b){ return b>0 ? Math.round(a/b*100) : 0; }
    function nn(x){ return (x||0).toLocaleString(); }
    function money(x){ return (cur? cur+" " : "$") + (Math.round(x||0)).toLocaleString(); }
    function card(def){
      var s = d[def.key] || { clicks:0, adds:0, purchases:0, revenue:0 };
      var wAdd = pct(s.adds, s.clicks), wBuy = pct(s.purchases, s.clicks);
      var addRate = pct(s.adds, s.clicks), buyRate = pct(s.purchases, s.adds), cvr = pct(s.purchases, s.clicks);
      return '<div class="bkc">'
        + '<div class="bkh"><span class="bkdot"></span>' + def.name + '</div>'
        + '<div><div class="bkrow"><span class="bkl">Clicks</span><span class="bkn">' + nn(s.clicks) + '</span></div>'
        +   '<div class="bkbar"><div class="bkfill" style="width:100%"></div></div></div>'
        + '<div class="bkconv"><b>' + addRate + '%</b> added to cart</div>'
        + '<div><div class="bkrow"><span class="bkl">Add to cart</span><span class="bkn">' + nn(s.adds) + '</span></div>'
        +   '<div class="bkbar"><div class="bkfill" style="width:' + wAdd + '%"></div></div></div>'
        + '<div class="bkconv"><b>' + buyRate + '%</b> of carts purchased</div>'
        + '<div><div class="bkrow"><span class="bkl">Purchases</span><span class="bkn">' + nn(s.purchases) + '</span></div>'
        +   '<div class="bkbar"><div class="bkfill dark" style="width:' + Math.max(wBuy,3) + '%"></div></div></div>'
        + '<div class="bkfoot"><div><div class="l">Revenue</div><div class="v">' + money(s.revenue) + '</div></div>'
        +   '<div style="text-align:right"><div class="l">Click &rarr; buy</div><div class="v">' + cvr + '%</div></div></div>'
        + '</div>';
    }
    document.getElementById("bkFunnelGrid").innerHTML = defs.map(card).join("");
  }).catch(function(){});
}
async function authedFetch(url){
  var headers={Accept:"application/json"};
  try{ if(window.shopify&&shopify.idToken){ var t=await shopify.idToken(); headers.Authorization="Bearer "+t; } }catch(e){}
  return fetch(url,{headers:headers}).then(function(r){return r.json();});
}
function load(){
  var days=document.getElementById("days").value;
  authedFetch("/stats?days="+days).then(function(d){
    CUR=d.currency||"USD";
    document.getElementById("err").innerHTML=d.error?"<div class='err'>"+(d.error==="unauthorized"?"Couldn't verify your session — open this from Shopify Admin → Apps.":"Couldn't read orders: "+d.error+". Ensure the app has read_orders scope.")+"</div>":"";
    document.getElementById("revTotal").textContent=fmt(d.totalRevenue);
    document.getElementById("itemTotal").textContent=(d.totalItems!=null?d.totalItems:0);
    document.getElementById("pdpTotal").textContent=(d.pdp&&d.pdp.total)||0;
    document.getElementById("cdTotal").textContent=(d.cart_drawer&&d.cart_drawer.total)||0;
    document.getElementById("pdpRev").textContent="Revenue: "+fmt(d.pdp&&d.pdp.revenue);
    document.getElementById("cdRev").textContent="Revenue: "+fmt(d.cart_drawer&&d.cart_drawer.revenue);
    rows(document.getElementById("pdpRows"),d.pdp&&d.pdp.items);
    rows(document.getElementById("cdRows"),d.cart_drawer&&d.cart_drawer.items);document.getElementById("spTotal").textContent=(d.sfy_page&&d.sfy_page.total)||0;document.getElementById("spRev").textContent="Revenue: "+fmt(d.sfy_page&&d.sfy_page.revenue);rows(document.getElementById("spRows"),d.sfy_page&&d.sfy_page.items);
    document.getElementById("meta").textContent=d.ordersScanned!=null?(d.ordersScanned+" recent orders scanned"):"";
    document.getElementById("foot").textContent="Counts reflect orders since "+(d.since||"")+" whose items were added via a Boko recommendation widget.";
  }).catch(function(){document.getElementById("err").innerHTML="<div class='err'>Couldn't load stats.</div>";});
  bkFunnel(days);
}
document.getElementById("days").addEventListener("change",load); load();
</script></body></html>`;

app.get("/dashboard", (req, res) => {
  const shop = req.query.shop || "";
  const frameShop = validShop(shop) ? shop : "*.myshopify.com";
  res.set("Content-Security-Policy", "frame-ancestors https://" + frameShop + " https://admin.shopify.com");
  const ab = '<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="' + API_KEY + '"></script>';
  res.set("Content-Type", "text/html").status(200).send(DASHBOARD.replace("__APP_BRIDGE__", ab));
});

// ---------- Uninstall webhook (HMAC verified) — removes only this shop's token ----------
app.post("/webhooks/app_uninstalled", (req, res) => {
  const hmac = req.get("X-Shopify-Hmac-Sha256") || "";
  const digest = crypto.createHmac("sha256", API_SECRET).update(req.body).digest("base64");
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac)); } catch (e) {}
  if (!ok) return res.status(401).send("bad hmac");
  const shop = req.get("X-Shopify-Shop-Domain");
  if (validShop(shop)) delToken(shop);
  res.status(200).send("ok");
});

// ---------- Entry / health ----------
app.get("/", async (req, res) => {
  const shop = req.query.shop;
  if (validShop(shop)) {
    const token = await getToken(shop);
    return res.redirect(token ? ("/dashboard?shop=" + shop) : ("/auth?shop=" + shop));
  }
  res.send("Boko AI Recommendations (multi-tenant) is running.");
});

app.listen(PORT, () => console.log("Boko Reco MULTI-TENANT listening on " + PORT));
