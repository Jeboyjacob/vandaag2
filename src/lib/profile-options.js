'use strict';

const PROMPT_SLOTS = 3;
const PROMPT_MAX_LEN = 150;
const MAX_INTERESTS = 12;
const MAX_LANGUAGES = 8;

const PROMPTS = [
  { key: 'openingszin', text: 'Mijn favoriete openingszin is…' },
  { key: 'vrienden', text: 'Mijn vrienden omschrijven mij als…' },
  { key: 'zondag', text: 'Mijn perfecte zondag ziet er zo uit…' },
  { key: 'eerste-date', text: 'Mijn ideale eerste date is…' },
  { key: 'val-voor', text: 'Ik val voor mensen die…' },
  { key: 'blij', text: 'Hier word ik altijd blij van…' },
  { key: 'guilty', text: 'Mijn guilty pleasure is…' },
  { key: 'mening', text: 'Mijn onpopulaire mening is…' },
  { key: 'goed-in', text: 'Ik ben echt goed in…' },
  { key: 'bestelling', text: 'Mijn vaste bestelling in een café is…' },
  { key: 'amsterdam', text: 'Mijn favoriete plek in Amsterdam is…' },
  { key: 'advies', text: 'Het beste advies dat ik ooit kreeg…' },
  { key: 'weten', text: 'Dit moet je over mij weten…' },
  { key: 'samen', text: 'Samen zouden we…' },
  { key: 'nooit-genoeg', text: 'Hier krijg ik nooit genoeg van…' },
  { key: 'lach', text: 'Hier kan ik echt hard om lachen…' },
];

const INTEREST_GROUPS = [
  {
    key: 'uitgaan',
    title: 'Uitgaan & drinken',
    items: [
      ['cafes', 'Café’s'], ['bruine-kroegen', 'Bruine kroegen'], ['cocktailbars', 'Cocktailbars'], ['koffie', 'Koffie'],
      ['speciaalbier', 'Speciaalbier'], ['wijn', 'Wijn'], ['terrasjes', 'Terrasjes'], ['clubs', 'Clubs & dansen'],
      ['borrelen', 'Borrelen'], ['foodmarkten', 'Foodmarkten'],
    ],
  },
  {
    key: 'muziek',
    title: 'Muziek',
    items: [
      ['live-muziek', 'Live muziek'], ['festivals', 'Festivals'], ['techno', 'Techno & house'], ['hiphop', 'Hiphop'],
      ['jazz', 'Jazz'], ['indie', 'Indie & rock'], ['pop', 'Pop'], ['vinyl', 'Vinyl'], ['muziek-maken', 'Zelf muziek maken'],
    ],
  },
  {
    key: 'cultuur',
    title: 'Humor & cultuur',
    items: [
      ['standup', 'Stand-upcomedy'], ['theater', 'Theater'], ['film', 'Film'], ['series', 'Series'], ['musea', 'Musea'],
      ['boeken', 'Boeken'], ['fotografie', 'Fotografie'], ['kunst', 'Kunst'], ['podcasts', 'Podcasts'], ['pubquiz', 'Pubquiz'],
    ],
  },
  {
    key: 'sport',
    title: 'Sport & buiten',
    items: [
      ['hardlopen', 'Hardlopen'], ['sportschool', 'Sportschool'], ['voetbal', 'Voetbal'], ['padel', 'Padel & tennis'],
      ['fietsen', 'Fietsen'], ['wandelen', 'Wandelen'], ['yoga', 'Yoga'], ['klimmen', 'Klimmen'], ['zwemmen', 'Zwemmen'],
      ['varen', 'Varen op de grachten'],
    ],
  },
  {
    key: 'leven',
    title: 'Hobby’s & leven',
    items: [
      ['reizen', 'Reizen'], ['gamen', 'Gamen'], ['koken', 'Koken'], ['dieren', 'Dieren'], ['mode', 'Mode'],
      ['duurzaamheid', 'Duurzaamheid'], ['ondernemen', 'Ondernemen'], ['creatief', 'Creatief bezig zijn'],
      ['boardgames', 'Bordspellen'], ['tuinieren', 'Planten'],
    ],
  },
].map((g) => ({ ...g, items: g.items.map(([key, label]) => ({ key, label })) }));

const LANGUAGES = [
  ['nl', 'Nederlands'], ['en', 'Engels'], ['de', 'Duits'], ['fr', 'Frans'], ['es', 'Spaans'], ['it', 'Italiaans'],
  ['pt', 'Portugees'], ['tr', 'Turks'], ['ar', 'Arabisch'], ['pl', 'Pools'], ['ru', 'Russisch'], ['zh', 'Chinees'],
  ['hi', 'Hindi'], ['id', 'Indonesisch'], ['el', 'Grieks'], ['ber', 'Berbers'], ['srn', 'Sranan Tongo'],
  ['fy', 'Fries'], ['ngt', 'Nederlandse Gebarentaal'],
].map(([key, label]) => ({ key, label }));

const PROMPT_BY_KEY = new Map(PROMPTS.map((p) => [p.key, p]));
const INTEREST_LABEL = new Map(INTEREST_GROUPS.flatMap((g) => g.items.map((i) => [i.key, i.label])));
const LANGUAGE_LABEL = new Map(LANGUAGES.map((l) => [l.key, l.label]));

function asArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

/** Validate and normalise the prompt/interest/language part of the profile form. */
function parseExtras(body) {
  const errors = [];
  const prompts = [];
  const seen = new Set();
  for (let i = 0; i < PROMPT_SLOTS; i++) {
    const key = String(body[`prompt_key_${i}`] || '').trim();
    const answer = String(body[`prompt_answer_${i}`] || '').trim();
    if (!key && !answer) continue;
    if (!key || !PROMPT_BY_KEY.has(key)) {
      errors.push(`Kies bij vraag ${i + 1} een vraag uit de lijst.`);
      continue;
    }
    if (!answer) {
      errors.push(`Vul een antwoord in bij “${PROMPT_BY_KEY.get(key).text}”.`);
      continue;
    }
    if (answer.length > PROMPT_MAX_LEN) {
      errors.push(`Een antwoord mag maximaal ${PROMPT_MAX_LEN} tekens zijn.`);
      continue;
    }
    if (seen.has(key)) {
      errors.push('Je kunt dezelfde vraag maar één keer beantwoorden.');
      continue;
    }
    seen.add(key);
    prompts.push({ key, answer });
  }

  const interests = [...new Set(asArray(body.interests).map(String))];
  if (interests.some((k) => !INTEREST_LABEL.has(k))) errors.push('Ongeldige interesse gekozen.');
  if (interests.length > MAX_INTERESTS) errors.push(`Kies maximaal ${MAX_INTERESTS} interesses.`);

  const languages = [...new Set(asArray(body.languages).map(String))];
  if (languages.some((k) => !LANGUAGE_LABEL.has(k))) errors.push('Ongeldige taal gekozen.');
  if (languages.length > MAX_LANGUAGES) errors.push(`Kies maximaal ${MAX_LANGUAGES} talen.`);

  return { errors, prompts, interests, languages };
}

/** Prompts with their question text; unknown keys (removed from the list later) are skipped. */
function promptsForDisplay(prompts) {
  return (Array.isArray(prompts) ? prompts : [])
    .filter((p) => p && PROMPT_BY_KEY.has(p.key))
    .map((p) => ({ question: PROMPT_BY_KEY.get(p.key).text, answer: p.answer }));
}

module.exports = {
  PROMPTS, INTEREST_GROUPS, LANGUAGES, PROMPT_SLOTS, PROMPT_MAX_LEN, MAX_INTERESTS, MAX_LANGUAGES,
  INTEREST_LABEL, LANGUAGE_LABEL, parseExtras, promptsForDisplay,
};
