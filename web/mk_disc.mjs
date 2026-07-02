import Database from "@replit/database";
const db = new Database();
const SHOP = "venomemilio.myshopify.com";
async function getToken(shop){ const r = await db.get("shop:"+shop); if (r && typeof r==="object" && "ok" in r) return r.ok ? r.value : null; return r || null; }
const token = await getToken(SHOP);
if(!token){ console.error("NO TOKEN stored for", SHOP); process.exit(1); }
const API = "https://"+SHOP+"/admin/api/2025-01/graphql.json";
const gql = (q,v)=>fetch(API,{method:"POST",headers:{"Content-Type":"application/json","X-Shopify-Access-Token":token},body:JSON.stringify({query:q,variables:v})}).then(r=>r.json());
const fns = await gql("{ shopifyFunctions(first:25){ nodes{ id title apiType } } }");
console.log("FUNCTIONS:", JSON.stringify(fns.data && fns.data.shopifyFunctions && fns.data.shopifyFunctions.nodes));
const fn = ((fns.data && fns.data.shopifyFunctions && fns.data.shopifyFunctions.nodes) || []).find(n => n.apiType === "product_discounts");
if(!fn){ console.error("No product_discounts function found for this token."); process.exit(1); }
console.log("USING FUNCTION:", fn.id, fn.title);
const m = "mutation($d: DiscountAutomaticAppInput!){ discountAutomaticAppCreate(automaticAppDiscount:$d){ automaticAppDiscount{ discountId } userErrors{ field message } } }";
const res = await gql(m, { d: { title: "Bundle 10% off", functionId: fn.id, startsAt: new Date().toISOString(), combinesWith: { orderDiscounts: true, productDiscounts: false, shippingDiscounts: true } } });
console.log("CREATE RESULT:", JSON.stringify(res, null, 2));
