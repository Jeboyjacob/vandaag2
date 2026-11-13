'use strict';
const profileOptions = require('./lib/profile-options');
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');

const { csrfMiddleware, csrfProtect } = require('./lib/security');
const { formatTime, formatLongDate, formatDateTime } = require('./lib/time');
const { createMailer } = require('./services/mailer');
const { createNotifier } = require('./services/notifications');
const { createIntegrations } = require('./services/integrations');
const { createVideoStorage } = require('./services/storage');
const { createMatching } = require('./services/matching');
const { createDates } = require('./services/dates');
const { loadUser } = require('./middleware/auth');

function euro(cents) {
  return `€ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

function createApp({ config, pool, logger = console, overrides = {} }) {
  const mailer = overrides.mailer || createMailer(config, { logger });
  const notifier = createNotifier({ pool, mailer, config });
  const integrations = overrides.integrations || createIntegrations(config, { logger });
  const storage = createVideoStorage(config);
  const matching = createMatching({ pool, config, notifier });
  const dates = createDates({ pool, config, notifier });
  const ctx = { config, pool, mailer, notifier, integrations, storage, matching, dates, logger };

  const app = express();
  app.locals.ctx = ctx;
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'media-src': ["'self'", 'blob:'],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
          'upgrade-insecure-requests': config.isProduction ? [] : null,
        },
      },
      hsts: config.isProduction,
    })
  );
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProduction ? '7d' : 0 }));
  // Webhooks need the raw body for signature checks, so skip the parsers there.
  const urlencoded = express.urlencoded({ extended: true, limit: '100kb' });
  const json = express.json({ limit: '100kb' });
  app.use((req, res, next) => (req.path.startsWith('/webhooks/') ? next() : urlencoded(req, res, next)));
  app.use((req, res, next) => (req.path.startsWith('/webhooks/') ? next() : json(req, res, next)));

  app.use(
    session({
      store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
      name: 'sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
        maxAge: 1000 * 60 * 60 * 24 * 14,
      },
    })
  );
  app.use(csrfMiddleware);

  app.use((req, res, next) => {
    res.locals.user = null;
    res.locals.unreadCount = 0;
    res.locals.devMode = config.devMode;
    res.locals.appName = config.appName;
    res.locals.pOpts = profileOptions;
    res.locals.companyName = config.companyName;
    res.locals.paymentsConfigured = integrations.payments.configured;
    res.locals.noShowDelay = config.noShowReportDelayMinutes;
    res.locals.maxTimeChoices = config.maxTimeChoices;
    res.locals.flash = req.session.flash || [];
    delete req.session.flash;
    res.locals.path = req.path;
    res.locals.fmt = { time: formatTime, longDate: formatLongDate, dateTime: formatDateTime, euro };
    res.locals.noShowFee = euro(config.noShowFeeCents);
    req.flash = (type, text) => {
      req.session.flash = req.session.flash || [];
      req.session.flash.push({ type, text });
    };
    next();
  });
  app.use(loadUser(ctx));
  app.use(csrfProtect);

  app.use(require('./routes/webhooks')(ctx));
  app.use(require('./routes/auth')(ctx));
  app.use(require('./routes/verify')(ctx));
  app.use(require('./routes/profile')(ctx));
  app.use(require('./routes/media')(ctx));
  app.use(require('./routes/swipe')(ctx));
  app.use(require('./routes/matches')(ctx));
  app.use(require('./routes/safety')(ctx));
  app.use(require('./routes/notifications')(ctx));
  app.use('/beheer', require('./routes/admin')(ctx));

  app.get('/favicon.ico', (req, res) => res.status(204).end());

  app.get('/gezondheid', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch (_) {
      res.status(503).json({ ok: false });
    }
  });

  app.use((req, res) => res.status(404).render('error', { title: 'Niet gevonden', message: 'Deze pagina bestaat niet.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error('[fout]', err);
    res.status(500).render('error', { title: 'Er ging iets mis', message: 'Er is een onverwachte fout opgetreden. Probeer het later opnieuw.' });
  });

  return app;
}

module.exports = { createApp, euro };
