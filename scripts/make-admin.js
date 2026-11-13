'use strict';
/**
 * Give an existing account the admin role:  npm run make-admin -- user@example.com
 * Remove it again:                          npm run make-admin -- user@example.com --remove
 * There are no default admin credentials.
 */
const { loadConfig } = require('../src/config');
const { createPool } = require('../src/db');

(async () => {
  const email = (process.argv[2] || '').trim().toLowerCase();
  const remove = process.argv.includes('--remove');
  if (!email) {
    console.error('Gebruik: npm run make-admin -- <e-mailadres> [--remove]');
    process.exit(1);
  }
  const pool = createPool(loadConfig());
  try {
    const { rowCount } = await pool.query('UPDATE users SET role=$2 WHERE lower(email)=$1', [email, remove ? 'user' : 'admin']);
    if (!rowCount) {
      console.error('Geen account gevonden met dit e-mailadres. Registreer eerst een account.');
      process.exitCode = 1;
    } else {
      console.log(remove ? `${email} is geen beheerder meer.` : `${email} is nu beheerder.`);
    }
  } finally {
    await pool.end();
  }
})();
