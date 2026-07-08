// recommendations.js
// Single-mode recommendation engine: "Recommended" picks, optionally curated by an LLM.
// (Up-sell / down-sell / bestseller helpers remain available but the app uses "recommended".)
//
// LLM refinement (optional): set LLM_API_URL + LLM_API_KEY (+ LLM_PROVIDER, LLM_MODEL).
//   provider "openai"    -> OpenAI-compatible /chat/completions (GPT, Groq, OpenRouter…)
//   provider "anthropic" -> Claude messages API (https://api.anthropic.com/v1/messages)
//   Auto-detected from the URL if LLM_PROVIDER unset. Fails safe to the heuristic order.

const STOP = new Set(["the","a","an","and","or","for","with","of","in","to","by","on","womens","women","mens","men","size","new"]);
function tokenize(s) {
  return String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
}

const HEURISTIC = {
  // General "recommended": popular products, boosted when they share the anchor's category.
  recommended(products, anchor) {
    const aCat = anchor && anchor.category ? String(anchor.category).toLowerCase() : "";
    const aWords = anchor ? tokenize(anchor.title) : [];
    const aTags = anchor && anchor.tags ? anchor.tags.map((t) => String(t).toLowerCase()) : [];
    const aPrice = anchor && anchor.price ? Number(anchor.price) : 0;
    return products
      .filter((p) => !anchor || p.id !== anchor.id)
      .map((p) => {
        let score = 0;
        if (anchor) {
          if (aCat && String(p.category || "").toLowerCase() === aCat) score += 100;
          const pWords = tokenize(p.title);
          score += pWords.filter((w) => aWords.includes(w)).length * 12;
          const pTags = (p.tags || []).map((t) => String(t).toLowerCase());
          score += pTags.filter((t) => aTags.includes(t)).length * 8;
          if (aPrice > 0 && p.price > 0) score += Math.max(0, 6 - (Math.abs(p.price - aPrice) / aPrice) * 6);
        }
        if (p.createdAt) { var ageDays = (Date.now() - new Date(p.createdAt).getTime()) / 86400000; score += 45 * Math.exp(-ageDays / 90); }
        score += Math.min((p.orders || 0) * 0.01, 8) + Math.min((p.views || 0) * 0.005, 4);
        return { p, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p);
  },
  byPurchased(products) {
    return products.slice().sort((a, b) => (b.orders || 0) - (a.orders || 0));
  },
  byViewed(products) {
    return products.slice().sort((a, b) => (b.views || 0) - (a.views || 0));
  },
};

function rankHeuristic(type, products, anchor) {
  if (type === "purchased") return HEURISTIC.byPurchased(products);
  if (type === "viewed") return HEURISTIC.byViewed(products);
  return HEURISTIC.recommended(products, anchor); // default + "recommended"
}

function bundlePricing(items, discountPct = 0) {
  const subtotal = items.reduce((s, p) => s + (p.price || 0), 0);
  const discount = (subtotal * discountPct) / 100;
  return { subtotal, discount, total: subtotal - discount };
}

function buildPrompt(type, candidates, anchor) {
  const sys =
    "You are a fashion merchandising stylist for an e-commerce store. Given an anchor product " +
    "and a candidate list, choose and order the products that best COMPLEMENT the anchor to " +
    "complete an outfit or look. Strongly prefer products from DIFFERENT categories than the anchor " +
    "(e.g. a jacket should be paired with bottoms, footwear, accessories, or base layers — not more jackets). " +
    "Never recommend near-duplicates of the anchor or the same item in another colour. " +
    "Prefer NEW ARRIVAL items; avoid recommending very old products unless highly relevant. " +
    "Respond ONLY with JSON: {\"ids\":[<id>,<id>,...]}.";
  const now = Date.now();
  const user = {
    anchor: anchor
      ? { id: anchor.id, title: anchor.title, price: anchor.price, category: anchor.category, tags: anchor.tags || [] }
      : null,
    candidates: candidates.map((p) => {
      const isNew = p.createdAt && (now - new Date(p.createdAt).getTime()) / 86400000 < 60;
      return { id: p.id, title: (isNew ? "[NEW] " : "") + p.title, price: p.price, category: p.category, tags: p.tags || [], orders: p.orders, views: p.views };
    }),
    guidance:
      "All candidates are in stock. Build a complementary set around the anchor — favour variety across " +
      "categories and collections. Do not just return more items from the anchor's own category. " +
      "Use tags and titles to judge style, colour, and occasion fit.",
  };
  return { sys, userStr: JSON.stringify(user) };
}

function parseIds(txt, candidates) {
  if (!txt) return null;
  const m = String(txt).match(/\{[\s\S]*\}/);
  let parsed;
  try { parsed = JSON.parse(m ? m[0] : txt); } catch (e) { return null; }
  if (!Array.isArray(parsed.ids)) return null;
  const byId = new Map(candidates.map((p) => [p.id, p]));
  const ordered = parsed.ids.map((id) => byId.get(id)).filter(Boolean);
  return ordered.length ? ordered : null;
}

async function refineWithLLM({ candidates, anchor }) {
  const url = process.env.LLM_API_URL;
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  if (!url || !key) return null;
  const provider = (process.env.LLM_PROVIDER || (/anthropic\.com/.test(url) ? "anthropic" : "openai")).toLowerCase();
  const { sys, userStr } = buildPrompt("recommended", candidates, anchor);
  try {
    let txt;
    if (provider === "anthropic") {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 512, system: sys, messages: [{ role: "user", content: userStr }] }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      txt = data.content && data.content[0] && data.content[0].text;
    } else {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model, temperature: 0.2, response_format: { type: "json_object" },
          messages: [{ role: "system", content: sys }, { role: "user", content: userStr }],
        }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      txt = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    }
    return parseIds(txt, candidates);
  } catch (e) {
    console.error("[reco] LLM refine failed:", e.message);
    return null;
  }
}

async function recommend({ products, anchor = null, limit = 8, useLLM = true }) {
  const NINETY = 90 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const getPub = (p) => p.publishedAt || p.published_at || p.createdAt || p.published_date || null;
  const isRecent = (p) => {
    const pub = getPub(p);
    return !!pub && (now - new Date(pub).getTime()) <= NINETY;
  };
  const recentProducts = products.filter(isRecent);
  const olderProducts = products
    .filter((p) => !isRecent(p))
    .sort((a, b) => {
      const pa = getPub(a), pb = getPub(b);
      return (pb ? new Date(pb).getTime() : 0) - (pa ? new Date(pa).getTime() : 0); // newest first, undated last
    });

  const ranked = rankHeuristic("recommended", recentProducts, anchor);
  const anchorCat = anchor && anchor.category ? String(anchor.category).toLowerCase() : "";
  const bycat = new Map();
  for (const p of ranked) {
    const k = String(p.category || "_").toLowerCase();
    if (!bycat.has(k)) bycat.set(k, []);
    bycat.get(k).push(p);
  }
  const otherCats = [...bycat.keys()].filter((k) => k !== anchorCat);
  const pool = [];
  for (let round = 0; pool.length < 30; round++) {
    let added = 0;
    for (const cat of otherCats) {
      if (pool.length >= 30) break;
      const arr = bycat.get(cat);
      if (arr && round < arr.length) { pool.push(arr[round]); added++; }
    }
    if (added === 0) break;
  }
  if (pool.length < Math.max(limit, 8) && bycat.has(anchorCat)) {
    for (const p of bycat.get(anchorCat)) {
      if (pool.length >= Math.max(limit, 8)) break;
      pool.push(p);
    }
  }
  const candidates = pool.length ? pool : ranked.slice(0, Math.max(limit, 12));
  let ordered = candidates;
  if (useLLM) {
    const refined = await refineWithLLM({ candidates, anchor });
    if (refined && refined.length) ordered = refined;
  }
  ordered = ordered.slice(0, limit);

  if (ordered.length < limit && olderProducts.length) {
    const used = new Set(ordered.map((p) => p.id));
    if (anchor) used.add(anchor.id);
    for (const p of olderProducts) {
      if (ordered.length >= limit) break;
      if (used.has(p.id)) continue;
      ordered.push(p);
      used.add(p.id);
    }
  }

  return ordered;
}

export { recommend, rankHeuristic, bundlePricing, refineWithLLM, parseIds, HEURISTIC };
