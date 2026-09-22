const express = require('express');
const cors = require('cors');

const clustersRouter = require('./routes/clusters');
const timelineRouter = require('./routes/timeline');
const ingestRouter = require('./routes/ingest');

const app = express();

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN,
  methods: ['GET', 'POST']
}));

app.use(express.json());

// Health check for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Routes
app.use('/clusters', clustersRouter);
app.use('/timeline', timelineRouter);
app.use('/ingest', ingestRouter);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

module.exports = app;
