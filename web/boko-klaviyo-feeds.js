// BOKO KLAVIYO FEEDS — Step 3: Klaviyo web feeds served from the Step-1 cache.
// Additive and self-contained; safe to remove (delete file + the two wired lines in server.js).
// Routes are public but HMAC-signed via ?sig= — unsigned requests get an empty feed, not data.
import { kvGet, sign, mintToken } from "./boko-klaviyo.js";

function feedSig(shop, kind) {
  return sign("feed:" + shop + ":" + kind);
}

function toFeedItems(host, shop, entry, m) {
  const items = (entry && entry.items) || [];
  const anchorId = (entry && entry.anchor && entry.anchor.id) || "";
  return items.map(function (it, idx) {
    return {
      title: it.title || "",
      price: it.price || 0,
      image: it.image || "",
      handle: it.handle || "",
      url: "https://" + host + "/r/" + mintToken({
        s: shop, h: it.handle || "", m: m, a: anchorId, i: it.id || "",
        n: idx + 1, g: (entry && entry.algo) || "v1", c: "feed", p: "",
      }),
    };
  });
}

export function mountKlaviyoFeeds(app) {
  const SECRET = process.env.BOKO_KLAVIYO_KEY || "bkl7391x";

  // Best-sellers fallback feed.
  app.get("/feeds/:shop/best.json", async (req, res) => {
    try {
      const shop = String(req.params.shop || "");
      if (String(req.query.sig || "") !== feedSig(shop, "best")) {
        return res.status(404).json({ items: [] });
      }
      const entry = await kvGet("bkl_best:" + shop);
      res.set("Cache-Control", "public, max-age=300");
      res.json({
        shop: shop, kind: "best",
        generated_at: (entry && entry.at) || null,
        items: toFeedItems(req.get("host"), shop, entry, "best"),
      });
    } catch (e) {
      res.status(500).json({ items: [], error: e.message });
    }
  });

  // Complete-the-Look feed anchored to one product. Falls back to best sellers so the
  // email block never renders empty when an anchor has no cached pairing.
  app.get("/feeds/:shop/ctl/:anchor", async (req, res) => {
    try {
      const shop = String(req.params.shop || "");
      const anchor = String(req.params.anchor || "").replace(/\.json$/, "");
      if (String(req.query.sig || "") !== feedSig(shop, "ctl:" + anchor)) {
        return res.status(404).json({ items: [] });
      }
      let entry = await kvGet("bkl_ctl:" + shop + ":" + anchor);
      let kind = "ctl";
      if (!entry || !(entry.items || []).length) {
        entry = await kvGet("bkl_best:" + shop);
        kind = "ctl-fallback-best";
      }
      res.set("Cache-Control", "public, max-age=300");
      res.json({
        shop: shop, kind: kind, anchor: (entry && entry.anchor) || { id: anchor },
        generated_at: (entry && entry.at) || null,
        items: toFeedItems(req.get("host"), shop, entry, "ctl"),
      });
    } catch (e) {
      res.status(500).json({ items: [], error: e.message });
    }
  });

  // Secret-keyed helper: returns the exact signed URLs to paste into Klaviyo's web-feed setup.
  app.get("/klaviyo/feedurl", (req, res) => {
    if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
    const shop = String(req.query.shop || "");
    const anchor = String(req.query.anchor || "");
    const base = "https://" + req.get("host") + "/feeds/" + shop;
    const out = { best: base + "/best.json?sig=" + feedSig(shop, "best") };
    if (anchor) out.ctl = base + "/ctl/" + anchor + ".json?sig=" + feedSig(shop, "ctl:" + anchor);
    res.json(out);
  });
}
