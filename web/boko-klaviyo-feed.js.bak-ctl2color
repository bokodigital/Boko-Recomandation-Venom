// BOKO KLAVIYO CTL-LIVE FEED — send-time "Complete the Look" data feed for FLOW emails.
// Resolves recommendations AT SEND TIME from the product the customer actually bought
// (product_id injected into the URL from the flow's trigger event), so there is NO
// nightly-sync lag and NO pre-known anchor.
//
// Why this exists alongside boko-klaviyo-feeds.js:
//   - boko-klaviyo-feeds.js signs each feed URL PER ANCHOR (sig = HMAC of the product),
//     which a Klaviyo flow cannot reproduce for an arbitrary purchased product, and it has
//     no live fallback. This module uses ONE STABLE PER-SHOP signature (paste once) and
//     accepts product_id as a normal query param, and computes pairings live on a cache miss.
//
// Additive and self-contained; safe to remove (delete this file + the one wired line in
// server.js). Read-only. Same deps as mountKlaviyo: { getToken, loadProducts, recommend,
// complementaryPool }. Reuses bkl_ctl / bkl_best cache, mintToken -> /r/:token tracked links.
//
// Route:  GET /feeds/:shop/ctl-live.json?sig={perShopSig}&product_id={id}&email={email}&limit=4
//   sig        : stable per-shop signature = sign("cfeed:" + shop). Get it from
//                GET /klaviyo/ctlfeedurl?key={BOKO_KLAVIYO_KEY}&shop={shop}. Unsigned = empty feed.
//   product_id : numeric Shopify product id of the purchased item (the anchor). Dynamic per send.
//                Missing/unknown -> best-sellers, so the email block never renders empty.
//   email      : recipient email, only to stamp tracked links for click attribution. Optional.
//   limit      : suggestions to return (default 4, max 8).
// Returns JSON: { ok, source, anchor:{id,title,price,image,handle,url}, items:[{...,url}] }
// In the flow email:  {{ feeds.completelook.anchor.title }},  loop {{ feeds.completelook.items }}.

import { kvGet, sign, mintToken } from "./boko-klaviyo.js";

const HOST = process.env.BOKO_PUBLIC_HOST || "boko-reco-app--admin7695.replit.app";
const SECRET = process.env.BOKO_KLAVIYO_KEY || "bkl7391x";

function numId(v) { return String(v == null ? "" : v).split("/").pop().replace(/\D/g, ""); }
function shopSig(shop) { return sign("cfeed:" + shop); }

function trackedUrl(shop, item, module, anchorId, idx, algo, email) {
  return "https://" + HOST + "/r/" + mintToken({
    s: shop, h: item.handle || "", m: module, a: anchorId || "", i: item.id || "",
    n: (idx || 0) + 1, g: algo || "ctl-v1", c: "flow", p: email || "",
  });
}

function shapeItem(shop, it, module, anchorId, idx, algo, email) {
  return {
    id: it.id || "", title: it.title || "", price: it.price || "",
    image: it.image || "", handle: it.handle || "",
    url: trackedUrl(shop, it, module, anchorId, idx, algo, email),
  };
}

export function mountKlaviyoCtlFeed(app, deps) {
  const getToken = deps && deps.getToken;
  const loadProducts = deps && deps.loadProducts;
  const recommend = deps && deps.recommend;
  const complementaryPool = deps && deps.complementaryPool;

  async function computeLive(shop, productId, limit) {
    if (!getToken || !loadProducts || !recommend || !complementaryPool) return null;
    const token = await getToken(shop);
    if (!token) return null;
    const products = await loadProducts(shop, token, 250); // already filtered to in-stock/active
    if (!products || !products.length) return null;
    const anchor = products.find((p) => numId(p.id) === numId(productId));
    if (!anchor) return null;
    const pool = complementaryPool(products, anchor.category, numId(anchor.id)) || [];
    if (!pool.length) return null;
    const picks = await recommend({ products: pool, anchor: null, limit, useLLM: false });
    if (!picks || !picks.length) return null;
    return {
      anchor: { id: numId(anchor.id), title: anchor.title, price: anchor.price, image: anchor.image, handle: anchor.handle },
      items: picks.slice(0, limit), algo: "ctl-live",
    };
  }

  app.get("/feeds/:shop/ctl-live.json", async (req, res) => {
    res.set("Content-Type", "application/json");
    res.set("Cache-Control", "public, max-age=120");
    try {
      const shop = String(req.params.shop || "").toLowerCase();
      if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
        return res.status(200).send(JSON.stringify({ ok: false, error: "bad shop", anchor: null, items: [] }));
      }
      // Stable per-shop signature (unsigned requests get an empty feed, never data).
      if (String(req.query.sig || "") !== shopSig(shop)) {
        return res.status(200).send(JSON.stringify({ ok: false, error: "bad sig", anchor: null, items: [] }));
      }
      const productId = numId(req.query.product_id || "");
      const email = String(req.query.email || "");
      const limit = Math.max(1, Math.min(8, parseInt(req.query.limit, 10) || 4));

      let source = "", anchor = null, items = [], algo = "ctl-v1-complement";

      if (productId) {
        const ctl = await kvGet("bkl_ctl:" + shop + ":" + productId);
        if (ctl && (ctl.items || []).length) {
          source = "cache"; algo = ctl.algo || algo; anchor = ctl.anchor || null; items = ctl.items.slice(0, limit);
        }
      }
      if (!items.length && productId) {
        const live = await computeLive(shop, productId, limit).catch(() => null);
        if (live && live.items.length) { source = "live"; algo = live.algo; anchor = live.anchor; items = live.items; }
      }
      if (!items.length) {
        const best = await kvGet("bkl_best:" + shop);
        if (best && (best.items || []).length) { source = "best"; algo = best.algo || "best-v1"; items = best.items.slice(0, limit); }
      }

      const anchorId = anchor ? (anchor.id || productId) : productId;
      const out = {
        ok: true, source: source || "empty",
        anchor: anchor ? {
          id: anchor.id || productId, title: anchor.title || "", price: anchor.price || "",
          image: anchor.image || "", handle: anchor.handle || "",
          url: trackedUrl(shop, anchor, "ctl-anchor", anchorId, 0, algo, email),
        } : null,
        items: items.map((it, i) => shapeItem(shop, it, "ctl", anchorId, i, algo, email)),
      };
      return res.status(200).send(JSON.stringify(out));
    } catch (e) {
      return res.status(200).send(JSON.stringify({ ok: false, error: e.message, anchor: null, items: [] }));
    }
  });

  // Secret-keyed helper: prints the exact stable feed URL to paste into Klaviyo (with a
  // {{product_id}} placeholder you replace with the event tag). GET ok for convenience.
  app.get("/klaviyo/ctlfeedurl", (req, res) => {
    if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
    const shop = String(req.query.shop || "");
    if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) return res.status(400).json({ error: "bad shop" });
    const base = "https://" + (req.get("host") || HOST) + "/feeds/" + shop + "/ctl-live.json";
    const sig = shopSig(shop);
    res.json({
      shop,
      sig,
      url_template: base + "?sig=" + sig + "&product_id={{ PRODUCT_ID }}&email={{ person.email }}",
      note: "Replace {{ PRODUCT_ID }} with the flow trigger event's purchased product id, e.g. {{ event.extra.line_items.0.product.id }} (confirm the exact path from a real Placed Order event).",
    });
  });
}
