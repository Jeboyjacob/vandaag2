'use strict';
const { loadConfig } = require('./config');
const { createPool, migrate } = require('./db');
const { createApp } = require('./app');
const { notifyNewPeople } = require('./services/new-people');
const { cleanupOldData } = require('./services/cleanup');

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
  // Elk half uur: melding als er nieuwe mensen zijn (zie services/new-people.js).
  const ctx = app.locals.ctx;
  const timer = setInterval(() => {
    notifyNewPeople({ pool, config, notifier: ctx.notifier }).catch((e) => console.error('Melding nieuwe mensen mislukt:', e.message));
  }, 30 * 60 * 1000);
  timer.unref();
  // Opruimen van afgelopen matches en oude meldingen: bij het opstarten en daarna elke 6 uur.
  const clean = () =>
    cleanupOldData({ pool, config })
      .then((r) => (r.matches || r.notifications) && console.log(`Opruimen: ${r.matches} matches, ${r.notifications} meldingen verwijderd`))
      .catch((e) => console.error('Opruimen mislukt:', e.message));
  clean();
  setInterval(clean, 6 * 60 * 60 * 1000).unref();
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
