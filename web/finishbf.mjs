import Database from "@replit/database";
import { __test } from "./boko-impact.js";
const db = new Database();
const shop = "venomemilio.myshopify.com";
const API = process.env.SHOPIFY_API_VERSION || "2026-01";
console.log("using API=" + API);
const tr = await db.get("shop:" + shop);
const token = (tr && typeof tr === "object" && "ok" in tr) ? (tr.ok ? tr.value : null) : tr;
if (!token) { console.log("NO_TOKEN"); process.exit(1); }
async function gql(shop, token, query, variables) {
  const r = await fetch("https://" + shop + "/admin/api/" + API + "/graphql.json", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j && j.errors) console.log("GQL_ERR " + JSON.stringify(j.errors).slice(0, 250));
  return j;
}
console.log("scanning orders to completion...");
const n = await __test.backfill(shop, token, { gql }, 90);
console.log("FINISHED recorded_new=" + n);
