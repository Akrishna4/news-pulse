"""
ingest.py — RSS ingestion and normalization pipeline.

Entry point called by main.py.  Does NOT do article-body extraction
(that's Phase 3) and does NOT do clustering (that's Phase 4).

Dedup strategy: INSERT ... ON CONFLICT (url) DO NOTHING
  Rationale: avoids a separate SELECT round-trip per article; the DB
  enforces uniqueness atomically via the UNIQUE+CITEXT constraint;
  psycopg2 rowcount == 0 tells us it was a duplicate so we can count
  new vs skipped precisely without extra queries.
"""

import calendar
import logging
import re
import time
from datetime import datetime, timezone
from typing import Optional

import feedparser
from dateutil import parser as dateutil_parser

from .db import get_connection
from .feeds import FEEDS, normalize_url

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _parse_published_at(entry) -> Optional[datetime]:
    """
    Return a timezone-aware datetime for the entry's publication time.

    Priority:
      1. feedparser's parsed struct-time (entry.published_parsed or
         entry.updated_parsed) — most reliable.
      2. Raw string via python-dateutil.
      3. None — caller stores NULL; query layer falls back to fetched_at.
    """
    # feedparser exposes a time.struct_time in UTC when it can parse the date
    for attr in ("published_parsed", "updated_parsed"):
        st = getattr(entry, attr, None)
        if st is not None:
            try:
                ts = calendar.timegm(st)  # struct_time → UTC epoch (no mktime local-TZ error)
                return datetime.fromtimestamp(ts, tz=timezone.utc)
            except Exception:
                pass

    # Fall back to raw string
    for attr in ("published", "updated"):
        raw = getattr(entry, attr, None)
        if raw:
            try:
                dt = dateutil_parser.parse(raw)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt
            except Exception:
                pass

    return None  # will be stored as NULL


def _best_summary(entry) -> str:
    """
    Return the best available summary text.

    Prefers content:encoded (full article body in some feeds) over
    description/summary, but we only want a summary here — if
    content:encoded is very long, truncate to 1 000 chars so we don't
    bloat the articles table before Phase 3 (body extraction).

    Returns '' (empty string) when nothing is available — matches the
    column DEFAULT ''.
    """
    # content:encoded → entry.content list, type text/html
    content_list = getattr(entry, "content", [])
    for item in content_list:
        value = item.get("value", "").strip()
        if value:
            clean = re.sub(r"<[^>]+>", " ", value)
            clean = re.sub(r"\s+", " ", clean).strip()
            return clean[:1000]

    for attr in ("summary", "description"):
        raw = getattr(entry, attr, None)
        if raw:
            clean = re.sub(r"<[^>]+>", " ", raw)
            clean = re.sub(r"\s+", " ", clean).strip()
            return clean[:1000]

    return ""


def _extract_entry(entry, source_name: str) -> Optional[dict]:
    """
    Normalize one feedparser entry into a dict ready for DB insertion.
    Returns None if mandatory fields are missing.
    """
    # URL is mandatory
    url_raw = getattr(entry, "link", None) or getattr(entry, "id", None)
    if not url_raw:
        logger.warning("[%s] entry has no link/id — skipping", source_name)
        return None

    url = normalize_url(url_raw)
    if not url:
        logger.warning("[%s] URL normalized to empty — skipping", source_name)
        return None

    # Headline is mandatory
    headline = (getattr(entry, "title", None) or "").strip()
    if not headline:
        logger.warning("[%s] entry has no title (url=%s) — skipping", source_name, url)
        return None

    summary      = _best_summary(entry)
    published_at = _parse_published_at(entry)

    return {
        "url":          url,
        "source":       source_name,
        "headline":     headline,
        "summary":      summary,
        "published_at": published_at,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Per-feed ingestion
# ─────────────────────────────────────────────────────────────────────────────

def _ingest_feed(conn, source_name: str, feed_url: str) -> dict:
    """
    Fetch, parse, and upsert one RSS feed.  Returns counts dict.
    Raises no exceptions — all errors are caught and logged.
    """
    counts = {"found": 0, "new": 0, "skipped": 0, "errors": 0}

    try:
        logger.info("[%s] Fetching %s", source_name, feed_url)
        feed = feedparser.parse(feed_url)

        if feed.bozo and not feed.entries:
            # bozo=True means malformed XML; if there are still entries
            # feedparser managed partial parsing — keep going.
            raise ValueError(
                f"Feed unreachable or completely malformed: {feed.bozo_exception}"
            )

        logger.info("[%s] %d entries found", source_name, len(feed.entries))

    except Exception as exc:
        logger.error("[%s] Feed-level failure — skipping feed. Error: %s", source_name, exc)
        counts["errors"] += 1
        return counts

    with conn.cursor() as cur:
        for entry in feed.entries:
            counts["found"] += 1
            try:
                record = _extract_entry(entry, source_name)
                if record is None:
                    counts["errors"] += 1
                    continue

                cur.execute(
                    """
                    INSERT INTO articles (url, headline, summary, source, published_at)
                    VALUES (%(url)s, %(headline)s, %(summary)s, %(source)s, %(published_at)s)
                    ON CONFLICT (url) DO NOTHING
                    """,
                    record,
                )
                if cur.rowcount == 1:
                    counts["new"] += 1
                    logger.debug("[%s] NEW  %s", source_name, record["url"])
                else:
                    counts["skipped"] += 1
                    logger.debug("[%s] DUP  %s", source_name, record["url"])

            except Exception as exc:
                logger.warning(
                    "[%s] Entry-level error — skipping entry. Error: %s", source_name, exc
                )
                counts["errors"] += 1
                conn.rollback()  # discard partial state for this entry
                continue

    conn.commit()
    return counts


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def run_ingestion(job_id: Optional[str] = None) -> dict:
    """
    Ingest all feeds in FEEDS.  Returns a summary dict:
        {
          "feeds_attempted": int,
          "feeds_failed":    int,
          "articles_found":  int,
          "articles_new":    int,
        }

    job_id is used only for log correlation; it does NOT update the
    ingestion_jobs table here (that's main.py's responsibility so the
    DB write happens in one place).
    """
    logger.info("=== Ingestion run start (job_id=%s) ===", job_id)
    conn = get_connection()

    totals = {
        "feeds_attempted": 0,
        "feeds_failed":    0,
        "articles_found":  0,
        "articles_new":    0,
    }

    try:
        for source_name, feed_url in FEEDS:
            totals["feeds_attempted"] += 1
            counts = _ingest_feed(conn, source_name, feed_url)
            totals["articles_found"] += counts["found"]
            totals["articles_new"]   += counts["new"]
            if counts["errors"] > 0 and counts["new"] == 0 and counts["found"] == 0:
                totals["feeds_failed"] += 1
    finally:
        conn.close()

    logger.info(
        "=== Ingestion run complete: %d feeds, %d new articles out of %d found ===",
        totals["feeds_attempted"],
        totals["articles_new"],
        totals["articles_found"],
    )
    return totals
