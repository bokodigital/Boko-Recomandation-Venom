// boko-ctl3.js - "Complete the Look" v3: stylist rules (Boko AI Recommendations)
//
// Pure engine, no I/O. Used by boko-ctl2.js (/proxy/ctl, __ctl2Pick) when engine 3 is on.
// Principle: NO GUESSING. A piece is only shown when we KNOW its colour and it is on the
// stylist-approved pairing list with the product AND with every other piece in the look.
//
//  1. Garment type from title + product type + collections (top, knit, dress, pants, jeans,
//     skirt, shorts, blazer, coat, jacket, denim jacket, bag, jewellery, belt, scarf, shoes ...)
//  2. Outfit recipe per garment type (a top gets bottom + layer + bag + jewellery + shoes;
//     a dress never gets pants; no knit/cardigan over a blouse; no denim on denim ...)
//  3. Colour = selected variant colour -> Shopify colour/pattern field -> colour word in title.
//     Unknown colour = never recommended.
//  4. Approved pairs table (3 perfect, 2 good, 1 ok, 0 never). Piece must score >= 2 with the
//     product and >= 1 with every other piece. One colour + neutrals per look. One print per look.
//     Never the same bright colour twice (no red bag with a red dress). One metal.
//  5. Season (no linen with wool coats) and occasion (no sequins with sweatpants) gates.
//  6. Rank: colour score -> occasion closeness -> best seller -> new -> closest price.
//  Fewer, right pieces beat a full rail of guesses.

/* ---------- colour vocabulary ---------- */
const TONE_WORDS = [
  // metallics
  ["rose gold", "gold"], ["gold", "gold"], ["bronze", "gold"], ["champagne", "beige"], ["silver blue", "sky"], ["silver", "silver"], ["metallic", "silver"],
  // whites / creams
  ["off white", "white"], ["milky white", "white"], ["white", "white"], ["ivory", "white"], ["milk", "white"], ["cream", "white"], ["natural", "white"],
  ["ecru", "white"], ["oatmeal", "beige"], ["oat", "beige"], ["vanilla", "white"], ["coconut", "white"], ["pearl", "white"],
  // beiges
  ["rose beige", "beige"], ["beige", "beige"], ["sand", "beige"], ["stone", "beige"], ["taupe", "beige"], ["nude", "beige"], ["latte", "beige"],
  ["almond", "beige"], ["biscuit", "beige"], ["mushroom", "beige"], ["desert", "beige"],
  // camel / tan
  ["camel", "camel"], ["tan", "camel"], ["cognac", "camel"], ["caramel", "camel"], ["toffee", "camel"], ["tobacco", "camel"], ["ginger", "camel"],
  // browns
  ["dark chocolate", "brown"], ["chocolate", "brown"], ["choc", "brown"], ["brown", "brown"], ["coffee", "brown"], ["espresso", "brown"],
  ["mocha", "brown"], ["walnut", "brown"], ["tort", "brown"],
  // greys
  ["charcoal", "grey"], ["grey", "grey"], ["gray", "grey"], ["marle", "grey"], ["smoke", "grey"], ["graphite", "grey"],
  // black
  ["black", "black"], ["nero", "black"], ["onyx", "black"],
  // navy / denim
  ["navy", "navy"], ["dark indigo", "denim"], ["indigo blue", "navy"], ["indigo", "denim"], ["midnight", "navy"],
  ["dark denim", "denim"], ["light denim", "denim"], ["denim blue", "denim"], ["denim", "denim"], ["light wash", "denim"], ["mid wash", "denim"],
  ["dark wash", "denim"], ["blue wash", "denim"], ["worn wash", "denim"], ["washed khaki", "olive"], ["wash", "denim"], ["chambray", "denim"],
  // olive / khaki
  ["deep olive", "olive"], ["dark olive", "olive"], ["olive", "olive"], ["khaki", "olive"], ["army", "olive"], ["moss", "olive"],
  // reds
  ["cherry black", "wine"], ["red wine", "wine"], ["choc wine", "wine"], ["burgundy", "wine"], ["wine", "wine"], ["maroon", "wine"], ["berry", "wine"],
  ["oxblood", "wine"], ["ruby", "red"], ["cherry", "red"], ["scarlet", "red"], ["pomodoro", "red"], ["brick", "rust"], ["red", "red"],
  // pinks
  ["hot pink", "hotpink"], ["fuchsia", "hotpink"], ["fuscia", "hotpink"], ["magenta", "hotpink"], ["bubblegum", "pink"],
  ["baby pink", "pink"], ["pale pink", "pink"], ["dusty pink", "pink"], ["rose pink", "pink"], ["blush", "pink"], ["rose", "pink"], ["pink", "pink"],
  // oranges
  ["terracotta", "rust"], ["rust", "rust"], ["copper", "rust"], ["burnt orange", "rust"],
  ["tangarine", "orange"], ["tangerine", "orange"], ["clementine", "orange"], ["coral", "orange"], ["orange", "orange"],
  ["apricot", "peach"], ["peach", "peach"], ["melon", "peach"],
  // yellows
  ["mustard", "mustard"], ["lemon", "yellow"], ["butter", "yellow"], ["yellow", "yellow"],
  // greens
  ["lime green", "lime"], ["lime", "lime"], ["neon green", "lime"], ["aqua green", "sage"], ["sage", "sage"], ["mint", "sage"], ["pistachio", "sage"],
  ["emerald", "green"], ["kelly", "green"], ["forest", "green"], ["bottle green", "green"], ["green", "green"],
  // blues
  ["jade blue", "teal"], ["jade", "teal"], ["teal", "teal"], ["petrol", "teal"], ["turquoise", "teal"], ["aqua blue", "teal"], ["aqua", "teal"],
  ["acqua", "teal"], ["peacock", "teal"],
  ["cobalt blue", "blue"], ["cobalt", "blue"], ["royal blue", "blue"], ["electric blue", "blue"], ["bright blue", "blue"],
  ["baby blue", "sky"], ["sky blue", "sky"], ["sky", "sky"], ["powder blue", "sky"], ["cornflower", "sky"], ["dusty blue", "sky"],
  ["light blue", "sky"], ["pale blue", "sky"], ["blue", "blue"],
  // purples
  ["lilac", "lilac"], ["lavender", "lilac"], ["mauve", "lilac"], ["violet", "purple"], ["plum", "purple"], ["purple", "purple"],
];
TONE_WORDS.sort((a, b) => b[0].length - a[0].length);
const NEUTRALS = new Set(["black", "white", "beige", "camel", "brown", "grey", "navy", "denim", "olive"]);
const METALS = new Set(["gold", "silver"]);
const isColourful = t => !!t && !NEUTRALS.has(t) && !METALS.has(t) && t !== "print";

const PRINT_WORDS = [
  [/\b(leo|leopard|animal|zebra|snake|python|croc|cheetah|tiger|cow)\b/, "animal"],
  [/\b(stripe|striped|stripes|pinstripe|pinstrpe)\b/, "stripe"],
  [/\b(check|checked|checkered|plaid|tartan|gingham|houndstooth|argyle|tweed|herringbone)\b/, "check"],
  [/\b(dot|dots|spot|spots|polka|dotted)\b/, "dots"],
  [/\b(floral|flower|flowers|bouquet|rose print|tulip print|daisy|peony|botanical|palm|palms)\b/, "floral"],
  [/\b(print|printed|pattern|patterned|patchwork|multi|multicolou?r|multicolor|abstract|geometric|graffiti|tie.?dye|camo|paisley|motif|watercolou?r|tribal|border|colour block|block colour|contrast)\b/, "print"],
];

function wordsIn(s) {
  // all tones mentioned, in reading order
  const out = []; const str = " " + s + " ";
  const taken = [];
  for (const [w, t] of TONE_WORDS) {
    const re = new RegExp("(^|[^a-z])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=[^a-z]|$)", "g");
    let m; while ((m = re.exec(str))) {
      const at = m.index + m[1].length, end = at + w.length;
      if (taken.some(([a, b]) => at < b && end > a)) continue;
      taken.push([at, end]); out.push([at, t]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]).map(x => x[1]);
}
function printIn(s) { for (const [re, k] of PRINT_WORDS) if (re.test(s)) return k; return null; }
const norm = s => String(s || "").toLowerCase().replace(/[_\-\/&,()]+/g, " ").replace(/\s+/g, " ").trim();

// colourLabel: chosen variant colour (may be ""), cp: Shopify colour-pattern labels, title
function toneOf(colourLabel, cp, title, kind) {
  const c = norm(colourLabel), tl = norm(title), cps = (cp || []).map(norm);
  let print = printIn(c) || null;
  let tones = wordsIn(c);
  if (!c || (!tones.length && !print)) {
    // no usable variant colour -> colour/pattern field (only if it is a single value, or patterns)
    const cpPrint = cps.map(printIn).find(Boolean);
    const cpTones = cps.flatMap(wordsIn);
    if (cpPrint) { print = cpPrint; tones = cpTones; }
    else if (cps.length === 1) tones = cpTones;
    else if (cps.length > 1) {
      // several colours listed and no variant chosen -> trust the title if it names one
      const tt = wordsIn(tl); tones = tt.length ? tt : [];
    }
    if (!tones.length) { tones = wordsIn(tl); }
  }
  // the title can still reveal a print ("Leopard Pant", "Floral Blouse", "Stripe Tee")
  if (!print) print = printIn(tl);
  if (!print && c && /\//.test(colourLabel)) print = "print"; // "choc/blue"
  let base = tones[0] || null;
  if ((kind === "jeans" || kind === "denimjacket") && (base === "blue" || base === "sky" || base === "navy")) base = "denim";
  if (!base && (kind === "jeans" || kind === "denimjacket") && !print) base = "denim";
  if (!base && kind === "jewellery") { if (/\bsilver|sterling\b/.test(tl)) base = "silver"; else if (/\bgold\b/.test(tl)) base = "gold"; }
  if (print === "stripe" && !base) base = null;
  if (!base && !print) return { tone: null, print: null, known: false };
  // metallic apparel (gold satin blouse) stays metallic
  return { tone: base || "print", print, known: true, second: tones.find(t => t !== base) || null };
}

/* ---------- approved pairs ---------- */
// neutral x neutral (symmetric). 0 = never
const NN = {
  black: { black: 3, white: 3, beige: 3, camel: 3, brown: 1, grey: 2, navy: 0, denim: 3, olive: 2 },
  white: { white: 2, beige: 3, camel: 3, brown: 3, grey: 3, navy: 3, denim: 3, olive: 3 },
  beige: { beige: 2, camel: 3, brown: 3, grey: 1, navy: 3, denim: 3, olive: 3 },
  camel: { camel: 1, brown: 3, grey: 2, navy: 3, denim: 3, olive: 3 },
  brown: { brown: 2, grey: 0, navy: 2, denim: 3, olive: 2 },
  grey: { grey: 2, navy: 3, denim: 3, olive: 0 },
  navy: { navy: 1, denim: 2, olive: 1 },
  denim: { denim: 0, olive: 3 },
  olive: { olive: 0 },
};
// colour (or metallic apparel) x neutral
const CN = {
  red:     { black: 3, white: 3, beige: 3, camel: 3, brown: 1, grey: 2, navy: 2, denim: 3, olive: 0 },
  wine:    { black: 3, white: 2, beige: 3, camel: 3, brown: 2, grey: 3, navy: 2, denim: 3, olive: 1 },
  pink:    { black: 2, white: 3, beige: 3, camel: 2, brown: 2, grey: 3, navy: 3, denim: 3, olive: 0 },
  hotpink: { black: 3, white: 3, beige: 2, camel: 1, brown: 0, grey: 2, navy: 2, denim: 3, olive: 0 },
  orange:  { black: 1, white: 3, beige: 3, camel: 3, brown: 2, grey: 0, navy: 3, denim: 3, olive: 1 },
  rust:    { black: 2, white: 3, beige: 3, camel: 3, brown: 3, grey: 0, navy: 2, denim: 3, olive: 3 },
  peach:   { black: 0, white: 3, beige: 3, camel: 3, brown: 2, grey: 2, navy: 2, denim: 3, olive: 1 },
  yellow:  { black: 1, white: 3, beige: 3, camel: 2, brown: 1, grey: 3, navy: 3, denim: 3, olive: 0 },
  mustard: { black: 2, white: 3, beige: 3, camel: 2, brown: 3, grey: 2, navy: 3, denim: 3, olive: 2 },
  green:   { black: 1, white: 3, beige: 3, camel: 3, brown: 2, grey: 1, navy: 2, denim: 3, olive: 0 },
  lime:    { black: 2, white: 3, beige: 2, camel: 1, brown: 0, grey: 2, navy: 2, denim: 3, olive: 0 },
  sage:    { black: 1, white: 3, beige: 3, camel: 3, brown: 3, grey: 2, navy: 1, denim: 3, olive: 0 },
  blue:    { black: 1, white: 3, beige: 3, camel: 3, brown: 2, grey: 3, navy: 0, denim: 1, olive: 0 },
  sky:     { black: 1, white: 3, beige: 3, camel: 3, brown: 3, grey: 3, navy: 3, denim: 2, olive: 0 },
  teal:    { black: 2, white: 3, beige: 3, camel: 3, brown: 3, grey: 2, navy: 1, denim: 2, olive: 0 },
  purple:  { black: 2, white: 3, beige: 2, camel: 1, brown: 0, grey: 3, navy: 1, denim: 3, olive: 0 },
  lilac:   { black: 1, white: 3, beige: 3, camel: 1, brown: 0, grey: 3, navy: 3, denim: 3, olive: 0 },
  gold:    { black: 3, white: 3, beige: 3, camel: 2, brown: 3, grey: 1, navy: 3, denim: 2, olive: 2 },
  silver:  { black: 3, white: 3, beige: 1, camel: 0, brown: 0, grey: 3, navy: 3, denim: 3, olive: 0 },
  // a print we cannot read the colours of -> only the safest neutrals
  print:   { black: 1, white: 2, beige: 2, camel: 2, brown: 1, grey: 0, navy: 0, denim: 3, olive: 0 },
};
// animal print as a piece (scarf, bag, pant) - classic with these
const ANIMAL = { black: 3, white: 3, beige: 3, camel: 3, brown: 3, denim: 3, grey: 1, navy: 1, olive: 2, red: 2, wine: 2 };
const WARM = new Set(["red", "wine", "orange", "rust", "peach", "yellow", "mustard", "green", "olive", "camel", "brown", "beige", "white", "lime"]);

function nn(a, b) { return (NN[a] && NN[a][b] != null) ? NN[a][b] : (NN[b] && NN[b][a] != null ? NN[b][a] : 0); }
// score of two colour descriptors. 0 = never together
function pairScore(a, b) {
  if (!a || !b || !a.known || !b.known) return 0;
  if (a.print && b.print) return 0; // one print per look
  const ta = a.tone, tb = b.tone;
  // metals (jewellery, gold/silver pieces): go with neutrals and colours, never gold with silver
  if (METALS.has(ta) || METALS.has(tb)) {
    if (METALS.has(ta) && METALS.has(tb)) return ta === tb ? 3 : 0;
    const m = METALS.has(ta) ? ta : tb, o = METALS.has(ta) ? b : a;
    if (o.print) return 2;
    if (NEUTRALS.has(o.tone)) return Math.max(2, CN[m][o.tone] || 0);
    if (o.tone === "print") return 2;
    return (m === "gold") === WARM.has(o.tone) ? 3 : 2;
  }
  // animal print piece
  if (a.print === "animal" || b.print === "animal") {
    const o = a.print === "animal" ? b : a;
    return ANIMAL[o.tone] || 0;
  }
  const aC = !NEUTRALS.has(ta), bC = !NEUTRALS.has(tb);
  if (!aC && !bC) {
    let s = nn(ta, tb);
    // a stripe/check/dot print on a neutral base: both its colours must work (e.g. navy/white stripe)
    if (s && a.print && a.second && NEUTRALS.has(a.second)) s = Math.min(s, Math.max(1, nn(a.second, tb)));
    if (s && b.print && b.second && NEUTRALS.has(b.second)) s = Math.min(s, Math.max(1, nn(b.second, ta)));
    return s;
  }
  if (aC && bC) return 0; // two colours (or the same colour twice) never - one colour per look
  const col = aC ? a : b, neu = aC ? b : a;
  let s = (CN[col.tone] && CN[col.tone][neu.tone]) || 0;
  if (s && col.print && col.second && NEUTRALS.has(col.second) && neu.tone === col.second) s = Math.max(s, 2);
  return s;
}

/* ---------- garment type ---------- */
const has = (s, re) => re.test(s);
function kindOf(p) {
  const t = " " + norm(p.title) + " ", pt = norm(p.category), c = p.cols || [];
  const any = re => has(t, re) || has(pt, re);
  if (c.includes("homewares") || any(/\b(gift card|e gift|homeware|candle|mug)\b/)) return "x";
  if (any(/\b(slipper|slippers|socks?|umbrella|keyring|key ring|jewellery case|jewelry case|face mask|scrunchies?|headband|hair clip|claw clips?|clips?|armbands?|brooch|pin|band)\b/) && !any(/\b(dress|top|pant|skirt)\b/)) return "x";
  if (any(/\b(pyjamas?|pajamas?|sleep|sleepwear|bralette|intimates?|lingerie|robe|lounge set)\b/)) return "x";
  // accessories (product type ACCESSORIES is shared) - but never when the title names a garment ("Ring Detail Tee")
  const garment = has(t, /\b(dress|dresses|top|tee|t shirt|shirt|blouse|pants?|skirt|knit|jumper|cardigan|jacket|coat|blazer|jeans?|shorts|tank|singlet|sweater)\b/);
  const tAny = re => has(t, re);
  if (!garment) {
    if (any(/\b(bag|tote|clutch|handbag|crossbody|purse|hobo|satchel|backpack|bucket bag|camera bag|b ag)\b/) || c.includes("bags")) return "bag";
    if (any(/\b(necklace|earrings?|earring set|bracelet|bangle|cuff|ring|pendant|choker|anklet|stacker)\b/) || c.includes("jewelry")) return "jewellery";
    if (any(/\bbelts?\b|\bbet\b/) || c.includes("belts")) return "belt";
    if (tAny(/\b(scarf|shawl|pashmina|bandana)\b/) || c.includes("scarves")) return "scarf";
    if (any(/\b(sunglasses|sunnies)\b/) || c.includes("sunglasses")) return "sunglasses";
    if (any(/\b(hat|beanie|cap|beret)\b/) || c.includes("headwear")) return "hat";
    if (any(/\b(shoe|shoes|slides?|sandals?|sandle|wedge|heel|heels|boots?|loafer|sneaker|mule|flats)\b/) || c.includes("shoes")) return "shoes";
  }
  if (any(/\bset\b/) || /top and pant/.test(pt) || tAny(/\btop (and )?pants?\b/)) return "set"; // BOKO P7: "TOP / PANT" two-piece
  if (any(/\b(jumpsuit|playsuit|romper|overall)\b/) || c.includes("jumpsuits")) return "jumpsuit";
  if (any(/\b(dress|dresses|sundress|kaftan|caftan|dres)\b/) && !any(/\bdress(y)? (pant|shirt|top)\b/)) return "dress";
  if (any(/\b(blazer)\b/)) return "blazer";
  if (any(/\b(denim jacket|denim shacket|shacket|trucker)\b/) || (any(/\bjacket\b/) && any(/\bdenim\b/)) || c.includes("womens-denim-jackets")) return "denimjacket";
  if (any(/\b(coat|trench|puffer|parka|overcoat|faux fur)\b/)) return "coat";
  if (tAny(/\b(windcheater|anorak|raincoat|spray jacket)\b/)) return "jacket";
  if (any(/\b(jacket|bomber|vest|gilet|cape)\b/) && !any(/\b(vest top|knit|knitted)\b/) && pt !== "knits" || pt === "coats jackets" || c.includes("coats-and-jackets") && !any(/\b(top|shirt|tee|knit|jumper)\b/)) return "jacket";
  if (any(/\b(cardigan|cardi)\b/) || c.includes("cardigans")) return "cardigan";
  if (any(/\b(skirt)\b/)) return "skirt";
  if (any(/\b(shorts)\b/)) return "shorts";
  if (any(/\b(jeans?|jean)\b/) || (pt === "denim" && !any(/\b(shirt|blouse|top|jacket|skirt|dress|short)/))) return "jeans";
  if (any(/\b(pants?|pant|trousers?|culottes?|leggings?|joggers?|capri|palazzo|flares?)\b/) || pt === "pants") return "pants";
  if (tAny(/\b(tee|t shirt|tshirt|tank|singlet|cami|shirt|blouse|top)\b/) && !tAny(/\b(jumper|sweater|knit|knitted|pullover|turtleneck|cardigan|cardi)\b/)) return "top";
  if (any(/\b(jumper|sweater|knit|pullover|turtleneck|poncho|mohair)\b/) || pt === "knits" || c.includes("knits") && !any(/\b(shirt|tee|blouse|top)\b/)) return "knit";
  if (any(/\b(shirt|blouse|top|tee|t shirt|tshirt|tank|singlet|cami|bodysuit|bustier|sweatshirt|polo|crop|tunic)\b/) || /^(top|tops|shirts|t shirt|t shirts|tee|tshirt)$/.test(pt)) return "top";
  return "x";
}
const APPAREL = new Set(["top", "knit", "cardigan", "dress", "jumpsuit", "set", "pants", "jeans", "skirt", "shorts", "blazer", "coat", "jacket", "denimjacket"]);
const BOTTOMS = ["pants", "jeans", "skirt", "shorts"];
const OUTERS = ["blazer", "coat", "jacket", "denimjacket"];

/* ---------- season & occasion ---------- */
function seasonOf(p, kind) {
  const t = norm(p.title);
  if (/\b(wool|teddy|faux fur|fur|puffer|mohair|fluffy|fleece|sherpa|velvet|turtleneck|cable|felt|herringbone|corduroy|cord|quilted|chunky|thick|boucle|cashmere|shearling|thermal)\b/.test(t)) return "winter";
  if (kind === "coat") return /\btrench\b/.test(t) ? "all" : "winter";
  if (kind === "knit" && !/\b(tank|short sleeve|light|fine|viscose|vest|cami|ss2\d|summer|crochet|cotton)\b/.test(t)) return "winter";
  if (kind === "cardigan" && !/\b(lightweight|light|fine|cotton|bamboo)\b/.test(t)) return "winter";
  if (/\b(linen|sundress|tank|singlet|cami|strapless|sleeveless|swim|kaftan|raffia|rafia|straw|slides?|sandals?|sandle|resort|summer|shorts|beach|crochet|broderie|seersucker)\b/.test(t)) return "summer";
  if (kind === "shorts") return "summer";
  return "all";
}
// 2 evening, 1 smart, 0 everyday, -1 casual/sport
function occasionOf(p, kind) {
  const t = norm(p.title), c = p.cols || [];
  if (c.includes("formal-dresses") || c.includes("special-occassion-dresses") || /\b(sequin|sequins|cocktail|formal|gown|diamante|diamant|bustier|tulle|metallic|metalic|evening|party|silk)\b/.test(t)) return 2;
  if (/\b(raffia|rafia|straw|canvas|beach|slides?|thongs|flip flops?|bear|lobster|novelty|cartoon|confetti|slogan|graphic|cherrybomb|fruit|fruits)\b/.test(t)) return -1;
  if (/\b(sweat|sweatshirt|sweatpants?|jogger|joggers|hoodie|hooded|track|trackpant|cargo|rugby|legging|leggings|sport|graphic|slogan)\b/.test(t)) return -1;
  if (/\b(satin|velvet|lace|blazer|tailored|suit|suiting|trench|pinstripe|pleated|classic pant|pencil|bias|silky|pussy bow|leather|pleather|faux leather|heel|heels|clutch)\b/.test(t) || kind === "blazer") return 1;
  return 0;
}

/* ---------- recipes ---------- */
// each slot = list of piece kinds. Order = outfit order on the rail.
const RECIPES = {
  top:        [["bottom", BOTTOMS], ["layer", ["blazer", "jacket", "denimjacket", "coat"]], ["bag", ["bag"]], ["jewellery", ["jewellery"]], ["shoes", ["shoes"]], ["belt", ["belt"]]],
  knit:       [["bottom", ["pants", "jeans", "skirt"]], ["layer", ["coat", "jacket", "blazer"]], ["bag", ["bag"]], ["jewellery", ["jewellery", "scarf"]], ["shoes", ["shoes"]]],
  cardigan:   [["top", ["top"]], ["bottom", ["pants", "jeans", "skirt"]], ["bag", ["bag"]], ["jewellery", ["jewellery"]], ["shoes", ["shoes"]]],
  dress:      [["layer", ["denimjacket", "blazer", "jacket", "coat"]], ["bag", ["bag"]], ["jewellery", ["jewellery"]], ["shoes", ["shoes"]], ["belt", ["belt", "scarf"]]],
  jumpsuit:   [["layer", ["blazer", "jacket", "denimjacket", "coat"]], ["bag", ["bag"]], ["jewellery", ["jewellery"]], ["shoes", ["shoes"]], ["belt", ["belt"]]],
  set:        [["layer", ["blazer", "jacket", "coat"]], ["bag", ["bag"]], ["jewellery", ["jewellery"]], ["shoes", ["shoes"]]],
  pants:      [["top", ["top", "knit"]], ["layer", ["blazer", "jacket", "denimjacket", "coat"]], ["bag", ["bag"]], ["belt", ["belt", "jewellery"]], ["shoes", ["shoes"]]],
  jeans:      [["top", ["top", "knit"]], ["layer", ["blazer", "jacket", "coat"]], ["bag", ["bag"]], ["belt", ["belt", "jewellery"]], ["shoes", ["shoes"]]],
  skirt:      [["top", ["top", "knit"]], ["layer", ["blazer", "jacket", "denimjacket", "coat"]], ["bag", ["bag"]], ["jewellery", ["jewellery", "belt"]], ["shoes", ["shoes"]]],
  shorts:     [["top", ["top"]], ["layer", ["blazer", "denimjacket", "jacket"]], ["bag", ["bag"]], ["jewellery", ["jewellery", "belt"]], ["shoes", ["shoes"]]],
  blazer:     [["top", ["top", "knit"]], ["bottom", ["pants", "jeans", "skirt"]], ["bag", ["bag"]], ["jewellery", ["jewellery"]], ["shoes", ["shoes"]]],
  coat:       [["top", ["knit", "top"]], ["bottom", ["pants", "jeans", "skirt"]], ["bag", ["bag"]], ["scarf", ["scarf", "jewellery"]], ["shoes", ["shoes"]]],
  jacket:     [["top", ["top", "knit"]], ["bottom", ["pants", "jeans", "skirt"]], ["bag", ["bag"]], ["jewellery", ["jewellery"]], ["shoes", ["shoes"]]],
  denimjacket:[["top", ["top", "knit"]], ["bottom", ["pants", "skirt", "shorts"]], ["bag", ["bag"]], ["jewellery", ["jewellery"]], ["shoes", ["shoes"]]],
  bag:        [["dress", ["dress"]], ["top", ["top", "knit"]], ["bottom", ["pants", "jeans", "skirt"]], ["layer", ["blazer", "jacket", "coat"]]],
  jewellery:  [["dress", ["dress"]], ["top", ["top", "knit"]], ["bottom", ["pants", "jeans", "skirt"]], ["bag", ["bag"]]],
  belt:       [["dress", ["dress"]], ["bottom", ["pants", "jeans", "skirt"]], ["top", ["top"]], ["bag", ["bag"]]],
  scarf:      [["layer", ["coat", "jacket"]], ["top", ["knit", "top"]], ["bottom", ["pants", "jeans"]], ["bag", ["bag"]]],
  shoes:      [["dress", ["dress"]], ["top", ["top"]], ["bottom", ["pants", "jeans", "skirt"]], ["bag", ["bag"]]],
  sunglasses: [["dress", ["dress"]], ["top", ["top"]], ["bottom", ["pants", "jeans", "skirt", "shorts"]], ["bag", ["bag"]]],
  hat:        [["dress", ["dress"]], ["top", ["top"]], ["bottom", ["pants", "jeans", "skirt", "shorts"]], ["bag", ["bag"]]],
};

/* ---------- product helpers ---------- */
const NEW_DAYS = 30;
const colsOf = p => p.cols || [];
const isBest = p => colsOf(p).includes("best-seller") || (p.tagsLc || []).includes("best-seller");
const isNew = (p, now) => colsOf(p).includes("new-arrivals") || (p.createdAt && now - Date.parse(p.createdAt) <= NEW_DAYS * 864e5);
function stem(title) { return norm(title).replace(/\s*(new colou?rs?|pre order|\d\.\d|ss\d\d|aw\d\d)\b.*$/, "").replace(/\s+(in\s+)?(black|white|navy|ivory|chocolate|choc|mocha|olive|plum|stone|beige|khaki|red|berry|green|grey|brown|blue|denim|dark denim|washed black|ivory)$/, "").trim(); }
function size12(p) {
  const sizes = p.sizes || [];
  if (!sizes.length) return true;
  for (const v of sizes) {
    const n = (String(v).match(/\d+/g) || []).map(Number).filter(x => x <= 40);
    if (n.length && Math.max(...n) >= 12) return true;
    if (/one\s*-?\s*size|osfa|free\s*size/i.test(v)) return true;
    if (/\b(l|xl|xxl|xxxl|ml|lxl|[1-4]x)\b/i.test(v)) return true;
  }
  return false;
}
function metalOfTitle(t) { t = norm(t); if (/rose gold/.test(t)) return "gold"; if (/\bgold\b/.test(t)) return "gold"; if (/\bsilver|sterling\b/.test(t)) return "silver"; return null; }

// every colour option of a product as a descriptor (variant colour -> its photo / variant id)
function optionsOf(p, kind) {
  const list = (p.colours && p.colours.length) ? p.colours : [{ color: p.color || "", variantId: p.variantId, img: p.img, price: p.price }];
  const out = [];
  for (const o of list) {
    const d = toneOf(o.color, p.cp, p.title, kind);
    if (d.known) out.push({ d, opt: o });
  }
  return out;
}

// stable 0..1 number per (product, piece) pair: same answer every time for a product, different across products
function mix(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; }

/* ---------- engine ---------- */
function completeTheLook3(catalog, anchor, opts = {}) {
  const total = Number.isFinite(opts.total) ? opts.total : 8;
  const now = opts.now || Date.now();
  const akind = kindOf(anchor);
  const recipe = RECIPES[akind];
  if (!recipe) return { items: [], meta: { engine: "ctl3", kind: akind, skipped: "not an outfit product" } };
  const acolorRaw = opts.acolor || anchor.color || "";
  let ad = toneOf(acolorRaw, anchor.cp, anchor.title, akind);
  if (!ad.known) ad = { tone: "print", print: "unknown", known: true }; // unknown product colour -> safest neutrals only
  const aSeason = seasonOf(anchor, akind), aOcc = occasionOf(anchor, akind);
  const aMetal = metalOfTitle(anchor.title) || (METALS.has(ad.tone) ? ad.tone : null);
  const curvy = colsOf(anchor).some(h => /^curvy-/.test(h)) || (anchor.tagsLc || []).some(t => /curvy|plus/.test(t));
  const formal = colsOf(anchor).includes("formal-dresses") || colsOf(anchor).includes("special-occassion-dresses") || aOcc === 2;
  const aStem = stem(anchor.title);
  // Sydney seasons: Oct-Mar warm, May-Aug cool -> prefer in-season pieces (soft, not a block)
  const mon = new Date(now).getMonth();
  const nowSeason = opts.season || ([9, 10, 11, 0, 1, 2].includes(mon) ? "summer" : [4, 5, 6, 7].includes(mon) ? "winter" : "all");
  const offSeason = s => (nowSeason === "summer" && s === "winter") || (nowSeason === "winter" && s === "summer");
  const meta = { engine: "ctl3", kind: akind, anchor_tone: ad.tone, anchor_print: ad.print || null, season: aSeason, occasion: aOcc, curvy, metal: aMetal, dropped: {} };
  const drop = why => { meta.dropped[why] = (meta.dropped[why] || 0) + 1; };

  // candidate pool, pre-filtered by hard gates
  const pool = [];
  for (const p of catalog) {
    if (!p || !p.available) continue;
    if (String(p.id) === String(anchor.id) || (p.handle && p.handle === anchor.handle)) continue;
    const k = kindOf(p);
    if (k === "x" || k === "set") continue;
    if (/\b(cape|poncho|kimono)\b/.test(norm(p.title))) { drop("statement_layer"); continue; }
    if (/\b(lounge|loungewear|pyjama|pajama)\b/.test(norm(p.title))) { drop("lounge"); continue; } // BOKO P7: loungewear is not an outfit piece // statement pieces are not "go-with" items
    if (stem(p.title) === aStem) { drop("same_style"); continue; }
    if (curvy && APPAREL.has(k) && !size12(p)) { drop("size"); continue; }
    const s = seasonOf(p, k);
    if ((aSeason === "summer" && s === "winter") || (aSeason === "winter" && s === "summer")) { drop("season"); continue; }
    const o = occasionOf(p, k);
    if (Math.abs(aOcc - o) >= 2 && !(aOcc === 2 && o === 0) && !(aOcc === 0 && o === 2)) { drop("occasion"); continue; }
    if (formal && (k === "denimjacket" || k === "hat" || k === "sunglasses" || (k === "jacket" && /\b(bomber|utility|puffer|vest|sport|hooded)\b/.test(norm(p.title))))) { drop("formal"); continue; }
    if (aOcc === -1 && (k === "blazer")) { drop("occasion"); continue; }
    const options = optionsOf(p, k);
    if (!options.length) { drop("unknown_colour"); continue; }
    pool.push({ p, k, s, o, options, metal: metalOfTitle(p.title) });
  }

  // look state: the anchor + chosen pieces
  const look = [{ d: ad, slot: "anchor" }];
  const lookColour = () => look.map(x => x.d).find(d => isColourful(d.tone) && !d.print) || null;
  const lookPrints = () => look.filter(x => x.d.print).length;
  const lookStatements = () => look.filter(x => x.d.print || isColourful(x.d.tone)).length;
  let lookMetal = aMetal;

  function fit(c, d, against) {
    // product
    const sA = pairScore(ad, d);
    if (sA < 2) return null;
    let min = sA, sum = sA * 2;
    for (const x of against) { const s = pairScore(x.d, d); if (s < 1) return null; min = Math.min(min, s); sum += s; }
    // ONE statement per look: a colour OR a print (the product counts). Neutrals + metals are free.
    // e.g. green top -> neutral pieces only; black pant -> one red bag OR one leopard scarf, not both.
    if ((isColourful(d.tone) || d.print) && lookStatements() >= 1) return null;
    // metals
    if (c.k === "jewellery") {
      const m = METALS.has(d.tone) ? d.tone : c.metal;
      if (!m) return null;
      if (lookMetal && m !== lookMetal) return null;
      sum += (m === "gold") === WARM.has(ad.tone) ? 1 : 0;
    }
    return { min, sum };
  }
  function bestOption(c, against) {
    let best = null;
    for (const o of c.options) {
      const f = fit(c, o.d, against);
      if (f && (!best || f.sum > best.f.sum)) best = { f, o };
    }
    return best;
  }
  function rank(cands, against) {
    const out = [];
    for (const c of cands) {
      const b = bestOption(c, against);
      if (!b) continue;
      out.push({ c, b, key: [offSeason(c.s) ? 0 : 1, b.f.sum, -Math.abs(c.o - aOcc), mix(String(anchor.id) + ":" + c.p.id)] });
    }
    out.sort((x, y) => { for (let i = 0; i < x.key.length; i++) if (x.key[i] !== y.key[i]) return y.key[i] - x.key[i]; return 0; });
    return out;
  }
  const used = new Set(), usedStems = new Set();
  const take = (x, slot) => {
    used.add(String(x.c.p.id)); usedStems.add(stem(x.c.p.title));
    look.push({ d: x.b.o.d, slot, kind: x.c.k });
    if (x.c.k === "jewellery") lookMetal = lookMetal || (METALS.has(x.b.o.d.tone) ? x.b.o.d.tone : x.c.metal);
    return format(x, slot);
  };
  const free = c => !used.has(String(c.p.id)) && !usedStems.has(stem(c.p.title));

  // Pass 1 - the outfit: best piece per slot, each checked against everything already in the look
  const out = [];
  const core = {};
  for (const [slot, kinds] of recipe) {
    const cands = pool.filter(c => kinds.includes(c.k) && free(c));
    const r = rank(cands, look.slice(1));
    if (r.length) { core[slot] = r[0]; out.push(take(r[0], slot)); }
    else drop("empty_slot:" + slot);
  }
  // Pass 2 - alternatives per slot (round robin), each must work with the product and with the
  // other outfit pieces (not the piece it would replace)
  const queues = recipe.map(([slot, kinds]) => {
    const against = look.filter(x => x.slot !== "anchor" && x.slot !== slot);
    const saved = look.slice(); // freeze look for checks
    const r = rank(pool.filter(c => kinds.includes(c.k) && free(c)), against);
    return { slot, r, saved };
  });
  let added = true;
  while (out.length < total && added) {
    added = false;
    for (const q of queues) {
      if (out.length >= total) break;
      while (q.r.length && !free(q.r[0].c)) q.r.shift();
      const x = q.r.shift();
      if (!x) continue;
      used.add(String(x.c.p.id)); usedStems.add(stem(x.c.p.title));
      out.push(format(x, q.slot + "_alt")); added = true;
    }
  }
  meta.pieces = out.length;
  return { items: out.slice(0, total), meta };
}

function format(x, slot) {
  const p = x.c.p, o = x.b.o.opt || {}, d = x.b.o.d;
  return {
    id: p.gid || ("gid://shopify/Product/" + p.id), handle: p.handle, variantId: o.variantId || p.variantId, available: true,
    title: p.title, vendor: p.vendor || "", tags: p.tags || [], category: p.category || "", price: o.price || p.price, img: o.img || p.img || "",
    createdAt: p.createdAt || null, slot, kind: x.c.k,
    reason: "color_match", color: o.color || "", color_tone: d.tone + (d.print ? " " + d.print : ""), color_score: x.b.f.min,
  };
}

export { completeTheLook3, kindOf, toneOf, pairScore, seasonOf, occasionOf, RECIPES };
