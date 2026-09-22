const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(`
      SELECT id, label, article_count, start_time, end_time
      FROM clusters
      ORDER BY id ASC;
    `);

    // Map to camelCase explicitly
    const clusters = result.rows.map(row => ({
      id: row.id,
      label: row.label,
      articleCount: row.article_count,
      startTime: row.start_time, // node-postgres parses timestamp to JS Date, or returns null
      endTime: row.end_time
    }));

    res.json(clusters);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const clusterId = parseInt(req.params.id, 10);
    // 400 if :id is not a positive integer
    if (isNaN(clusterId) || clusterId <= 0 || String(clusterId) !== req.params.id) {
      return res.status(400).json({ error: 'Invalid cluster ID' });
    }

    const clusterResult = await db.query(`
      SELECT id, label, article_count, start_time, end_time
      FROM clusters
      WHERE id = $1;
    `, [clusterId]);

    if (clusterResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cluster not found' });
    }

    const clusterRow = clusterResult.rows[0];

    const articlesResult = await db.query(`
      SELECT a.id, a.headline, a.source, a.url, a.published_at
      FROM article_cluster ac
      JOIN articles a ON ac.article_id = a.id
      WHERE ac.cluster_id = $1
      ORDER BY a.published_at ASC NULLS LAST;
    `, [clusterId]);

    const articles = articlesResult.rows.map(row => ({
      id: row.id,
      headline: row.headline,
      source: row.source,
      url: row.url,
      publishedAt: row.published_at
    }));

    res.json({
      id: clusterRow.id,
      label: clusterRow.label,
      articles: articles
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
