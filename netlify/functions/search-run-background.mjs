// Saudi First Home Finder: runs one live search in the background, one parallel search per city.
import { getStore } from "@netlify/blobs";
const jobs = () => getStore("fhf-jobs");
const env = (k, d) => { const v = Netlify.env.get(k); return v === undefined || v === "" ? d : v; };
async function sha(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("").slice(0, 32); }

const SITES = ["aqar.fm", "bayut.sa", "propertyfinder.sa", "wasalt.sa"];
const DISTRICTS = {
  Riyadh: "North: Al Malqa, Al Yasmin, Al Narjis, Al Arid, Hittin, Al Qirawan, Al Nada, Al Sahafa. East: Al Rimal, Qurtubah, Al Yarmuk, Ishbiliyah, Al Munsiyah, Al Nahdah, Ghirnatah",
  Jeddah: "North: Obhur Al Shamaliyah, Al Yaqoot, Al Zumorrodah, Al Lulu, Al Basateen, Al Mohammadiyah, Al Naeem",
  "Al Khobar": "Al Aqrabiyah, Al Rakah Al Janubiyah, Al Hamra, Al Hizam Al Akhdar, Al Ulaya, Al Khobar Al Shamaliyah",
};

const SYSTEM = `You search Saudi property listing sites for apartments, floors (دور) and roof units currently FOR SALE. Be quick: run your searches, then answer.
Rules:
- Use the web_search tool. Search in Arabic, for example "شقق للبيع حي الرمال الرياض", and in English if needed.
- Report ONLY listings whose price and size you actually saw in the search results. Never invent, estimate or round a price, size or URL. Copy the URL exactly as it appeared in the results.
- Skip rentals, villas, land, whole buildings, studios under 40 m² and anything outside the price range.
- Note honest red flags you saw: cash only, off-plan or under construction (ask for Wafi licence), price conflicts, posting older than 6 months.
- Return up to 8 listings.
Output ONLY a JSON object between <json> and </json>:
{"listings":[{"title":"","title_ar":"","district":"","district_ar":"","type":"apartment|floor|roof","price_sar":0,"size_m2":0,"beds":null,"url":"","source":"Aqar|Bayut|Property Finder|Wasalt","posted":null,"rent_annual_sar":null,"rent_basis":null,"features":[],"red_flags":[]}],"market_note":""}
rent_annual_sar only if a rent for this or a very similar nearby unit appeared in the results.`;

const cityPrompt = (city, c) => `City: ${city}. Districts to favour: ${DISTRICTS[city]}.
Price: ${c.minPrice.toLocaleString("en-US")} to ${c.maxPrice.toLocaleString("en-US")} SAR. Bedrooms: ${c.minBeds ? c.minBeds + " or more" : "any"}.
Today is ${new Date().toISOString().slice(0, 10)}; favour recent postings.`;

async function callClaude(messages, signal) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal,
    headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: env("CLAUDE_MODEL", "claude-haiku-5-5"), max_tokens: 3000, system: SYSTEM, messages,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: Number(env("MAX_WEB_SEARCHES", "3")), allowed_domains: SITES, allowed_callers: ["direct"], user_location: { type: "approximate", country: "SA", timezone: "Asia/Riyadh" } }],
    }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 240)}`);
  return r.json();
}

const num = v => { const n = Number(String(v ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
const str = (v, n = 140) => (typeof v === "string" ? v.replace(/[<>]/g, "").trim().slice(0, n) : "");

async function searchCity(city, crit) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), Number(env("CITY_TIMEOUT_SECONDS", "150")) * 1000);
  try {
    const messages = [{ role: "user", content: cityPrompt(city, crit) }];
    const seen = new Set(); let text = ""; const usage = { searches: 0, input: 0, output: 0 };
    for (let turn = 0; turn < 3; turn++) {
      const res = await callClaude(messages, ctl.signal);
      usage.input += res.usage?.input_tokens || 0; usage.output += res.usage?.output_tokens || 0; usage.searches += res.usage?.server_tool_use?.web_search_requests || 0;
      for (const b of res.content || []) {
        if (b.type === "web_search_tool_result" && Array.isArray(b.content)) b.content.forEach(x => x.url && seen.add(x.url));
        if (b.type === "text") text += b.text;
      }
      if (res.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: res.content });
    }
    const m = text.match(/<json>([\s\S]*?)<\/json>/);
    let parsed = null; try { parsed = JSON.parse(m ? m[1] : text); } catch { parsed = { listings: [] }; }
    const raw = Array.isArray(parsed.listings) ? parsed.listings.slice(0, 12) : [];
    const listings = [];
    for (const x of raw) {
      const price = num(x.price_sar), size = num(x.size_m2), url = str(x.url, 600);
      if (!price || !size || price < 50000 || price > 20e6 || size < 30 || size > 2000) continue;
      if (!/^https:\/\/([a-z0-9-]+\.)*(aqar\.fm|bayut\.sa|propertyfinder\.sa|wasalt\.sa)\//i.test(url) || !seen.has(url)) continue;
      listings.push({ title: str(x.title), title_ar: str(x.title_ar), city, district: str(x.district, 60), district_ar: str(x.district_ar, 60),
        type: ["apartment", "floor", "roof"].includes(x.type) ? x.type : "apartment", price, size, beds: num(x.beds), url, source: str(x.source, 30), posted: str(x.posted, 40) || null,
        rent: num(x.rent_annual_sar), rentBasis: str(x.rent_basis, 200) || null,
        features: (Array.isArray(x.features) ? x.features : []).slice(0, 6).map(f => str(f, 90)).filter(Boolean),
        flags: (Array.isArray(x.red_flags) ? x.red_flags : []).slice(0, 6).map(f => str(f, 120)).filter(Boolean) });
    }
    return { listings, dropped: raw.length - listings.length, note: str(parsed.market_note, 200), usage };
  } finally { clearTimeout(timer); }
}

export default async (req) => {
  let id;
  try {
    if (req.headers.get("x-fhf-secret") !== await sha(env("ANTHROPIC_API_KEY") + "run")) return;
    ({ id } = await req.json());
    const J = jobs();
    const job = await J.get("job:" + id, { type: "json" });
    if (!job || job.status !== "queued") return;
    const crit = job.crit; const cacheMs = Number(env("CACHE_HOURS", "6")) * 3600e3;
    const state = { status: "running", at: job.at, startedAt: Date.now(), listings: [], done: [], failed: [], pending: [...crit.cities], dropped: 0, notes: [] };
    const save = () => J.setJSON("job:" + id, state);
    await save();
    let chain = Promise.resolve(); const queueSave = () => (chain = chain.then(save)); // keep blob writes in order

    await Promise.all(crit.cities.map(async city => {
      const ck = "city:" + await sha(JSON.stringify([city, crit.maxPrice, crit.minBeds]));
      try {
        let r = null; const hit = await J.get(ck, { type: "json" });
        if (hit && Date.now() - hit.at < cacheMs) r = hit.r;
        else { r = await searchCity(city, crit); await J.setJSON(ck, { at: Date.now(), r }); }
        state.listings.push(...r.listings); state.dropped += r.dropped; if (r.note) state.notes.push(r.note); state.done.push(city);
      } catch (e) {
        state.failed.push({ city, message: e.name === "AbortError" ? "timed out" : String(e.message || e).slice(0, 240) });
      }
      state.pending = state.pending.filter(c => c !== city);
      await queueSave();
    }));
    await chain;
    state.status = state.done.length ? "done" : "error";
    if (!state.done.length) state.message = state.failed.map(f => `${f.city}: ${f.message}`).join("; ");
    state.note = state.notes.join(" ");
    state.finishedAt = Date.now();
    await save();
  } catch (e) {
    if (id) await jobs().setJSON("job:" + id, { status: "error", message: String(e.message || e).slice(0, 300) });
  }
};

export const config = { background: true, path: "/api/search-run" };
