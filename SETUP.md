# Wiring guide — oqva-marketing-mcp

> **Most people don't need this guide.** Run the installer (see [README](README.md)) and the
> `setup` wizard walks you through everything below, opens the browser for you, validates each
> connection, and registers the tool with Claude. This document is the detailed reference for
> the parts you do in the Google Cloud and Meta consoles — read it if a step is unclear or you
> prefer to configure things by hand.

Follow top to bottom. **Google auth is OAuth** — one client + one refresh token covers **GSC + GA4 + GBP + GTM**. **Meta** uses its own token (Phase 3). GBP needs a Google approval (Phase 4) you start now but don't wait on.

Secrets are stored only on your machine — the `setup` wizard saves them to `~/.oqva-marketing-mcp/.env`; if you configure by hand, the same file (or a local `./.env`) works. Never paste them in chat or commit them.

---

## Phase 0 — what you need
Admin/owner access to: **Search Console** (the property), **GA4** (the property), a **Google Cloud** account (free), a **Meta Business Manager** with your Page + ad account (Phase 3), and — for GBP — the Google account that **manages the Business Profile**.

---

## Phase 1 — Google Cloud project + APIs
1. [console.cloud.google.com](https://console.cloud.google.com) → create/pick a project (e.g. `oqva-marketing`). Note the **Project number** (Dashboard) — needed for GBP.
2. *APIs & Services → Library* → **Enable** these five: **Google Search Console API**, **Google Analytics Data API**, **Google Analytics Admin API** (manage GA4 config), **Web Search Indexing API** (request recrawls), and **Tag Manager API** (manage GTM tags). (Business Profile APIs come later, Phase 4.)

---

## Phase 2 — Google OAuth (covers GSC + GA4 + GBP)
The app acts as **your own Google account** (which already has access to your properties), so there's no "grant a user" step — and it sidesteps the current Google bug that blocks service accounts on GSC/GA4.

a. **Consent screen** — *APIs & Services → OAuth consent screen* → **External** → app name + your email → add these **nine** scopes (read **and** manage) → add yourself as a **test user** → then set **Publishing status → In production**.
   ```
   https://www.googleapis.com/auth/webmasters
   https://www.googleapis.com/auth/analytics.readonly
   https://www.googleapis.com/auth/analytics.edit
   https://www.googleapis.com/auth/business.manage
   https://www.googleapis.com/auth/indexing
   https://www.googleapis.com/auth/tagmanager.readonly
   https://www.googleapis.com/auth/tagmanager.edit.containers
   https://www.googleapis.com/auth/tagmanager.edit.containerversions
   https://www.googleapis.com/auth/tagmanager.publish
   ``` ⚠️ If you leave it "Testing", refresh tokens **expire after 7 days**; "In production" (click past the "unverified app" warning — fine for your own use) makes them durable.
b. **Client** — *Credentials → Create credentials → OAuth client ID* → type **Desktop app** → copy the **Client ID** + **Client secret** into `.env`:
   ```
   GOOGLE_OAUTH_CLIENT_ID=...
   GOOGLE_OAUTH_CLIENT_SECRET=...
   ```
c. **Authorize once** — `npm install && npm run build`, then:
   ```
   npm run auth
   ```
   → open the printed URL → sign in as the account that manages GSC/GA4 → approve → it prints `GOOGLE_OAUTH_REFRESH_TOKEN=…` → paste that into `.env`.
d. **Property identifiers** in `.env` — **optional defaults.** The MCP manages **multiple** GA4 properties + apps and Search Console properties; you don't pin one:
   - Leave both blank → Claude enumerates everything via `ga4_account_summaries` / `gsc_list_sites` and targets any by passing `propertyId` / `siteUrl` per call. No need to hunt for a numeric id.
   - OR set a convenience default for your most-used one: `GSC_SITE_URL=https://example.com/` (or `sc-domain:…`) and `GA4_PROPERTY_ID=` the **numeric** id (*not* `G-XXXXXXXXXX`).

---

## Phase 3 — Meta (Page + Ads: read AND manage)
Different platform, its own token. Needed for the Meta audit + any tidy/management.

1. **IDs** — Page ID ([Business Suite](https://business.facebook.com) → Settings → your Page); ad account `act_<number>` (Ads Manager).
2. **System User token** — [Business Settings](https://business.facebook.com/settings) → **Users → System Users** → **Add** an **Admin** system user → **Assign assets** (your Page + ad account, toggle **Full control**) → **Generate new token** → pick a Meta App (create a free one at developers.facebook.com and add the **Marketing API** product if needed) → expiry **Never** → tick scopes:
   - read: `read_insights`, `pages_read_engagement`, `ads_read`, `pages_show_list`
   - manage: **`ads_management`**, **`business_management`**, **`pages_manage_metadata`** (+ `pages_manage_posts` only if you want Claude publishing posts)
   → **Generate** → copy. A system-user token is **long-lived** (unlike a Graph Explorer token that dies in hours).
3. `.env`: `META_ACCESS_TOKEN`, `META_PAGE_ID`, `META_AD_ACCOUNT_ID`.

> ⚠️ **App Review caveat:** managing your *own* business's assets as its admin works with the Marketing API's **Standard Access** (lower rate limits). Broad/advanced use, or acting on assets you don't own, needs Meta **App Review**. Anything that needs more fails with a clear permission error — never a silent no-op.

---

## TikTok (Ads) — optional
Its own platform and token; independent of Google and Meta. Skip if you don't run TikTok ads.

1. **Developer app** — go to [TikTok for Business / Marketing API](https://business-api.tiktok.com), register as a developer, and create an app with the **Marketing API** product. Add the scopes you need (**Ad Account Management**, **Reporting**, and **Ads Management** if you want Claude to pause/enable campaigns).
2. **Authorize + token** — complete the app's OAuth flow once for your ad account; TikTok returns a **long-lived Access Token** (it doesn't expire like Meta's Graph Explorer tokens, but can be revoked). Copy it.
3. **Advertiser ID** — the numeric id shown in [TikTok Ads Manager](https://ads.tiktok.com) (or list them with `tiktok_list_advertisers` once App ID + Secret are set).
4. `.env` (or run `setup` and paste when asked):
   - `TIKTOK_ACCESS_TOKEN` — required. Sent in the `Access-Token` header.
   - `TIKTOK_ADVERTISER_ID` — the default advertiser (or pass `advertiserId` per call).
   - `TIKTOK_APP_ID` + `TIKTOK_APP_SECRET` — optional, only to auto-discover advertiser ids (`tiktok_list_advertisers` / `oauth2/advertiser/get`).

> The reporting tool (`tiktok_ad_insights`) hits `report/integrated/get` synchronously; video metrics like `video_views_p25/p50/p75/p100` and `average_video_play` are available in the `metrics` list.

---

## Phase 4 — GBP API (slow approval — apply today)
GBP works through the **same OAuth token** (the `business.manage` scope) — but Google must approve API access first (~1–3 weeks). Runs in the background; nothing else waits on it.

1. Same project → *APIs & Services → Library* → enable the **Business Profile** / "My Business" APIs.
2. Submit the **Application for Basic API Access** (linked from [Prerequisites](https://developers.google.com/my-business/content/prereqs)) — project number + the Google account that manages the profile + use case. *(Ask Claude to draft the use-case text.)* Don't submit a quota-increase form.
3. Check *APIs & Services → Quotas*: **0 QPM = pending, 300 QPM = approved** ([limits](https://developers.google.com/my-business/content/limits)).
4. After approval: set `GBP_ACCOUNT_ID` in `.env` (run `gbp_list_accounts` to get it, format `accounts/123`). The OAuth account must be a **manager** on the profile — which it is, if it's yours.
   - The **reviews** (legacy v4) API is the most tightly gated of the set.

> Meanwhile: do reviews + profile optimisation in the free GBP app now — no API needed.

---

## Phase 5 — register with Claude
```bash
claude mcp add oqva-marketing -- node /path/to/oqva-marketing-mcp/dist/index.js
```
The server reads its own `.env` — **no secrets in the MCP config.** Reconnect / restart Claude so the tools load. (No rebuild needed after editing `.env`.)

---

## Phase 6 — verify
1. `config_status` → `credentialsConfigured: true` + your `gscSiteUrl` / `ga4PropertyId`.
2. `gsc_list_sites` → confirms the OAuth account's access + the exact `siteUrl`.
3. `gsc_query { startDate:"2026-03-01", endDate:"2026-05-30", dimensions:["query"], rowLimit:25 }`.
4. `ga4_run_report { startDate:"30daysAgo", endDate:"today", metrics:["sessions","conversions"], dimensions:["sessionDefaultChannelGroup"] }`.

---

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `Google not configured` | OAuth not set — run `npm run auth` (needs `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` in `.env` first). |
| `npm run auth`: no `refresh_token` returned | You'd authorized before — revoke at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and re-run (we send `prompt=consent`). |
| Token refresh fails after a week | Consent screen still in "Testing" → 7-day expiry. Set it to **In production** and re-run `npm run auth`. |
| GSC `403` | The OAuth account doesn't have access to that property, or wrong `GSC_SITE_URL` form. Run `gsc_list_sites`. |
| GA4 `PERMISSION_DENIED` / empty | OAuth account lacks property access, or you used the `G-…` measurement id instead of the **numeric** Property ID. |
| Meta `400 / Unsupported get request` | Token missing a scope, or the Page/ad account isn't assigned to the system user. |
| GBP `403` / quota `0` | Business Profile API access not yet approved (Phase 4). |
