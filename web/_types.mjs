import Database from "@replit/database";
const db = new Database();
const shop = "venomemilio.myshopify.com";
const r = await db.get("shop:" + shop);
const token = (r && typeof r === "object" && "ok" in r) ? r.value : r;
const ver = process.env.SHOPIFY_API_VERSION || "2024-10";
const q = `{ products(first: 250, sortKey: PUBLISHED_AT, reverse: true){ edges{ node{ productType createdAt } } } }`;
const res = await fetch(`https://${shop}/admin/api/${ver}/graphql.json`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token }, body: JSON.stringify({ query: q }) });
const j = await res.json();
if (j.errors) { console.log("ERR", JSON.stringify(j.errors)); process.exit(0); }
const edges = j.data.products.edges;
const types = {}; const recent = {};
const now = Date.now();
for (const e of edges) { const t = (e.node.productType || "(none)"); types[t] = (types[t] || 0) + 1; if (now - new Date(e.node.createdAt).getTime() < 90 * 864e5) recent[t] = (recent[t] || 0) + 1; }
console.log("SAMPLE " + edges.length);
console.log("ALL_TYPES " + JSON.stringify(types));
console.log("RECENT_90D " + JSON.stringify(recent));
