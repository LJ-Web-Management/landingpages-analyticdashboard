// Pulls fresh Ahrefs data for the "live" sites and writes data/latest.json.
// Run by .github/workflows/fetch-ahrefs-data.yml on a daily schedule.
// Requires env var AHREFS_API_KEY (a GitHub Actions secret in CI).

import { mkdir, writeFile } from "node:fs/promises";
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

async function ahrefsGet(pathname, params) {
  const url = new URL(API_BASE + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  url.searchParams.set("output", "json");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ahrefs ${pathname} -> ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res.json();
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

async function main() {
  const results = await Promise.all(LIVE_SITES.map(fetchSite));
  const sites = {};
  for (const r of results) sites[r.id] = r;

  const payload = {
    generatedAt: new Date().toISOString(),
    sites,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUT_PATH} for sites: ${Object.keys(sites).join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
