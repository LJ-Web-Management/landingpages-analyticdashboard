// Pulls fresh Ahrefs data for the "live" sites and writes data/latest.json.
// Run by .github/workflows/fetch-ahrefs-data.yml on a daily schedule.
// Requires env var AHREFS_API_KEY (a GitHub Actions secret in CI).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const API_BASE = "https://api.ahrefs.com/v3";
const API_KEY = process.env.AHREFS_API_KEY;

if (!API_KEY) {
  console.error("Missing AHREFS_API_KEY environment variable.");
  process.exit(1);
}

// Sites currently wired up for live Ahrefs data. Add more entries here
// (matching the `id` used in index.html's SITES array) when ready.
const LIVE_SITES = [
  { id: "mold", target: "moldtraining.us" },
  { id: "confined", target: "confined-space.com" },
  { id: "excavation", target: "excavationtrenchingshoring.com" },
  { id: "stormwater", target: "stormwaterplanning.us" },
];

// Floor for "all time" monthly history. Ahrefs just returns whatever it
// actually has from here forward, so this only needs to predate every
// site's real history — no need to keep it in sync with anything.
const ALL_TIME_FROM = "2015-01-01";
// Window for daily-resolution history, covering the 1D/1W/1M ranges.
const DAILY_WINDOW_DAYS = 35;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "latest.json");

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ahrefs occasionally returns a transient 500 (seen 2026-09-14: a single
// flaky metrics-history call aborted the whole day's fetch for every site).
// Retry server-side errors with backoff; a 4xx means retrying won't help,
// so those fail immediately.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

async function ahrefsGet(pathname, params) {
  const url = new URL(API_BASE + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  url.searchParams.set("output", "json");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
      });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      await sleep(RETRY_DELAY_MS * attempt);
      continue;
    }
    if (res.ok) return res.json();

    const body = await res.text().catch(() => "");
    const err = new Error(`Ahrefs ${pathname} -> ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    if (res.status < 500 || attempt === MAX_ATTEMPTS) throw err;
    await sleep(RETRY_DELAY_MS * attempt);
  }
}

// Normalizes a history array into sorted {date, value} points.
function toPoints(rows, dateKey, valueKey) {
  return rows
    .map((r) => ({ date: r[dateKey], value: Number(r[valueKey]) || 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchSite({ id, target }) {
  const today = isoDate(new Date());
  const dailyFrom = isoDate(daysAgo(DAILY_WINDOW_DAYS));

  const [
    drMonthly,
    drDaily,
    trafficMonthly,
    trafficDaily,
    snapshot,
    refDomains,
    topKeywords,
  ] = await Promise.all([
    ahrefsGet("/site-explorer/domain-rating-history", {
      target,
      date_from: ALL_TIME_FROM,
      date_to: today,
      history_grouping: "monthly",
    }),
    ahrefsGet("/site-explorer/domain-rating-history", {
      target,
      date_from: dailyFrom,
      date_to: today,
      history_grouping: "daily",
    }),
    ahrefsGet("/site-explorer/metrics-history", {
      target,
      date_from: ALL_TIME_FROM,
      date_to: today,
      history_grouping: "monthly",
      mode: "subdomains",
      select: "date,org_traffic",
    }),
    ahrefsGet("/site-explorer/metrics-history", {
      target,
      date_from: dailyFrom,
      date_to: today,
      history_grouping: "daily",
      mode: "subdomains",
      select: "date,org_traffic",
    }),
    ahrefsGet("/site-explorer/metrics", {
      target,
      date: today,
      mode: "subdomains",
    }),
    ahrefsGet("/site-explorer/backlinks-stats", {
      target,
      date: today,
      mode: "subdomains",
    }),
    ahrefsGet("/site-explorer/organic-keywords", {
      target,
      date: today,
      mode: "subdomains",
      select: "keyword,best_position,volume,sum_traffic",
      order_by: "sum_traffic:desc",
      limit: 6,
    }),
  ]);

  const drMonthlyPts = toPoints(drMonthly.domain_ratings ?? [], "date", "domain_rating");
  const drDailyPts = toPoints(drDaily.domain_ratings ?? [], "date", "domain_rating");
  const trafficMonthlyPts = toPoints(trafficMonthly.metrics ?? [], "date", "org_traffic");
  const trafficDailyPts = toPoints(trafficDaily.metrics ?? [], "date", "org_traffic");

  const latestDR = drDailyPts.at(-1)?.value ?? drMonthlyPts.at(-1)?.value ?? 0;

  return {
    id,
    asOf: today,
    dr: latestDR,
    organicTraffic: snapshot.metrics?.org_traffic ?? trafficDailyPts.at(-1)?.value ?? 0,
    organicKeywords: snapshot.metrics?.org_keywords ?? 0,
    referringDomains: refDomains.metrics?.live_refdomains ?? 0,
    keywords: (topKeywords.keywords ?? [])
      .filter((k) => k.keyword)
      .map((k) => ({
        k: k.keyword,
        pos: k.best_position ?? null,
        vol: k.volume ?? 0,
        traffic: k.sum_traffic ?? 0,
      })),
    history: {
      monthly: { dr: drMonthlyPts, traffic: trafficMonthlyPts },
      daily: { dr: drDailyPts, traffic: trafficDailyPts },
    },
  };
}

async function loadExistingSites() {
  try {
    const raw = await readFile(OUT_PATH, "utf8");
    return JSON.parse(raw).sites ?? {};
  } catch {
    return {};
  }
}

async function main() {
  // Load yesterday's data first so a site that still fails after retries
  // can fall back to its last-known values instead of losing the day
  // entirely (or, before this fix, aborting every other site's refresh too
  // since they all ran under one Promise.all).
  const existingSites = await loadExistingSites();

  const settled = await Promise.allSettled(LIVE_SITES.map(fetchSite));
  const sites = {};
  const failedIds = [];

  settled.forEach((result, i) => {
    const { id } = LIVE_SITES[i];
    if (result.status === "fulfilled") {
      sites[id] = result.value;
      return;
    }
    failedIds.push(id);
    console.error(`Site "${id}" failed to fetch: ${result.reason}`);
    if (existingSites[id]) {
      sites[id] = { ...existingSites[id], stale: true };
      console.warn(`Site "${id}": reusing data from ${existingSites[id].asOf} instead.`);
    } else {
      console.warn(`Site "${id}": no previous data to fall back on — omitted from this run.`);
    }
  });

  if (!Object.keys(sites).length) {
    throw new Error("Every site failed to fetch and none had previous data to fall back on.");
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    sites,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUT_PATH} for sites: ${Object.keys(sites).join(", ")}`);

  if (failedIds.length) {
    // Still exit non-zero so the workflow (and its failure email) flags
    // this run — the data is saved either way, this just keeps the alert
    // as an early-warning signal for genuinely broken sites/keys.
    console.error(`${failedIds.length} site(s) failed this run: ${failedIds.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
