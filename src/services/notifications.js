'use strict';

/**
 * Notifications are always stored in the database (shown in the app's notification
 * centre — this is a real delivery channel). When SMTP is configured an e-mail is
 * also attempted; the real outcome is stored and reported back to the caller.
 */
function createNotifier({ pool, mailer, config }) {
  async function notify(userId, { type, title, body = '', link = null }, client = pool) {
    const { rows } = await client.query(
      `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [userId, type, title, body, link]
    );
    const id = rows[0].id;
    return { id, userId, title, body, link };
  }

  /** E-mail is sent after the DB transaction commits. */
  async function deliverEmail(n) {
    const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [n.userId]);
    if (!rows[0]) return { status: 'skipped' };
    const linkText = n.link ? `\n\nOpen de app: ${config.baseUrl}${n.link}` : '';
    const result = await mailer.send({ to: rows[0].email, subject: n.title, text: `${n.body}${linkText}` });
    await pool.query('UPDATE notifications SET email_status = $2, email_error = $3 WHERE id = $1', [
      n.id,
      result.status,
      result.error || null,
    ]);
    return result;
  }

  /** Human-readable, honest summary for the acting user. */
  function describeDelivery(name, emailResult) {
    const base = `${name} ziet een melding in de app zodra die de app opent.`;
    switch (emailResult.status) {
      case 'sent':
        return `${base} Er is ook een e-mail verstuurd.`;
      case 'failed':
        return `${base} Het versturen van de e-mail is mislukt.`;
      case 'dev_logged':
        return `${base} E-mail is niet verstuurd (ontwikkelmodus: alleen in de serverlog).`;
      case 'not_configured':
        return `${base} Er is geen e-mail verstuurd, omdat e-mailverzending nog niet is ingesteld.`;
      default:
        return base;
    }
  }

  return { notify, deliverEmail, describeDelivery };
}

module.exports = { createNotifier };
