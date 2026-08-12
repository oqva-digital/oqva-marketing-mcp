# Build brief — keyword/demand tools ("the radar")

*Working brief for the building agent. UNTRACKED — never commit this file; delete it
when the build is done. The spec it implements is general-purpose, like the rest of
this server: nothing business-specific (no client names, no real keyword lists) may
appear in code, comments, README, examples, or commit messages. Placeholder terms
only ("example software", "nichename").*

## Mission

Four tools added to `src/index.ts` so any business this server serves can
(a) look up real search volumes, (b) mine the visible query surface of a topic,
(c) track SERPs it cares about, and (d) get told, on each sweep, only what CHANGED —
including the moment a watched query first appears in Google suggest.

No dashboards, no subscriptions: DataForSEO pay-per-call for volume/SERP, free
Google suggest for query mining.

## House rules (read the code first — everything has a pattern)

- **One file, zero deps, Node ≥ 20 built-ins only.** Everything goes in
  `src/index.ts`. Global `fetch` is the HTTP client (see `gfetch`/`mfetch`).
- **Registry:** `tool(name, description, inputSchema, run)` (~line 199). Handlers
  return data or `throw new Error("…")` — the wrapper turns throws into `isError`
  results. Schema helpers `obj/str/enm/arr` (~lines 213–216).
- **Config:** env is loaded by the three-path `loadEnv` chain at the top (cwd
  `./.env` → `~/.oqva-marketing-mcp/.env` → source-tree `.env`). Add module-level
  `let DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD` beside the existing config lets and
  mirror them in `reloadConfig()`.
- **Not-configured behavior:** match `mfetch` — a clear
  `throw new Error("DataForSEO not configured — set DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD. See README.")`
  the moment a tool needing it runs without creds. `kw_suggest` needs no creds and
  must work regardless.
- **`config_status`** (~line 219) gains a `dataforseo: { configured: boolean }`
  block (no secrets revealed, same as the rest).
- **Per-call args with env/file defaults** — the `gsc_query` `siteUrl` idiom:
  explicit arg wins, sensible default otherwise (location defaults to 2840 US,
  language to "en", cluster values come from the cluster file).

## DataForSEO mechanics

- Auth: HTTP Basic — `Authorization: Basic base64(login:password)`.
- All endpoints are POST with a JSON **array** body of task objects; results come
  back under `tasks[0].result`. Write one `dfetch(path, taskBody)` helper in the
  style of `gfetch` (auth header, parse, throw on !ok **and** on DataForSEO's own
  per-task `status_code !== 20000`).
- Endpoints (verify exact request/response field names against
  https://docs.dataforseo.com/v3/ while building — don't trust this brief for
  field-level shapes):
  - Volume: `/v3/keywords_data/google_ads/search_volume/live`
  - SERP: `/v3/serp/google/organic/live/advanced` (advanced, not regular — the
    ads-presence signal needs paid items in the response)
- Cost sanity: volume ≈ $0.05–0.075 per 1k keywords, SERP a fraction of a cent
  per query. Cap volume batches at **500 keywords per call**; chunk above that.

## The four tools

1. **`kw_volume`** — batch keyword → volume / CPC / competition.
   Args: `keywords[]` (required), `location` (integer DataForSEO location code,
   default 2840), `language` (default "en").
   Returns per keyword: `search_volume`, `cpc`, `competition` (+ monthly trend if
   the API returns it cheaply). One API call per ≤500-keyword chunk.

2. **`kw_serp`** — live top-10 organic for one keyword.
   Args: `keyword` (required), `location`, `language`.
   Returns: ordered `[{ position, domain, title, url }]` for organic items, plus
   `ads: boolean` (any paid items present — the commercial-intent signal).

3. **`kw_suggest`** — recursive Google-suggest mine. Free, no creds.
   Args: `seed` (required), `gl` (default "us"), `hl` (default "en"),
   `depth` (default 2, max 3).
   Mechanics: `https://suggestqueries.google.com/complete/search?client=firefox&q=<term>&gl=<gl>&hl=<hl>`
   returns `[query, [suggestions]]`. Expand: seed itself, then `seed + " a"…" z"`;
   recurse on new finds to `depth`; dedupe; throttle ~150ms between requests.
   Returns the sorted unique suggestion list + count.

4. **`kw_radar`** — the sweep. Args: `slug` (required — names the cluster file),
   `location` (optional — default: every code in the file's `locations`).
   - Reads `~/.oqva-marketing-mcp/radar/<slug>.json` (i.e. `CONFIG_DIR/radar/`):
     ```json
     {
       "clusters": { "category": ["example software", "best example software"] },
       "watchlist": ["ai example for nichename"],
       "locations": [2840, 2826]
     }
     ```
     Tolerate and preserve unknown extra keys — real files carry notes/parked
     lists. Tracked terms = union of all `clusters` values; watchlist terms are
     swept for suggest presence and volume too.
   - For every term × location: volume (batched), top-10 SERP, and a
     suggest-presence probe (does the term itself appear when its first words are
     queried — a boolean, not a full mine).
   - Writes snapshot `CONFIG_DIR/radar/<slug>/<YYYY-MM-DD>.json` (mkdir -p; the
     date from the machine clock; one file per run day, overwrite on re-run).
   - Diffs against the **most recent prior snapshot** and returns ONLY deltas:
     - watchlist crossings — first suggest appearance or first nonzero volume
       (report these loudly: they're the whole point of the watchlist);
     - new suggest appearances / disappearances on tracked terms;
     - volume shifts > 20% (report old → new absolute numbers);
     - SERP top-10 entrants, dropouts, and movers of ≥ 3 positions (by domain).
   - First run (no prior snapshot): return `{ baseline: true, counts… }`, no deltas.
   - Never delete old snapshots — the history is the product.

Business cluster files and snapshots are per-user DATA in `CONFIG_DIR` — they never
enter this repo, and no example in code or docs may use a real business's terms.

## Verification bar

- `npm run build` green (tsc is the type gate — there is no separate typecheck
  script; do not add one).
- `kw_suggest` proven live (free): a generic seed returns a plausible, deduped list.
- With `DATAFORSEO_*` creds present: one real `kw_radar` sweep against a seeded
  cluster file; sanity-check volumes (a category head term ≈ thousands, a
  watchlist-style invented term ≈ 0); run it twice to prove the diff path
  (second run should report near-zero deltas + no watchlist noise).
- If creds are absent at build time: build everything, verify suggest live, and
  say plainly in your report that volume/SERP/radar remain unverified pending
  creds — do not fake or stub the verification.
- README `## Tools` table gains four rows (business-agnostic wording, match the
  table's voice); the env keys get documented wherever the other optional keys
  live (README/SETUP.md — follow the existing placement).

## Out of scope (decided — don't re-open, don't build)

- No backlink index, no clickstream/traffic estimates, no dashboard UI.
- No Ahrefs/Semrush or any subscription.
- No cron/scheduler — the weekly sweep is an agent session's job, not this server's.
- No setup-wizard integration for the new keys (plain env keys are enough).

## Git

Commit in this repo's voice (narrative one-liners — see `git log`), push in the
same turn. Never commit: this brief, cluster files, snapshots, or anything naming
a real business or its keywords.
