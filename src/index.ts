#!/usr/bin/env node
/**
 * oqva-marketing-mcp  —  zero runtime dependencies.
 * ------------------------------------------------------
 * A Model Context Protocol server giving Claude direct read + management access
 * to your marketing data, straight from the source APIs — no SDK,
 * no third-party middleman, only Node built-ins:
 *   • Google Search Console   (search analytics, sitemaps, URL inspection)
 *   • Google Analytics 4      (Data API: reports + realtime)
 *   • Google Business Profile (locations, performance, reviews)   [needs API allowlist]
 *   • Meta / Facebook         (Graph API: page + ad insights, raw escape hatch)
 *
 * How it stays dependency-free:
 *   - MCP transport = newline-delimited JSON-RPC 2.0 over stdio, hand-rolled below.
 *   - Google auth = OAuth user token (refresh-token → access-token exchange; no google-auth-library).
 *   - Tool schemas = plain JSON Schema literals (no zod).
 *   - .env = parsed with node:fs (no dotenv).
 *
 * One fat file on purpose (project convention). Credentials come from env / a
 * local .env (see .env.example) — never hard-coded, never committed. Nothing is
 * required to *start*; each tool reports clearly when its source isn't configured.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

// ─────────────────────────── .env (tiny vanilla parser) ───────────────────────────
function loadEnv(path: string): void {
  let txt: string;
  try {
    txt = readFileSync(path, "utf8");
  } catch {
    return; // no .env at this path — fine
  }
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue; // skips blanks + comments (# / non-KEY lines)
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
function selfFile(): string {
  try { return fileURLToPath(import.meta.url); } catch { return ""; }
}
const SELF = selfFile();
// Bun standalone executables expose import.meta.url under a virtual "$bunfs" root (and
// existsSync() on it returns true), so detect that marker rather than trusting the path.
const COMPILED = !SELF || SELF.includes("$bunfs") || SELF.includes("~BUN") || !existsSync(SELF);
const HERE = COMPILED ? dirname(process.execPath) : dirname(SELF);

// Config is stored per-user so a compiled binary (which can't reliably write next to
// itself) has a stable home. `setup` writes here; the server + `doctor` read it back.
const CONFIG_DIR = resolve(homedir(), ".oqva-marketing-mcp");
const CONFIG_ENV = resolve(CONFIG_DIR, ".env");
loadEnv(resolve(process.cwd(), ".env")); // 1) a local ./.env (dev / per-project override)
loadEnv(CONFIG_ENV); //                      2) the per-user store that `setup` writes
loadEnv(resolve(HERE, "../.env")); //        3) the source tree (next to dist/), for development

// ─────────────────────────── config (mutable: `setup` rewrites these at runtime) ───────────────────────────
let GSC_SITE_URL = process.env.GSC_SITE_URL ?? "";
let GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID ?? "";
let GBP_ACCOUNT_ID = process.env.GBP_ACCOUNT_ID ?? "";
// Google auth = OAuth (user-delegated). One client + refresh token covers GSC + GA4
// + GBP. Set up once via `setup` (or `auth`). Chosen over a service account: the SA
// route is bugged for GSC/GA4 (Google-side, 2026-04) and SA-for-GBP is unreliable.
let OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
let OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";
let OAUTH_REFRESH_TOKEN = process.env.GOOGLE_OAUTH_REFRESH_TOKEN ?? "";
let META_TOKEN = process.env.META_ACCESS_TOKEN ?? "";
let META_AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID ?? "";
let META_PAGE_ID = process.env.META_PAGE_ID ?? "";
let META_API_VER = process.env.META_API_VERSION ?? "v22.0";
/** Re-read every config value from process.env — called after `setup` writes new ones. */
function reloadConfig(): void {
  GSC_SITE_URL = process.env.GSC_SITE_URL ?? "";
  GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID ?? "";
  GBP_ACCOUNT_ID = process.env.GBP_ACCOUNT_ID ?? "";
  OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
  OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";
  OAUTH_REFRESH_TOKEN = process.env.GOOGLE_OAUTH_REFRESH_TOKEN ?? "";
  META_TOKEN = process.env.META_ACCESS_TOKEN ?? "";
  META_AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID ?? "";
  META_PAGE_ID = process.env.META_PAGE_ID ?? "";
  META_API_VER = process.env.META_API_VERSION ?? "v22.0";
}

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/webmasters", // GSC: read + manage sitemaps/sites
  "https://www.googleapis.com/auth/analytics.readonly", // GA4 Data API (reports)
  "https://www.googleapis.com/auth/analytics.edit", // GA4 Admin API (manage config)
  "https://www.googleapis.com/auth/business.manage", // Google Business Profile (read + write)
  "https://www.googleapis.com/auth/indexing", // Indexing API (request recrawl)
  "https://www.googleapis.com/auth/tagmanager.readonly", // GTM: read containers/tags/triggers
  "https://www.googleapis.com/auth/tagmanager.edit.containers", // GTM: create/edit tags/triggers/variables (in a workspace)
  "https://www.googleapis.com/auth/tagmanager.edit.containerversions", // GTM: create/manage container VERSIONS (create_version) — edit.containers explicitly EXCLUDES versioning
  "https://www.googleapis.com/auth/tagmanager.publish", // GTM: publish a container version live
].join(" ");

// ─────────────────────────── Google auth (RS256 JWT → token, cached) ───────────────────────────
function googleConfigured(): boolean {
  return !!(OAUTH_REFRESH_TOKEN && OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET);
}
let _tok: { token: string; exp: number } | null = null;
/** Exchange the stored OAuth refresh token for a short-lived access token (cached). */
async function googleToken(): Promise<string> {
  if (!googleConfigured()) {
    throw new Error("Google not configured — run `npm run auth` to set up OAuth (needs GOOGLE_OAUTH_CLIENT_ID/SECRET in .env). See SETUP.md.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (_tok && _tok.exp - 60 > now) return _tok.token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: OAUTH_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!r.ok || !data.access_token) {
    throw new Error(`Google OAuth token refresh failed (${r.status}): ${JSON.stringify(data)}. If the token was revoked/expired, re-run \`npm run auth\`.`);
  }
  _tok = { token: data.access_token, exp: now + (data.expires_in ?? 3600) };
  return _tok.token;
}

// ─────────────────────────── REST helpers ───────────────────────────
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
async function gfetch(url: string, init: FetchInit = {}): Promise<unknown> {
  const token = await googleToken();
  const r = await fetch(url, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: init.body,
  });
  const text = await r.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  if (!r.ok) {
    throw new Error(`Google API ${r.status} ${r.statusText}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}
async function mfetch(path: string, params: Record<string, string | number | undefined> = {}, method: string = "GET"): Promise<unknown> {
  if (!META_TOKEN) throw new Error("Meta not configured — set META_ACCESS_TOKEN. See README.");
  const u = new URL(`https://graph.facebook.com/${META_API_VER}/${path.replace(/^\//, "")}`);
  const init: { method: string; body?: URLSearchParams; headers?: Record<string, string> } = { method };
  if (method === "POST") {
    const form = new URLSearchParams(); // writes: params go in the body
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") form.set(k, String(v));
    form.set("access_token", META_TOKEN);
    init.body = form;
    init.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  } else {
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
    u.searchParams.set("access_token", META_TOKEN);
  }
  const r = await fetch(u, init);
  const body = (await r.json().catch(() => ({}))) as unknown;
  if (!r.ok) throw new Error(`Meta Graph API ${r.status} (${method}): ${JSON.stringify(body)}`);
  return body;
}

// ─────────────────────────── tool registry + result helpers ───────────────────────────
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type Args = Record<string, any>;
type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; handler: (a: Args) => Promise<ToolResult> };
const TOOLS: Tool[] = [];

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (msg: string): ToolResult => ({ content: [{ type: "text", text: `ERROR: ${msg}` }], isError: true });

/** Register a tool whose handler just returns data (or throws) — errors become isError text. */
function tool(name: string, description: string, inputSchema: Record<string, unknown>, run: (a: Args) => Promise<unknown>): void {
  TOOLS.push({
    name,
    description,
    inputSchema,
    handler: async (a) => {
      try {
        return ok(await run(a));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  });
}
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = (description?: string) => (description ? { type: "string", description } : { type: "string" });
const enm = (values: string[], description?: string) => ({ type: "string", enum: values, ...(description ? { description } : {}) });
const arr = (items: unknown, description?: string) => ({ type: "array", items, ...(description ? { description } : {}) });

// ───────── status ─────────
tool("config_status", "Report which marketing data sources are configured (no secrets revealed). Call first if a tool says 'not configured'.", obj({}), async () => ({
  google: { credentialsConfigured: googleConfigured(), gscSiteUrl: GSC_SITE_URL || null, ga4PropertyId: GA4_PROPERTY_ID || null, gbpAccountId: GBP_ACCOUNT_ID || null },
  meta: { tokenSet: !!META_TOKEN, adAccountId: META_AD_ACCOUNT || null, pageId: META_PAGE_ID || null, apiVersion: META_API_VER },
}));

// ───────── Google Search Console ─────────
tool("gsc_list_sites", "List Search Console properties the service account can access (confirm the SA is granted + the exact siteUrl).", obj({}), () =>
  gfetch("https://searchconsole.googleapis.com/webmasters/v3/sites")
);

tool(
  "gsc_query",
  "Search Console Search Analytics — clicks / impressions / CTR / position grouped by dimension(s). The core SEO tool (same data as the GSC Performance export, but live + filterable).",
  obj(
    {
      startDate: str("YYYY-MM-DD"),
      endDate: str("YYYY-MM-DD"),
      dimensions: arr(enm(["query", "page", "country", "device", "date", "searchAppearance"]), "Group by these; omit for site totals."),
      siteUrl: str("Defaults to GSC_SITE_URL. URL-prefix (trailing slash) or sc-domain: form."),
      rowLimit: { type: "integer", description: "Default 1000 (max 25000)." },
      searchType: enm(["web", "image", "video", "news", "discover", "googleNews"]),
      filterDimension: enm(["query", "page", "country", "device"], "Optional single filter."),
      filterOperator: enm(["equals", "contains", "notContains", "includingRegex", "excludingRegex"]),
      filterExpression: str(),
    },
    ["startDate", "endDate"]
  ),
  (a) => {
    const site = a.siteUrl || GSC_SITE_URL;
    if (!site) throw new Error("No siteUrl provided and GSC_SITE_URL not set.");
    const body: Record<string, unknown> = {
      startDate: a.startDate,
      endDate: a.endDate,
      dimensions: a.dimensions ?? [],
      rowLimit: a.rowLimit ?? 1000,
    };
    if (a.searchType) body.type = a.searchType;
    if (a.filterDimension && a.filterExpression) {
      body.dimensionFilterGroups = [
        { filters: [{ dimension: a.filterDimension, operator: a.filterOperator ?? "equals", expression: a.filterExpression }] },
      ];
    }
    return gfetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
      { method: "POST", body: JSON.stringify(body) }
    );
  }
);

tool("gsc_list_sitemaps", "List submitted sitemaps + processing status for a property.", obj({ siteUrl: str() }), (a) => {
  const site = a.siteUrl || GSC_SITE_URL;
  if (!site) throw new Error("No siteUrl and GSC_SITE_URL not set.");
  return gfetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps`);
});

tool(
  "gsc_inspect_url",
  "URL Inspection — index/coverage status, last crawl, canonical, mobile usability for one URL.",
  obj({ inspectionUrl: str("Full URL to inspect."), siteUrl: str() }, ["inspectionUrl"]),
  (a) => {
    const site = a.siteUrl || GSC_SITE_URL;
    if (!site) throw new Error("No siteUrl and GSC_SITE_URL not set.");
    return gfetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      body: JSON.stringify({ inspectionUrl: a.inspectionUrl, siteUrl: site }),
    });
  }
);

// ───────── GA4 (Data API) ─────────
tool(
  "ga4_run_report",
  "GA4 Data API runReport — sessions, users, conversions, events, channels. Flexible dimensions + metrics over a date range.",
  obj(
    {
      startDate: str("YYYY-MM-DD, or 'NdaysAgo' / 'today' / 'yesterday'."),
      endDate: str(),
      metrics: arr(str(), "e.g. ['sessions','activeUsers','conversions','eventCount']."),
      dimensions: arr(str(), "e.g. ['date','sessionDefaultChannelGroup','deviceCategory','eventName']."),
      propertyId: str("Numeric GA4 property id; defaults to GA4_PROPERTY_ID (NOT the G-XXXX measurement id)."),
      limit: { type: "integer" },
      dimensionFilter: str("Dimension name to filter on (exact match)."),
      dimensionFilterValue: str(),
    },
    ["startDate", "endDate", "metrics"]
  ),
  (a) => {
    const pid = a.propertyId || GA4_PROPERTY_ID;
    if (!pid) throw new Error("No propertyId and GA4_PROPERTY_ID not set (numeric property id, not the G-XXXX measurement id).");
    const req: Record<string, unknown> = {
      dateRanges: [{ startDate: a.startDate, endDate: a.endDate }],
      metrics: (a.metrics ?? []).map((name: string) => ({ name })),
      dimensions: (a.dimensions ?? []).map((name: string) => ({ name })),
    };
    if (a.limit) req.limit = a.limit;
    if (a.dimensionFilter && a.dimensionFilterValue) {
      req.dimensionFilter = { filter: { fieldName: a.dimensionFilter, stringFilter: { value: a.dimensionFilterValue } } };
    }
    return gfetch(`https://analyticsdata.googleapis.com/v1beta/properties/${pid}:runReport`, { method: "POST", body: JSON.stringify(req) });
  }
);

tool(
  "ga4_realtime",
  "GA4 realtime report (active users in the last 30 min).",
  obj({ propertyId: str(), metrics: arr(str(), "Default ['activeUsers']."), dimensions: arr(str()) }),
  (a) => {
    const pid = a.propertyId || GA4_PROPERTY_ID;
    if (!pid) throw new Error("No propertyId and GA4_PROPERTY_ID not set.");
    const req = {
      metrics: (a.metrics ?? ["activeUsers"]).map((name: string) => ({ name })),
      dimensions: (a.dimensions ?? []).map((name: string) => ({ name })),
    };
    return gfetch(`https://analyticsdata.googleapis.com/v1beta/properties/${pid}:runRealtimeReport`, { method: "POST", body: JSON.stringify(req) });
  }
);

// ───────── Google Business Profile (needs API allowlist approval) ─────────
tool("gbp_list_accounts", "[GBP] List Business Profile accounts. NOTE: the Business Profile APIs require Google to approve API access (allowlist) first.", obj({}), () =>
  gfetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts")
);

tool("gbp_list_locations", "[GBP] List locations for an account (name, title, address, website, categories).", obj({ account: str("accounts/123; defaults to GBP_ACCOUNT_ID.") }), (a) => {
  const acc = a.account || GBP_ACCOUNT_ID;
  if (!acc) throw new Error("No account and GBP_ACCOUNT_ID not set.");
  return gfetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${acc}/locations?readMask=name,title,storefrontAddress,websiteUri,phoneNumbers,categories,metadata`);
});

tool(
  "gbp_performance",
  "[GBP] Daily performance time series for a location: impressions (maps/search × desktop/mobile), call clicks, website clicks, direction requests, conversations, bookings.",
  obj(
    {
      location: str("locations/123"),
      metric: enm([
        "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
        "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
        "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
        "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
        "CALL_CLICKS",
        "WEBSITE_CLICKS",
        "BUSINESS_DIRECTION_REQUESTS",
        "BUSINESS_CONVERSATIONS",
        "BUSINESS_BOOKINGS",
      ]),
      startDate: str("YYYY-MM-DD"),
      endDate: str("YYYY-MM-DD"),
    },
    ["location", "metric", "startDate", "endDate"]
  ),
  (a) => {
    const [sy, sm, sd] = a.startDate.split("-");
    const [ey, em, ed] = a.endDate.split("-");
    const qs = new URLSearchParams({
      dailyMetric: a.metric,
      "dailyRange.start_date.year": sy,
      "dailyRange.start_date.month": String(+sm),
      "dailyRange.start_date.day": String(+sd),
      "dailyRange.end_date.year": ey,
      "dailyRange.end_date.month": String(+em),
      "dailyRange.end_date.day": String(+ed),
    });
    return gfetch(`https://businessprofileperformance.googleapis.com/v1/${a.location}:getDailyMetricsTimeSeries?${qs.toString()}`);
  }
);

tool("gbp_list_reviews", "[GBP] List reviews for a location (rating, comment, reviewer, time, any reply).", obj({ location: str("Full path, e.g. accounts/123/locations/456 (v4 reviews API).") }, ["location"]), (a) =>
  gfetch(`https://mybusiness.googleapis.com/v4/${a.location}/reviews`)
);

tool(
  "gbp_reply_review",
  "[GBP][WRITE] Post (or update) the business reply to a review.",
  obj({ location: str("accounts/123/locations/456"), reviewId: str(), comment: str("The reply text.") }, ["location", "reviewId", "comment"]),
  (a) =>
    gfetch(`https://mybusiness.googleapis.com/v4/${a.location}/reviews/${a.reviewId}/reply`, { method: "PUT", body: JSON.stringify({ comment: a.comment }) })
);

// ───────── Meta / Facebook (Graph API) ─────────
tool(
  "meta_graph",
  "Meta Graph / Marketing API call — flexible escape hatch, READ and WRITE. method defaults GET; POST to create/update (e.g. path='<campaignId>', params={status:'PAUSED'}), DELETE to remove. Does anything the token's scopes allow.",
  obj({ path: str("Graph path, e.g. 'me/adaccounts' or '<campaignId>'."), method: enm(["GET", "POST", "DELETE"]), params: { type: "object", additionalProperties: { type: "string" }, description: "Fields/params for reads; values for writes." } }, ["path"]),
  (a) => mfetch(a.path, a.params ?? {}, a.method ?? "GET")
);

tool(
  "meta_page_insights",
  "[Meta] Facebook Page insights (impressions, engagement, fans, etc.).",
  obj(
    {
      metric: str("Comma-separated, e.g. 'page_impressions,page_post_engagements,page_fan_adds'."),
      pageId: str("Defaults to META_PAGE_ID."),
      period: enm(["day", "week", "days_28"]),
      since: str("YYYY-MM-DD"),
      until: str("YYYY-MM-DD"),
    },
    ["metric"]
  ),
  (a) => {
    const pid = a.pageId || META_PAGE_ID;
    if (!pid) throw new Error("No pageId and META_PAGE_ID not set.");
    return mfetch(`${pid}/insights`, { metric: a.metric, period: a.period ?? "day", since: a.since, until: a.until });
  }
);

tool(
  "meta_ad_insights",
  "[Meta] Ad account insights (impressions, clicks, spend, actions, CPC, CTR). Only returns data if you actually run Meta ads.",
  obj({
    adAccountId: str("act_<id>; defaults to META_AD_ACCOUNT_ID."),
    fields: str("Default 'impressions,clicks,spend,actions,cpc,ctr'."),
    datePreset: str("e.g. 'last_30d','last_7d','this_month'. Default last_30d."),
    level: enm(["account", "campaign", "adset", "ad"]),
  }),
  (a) => {
    const acc = a.adAccountId || META_AD_ACCOUNT;
    if (!acc) throw new Error("No adAccountId and META_AD_ACCOUNT_ID not set.");
    return mfetch(`${acc}/insights`, {
      fields: a.fields ?? "impressions,clicks,spend,actions,cpc,ctr",
      date_preset: a.datePreset ?? "last_30d",
      level: a.level ?? "account",
    });
  }
);

// ───────── Meta — MANAGE (audit + tidy: ad accounts, campaigns, audiences, pixels, pages) ─────────
tool("meta_list_ad_accounts", "[Meta] List ad accounts the token can access (id, name, status, spend, currency, business). NOTE: amount_spent is in the currency's MINOR unit (cents/pence) — divide by 100 for the real figure. (A SYSTEM-USER token returns [] here — use meta_graph on '<businessId>/owned_ad_accounts' instead.) Start of an ads audit.", obj({}), () =>
  mfetch("me/adaccounts", { fields: "id,name,account_status,amount_spent,currency,business", limit: 200 })
);
tool("meta_list_businesses", "[Meta] List Business Manager businesses the token can access.", obj({}), () =>
  mfetch("me/businesses", { fields: "id,name,verification_status", limit: 100 })
);
tool("meta_list_pages", "[Meta] List Facebook Pages the token manages (id, name, category, fans).", obj({}), () =>
  mfetch("me/accounts", { fields: "id,name,category,fan_count,tasks", limit: 100 })
);
tool(
  "meta_list_campaigns",
  "[Meta] List campaigns on an ad account (id, name, status, effective_status, objective, budget, dates). NOTE: daily_budget/lifetime_budget are in the currency's MINOR unit (cents/pence — ÷100). The core tool for finding dead/clutter campaigns.",
  obj({ adAccountId: str("act_<id>; defaults to META_AD_ACCOUNT_ID."), limit: { type: "integer", description: "Default 200." } }),
  (a) => {
    const acc = a.adAccountId || META_AD_ACCOUNT;
    if (!acc) throw new Error("No adAccountId and META_AD_ACCOUNT_ID not set.");
    return mfetch(`${acc}/campaigns`, { fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time,updated_time", limit: a.limit ?? 200 });
  }
);
tool(
  "meta_update_campaign",
  "[Meta][WRITE] Change a campaign's status — ACTIVE / PAUSED / ARCHIVED / DELETED. The tidy verb for dead campaigns (prefer ARCHIVED over DELETED — reversible).",
  obj({ campaignId: str(), status: enm(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"]) }, ["campaignId", "status"]),
  (a) => mfetch(a.campaignId, { status: a.status }, "POST")
);
tool(
  "meta_list_custom_audiences",
  "[Meta] List custom audiences on an ad account (id, name, size, subtype, status, dates).",
  obj({ adAccountId: str("act_<id>; defaults to META_AD_ACCOUNT_ID.") }),
  (a) => {
    const acc = a.adAccountId || META_AD_ACCOUNT;
    if (!acc) throw new Error("No adAccountId and META_AD_ACCOUNT_ID not set.");
    return mfetch(`${acc}/customaudiences`, { fields: "id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,operation_status,time_created,retention_days", limit: 200 });
  }
);
tool(
  "meta_delete_custom_audience",
  "[Meta][WRITE] Delete a custom audience (destructive — removed, not archived).",
  obj({ audienceId: str() }, ["audienceId"]),
  (a) => mfetch(a.audienceId, {}, "DELETE")
);
tool(
  "meta_list_pixels",
  "[Meta] List ad pixels / datasets on an ad account (id, name, last_fired_time) — spot stale/duplicate pixels.",
  obj({ adAccountId: str("act_<id>; defaults to META_AD_ACCOUNT_ID.") }),
  (a) => {
    const acc = a.adAccountId || META_AD_ACCOUNT;
    if (!acc) throw new Error("No adAccountId and META_AD_ACCOUNT_ID not set.");
    return mfetch(`${acc}/adspixels`, { fields: "id,name,last_fired_time,is_unavailable", limit: 100 });
  }
);

// ───────── GA4 Admin API (MANAGE config: key events, custom dimensions, streams, audiences) ─────────
tool(
  "ga4_account_summaries",
  "GA4 Admin: list the accounts + properties you can access, including each property's NUMERIC id — use this to discover GA4_PROPERTY_ID.",
  obj({}),
  () => gfetch("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200")
);
tool(
  "ga4_list_key_events",
  "GA4 Admin: list key events (conversions) on a property.",
  obj({ propertyId: str("numeric; defaults to GA4_PROPERTY_ID") }),
  (a) => {
    const pid = a.propertyId || GA4_PROPERTY_ID;
    if (!pid) throw new Error("No propertyId and GA4_PROPERTY_ID not set.");
    return gfetch(`https://analyticsadmin.googleapis.com/v1beta/properties/${pid}/keyEvents`);
  }
);
tool(
  "ga4_create_key_event",
  "GA4 Admin [WRITE]: mark an event name as a Key event (conversion). e.g. eventName='generate_lead'.",
  obj(
    { eventName: str("the GA4 event name"), propertyId: str(), countingMethod: enm(["ONCE_PER_EVENT", "ONCE_PER_SESSION"]) },
    ["eventName"]
  ),
  (a) => {
    const pid = a.propertyId || GA4_PROPERTY_ID;
    if (!pid) throw new Error("No propertyId and GA4_PROPERTY_ID not set.");
    return gfetch(`https://analyticsadmin.googleapis.com/v1beta/properties/${pid}/keyEvents`, {
      method: "POST",
      body: JSON.stringify({ eventName: a.eventName, countingMethod: a.countingMethod || "ONCE_PER_EVENT" }),
    });
  }
);
tool(
  "ga4_list_custom_dimensions",
  "GA4 Admin: list custom dimensions on a property.",
  obj({ propertyId: str() }),
  (a) => {
    const pid = a.propertyId || GA4_PROPERTY_ID;
    if (!pid) throw new Error("No propertyId and GA4_PROPERTY_ID not set.");
    return gfetch(`https://analyticsadmin.googleapis.com/v1beta/properties/${pid}/customDimensions`);
  }
);
tool(
  "ga4_create_custom_dimension",
  "GA4 Admin [WRITE]: register an event parameter as a custom dimension (e.g. surface a 'step' param as 'Booking Step').",
  obj(
    { parameterName: str("the event parameter name"), displayName: str("UI display name"), scope: enm(["EVENT", "USER", "ITEM"]), propertyId: str() },
    ["parameterName", "displayName"]
  ),
  (a) => {
    const pid = a.propertyId || GA4_PROPERTY_ID;
    if (!pid) throw new Error("No propertyId and GA4_PROPERTY_ID not set.");
    return gfetch(`https://analyticsadmin.googleapis.com/v1beta/properties/${pid}/customDimensions`, {
      method: "POST",
      body: JSON.stringify({ parameterName: a.parameterName, displayName: a.displayName, scope: a.scope || "EVENT" }),
    });
  }
);
tool(
  "ga4_list_data_streams",
  "GA4 Admin: list data streams (web/app) on a property — incl. the measurement id.",
  obj({ propertyId: str() }),
  (a) => {
    const pid = a.propertyId || GA4_PROPERTY_ID;
    if (!pid) throw new Error("No propertyId and GA4_PROPERTY_ID not set.");
    return gfetch(`https://analyticsadmin.googleapis.com/v1beta/properties/${pid}/dataStreams`);
  }
);
tool(
  "ga4_admin",
  "GA4 Admin API escape hatch — any method/path under analyticsadmin v1beta (audiences, property/stream updates, etc.). WRITES are real; PATCH usually needs a updateMask query.",
  obj(
    { method: enm(["GET", "POST", "PATCH", "DELETE"]), path: str("relative to .../v1beta/ — e.g. properties/123/audiences"), body: str("JSON string for POST/PATCH"), query: str("e.g. updateMask=displayName") },
    ["method", "path"]
  ),
  (a) =>
    gfetch(`https://analyticsadmin.googleapis.com/v1beta/${a.path.replace(/^\//, "")}${a.query ? `?${a.query}` : ""}`, {
      method: a.method,
      body: a.body,
    })
);

// ───────── Search Console — MANAGE (sitemaps, properties) + Indexing API (recrawl) ─────────
tool(
  "gsc_submit_sitemap",
  "GSC [WRITE]: submit / resubmit a sitemap.",
  obj({ feedpath: str("full sitemap URL, e.g. https://example.com/sitemap.xml"), siteUrl: str() }, ["feedpath"]),
  (a) => {
    const site = a.siteUrl || GSC_SITE_URL;
    if (!site) throw new Error("No siteUrl and GSC_SITE_URL not set.");
    return gfetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps/${encodeURIComponent(a.feedpath)}`,
      { method: "PUT" }
    ).then(() => ({ submitted: a.feedpath }));
  }
);
tool(
  "gsc_delete_sitemap",
  "GSC [WRITE]: remove a sitemap (re-submittable).",
  obj({ feedpath: str("full sitemap URL"), siteUrl: str() }, ["feedpath"]),
  (a) => {
    const site = a.siteUrl || GSC_SITE_URL;
    if (!site) throw new Error("No siteUrl and GSC_SITE_URL not set.");
    return gfetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps/${encodeURIComponent(a.feedpath)}`,
      { method: "DELETE" }
    ).then(() => ({ deleted: a.feedpath }));
  }
);
tool(
  "gsc_add_site",
  "GSC [WRITE]: add a property to Search Console (ownership still has to be verified separately).",
  obj({ siteUrl: str("URL-prefix or sc-domain: form") }, ["siteUrl"]),
  (a) =>
    gfetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(a.siteUrl)}`, { method: "PUT" }).then(() => ({ added: a.siteUrl }))
);
tool(
  "gsc_request_indexing",
  "Indexing API [WRITE]: ask Google to (re)crawl a URL. NOTE: officially for JobPosting/BroadcastEvent pages; pinging general URLs works but is unofficial.",
  obj({ url: str("the page URL"), type: enm(["URL_UPDATED", "URL_DELETED"]) }, ["url"]),
  (a) =>
    gfetch("https://indexing.googleapis.com/v3/urlNotifications:publish", {
      method: "POST",
      body: JSON.stringify({ url: a.url, type: a.type || "URL_UPDATED" }),
    })
);

// ───────── Google Tag Manager API v2 (manage tags/triggers/variables → version → publish) ─────────
tool(
  "gtm",
  "Google Tag Manager API v2 escape hatch — any method/path under tagmanager/v2. Discover: GET 'accounts', then '<acct>/containers', then '<container>/workspaces'. Manage: GET/POST '<workspace>/tags' | '/triggers' | '/variables'; create a version (POST '<workspace>:create_version'); publish (POST '<containerVersion>:publish'). WRITES + PUBLISH are real and affect the live site — build in a workspace, publish deliberately.",
  obj(
    { method: enm(["GET", "POST", "PUT", "DELETE"]), path: str("relative to https://www.googleapis.com/tagmanager/v2/ — e.g. accounts/123/containers/456/workspaces/7/tags"), body: str("JSON string for POST/PUT"), query: str("optional query string, e.g. fingerprint=...") },
    ["method", "path"]
  ),
  (a) =>
    gfetch(`https://www.googleapis.com/tagmanager/v2/${a.path.replace(/^\//, "")}${a.query ? `?${a.query}` : ""}`, {
      method: a.method,
      body: a.body,
    })
);

// ─────────────────────────── MCP transport: JSON-RPC 2.0 over stdio ───────────────────────────
const PROTOCOL_VERSION = "2024-11-05";
function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n"); // stdout is the MCP channel — logs go to stderr only
}
function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg: any): Promise<void> {
  const { id, method, params } = msg ?? {};
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "oqva-marketing-mcp", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return; // notifications: no response
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      return;
    case "tools/call": {
      const t = TOOLS.find((x) => x.name === params?.name);
      if (!t) {
        replyError(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      const result = await t.handler(params?.arguments ?? {});
      reply(id, result);
      return;
    }
    default:
      if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`);
  }
}

function startServer(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let msg: unknown;
    try {
      msg = JSON.parse(t);
    } catch {
      return; // ignore non-JSON lines
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    for (const m of msgs) void handleMessage(m).catch((e) => console.error("handler error:", e));
  });
  rl.on("close", () => setTimeout(() => process.exit(0), 50)); // stdin closed → flush any in-flight reply, then exit
  console.error("oqva-marketing-mcp running on stdio (vanilla, 0 runtime deps)");
}

// ─────────────────────────── interactive setup (`setup` / `auth` / `doctor`) ───────────────────────────
// Everything below is the human-facing CLI. It prints to stdout (the MCP stdio channel
// is only used by `startServer`), writes config to ~/.oqva-marketing-mcp/.env, and never
// asks the user to hand-edit a file or hunt for an ID.

type RL = ReturnType<typeof createInterface>;
function say(s = ""): void { process.stdout.write(s + "\n"); }
function shortErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 240 ? m.slice(0, 240) + "…" : m;
}
function ask(rl: RL, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, (a) => res(a.trim())));
}
async function askYesNo(rl: RL, q: string, def = true): Promise<boolean> {
  const a = (await ask(rl, `${q} ${def ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return a ? a[0] === "y" : def;
}
/** Auto-pick when there's one, otherwise let the user choose by number. Returns "" if none. */
async function pickOne(rl: RL, label: string, items: { id: string; name: string }[]): Promise<string> {
  if (items.length === 0) return "";
  if (items.length === 1) { say(`  → using your only ${label}: ${items[0].name} (${items[0].id})`); return items[0].id; }
  say(`  You have several — pick a ${label}:`);
  items.forEach((it, i) => say(`    ${i + 1}) ${it.name} (${it.id})`));
  for (;;) {
    const n = parseInt(await ask(rl, `  Number [1-${items.length}]: `), 10);
    if (n >= 1 && n <= items.length) return items[n - 1].id;
  }
}

/** Write KEY=value into the per-user config .env (creating it), and into this process. */
function upsertEnv(key: string, value: string): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  let txt = "";
  try { txt = readFileSync(CONFIG_ENV, "utf8"); } catch { /* first write */ }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  txt = re.test(txt) ? txt.replace(re, line) : txt.replace(/\s*$/, "") + "\n" + line + "\n";
  writeFileSync(CONFIG_ENV, txt.replace(/^\n+/, ""), { mode: 0o600 });
  process.env[key] = value;
}

/** Open a URL in the user's default browser (best-effort; never throws). */
function openBrowser(url: string): void {
  const isWin = process.platform === "win32";
  const cmd = process.platform === "darwin" ? "open" : isWin ? "cmd" : "xdg-open";
  const args = isWin ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* user can paste it */ }
}

/** Run the Google loopback OAuth dance and RETURN a durable refresh token (throws on failure). */
async function obtainGoogleRefreshToken(): Promise<string> {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) throw new Error("GOOGLE_OAUTH_CLIENT_ID / _SECRET are not set yet.");
  const port = 4571;
  const redirectUri = `http://localhost:${port}`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  say("\n  Opening your browser to sign in to Google…");
  say("  (If it doesn't open, paste this URL into your browser:)");
  say("  " + authUrl.toString());
  openBrowser(authUrl.toString());
  const code: string = await new Promise((resolveCode, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url || "/", redirectUri);
      const c = u.searchParams.get("code");
      const e = u.searchParams.get("error");
      if (!c && !e) { res.writeHead(204); res.end(); return; } // ignore favicon etc.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>All set — close this tab and return to the terminal.</h2>");
      srv.close();
      if (e) reject(new Error(`Google authorization error: ${e}`));
      else resolveCode(c as string);
    });
    srv.on("error", reject);
    srv.listen(port, () => say(`  (waiting for Google to redirect back…)`));
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: OAUTH_CLIENT_ID, client_secret: OAUTH_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const data = (await r.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
  if (!r.ok || !data.refresh_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(data)}. If there is no refresh_token, revoke the app at myaccount.google.com/permissions and try again.`);
  }
  return data.refresh_token;
}

/** `auth` subcommand — get + save the Google refresh token. Sets exitCode; exits naturally. */
async function runAuthFlow(): Promise<void> {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    say("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first — easiest is to run `setup`.");
    process.exitCode = 1;
    return;
  }
  try {
    upsertEnv("GOOGLE_OAUTH_REFRESH_TOKEN", await obtainGoogleRefreshToken());
    reloadConfig();
    say(`\n✅ Google connected. Saved to ${CONFIG_ENV}.`);
  } catch (e) {
    say(`\n❌ ${shortErr(e)}`);
    process.exitCode = 1;
  }
}

// Meta discovery — turn a bare token into the Page + ad-account ids, so the user never hunts for them.
async function metaDiscoverPages(): Promise<{ id: string; name: string }[]> {
  const r = (await mfetch("me/accounts", { fields: "id,name", limit: 100 })) as { data?: { id: string; name: string }[] };
  return r.data ?? [];
}
async function metaDiscoverAdAccounts(): Promise<{ id: string; name: string }[]> {
  let out: { id: string; name: string }[] = [];
  try {
    const r = (await mfetch("me/adaccounts", { fields: "id,name", limit: 200 })) as { data?: { id: string; name: string }[] };
    out = r.data ?? [];
  } catch { /* fall through */ }
  if (out.length) return out;
  // System-user tokens return [] above → reach them via the owning business instead.
  try {
    const b = (await mfetch("me/businesses", { fields: "id,name", limit: 50 })) as { data?: { id: string }[] };
    for (const biz of b.data ?? []) {
      const oa = (await mfetch(`${biz.id}/owned_ad_accounts`, { fields: "id,name", limit: 200 })) as { data?: { id: string; name: string }[] };
      out.push(...(oa.data ?? []));
    }
  } catch { /* none reachable */ }
  return out;
}

/** How Claude should launch the server: the binary itself, or `node dist/index.js` in dev. */
function serverInvocation(): string[] {
  if (COMPILED) return [process.execPath];
  return [process.execPath, SELF.replace(/src([\\/])index\.ts$/, "dist$1index.js")];
}

/** Register with the Claude CLI if it's installed; otherwise print the exact command + config. */
function registerWithClaude(): void {
  const inv = serverInvocation();
  const added = spawnSync("claude", ["mcp", "add", "oqva-marketing", "--", ...inv], { stdio: "ignore" });
  if (added.status === 0) {
    say('\n✅ Registered with Claude as "oqva-marketing". Restart Claude and the tools appear.');
    return;
  }
  const printable = inv.map((p) => (p.includes(" ") ? `"${p}"` : p)).join(" ");
  say("\nLast step — connect it to Claude. Run:");
  say(`\n  claude mcp add oqva-marketing -- ${printable}`);
  say("\n…or add this to your project's .mcp.json:");
  say(`  {"mcpServers":{"oqva-marketing":{"command":${JSON.stringify(inv[0])},"args":${JSON.stringify(inv.slice(1))}}}}`);
}

/** Live connection check for every source. Returns true if Google + Meta are both working. */
async function runDoctor(): Promise<boolean> {
  reloadConfig();
  _tok = null;
  say("\n── Connection check ───────────────────────────────");
  let bothCriticalOk = true;

  if (!googleConfigured()) {
    say("Google:  ⚠️  not connected yet — run setup");
    bothCriticalOk = false;
  } else {
    try {
      const sites = (await gfetch("https://searchconsole.googleapis.com/webmasters/v3/sites")) as { siteEntry?: unknown[] };
      const summ = (await gfetch("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200")) as { accountSummaries?: { propertySummaries?: unknown[] }[] };
      const nSites = sites.siteEntry?.length ?? 0;
      const nProps = (summ.accountSummaries ?? []).reduce((a: number, s) => a + (s.propertySummaries?.length ?? 0), 0);
      say(`Google:  ✅ connected — ${nSites} Search Console + ${nProps} Analytics propert${nProps === 1 ? "y" : "ies"} reachable`);
    } catch (e) {
      say(`Google:  ❌ ${shortErr(e)}`);
      bothCriticalOk = false;
    }
  }

  if (!META_TOKEN) {
    say("Meta:    ⚠️  not connected yet — run setup");
    bothCriticalOk = false;
  } else {
    try {
      const me = (await mfetch("me", { fields: "id,name" })) as { name?: string };
      const pages = await metaDiscoverPages().catch(() => []);
      const accts = await metaDiscoverAdAccounts().catch(() => []);
      say(`Meta:    ✅ connected as ${me.name ?? "your account"} — ${pages.length} Page(s), ${accts.length} ad account(s)`);
      if (META_PAGE_ID) say(`           Page:       ${META_PAGE_ID}`);
      if (META_AD_ACCOUNT) say(`           Ad account: ${META_AD_ACCOUNT}`);
    } catch (e) {
      say(`Meta:    ❌ ${shortErr(e)}`);
      bothCriticalOk = false;
    }
  }

  if (GBP_ACCOUNT_ID) {
    try {
      await gfetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts");
      say(`GBP:     ✅ Business Profile API approved (${GBP_ACCOUNT_ID})`);
    } catch {
      say("GBP:     ⏳ set, but Google hasn't approved Business Profile API access yet (see SETUP.md Phase 4)");
    }
  } else {
    say("GBP:     —  optional, set up later (needs a Google approval; see SETUP.md Phase 4)");
  }
  say("───────────────────────────────────────────────────");
  return bothCriticalOk;
}

/** Guided setup — connects Google and Meta, then verifies + registers with Claude. */
async function runSetupWizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    say("\n┌───────────────────────────────────────────────┐");
    say("│   OQVA Marketing MCP — setup                  │");
    say("└───────────────────────────────────────────────┘");
    say("\nThis connects Claude to your marketing data — Google (Search Console + Analytics)");
    say("and Meta (Facebook/Instagram Page + Ads). About 5 minutes. Everything you enter is");
    say(`saved only on this computer, at ${CONFIG_ENV}.`);

    // ── 1. GOOGLE ──
    say("\n=== 1 of 2 · Google (Search Console + Analytics) ===");
    say("You make a free Google Cloud “app” so Claude can read your data as you. Quick version");
    say("(full walkthrough with screenshots is in SETUP.md):");
    say("  a) https://console.cloud.google.com → create a project.");
    say("  b) APIs & Services → Library → Enable: Search Console API, Google Analytics Data API,");
    say("     Google Analytics Admin API.");
    say("  c) APIs & Services → OAuth consent screen → External → add your email as a Test user");
    say("     → set Publishing status to “In production”.");
    say("  d) APIs & Services → Credentials → Create credentials → OAuth client ID → “Desktop app”.");
    say("     Copy the Client ID and Client secret.");
    if (await askYesNo(rl, "\nReady to paste your Google Client ID + secret?")) {
      let clientId = "";
      while (!clientId.endsWith(".apps.googleusercontent.com")) {
        clientId = await ask(rl, "  Client ID (ends in .apps.googleusercontent.com): ");
        if (!clientId.endsWith(".apps.googleusercontent.com")) say("    ↳ that doesn't look right — it should end with .apps.googleusercontent.com");
      }
      let secret = "";
      while (!secret) secret = await ask(rl, "  Client secret (starts with GOCSPX-): ");
      upsertEnv("GOOGLE_OAUTH_CLIENT_ID", clientId);
      upsertEnv("GOOGLE_OAUTH_CLIENT_SECRET", secret);
      reloadConfig();
      try {
        upsertEnv("GOOGLE_OAUTH_REFRESH_TOKEN", await obtainGoogleRefreshToken());
        reloadConfig();
        _tok = null;
        say("  ✅ Google connected.");
      } catch (e) {
        say(`  ❌ ${shortErr(e)}`);
        say("  No problem — re-run setup to try Google again.");
      }
    } else {
      say("  Skipping Google for now — re-run setup when you have the Client ID + secret.");
    }

    // ── 2. META (Page + Ads) ──
    say("\n=== 2 of 2 · Meta (Facebook / Instagram Page + Ads) ===");
    say("Claude reads your Page insights and ad performance with a Meta access token. Quick");
    say("version (full walkthrough in SETUP.md, Phase 3):");
    say("  a) https://business.facebook.com/settings → Users → System Users.");
    say("  b) Add an Admin system user → Assign assets → add your Page + ad account (Full control).");
    say("  c) Generate new token → choose/create an app with the Marketing API → expiry: Never.");
    say("  d) Tick: read_insights, pages_read_engagement, pages_show_list, ads_read");
    say("     (add ads_management, business_management, pages_manage_metadata to let Claude tidy ads).");
    say("  e) Generate, then copy the token.");
    if (await askYesNo(rl, "\nReady to paste your Meta access token?")) {
      let token = "";
      while (!token) token = await ask(rl, "  Meta access token: ");
      upsertEnv("META_ACCESS_TOKEN", token);
      reloadConfig();
      try {
        const me = (await mfetch("me", { fields: "id,name" })) as { name?: string };
        say(`  ✅ Token works — connected as ${me.name ?? "your account"}.`);
        say("  Finding your Page…");
        const pageId = await pickOne(rl, "Page", await metaDiscoverPages().catch(() => []));
        if (pageId) upsertEnv("META_PAGE_ID", pageId);
        else say("    (no Page on this token yet — re-check the asset assignment in step b.)");
        say("  Finding your ad account…");
        const adId = await pickOne(rl, "ad account", await metaDiscoverAdAccounts().catch(() => []));
        if (adId) upsertEnv("META_AD_ACCOUNT_ID", adId);
        else say("    (no ad account — fine if you don't run ads; assign one and re-run to add it.)");
        reloadConfig();
      } catch (e) {
        say(`  ❌ That token didn't work: ${shortErr(e)}`);
        say("  Usual cause: a scope wasn't ticked, or the Page/ad account isn't assigned to the system user.");
      }
    } else {
      say("  Skipping Meta for now — re-run setup when you have the token.");
    }

    // ── Verify + register ──
    const ok = await runDoctor();
    registerWithClaude();
    say(ok
      ? "\n🎉 All set — Google and Meta are both connected. Restart Claude to use them."
      : "\nDone, but something above isn't connected yet. Fix it and just run setup again: oqva-marketing-mcp setup");
    say("");
  } finally {
    rl.close();
    process.stdin.unref(); // let the process exit naturally (flushes stdout; process.exit can truncate a pipe)
  }
}

// ─────────────────────────── entry point ───────────────────────────
// Subcommands set process.exitCode and return rather than calling process.exit(), so
// buffered stdout always flushes before the process ends (exit() can truncate a pipe).
const SUBCOMMAND = process.argv.slice(1).find((a) => a === "setup" || a === "auth" || a === "doctor" || a === "serve");
if (SUBCOMMAND === "setup") runSetupWizard().catch((e) => { say(`\n❌ ${shortErr(e)}`); process.exitCode = 1; });
else if (SUBCOMMAND === "auth") void runAuthFlow();
else if (SUBCOMMAND === "doctor") runDoctor().then((ok) => { process.exitCode = ok ? 0 : 1; }).catch((e) => { say(`\n❌ ${shortErr(e)}`); process.exitCode = 1; });
else startServer(); // default (and `serve`) → MCP stdio server
