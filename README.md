# Saudi First Home Finder

Static site (index.html, tiles.js) plus three Netlify Functions that run a live Claude web search of Saudi listing sites.

## Deploy (once)
1. Create a GitHub repository and upload every file in this folder (keep the folder structure).
2. In Netlify: Add new site → Import an existing project → GitHub → pick the repository. Leave the build settings as they are (netlify.toml sets them).
3. In Netlify: Site configuration → Environment variables → add `ANTHROPIC_API_KEY` with your key from console.anthropic.com. Mark it secret.
4. Deploys → Trigger deploy. Open the site, fill the profile, press "Search now".

## Optional settings (environment variables)
| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Model used for the search |
| `MAX_WEB_SEARCHES` | `8` | Web searches per live search ($10 per 1,000 searches, plus tokens) |
| `MAX_SEARCHES_PER_VISITOR_PER_DAY` | `3` | Per-visitor daily limit |
| `MAX_SEARCHES_PER_DAY` | `40` | Site-wide daily limit, your cost ceiling |
| `CACHE_HOURS` | `6` | Reuse a search for the same cities, budget band and bedrooms |

Also set a monthly spend limit on your Anthropic account.

## How it works
- `/api/search-start` checks limits and cache, then starts `/api/search-run` (a background function, up to 15 minutes).
- `search-run` asks Claude to search aqar.fm, bayut.sa, propertyfinder.sa and wasalt.sa, keeps only listings whose URL appeared in the real search results and whose price and size are plausible, and stores the result in Netlify Blobs.
- The page polls `/api/search-status` and scores each result against the visitor's profile in the browser. Salary and savings never leave the browser.
