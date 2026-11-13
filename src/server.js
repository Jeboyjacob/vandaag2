'use strict';
const { loadConfig } = require('./config');
const { createPool, migrate } = require('./db');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const pool = createPool(config);
  await migrate(pool);
  const app = createApp({ config, pool });
  const server = app.listen(config.port, () => {
    console.log(`Server draait op poort ${config.port} (${config.nodeEnv})`);
    if (config.devMode) {
      console.warn('\n*** ONTWIKKELMODUS ACTIEF — niet geschikt voor echte gebruikers ***\n');
    }
  });
  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  const refused = err.code === 'ECONNREFUSED' || (err.errors || []).some((e) => e.code === 'ECONNREFUSED');
  if (refused) {
    console.error('Starten mislukt: kan geen verbinding maken met de database. Draait PostgreSQL (bijv. Postgres.app)?');
  } else {
    console.error('Starten mislukt:', err.message || err.code || err);
  }
  process.exit(1);
});
