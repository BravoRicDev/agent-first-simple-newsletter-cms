# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1): **ONDA 1 — Core CRM (contatti + opportunità +
  custom values + webhook OUT) COMPLETATO e verificato** (commit di questo run:
  fc04e2f servizi/migrazione, 72ae696 route /v1, ff5384d test). Mancano solo i
  punti "custom fields mapping su opportunità" (già coperto per contatti) e un
  eventuale passaggio di rifinitura; sostanzialmente il perimetro v1 è chiuso.
  Prossimo blocco consigliato = **rifinitura v1 + verifica end-to-end / import**.

## ONDA 1 COMPLETATO (punti di verifica)
- Migrazione `db/075_onda1_contacts.sql` idempotente: tabelle
  `contact_custom_values` (UNIQUE(site_id, contact_id, object_key), values
  JSONB) e `contact_followers` (UNIQUE(site_id, contact_id, user_id)).
  Nessun `ADD CONSTRAINT IF NOT EXISTS`. Verificata doppia riesecuzione senza
  errori.
- `src/services/custom-values.js`: get/set/merge/clear custom values per-tenant,
  validati contro `custom_fields` (stesso object_key) + chiavi di profilo
  riservate (name/firstName/lastName/phone/companyName/website) sempre ammesse
  per object_key='contact'. Field_key sconosciuti → warn e ignora.
- `src/services/contacts-v1.js`: serializeContact (email, nome+split
  firstName/lastName, phone, companyName, website, tags, status, notes,
  value_estimate, is_client, client_status, customFields{}), create/get/update/
  delete/list/search/upsertByEmail/findDuplicate + note (contact_notes),
  tags, e helper per tasks. Non tocca le firme di `src/services/contacts.js`.
- `src/routes/v1.js`: AGGIUNTE (senza rimuovere le route F0) le route /v1:
  - Contatti: GET/POST /contacts, POST /contacts/search, POST /contacts/upsert,
    POST /contacts/search/duplicate, GET/PUT/DELETE /contacts/:id, note
    (GET/POST /:id/notes, DELETE /:id/notes/:noteId), tags (GET/POST /:id/tags,
    DELETE /:id/tags/:tag), tasks (GET/POST /:id/tasks, PUT /:id/tasks/:taskId),
    followers (GET/POST, persistiti su contact_followers), campaigns (v1: []),
    workflow (snapshot da contact_events).
  - Opportunità (riusa services/opportunities.js): GET/POST /opportunities,
    POST /opportunities/search, POST /opportunities/upsert,
    GET/PUT/DELETE /opportunities/:id, PUT /:id/status, GET /:id/followers ([]).
  - Route statiche PRIMA di /:id (search/upsert/duplicate prima di /:id).
- **Webhook OUT**: la creazione contatto emette `contact_created` via
  `events.js` → `enqueueForEvent` → `webhook_deliveries` (verificato da test).
  I cambi fase opportunità già emettevano opportunity_stage_changed/status
  (pattern pre-esistente confermato).
- Test nuovi: `test/onda1-contacts.test.js` (8), `test/onda1-opportunities-v1.test.js`
  (4), `test/onda1-webhook-out.test.js` (1) = **13/13 PASS** (pattern F0, 2
  tenant per isolamento, header Version ignorato).
- Regressioni (eseguite singolarmente, come da prassi F0): f0-foundations 9/9,
  crm-opportunities ok, crm-opportunity-board 6/6, pipeline 3/3, webhooks 10/10,
  route-order 2/2 → **NADA regressioni**.
- Nessun segreto; `node --check` + import smoke test ok su tutti i file toccati.

## PROSSIMO BLOCCO CONSIGLIATO (dal run precedente → da fare ora)
**Rifinitura v1 + verifica end-to-end / readiness import**:
1. Custom fields mapping su OPPORTUNITÀ (oggi i customValues sono gestiti
   principalmente per object_key='contact'; valutare se servono valori custom
   per opportunity e come esporli nel payload opportunità).
2. Verifica end-to-end: far girare l'intera suite (npm test) e stabilizzare i 3
   fail flaky noti (forms-crm, newsletter-base-url, newsletter-bounce) se
   ancora presenti.
3. Struttura READY per import dati: confermare che le tabelle v1 (contacts,
   contact_custom_values, opportunities, pipelines, custom_fields) siano
   coerenti per un import esterno; documentare in docs/ il tool di import
   PROGETTATO (migrazione dati NON eseguita, come da vincolo).
4. Eventuale endpoint `/v1/contacts/{id}` con custom fields opportunità +
   revisione del formato `customFields` per compatibilità.

## COSE GIÀ PRONTE (riusate da ONDA 1)
- `pipelines`/`pipeline_stages`, `opportunities`, `services/opportunities.js`,
  `custom_fields` (F0), webhook OUT (feature 35 via events.js→webhooks.js).
- Naming generico "API compatibili con CRM diffusi" applicato.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON migrate esterne (nessuna migrazione dati ora): schema pronto al import.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi non ce ne sono).

## LOG CRON POLISH/MONITOR (20/08/2026 — polisher)
- Repo LIBERO (nessun claude/codex/opencode attivo), working tree PULITA, nessun
  lock git. Nessuna interferenza col dev.
- Verifica: migrazioni 074/075 rieseguite idempotenti su testdb (cms-test-pg:15999)
  senza errori; `node --check` su tutto src → OK; test mirati ONDA1+F0 = 22/22 PASS.
- Fix banale fatto: `.env.example` allineato a `src/config.js` — aggiunte chiavi
  mancanti (GROQ_API_KEY/GROQ_BASE_URL/WHISPER_MODEL/AUDIO_RETENTION_DAYS,
  STRIPE_SECRET_KEY) con valori uguali ai default di config. NESSUNA logica toccata.
- Test intera suite: 451/471 pass. Fails = set già noto/assegnato al DEV
  (rifinitura/stabilizzazione), NON regressioni da questo run: forms-crm, hitl
  (human-in-the-loop, cascata su "secretOrPrivateKey must have a value" al primo
  subtest), newsletter-base-url, newsletter-bounce (duplicate key su
  newsletter_subscribers_token_key = collisione dati su testdb condiviso, igiene
  test). Da NON risolvere qui (strutturale, spetta al DEV).
- DECISIONI_UMANE: tutti [RISOLTO] confermati in essere, nessuna [APERTA] da
  segnalare/girare.
- Nota per il DEV: prima di stabilizzare newsletter-bounce meglio pulire/ricreare
  testdb o garantire cleanup delle righe subscriber tra run per evitare collisioni
  token su DB condiviso.
