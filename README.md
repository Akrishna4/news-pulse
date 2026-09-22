# News Pulse — Topic-Clustered News Timeline

STUB — Phase 0 placeholder only. Full README is written in Phase 10 and must cover:
overview, architecture, tech stack, news sources used, setup, environment variables,
running locally, database setup, ingestion pipeline, clustering approach + threshold
reasoning, known limitations, API documentation, deployment architecture, live URLs,
video walkthrough link, assumptions, future improvements.

Known assumptions that MUST be documented here in Phase 10 (do not lose these):
- Missing `pubDate` falls back to `ingested_at`.
- No retry/backoff on failed article-page fetches.
- Cluster IDs are not stable across ingestion runs (full recluster every run).
- Source filtering happens client-side, not via a query parameter.
- articles.url uses CITEXT, so duplicate detection is fully
   case-insensitive across the whole URL, not just scheme+host.
- Dense news bursts (e.g. 193 of 238 clusters within a 32-hour window)
   compress into a tall stack of lanes rather than spreading horizontally,
   since lane-assignment stacks by time-overlap; a zoom/bucket control
   would be a natural future improvement.
