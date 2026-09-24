# News Pulse

News Pulse is a topic-clustered news timeline that aggregates RSS articles from five major news sources, groups stories covering the same event using word-overlap clustering, and presents the result as an interactive visual timeline. You can see which stories broke when, which sources covered them together, and drill into the full article list for any cluster — all updating in real time via a one-click refresh cycle.

**Live deployment:**
- Frontend: https://news-pulse-mocha.vercel.app
- Backend API: https://news-pulse-fgub.onrender.com

---

## Architecture

The system has three independent components that share a single Neon Postgres database.

The **Python scraper** (`scraper/`) runs on demand: it fetches RSS feeds, normalises and deduplicates article URLs, extracts body text via Trafilatura where possible, then clusters every article in the database using a greedy pairwise word-overlap algorithm. All results are written to Postgres. The scraper is never running continuously — it is a one-shot script that exits after each run.

The **Node/Express API** (`backend/`) serves the frontend. It exposes read-only cluster and timeline endpoints backed by simple SQL queries, and an `/ingest/trigger` endpoint that spawns the Python scraper as a child process. The API tracks job state in Postgres so the frontend can poll for completion without keeping a long-lived connection open.

The **Next.js frontend** (`frontend/`) fetches the timeline cluster list on load, renders them as a horizontally-positioned dot-and-bar timeline with lane assignment to avoid visual overlap, and supports source filtering, cluster detail drill-down, and a live refresh button that drives the full trigger → poll → reload cycle.

```
User browser
    │  HTTPS
    ▼
Vercel (Next.js)
    │  fetch() NEXT_PUBLIC_API_URL
    ▼
Render Docker (Node/Express)
    │  child_process.spawn()      │  pg queries
    ▼                             ▼
Python scraper ──────────── Neon Postgres
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Scraper | Python 3, feedparser, Trafilatura, httpx, psycopg2, python-dateutil |
| API | Node.js 20, Express, node-postgres (pg) |
| Frontend | Next.js 14, TypeScript, Tailwind CSS |
| Database | Neon (serverless Postgres), CITEXT extension |
| Deployment | Docker (Render Web Service), Vercel |

---

## News Sources

| Source | RSS Feed |
|---|---|
| BBC News | `https://feeds.bbci.co.uk/news/rss.xml` |
| NY Times | `https://rss.nytimes.com/services/xml/rss/nyt/World.xml` |
| NPR | `https://feeds.npr.org/1001/rss.xml` |
| The Guardian | `https://www.theguardian.com/world/rss` |
| Al Jazeera | `https://www.aljazeera.com/xml/rss/all.xml` |

Reuters was the originally intended fifth source but was replaced by NY Times. Reuters discontinued all public RSS feeds in June 2020 — this is a deliberate business decision on their part, not a network or parsing issue.

---

## Setup

### Prerequisites

- Node.js ≥ 20
- Python ≥ 3.11
- A Postgres database (Neon recommended — free tier covers this project)

### 1. Clone

```bash
git clone https://github.com/Akrishna4/news-pulse.git
cd news-pulse
```

### 2. Database

Apply the schema to your Postgres instance:

```bash
psql "$DATABASE_URL" -f schema.sql
```

The schema creates the `articles`, `clusters`, `article_cluster`, and `ingestion_jobs` tables, and enables the `citext` extension.

### 3. Scraper (Python)

```bash
cd scraper
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # fill in DATABASE_URL
```

### 4. Backend (Node)

```bash
cd backend
npm install
cp .env.example .env          # fill in DATABASE_URL, PORT, ALLOWED_ORIGIN
```

### 5. Frontend (Next.js)

```bash
cd frontend
npm install
cp .env.example .env.local    # fill in NEXT_PUBLIC_API_URL
```

---

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `DATABASE_URL` | `scraper/.env`, `backend/.env` | Full Postgres connection string (e.g. `postgres://user:pass@host/db?sslmode=require`) |
| `PORT` | `backend/.env` | Port the Express server listens on. Defaults to 4000 locally; Render sets this automatically in production. |
| `NODE_ENV` | `backend/.env` | `production` disables the `.venv` PATH injection so the Dockerfile's system Python is used instead. |
| `ALLOWED_ORIGIN` | `backend/.env` | The single origin allowed by the CORS policy. Set to the Vercel frontend URL in production. |
| `NEXT_PUBLIC_API_URL` | `frontend/.env.local` | Base URL of the backend API, e.g. `http://localhost:4000` locally or the Render URL in production. |

---

## Running Locally

Run each process in a separate terminal, in this order:

```bash
# 1. Run the scraper once to populate the database
cd scraper
source .venv/bin/activate
python src/main.py

# 2. Start the backend API
cd backend
npm run dev          # or: node src/server.js

# 3. Start the frontend
cd frontend
npm run dev
```

Then open `http://localhost:3000`.

The backend defaults to port 4000. The frontend reads `NEXT_PUBLIC_API_URL` from `.env.local` — make sure it points to `http://localhost:4000`.

---

## Database Setup

`schema.sql` at the repo root defines the complete schema. Apply it once before running anything:

```bash
psql "$DATABASE_URL" -f schema.sql
```

Key schema decisions:
- `articles.url` uses `CITEXT` so duplicate detection is case-insensitive across the entire URL string, not just the scheme and host.
- `ingestion_jobs.id` uses `gen_random_uuid()`, which has been a built-in Postgres function since version 13 and requires no extension.
- `clusters.start_time` / `end_time` can be `NULL` when all articles in a cluster have no `published_at` — this is intentional, not a schema gap.

---

## Ingestion Pipeline

### What it does

Each pipeline run (triggered manually or via the API) does the following in sequence:

1. **Fetch feeds** — downloads all 5 RSS feeds using feedparser.
2. **Normalise & deduplicate** — strips tracking parameters from URLs, lowercases scheme and host, then uses `INSERT ... ON CONFLICT (url) DO NOTHING` to skip any already-known article atomically.
3. **Extract body text** — for new articles only, fetches each article page with httpx and runs Trafilatura's extraction. Failures (timeouts, 403s, empty results) are logged and marked `extraction_status = 'failed'` permanently. No retries.
4. **Cluster** — deletes all existing clusters and rebuilds from scratch using all articles currently in the database. See Clustering section below.
5. **Write results** — inserts the new cluster rows and their `article_cluster` join rows, updates the `ingestion_jobs` record with final status and counts.

### Triggering manually

```bash
cd scraper
source .venv/bin/activate
python src/main.py
```

### Triggering via API

```bash
curl -X POST http://localhost:4000/ingest/trigger
# returns: {"jobId": "<uuid>"}

curl http://localhost:4000/ingest/status/<jobId>
# poll until status is "completed" or "failed"
```

---

## Topic Clustering

### Why word-overlap, not TF-IDF

Word-overlap was chosen over TF-IDF primarily because the assessment rewards clear reasoning and explainability over algorithmic sophistication, and word-overlap is dramatically easier to demonstrate and explain on camera. Showing a concrete list of shared words — "these six words caused these two stories to merge" — is immediately legible. Explaining TF-IDF vectorisation, IDF weight computation, and cosine-similarity thresholds in a five-minute video walkthrough is not. The approach is also genuinely defensible for this task: news stories covering the same event do share specific named entities and proper nouns that appear in very few other articles, so a shared-count threshold has real selectivity. TF-IDF would be a straightforward upgrade path but was deliberately not chosen here.

### Algorithm

The clustering runs in five steps:

1. **Tokenise** each article's `headline + summary` — lowercase, strip punctuation, remove standard English stopwords.
2. **Corpus-adaptive filtering** — remove any word that appears in more than 25% of articles in the current run. This removes high-frequency words specific to the current news cycle (e.g. "said", "government", "year") that a generic stopword list wouldn't catch.
3. **Greedy pairwise best-match** — for each article in order, find the existing cluster whose representative article shares the most words with it, subject to two joint thresholds: `shared_word_count >= 3` AND `shared_count / min(|A|, |B|) >= 0.4`. If no cluster meets both thresholds, the article becomes a new singleton cluster.
4. **Label generation** — singleton clusters use the article headline directly (truncated to 52 characters). Multi-article clusters use the top 3 most-frequent significant words, joined with `/`, to form a keyword label.
5. **Full recompute** — every run deletes all existing cluster rows and recomputes from scratch. This is intentional: it guarantees consistency when new articles arrive that would have changed earlier groupings, and keeps the algorithm stateless.

The algorithm is pairwise (each article is compared against existing cluster representatives, not the full aggregate of all member words). This was chosen after observing that cluster-aggregate-union caused false merges in practice — see Known Limitations below.

### Threshold Reasoning

- **`shared >= 3`** — the value 3 comes directly from the assessment's own worked example and was adopted as the starting point. It was not derived from a sweep. The only empirical check performed was the Teesside/Sydney false-merge investigation, which confirmed the two articles shared 6 words (`crime`, `arrested`, `organised`, `police`, `officers`, `men`). Since `shared_count = 6` already clears any threshold up to 6, a higher absolute threshold would not have prevented that merge. No threshold adjustment was pursued as a result.
- **`ratio >= 0.4`** — a principled starting value requiring the shared words to represent at least 40% of the shorter article's significant-word set. This prevents a large cluster from absorbing short articles that happen to share one or two common topic words.
- **25% corpus-adaptive filter** — a word appearing in more than a quarter of all articles in a run is by definition not topic-specific for that run, regardless of whether it appears in a generic stopword list. 25% was chosen as a reasonable initial value, not the result of an empirical sweep across candidate thresholds.

---

## Known Limitations

- **Synonyms and paraphrases are invisible.** Word-overlap requires literal word matches. Two articles covering the same event using different vocabulary (e.g. "killed" vs "died") will not cluster together. This is an inherent limitation of the approach, not a tuning issue.

- **False-merge example (Teesside/Sydney).** During development, an article about a Teesside (UK) crime operation and an article about a Sydney (Australia) crime operation were merged into the same cluster. The shared words were: `crime`, `arrested`, `organised`, `police`, `officers`, `men`. None of these are in a standard English stopword list, and none appeared in more than 25% of articles in that particular run, so the corpus-adaptive filter did not remove them. This is the correct known-failure mode of word-overlap clustering: stories in the same genre (crime, politics, sport) that share structural vocabulary will occasionally merge even with no shared event. TF-IDF or entity-based clustering would reduce this class of error.

- **NY Times body extraction fails 100%.** NY Times article pages return a 403 to the scraper's default httpx User-Agent. This means `body` is always `NULL` for NY Times articles. Headline, summary, source attribution, and clustering are all unaffected — only full-text body extraction fails. A realistic browser User-Agent header would likely resolve this but has not been added.

- **No retry or backoff on failed fetches.** If an article page returns a timeout, 5xx, or empty body, it is marked `extraction_status = 'failed'` and never attempted again in future runs. This prevents hammering paywalled or slow sites but means transient failures result in permanent misses.

- **Cluster IDs are not stable across ingestion runs.** Because clustering deletes and reinserts every cluster each run, cluster IDs (integer primary keys) change. Any external system that caches a cluster ID will see a stale reference after the next ingest. This is acceptable for the current frontend (which reloads all data after each refresh) but would need addressing before exposing the API to third-party consumers.

- **Missing `pubDate` falls back to NULL.** Articles whose RSS entry has no `published` or `updated` field are stored with `published_at = NULL`. They are included in clustering but excluded from `cluster.start_time` / `cluster.end_time` calculations (which use `MIN`/`MAX` over non-null values). No fake timestamp is backfilled.

- **CITEXT deduplication is URL-wide.** `articles.url` uses the `CITEXT` type, so duplicate detection is case-insensitive across the entire URL string — scheme, host, path, and query string — not just the normalised scheme+host. A URL that differs only in case will be correctly de-duplicated; a URL with a different path capitalisation that points to the same content will not (but this is rare in practice for RSS-sourced URLs).

- **Dense news bursts compress into tall lane stacks.** The timeline assigns clusters to horizontal lanes to avoid visual overlap, stacking by time. When most clusters fall within a short time window (e.g. 193 of 238 clusters within a 32-hour window during testing), they stack vertically into a tall column rather than spreading across the full timeline width. A zoom or time-bucket control would be a natural future improvement.

- **Source filtering is client-side only.** The `/timeline` endpoint always returns all clusters regardless of source. Filtering by source happens in the browser against the already-fetched data. There is no server-side source filter query parameter.

---

## API Reference

All endpoints return `Content-Type: application/json`. The base URL is `https://news-pulse-fgub.onrender.com` in production.

### `GET /health`

Returns `200 OK` if the server is up.

```json
{ "status": "ok" }
```

---

### `GET /clusters`

Returns all clusters ordered by ID.

```json
[
  {
    "id": 1,
    "label": "ukraine / ceasefire / talks",
    "articleCount": 4,
    "startTime": "2026-09-21T14:00:00.000Z",
    "endTime": "2026-09-22T06:30:00.000Z"
  }
]
```

---

### `GET /clusters/:id`

Returns a single cluster with its full article list.

**Path parameter:** `:id` must be a positive integer.

```json
{
  "id": 1,
  "label": "ukraine / ceasefire / talks",
  "articles": [
    {
      "id": 42,
      "headline": "Ukraine and Russia exchange proposals for ceasefire",
      "source": "BBC News",
      "url": "https://...",
      "publishedAt": "2026-09-21T14:00:00.000Z"
    }
  ]
}
```

**Error responses:**
- `400 Bad Request` — `:id` is not a valid positive integer: `{"error": "Invalid cluster ID"}`
- `404 Not Found` — no cluster with that ID exists: `{"error": "Cluster not found"}`

---

### `GET /timeline`

Returns all clusters with their per-cluster source list, plus the global date range across all clusters.

```json
{
  "clusters": [
    {
      "id": 1,
      "label": "ukraine / ceasefire / talks",
      "startTime": "2026-09-21T14:00:00.000Z",
      "endTime": "2026-09-22T06:30:00.000Z",
      "articleCount": 4,
      "sources": ["BBC News", "The Guardian", "Al Jazeera"]
    }
  ],
  "range": {
    "earliest": "2026-09-15T11:23:16.000Z",
    "latest": "2026-09-23T05:30:22.000Z"
  }
}
```

Note: the frontend does not use the `range` field to compute its x-axis scale. It derives an outlier-aware scale directly from the cluster `startTime` distribution (median-based, excluding points more than 14 days from the median). The `range` field is returned for future API consumers.

---

### `POST /ingest/trigger`

Starts a new ingestion run asynchronously. Returns immediately with a job ID.

```json
{ "jobId": "26a0f241-e7a2-4873-8d9e-75b468273439" }
```

**Status codes:**
- `202 Accepted` — job started successfully
- `409 Conflict` — another ingestion job is already running: `{"error": "An ingestion job is already running"}`

---

### `GET /ingest/status/:jobId`

Polls the status of an ingestion job.

```json
{
  "jobId": "26a0f241-e7a2-4873-8d9e-75b468273439",
  "status": "completed",
  "startedAt": "2026-09-23T05:45:17.365Z",
  "finishedAt": "2026-09-23T05:46:31.298Z",
  "errorMessage": null
}
```

`status` is one of `running`, `completed`, or `failed`. `errorMessage` contains the last 10 KB of stderr if `status` is `failed`, otherwise `null`.

**Error responses:**
- `400 Bad Request` — `:jobId` is not a valid UUID: `{"error": "Invalid jobId format"}`
- `404 Not Found` — no job with that ID: `{"error": "Job not found"}`

---

## Deployment Architecture

### Why Docker on Render, not the default Node buildpack

Render's default Node.js buildpack does not include Python. The backend needs to spawn `python3` as a child process to run the scraper. The only reliable way to guarantee both runtimes are present in the same container is to use a custom Dockerfile. The Dockerfile installs Python and pip via `apt-get` before installing Node dependencies, then copies both `backend/` and `scraper/` into the image, so the Node process can spawn the Python script with a predictable path.

The frontend is deployed separately on Vercel (which handles the Next.js build natively), keeping the backend Dockerfile free of Node/frontend complexity.

### Components

| Component | Platform | What it runs |
|---|---|---|
| Frontend | Vercel | Next.js (`npm run build` + static + SSR) |
| Backend + Scraper | Render (Docker Web Service) | Express API + Python subprocess |
| Database | Neon | Serverless Postgres |

### CORS

The backend uses the `cors` npm package with a single allowed origin (`ALLOWED_ORIGIN` env var, set to the Vercel URL). Browsers making cross-origin requests from any other domain will have the response blocked by the browser's CORS enforcement. Note: server-side tools like `curl` do not enforce CORS — this is expected and correct behaviour.

---

## Testing

Testing was continuous live verification throughout development rather than a single formal test-suite pass. RSS parsing, deduplication, and idempotency were tested repeatedly against real feeds across multiple ingestion runs. Extraction fallback was tested against a live paywalled URL (NY Times, confirmed consistent 403 → `extraction_status = 'failed'` path). The clustering algorithm has 5 unit tests in `scraper/tests/test_cluster.py` covering the core matching logic (grouping threshold pass/fail, empty-word-set singleton, and label generation) against synthetic known-input sets. All 5 API endpoints were curl-tested against live data including every documented error case (400, 404, 409, 500). The full frontend/backend integration was tested live including the 409-conflict path (double-trigger) and the broken-connection recovery path in the frontend's polling hook. The complete production deployment loop — Node spawning Python → Neon write → poll → client reload, plus CORS behaviour — was verified end-to-end against the live Render and Vercel URLs.

---

## Assumptions

- URL normalisation strips common tracking parameters (`utm_*`, `fbclid`, `ref`, etc.) and lowercases scheme and host before deduplication. Path capitalisation is preserved.
- Source filtering was placed client-side (rather than as an API query parameter) because the total dataset fits comfortably in a single API response and adding a server-side filter would have added complexity without a meaningful performance benefit at this scale.
- The clustering threshold starting points (3 shared words, 0.4 ratio) were chosen based on manual inspection of real feed output before any tuning, not derived from a benchmark dataset.
- Ingestion is triggered manually (or via the API); there is no automated scheduled pipeline. Adding a cron trigger on Render would be straightforward.
- The `/timeline` endpoint returns all clusters regardless of date. The "recent 7 days" view in the frontend is a client-side filter.

---

## Future Improvements

- **TF-IDF clustering** — replace raw word-overlap with TF-IDF cosine similarity to reduce genre-based false merges (the Teesside/Sydney class of error).
- **Named entity recognition** — use spaCy or similar to identify person names, locations, and organisations as high-signal cluster features.
- **Timeline zoom / time-bucketing** — for dense news windows (many clusters in a short span), allow the user to zoom in or collapse clusters into hourly/daily buckets to reduce vertical lane stacking.
- **Incremental clustering** — avoid deleting and rebuilding all clusters on every run; only recluster articles added or modified since the last run.
- **Retry and backoff** — add configurable retry logic for transient extraction failures (timeouts, 5xx) while keeping the permanent-failure fast-path for 403s and paywalled sites.
- **NY Times extraction** — a realistic browser User-Agent header would likely bypass the current 403 block; not added because it verges on circumventing publisher intent.
- **Stemming** — apply a Porter stemmer before building word sets so "attack" and "attacks" are treated as the same token.
- **Auto-refresh** — poll for new articles on a background interval in the frontend rather than requiring a manual refresh button click.
- **Cross-source cluster merging** — currently two clusters that should be the same story but were seeded by different article orderings can remain separate. A post-pass merge step on the cluster graph would catch these.

---

## Video Walkthrough

[Watch the walkthrough](https://www.loom.com/share/2d00a39260994905b570b71158dd3ca8)
