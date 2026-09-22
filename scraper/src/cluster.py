"""
cluster.py — full-recompute topic clustering (Phase 4).

Algorithm (finalized, do not modify):
  1. Load ALL articles (id, headline, summary, published_at), id-ascending.
  2. Build per-article word sets: tokenise(headline + " " + summary),
     lowercase, strip English stopwords (hardcoded ~150-word list).
  3. Compute document frequency (DF) across the full article set.
  4. Remove any word that appears in > 25% of articles (corpus-adaptive
     high-frequency filter). This eliminates words like "says", "new",
     "government" that appear everywhere and would spuriously link
     unrelated articles.
  5. Articles whose significant-word set ends up empty (all-stopword
     headline, etc.) become singleton clusters immediately — they never
     zero-overlap-match into something else.
  6. Greedy PAIRWISE best-match in id-ascending order:
       - For each new article A, compare against every already-placed
         article B (not cluster aggregates).
       - shared_count = |words_A ∩ words_B|
       - Relation test: shared_count >= 3
                        AND shared_count / min(|A|, |B|) >= 0.4
       - Join the cluster of the best-matching already-placed article;
         ties broken by which already-placed article was processed
         earlier (lower processing order index).
       - No match → new singleton cluster.
  7. Cluster label = top 2–3 most-frequent significant words across all
     members; ties broken alphabetically (for determinism).
  8. start_time/end_time = MIN/MAX published_at, ignoring NULL members.
     If every member has NULL published_at, both are NULL.
  9. Persist: DELETE all rows from clusters (CASCADE wipes article_cluster),
     then INSERT fresh clusters + article_cluster rows.
     The articles table is NEVER modified.
 10. Called from main.py as Stage 3.

Retry/idempotency: full-recompute on every run. Cluster IDs are NOT
stable across runs — this is documented, expected behaviour.
"""

import logging
import re
import time
from collections import Counter, defaultdict
from typing import Optional

import psycopg2.extras

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Static English stopword list (~150 words)
# ─────────────────────────────────────────────────────────────────────────────
_STOPWORDS: frozenset = frozenset({
    "a", "about", "above", "after", "again", "against", "all", "also", "am",
    "an", "and", "any", "are", "aren't", "as", "at", "be", "because", "been",
    "before", "being", "below", "between", "both", "but", "by", "can", "can't",
    "cannot", "com", "could", "couldn't", "did", "didn't", "do", "does",
    "doesn't", "doing", "don't", "down", "during", "each", "few", "for",
    "from", "further", "get", "gets", "got", "had", "hadn't", "has", "hasn't",
    "have", "haven't", "having", "he", "he'd", "he'll", "he's", "her", "here",
    "here's", "hers", "herself", "him", "himself", "his", "how", "how's", "i",
    "i'd", "i'll", "i'm", "i've", "if", "in", "into", "is", "isn't", "it",
    "it's", "its", "itself", "just", "let's", "like", "made", "make", "may",
    "me", "more", "most", "more", "mustn't", "my", "myself", "no", "nor",
    "not", "now", "of", "off", "on", "once", "only", "or", "other", "ought",
    "our", "ours", "ourselves", "out", "over", "own", "same", "shan't", "she",
    "she'd", "she'll", "she's", "should", "shouldn't", "so", "some", "such",
    "than", "that", "that's", "the", "their", "theirs", "them", "themselves",
    "then", "there", "there's", "these", "they", "they'd", "they'll", "they're",
    "they've", "this", "those", "through", "to", "too", "under", "until", "up",
    "us", "very", "was", "wasn't", "we", "we'd", "we'll", "we're", "we've",
    "were", "weren't", "what", "what's", "when", "when's", "where", "where's",
    "which", "while", "who", "who's", "whom", "why", "why's", "will", "with",
    "won't", "would", "wouldn't", "you", "you'd", "you'll", "you're", "you've",
    "your", "yours", "yourself", "yourselves",
    # Common news-language noise that adds no discriminating signal
    "says", "said", "say", "told", "tell", "new", "news", "report", "reports",
    "reported", "according", "amid", "over", "after", "two", "three", "four",
    "five", "one", "first", "last", "back", "year", "years", "week", "day",
    "days", "time", "way", "take", "get", "go", "going", "come", "comes",
    "coming", "see", "seen", "put", "set", "use", "used", "using",
})

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _tokenize(text: str) -> set:
    """Split on non-alphanumeric boundaries, lowercase, strip stopwords,
    keep only tokens of length >= 3."""
    tokens = re.split(r"[^a-zA-Z0-9]+", text.lower())
    return {t for t in tokens if len(t) >= 3 and t not in _STOPWORDS}


def _compute_word_sets(articles: list[dict]) -> list[set]:
    """
    Steps 2-4: build per-article significant-word sets.
    Returns a parallel list of sets (empty set allowed for edge cases).
    """
    n = len(articles)
    if n == 0:
        return []

    # Step 2: raw token sets
    raw_sets = []
    for art in articles:
        text = (art["headline"] or "") + " " + (art["summary"] or "")
        raw_sets.append(_tokenize(text))

    # Step 3: document frequency
    df: Counter = Counter()
    for ws in raw_sets:
        for w in ws:
            df[w] += 1

    # Step 4: remove words appearing in > 25% of articles
    threshold = n * 0.25
    high_freq = {w for w, cnt in df.items() if cnt > threshold}
    logger.debug(
        "Corpus-adaptive filter: %d words removed (appeared in >25%% of %d articles): %s",
        len(high_freq), n,
        sorted(high_freq)[:20],  # log first 20 only
    )

    significant = [ws - high_freq for ws in raw_sets]
    return significant


# ─────────────────────────────────────────────────────────────────────────────
# Clustering
# ─────────────────────────────────────────────────────────────────────────────

def _greedy_cluster(word_sets: list[set]) -> list[int]:
    """
    Step 6: greedy pairwise best-match.
    Returns a list of cluster_index (0-based) for each article,
    in the same order as word_sets / articles.
    """
    n = len(word_sets)
    article_cluster_idx = [-1] * n   # cluster assignment per article
    next_cluster = 0

    for i, ws_a in enumerate(word_sets):
        best_shared = 0
        best_cluster = -1
        best_placed_order = -1  # lower = placed earlier, preferred on tie

        # Empty word set → immediate singleton (step 5)
        if not ws_a:
            article_cluster_idx[i] = next_cluster
            next_cluster += 1
            logger.debug("Article %d: empty word set → singleton cluster %d", i, article_cluster_idx[i])
            continue

        for j in range(i):  # only already-placed articles
            ws_b = word_sets[j]
            if not ws_b:
                continue

            shared = len(ws_a & ws_b)
            min_len = min(len(ws_a), len(ws_b))

            if shared >= 3 and shared / min_len >= 0.4:
                # Better match if higher shared_count; tie → lower j (earlier placed)
                if shared > best_shared or (shared == best_shared and j < best_placed_order):
                    best_shared = shared
                    best_cluster = article_cluster_idx[j]
                    best_placed_order = j

        if best_cluster >= 0:
            article_cluster_idx[i] = best_cluster
            logger.debug(
                "Article %d: joined cluster %d (shared=%d with article %d)",
                i, best_cluster, best_shared, best_placed_order,
            )
        else:
            article_cluster_idx[i] = next_cluster
            logger.debug("Article %d: new singleton cluster %d", i, next_cluster)
            next_cluster += 1

    return article_cluster_idx


# ─────────────────────────────────────────────────────────────────────────────
# Label generation (step 7)
# ─────────────────────────────────────────────────────────────────────────────

def _compute_label(member_word_sets: list[set],
                   singleton_headline: str | None = None) -> str:
    """
    Label for a cluster.

    Singletons: use the article headline truncated to 50 chars (with '…' if
    truncated) so the label reads as a real news headline rather than an
    arbitrary alphabetical word list.

    Multi-article clusters: top 2–3 most-frequent significant words across
    all member word-sets; ties broken alphabetically.
    """
    if singleton_headline is not None:
        hl = singleton_headline.strip()
        return hl[:50] + "…" if len(hl) > 50 else hl

    freq: Counter = Counter()
    for ws in member_word_sets:
        for w in ws:
            freq[w] += 1

    if not freq:
        return "misc"

    # Sort: highest frequency first, then alphabetically for ties
    ranked = sorted(freq.items(), key=lambda kv: (-kv[1], kv[0]))
    top_words = [w for w, _ in ranked[:3]]
    return " / ".join(top_words)


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def run_clustering(conn) -> dict:
    """
    Full-recompute clustering.  Uses the provided *conn* (already open);
    does NOT close it.

    Returns:
        {
          "clusters_total":    int,
          "clusters_singleton": int,
          "clusters_multi":    int,
          "articles_clustered": int,
          "runtime_ms":        float,
        }
    """
    t0 = time.perf_counter()

    # ── Step 1: load articles ────────────────────────────────────────────────
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, headline, summary, published_at
              FROM articles
             ORDER BY id ASC
            """
        )
        articles = cur.fetchall()

    n = len(articles)
    logger.info("Clustering: %d articles loaded", n)
    if n == 0:
        logger.info("Clustering: nothing to cluster, skipping")
        return {"clusters_total": 0, "clusters_singleton": 0,
                "clusters_multi": 0, "articles_clustered": 0, "runtime_ms": 0.0}

    # ── Steps 2–4: word sets ─────────────────────────────────────────────────
    word_sets = _compute_word_sets(articles)

    # ── Step 6: greedy pairwise clustering ───────────────────────────────────
    assignments = _greedy_cluster(word_sets)

    # ── Group articles by cluster index ─────────────────────────────────────
    cluster_members: dict[int, list[int]] = defaultdict(list)  # cluster_idx → [article row idx]
    for art_idx, cl_idx in enumerate(assignments):
        cluster_members[cl_idx].append(art_idx)

    # ── Steps 7 & 8: compute label, start_time, end_time ────────────────────
    cluster_data = []
    for cl_idx in sorted(cluster_members.keys()):
        member_idxs = cluster_members[cl_idx]
        member_word_sets = [word_sets[i] for i in member_idxs]

        # Singletons: use headline as label; multi-article: frequency-based.
        if len(member_idxs) == 1:
            singleton_hl = articles[member_idxs[0]]["headline"]
            label = _compute_label(member_word_sets, singleton_headline=singleton_hl)
        else:
            label = _compute_label(member_word_sets)

        # MIN/MAX published_at, excluding NULLs
        pub_dates = [
            articles[i]["published_at"]
            for i in member_idxs
            if articles[i]["published_at"] is not None
        ]
        start_time = min(pub_dates) if pub_dates else None
        end_time   = max(pub_dates) if pub_dates else None

        article_ids = [articles[i]["id"] for i in member_idxs]

        cluster_data.append({
            "label":         label,
            "start_time":    start_time,
            "end_time":      end_time,
            "article_count": len(article_ids),
            "article_ids":   article_ids,
        })

    # ── Step 9: persist ──────────────────────────────────────────────────────
    with conn.cursor() as cur:
        # DELETE cascades to article_cluster automatically
        cur.execute("DELETE FROM clusters;")
        logger.debug("Deleted existing clusters (cascade to article_cluster)")

        # Bulk INSERT all cluster rows in one round-trip, collect new DB ids.
        cluster_rows = [
            (cd["label"], cd["start_time"], cd["end_time"], cd["article_count"])
            for cd in cluster_data
        ]
        returned_rows = psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO clusters (label, start_time, end_time, article_count)
            VALUES %s
            RETURNING id
            """,
            cluster_rows,
            page_size=10000,
            fetch=True
        )
        db_ids = [row["id"] for row in returned_rows]

        # Bulk INSERT all article_cluster rows in a single round-trip.
        ac_rows = []
        for db_id, cd in zip(db_ids, cluster_data):
            for aid in cd["article_ids"]:
                ac_rows.append((aid, db_id))

        if ac_rows:
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO article_cluster (article_id, cluster_id) VALUES %s",
                ac_rows,
            )

    conn.commit()

    runtime_ms = (time.perf_counter() - t0) * 1000
    singletons = sum(1 for cd in cluster_data if cd["article_count"] == 1)
    multi       = len(cluster_data) - singletons

    logger.info(
        "Clustering complete: %d clusters (%d singleton, %d multi-article), %.1f ms",
        len(cluster_data), singletons, multi, runtime_ms,
    )

    return {
        "clusters_total":     len(cluster_data),
        "clusters_singleton": singletons,
        "clusters_multi":     multi,
        "articles_clustered": n,
        "runtime_ms":         round(runtime_ms, 1),
    }
