"""
feeds.py — RSS feed registry and URL normalization.

FEEDS: list of (source_name, rss_url) tuples.
normalize_url(raw_url): strips tracking params, lowercases scheme+host,
    removes fragment.  CITEXT in the DB gives full-URL case-insensitivity
    on top of this.
"""

from urllib.parse import urlparse, urlunparse, urlencode, parse_qsl

# ─────────────────────────────────────────────────────────────────────────────
# Feed registry — 5 real public RSS feeds
# ─────────────────────────────────────────────────────────────────────────────
FEEDS = [
    ("BBC News",     "https://feeds.bbci.co.uk/news/rss.xml"),
    ("NY Times",     "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"),
    ("NPR",          "https://feeds.npr.org/1001/rss.xml"),
    ("The Guardian", "https://www.theguardian.com/world/rss"),
    ("Al Jazeera",   "https://www.aljazeera.com/xml/rss/all.xml"),
]

# ─────────────────────────────────────────────────────────────────────────────
# Tracking / noise query parameters to strip unconditionally
# ─────────────────────────────────────────────────────────────────────────────
# Exact-match tracking parameters to strip
_STRIP_PARAMS = frozenset({
    # UTM campaign parameters
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    # Google / Facebook click IDs
    "gclid", "fbclid", "msclkid", "dclid",
    # Misc tracking
    "ref", "referrer", "mc_cid", "mc_eid",
    "yclid", "igshid", "twclid", "_hsenc", "_hsmi",
    "hsa_acc", "hsa_cam", "hsa_grp", "hsa_ad", "hsa_src",
    "hsa_tgt", "hsa_kw", "hsa_mt", "hsa_net", "hsa_ver",
    # Al Jazeera
    "traffic_source",
})

# Strip any query key whose lowercased name starts with one of these prefixes
# (catches BBC's at_medium, at_campaign, at_format, etc.)
_STRIP_PREFIXES = ("at_", "utm_", "hsa_")


def normalize_url(raw_url: str) -> str:
    """
    Return a canonical form of *raw_url*:
      1. Lowercase scheme and host (path, query case preserved).
      2. Strip known tracking query parameters.
      3. Remove URL fragment (#…).

    CITEXT on articles.url handles any remaining case variations at the
    database layer, but explicit lowercasing keeps the stored values clean.
    """
    try:
        parsed = urlparse(raw_url.strip())
    except Exception:
        return raw_url  # malformed — return as-is; DB UNIQUE will still catch dupes

    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    path   = parsed.path          # preserve case (path is case-sensitive on most servers)

    # Strip tracking params; preserve order of remaining params
    filtered_qs = [
        (k, v)
        for k, v in parse_qsl(parsed.query, keep_blank_values=True)
        if k.lower() not in _STRIP_PARAMS
        and not any(k.lower().startswith(p) for p in _STRIP_PREFIXES)
    ]
    query = urlencode(filtered_qs)

    # fragment always stripped
    return urlunparse((scheme, netloc, path, parsed.params, query, ""))
