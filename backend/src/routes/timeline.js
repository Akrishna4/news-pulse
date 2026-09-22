const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    // 1. Get global range (ignoring nulls)
    const rangeResult = await db.query(`
      SELECT MIN(start_time) as earliest, MAX(end_time) as latest
      FROM clusters;
    `);

    let range = null;
    if (rangeResult.rows.length > 0 && rangeResult.rows[0].earliest) {
      range = {
        earliest: rangeResult.rows[0].earliest,
        latest: rangeResult.rows[0].latest
      };
    }

    // 2. Get all clusters with their unique sources
    const clustersResult = await db.query(`
      SELECT 
        c.id, c.label, c.start_time, c.end_time, c.article_count,
        array_agg(DISTINCT a.source) as sources
      FROM clusters c
      LEFT JOIN article_cluster ac ON c.id = ac.cluster_id
      LEFT JOIN articles a ON ac.article_id = a.id
      GROUP BY c.id
      ORDER BY c.id ASC;
    `);

    const clusters = clustersResult.rows.map(row => ({
      id: row.id,
      label: row.label,
      startTime: row.start_time,
      endTime: row.end_time,
      articleCount: row.article_count,
      sources: row.sources.filter(Boolean) // remove nulls if any
    }));

    res.json({
      clusters: clusters,
      range: range
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
