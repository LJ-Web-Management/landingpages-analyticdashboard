# Search Console Dashboard

A static dashboard (GitHub Pages) that combines Google Search Console performance
across any mix of properties: pick sites from the multi-select and see their
combined clicks, impressions, CTR and impression-weighted position, with trends,
per-site breakdown, and merged top queries, pages, countries and devices.

The page shows the data synced daily by a GitHub Action from one or more
Google accounts. **Everyone who opens the dashboard sees it, with no sign-in.**
Until the first sync has run, it shows sample (demo) data.

> **Privacy:** shared data is committed to `data/gsc/` in this repo and served by
> GitHub Pages. If the repo or the Pages site is public, anyone with the link can
> see it. Keep the repo private (and Pages access-restricted) if that matters.

## Set up the shared daily sync (everyone sees real data)

You add credentials for **one or more Google accounts** to a single secret,
`GSC_ACCOUNTS`, which is a JSON array. Each entry can be either kind below, and you can mix them.

### Option A: service account (simplest, works across any number of Google accounts)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project, then enable the **Google Search Console API**.
2. Go to **IAM & Admin → Service accounts → Create service account**. Open the new account, go to **Keys → Add key → JSON**, and download the file.
3. In **Search Console**, for every property (under any of your Google accounts), go to
   **Settings → Users and permissions → Add user**. Paste the service account's email
   (`…@….iam.gserviceaccount.com`) and give it **Restricted** permission.
4. Paste the downloaded JSON into the secret, wrapped in `[ ]`.

### Option B: sign in as each Google account (picks up all its properties automatically)

1. In Google Cloud Console, create an **OAuth client ID** of type **Desktop app**. Note the client ID and secret.
2. On your computer, once per Google account:
   ```bash
   node scripts/get-refresh-token.mjs <client_id> <client_secret>
   ```
   Sign in with that account. The script prints a JSON object; add it to the array.

### Add the secret and run it

Repo **Settings → Secrets and variables → Actions → New repository secret**:

- Name: `GSC_ACCOUNTS`
- Value: for example
  ```json
  [
    { "type": "service_account", "client_email": "…", "private_key": "…", "...": "…" },
    { "label": "me@gmail.com", "client_id": "…", "client_secret": "…", "refresh_token": "…" },
    { "label": "clients@agency.com", "client_id": "…", "client_secret": "…", "refresh_token": "…" }
  ]
  ```

Optional: to limit which properties are synced, add a repository **variable** `GSC_SITES`
(comma-separated siteUrls, e.g. `sc-domain:example.com,https://www.example.org/`).

Then go to **Actions → Sync Search Console data → Run workflow**. After that it runs
every day at 09:23 UTC. A property visible to several accounts is fetched once.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | the dashboard |
| `assets/gsc-dashboard.js` | data loading, combining, charts |
| `assets/glass.css`, `assets/glass-theme.js` | liquid glass theme and Appearance panel |
| `scripts/fetch-gsc.mjs` | daily sync (run by `.github/workflows/fetch-gsc-data.yml`) |
| `scripts/get-refresh-token.mjs` | helper to add a Google account to the sync |
| `data/gsc/` | synced data (written by the workflow) |
