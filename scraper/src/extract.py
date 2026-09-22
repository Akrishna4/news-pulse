"""
extract.py — article full-body extraction (Phase 3).

For every article row whose extraction_status = 'pending':
  1. Fetch the article URL with httpx (timeout=10s, follow_redirects=True).
  2. Run trafilatura.extract() on the response HTML.
  3. On success (non-empty text): write body, set extraction_status='success'.
  4. On any failure (HTTP error, timeout, connection error, empty trafilatura
     result): leave body NULL, set extraction_status='failed'. Log reason.
     Do NOT retry on future runs (see decision rationale below).

Retry policy — 'failed' is PERMANENT:
  The vast majority of failures are structural: paywalls, JS-rendered SPAs,
  CDN bot-detection. Re-attempting on every pipeline run would hammer the
  same URL repeatedly and risk rate-limiting. This is consistent with the
  documented known limitation: "No retry/backoff on failed article-page fetches."
  Manual recovery: `UPDATE articles SET extraction_status='pending' WHERE id=...`

Per-article isolation:
  Each fetch+extract is wrapped in its own try/except. One article failing
  does NOT abort any others.
"""

import logging
from typing import Optional

import httpx
import trafilatura

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────
FETCH_TIMEOUT  = 10       # seconds
BATCH_SIZE     = 50       # articles per DB cursor fetch (avoids loading all at once)

# httpx headers that reduce bot-detection false positives
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; NewsPulse/1.0; "
        "+https://github.com/news-pulse)"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


# ─────────────────────────────────────────────────────────────────────────────
# Failure reason helpers (for logging — all land in 'failed' status)
# ─────────────────────────────────────────────────────────────────────────────

def _classify_failure(exc: Exception) -> str:
    """Return a short string describing the failure kind for log clarity."""
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    if isinstance(exc, httpx.HTTPStatusError):
        return f"http_{exc.response.status_code}"
    if isinstance(exc, httpx.RequestError):
        return f"connection_error ({type(exc).__name__})"
    return f"unknown ({type(exc).__name__})"


def _fetch_html(url: str) -> Optional[str]:
    """
    Fetch the article page.  Returns raw HTML string, or None on failure.
    Raises nothing — all exceptions are caught and re-raised to the caller
    (which handles them per-article).
    """
    with httpx.Client(
        timeout=FETCH_TIMEOUT,
        follow_redirects=True,
        headers=_HEADERS,
    ) as client:
        response = client.get(url)
        response.raise_for_status()          # raises HTTPStatusError on 4xx/5xx
        return response.text


def _extract_body(html: str) -> Optional[str]:
    """
    Run trafilatura on *html*.  Returns extracted text, or None.
    include_comments=False: exclude comment sections.
    include_tables=True: keep structured data.
    """
    result = trafilatura.extract(
        html,
        include_comments=False,
        include_tables=True,
        no_fallback=False,          # allow fallback extractors
    )
    return result if result and result.strip() else None


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def run_extraction(conn) -> dict:
    """
    Fetch and extract body text for all articles with extraction_status='pending'.
    Uses the provided *conn* (already open); does NOT close it.

    Returns:
        {
          "attempted":  int,   # articles tried
          "succeeded":  int,   # extraction_status set to 'success'
          "failed":     int,   # extraction_status set to 'failed'
        }
    """
    counts = {"attempted": 0, "succeeded": 0, "failed": 0}

    # Fetch all pending IDs upfront (avoids cursor-vs-update conflicts).
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, url
              FROM articles
             WHERE extraction_status = 'pending'
             ORDER BY id
            """
        )
        pending = cur.fetchall()

    total = len(pending)
    logger.info("Extraction: %d articles pending", total)

    for i, row in enumerate(pending, 1):
        article_id = row["id"]
        url        = row["url"]
        counts["attempted"] += 1

        logger.debug("[%d/%d] Fetching %s", i, total, url)
        new_status = "failed"
        body       = None

        try:
            html = _fetch_html(url)
            if html is None:
                logger.warning("[%d/%d] Empty response body (url=%s)", i, total, url)
            else:
                body = _extract_body(html)
                if body:
                    new_status = "success"
                    logger.debug(
                        "[%d/%d] Extracted %d chars (url=%s)", i, total, len(body), url
                    )
                else:
                    logger.info(
                        "[%d/%d] trafilatura returned empty — failure reason: empty_result "
                        "(url=%s)", i, total, url
                    )

        except httpx.TimeoutException as exc:
            logger.info(
                "[%d/%d] failure reason: timeout after %ds (url=%s)",
                i, total, FETCH_TIMEOUT, url,
            )
        except httpx.HTTPStatusError as exc:
            logger.info(
                "[%d/%d] failure reason: http_%d (url=%s)",
                i, total, exc.response.status_code, url,
            )
        except httpx.RequestError as exc:
            logger.info(
                "[%d/%d] failure reason: connection_error %s (url=%s)",
                i, total, type(exc).__name__, url,
            )
        except Exception as exc:
            logger.warning(
                "[%d/%d] failure reason: unexpected %s: %s (url=%s)",
                i, total, type(exc).__name__, exc, url,
            )

        # Write result back — isolated per article
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE articles
                       SET body              = %(body)s,
                           extraction_status = %(status)s
                     WHERE id = %(id)s
                    """,
                    {"body": body, "status": new_status, "id": article_id},
                )
            conn.commit()
        except Exception as db_exc:
            logger.error(
                "[%d/%d] DB write failed for article id=%s: %s",
                i, total, article_id, db_exc,
            )
            conn.rollback()
            # Still counts as failed from pipeline perspective
            new_status = "failed"

        if new_status == "success":
            counts["succeeded"] += 1
        else:
            counts["failed"] += 1

    logger.info(
        "Extraction complete: %d attempted, %d succeeded, %d failed",
        counts["attempted"], counts["succeeded"], counts["failed"],
    )
    return counts
