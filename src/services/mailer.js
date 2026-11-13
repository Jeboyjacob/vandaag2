'use strict';
const nodemailer = require('nodemailer');

/**
 * E-mail sending. Result status is always honest:
 *  - 'sent'           : SMTP server accepted the message
 *  - 'failed'         : SMTP configured but sending failed
 *  - 'not_configured' : no SMTP configured; nothing was sent
 *  - 'dev_logged'     : development mode without SMTP; message was only written to the server log
 */
function createMailer(config, { logger = console } = {}) {
  const smtp = config.smtp;
  const configured = Boolean(smtp.host && smtp.from);
  let transport = null;
  if (configured) {
    transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
  }

  return {
    isConfigured: () => configured,
    canDeliver: () => configured || config.devMode,
    async send({ to, subject, text }) {
      if (configured) {
        try {
          await transport.sendMail({ from: smtp.from, to, subject, text });
          return { status: 'sent' };
        } catch (err) {
          logger.error('[mail] verzenden mislukt:', err.message);
          return { status: 'failed', error: err.message.slice(0, 300) };
        }
      }
      if (config.devMode) {
        if (!config.isTest) {
          logger.log(`\n[mail:ONTWIKKELMODUS — NIET VERSTUURD]\nAan: ${to}\nOnderwerp: ${subject}\n${text}\n`);
        }
        return { status: 'dev_logged' };
      }
      return { status: 'not_configured' };
    },
  };
}

module.exports = { createMailer };
