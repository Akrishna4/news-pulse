const { Pool } = require('pg');

// Instantiate exactly once at module load.
// When other files require('./db'), Node.js will return the cached exports,
// meaning this same Pool instance is reused by every route file.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};
