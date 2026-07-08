import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "boko-track.json");
let data = {};
try { data = JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch (e) { data = {}; }

let dirty = false;
function persist(){ try { fs.writeFileSync(FILE, JSON.stringify(data)); } catch (e) {} }
setInterval(() => { if (dirty) { dirty = false; persist(); } }, 5000);
process.on("SIGTERM", persist);
process.on("SIGINT", () => { persist(); process.exit(0); });

export function normSource(v){
  v = String(v || "").toLowerCase();
  if (v.indexOf("selected-for-you") > -1) return "sfy";
  if (v.indexOf("cart") > -1) return "cart_drawer";
  if (v === "pdp" || v.indexOf("rail") > -1 || v.indexOf("product") > -1) return "pdp";
  return null;
}
export function track(event, source){
  if (event !== "click" && event !== "add") return;
  const s = normSource(source);
  if (!s) return;
  const day = new Date().toISOString().slice(0, 10);
  data[day] = data[day] || {};
  data[day][s] = data[day][s] || { click: 0, add: 0 };
  data[day][s][event] += 1;
  dirty = true;
}
export function funnelCounts(days){
  const since = new Date(Date.now() - (days || 90) * 864e5).toISOString().slice(0, 10);
  const out = { pdp: { click: 0, add: 0 }, cart_drawer: { click: 0, add: 0 }, sfy: { click: 0, add: 0 } };
  Object.keys(data).forEach((day) => {
    if (day < since) return;
    const d = data[day];
    ["pdp", "cart_drawer", "sfy"].forEach((s) => {
      if (d[s]) { out[s].click += d[s].click || 0; out[s].add += d[s].add || 0; }
    });
  });
  return out;
}
