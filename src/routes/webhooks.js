'use strict';
const express = require('express');

/**
 * Provider callbacks. Each adapter must verify the provider's signature itself.
 * While no provider is configured these endpoints answer 503 and change nothing.
 */
module.exports = (ctx) => {
  const { pool, integrations, logger } = ctx;
  const r = express.Router();
  const raw = express.raw({ type: '*/*', limit: '1mb' });

  function handler(kind, apply) {
    return async (req, res) => {
      const adapter = integrations[kind];
      if (!adapter.configured) return res.status(503).json({ error: 'not_configured' });
      try {
        const result = await adapter.handleWebhook({ headers: req.headers, rawBody: req.body });
        await apply(result);
        res.json({ ok: true });
      } catch (err) {
        logger.error(`[webhook:${kind}]`, err.message);
        res.status(400).json({ error: 'rejected' });
      }
    };
  }

  // Expected adapter result: { reference, status: 'passed' | 'failed' }
  r.post(
    '/webhooks/liveness',
    raw,
    handler('liveness', async ({ reference, status }) => {
      if (!['passed', 'failed'].includes(status)) return;
      await pool.query(
        `UPDATE users SET liveness_status=$2, liveness_checked_at=now() WHERE liveness_reference=$1 AND liveness_status='pending'`,
        [reference, status]
      );
    })
  );

  // Expected adapter result: { reference, status: 'verified' | 'failed' }
  r.post(
    '/webhooks/leeftijd',
    raw,
    handler('ageVerification', async ({ reference, status }) => {
      if (!['verified', 'failed'].includes(status)) return;
      await pool.query(
        `UPDATE users SET age_verification_status=$2, age_verified_at=now()
          WHERE age_verification_reference=$1 AND age_verification_status='pending'`,
        [reference, status]
      );
    })
  );

  // Expected adapter result: { reference, status: 'paid' | 'failed' }
  r.post(
    '/webhooks/betalingen',
    raw,
    handler('payments', async ({ reference, status }) => {
      if (!['paid', 'failed'].includes(status)) return;
      await pool.query(`UPDATE noshow_reports SET payment_status=$2 WHERE payment_reference=$1 AND payment_status='pending'`, [
        reference,
        status,
      ]);
    })
  );

  return r;
};
