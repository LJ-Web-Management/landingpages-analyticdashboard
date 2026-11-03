// Daily Google Search Console sync → data/gsc/*.json, so everyone who opens
// the dashboard sees real data without signing in.
// Run by .github/workflows/fetch-gsc-data.yml. No npm dependencies.
//
// Credentials (GitHub Actions secrets) — any number of Google accounts:
//   GSC_ACCOUNTS  JSON array. Each entry is either
//                   - a service-account key file's JSON ({"type":"service_account", ...}), or
//                   - {"client_id": "...", "client_secret": "...", "refresh_token": "..."}
//                     (mint one per Google account with scripts/get-refresh-token.mjs)
//   GSC_SITES     optional, comma-separated siteUrls to limit the sync to
//
// Properties from every account are merged; a property visible to several
// accounts is fetched once.

import { createSign } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const API = "https://www.googleapis.com/webmasters/v3";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const RANGES = [7, 28, 90, 180, 365, 480];   // must match RANGES in assets/gsc-dashboard.js
const HISTORY_DAYS = 486;                    // Search Console keeps ~16 months
const LIMITS = { q: 250, p: 120, c: 40, d: 5 };
const DIMS = { q: "query", p: "page", c: "country", d: "device" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "data", "gsc");

function parseAccounts() {
  const raw = process.env.GSC_ACCOUNTS;
  if (!raw) throw new Error("Missing GSC_ACCOUNTS secret (a JSON array of Google credentials).");
  let list;
  try { list = JSON.parse(raw); } catch { throw new Error("GSC_ACCOUNTS is not valid JSON."); }
  if (!Array.isArray(list)) list = [list];
  if (!list.length) throw new Error("GSC_ACCOUNTS is an empty list.");
  return list;
}

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

async function tokenFor(cred) {
  let body;
  if (cred.type === "service_account") {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = b64url({ alg: "RS256", typ: "JWT" }) + "." +
      b64url({ iss: cred.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
    const sig = createSign("RSA-SHA256").update(unsigned).sign(cred.private_key, "base64url");
    body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` });
  } else if (cred.refresh_token) {
    body = new URLSearchParams({ grant_type: "refresh_token", client_id: cred.client_id, client_secret: cred.client_secret, refresh_token: cred.refresh_token });
  } else {
    throw new Error("Account entry is neither a service account nor a refresh-token credential.");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token exchange failed: ${json.error_description || json.error || res.status}`);
  return json.access_token;
}

const label = (cred, i) => cred.client_email || cred.label || `account #${i + 1}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gsc(token, pathname, body) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(API + pathname, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    const text = await res.text().catch(() => "");
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(1500 * attempt * attempt); continue; }
    throw new Error(`${pathname} -> ${res.status}: ${text.slice(0, 300)}`);
  }
}

const iso = (d) => d.toISOString().slice(0, 10);
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
const slug = (siteUrl) => siteUrl.replace(/^sc-domain:/, "domain-").replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

async function fetchSite(token, siteUrl, endDate) {
  const end = new Date(endDate + "T00:00:00Z");
  const q = (body) => gsc(token, `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, { dataState: "all", ...body });

  const daily = await q({ startDate: iso(addDays(end, -(HISTORY_DAYS - 1))), endDate, dimensions: ["date"], rowLimit: 25000 });
  const ranges = {};
  for (const r of RANGES) {
    const startDate = iso(addDays(end, -(r - 1)));
    const out = {};
    // sequential per site keeps us well inside the per-site QPS quota
    for (const [k, dim] of Object.entries(DIMS)) {
      const res = await q({ startDate, endDate, dimensions: [dim], rowLimit: LIMITS[k] });
      out[k] = (res.rows || []).map((row) => [row.keys[0], row.clicks, row.impressions, round(row.position)]);
    }
    ranges[r] = out;
  }
  return {
    siteUrl, endDate,
    daily: (daily.rows || []).map((row) => [row.keys[0], row.clicks, row.impressions, round(row.position)]),
    ranges,
  };
}

async function readJson(p) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } }

async function main() {
  const creds = parseAccounts();
  const only = (process.env.GSC_SITES || "").split(",").map((s) => s.trim()).filter(Boolean);
  const endDate = iso(addDays(new Date(), -2));   // Search Console lags ~2 days
  await mkdir(OUT_DIR, { recursive: true });
  const prevIndex = (await readJson(path.join(OUT_DIR, "index.json"))) || { sites: [] };

  // 1. discover properties across every account (first account with access wins)
  const owners = new Map();   // siteUrl -> { token, permissionLevel, account }
  const accountErrors = [];
  for (const [i, cred] of creds.entries()) {
    try {
      const token = await tokenFor(cred);
      const { siteEntry = [] } = await gsc(token, "/sites");
      console.log(`${label(cred, i)}: ${siteEntry.length} properties`);
      for (const s of siteEntry) {
        if (s.permissionLevel === "siteUnverifiedUser") continue;
        if (only.length && !only.includes(s.siteUrl)) continue;
        if (!owners.has(s.siteUrl)) owners.set(s.siteUrl, { token, permissionLevel: s.permissionLevel, account: i });
      }
    } catch (err) {
      accountErrors.push(`${label(cred, i)}: ${err.message}`);
      console.error(`✗ ${label(cred, i)}: ${err.message}`);
    }
  }
  if (!owners.size && accountErrors.length) throw new Error("No account could be read:\n" + accountErrors.join("\n"));

  // 2. fetch each property, 3 at a time
  const urls = [...owners.keys()].sort();
  const sites = [], failed = [];
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const siteUrl = urls[next++];
      const { token, permissionLevel } = owners.get(siteUrl);
      const file = slug(siteUrl) + ".json";
      try {
        const data = await fetchSite(token, siteUrl, endDate);
        await writeFile(path.join(OUT_DIR, file), JSON.stringify(data));
        sites.push({ siteUrl, permissionLevel, file, endDate });
        console.log(`✓ ${siteUrl}`);
      } catch (err) {
        failed.push(siteUrl);
        console.error(`✗ ${siteUrl}: ${err.message}`);
        // keep yesterday's file so a transient failure doesn't blank the site
        const prev = prevIndex.sites.find((s) => s.siteUrl === siteUrl);
        if (prev) sites.push(prev);
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);

  // 3. index + prune files for properties that are gone
  sites.sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
  await writeFile(path.join(OUT_DIR, "index.json"), JSON.stringify({
    generatedAt: new Date().toISOString(), endDate, accounts: creds.length, sites,
  }, null, 2));
  const keep = new Set(["index.json", ...sites.map((s) => s.file)]);
  for (const f of await readdir(OUT_DIR)) if (!keep.has(f)) await unlink(path.join(OUT_DIR, f));

  console.log(`Done: ${sites.length} properties from ${creds.length} account(s); ${failed.length} failed.`);
  if (failed.length || accountErrors.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
