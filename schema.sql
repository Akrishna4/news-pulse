-- News Pulse — database schema
-- Phase 1: full table definitions.
--
-- Applied manually against Neon with:
--   psql "$DATABASE_URL" -f schema.sql
--
-- Re-running this file is idempotent (CREATE TABLE IF NOT EXISTS, etc.).
-- To reset completely: DROP TABLE article_cluster, clusters, articles, ingestion_jobs CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- EXTENSION
-- ─────────────────────────────────────────────────────────────────────────────
-- citext gives case-insensitive equality for the url UNIQUE constraint without
-- requiring a functional index. Available on Neon by default.
CREATE EXTENSION IF NOT EXISTS citext;

-- ─────────────────────────────────────────────────────────────────────────────
-- articles
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS articles (
    id            SERIAL      PRIMARY KEY,

    -- Normalized URL: scheme+host lowercased, tracking params stripped.
    -- citext makes the UNIQUE constraint case-insensitive, matching the
    -- normalization contract ("lowercase scheme+host only").
    url           CITEXT      NOT NULL UNIQUE,

    headline      TEXT        NOT NULL,
    summary       TEXT        NOT NULL DEFAULT '',
    source        TEXT        NOT NULL,          -- e.g. "BBC", "Reuters"
    published_at  TIMESTAMPTZ,
    fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Full article body text fetched in Phase 3 (trafilatura extraction).
    -- NULL until extraction runs or if extraction fails.
    body              TEXT,

    -- pending → success | failed
    -- 'pending': not yet attempted (default for new rows).
    -- 'success': trafilatura returned non-empty text, stored in body.
    -- 'failed':  fetch or extraction failed; body stays NULL; NOT retried.
    extraction_status TEXT NOT NULL DEFAULT 'pending'
                          CHECK (extraction_status IN ('pending','success','failed'))
);

CREATE INDEX IF NOT EXISTS idx_articles_published_at
    ON articles (published_at DESC);

CREATE INDEX IF NOT EXISTS idx_articles_source
    ON articles (source);

CREATE INDEX IF NOT EXISTS idx_articles_extraction_status
    ON articles (extraction_status)
    WHERE extraction_status = 'pending';  -- partial index: only rows that need work


-- ─────────────────────────────────────────────────────────────────────────────
-- clusters
-- ─────────────────────────────────────────────────────────────────────────────
-- Fully rebuilt on every ingestion run; IDs are NOT stable across runs.
-- (Known limitation — documented in README.)
CREATE TABLE IF NOT EXISTS clusters (
    id            SERIAL      PRIMARY KEY,

    -- Top 2–3 significant words that label this cluster.
    label         TEXT        NOT NULL,

    -- Earliest published_at among member articles.
    -- NULL when every member article has a NULL published_at.
    start_time    TIMESTAMPTZ,

    -- Latest published_at among member articles.
    -- NULL when every member article has a NULL published_at.
    end_time      TIMESTAMPTZ,

    -- Total count of member articles (denormalised for fast API responses).
    article_count INTEGER     NOT NULL DEFAULT 0,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clusters_start_time
    ON clusters (start_time DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- article_cluster  (join table)
-- ─────────────────────────────────────────────────────────────────────────────
-- ON DELETE CASCADE on both FKs: wiping clusters also wipes this table,
-- which is exactly what the full-recompute strategy does each run.
CREATE TABLE IF NOT EXISTS article_cluster (
    article_id    INTEGER     NOT NULL
                                REFERENCES articles  (id) ON DELETE CASCADE,
    cluster_id    INTEGER     NOT NULL
                                REFERENCES clusters  (id) ON DELETE CASCADE,
    PRIMARY KEY (article_id, cluster_id)
);

CREATE INDEX IF NOT EXISTS idx_article_cluster_cluster_id
    ON article_cluster (cluster_id);

CREATE INDEX IF NOT EXISTS idx_article_cluster_article_id
    ON article_cluster (article_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- ingestion_jobs
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ingestion_jobs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- running → completed | failed
    -- 'pending' is intentionally absent: jobs are inserted directly as 'running'
    -- by both main.py and the Node API. 'completed' is the deliberate rename
    -- from the originally-mistaken 'success' value (fixed in Phase 5).
    status          TEXT        NOT NULL DEFAULT 'running'
                                    CHECK (status IN ('running','completed','failed')),

    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,

    -- Counts filled in by the scraper on completion.
    articles_found  INTEGER,
    articles_new    INTEGER,

    -- Populated on failure; holds the last N bytes of scraper stderr.
    error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status
    ON ingestion_jobs (status);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_started_at
    ON ingestion_jobs (started_at DESC);
