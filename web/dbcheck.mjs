import Database from "@replit/database";
const db=new Database();
const shop="venomemilio.myshopify.com";
const meta=await db.get("boko_impact_meta:"+shop);
console.log("META="+JSON.stringify(meta));
const arr=x=>Array.isArray(x)?x:(x&&x.value?x.value:[]);
const oids=await db.list("boko_oid:"+shop+":");
const days=await db.list("boko_daily:"+shop+":");
console.log("OIDS="+arr(oids).length+" DAYS="+arr(days).length);
