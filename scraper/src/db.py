"""
db.py — thin database connection helper.

Opens one psycopg2 connection from DATABASE_URL (must include sslmode=require
for Neon).  Callers are responsible for commit/rollback and closing.
"""

import os
import psycopg2
from psycopg2.extras import RealDictCursor


def get_connection():
    """Return a new psycopg2 connection using DATABASE_URL from the environment."""
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError(
            "DATABASE_URL environment variable is not set. "
            "Copy scraper/.env.example to scraper/.env and fill it in."
        )
    return psycopg2.connect(database_url, cursor_factory=RealDictCursor)
