import Database from "@replit/database";
const db = new Database();
const shop = "venomemilio.myshopify.com";
const arr = x => Array.isArray(x) ? x : (x && x.value ? x.value : []);
const get = async k => { const r = await db.get(k); return (r && typeof r === 'object' && 'ok' in r) ? (r.ok ? r.value : null) : r; };
const oids = arr(await db.list("boko_oid:" + shop + ":"));
const days = arr(await db.list("boko_daily:" + shop + ":"));
let O = 0, R = 0, A = 0, I = 0;
for (const dk of days) { const row = await get(dk) || {}; O += row.orders || 0; R += row.revenue || 0; A += row.attributed_revenue || 0; I += row.influenced_orders || 0; }
console.log("UNIQUE_OIDS=" + oids.length + " DAYS=" + days.length);
console.log("SUM_ORDERS=" + O + " SUM_INFL=" + I);
console.log("SUM_REV=" + R.toFixed(2) + " SUM_ATTR=" + A.toFixed(2));