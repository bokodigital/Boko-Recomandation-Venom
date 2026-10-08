// boko-ctl2.js - "Complete the Look" v2 engine + colour coordination (Boko AI Recommendations)
//
// Self-contained module. Registers ONE new storefront route:
//   GET /proxy/ctl   (storefront: /apps/reco/ctl via the Shopify App Proxy, signed)
// It does NOT change /proxy/recommend, the PDP rail, the cart drawer, Klaviyo or /stats.
// Safe to remove: delete the import + mountCtl2(...) line in server.js.
//
// Spec: project doc "boko-complete-the-look-logic-v2-with-color.md" (approved).
//   - slot templates per collection, sec.2 non-negotiables (stock, curvy 12+, lounge/sleep
//     containment, formal elevation, denim-jacket casual-only, never self)
//   - colour layer: family / temperature / brightness, pairing ladder, clash guard,
//     1 accent when the anchor is bold, 3-colour rule, one metal, one print per look,
//     missing colour = neutral-eligible (flagged)
//   - ranking: new arrival -> best seller -> colour harmony -> closest price -> newest
//   - one pick per slot first, then backfill from the outfit's own categories only
//
// Catalogue: loaded with a Shopify Bulk Operation (no per-query cost limits), cached
// in memory + @replit/database, refreshed every 30 min (stale-while-revalidate).
// While the very first catalogue is building, the route falls back to the v1 logic
// so the section is never blank.

/* ===== ENGINE START (pure, no I/O - also runnable in a browser for QA) ===== */

// ---------- colour map ----------
const FAMILIES = ["red", "orange", "yellow", "green", "blue", "purple", "pink"]; // colour wheel order (cyclic)
const COMPLEMENT = { blue: "orange", orange: "blue", red: "green", green: "red", pink: "green", yellow: "purple", purple: "yellow" };

// keyword -> [family, temperature, brightness]   temperature: w | c | b (bridge)   brightness: p | m | B
// Order matters: more specific phrases first.
const COLOR_WORDS = [
  // metallics
  ["rose gold", "metallic", "w", "m", "rose-gold"], ["gold", "metallic", "w", "m", "gold"], ["silver", "metallic", "c", "m", "silver"],
  ["bronze", "metallic", "w", "m", "gold"], ["champagne", "metallic", "w", "p", "gold"], ["pearl", "neutral", "b", "p"],
  ["crystal", "metallic", "c", "m", "silver"], ["graphite", "neutral", "c", "m"],
  // neutrals - blacks / whites
  ["black", "neutral", "b", "m"], ["nero", "neutral", "b", "m"], ["white", "neutral", "b", "p"], ["ivory", "neutral", "b", "p"],
  ["off white", "neutral", "b", "p"], ["milk", "neutral", "b", "p"], ["cream", "neutral", "w", "p"], ["oat", "neutral", "w", "p"], ["oatmeal", "neutral", "w", "p"], ["tobacco", "neutral", "w", "m"], ["rosewood", "pink", "w", "m"],
  ["natural", "neutral", "w", "p"], ["ecru", "neutral", "w", "p"], ["vanilla", "neutral", "w", "p"],
  // neutrals - browns / beiges
  ["dark chocolate", "neutral", "w", "m"], ["chocolate", "neutral", "w", "m"], ["choc", "neutral", "w", "m"], ["brown", "neutral", "w", "m"],
  ["mocha", "neutral", "w", "m"], ["latte", "neutral", "w", "p"], ["coffee", "neutral", "w", "m"], ["espresso", "neutral", "w", "m"],
  ["tan", "neutral", "w", "m"], ["camel", "neutral", "w", "m"], ["beige", "neutral", "w", "p"], ["nude", "neutral", "w", "p"],
  ["sand", "neutral", "w", "p"], ["stone", "neutral", "w", "p"], ["taupe", "neutral", "w", "p"], ["mushroom", "neutral", "w", "p"],
  ["almond", "neutral", "w", "p"], ["desert", "neutral", "w", "p"], ["khaki", "neutral", "w", "m"], ["coconut", "neutral", "w", "p"],
  ["biscuit", "neutral", "w", "p"], ["tort", "neutral", "w", "m"], ["walnut", "neutral", "w", "m"], ["cognac", "neutral", "w", "m"],
  // neutrals - greys / navy / denim
  ["charcoal", "neutral", "c", "m"], ["grey", "neutral", "c", "m"], ["gray", "neutral", "c", "m"], ["marle", "neutral", "c", "m"],
  ["smoke", "neutral", "c", "m"], ["navy", "neutral", "c", "m"], ["denim", "neutral", "c", "m"], ["indigo", "neutral", "c", "m"],
  ["wash", "neutral", "c", "m"],
  // reds / burgundy
  ["burgundy", "red", "w", "m"], ["wine", "red", "w", "m"], ["red wine", "red", "w", "m"], ["maroon", "red", "w", "m"],
  ["cherry", "red", "w", "B"], ["ruby", "red", "w", "B"], ["brick", "red", "w", "m"], ["red", "red", "w", "B"], ["berry", "red", "c", "m"],
  ["pomodoro", "red", "w", "B"],
  // oranges
  ["terracotta", "orange", "w", "m"], ["rust", "orange", "w", "m"], ["ginger", "orange", "w", "m"], ["copper", "orange", "w", "m"],
  ["tangarine", "orange", "w", "B"], ["tangerine", "orange", "w", "B"], ["clementine", "orange", "w", "B"], ["orange", "orange", "w", "B"],
  ["coral", "orange", "w", "B"], ["apricot", "orange", "w", "p"], ["peach", "orange", "w", "p"], ["melon", "orange", "w", "p"],
  // yellows
  ["mustard", "yellow", "w", "m"], ["lemon", "yellow", "w", "p"], ["butter", "yellow", "w", "p"], ["yellow", "yellow", "w", "B"],
  // greens
  ["olive", "green", "w", "m"], ["moss", "green", "w", "m"], ["sage", "green", "c", "p"], ["pistachio", "green", "w", "p"],
  ["mint", "green", "c", "p"], ["lime", "green", "w", "B"], ["emerald", "green", "c", "B"], ["forest", "green", "c", "m"],
  ["jade", "green", "c", "m"], ["teal", "blue", "c", "m"], ["petrol", "blue", "c", "m"], ["green", "green", "c", "m"],
  ["aqua", "blue", "c", "m"], ["acqua", "blue", "c", "m"], ["turquoise", "blue", "c", "B"], ["torquo", "blue", "c", "B"],
  // blues
  ["cobalt", "blue", "c", "B"], ["royal", "blue", "c", "B"], ["electric", "blue", "c", "B"], ["bright blue", "blue", "c", "B"],
  ["peacock", "blue", "c", "B"], ["ocean", "blue", "c", "m"], ["sky", "blue", "c", "p"], ["baby blue", "blue", "c", "p"],
  ["cornflower", "blue", "c", "m"], ["dusty blue", "blue", "c", "p"], ["powder", "blue", "c", "p"], ["blue", "blue", "c", "m"],
  // purples
  ["lilac", "purple", "c", "p"], ["lavender", "purple", "c", "p"], ["violet", "purple", "c", "B"], ["plum", "purple", "c", "m"],
  ["purple", "purple", "c", "m"], ["mauve", "purple", "c", "p"], ["magenta", "pink", "c", "B"],
  // pinks
  ["hot pink", "pink", "c", "B"], ["fuscia", "pink", "c", "B"], ["fuchsia", "pink", "c", "B"], ["baby pink", "pink", "c", "p"],
  ["pale pink", "pink", "c", "p"], ["blush", "pink", "w", "p"], ["rose", "pink", "w", "m"], ["pink", "pink", "c", "m"],
  ["dusty pink", "pink", "w", "p"],
];
// sort longest phrase first so "rose gold" beats "rose", "red wine" beats "red"
COLOR_WORDS.sort((a, b) => b[0].length - a[0].length);
const PRINT_RE = /\b(print|floral|flower|stripe|striped|stripes|dots?|spot|check|checkered|plaid|tartan|gingham|paisley|geometric|tweed|marble|daisy|heart|fruit|books|birds?|dragonfly|tulip|multi|multicolou?r|mix|patchwork|tie.?dye|camo|abstract)\b/;
const ANIMAL_RE = /\b(leo|leopard|animal|zebra|snake|python|croc|cheetah|tiger|cow)\b/;

const TITLE_PRINT_RE = /\b(print|printed|floral|stripe|striped|stripes|polka|dot|dots|check|checked|checkered|plaid|tartan|gingham|paisley|leopard|leo|animal|zebra|snake|tie dye|camo|houndstooth|geometric)\b/;
const _colorCache = new Map();
// No Colour option (~1/3 of Venom's catalogue) -> read a colour word from the title, e.g. "Black Linen Pant".
// Only an explicit colour / print word counts; otherwise colour stays missing (neutral-eligible, QA flag).
function colorFromTitle(title) {
  const s = " " + String(title || "").toLowerCase().replace(/[^a-z ]+/g, " ") + " ";
  const animal = s.match(ANIMAL_RE); if (animal) return animal[1];
  let best = null, pos = Infinity;
  for (const w of COLOR_WORDS) { const i = s.indexOf(" " + w[0] + " "); if (i >= 0 && i < pos) { best = w[0]; pos = i; } }
  if (best) return best;
  const pr = s.match(PRINT_RE); return pr && !/^(multi|mix|heart|books|birds?|fruit)$/.test(pr[1]) ? pr[1] : "";
}
function colorInfo(raw) {
  const s = String(raw || "").toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return { family: null, temp: null, bright: null, metal: null, print: false, animal: false, missing: true, raw: "" };
  if (_colorCache.has(s)) return _colorCache.get(s);
  const animal = ANIMAL_RE.test(s);
  const print = animal || PRINT_RE.test(s) || /\//.test(s) || /\b(b&w|&)\b/.test(s);
  // first colour word in reading order (e.g. "navy floral" -> navy, "red/blue" -> red)
  let best = null, bestPos = Infinity, out_two = false;
  for (const w of COLOR_WORDS) {
    const re = new RegExp("(^|[^a-z])" + w[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z]|$)");
    const m = re.exec(s);
    if (m && m.index < bestPos) { best = w; bestPos = m.index; }
  }
  if (best && !print) {
    for (const w of COLOR_WORDS) {
      if (w[1] === "metallic" || w[1] === best[1] || best[0].includes(w[0]) || w[0].includes(best[0])) continue;
      if (new RegExp("(^|[^a-z])" + w[0] + "([^a-z]|$)").test(s) && !(w[1] === "neutral" && best[1] === "neutral")) { out_two = true; break; }
    }
  }
  let out;
  if (animal) out = { family: "neutral", temp: "w", bright: "m", metal: null, print: true, animal: true };
  else if (best) out = { family: best[1], temp: best[2], bright: best[3], metal: best[4] || null, print, animal: false };
  else if (print) out = { family: "multi", temp: "b", bright: "m", metal: null, print: true, animal: false };
  else out = { family: null, temp: null, bright: null, metal: null, print: false, animal: false, missing: true };
  // a "multi"/"/" value with a leading colour is a print in that colour (base family)
  if (best && /\b(multi|multicolou?r)\b/.test(s) && !/^(black|white|navy|cream)/.test(s)) out.print = true;
  if (out_two) out.print = true;
  out.raw = s; out.missing = !!out.missing;
  if (/\b(bright|neon|hot|electric|vivid)\b/.test(s)) out.bright = "B";
  if (/\b(pale|pastel|baby|dusty|soft|light)\b/.test(s) && out.bright === "B") out.bright = "m";
  _colorCache.set(s, out);
  return out;
}
const isNeutralish = ci => !ci || ci.missing || ci.family === "neutral" || ci.family === "metallic";

// pairing ladder: candidate colour vs anchor colour -> rule + score
function colorRule(a, c) {
  if (!c || c.missing) return { rule: "neutral", score: 3, missing: true };
  if (a && a.print && c.print) return { rule: "clash", score: 0, why: "print_on_print" };
  if (!a || a.missing) return { rule: isNeutralish(c) ? "neutral" : "weak", score: isNeutralish(c) ? 3 : 2 };
  if (c.family === "metallic") return { rule: "neutral", score: 3 };
  if (isNeutralish(c) || isNeutralish(a)) return { rule: "neutral", score: 3 };
  if (a.family === "multi") return { rule: "weak", score: 1 }; // colourful solid vs unknown print palette
  if (c.family === "multi") return { rule: "weak", score: 1 };
  if (c.family === a.family) return { rule: "tonal", score: 3 };
  const ia = FAMILIES.indexOf(a.family), ic = FAMILIES.indexOf(c.family);
  const d = Math.min((ia - ic + 7) % 7, (ic - ia + 7) % 7);
  if (d === 1) return { rule: "analogous", score: 2 };
  if (COMPLEMENT[a.family] === c.family) return { rule: "complementary_accent", score: 2 };
  if (a.bright === "B" && c.bright === "B" && a.temp !== c.temp && a.temp !== "b" && c.temp !== "b")
    return { rule: "clash", score: 0, why: "bold_opposite_temp" };
  return { rule: "weak", score: 1 };
}

// ---------- slot templates ----------
const T = {
  dressCasual: [
    { name: "jacket", targets: ["coats-and-jackets", "womens-denim-jackets"] },
    { name: "jewelry", targets: ["jewelry"] },
    { name: "bag", targets: ["bags"] },
    { name: "accessory", targets: ["headwear", "scarves", "hair-accessories"] },
  ],
  dressMaxi: [
    { name: "jacket", targets: ["coats-and-jackets"] },
    { name: "jewelry", targets: ["jewelry"] },
    { name: "bag", targets: ["bags"] },
    { name: "belt", targets: ["belts"] },
  ],
  dressFormal: [
    { name: "shoes", targets: ["shoes"] },
    { name: "jewelry", targets: ["jewelry"] },
    { name: "bag", targets: ["bags"] },
    { name: "jacket", targets: ["coats-and-jackets"] },
  ],
  topStd: [
    { name: "bottom", targets: ["skirts", "denim", "pants"] },
    { name: "accessory", targets: ["jewelry", "bags"] },
    { name: "jacket", targets: ["coats-and-jackets", "womens-denim-jackets"] },
    { name: "layer", targets: ["knits", "cardigans", "curvy-knits"] },
  ],
  knitStd: [
    { name: "bottom", targets: ["skirts", "denim", "pants"] },
    { name: "accessory", targets: ["jewelry", "scarves"] },
    { name: "jacket", targets: ["coats-and-jackets"] },
    { name: "bag", targets: ["bags"] },
  ],
  bottomStd: [
    { name: "top", targets: ["shirts", "t-shirts", "tops", "knits"] },
    { name: "accessory", targets: ["belts", "jewelry"] },
    { name: "jacket", targets: ["coats-and-jackets", "womens-denim-jackets"] },
    { name: "bag", targets: ["bags"] },
  ],
  skirtStd: [
    { name: "top", targets: ["shirts", "tops", "knits"] },
    { name: "jewelry", targets: ["jewelry"] },
    { name: "jacket", targets: ["coats-and-jackets"] },
    { name: "extra", targets: ["bags", "belts"] },
  ],
  jumpsuit: [
    { name: "jacket", targets: ["coats-and-jackets", "womens-denim-jackets"] },
    { name: "accessory", targets: ["jewelry", "belts"] },
    { name: "extra", targets: ["bags", "shoes"] },
  ],
  coats: [
    { name: "top", targets: ["shirts", "t-shirts", "tops", "knits"] },
    { name: "bottom", targets: ["denim", "pants", "skirts"] },
    { name: "accessory", targets: ["jewelry", "bags"] },
  ],
  denimJacket: [
    { name: "top", targets: ["t-shirts", "shirts", "tops", "knits"] },
    { name: "bottom", targets: ["denim", "shorts", "skirts"] },
    { name: "accessory", targets: ["jewelry", "bags"] },
  ],
  loungeTop: [{ name: "bottom", targets: ["lounge-pants", "lounge-joggers"] }, { name: "accessory", targets: ["headwear"] }],
  loungeBottom: [{ name: "top", targets: ["lounge-tops", "lounge-tees", "lounge-knits"] }],
  loungeKnit: [{ name: "bottom", targets: ["lounge-pants", "lounge-joggers"] }],
  sleep: [{ name: "sleep", targets: ["intimates", "sleepwear"] }],
  accessoryAnchor: [
    { name: "dress", targets: ["casual-dresses", "mini-dresses", "midi-dresses", "smock-dresses"] },
    { name: "top", targets: ["knits", "shirts", "tops"] },
    { name: "bottom", targets: ["denim", "pants", "skirts"] },
  ],
};
const SOURCE_MAP = {
  "formal-dresses": "dressFormal", "special-occassion-dresses": "dressFormal",
  "curvy-dresses": "dressCasual", "maxi-dresses": "dressMaxi",
  "mini-dresses": "dressCasual", "midi-dresses": "dressCasual", "casual-dresses": "dressCasual", "smock-dresses": "dressCasual",
  "dresses": "dressCasual",
  "shirts": "topStd", "t-shirts": "topStd", "curvy-tops": "topStd", "tops": "topStd",
  "knits": "knitStd", "curvy-knits": "knitStd", "cardigans": "knitStd",
  "denim": "bottomStd", "pants": "bottomStd", "shorts": "bottomStd", "bottoms": "bottomStd",
  "skirts": "skirtStd", "jumpsuits": "jumpsuit",
  "coats-and-jackets": "coats", "womens-denim-jackets": "denimJacket",
  "lounge-tops": "loungeTop", "lounge-tees": "loungeTop", "lounge-pants": "loungeBottom", "lounge-joggers": "loungeBottom",
  "lounge-knits": "loungeKnit", "sleepwear": "sleep", "intimates": "sleep",
  "jewelry": "accessoryAnchor", "bags": "accessoryAnchor", "belts": "accessoryAnchor", "scarves": "accessoryAnchor",
  "headwear": "accessoryAnchor", "hair-accessories": "accessoryAnchor", "sunglasses": "accessoryAnchor", "shoes": "accessoryAnchor",
};
const SOURCE_PRIORITY = [
  "formal-dresses", "special-occassion-dresses", "curvy-dresses", "maxi-dresses", "mini-dresses", "midi-dresses",
  "casual-dresses", "smock-dresses", "jumpsuits",
  "curvy-tops", "curvy-knits", "shirts", "t-shirts", "knits", "cardigans", "tops",
  "skirts", "denim", "pants", "shorts",
  "coats-and-jackets", "womens-denim-jackets", "dresses", "bottoms",
  "lounge-tops", "lounge-tees", "lounge-pants", "lounge-joggers", "lounge-knits", "sleepwear", "intimates",
  "jewelry", "bags", "belts", "scarves", "headwear", "hair-accessories", "sunglasses", "shoes",
];
const BROAD_FALLBACK = [
  [/dress/, "dressCasual"], [/skirt/, "skirtStd"], [/jean|denim|pant|trouser|short/, "bottomStd"],
  [/knit|jumper|cardigan|sweater/, "knitStd"], [/shirt|tee|t-shirt|top|blouse/, "topStd"], [/jumpsuit|playsuit/, "jumpsuit"],
  [/coat|jacket|blazer/, "coats"], [/lounge/, "loungeTop"], [/sleep|pyjama|pajama/, "sleep"],
  [/jewel|necklace|earring|bracelet|bangle|ring|bag|belt|scarf|hat|beanie|sunglass|shoe|accessor/, "accessoryAnchor"],
];
const LOUNGE_TPL = new Set(["loungeTop", "loungeBottom", "loungeKnit", "sleep"]);
const LOUNGE_COLS = h => /^lounge-/.test(h) || h === "sleepwear" || h === "intimates";
const MAIN_APPAREL = new Set(["tops", "shirts", "t-shirts", "knits", "cardigans", "curvy-tops", "curvy-knits", "pants", "denim",
  "skirts", "shorts", "dresses", "casual-dresses", "mini-dresses", "midi-dresses", "maxi-dresses", "smock-dresses", "curvy-dresses",
  "coats-and-jackets", "jumpsuits"]);
const FORMAL_SOURCES = new Set(["formal-dresses", "special-occassion-dresses"]);
const ELEVATED_POOL = new Set(["shoes", "jewelry", "bags", "coats-and-jackets"]);
const NEW_DAYS = 30;

// ---------- product accessors (catalogue shape, see compactProduct below) ----------
const cols = p => p.cols || [];
const inAny = (p, hs) => { const c = cols(p); for (const h of hs) if (c.includes(h)) return true; return false; };
const isNewArrival = (p, now) => cols(p).includes("new-arrivals") || (p.createdAt && now - Date.parse(p.createdAt) <= NEW_DAYS * 864e5);
const isBestSeller = p => cols(p).includes("best-seller") || (p.tagsLc || []).includes("best-seller");
const isLoungeOnly = p => cols(p).some(LOUNGE_COLS) && !cols(p).some(h => MAIN_APPAREL.has(h));
function metalOf(p) {
  const t = (p.title || "").toLowerCase() + " " + (p.color || "");
  if (/rose\s*gold/.test(t)) return "rose-gold";
  if (/\bgold\b/.test(t)) return "gold";
  if (/\bsilver\b|sterling/.test(t)) return "silver";
  return null;
}
function hasSize12Plus(p) {
  const sizes = p.sizes || [];
  if (!sizes.length) return true; // no size data -> can't verify, allow (QA)
  let anySmall = false, anyAmb = false;
  for (const val of sizes) {
    const nums = (String(val).match(/\d+/g) || []).map(Number).filter(n => n <= 40);
    if (nums.length) { if (Math.max(...nums) >= 12) return true; anySmall = true; continue; }
    if (/one\s*-?\s*size|^o\/?s$|free\s*size/i.test(val)) return true;
    if (/\b(l|xl|xxl|xxxl|ml|lxl|[1-4]x)\b/i.test(val)) return true;
    if (/\b(xs|s|sm)\b/i.test(val)) { anySmall = true; continue; }
    anyAmb = true;
  }
  return !(anySmall && !anyAmb);
}

function resolveTemplate(anchor) {
  const c = cols(anchor);
  for (const h of SOURCE_PRIORITY) if (c.includes(h)) return { key: SOURCE_MAP[h], source: h };
  const pt = String(anchor.category || "").toLowerCase() + " " + String(anchor.title || "").toLowerCase();
  for (const [re, key] of BROAD_FALLBACK) if (re.test(pt)) return { key, source: "type:" + pt.trim().slice(0, 30) };
  return { key: "topStd", source: "default" };
}
function expandCurvy(targets, curvy) {
  if (!curvy) return targets;
  const out = targets.slice();
  if (out.includes("knits") && !out.includes("curvy-knits")) out.push("curvy-knits");
  if ((out.includes("shirts") || out.includes("t-shirts") || out.includes("tops")) && !out.includes("curvy-tops")) out.push("curvy-tops");
  return out;
}

function buildContext(anchor, tpl, acolorRaw) {
  const c = cols(anchor), tags = anchor.tagsLc || [];
  let ci = colorInfo(acolorRaw || anchor.color);
  if (anchor.pattern && !ci.print) ci = { ...ci, print: true, missing: false, family: ci.missing ? "multi" : ci.family, temp: ci.temp || "b", bright: ci.bright || "m" };
  return {
    anchorId: String(anchor.id), anchorHandle: anchor.handle, anchorPrice: anchor.price,
    tplKey: tpl.key, source: tpl.source,
    isFormal: c.some(h => FORMAL_SOURCES.has(h)),
    isLounge: LOUNGE_TPL.has(tpl.key),
    curvy: c.some(h => /^curvy-/.test(h)) || tags.includes("curvy") || tags.includes("plus"),
    color: ci,
    anchorBold: !!(ci && !ci.missing && !isNeutralish(ci) && ci.bright === "B"),
  };
}

// sec.2 non-negotiables 1-8 (hard gates; colour never empties a slot so it is NOT here)
function allowed(p, ctx) {
  const c = cols(p);
  if (c.includes("homewares")) return false;
  if (String(p.id) === ctx.anchorId || (p.handle && p.handle === ctx.anchorHandle)) return false;
  if (!p.available) return false;
  if (ctx.isLounge) { if (!c.some(LOUNGE_COLS)) return false; }
  else if (isLoungeOnly(p)) return false;
  if (ctx.isFormal) {
    if (!c.some(h => ELEVATED_POOL.has(h))) return false;
    if (c.includes("womens-denim-jackets") || c.includes("headwear") || c.includes("sunglasses")) return false;
  }
  if (ctx.curvy && !hasSize12Plus(p)) return false;
  return true;
}

// Outfit state: colours placed so far, accents used, metal chosen, print used
function newOutfit(ctx) {
  const fam = new Set();
  if (ctx.color && !isNeutralish(ctx.color) && ctx.color.family !== "multi") fam.add(ctx.color.family);
  return { families: fam, accents: 0, metal: null, prints: ctx.color && ctx.color.print ? 1 : 0 };
}
// Evaluate a candidate in the context of the outfit -> {rule, score, blocked, why}
function evalColor(p, ctx, outfit) {
  let ci = colorInfo(p.color);
  if (p.pattern && !ci.print) ci = { ...ci, print: true, missing: false, family: ci.missing ? "multi" : ci.family, temp: ci.temp || "b", bright: ci.bright || "m" };
  const r = colorRule(ctx.color, ci);
  let blocked = r.rule === "clash", why = r.why || null;
  const isAccent = r.rule === "analogous" || r.rule === "complementary_accent" || r.rule === "weak";
  if (!blocked && isAccent && ci && !isNeutralish(ci)) {
    if (ctx.anchorBold && outfit.accents >= 1) { blocked = true; why = "accent_cap"; }
    const fams = new Set(outfit.families); if (ci.family !== "multi") fams.add(ci.family);
    if (fams.size > 3) { blocked = true; why = "three_colour_rule"; }
  }
  if (!blocked && ci && ci.print && outfit.prints >= 1) { blocked = true; why = "one_print_per_look"; }
  const m = metalOf(p);
  if (!blocked && m && outfit.metal && m !== outfit.metal) { blocked = true; why = "mixed_metals"; }
  // metal preference follows anchor warmth (bonus inside the harmony score)
  let score = r.score;
  if (m && ctx.color && !ctx.color.missing) {
    if ((m === "gold" || m === "rose-gold") && ctx.color.temp === "w") score += 0.5;
    if (m === "silver" && ctx.color.temp === "c") score += 0.5;
  }
  return { ci, rule: r.rule, score, blocked, why, isAccent: isAccent && !isNeutralish(ci), metal: m, missing: !!(ci && ci.missing) };
}
function placeInOutfit(outfit, ev) {
  if (ev.isAccent) outfit.accents++;
  if (ev.ci && !isNeutralish(ev.ci) && ev.ci.family !== "multi") outfit.families.add(ev.ci.family);
  if (ev.ci && ev.ci.print) outfit.prints++;
  if (ev.metal && !outfit.metal) outfit.metal = ev.metal;
}

function rankPool(pool, ctx, outfit, now) {
  return pool.map(p => {
    const ev = evalColor(p, ctx, outfit);
    return {
      p, ev,
      n: isNewArrival(p, now) ? 1 : 0,
      b: isBestSeller(p) ? 1 : 0,
      d: ctx.anchorPrice != null && p.price != null ? Math.abs(p.price - ctx.anchorPrice) : Infinity,
      t: p.createdAt ? Date.parse(p.createdAt) : 0,
    };
  }).sort((a, b) =>
    (a.ev.blocked - b.ev.blocked) || b.n - a.n || b.b - a.b || b.ev.score - a.ev.score || a.d - b.d || b.t - a.t);
}
function reasonFor(x) {
  if (x.n) return "new_arrival";
  if (x.b) return "best_seller";
  if (x.ev.score >= 3 && !x.ev.missing) return "color_match";
  if (isFinite(x.d)) return "price_band";
  return "category_pair";
}
function formatItem(x, slotName, targets) {
  const p = x.p;
  return {
    id: p.gid || ("gid://shopify/Product/" + p.id), handle: p.handle, variantId: p.variantId, available: true,
    title: p.title, vendor: p.vendor || "", tags: p.tags || [], category: p.category || "", price: p.price, img: p.img || "",
    createdAt: p.createdAt || null,
    slot: slotName, source_collection: (cols(p).find(h => targets.includes(h))) || cols(p)[0] || "",
    reason: reasonFor(x),
    color: p.color || "", color_family: x.ev.ci && !x.ev.ci.missing ? x.ev.ci.family : "unknown",
    color_rule: x.ev.blocked ? "clash" : x.ev.rule, color_note: x.ev.why || (x.ev.missing ? "missing_colour_qa" : undefined),
  };
}

/**
 * Complete the Look v2 + colour.
 * @param {Array} catalog compact products (see compactProduct)
 * @param {Object} anchor compact product being viewed
 * @param {Object} opts { total=12, days=0, acolor="" }
 */
function completeTheLook(catalog, anchor, opts = {}) {
  const total = Number.isFinite(opts.total) ? opts.total : 12;
  const now = opts.now || Date.now();
  const tpl = resolveTemplate(anchor);
  const template = T[tpl.key];
  const ctx = buildContext(anchor, tpl, opts.acolor);
  const outfit = newOutfit(ctx);
  const used = new Set([String(anchor.id)]);
  const daysOk = p => !(opts.days > 0) || !p.createdAt || now - Date.parse(p.createdAt) <= opts.days * 864e5;
  const eligible = catalog.filter(p => allowed(p, ctx));
  const out = [];
  // Pass 1 - one pick per slot (outfit). Colour never empties a slot: blocked items sort last.
  for (const slot of template) {
    const targets = expandCurvy(slot.targets, ctx.curvy);
    let pool = eligible.filter(p => !used.has(String(p.id)) && inAny(p, targets));
    const inWindow = pool.filter(daysOk); if (inWindow.length) pool = inWindow;
    const ranked = rankPool(pool, ctx, outfit, now);
    if (ranked.length) {
      const x = ranked[0];
      used.add(String(x.p.id)); placeInOutfit(outfit, x.ev); out.push(formatItem(x, slot.name, targets));
    }
  }
  // Pass 2 - backfill from the outfit's own complementary categories (non-blocked first).
  if (out.length < total) {
    const all = [...new Set(template.flatMap(s => expandCurvy(s.targets, ctx.curvy)))];
    let pool = eligible.filter(p => !used.has(String(p.id)) && inAny(p, all));
    const inWindow = pool.filter(daysOk); if (inWindow.length >= total - out.length) pool = inWindow;
    // interleave slots so the rail isn't 8 jackets in a row
    const ranked = rankPool(pool, ctx, outfit, now);
    const bySlot = template.map(s => ({ s, targets: expandCurvy(s.targets, ctx.curvy), q: [] }));
    const blocked = [];
    for (const x of ranked) {
      if (x.ev.blocked) { blocked.push(x); continue; }
      const b = bySlot.find(b => inAny(x.p, b.targets)); if (b) b.q.push(x);
    }
    let added = true;
    while (out.length < total && added) {
      added = false;
      for (const b of bySlot) {
        if (out.length >= total) break;
        const x = b.q.shift(); if (!x) continue;
        used.add(String(x.p.id)); out.push(formatItem(x, b.s.name, b.targets)); added = true;
      }
    }
    // clash/over-cap items only to avoid a near-empty rail (spec: colour never empties, but clashes are a last resort)
    for (const x of blocked) { if (out.length >= Math.min(total, 4)) break; out.push(formatItem(x, "more", all)); }
  }
  return {
    items: out.slice(0, total),
    meta: { template: tpl.key, source: tpl.source, curvy: ctx.curvy, formal: ctx.isFormal, lounge: ctx.isLounge,
      anchor_color: ctx.color.raw || "", anchor_family: ctx.color.missing ? "unknown" : ctx.color.family,
      anchor_bold: ctx.anchorBold, eligible: eligible.length, outfit_metal: outfit.metal, accents: outfit.accents },
  };
}

/* ===== ENGINE END ===== */

// ---------- catalogue (Shopify Bulk Operation) ----------
const COLOR_OPT = /^(colou?r)$/i;
const SIZE_OPT = /size/i;
const numId = gid => { const m = String(gid || "").match(/(\d+)$/); return m ? m[1] : String(gid || ""); };

function compactProduct(n, colls, variants) {
  const tags = (n.tags || []).map(String);
  const tagsLc = tags.map(t => t.toLowerCase());
  const pt = (n.productType || "").toLowerCase();
  if (n.isGiftCard || /gift\s*cards?/.test(pt) || tagsLc.some(t => /gift\s*cards?/.test(t)) || colls.some(h => /gift-?cards?/.test(h))) return null;
  if (!n.publishedAt) return null; // not on the online store
  const av = variants.filter(v => v.availableForSale);
  if (!av.length) return null;
  const first = av[0];
  const opt = (v, re) => { const o = (v.selectedOptions || []).find(o => re.test(o.name)); return o ? String(o.value) : ""; };
  const sizes = [...new Set(av.map(v => opt(v, SIZE_OPT)).filter(Boolean))];
  return {
    id: numId(n.id), gid: n.id, handle: n.handle, title: n.title, vendor: n.vendor || "", category: pt, tags, tagsLc,
    cols: colls, createdAt: n.publishedAt || n.createdAt, price: parseFloat(first.price) || 0,
    img: (n.featuredImage && n.featuredImage.url) || "", variantId: numId(first.id), available: true,
    color: opt(first, COLOR_OPT).toLowerCase() || colorFromTitle(n.title), sizes,
    pattern: TITLE_PRINT_RE.test(String(n.title || "").toLowerCase()),
  };
}

const BULK_QUERY = `{ products(query: "status:active") { edges { node {
  id handle title vendor productType tags createdAt publishedAt isGiftCard featuredImage { url }
  collections { edges { node { id handle } } }
  variants { edges { node { id price availableForSale selectedOptions { name value } } } }
} } } }`;

function parseJsonl(text) {
  const prods = new Map(), colls = new Map(), vars = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    const id = String(o.id || "");
    if (!o.__parentId && id.includes("/Product/")) { prods.set(id, o); continue; }
    if (id.includes("/Collection/")) { (colls.get(o.__parentId) || colls.set(o.__parentId, []).get(o.__parentId)).push(String(o.handle || "").toLowerCase()); continue; }
    if (id.includes("/ProductVariant/")) { (vars.get(o.__parentId) || vars.set(o.__parentId, []).get(o.__parentId)).push(o); }
  }
  const out = [];
  for (const [id, n] of prods) { const p = compactProduct(n, colls.get(id) || [], vars.get(id) || []); if (p) out.push(p); }
  return out;
}

const ANCHOR_QUERY = `query($id: ID!) { product(id: $id) {
  id handle title vendor productType tags createdAt publishedAt isGiftCard featuredImage { url }
  collections(first: 30) { nodes { handle } }
  variants(first: 60) { nodes { id price availableForSale selectedOptions { name value } } }
} }`;

export function mountCtl2(app, { verifyProxy, getToken, gql, db, loadProducts, recommend, complementaryPool }) {
  const TTL = 30 * 60 * 1000, OP_MAX = 20 * 60 * 1000;
  const mem = {}; // shop -> { at, products, byId }
  const ops = {}; // shop -> { id, startedAt, lastPoll }
  const kCat = s => "ctl2:cat:" + s, kOp = s => "ctl2:op:" + s;
  const dbGet = async k => { try { const r = await db.get(k); if (r && typeof r === "object" && "ok" in r) return r.ok ? r.value : null; return r || null; } catch (e) { return null; } };
  const dbSet = async (k, v) => { try { await db.set(k, v); } catch (e) {} };
  const index = c => { c.byId = new Map(c.products.map(p => [p.id, p])); return c; };

  async function startOp(shop, token) {
    const j = await gql(shop, token, `mutation($q: String!) { bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { field message } } }`, { q: BULK_QUERY });
    const r = j && j.data && j.data.bulkOperationRunQuery;
    if (r && r.bulkOperation) { ops[shop] = { id: r.bulkOperation.id, startedAt: Date.now(), lastPoll: 0 }; await dbSet(kOp(shop), ops[shop]); return ops[shop]; }
    ops[shop] = { id: null, startedAt: Date.now(), lastPoll: Date.now(), error: JSON.stringify((r && r.userErrors) || (j && j.errors) || "unknown").slice(0, 300) };
    return null;
  }
  async function pollOp(shop, token) {
    const op = ops[shop];
    if (!op || !op.id) return null;
    if (Date.now() - op.lastPoll < 2500) return null;
    op.lastPoll = Date.now();
    const j = await gql(shop, token, `query($id: ID!) { node(id: $id) { ... on BulkOperation { id status errorCode objectCount url } } }`, { id: op.id });
    const n = j && j.data && j.data.node;
    if (!n) return null;
    op.status = n.status; op.objectCount = n.objectCount;
    if (n.status === "COMPLETED") {
      let products = [];
      if (n.url) { const txt = await fetch(n.url).then(r => r.text()); products = parseJsonl(txt); }
      const cat = index({ at: Date.now(), products });
      mem[shop] = cat; delete ops[shop];
      await dbSet(kOp(shop), null);
      await dbSet(kCat(shop), { at: cat.at, products });
      return cat;
    }
    if (["FAILED", "CANCELED", "EXPIRED"].includes(n.status) || Date.now() - op.startedAt > OP_MAX) { delete ops[shop]; await dbSet(kOp(shop), null); }
    return null;
  }
  async function refresh(shop, token) {
    if (!ops[shop]) { const saved = await dbGet(kOp(shop)); if (saved && saved.id && Date.now() - saved.startedAt < OP_MAX) ops[shop] = { ...saved, lastPoll: 0 }; }
    const op = ops[shop];
    if (op && !op.id && Date.now() - op.startedAt < 60000) return null; // recent start error -> back off 1 min
    if (!op || !op.id) { await startOp(shop, token); return null; }
    return pollOp(shop, token);
  }
  // Returns the freshest catalogue available now (may be stale); triggers refresh in the background.
  async function getCatalog(shop, token, waitMs) {
    if (!mem[shop]) { const saved = await dbGet(kCat(shop)); if (saved && saved.products) mem[shop] = index(saved); }
    const cat = mem[shop];
    if (cat && Date.now() - cat.at < TTL) return cat;
    const deadline = Date.now() + (cat ? 0 : waitMs);
    try {
      let fresh = await refresh(shop, token);
      while (!fresh && Date.now() < deadline) { await new Promise(r => setTimeout(r, 1500)); fresh = await refresh(shop, token); }
      if (fresh) return fresh;
    } catch (e) {}
    return cat || null;
  }
  async function fetchAnchor(shop, token, anum) {
    try {
      const j = await gql(shop, token, ANCHOR_QUERY, { id: "gid://shopify/Product/" + anum });
      const n = j && j.data && j.data.product;
      if (!n) return null;
      const p = compactProduct({ ...n, publishedAt: n.publishedAt || n.createdAt }, (n.collections.nodes || []).map(c => String(c.handle).toLowerCase()), n.variants.nodes || []);
      if (p) return p;
      // anchor may be sold out - still usable as an anchor
      const v = (n.variants.nodes || [])[0] || {};
      const col = ((v.selectedOptions || []).find(o => COLOR_OPT.test(o.name)) || {}).value || "";
      return { id: anum, handle: n.handle, title: n.title, category: (n.productType || "").toLowerCase(), tags: n.tags || [], tagsLc: (n.tags || []).map(t => String(t).toLowerCase()),
        cols: (n.collections.nodes || []).map(c => String(c.handle).toLowerCase()), price: parseFloat(v.price) || 0, color: String(col).toLowerCase(), sizes: [], createdAt: n.createdAt };
    } catch (e) { return null; }
  }

  async function v1Fallback(shop, token, q, limit) {
    const anum = (q.anchor || "").trim(), atype = (q.atype || "").trim();
    let days = parseInt(q.days, 10); if (!Number.isFinite(days)) days = 90;
    let products = await loadProducts(shop, token, 250);
    const found = anum ? products.find(p => String(p.id).endsWith(anum)) : null;
    const anchor = found || (atype || q.atitle ? { id: "anchor:" + anum, title: q.atitle || "", category: atype.toLowerCase(), tags: [], price: parseFloat(q.aprice || "0") || 0 } : null);
    if (anum) products = products.filter(p => !String(p.id).endsWith(anum));
    let items;
    if (anchor && anchor.category) { const cp = complementaryPool(products, anchor.category, anum, days); if (cp.length) items = await recommend({ products: cp, anchor: null, limit, days }); }
    if (!items || !items.length) items = await recommend({ products, anchor, limit, days });
    return items || [];
  }

  app.get("/proxy/ctl", async (req, res) => {
    res.set("Content-Type", "application/json");
    res.set("Cache-Control", "no-store");
    const q = req.query;
    try {
      if (!verifyProxy(q)) return res.status(401).send(JSON.stringify({ items: [], error: "bad signature" }));
      const shop = q.shop;
      const token = await getToken(shop);
      if (!token) return res.status(200).send(JSON.stringify({ items: [], error: "app not installed for shop" }));
      const limit = Math.max(1, Math.min(parseInt(q.limit || "12", 10) || 12, 24));
      const days = Math.max(0, parseInt(q.days, 10) || 0);
      const anum = String(q.anchor || "").replace(/\D/g, "");
      const debug = q.debug === "1";
      if (q.refresh === "1" && debug) { mem[shop] && (mem[shop].at = 0); }
      const cat = await getCatalog(shop, token, 6000);
      let anchor = cat && anum ? cat.byId.get(anum) : null;
      if (cat && anum && !anchor) anchor = await fetchAnchor(shop, token, anum);
      if (cat && anchor) {
        const r = completeTheLook(cat.products, anchor, { total: limit, days, acolor: String(q.acolor || "").toLowerCase() });
        if (r.items.length) {
          const body = { engine: "ctl2", items: r.items };
          if (debug) body.meta = { ...r.meta, catalog_size: cat.products.length, catalog_age_s: Math.round((Date.now() - cat.at) / 1000), op: ops[shop] || null };
          else body.items = r.items.map(({ color_note, ...it }) => it);
          return res.status(200).send(JSON.stringify(body));
        }
      }
      const items = await v1Fallback(shop, token, q, limit);
      const body = { engine: "v1-fallback", items };
      if (debug) body.meta = { reason: !cat ? "catalogue building" : !anchor ? "anchor not found" : "no v2 results", op: ops[shop] || null, catalog_size: cat ? cat.products.length : 0 };
      return res.status(200).send(JSON.stringify(body));
    } catch (e) {
      return res.status(200).send(JSON.stringify({ items: [], error: e.message }));
    }
  });
}

export { completeTheLook, colorInfo, colorRule, resolveTemplate, hasSize12Plus, parseJsonl, compactProduct, T as SLOT_TEMPLATES };
