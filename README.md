# Vandaag: datingapp voor Amsterdam (18+)

Gebruikers bekijken profielvideo's en swipen. Als twee mensen allebei naar rechts swipen, kiezen en rangschikken ze hun voorkeurstijden voor dezelfde dag. De app vindt de beste gezamenlijke tijd en stelt één bar of koffieplek (geen restaurants) voor. De date is pas definitief als beide gebruikers bevestigen. Er is geen chat.

> **Lees ook [`OPEN-BESLISSINGEN.md`](OPEN-BESLISSINGEN.md).** Gezichtscheck, leeftijdsverificatie, betalingen en e-mail zijn voorbereid, maar staan uit totdat er een dienst is gekozen en ingesteld. Zonder gezichtscheck is publieke registratie geblokkeerd.

## Techniek

- Node.js 20+ en Express, server-gerenderde pagina's (EJS), mobile-first CSS en een klein beetje JavaScript als progressive enhancement
- PostgreSQL 14+ (migraties in `migrations/`)
- Sessies in PostgreSQL met een httpOnly cookie (in productie `secure`, altijd `SameSite=Lax`)
- Wachtwoorden met scrypt (N=2^15) en een unieke salt per gebruiker
- CSRF-tokens op alle formulieren, Helmet met een strikte CSP, en rate-limiting op inloggen, registratie en wachtwoordherstel
- Video's in een privémap, alleen opvraagbaar via een route met toegangscontrole

## Lokaal starten

```bash
# 1. PostgreSQL-database
createuser -P datingapp           # kies een wachtwoord
createdb -O datingapp datingapp_dev

# 2. Configuratie
cp .env.example .env              # vul DATABASE_URL in; laat DEV_MODE=true en NODE_ENV=development

# 3. Installeren en starten (migraties draaien automatisch)
npm install
npm run dev                       # http://localhost:3000
```

In ontwikkelmodus staat bovenaan elke pagina een rode balk. Je kunt de gezichtscheck dan overslaan (het account blijft "niet geverifieerd"), en e-mails worden alleen in de serverlog gezet, niet verstuurd.

**Beheerder maken:** registreer eerst een account en voer dan uit:

```bash
npm run make-admin -- jij@voorbeeld.nl
```

Er bestaan geen standaard-inloggegevens voor beheerders. Het beheergedeelte staat op `/beheer`: locaties, meldingen, no-shows en de status van de externe diensten.

## Tests

```bash
createdb -O datingapp datingapp_test
TEST_DATABASE_URL=postgres://datingapp:WACHTWOORD@localhost:5432/datingapp_test npm test
```

52 tests over:
- registratie
- de 18+-blokkade (er wordt niets opgeslagen)
- inloggen en wachtwoordherstel
- CSRF
- de guards rond de ontwikkelmodus
- swipes en dubbele swipes
- wederzijdse matches, ook bij gelijktijdige swipes
- voorkeuren
- blokkeren
- toegang tot video's en uploadcontrole
- tijdsoverlap en rangordes
- alleen toekomstige tijden
- dubbele bevestiging
- verouderde voorstellen
- date-acties en meldingen
- no-showtiming, bezwaar en beoordeling (zonder inning)
- beheer van locaties

## Deployment

De app draait op elke host met Node 20+, PostgreSQL en een **persistente schijf** voor de video's, bijvoorbeeld Render, Fly.io, Railway of een VPS. Een `Dockerfile` is meegeleverd. Serverless platforms zonder schijf (zoals Vercel) zijn niet geschikt, tenzij de video-opslag eerst naar S3-compatibele opslag wordt omgezet.

Verplicht in productie:

| Variabele | Waarde |
|---|---|
| `NODE_ENV` | `production` |
| `DEV_MODE` | leeg of `false`. Met `true` **weigert de server te starten**. |
| `DATABASE_URL` | productiedatabase (`DATABASE_SSL=true` bij een managed database) |
| `SESSION_SECRET` | minimaal 32 willekeurige tekens |
| `APP_BASE_URL` | `https://…` |
| `TRUST_PROXY` | `1` achter een load balancer of reverse proxy (nodig voor secure cookies en rate-limiting) |
| `UPLOAD_DIR` | pad op de persistente schijf |

Daarna, zodra ze gekozen zijn: `SMTP_*`, `LIVENESS_*`, `AGE_VERIFICATION_*`, `PAYMENT_*` en `COMPANY_NAME`. Zie `.env.example`.

Met Docker:

```bash
docker build -t vandaag .
docker run -p 3000:3000 --env-file .env.production -v vandaag-data:/data vandaag
```

Een healthcheck staat op `GET /gezondheid`. Maak regelmatig back-ups van de database en de uploadmap.

## Een externe dienst koppelen

`src/services/integrations.js` bevat de adapters voor de gezichtscheck, leeftijdsverificatie en betalingen. Een adapter heeft deze vorm:

- `configured`, `providerName`
- `startSession(user)` → `{ redirectUrl, reference }`
- `handleWebhook({ headers, rawBody })` → `{ reference, status }`

De adapter moet de webhook-handtekening controleren. De status wordt **alleen** bijgewerkt via een geverifieerde webhook, dus nooit op basis van een redirect in de browser. Webhooks komen binnen op `/webhooks/liveness`, `/webhooks/leeftijd` en `/webhooks/betalingen`. Zolang er geen adapter is, antwoorden die endpoints met 503.

## Structuur

```
src/
  config.js            configuratie + productie-guards
  app.js, server.js    Express-app
  lib/                 tijd (Europe/Amsterdam), leeftijd, scheduling, beveiliging
  services/            matching, dates, locaties, notificaties, mail, opslag, integraties
  routes/              auth, verificatie, profiel, media, swipen, matches, veiligheid, beheer, webhooks
migrations/            SQL-schema
views/, public/        pagina's, CSS, JS
test/                  node:test + supertest
```


## E-mail via Gmail (industrylego@gmail.com)

Zo kan de app wachtwoord-herstelmails en meldingen versturen. Het wachtwoord zet je alleen in je eigen `.env`, nooit in een chat of in de code.

1. Ga naar https://myaccount.google.com/security en zet **Verificatie in twee stappen** aan voor dit account.
2. Ga naar https://myaccount.google.com/apppasswords, maak een app-wachtwoord (noem het "Vandaag") en kopieer de 16 tekens.
3. Open je `.env` (in de app-map) en zet erin:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=industrylego@gmail.com
   SMTP_PASS=plak-hier-het-app-wachtwoord
   MAIL_FROM=Vandaag <industrylego@gmail.com>
   ```
4. Stop de app (Ctrl+C) en start opnieuw met `npm run dev`.

Let op: Gmail is prima om met vrienden te testen (ongeveer 500 mails per dag). Voor echte gebruikers is een aparte mailservice met eigen domein beter.

## Echte bars en koffieplekken laden

`npm run import-venues` zet 10 Amsterdamse bars/koffieplekken uit `data/venues-amsterdam.json` in de database (veilig om vaker te draaien). Controleer de openingstijden altijd even zelf via Beheer > Locaties of de website van de zaak.
