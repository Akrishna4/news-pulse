const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const db = require('../db');

const router = express.Router();

// Helper to check UUID format
const isValidUUID = (uuid) => {
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return regex.test(uuid);
};

router.post('/trigger', async (req, res, next) => {
  try {
    // Check if any job is currently running
    const checkResult = await db.query(`
      SELECT id FROM ingestion_jobs WHERE status = 'running' LIMIT 1;
    `);

    if (checkResult.rows.length > 0) {
      return res.status(409).json({ error: 'An ingestion job is already running' });
    }

    // Insert new job (Postgres gen_random_uuid() handles ID generation)
    // We assume ingestion_jobs table has id, status, started_at, finished_at, error_message columns.
    const insertResult = await db.query(`
      INSERT INTO ingestion_jobs (status, started_at)
      VALUES ('running', NOW())
      RETURNING id;
    `);

    const jobId = insertResult.rows[0].id;

    // Immediately return 202 response
    res.status(202).json({ jobId });

    // Spawn the subprocess
    // Resolve scraper directory relative to this file
    const scraperDir = path.resolve(__dirname, '../../../scraper');

    // In development, python3 lives inside the .venv; prepend it so all deps
    // (psycopg2, httpx, trafilatura…) resolve correctly.
    // In production (Docker), python3 is installed system-wide via apt-get and
    // there is no .venv, so we leave PATH unmodified.
    const spawnEnv = process.env.NODE_ENV !== 'production'
      ? { ...process.env, PATH: `${path.join(scraperDir, '.venv', 'bin')}:${process.env.PATH}` }
      : process.env;

    const pyProcess = spawn('python3', ['src/main.py'], {
      cwd: scraperDir,
      env: spawnEnv
    });

    let stderrOutput = '';

    pyProcess.stdout.on('data', (data) => {
      console.log(`[Ingest ${jobId}] stdout: ${data}`);
    });

    pyProcess.stderr.on('data', (data) => {
      console.error(`[Ingest ${jobId}] stderr: ${data}`);
      // Accumulate stderr for error message in case of failure. Keep it reasonably sized.
      stderrOutput += data.toString();
      if (stderrOutput.length > 10000) {
        stderrOutput = stderrOutput.substring(stderrOutput.length - 10000);
      }
    });

    pyProcess.on('close', async (code) => {
      console.log(`[Ingest ${jobId}] child process exited with code ${code}`);
      
      let status = 'completed';
      let errorMessage = null;

      if (code !== 0) {
        status = 'failed';
        errorMessage = stderrOutput.trim() || `Process exited with code ${code}`;
      }

      try {
        await db.query(`
          UPDATE ingestion_jobs
          SET status = $1, finished_at = NOW(), error_message = $2
          WHERE id = $3;
        `, [status, errorMessage, jobId]);
      } catch (err) {
        console.error(`[Ingest ${jobId}] failed to update job status in DB:`, err);
      }
    });

    pyProcess.on('error', async (err) => {
      console.error(`[Ingest ${jobId}] failed to start subprocess:`, err);
      try {
        await db.query(`
          UPDATE ingestion_jobs
          SET status = 'failed', finished_at = NOW(), error_message = $1
          WHERE id = $2;
        `, [err.message, jobId]);
      } catch (dbErr) {
        console.error(`[Ingest ${jobId}] failed to update job status in DB:`, dbErr);
      }
    });

  } catch (error) {
    next(error);
  }
});

router.get('/status/:jobId', async (req, res, next) => {
  try {
    const { jobId } = req.params;

    if (!isValidUUID(jobId)) {
      return res.status(400).json({ error: 'Invalid jobId format' });
    }

    const jobResult = await db.query(`
      SELECT id, status, started_at, finished_at, error_message
      FROM ingestion_jobs
      WHERE id = $1;
    `, [jobId]);

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const row = jobResult.rows[0];

    res.json({
      jobId: row.id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      errorMessage: row.error_message
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
