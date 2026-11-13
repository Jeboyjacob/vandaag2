'use strict';
const { loadConfig } = require('../src/config');
const { createPool, migrate } = require('../src/db');

(async () => {
  const pool = createPool(loadConfig());
  try {
    await migrate(pool);
    console.log('Database is up-to-date.');
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
