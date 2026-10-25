// Saudi First Home Finder: starts a live search and reports its progress.
import { getStore } from "@netlify/blobs";
const jobs = () => getStore("fhf-jobs");
const limits = () => getStore("fhf-limits");
const env = (k, d) => { const v = Netlify.env.get(k); return v === undefined || v === "" ? d : v; };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
async function sha(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("").slice(0, 32); }
const CITIES = ["Riyadh", "Jeddah", "Al Khobar"];
// Normalise and bound what a visitor can ask for, so the search prompt only ever sees clean values.
function cleanCriteria(c) {
  if (!c || typeof c !== "object") return null;
  const cities = Array.isArray(c.cities) ? c.cities.filter(x => CITIES.includes(x)) : [];
  const maxPrice = Math.round(Number(c.maxPrice));
  const minBeds = [0, 2, 3].includes(Number(c.minBeds)) ? Number(c.minBeds) : 0;
  if (!cities.length || !(maxPrice >= 150000 && maxPrice <= 5000000)) return null;
  const bucket = Math.ceil(maxPrice / 25000) * 25000; // group similar budgets so results can be reused
  return { cities: [...cities].sort(), maxPrice: bucket, minPrice: Math.round(bucket * 0.55 / 10000) * 10000, minBeds };
}


async function startSearch(req, context) {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  if (!env("ANTHROPIC_API_KEY")) return json({ error: "Live search is not set up on this site yet (missing ANTHROPIC_API_KEY)." }, 503);
  let body; try { body = await req.json(); } catch { return json({ error: "Send the search criteria as JSON." }, 400); }
  const crit = cleanCriteria(body);
  if (!crit) return json({ error: "Pick at least one city and a budget between 150,000 and 5,000,000 SAR." }, 400);

  const today = new Date().toISOString().slice(0, 10);
  const key = await sha(JSON.stringify(crit));
  const J = jobs(), L = limits();

  // Reuse a recent search for the same criteria instead of paying for a new one.
  const cacheHours = Number(env("CACHE_HOURS", "6"));
  const cached = await J.get("cache:" + key, { type: "json" });
  if (cached && Date.now() - cached.at < cacheHours * 3600e3) {
    const job = await J.get("job:" + cached.id, { type: "json" });
    if (job && job.status === "done") return json({ id: cached.id, cached: true });
  }

  const ipHash = await sha((context.ip || "unknown") + today);
  const perIp = Number(env("MAX_SEARCHES_PER_VISITOR_PER_DAY", "3"));
  const perDay = Number(env("MAX_SEARCHES_PER_DAY", "40"));
  const ipCount = (await L.get(`ip:${today}:${ipHash}`, { type: "json" })) || 0;
  const dayCount = (await L.get(`day:${today}`, { type: "json" })) || 0;
  if (ipCount >= perIp) return json({ error: `You have used today's ${perIp} live searches. Try again tomorrow, or browse the saved listings below.` }, 429);
  if (dayCount >= perDay) return json({ error: "Today's live searches for this site are used up. Try again tomorrow, or browse the saved listings below." }, 429);
  await L.setJSON(`ip:${today}:${ipHash}`, ipCount + 1);
  await L.setJSON(`day:${today}`, dayCount + 1);

  const id = crypto.randomUUID();
  await J.setJSON("job:" + id, { status: "queued", crit, at: Date.now() });
  await J.setJSON("cache:" + key, { id, at: Date.now() });

  const origin = new URL(req.url).origin;
  const r = await fetch(origin + "/api/search-run", { method: "POST", headers: { "content-type": "application/json", "x-fhf-secret": await sha(env("ANTHROPIC_API_KEY") + "run") }, body: JSON.stringify({ id }) });
  if (r.status !== 202) { await J.setJSON("job:" + id, { status: "error", message: "The search could not be started." }); return json({ error: "The search could not be started. Try again in a minute." }, 502); }
  return json({ id });
}

async function searchStatus(req) {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "Unknown search." }, 400);
  const job = await jobs().get("job:" + id, { type: "json" });
  if (!job) return json({ error: "Unknown search." }, 404);
  const { crit, ...pub } = job;
  return json(pub);
}

export default async (req, context) => new URL(req.url).pathname.endsWith("/search-status") ? searchStatus(req) : startSearch(req, context);

export const config = { path: ["/api/search-start", "/api/search-status"] };
