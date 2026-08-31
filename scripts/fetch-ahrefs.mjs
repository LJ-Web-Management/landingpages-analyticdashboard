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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "latest.json");

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function monthsAgo(n) {
  const d = new Date();
  d.setUTCDate(1); // avoid month-length rollover surprises
  d.setUTCMonth(d.getUTCMonth() - n);
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

// Reduce a monthly-grouped history array to exactly 12 points (oldest -> newest),
// padding the front by repeating the earliest known value if the domain's
// history is shorter than 12 months.
function last12(rows, dateKey, valueKey) {
  const sorted = [...rows].sort((a, b) => a[dateKey].localeCompare(b[dateKey]));
  const values = sorted.map((r) => Number(r[valueKey]) || 0);
  const trimmed = values.slice(-12);
  while (trimmed.length < 12) trimmed.unshift(trimmed[0] ?? 0);
  return trimmed;
}

async function fetchSite({ id, target }) {
  const today = isoDate(new Date());
  const from = isoDate(monthsAgo(12));

  const [drHistory, trafficHistory, snapshot, refDomains, topKeywords] = await Promise.all([
    ahrefsGet("/site-explorer/domain-rating-history", {
      target,
      date_from: from,
      date_to: today,
      history_grouping: "monthly",
    }),
    ahrefsGet("/site-explorer/metrics-history", {
      target,
      date_from: from,
      date_to: today,
      history_grouping: "monthly",
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

  const drTrend = last12(drHistory.domain_ratings ?? [], "date", "domain_rating");
  const trafficTrend = last12(trafficHistory.metrics ?? [], "date", "org_traffic");

  return {
    id,
    asOf: today,
    dr: drTrend[drTrend.length - 1] ?? 0,
    drTrend,
    organicTraffic: snapshot.metrics?.org_traffic ?? trafficTrend[trafficTrend.length - 1] ?? 0,
    trafficTrend,
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
