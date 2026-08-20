// BOKO KLAVIYO SYNC — Step 4 design-complete build: full profile sync worker +
// "Boko Recommendation Clicked" event client. Additive and self-contained; safe to remove.
// IMPORTANT: code is complete but DORMANT until KLAVIYO_API_KEY is set in Replit Secrets.
// Without the key every route answers with a clear "not configured" message and writes nothing.
import { kvGet, kvSet, mintToken } from "./boko-klaviyo.js";

const SECRET = process.env.BOKO_KLAVIYO_KEY || "bkl7391x";
const HOST = process.env.BOKO_PUBLIC_HOST || "boko-reco-app--admin7695.replit.app";
const REV = "2025-07-15";

function kkey() {
  return process.env.KLAVIYO_API_KEY || "";
}

async function kapi(path, method, body, attempt) {
  const r = await fetch("https://a.klaviyo.com/api" + path, {
    method: method || "GET",
    headers: {
      Authorization: "Klaviyo-API-Key " + kkey(),
      accept: "application/vnd.api+json",
      "content-type": "application/vnd.api+json",
      revision: REV,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429 && (attempt || 0) < 4) {
    const wait = parseInt(r.headers.get("Retry-After"), 10) || 5;
    await new Promise((ok) => setTimeout(ok, wait * 1000));
    return kapi(path, method, body, (attempt || 0) + 1);
  }
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { status: r.status, json };
}

function tokUrl(shop, item, m, anchorId, idx, algo, email) {
  return "https://" + HOST + "/r/" + mintToken({
    s: shop, h: item.handle || "", m: m, a: anchorId || "", i: item.id || "",
    n: idx + 1, g: algo || "v1", c: "profile", p: email || "",
  });
}

// Same property schema as the verified test batch, but with PER-PROFILE tracked links
// (each URL carries the recipient's email, so clicks are identity-attributed).
function buildProps(shop, best, ctl, email) {
  const props = {
    boko_algo: "v1",
    boko_source: "sync-v1",
    boko_updated_at: new Date().toISOString(),
  };
  const bItems = (best && best.items) || [];
  props.boko_sfy = bItems.slice(0, 4).map(function (it, i) {
    return {
      title: it.title, price: it.price, handle: it.handle, image: it.image,
      url: tokUrl(shop, it, "sfy", "", i, best.algo, email),
    };
  });
  props.boko_sfy.forEach(function (it, i) {
    props["boko_sfy_" + (i + 1) + "_title"] = it.title;
    props["boko_sfy_" + (i + 1) + "_price"] = it.price;
    props["boko_sfy_" + (i + 1) + "_image"] = it.image;
    props["boko_sfy_" + (i + 1) + "_url"] = it.url;
  });
  if (ctl && (ctl.items || []).length) {
    const a = ctl.anchor || {};
    props.boko_ctl = {
      anchor_id: a.id || "", anchor_title: a.title || "", anchor_handle: a.handle || "",
      items: ctl.items.slice(0, 4).map(function (it, i) {
        return {
          title: it.title, price: it.price, handle: it.handle, image: it.image,
          url: tokUrl(shop, it, "ctl", a.id, i, ctl.algo, email),
        };
      }),
    };
    props.boko_ctl_anchor_title = a.title || "";
    props.boko_ctl_anchor_id = a.id || "";
  }
  return props;
}

// Fire "Boko Recommendation Clicked" back into Klaviyo (used by the redirect hook).
// Only possible when the click token carries a profile identity (p = email) AND the key is set.
export async function trackClick(p) {
  if (!kkey() || !p || !p.p || String(p.p).indexOf("@") < 0) return;
  await kapi("/events", "POST", {
    data: {
      type: "event",
      attributes: {
        properties: {
          module: p.m || "", anchor: p.a || "", item: p.i || "",
          position: p.n || 0, campaign: p.c || "", algorithm: p.g || "",
        },
        metric: { data: { type: "metric", attributes: { name: "Boko Recommendation Clicked" } } },
        profile: { data: { type: "profile", attributes: { email: p.p } } },
      },
    },
  });
}

export function mountKlaviyoSync(app) {
  // Redirect click hook — boko-klaviyo.js calls this after logging a click.
  globalThis.__bklClickHook = function (p) { trackClick(p).catch(function () {}); };

  // Config check: is the key in place yet?
  app.get("/klaviyo/synccfg", (req, res) => {
    if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
    res.json({ klaviyo_key_set: !!kkey(), host: HOST });
  });

  // Full profile sync. Secret-keyed; GET allowed for the nightly job. Options:
  //   shop (required) · limit=N (default 100, max 2000) · dry=1 (count, write nothing)
  // Targets profiles active in the last 180 days (sorted by last activity, stops at cutoff).
  app.all("/klaviyo/sync", async (req, res) => {
    try {
      if (String(req.query.key || "") !== SECRET) return res.status(401).json({ error: "bad key" });
      if (!kkey()) {
        return res.json({ ok: false, configured: false, error: "KLAVIYO_API_KEY not set. Add it in Replit Secrets (Klaviyo full-access private key) - the sync activates automatically, no code changes needed." });
      }
      const shop = String(req.query.shop || "");
      if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) return res.status(400).json({ error: "bad shop" });
      const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit, 10) || 100));
      const dry = String(req.query.dry || "") === "1";
      const best = await kvGet("bkl_best:" + shop);
      if (!best || !(best.items || []).length) {
        return res.json({ ok: false, error: "recommendation cache empty - run /klaviyo/recompute first" });
      }
      const status = await kvGet("bkl_status:" + shop);
      const ctlKey = String(req.query.anchor || "");
      const ctl = ctlKey ? await kvGet("bkl_ctl:" + shop + ":" + ctlKey) : null;
      const cutoff = new Date(Date.now() - 180 * 86400000).toISOString();
      let scanned = 0, patched = 0, skipped = 0, failed = 0, done = false;
      let path = "/profiles?sort=-last_event_date&page%5Bsize%5D=100";
      while (!done && path && scanned < limit) {
        const page = await kapi(path);
        if (page.status !== 200 || !page.json || !page.json.data) {
          return res.json({ ok: false, error: "klaviyo profiles fetch failed (status " + page.status + ")", scanned, patched });
        }
        for (const prof of page.json.data) {
          if (scanned >= limit) { done = true; break; }
          scanned++;
          const at = prof.attributes || {};
          if (at.last_event_date && at.last_event_date < cutoff) { done = true; break; }
          if (!at.email) { skipped++; continue; }
          if (dry) { patched++; continue; }
          const props = buildProps(shop, best, ctl, at.email);
          const r = await kapi("/profiles/" + prof.id + "/", "PATCH", {
            data: { type: "profile", id: prof.id, attributes: { properties: props } },
          });
          if (r.status >= 200 && r.status < 300) patched++; else failed++;
        }
        const next = page.json.links && page.json.links.next;
        path = next ? String(next).replace("https://a.klaviyo.com/api", "") : null;
      }
      const summary = {
        shop, scanned, patched, skipped, failed, dry,
        cache_at: (status && status.at) || null,
        at: new Date().toISOString(),
      };
      await kvSet("bkl_sync:" + shop, summary);
      res.json(Object.assign({ ok: true, configured: true }, summary));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
