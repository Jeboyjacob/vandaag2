'use strict';
/**
 * Zet de gecontroleerde Amsterdamse bars en koffieplekken uit data/venues-amsterdam.json in de database.
 *   npm run import-venues
 * Veilig om vaker te draaien: bestaande locaties (zelfde naam + adres) worden bijgewerkt, niet dubbel aangemaakt.
 * Controleer de tijden daarna zelf via Beheer > Locaties.
 */
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { createPool } = require('../src/db');

const CHECKED = '13 nov 2026';

(async () => {
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'venues-amsterdam.json'), 'utf8'));
  const pool = createPool(loadConfig());
  try {
    let added = 0, updated = 0;
    for (const v of list) {
      if (!['bar', 'koffie'].includes(v.kind)) throw new Error(`${v.name}: alleen bar of koffie toegestaan`);
      const hours = {};
      for (const [day, [open, close]] of Object.entries(v.hours)) hours[day] = { open, close };
      const note = `Gegevens opgezocht op ${CHECKED} via ${v.source}. Controleer ter plaatse of op de website van de zaak voor het live gaat.`;
      const found = await pool.query('SELECT id FROM venues WHERE lower(name)=lower($1) AND street_address=$2', [v.name, v.street_address]);
      if (found.rowCount) {
        await pool.query(
          `UPDATE venues SET kind=$2, postcode=$3, neighborhood=$4, website=$5, opening_hours=$6, source_note=$7,
             active=TRUE, deleted_at=NULL, updated_at=now() WHERE id=$1`,
          [found.rows[0].id, v.kind, v.postcode, v.neighborhood, v.website || '', JSON.stringify(hours), note]);
        updated++;
      } else {
        await pool.query(
          `INSERT INTO venues (name, kind, street_address, postcode, city, neighborhood, website, opening_hours, source_note, active)
           VALUES ($1,$2,$3,$4,'Amsterdam',$5,$6,$7,$8,TRUE)`,
          [v.name, v.kind, v.street_address, v.postcode, v.neighborhood, v.website || '', JSON.stringify(hours), note]);
        added++;
      }
    }
    console.log(`Klaar: ${added} nieuw, ${updated} bijgewerkt (${list.length} locaties).`);
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
