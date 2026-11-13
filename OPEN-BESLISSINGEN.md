# Open beslissingen en externe diensten

Deze punten moeten worden geregeld voordat de app publiek gebruikt kan worden. Zolang ze open staan, doet de app niet alsof ze werken. De betreffende functie staat uit en dat is ook zichtbaar in de app.

## 1. Blokkerend voor publieke lancering

| # | Onderwerp | Huidige stand in de app | Wat ik van jou nodig heb |
|---|---|---|---|
| 1 | **Gezichtscheck (liveness)** | Geen dienst gekoppeld. Publieke registratie is **geblokkeerd**. In ontwikkelmodus kun je de check overslaan; je account wordt dan getoond als "niet geverifieerd". | Keuze van de dienst (bijv. Veriff, Onfido, iProov of AWS Rekognition Face Liveness), een account, API-sleutel en webhook-secret. Daarnaast een verwerkersovereenkomst en een DPIA, want het gaat om biometrische verwerking via een derde. |
| 2 | **Leeftijdsverificatie** | Geen dienst gekoppeld. De geboortedatum wordt gecontroleerd (18+), maar **niet geverifieerd**. Dat staat ook zo in de app. | Keuze van de dienst (vaak dezelfde als bij punt 1, via ID-document en selfie), accountgegevens en een API-sleutel. Plus de beslissing of verificatie verplicht is voordat iemand mag swipen. |
| 3 | **Betaalprovider no-showkosten** | Geen provider gekoppeld. Er wordt **niets geïnd**. Een melding die als terecht is beoordeeld, verandert alleen de status. | Keuze van de provider (bijv. Mollie, Stripe of Adyen), accountgegevens, de manier van innen (vooraf een mandaat of kaart vastleggen, of achteraf een betaalverzoek) en goedgekeurde voorwaarden. |
| 4 | **Hoe een no-show wordt vastgesteld** | Nu: de aanwezige meldt na 30 minuten, de gemelde kan binnen 14 dagen bezwaar maken, en de beheerder beslist. | Wat telt als bewijs? Wat gebeurt er als beide gebruikers elkaar melden? Geldt annuleren vlak voor de starttijd ook als no-show? Moet een uitspraak automatisch tot inning leiden? |
| 5 | **Juridische teksten** | Gebruikers moeten wel een vinkje zetten, maar de teksten bestaan nog niet. | Gebruiksvoorwaarden, privacyverklaring, de no-showvoorwaarden (inclusief bedrijfsnaam via `COMPANY_NAME`) en bewaartermijnen. Laat je hierbij juridisch adviseren (AVG, consumentenrecht, boetebeding). |
| 6 | **E-mail (SMTP)** | Niet ingesteld. Meldingen komen alleen in de app. Wachtwoordherstel is uitgeschakeld en dat staat ook zo op de pagina. | Een SMTP-dienst (bijv. Postmark, Mailgun of Amazon SES), een afzenderadres en een geverifieerd domein (SPF en DKIM). |
| 7 | **Echte locaties** | Er zijn geen locaties meegeleverd. Zolang er geen locatie is, toont de app "Er is nog geen locatie beschikbaar". | Invoer van echte bars en koffieplekken via `/beheer/locaties`, en eventueel afspraken met die locaties. |

## 2. Productkeuzes die ik nu zelf heb ingevuld (makkelijk aan te passen)

- **Voorkeuren:** gender (vrouw / man / non-binair) en leeftijdsbereik. Allebei optioneel, en ze werken twee kanten op. Kloppen deze gendercategorieën voor jou?
- **Tijdsloten:** 12:00–23:00, elk half uur, minimaal 30 minuten vooruit, maximaal 6 keuzes. Dit stel je in via `SLOT_*` en `MAX_TIME_CHOICES`.
- **Beste tijd:** de laagste som van beide rangordes. Bij gelijke stand wint de vroegste tijd.
- **Zelfde dag:** afspreken kan alleen op de kalenderdag van de match (Amsterdamse tijd). Een match om 23:30 heeft dus geen tijden meer. Wil je dat matches ook de volgende dag nog kunnen plannen?
- **Locatiekeuze:** een actieve locatie die open is op de starttijd, met de minste dates op die dag. Op `/beheer/locaties` staat welke extra gegevens nodig zijn voor een slimmere keuze.
- **Annuleren:** kan tot de starttijd. "Ik ben vertraagd" kan tot 2 uur na de start.
- **"Ik voel me niet veilig":** de ander krijgt alleen een neutrale melding ("date beëindigd"), zonder de reden.
- **Account verwijderen:** het account, de video, swipes en matches worden direct gewist. Meldingen en no-showdossiers blijven geanonimiseerd bewaard. De bewaartermijn moet nog worden vastgesteld (zie punt 5).
- **Video's:** opslag op een privé-schijf van de server, maximaal 50 MB (mp4, mov of webm), gecontroleerd op bestandssignatuur. Videoduur en transcodering worden niet gecontroleerd. Voor schaal kun je S3-compatibele opslag met een CDN overwegen.
- **Naam van de app:** "Vandaag". Aanpasbaar via `APP_NAME`.

## 3. Bewust niet gebouwd

- Geen open chat (zo gevraagd).
- Geen reserveringen bij locaties (zo gevraagd).
- Geen eigen gezichtsherkenning en geen opslag van biometrische gegevens.
- Geen live hulpdienst. De app verwijst bij acuut gevaar naar 112.
- Geen pushnotificaties (alleen meldingen in de app en, na instellen, e-mail). Webpush kan later worden toegevoegd.
