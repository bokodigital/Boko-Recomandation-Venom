// Durable funnel tracker for Boko Reco.
// Stores click/add counts in Replit DB so they PERSIST across redeploys/restarts.
// Uses the Replit DB HTTP API via REPLIT_DB_URL (no extra npm package needed).
// Falls back to a local file only if Replit DB is unavailable, so it never crashes.
import fs from "fs";
import path from "path";

const KEY = "boko_track";
const FILE = path.join(process.cwd(), "boko-track.json"); // fallback only

let data = {};
let loaded = false;
const queue = [];

function dbBase() {
  return process.env.REPLIT_DB_URL || "";
}

async function dbGet() {
  const base = dbBase();
  if (base) {
    const res = await fetch(base + "/" + encodeURIComponent(KEY));
    if (res.status === 404) return {};
    if (!res.ok) throw new Error("db get " + res.status);
    const txt = await res.text();
    return txt ? JSON.parse(txt) : {};
  }
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

async function dbSet(obj) {
  const base = dbBase();
  if (base) {
    try {
      await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:
          encodeURIComponent(KEY) +
          "=" +
          encodeURIComponent(JSON.stringify(obj)),
      });
      return;
    } catch (e) {}
  }
  try {
    fs.writeFileSync(FILE, JSON.stringify(obj));
  } catch (e) {}
}

async function load() {
  for (let i = 0; i < 3; i++) {
    try {
      data = await dbGet();
      break;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  loaded = true;
  while (queue.length) queue.shift()();
  scheduleSave();
}
load();

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    dbSet(data);
  }, 500);
}
process.on("SIGTERM", () => {
  try {
    dbSet(data);
  } catch (e) {}
});

export function normSource(v) {
  v = String(v || "").toLowerCase();
  if (v.indexOf("selected-for-you") > -1) return "sfy";
  if (v.indexOf("cart") > -1) return "cart_drawer";
  if (
    v.indexOf("pdp") > -1 ||
    v.indexOf("rail") > -1 ||
    v.indexOf("product") > -1
  )
    return "pdp";
  return null;
}

export function track(event, source) {
  if (event !== "click" && event !== "add") return;
  const s = normSource(source);
  if (!s) return;
  const apply = () => {
    const day = new Date().toISOString().slice(0, 10);
    data[day] = data[day] || {};
    data[day][s] = data[day][s] || { click: 0, add: 0 };
    data[day][s][event] += 1;
    scheduleSave();
  };
  if (!loaded) {
    queue.push(apply);
    return;
  }
  apply();
}

export function funnelCounts(days) {
  const since = new Date(Date.now() - (days || 90) * 864e5)
    .toISOString()
    .slice(0, 10);
  const out = {
    pdp: { click: 0, add: 0 },
    cart_drawer: { click: 0, add: 0 },
    sfy: { click: 0, add: 0 },
  };
  Object.keys(data).forEach((day) => {
    if (day < since) return;
    const d = data[day];
    ["pdp", "cart_drawer", "sfy"].forEach((s) => {
      if (d[s]) {
        out[s].click += d[s].click || 0;
        out[s].add += d[s].add || 0;
      }
    });
  });
  return out;
}
