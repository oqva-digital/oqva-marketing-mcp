# OQVA Marketing MCP

Connect Claude to your marketing data. This [MCP](https://modelcontextprotocol.io) server lets
Claude read and manage your Google and Meta accounts directly:

- **Google Search Console** — search analytics, sitemaps, URL inspection
- **Google Analytics 4** — reports, realtime, and configuration
- **Meta (Facebook & Instagram)** — Page insights and Ads
- **Google Tag Manager** — tags, triggers, variables, publishing
- **Google Business Profile** — locations, performance, reviews *(needs Google approval)*

## Install

**macOS / Linux** — paste this into a terminal:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/oqva-digital/oqva-marketing-mcp/main/install.sh)"
```

**Windows** — download `oqva-marketing-mcp-Windows-x86_64.exe` from the
[latest release](https://github.com/oqva-digital/oqva-marketing-mcp/releases/latest) and run:

```
oqva-marketing-mcp-Windows-x86_64.exe setup
```

Installing runs a guided setup that connects your accounts, checks each one, and adds the tool
to Claude. Restart Claude when it finishes.

## Setup

`setup` walks you through each account and verifies it as you go:

- **Google** — you create a free Google Cloud OAuth client; setup opens your browser to sign in
  and stores the access for you. One sign-in covers Search Console, Analytics, Tag Manager, and
  Business Profile.
- **Meta** — you paste a Business Manager access token; setup finds your Page and ad account for
  you.

Step-by-step credential guide: **[SETUP.md](SETUP.md)**. Everything you enter is stored only on
your own computer, at `~/.oqva-marketing-mcp/.env`.

## Commands

```
oqva-marketing-mcp setup     guided setup — connect accounts, register with Claude (run anytime)
oqva-marketing-mcp doctor    check every connection
oqva-marketing-mcp auth      re-do the Google sign-in
```

## Tools

| Tool | What it does |
|------|--------------|
| `config_status` | Which sources are configured (no secrets shown). Call first if something says "not configured". |
| `gsc_list_sites` | Properties the OAuth account can read (confirms access + exact `siteUrl`). |
| `gsc_query` | **Search Analytics** — clicks/impressions/CTR/position by query/page/country/device/date. Live + filterable. |
| `gsc_list_sitemaps` | Submitted sitemaps + status. |
| `gsc_inspect_url` | Index/coverage/canonical for one URL. |
| `ga4_run_report` | GA4 Data API: sessions/users/conversions/events by any dimensions, any date range. |
| `ga4_realtime` | Active users in the last 30 min. |
| `gbp_list_accounts` / `gbp_list_locations` | Business Profile accounts + locations. *(needs GBP API approval)* |
| `gbp_performance` | Daily impressions/calls/website-clicks/directions for a location. *(needs approval)* |
| `gbp_list_reviews` | Reviews (rating, text, reply). *(needs approval)* |
| `gbp_reply_review` | **[write]** Reply to a review. *(needs approval)* |
| `meta_graph` | **[write-capable]** Raw Meta Graph/Marketing API call — GET / POST / DELETE escape hatch. |
| `meta_page_insights` | Facebook Page insights. |
| `meta_ad_insights` | Ad-account insights (only if you run Meta ads). |
| `meta_list_ad_accounts` · `meta_list_businesses` · `meta_list_pages` | Enumerate Meta assets (ads audit). |
| `meta_list_campaigns` · `meta_list_custom_audiences` · `meta_list_pixels` | List campaigns / audiences / pixels on an ad account. |
| `meta_update_campaign` | **[write]** pause / archive / activate a campaign. |
| `meta_delete_custom_audience` | **[write]** delete a custom audience. |
| `ga4_account_summaries` | List your GA4 accounts/properties + their **numeric** ids. |
| `ga4_list_key_events` · `ga4_create_key_event` | **[write]** read / create Key events (conversions). |
| `ga4_list_custom_dimensions` · `ga4_create_custom_dimension` | **[write]** read / create custom dimensions. |
| `ga4_list_data_streams` | List data streams (+ measurement ids). |
| `ga4_admin` | **[write]** GA4 Admin API escape hatch (audiences, property/stream edits). |
| `gsc_submit_sitemap` · `gsc_delete_sitemap` · `gsc_add_site` | **[write]** manage sitemaps + properties. |
| `gsc_request_indexing` | **[write]** request a recrawl (Indexing API). |
| `gtm` | **[write + publish]** Google Tag Manager API escape hatch (tags/triggers/variables → version → publish). |

## Security

- Credentials live only at `~/.oqva-marketing-mcp/.env` on your machine, and go only to Google and Meta.
- Write tools are tagged `[WRITE]`; Claude confirms before anything destructive or public (a review reply, a Tag Manager publish).

## Build from source

One TypeScript file, no runtime dependencies. To run it from source instead of the binary:

```bash
npm install        # TypeScript toolchain only
npm run setup      # build, then guided setup
npm run doctor     # check connections
npm start          # run as the MCP server
```

Release binaries are built with [Bun](https://bun.sh):

```bash
./build.sh         # compiles the macOS/Linux/Windows binaries into dist/
```

Create a GitHub release and upload the five files; `install.sh` downloads them by name.

## License

[Apache-2.0](LICENSE) © OQVA.
