'use strict';
/**
 * External integrations: liveness (gezichtscheck), age verification and payments.
 *
 * None of these is implemented against a real provider yet, on purpose: the product
 * owner must first choose a provider and supply account details (see
 * OPEN-BESLISSINGEN.md). Until then every adapter reports `configured: false` and
 * every action fails honestly. Nothing in this file ever marks a user as verified
 * or a payment as collected.
 *
 * To add a provider: implement an adapter with the same shape and register it in
 * PROVIDERS below. The adapter must verify webhook signatures and only report
 * success when the provider confirms it.
 */

// Registered, implemented providers. Empty until a provider is chosen.
const LIVENESS_PROVIDERS = {};
const AGE_PROVIDERS = {};
const PAYMENT_PROVIDERS = {};

function notConfigured(kind, requested) {
  const reason = requested
    ? `De ${kind}-dienst "${requested}" is ingesteld, maar er is nog geen koppeling voor deze dienst gebouwd.`
    : `Er is nog geen ${kind}-dienst gekozen en ingesteld.`;
  return {
    configured: false,
    providerName: null,
    reason,
    async startSession() {
      const err = new Error(reason);
      err.code = 'NOT_CONFIGURED';
      throw err;
    },
    async handleWebhook() {
      const err = new Error(reason);
      err.code = 'NOT_CONFIGURED';
      throw err;
    },
  };
}

function build(registry, kind, settings, logger) {
  const name = settings.provider;
  if (name && registry[name]) return registry[name](settings);
  if (name) logger.warn(`[integraties] ${kind}: onbekende dienst "${name}" — functie blijft uitgeschakeld.`);
  return notConfigured(kind, name);
}

function createIntegrations(config, { logger = console } = {}) {
  return {
    liveness: build(LIVENESS_PROVIDERS, 'gezichtscheck (liveness)', config.liveness, logger),
    ageVerification: build(AGE_PROVIDERS, 'leeftijdsverificatie', config.ageVerification, logger),
    payments: build(PAYMENT_PROVIDERS, 'betaal', config.payments, logger),
  };
}

module.exports = { createIntegrations };
