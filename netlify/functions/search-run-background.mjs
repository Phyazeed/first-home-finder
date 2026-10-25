// Saudi First Home Finder: runs one live search in the background.
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
  const goal = ["rent", "live", "either"].includes(c.goal) ? c.goal : "either";
  if (!cities.length || !(maxPrice >= 150000 && maxPrice <= 5000000)) return null;
  const bucket = Math.ceil(maxPrice / 25000) * 25000; // group similar budgets so results can be reused
  return { cities: [...cities].sort(), maxPrice: bucket, minPrice: Math.round(bucket * 0.55 / 10000) * 10000, minBeds, goal };
}


// Runs one live listing search with Claude + web search, then stores the result for the page to poll.
const SITES = ["aqar.fm", "bayut.sa", "propertyfinder.sa", "wasalt.sa"];
const DISTRICTS = {
  Riyadh: "North: Al Malqa, Al Yasmin, Al Narjis, Al Arid, Hittin, Al Qirawan, Al Nada, Al Sahafa. East: Al Rimal, Qurtubah, Al Yarmuk, Ishbiliyah, Al Munsiyah, Al Nahdah, Ghirnatah",
  Jeddah: "North: Obhur Al Shamaliyah, Al Yaqoot, Al Zumorrodah, Al Lulu, Al Basateen, Al Mohammadiyah, Al Naeem",
  "Al Khobar": "Al Aqrabiyah, Al Rakah Al Janubiyah, Al Hamra, Al Hizam Al Akhdar, Al Ulaya, Al Khobar Al Shamaliyah",
};

const SYSTEM = `You search Saudi property listing sites for apartments, floors (دور) and roof units currently FOR SALE.
Rules:
- Use the web_search tool. Search in Arabic and English, for example "شقق للبيع حي الرمال الرياض" or "apartment for sale Al Yaqoot Jeddah".
- Prefer individual listing pages. A search-results page is acceptable only if the specific listing's price and size are visible in its snippet.
- Report ONLY listings whose price and size you actually saw in the search results. Never invent, estimate or round a price, size or URL. Copy the URL exactly as it appeared in the results.
- Skip rentals, villas, land, buildings, studios under 40 m² and anything outside the price range.
- Note honest red flags you saw: cash only, off-plan or under construction (ask for Wafi licence), price conflicts in the text, posting older than 6 months, missing size.
- Return 6 to 15 listings, spread across the requested cities.
Output ONLY a JSON object between <json> and </json>, with this shape:
{"listings":[{"title":"","title_ar":"","city":"Riyadh|Jeddah|Al Khobar","district":"","district_ar":"","type":"apartment|floor|roof","price_sar":0,"size_m2":0,"beds":null,"url":"","source":"Aqar|Bayut|Property Finder|Wasalt","posted":null,"rent_annual_sar":null,"rent_basis":null,"features":[],"red_flags":[]}],"market_note":""}
rent_annual_sar is only filled if a rent for this or a very similar unit nearby appeared in the results; say where in rent_basis.`;

function userPrompt(c) {
  const cities = c.cities.map(x => `${x} (${DISTRICTS[x]})`).join("; ");
  const goal = c.goal === "rent" ? "to rent out, so rental demand matters" : c.goal === "live" ? "to live in" : "to live in or rent out";
  return `Find current listings for a first-home buyer.
Cities and districts to cover: ${cities}.
Price: between ${c.minPrice.toLocaleString("en-US")} and ${c.maxPrice.toLocaleString("en-US")} SAR.
Bedrooms: ${c.minBeds ? c.minBeds + " or more" : "any"}.
Purpose: ${goal}.
Today is ${new Date().toISOString().slice(0, 10)}. Favour recent postings.`;
}

async function callClaude(messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: env("CLAUDE_MODEL", "claude-sonnet-5-5"),
      max_tokens: 8000,
      system: SYSTEM,
      messages,
      tools: [{
        type: "web_search_20250305", name: "web_search",
        max_uses: Number(env("MAX_WEB_SEARCHES", "8")),
        allowed_domains: SITES, allowed_callers: ["direct"],
        user_location: { type: "approximate", country: "SA", timezone: "Asia/Riyadh" },
      }],
    }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const num = v => { const n = Number(String(v ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
const str = (v, n = 140) => (typeof v === "string" ? v.replace(/[<>]/g, "").trim().slice(0, n) : "");

export default async (req) => {
  let id;
  try {
    if (req.headers.get("x-fhf-secret") !== await sha(env("ANTHROPIC_API_KEY") + "run")) return;
    ({ id } = await req.json());
    const J = jobs();
    const job = await J.get("job:" + id, { type: "json" });
    if (!job || job.status !== "queued") return;
    await J.setJSON("job:" + id, { ...job, status: "running", startedAt: Date.now() });

    const messages = [{ role: "user", content: userPrompt(job.crit) }];
    const seen = new Set(); const queries = []; let text = ""; let usage = { searches: 0, input: 0, output: 0 };
    for (let turn = 0; turn < 5; turn++) {
      const res = await callClaude(messages);
      usage.input += res.usage?.input_tokens || 0; usage.output += res.usage?.output_tokens || 0;
      usage.searches += res.usage?.server_tool_use?.web_search_requests || 0;
      for (const b of res.content || []) {
        if (b.type === "server_tool_use" && b.input?.query) queries.push(b.input.query);
        if (b.type === "web_search_tool_result" && Array.isArray(b.content)) b.content.forEach(x => x.url && seen.add(x.url));
        if (b.type === "text") text += b.text;
      }
      if (res.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: res.content });
    }

    const m = text.match(/<json>([\s\S]*?)<\/json>/);
    let parsed = null; try { parsed = JSON.parse(m ? m[1] : text); } catch { /* handled below */ }
    if (!parsed || !Array.isArray(parsed.listings)) throw new Error("The search returned no readable listings.");

    // Keep only listings that point at a page the search really returned and have real numbers.
    const listings = [];
    for (const x of parsed.listings.slice(0, 20)) {
      const price = num(x.price_sar), size = num(x.size_m2), url = str(x.url, 600);
      if (!price || !size || price < 50000 || price > 20e6 || size < 30 || size > 2000) continue;
      if (!/^https:\/\/([a-z0-9-]+\.)*(aqar\.fm|bayut\.sa|propertyfinder\.sa|wasalt\.sa)\//i.test(url)) continue;
      if (!seen.has(url)) continue;
      listings.push({
        title: str(x.title), title_ar: str(x.title_ar), city: ["Riyadh", "Jeddah", "Al Khobar"].includes(x.city) ? x.city : null,
        district: str(x.district, 60), district_ar: str(x.district_ar, 60), type: ["apartment", "floor", "roof"].includes(x.type) ? x.type : "apartment",
        price, size, beds: num(x.beds), url, source: str(x.source, 30), posted: str(x.posted, 40) || null,
        rent: num(x.rent_annual_sar), rentBasis: str(x.rent_basis, 200) || null,
        features: (Array.isArray(x.features) ? x.features : []).slice(0, 6).map(f => str(f, 90)).filter(Boolean),
        flags: (Array.isArray(x.red_flags) ? x.red_flags : []).slice(0, 6).map(f => str(f, 120)).filter(Boolean),
      });
    }
    const dropped = parsed.listings.length - listings.length;
    await J.setJSON("job:" + id, { status: "done", listings: listings.filter(l => l.city), note: str(parsed.market_note, 300), queries: queries.slice(0, 12), dropped, usage, finishedAt: Date.now() });
  } catch (e) {
    if (id) await jobs().setJSON("job:" + id, { status: "error", message: String(e.message || e).slice(0, 300) });
  }
};

export const config = { background: true, path: "/api/search-run" };
