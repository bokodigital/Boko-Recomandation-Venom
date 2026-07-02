const SHOP = process.env.SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
if (!SHOP || !TOKEN) { console.error("MISSING SHOP or SHOPIFY_ADMIN_TOKEN"); process.exit(1); }
const API = `https://${SHOP.replace(/^https?:\/\//,"")}/admin/api/2025-01/graphql.json`;
async function gql(query, variables) {
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN }, body: JSON.stringify({ query, variables }) });
  return r.json();
}
const q = `{ shopifyFunctions(first: 25) { nodes { id title apiType app { title } } } }`;
const fns = await gql(q);
console.log("FUNCTIONS:", JSON.stringify(fns.data && fns.data.shopifyFunctions && fns.data.shopifyFunctions.nodes, null, 2));
const nodes = (fns.data && fns.data.shopifyFunctions && fns.data.shopifyFunctions.nodes) || [];
const fn = nodes.find(n => n.apiType === "product_discounts" && /boko|bundle/i.test(((n.title||"") + " " + (n.app && n.app.title || ""))));
if (!fn) { console.error("Bundle function not found."); process.exit(1); }
console.log("USING FUNCTION:", fn.id, fn.title);
const m = `mutation($d: DiscountAutomaticAppInput!) { discountAutomaticAppCreate(automaticAppDiscount: $d) { automaticAppDiscount { discountId } userErrors { field message } } }`;
const res = await gql(m, { d: { title: "Bundle 10% off", functionId: fn.id, startsAt: new Date().toISOString(), combinesWith: { orderDiscounts: true, productDiscounts: false, shippingDiscounts: true } } });
console.log("CREATE RESULT:", JSON.stringify(res, null, 2));
