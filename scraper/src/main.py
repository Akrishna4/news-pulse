"""
main.py — standalone entrypoint for the News Pulse scraper pipeline.

Pipeline executed in one run:
  1. Ingestion  (Phase 2): fetch RSS feeds, normalize, upsert new articles.
  2. Extraction (Phase 3): for every article still at extraction_status='pending',
     fetch its page and run trafilatura. Articles at 'failed' are NOT retried.
  3. Clustering (Phase 4): full recompute of clusters + article_cluster tables.
     (Skipped silently until cluster.py is implemented.)

Usage (local):
    cd scraper
    source .venv/bin/activate
    # Fill DATABASE_URL in scraper/.env first, then:
    python src/main.py

Usage (from Node child_process.spawn — Phase 5):
    spawn("python", ["src/main.py", "<jobId>"], { cwd: "<repo>/scraper", env: process.env })

Exit codes:
    0  — completed (all three stages ran without a fatal error)
    1  — fatal error (DB connection failed, or an unhandled stage exception)

stdout (one JSON line, parsed by Node):
    {"status":"completed","articles_found":<n>,"articles_new":<n>,
     "extracted_succeeded":<n>,"extracted_failed":<n>}

All logging goes to stderr so stdout stays machine-parseable.

SSL note: On macOS with a standalone Python 3.11 install, Python doesn't find
the system keychain. We point SSL_CERT_FILE at certifi's bundle before any
network import — this is a no-op on Linux/Docker where the system CA is present.
"""

# ── SSL fix (macOS only, harmless on Linux) ──────────────────────────────────
import os as _os
try:
    import certifi as _certifi
    _os.environ.setdefault("SSL_CERT_FILE",       _certifi.where())
    _os.environ.setdefault("REQUESTS_CA_BUNDLE",  _certifi.where())
except ImportError:
    pass  # certifi not installed — rely on system CA bundle

# ── Load .env for standalone local runs (no-op when spawned by Node) ─────────
# Only attempted if python-dotenv is installed; not required in Docker.
try:
    from dotenv import load_dotenv as _load_dotenv
    import pathlib as _pathlib
    _env_path = _pathlib.Path(__file__).resolve().parent.parent / ".env"
    _load_dotenv(_env_path, override=False)
except ImportError:
    pass
# ─────────────────────────────────────────────────────────────────────────────

import json
import logging
import os
import sys
import uuid

# ── Logging: everything → stderr so stdout stays clean JSON ──────────────────
logging.basicConfig(
    stream=sys.stderr,
    level=logging.DEBUG if os.environ.get("NODE_ENV") != "production" else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
logger = logging.getLogger("main")

# ── Ensure src package is importable regardless of cwd ───────────────────────
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.db      import get_connection
from src.ingest  import run_ingestion
from src.extract import run_extraction
from src.cluster import run_clustering


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _update_job(conn, job_id: str, status: str,
                ingest_totals: dict | None = None,
                extract_totals: dict | None = None,
                error_message: str | None = None):
    """Persist final job state to ingestion_jobs."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE ingestion_jobs
               SET status         = %(status)s,
                   finished_at    = NOW(),
                   articles_found = %(articles_found)s,
                   articles_new   = %(articles_new)s,
                   error_message  = %(error_message)s
             WHERE id = %(id)s
            """,
            {
                "id":             job_id,
                "status":         status,
                "articles_found": ingest_totals.get("articles_found") if ingest_totals else None,
                "articles_new":   ingest_totals.get("articles_new")   if ingest_totals else None,
                "error_message":  error_message,
            },
        )
    conn.commit()


def _abort(conn, job_id: str, ingest_totals: dict | None,
           exc: Exception, stage: str) -> None:
    """Log, update the job row, print JSON, and exit 1."""
    logger.exception("%s failed with unhandled exception", stage)
    try:
        _update_job(conn, job_id, "failed",
                    ingest_totals=ingest_totals,
                    error_message=f"{stage}: {exc}")
    except Exception:
        pass
    conn.close()
    print(json.dumps({"status": "failed", "stage": stage, "error": str(exc)}),
          flush=True)
    sys.exit(1)


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    job_id = sys.argv[1] if len(sys.argv) > 1 else str(uuid.uuid4())
    logger.info("Pipeline start (job_id=%s)", job_id)

    # ── DB connection for job tracking ────────────────────────────────────────
    try:
        conn = get_connection()
    except Exception as exc:
        logger.critical("Cannot connect to database: %s", exc)
        print(json.dumps({"status": "failed", "error": str(exc)}), flush=True)
        sys.exit(1)

    # Mark job running
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ingestion_jobs (id, status)
                VALUES (%(id)s, 'running')
                ON CONFLICT (id) DO UPDATE SET status = 'running'
                """,
                {"id": job_id},
            )
        conn.commit()
    except Exception as exc:
        logger.error("Could not mark job as running: %s", exc)

    # ── Stage 1: Ingestion ────────────────────────────────────────────────────
    try:
        ingest_totals = run_ingestion(job_id=job_id)
    except Exception as exc:
        _abort(conn, job_id, None, exc, "ingestion")

    # ── Stage 2: Extraction ───────────────────────────────────────────────────
    try:
        extract_totals = run_extraction(conn)
    except Exception as exc:
        _abort(conn, job_id, ingest_totals, exc, "extraction")

    # ── Stage 3: Clustering ───────────────────────────────────────────────────
    try:
        cluster_totals = run_clustering(conn)
    except Exception as exc:
        _abort(conn, job_id, ingest_totals, exc, "clustering")

    # ── Finalise ──────────────────────────────────────────────────────────────
    try:
        _update_job(conn, job_id, "completed",
                    ingest_totals=ingest_totals,
                    extract_totals=extract_totals)
    except Exception as exc:
        logger.warning("Could not mark job as completed: %s", exc)

    conn.close()

    result = {
        "status":              "completed",
        "articles_found":      ingest_totals["articles_found"],
        "articles_new":        ingest_totals["articles_new"],
        "extracted_succeeded": extract_totals["succeeded"],
        "extracted_failed":    extract_totals["failed"],
        "clusters_total":      cluster_totals["clusters_total"],
        "clusters_singleton":  cluster_totals["clusters_singleton"],
        "clusters_multi":      cluster_totals["clusters_multi"],
        "clustering_ms":       cluster_totals["runtime_ms"],
    }
    print(json.dumps(result), flush=True)
    logger.info("Pipeline complete: %s", result)
    sys.exit(0)


if __name__ == "__main__":
    main()
