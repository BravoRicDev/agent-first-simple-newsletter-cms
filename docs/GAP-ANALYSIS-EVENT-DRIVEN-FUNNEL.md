# GAP ANALYSIS — FUNNEL EVENT-DRIVEN (Webinar / Flash Sale / Challenge) + AREE RISERVATE (LMS)

> Analisi fatta sul codice **reale** del repo (non su assunzioni): ogni voce della
> scaletta è stata verificata grep/lettura dei file. Nessun file è stato modificato.
> Date: 2026-08-28. Legenda: ✅ = già supportato (eventuali caveat config) · 🟡 = parziale,
> manca X · ❌ = assente.

Verifiche trasversali rilevanti prima della mappatura:

- **WhatsApp**: NESSUNA integrazione di invio. In tutto il codice `whatsapp` è solo
  un'etichetta di canale sulle conversazioni (`channel IN ('email','whatsapp')`). Il servizio
  `src/services/mcp-tools.js:843` lo dice esplicitamente: *"WhatsApp is not sent by the CMS (the
  bot does that)"*. `.env.example` non ha chiavi WA. → **tutte le voci che richiedono invio WA
  sono ❌ (serve gateway esterno)**.
- **`courses`/`memberships`/`enrollments`**: presenti SOLO nella whitelist di
  `src/services/external-ids.js:69-71`; nessuna `CREATE TABLE` in `db/*.sql`, nessun mapper
  in `src/services/source-sync/mappers/`. → **da costruire da zero**.
- **`products`/`product_prices`/`invoices`**: le tabelle ESISTONO (`db/088_commerce_campaigns.sql`)
  ma sono solo schema per il source-sync (clone da CRM esterno) e non esiste nessun flusso di
  checkout/ordine che le usi. Il checkout attuale è esclusivamente `payment_links`
  (pagamento singolo Stripe, `src/services/payments.js` + `src/routes/public-payments.js`).
- **Countdown/scarcity**: nessun widget nel renderer (`src/services/page-renderer.js` conosce
  solo `{{form}}`, `{{quiz}}`, `{{calendar}}`, `{{var}}`, `{{snippet}}`). Le uniche occorrenze di
  "countdown" sono HTML statici hardcoded in `static/2/*.html`.
- **Redirect condizionale lato server su tag/score/stage**: assente. `serve.js` fa solo
  redirect statici da tabella `redirects` (`db/012_redirects.sql`).

---

## A) TABELLA DI MAPPATURA

| # | Voce cliente | Stato | Dove nel codice | Cosa manca esattamente |
|---|---|---|---|---|
| 1 | **CORE — Endpoint webhook / gestore stato CRM** (ricezione tag NR, in contatto, Irreperibile, Consulenza, Vinto, Sospeso) | ✅ (config da fare) | `src/routes/public-webhooks.js:25` → `POST /webhooks/in/:siteId/:token`; azioni in `src/services/webhooks.js:498-544` (`add_tag`, `create_contact`, `emit_event`, `create_task`); tag dinamici `contacts.tags` (array) | Nessuna feature mancante: il meccanismo trasporto→tag→evento `tag_added` (`src/services/contacts.js:114-128`) → workflow/scoring/segmenti esiste. Mancano solo convenzioni config (i tag sono testo libero, vedi `db/086_tags.sql` e `db/025_contacts.sql`) |
| 2 | **CORE — Automazione recupero "Perso + Motivo"** (trigger su tag → instrada a Webinar/Flash Sale/Challenge) | 🟡 — manca gestione strutturata del "motivo" | Workflow engine `src/services/workflows.js:18-25` (trigger `tag_added`), filtro `config.tag` a `src/services/workflows.js:60`; azioni `add_tag`/`set_stage`/`send_campaign`/`send_sequence`/`wait_days` | Oggi si replica solo con un workflow per tag ("Perso" + un tag per motivo) e routing manuale in `trigger_config`. Manca: mapping dichiarativo "tag Perso + motivo → funnel target" (una tabella di routing) e semantica a 2 tag. L'infrastruttura (trigger/azioni) c'è |
| 3 | **CORE — Modulo Typeform / survey di qualificazione** (domande chiuse → Profit/Breakeven/KO, **redirect condizionali per score**) | 🟡 — manca redirect per soglia | `src/routes/quizzes.js` (compute `total_points:93`, soglie `findQuizThreshold:108`, evento `quiz_completed:417`), `db/037_quizzes.sql` (`thresholds` JSONB, singolo `redirect_url`), widget `src/services/page-renderer.js:249` | Il quiz calcola già lo score e classifica in soglie (min/max → title/message/class), ma `redirect_url` è UNO per quiz (`src/routes/quizzes.js:428`). Serve `redirect_url` PER soglia (Profit→A, Breakeven→B, KO→C) deciso lato server dopo il punteggio. Il pattern Typeform (una domanda alla volta) è UI, non backend |
| 4 | **WEBINAR — Link Opt-in pubblico (landing Masterclass)** | ✅ | `src/routes/pages.js` + `src/routes/serve.js:142` (catch-all pagine), form builder `src/routes/forms.js`, widget `{{form:slug}}` in `src/services/page-renderer.js:42`, export statico `src/services/static-export.js` | Nessuna feature nuova: è contenuto + form già esistenti. Evento `form_submitted` già alimenta workflow/segmenti |
| 5 | **WEBINAR — Pagina profilazione (step-2 post registrazione, Profit/Breakeven)** | 🟡 — stesso gap del #3 | Stesso modulo quiz `src/routes/quizzes.js` | Idem #3: serve redirect condizionale per soglia. La profilazione "step-2" è un secondo modulo già realizzabile con form/quiz |
| 6 | **WEBINAR — Check-out Low Ticket (50-100€) triggerata per chi abbandona il funnel post-opt-in senza qualificarsi** | 🟡 — manca il trigger di abbandono | Checkout singolo: `src/services/payments.js` (`createPaymentLink:119`, `markPaid:205`), pagina `/pay/:token` `src/routes/public-payments.js:106` | Il "checkout low ticket" è un `payment_link` → ok. Manca: rilevamento "iscritto che NON si è qualificato entro X giorni" (trigger su assenza evento — non esiste) e consegna del link via workflow (l'azione `send_campaign` invia una campagna email, non un link di pagamento diretto). Serve trigger "no_event_after" + payload link di pagamento nelle azioni |
| 7 | **WEBINAR — Link Invito Gruppo WhatsApp (Community) post-iscrizione / post-acquisto** | 🟡 — link ok, consegna WA mancante | Link tracciati: `db/067_tracked_links.sql`, `src/routes/public-tracked-links.js` (`GET /go/:slug`), CRUD `src/routes/agent-tracked-links.js` | Il "link di invito" è un `tracked_link` (già con contatore visite e `?email=`) → ok. Manca: consegna automatica via **WhatsApp** (❌) e, se il link deve scadere, la scadenza su `tracked_links` (❌). Via email il delivery si può già fare con `send_campaign`/`send_sequence` |
| 8 | **WEBINAR — Nurturing pre-webinar T-3 / T-1 / T-15min con link d'accesso** | ❌ — scheduling relativo a evento assente | Sequenze a intervalli fissi: `src/services/newsletter.js:375` (`sendSequenceSteps`, delay in GIORNI da `confirmed_at`, vedi `db/019_newsletter_sequences.sql`), `src/services/scheduler.js` (tick 60s, azioni differite solo `wait_days` in giorni interi: `src/services/workflows.js:180-189`) | Mancano: (a) entità "evento/webinar" con data-ora; (b) scheduler di email **relative all'evento** con granularità ore/minuti (T-3g, T-1g, T-15min); (c) consegna WA. Solo T-3 è emulabile con `wait_days` |
| 9 | **WEBINAR — Stanza Accesso Form (pagina di gate live/registrata)** | ❌ — nessun gate pubblico | Nessun gate. Più vicini: pagina conferma booking `src/routes/booking-public.js:59`, pagina pubblica `/quote/:token` (`getQuoteByToken` in `src/services/opportunities.js:277`), `/pay/:token` | Serve una pagina pubblica **token-gated con scadenza** che verifica il diritto di accesso (email iscritta / acquisto low-ticket) prima di mostrare live/registrata. Pattern token da copiare: `/quote/:token`. Nessuna feature di gate esiste |
| 10 | **WEBINAR — Landing di vendita principale (Front/Back/Cross/Continuity)** | 🟡 — landing ok, scala offerte ❌ | Landing: `src/routes/pages.js` ✅. Checkout: solo `payment_links` singolo (`src/services/payments.js`) | La pagina è solo contenuto. La scala Front→Back→Cross→Continuity richiede il modulo checkout a più step (❌, vedi #15) |
| 11 | **WEBINAR — Follow-up post webinar (replay + offerta, community + 1-1 da tutor)** | 🟡 — email ok, WA ❌ | Campaign/sequence con targeting: `db/040_email_tracking.sql` (`target_segment_id`), `db/025_contacts.sql` (`target_tag`), invio `src/services/newsletter.js` | Email replay/offerta → già fattibile (campagna/sequenza target-tag/segmento). Messaggi in community WhatsApp e "1-1 da tutor" = invio WA → ❌ |
| 12 | **FLASH SALE — Trigger iniziale storytelling al DB non convertito / KO** | ✅ | Segmenti dinamici `src/services/segments.js` (regole su `tag`, `status`, `score`, `event` con `lt_days_ago`/`gte_days_ago`: righe `src/services/segments.js:49-59`), campagna/sequenza target per segmento `db/040_email_tracking.sql` | Un segmento "KO / non convertito" (es. `event quiz_completed lt_days_ago 30` + `score lt X`) + campagna con `target_segment_id` fa esattamente questo. Nessuna feature nuova |
| 13 | **FLASH SALE — Landing opt-in "Scopri Offerta" (alzata di mano) con redirect a profilazione** | ✅ (redirect statico) | `src/routes/forms.js` (`redirect_url` validato, `sanitizeRedirect:97`, redirect a `src/routes/forms.js:622-629`), `db/035_forms_redirect.sql` | L'alzata di mano = form; redirect post-submit a un solo URL (la pagina quiz). Ok se il percorso è fisso; se serve il redirect per-threshold torna il gap del #3 |
| 14 | **FLASH SALE — Sales page temporizzata (timer/scarcity)** | 🟡 — pagina ok, timer ❌ | Pagina: `src/routes/pages.js`. Timer: assente in `src/services/page-renderer.js` (widget esistenti: form/quiz/calendar/var/snippet) | Serve un widget `{{countdown:...}}` (data di scadenza per sito/pagina/variabile) renderizzato dal server, opzionalmente con redirect automatico a scadenza. Anche `{{var:}}` esiste ma non fa countdown |
| 15 | **FLASH SALE — Scala checkout Front End → Upsell → Downsell → Continuity** | ❌ | Solo `payment_links` singolo (`src/services/payments.js:119-148`, un prodotto one-shot Stripe `createStripePaymentLink:48`), nessuna tabella ordini | Manca tutto: entità ordine (`orders`/`order_items`), catena di offerte condizionali post-acquisto (upsell/downsell), e continuità = fatturazione ricorrente (Stripe subscription; `product_prices.billing_type='recurring'` esiste ma è inutilizzato). Nessun evento di "pagamento completato con acquisto di X" collegato a prodotti (l'unico evento è `payment_paid`, `src/services/payments.js:228`) |
| 16 | **FLASH SALE — Evento abbandono carrello → alert venditore a T+3 giorni** | ❌ | Nessun carrello; alert "apertura chat/chiamata" oggi possibile solo con `create_task`/`notify_email` da workflow (`src/services/workflows.js:158-179`) | Serve: tracciamento sessioni di checkout incomplete (tabella `checkout_sessions`/`abandoned_carts`) + trigger programmato T+3 + azione di alert al venditore (c'è già `notify_email`/`create_task` come azioni, manca la sorgente evento) |
| 17 | **CHALLENGE — Trigger lancio sfida (invito al database)** | ✅ | Stesso targeting di #12 (segmenti + campagna `target_segment_id`, `db/040_email_tracking.sql`) | Nessuna feature nuova |
| 18 | **CHALLENGE — Landing iscrizione challenge con profilazione integrata** | ✅ (redirect statico) | `src/routes/forms.js` + `src/routes/quizzes.js` sulla stessa pagina | Ok con un solo form/quiz; per percorso condizionale per score vale il gap del #3 |
| 19 | **CHALLENGE — Pagina conferma / Thank-you con istruzioni (moodboard)** | ✅ | Thank-you via `redirect_url` form (`src/routes/forms.js:622`) → pagina `pages` pubblicata; contenuto statico | Nessuna feature nuova |
| 20 | **CHALLENGE — Link gruppo WhatsApp temporaneo (scadenza automatica)** | 🟡 — link ok, scadenza ❌ | Link tracciati `db/067_tracked_links.sql` (no scadenza), `src/routes/public-tracked-links.js` | Serve: colonna `expires_at` su `tracked_links` + redirect a scadenza (e l'invio WA resta ❌). Se "temporaneo" significa creare/espellere utenti dal gruppo, serve integrazione WA esterna (Baileys/Twilio) |
| 21 | **CHALLENGE — Accesso modulo gratuito (LMS): video/materiali operativi, scadenza 7 giorni** | ❌ | `src/routes/media-protected.js` (solo auth admin/superadmin, `requireProtectedAccess:116`), `db/090_external_ids.sql` (whitelist `courses/memberships/enrollments` senza tabelle) | Serve il modulo LMS: tabelle corso/modulo/enrollment + servizio media gated per-enrollment con token pubblico a scadenza (7 giorni). Vedi sezione B, voce 21 |
| 22 | **CHALLENGE — Landing chiusura / offerta non vincitori (acquisto completo)** | 🟡 | Pagina: `src/routes/pages.js` ✅; acquisto: `payment_links` singolo ✅; checkout completo ❌ | La landing è pronta e il pagamento singolo esiste. Manca solo se si vuole la scala offerte completa (#15) |
| 23 | **AREA RISERVATA — videocorsi/slide gated per-utente/per-acquisto (non solo auth sì/no)** | ❌ | `src/routes/media-protected.js` (`requireProtectedAccess:116-128`: solo ruolo admin/superadmin; la roadmap nel commento alle righe 58-78 prevede ACL per sito/record e token one-shot, non implementati) | Serve modello di autorizzazione basato su enrollment/acquisto, non su ruolo. Base filesystem c'è (cartella `media-protected`, naming `timestamp-hash.ext`, serve con `Cache-Control: private,no-store`), ma il gate è da riscrivere |
| 24 | **AREA RISERVATA — tabelle corsi/moduli/progressi** | ❌ | Assenti (solo whitelist `src/services/external-ids.js:69-71`; `db/094` non esiste per queste) | Da creare: `courses`, `course_modules`, `course_lessons`, `enrollments`, `enrollment_progress` (schema proposto in B) |
| 25 | **AREA RISERVATA — tracciamento progressi (lezione vista, % completamento)** | ❌ | Assente (vedi #24) | Servizio progressi + endpoint POST "lezione completata" + % su enrollment; può riusare l'event bus (`src/services/events.js`) per eventi `lesson_completed` |
| 26 | **AREA RISERVATA — scadenza accesso (7 giorni challenge / durata membership)** | ❌ | Assente (media-protected non ha scadenza per-utente) | Colonne `access_expires_at` su enrollment; check nel gate; scheduler di revoca |
| 27 | **AREA RISERVATA — gating per acquisto (enrollment dall'ordine)** | ❌ | Nessun ordine (vedi #15); `payment_paid` è l'unico hook (`src/services/payments.js:228`) | Creare enrollment automatico all'evento `payment_paid` (o `checkout_completed`) se l'acquisto include un corso |
| 28 | **AREA RISERVATA — accesso senza login via token firmato con scadenza** | ❌ | Pattern disponibile: `/quote/:token` (`src/services/opportunities.js:277`), `/pay/:token` (`src/routes/public-payments.js`); media-protected richiede login | Serve rotta pubblica `/media-protected/shared/:token` (già prevista come "futuro" nel commento `src/routes/media-protected.js:67-70`) con token HMAC firmato + scadenza, collegato a enrollment |

---

## B) ELEMENTI MANCANTI — COME STRUTTURARLI

Per ogni voce 🟡/❌ della tabella: comportamento atteso, integrazione nell'architettura
esistente, tabelle/migrazioni necessarie, file da toccare/creare.

### B.2 — Routing "Perso + Motivo" (🟡)
- **Cosa deve fare**: quando arriva un aggiornamento CRM che aggiunge i tag `Perso` + `<motivo>`
  (via webhook IN o azione manuale), il sistema deve instradare automaticamente il contatto nel
  funnel corretto (Webinar / Flash Sale / Challenge) in base al motivo.
- **Integrazione**: il motore workflow già scatta su `tag_added` con filtro `config.tag`
  (`src/services/workflows.js:60`). Non serve toccare l'engine: serve una **tabella di routing**
  configurabile che mappa `(tag_perso, motivo_tag) → (funnel)` e genera il workflow (o un'azione
  `emit_event` con `event_type='recovery_routed'` + `funnel`).
- **Tabelle**: nuova migrazione `recovery_routes (id, site_id, lost_tag, reason_tag, funnel_tag,
  created_at)` — il resto del flusso è già `workflow_actions` esistenti.
- **File**: creare `src/services/recovery.js` (risolve la route ed emette `recovery_routed`);
  modificare `src/services/webhooks.js:498` (azione `add_tag` multipla → chiama recovery);
  `src/routes/agent-recovery.js` (CRUD route); migrazione `db/097_recovery_routes.sql`.
- **Riusa**: `src/services/events.js`, `src/services/workflows.js`, `addContactTag`.

### B.3/B.5 — Redirect condizionale per soglia su quiz/survey (🟡)
- **Cosa deve fare**: a fine quiz il server calcola il punteggio, trova la soglia
  (Profit/Breakeven/KO) e reindirizza a un URL DIVERSO per soglia (oggi c'è un solo
  `redirect_url`).
- **Integrazione**: le soglie sono già JSONB in `quizzes.thresholds`
  (`db/037_quizzes.sql:17`, struttura `{min,max,title,message,class}`). Si aggiunge il campo
  `redirect_url` opzionale dentro ogni soglia; il calcolo server già esiste
  (`src/routes/quizzes.js:93-112`).
- **Tabelle**: nessuna nuova tabella — solo estensione del JSONB (basta che il builder lo salvi);
  opzionalmente colonna helper non necessaria.
- **File**: `src/routes/quizzes.js` (sanitize `sanitizeThresholds:68`, `findQuizThreshold:108`,
  submit `:428-441` → scegliere redirect della soglia, non di `quiz.redirect_url`); builder
  `views/admin/quizzes/builder.ejs`; test `test/quizzes-public.test.js`.
- **Riusa**: `isSafeRedirect` (`src/routes/quizzes.js:116`).

### B.6 — Checkout low-ticket triggerato su abbandono del funnel (🟡)
- **Cosa deve fare**: un iscritto all'opt-in che NON si qualifica (nessun `quiz_completed`) entro
  N giorni riceve un link di pagamento low-ticket (50–100 €) via email.
- **Integrazione**: manca il concetto di "trigger su assenza di evento". Due opzioni (consigliata
  la seconda):
  1. Estendere `matchTriggerConfig` con `no_event`/`days_since` (più invasivo);
  2. nuovo trigger workflow `no_event_after` con `trigger_config {base_event:'form_submitted',
     missing_event:'quiz_completed', days:3}` valutato dal tick.
- **Tabelle**: nessuna nuova tabella (si appoggia su `contact_events` esistente
  `db/008_ingest_log.sql`/`contacts` timeline — verificare tabella `contact_events`). Eventuale
  tabella `workflow_rules` non necessaria: si riusa `workflows`.
- **File**: `src/services/workflows.js` (nuovo trigger + valutazione in
  `processDelayedActions`/nuova funzione `checkNoEventWorkflows` chiamata da
  `src/services/scheduler.js:151`); nuova azione `send_payment_link` in `executeAction`
  (`src/services/workflows.js:92`) che crea `payment_link` e manda l'email con `/pay/:token`.
- **Riusa**: `src/services/payments.js`, `src/services/email.js`, `src/services/events.js`.

### B.7/B.20 — Link WhatsApp + scadenza (🟡/❌)
- **Cosa deve fare**: consegnare un link di invito (gruppo WhatsApp community) post-iscrizione/
  post-acquisto; per la Challenge il link deve scadere.
- **Integrazione**: il link è un `tracked_link` (`GET /go/:slug`, `db/067_tracked_links.sql`).
  La consegna automatizzata via email è già possibile (`send_campaign`); l'invio WA è ❌
  (vedi D, rischio trasversale).
- **Tabelle**: migrazione per `ALTER TABLE tracked_links ADD COLUMN expires_at TIMESTAMPTZ NULL`
  + in `src/routes/public-tracked-links.js` redirect a scadenza (302 a una pagina "scaduto").
- **File**: `db/098_tracked_links_expiry.sql`; `src/services/tracked-links.js` (check scadenza);
  `src/routes/public-tracked-links.js`; `src/routes/agent-tracked-links.js` (admin scadenza);
  `views/...` editor link. Per il WA: modulo `src/services/whatsapp-gateway.js` + config
  (`wa_provider=baileys|twilio`, credenziali) — nessuna API ufficiale gratuita.

### B.8 — Scheduling email relative a evento (T-3 / T-1 / T-15min) (❌)
- **Cosa deve fare**: a una data-evento (webinar) nota, inviare reminder a ciascun partecipante
  a T-3 giorni, T-1 giorno, T-15 minuti prima, con link d'accesso personalizzato.
- **Integrazione**: oggi le sequenze sono "giorni dalla conferma" (`db/019_newsletter_sequences.sql`).
  Serve un nuovo modello "reminder legato a evento":
- **Tabelle**: `webinar_events (id, site_id, title, starts_at, ends_at, access_url_template)`,
  `event_participants (id, event_id, email, join_token, status)` (join_token = pattern
  `/quote/:token`), `event_reminders (id, event_id, offset_seconds, channel email|whatsapp,
  template)`.
- **File**: `db/099_event_scheduling.sql`; `src/services/event-reminders.js` (genera reminder e
  li accoda come delivery programmate, riusando `workflow_delayed_actions` o una nuova tabella
  `scheduled_sends`); `src/services/scheduler.js` (nuova task nel tick); `src/routes/events.js`
  (CRUD evento/partecipanti); pagina gate per l'accesso (vedi B.9).
- **Riusa**: `src/services/email.js`, `src/services/tracking-email.js` (link tracciati),
  `src/services/newsletter.js` (template), `src/services/workflows.js` (coda differita con
  `run_at` — si può riusare estendendo granularità al minuto: oggi `wait_days` è in giorni,
  `src/services/workflows.js:180`).

### B.9 — Stanza accesso (gate live/registrata) (❌)
- **Cosa deve fare**: pagina pubblica `/accedi/:token` che verifica che l'email abbia diritto
  (iscritta all'evento, oppure acquisto low-ticket) e mostra live o registrata; token con
  scadenza.
- **Integrazione**: copiare il pattern `quote/:token` (`getQuoteByToken`,
  `src/services/opportunities.js:277`). Il gate risolve `join_token` su `event_participants`
  (B.8) o su `enrollments`/`payment_links`.
- **Tabelle**: nessuna nuova oltre quelle di B.8; opzionale tabella `access_tokens (token,
  entity_type, entity_id, email, expires_at, used_at)`.
- **File**: `src/routes/access.js` (GET `/accedi/:token`), `views/access/*.ejs`, montaggio in
  `src/index.js` PRIMA del catch-all pubblico.

### B.14 — Widget countdown/scarcity (🟡)
- **Cosa deve fare**: `{{countdown:slug}}` o `{{countdown:2026-09-30T23:59:00Z}}` che renderizza
  un timer client-side con scadenza server-side (per evitare manipolazione) e redirect a scadenza.
- **Integrazione**: seguire il pattern del widget quiz in `src/services/page-renderer.js`
  (`renderQuizWidget:249`, `expandQuizzes:431`): nuova regex + `expandCountdowns` + funzione
  `renderCountdownWidget`. La scadenza può venire da `site_variables` (`{{var:}}` pattern)
  o da una nuova tabella.
- **Tabelle**: opzionale `countdowns (id, site_id, slug, ends_at, redirect_url, created_at)`.
- **File**: `src/services/page-renderer.js`; `src/routes/countdowns.js` (admin CRUD);
  `db/100_countdowns.sql`; test `test/page-renderer.test.js`.

### B.15/B.16 — Checkout a scala (upsell/downsell/continuity) + abbandono carrello (❌)
- **Cosa deve fare**: dopo un pagamento Front End, presentare offerte condizionali in sequenza
  (upsell → downsell → continuity); tracciare i checkout incompleti e avvisare il venditore a
  T+3.
- **Integrazione**: si appoggia su `payment_links` (un link per step) + un'entità "ordine" che
  collega gli step. `product_prices.billing_type='recurring'` esiste già
  (`db/088_commerce_campaigns.sql`) ma va usato per la continuity via Stripe Checkout/Subscription.
- **Tabelle**:
  ```sql
  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY, site_id INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    contact_email VARCHAR(255) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','paid','abandoned','refunded')),
    total NUMERIC(12,2) NOT NULL DEFAULT 0, currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
    checkout_token VARCHAR(64), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ, abandoned_at TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY, order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INT REFERENCES products(id), title VARCHAR(255) NOT NULL,
    amount NUMERIC(12,2) NOT NULL DEFAULT 0, step INT NOT NULL DEFAULT 1,
    step_type VARCHAR(20) NOT NULL DEFAULT 'front' CHECK (step_type IN
      ('front','upsell','downsell','continuity')), payment_link_id INT REFERENCES payment_links(id)
  );
  CREATE TABLE IF NOT EXISTS checkout_offers (
    id SERIAL PRIMARY KEY, site_id INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL, step_type VARCHAR(20) NOT NULL,
    trigger_step INT NOT NULL DEFAULT 1, amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    product_id INT REFERENCES products(id), offer_page_path VARCHAR(500) NOT NULL DEFAULT '',
    redirect_next VARCHAR(500) NOT NULL DEFAULT '', active BOOLEAN NOT NULL DEFAULT true
  );
  ```
- **File**: `src/routes/checkout.js` (pubblico: `GET /checkout/:token` → step; POST conferma);
  `src/services/checkout.js` (crea ordine, crea `payment_link` per step, emette
  `checkout_started`/`checkout_completed`/`checkout_abandoned`); `src/services/payments.js`
  (estensione per continuity/recurring); `src/services/scheduler.js` (task abbandono T+3 →
  `notify_email`/`create_task` al venditore); migrazioni `db/101_orders.sql`,
  `db/102_checkout_offers.sql`. Evento `checkout_abandoned` alimenta `workflows`
  (`TRIGGER_TYPES` in `src/services/workflows.js:18`).

### B.21 + B.23…B.28 — AREA RISERVATA / LMS (❌) — richiesta proprietario
- **Cosa deve fare**: contenuti (video/slide/PDF) accessibili SOLO a chi ha acquistato il corso o
  è iscritto alla challenge, con scadenza (7 giorni o durata membership), tracciamento progressi,
  accesso senza login tramite token firmato.
- **Integrazione**: riusa la cartella `media-protected` (naming `timestamp-hash.ext`,
  serve con `Cache-Control: private, no-store`) e le route `media.js` per l'upload. Il gate
  attuale (`requireProtectedAccess`, `src/routes/media-protected.js:116`) va esteso per
  supportare un accesso per-enrollment senza sostituirlo per i casi admin.
- **Tabelle** (nuova migrazione):
  ```sql
  CREATE TABLE IF NOT EXISTS courses (
    id SERIAL PRIMARY KEY, site_id INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL, slug VARCHAR(120) NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '', access_days INT, active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS course_modules (
    id SERIAL PRIMARY KEY, course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL, sort_order INT NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS course_lessons (
    id SERIAL PRIMARY KEY, module_id INT NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL, media_path VARCHAR(500) NOT NULL DEFAULT '',
    media_type VARCHAR(20) NOT NULL DEFAULT 'video' CHECK (media_type IN ('video','slide','pdf','audio')),
    sort_order INT NOT NULL DEFAULT 0, duration_seconds INT NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS enrollments (
    id SERIAL PRIMARY KEY, site_id INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    contact_email VARCHAR(255) NOT NULL,
    source VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','purchase','challenge')),
    order_id INT REFERENCES orders(id) ON DELETE SET NULL,
    access_token VARCHAR(64), access_expires_at TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (course_id, contact_email)
  );
  CREATE TABLE IF NOT EXISTS enrollment_progress (
    id SERIAL PRIMARY KEY, enrollment_id INT NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
    lesson_id INT NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (enrollment_id, lesson_id)
  );
  ```
- **File**: `src/routes/lms.js` (admin CRUD corsi/moduli/lezioni + upload media protetto, riusa
  `src/routes/media.js`); `src/routes/lms-public.js` (`GET /accedi/:token` → elenco lezioni,
  `GET /accedi/:token/lesson/:id` → serve il file via `media-protected` con check enrollment);
  `src/services/lms.js` (gate: enrollment valido + `access_expires_at` + progressi; emette
  `lesson_completed` sull'event bus `src/services/events.js`); estendere
  `requireProtectedAccess` in `src/routes/media-protected.js` per accettare anche token di
  enrollment (pattern `quote/:token`), MAI `express.static`; migrazione
  `db/103_lms.sql`; `src/routes/agent-lms.js` (API agent); sincronizzazione automatica
  enrollment da `payment_paid`/`checkout_completed` per corsi venduti (`src/services/payments.js:228`).
- **Integrazione source-sync**: aggiornare `src/services/external-ids.js:69-71` (già in whitelist)
  e aggiungere eventuali mapper `src/services/source-sync/mappers/lms.js` quando il CRM sorgente
  li espone.

---

## C) ROADMAP IN FASI — UNITÀ DI LAVORO PER SUBAGENT PARALLELI

> Convenzione prompt subagent: stile imperativo, path relativi, pattern da seguire come modello.

### FASE 1 — FONDAMENTA / SCHEMA DB (sequenziale per migrazioni, mappature indipendenti)
Le migrazioni sono numerate (idempotenti, `CREATE TABLE IF NOT EXISTS` come le esistenti) ma
possono essere **scritte in parallelo** perché non si riferiscono tra loro; la verifica è `npm test`
che esegue `node db/migrate.js`.

| ID | Titolo | File | Dipendenze | Done verificabile | Rischi |
|---|---|---|---|---|---|
| U1 | Migrazione routing recupero "Perso+Motivo" | `db/097_recovery_routes.sql` | nessuna | `npm test` passa; `CREATE TABLE` idempotente presente | nessuno (solo schema) |
| U2 | Migrazione scadenza tracked_links | `db/098_tracked_links_expiry.sql` | nessuna | colonna `expires_at` su tracked_links | nessuno |
| U3 | Migrazione event scheduling (webinar/reminder) | `db/099_event_scheduling.sql` | nessuna | tabelle `webinar_events/event_participants/event_reminders` | FK verso `contacts` opzionali |
| U4 | Migrazione countdown widget | `db/100_countdowns.sql` | nessuna | tabella `countdowns` | nessuno |
| U5 | Migrazione ordini + offerte checkout | `db/101_orders.sql`, `db/102_checkout_offers.sql` | nessuna (per reference a `products` già esistenti da 088) | tabelle ordini/items/offers; `npm test` | prodotti esistenti ma senza UI admin → usare `product_id` nullable |
| U6 | Migrazione LMS (corsi/moduli/lezioni/enrollments/progress) | `db/103_lms.sql` | nessuna (reference `orders` opzionale, `order_id` nullable) | tabelle LMS; `npm test` | gestire `order_id` nullable fino a U14 |

**Parallelizzabili nella fase 1**: U1–U6 tutte tra loro (sono solo DDL indipendenti). Vincolo
unico: non vanno eseguite prima che la suite `npm test` riparta pulita.

### FASE 2 — FEATURE CORE (motore eventi, checkout, LMS, scheduler) — dipende dalla Fase 1
| ID | Titolo | File | Dipendenze | Done verificabile | Rischi |
|---|---|---|---|---|---|
| U7 | Redirect per-soglia su quiz | `src/routes/quizzes.js`, `views/admin/quizzes/builder.ejs`, `test/quizzes-public.test.js` | U-nulla (solo JSONB, no tabella nuova) | test: quiz con soglie Profit/Breakeven/KO reindirizza a 3 URL diversi | cambiare la firma del JSONB `thresholds` senza rompere i quiz esistenti (campo opzionale) |
| U8 | Servizio recovery "Perso+Motivo" | `src/services/recovery.js`, `src/routes/agent-recovery.js`, `src/services/webhooks.js:498`, `test/recovery.test.js` | U1 | webhook IN che aggiunge `Perso`+motivo → tag funnel corretto | convenzione nomi tag da documentare |
| U9 | Trigger workflow "no_event_after" + azione `send_payment_link` | `src/services/workflows.js` (TRIGGER_TYPES:18, `matchTriggerConfig:54`, `executeAction:92`), `src/services/scheduler.js:151`, `test/crm-workflows.test.js` | U-nulla (usa `contact_events`/`payment_links` esistenti) | workflow `no_event_after` esegue azione dopo N giorni senza evento; invia email con `/pay/:token` | costi di query su `contact_events` → indice su (site_id,email,event_type) |
| U10 | Scheduler reminder evento (T-3/T-1/T-15min) | `src/services/event-reminders.js`, `src/routes/events.js`, `src/services/scheduler.js` (tick), `test/event-reminders.test.js` | U3 | partecipante con evento a data X riceve reminder a T-3g, T-1g, T-15min | granularità: `workflow_delayed_actions.run_at` è TIMESTAMPTZ → ok minuti; non toccare `wait_days` |
| U11 | Widget countdown | `src/services/page-renderer.js` (pattern `renderQuizWidget:249`), `src/routes/countdowns.js`, `test/page-renderer.test.js` | U4 | `{{countdown:slug}}` renderizza timer + redirect a scadenza | static export: timer JS funziona, la scadenza deve venire dal server |
| U12 | Checkout a scala + abbandono | `src/routes/checkout.js`, `src/services/checkout.js`, `src/services/payments.js` (continuity/recurring), `src/services/scheduler.js` (T+3), `test/checkout.test.js` | U5, U9 (per riuso `notify_email`) | ordine con front→upsell→downsell→continuity; `checkout_abandoned` crea task/email venditore a T+3 | Stripe continuity richiede subscription → testare in modalità simulata come `markPaid` |
| U13 | Modulo LMS core (gate + token + progressi) | `src/routes/lms.js`, `src/routes/lms-public.js`, `src/services/lms.js`, estensione `src/routes/media-protected.js` (accesso token, NON express.static), `test/lms.test.js` | U6 | enrollment via token serve lezione entro scadenza; oltre scadenza 403; progressi salvati; `lesson_completed` emesso | sicurezza: non sostituire `requireProtectedAccess`, aggiungere solo ramo token; anti path-traversal già gestito |
| U14 | Enrollment automatico da acquisto | `src/services/payments.js:228` (hook `payment_paid`) o `src/services/checkout.js`, `test/enrollment-from-order.test.js` | U12, U13 | pagamento prodotto con corso → enrollment `source='purchase'` attivo | mappare prodotto→corso (colonna `product_id` su courses o config) |
| U15 | Accesso pubblico con token firmato (stanza webinar / media) | `src/routes/access.js`, `src/services/access-tokens.js`, `views/access/*.ejs`, `src/index.js` (mount prima del catch-all) | U10 (partecipanti) o U13 (enrollment) | `/accedi/:token` mostra live/registrata se diritto e token valido | token HMAC firmato con scadenza (riusare `crypto` di `src/services/payments.js:41`) |

**Parallelizzabili in fase 2**: U7, U8, U9, U11 tra loro (nessuna dipendenza incrociata).
U10 dipende da U3 (fase 1). U12 dipende da U5 e da U9. U13 dipende da U6. U14 dipende da
U12+U13. U15 dipende da U10 o U13.

### FASE 3 — LANDING / UI (dipende da Fase 2 per i widget/route, ma le pagine sono contenuto)
| ID | Titolo | File | Dipendenze | Done verificabile | Rischi |
|---|---|---|---|---|---|
| U16 | Landing webinar: opt-in + profilazione step-2 + thank-you | pagine contenuto in `src/routes/pages.js` + form `src/routes/forms.js` + quiz (U7) | U7 (redirect per soglia) | flusso utente completo su sito di test | nessuno (contenuto) |
| U17 | Sales page temporizzata con countdown + redirect offerta | pagina `pages` + widget U11 | U11 | pagina mostra countdown che scade e reindirizza | contenuto |
| U18 | Stanza accesso UI (gate live/registrata) | `views/access/*.ejs` (riuso U15) | U15 | UI gate + pagina "scaduto" | nessuno |
| U19 | UI admin: builder quiz con redirect per soglia, countdown, eventi/webinar, LMS, offerte | `views/admin/...` nuovi builder | U7,U10,U11,U12,U13 | builder salvano e rileggono le config | coerenza con sanitizer lato server |

**Parallelizzabili in fase 3**: U16, U17, U18, U19 tra loro (dipendono solo dalle API/core
della fase 2, non tra loro).

### FASE 4 — INTEGRAZIONI EMAIL/WA/PAGAMENTI
| ID | Titolo | File | Dipendenze | Done verificabile | Rischi |
|---|---|---|---|---|---|
| U20 | Gateway WhatsApp (Baileys o Twilio) | `src/services/whatsapp-gateway.js`, `src/routes/agent-whatsapp.js`, `.env.example` (`WA_PROVIDER`, credenziali), `src/config.js` | U8,U10 (i flussi che inviano WA) | invio messaggio WA da workflow/reminder | **nessuna API ufficiale gratuita**: Baileys = reverse engineering (rischio ban), Twilio = a pagamento; determinare provider in config |
| U21 | Continuity/recurring Stripe (Checkout Session + subscription) | `src/services/payments.js` (nuova `createStripeSubscription`), `src/routes/checkout.js`, test | U12 | subscription attiva, evento `subscription_created` → workflow | webhook Stripe → servizio dedicato; mapping `billing_type='recurring'` (`db/088`) |
| U22 | Rilevamento abbandono carrello con conteggio giorni + alert venditore (chat/chiamata) | `src/services/checkout.js` + `src/services/scheduler.js` (task giornaliero), `src/services/workflows.js` (azione esistente `create_task`/`notify_email`) | U12 | checkout abbandonato → task al venditore a T+3 con conteggio giorni | falso positivo su utenti che tornano |

**Parallelizzabili in fase 4**: U20 e U22 tra loro; U21 dipende da U12.

---

## D) RIASSUNTO FINALE

- **Unità totali**: 22 (6 fondamenti/DB fase 1 + 9 core fase 2 + 4 landing/UI fase 3 + 3
  integrazioni fase 4). Riga tabella di mappatura: 28 voci (3 core + 8 webinar + 5 flash sale +
  6 challenge + 6 area riservata).
- **Unità "fondamenta/DB"**: 6 (U1–U6), tutte con nuove migrazioni (totale **7 nuovi file di
  migrazione** nell'intervallo `db/097…db/103`; le tabelle nuove stimate: recovery_routes,
  tracked_links.expires_at, webinar_events/event_participants/event_reminders, countdowns,
  orders/order_items/checkout_offers, courses/course_modules/course_lessons/enrollments/
  enrollment_progress — nessuna migrazione dati, solo DDL).
- **Parallelizzabili nella fase 1**: tutte e 6 (sono DDL indipendenti, verifica con `npm test`).
  Nella fase 2 sono parallelizzabili in 4 blocchi (U7/U8/U9/U11; U10; U12; U13).
- **Già coperti senza sviluppo**: tag/stato CRM ricevuti via webhook IN (v. 1), targeting
  "non convertito/KO" via segmenti + campagna target_segment (v. 12, 17), landing/opt-in/
  thank-you via moduli pages+forms (v. 4, 13, 18, 19, 22), link tracciati (v. 7, 20),
  pagamento singolo (v. 6, 22).
- **Rischi trasversali**:
  1. **WhatsApp**: nessuna integrazione di invio nel codice e nessuna API ufficiale gratuita →
     va scelto un provider esterno (Baileys non ufficiale, rischio ban account; Twilio/WhatsApp
     Business a pagamento). Blocca le consegne WA di v. 7/8/11/20 e in parte U20. Tutto il resto
     della scaletta è comunque erogabile via email (già presente).
  2. **Continuity**: la fatturazione ricorrente richiede Stripe Checkout/Subscription (U21);
     oggi esiste solo `payment_links` one-shot. In modalità simulata (no `STRIPE_SECRET_KEY`)
     la continuity non è testabile end-to-end.
  3. **Trigger su assenza di evento / abbandono**: nessun trigger "non ha fatto X entro N
     giorni" e nessun carrello; è la logica più nuova (U9, U12, U22) e va progettata con cura
     sugli indici di `contact_events`.
  4. **Redirect condizionali**: il redirect server-side su tag/score oggi non esiste → estendere
     quiz (U7) e, se serve su pagina pubblica generica, serve un modulo "page gates" che oggi
     non è nella scaletta.
  5. **Area riservata**: il gate attuale di `media-protected` è solo ruolo admin → il nuovo
     ramo enrollment/token va aggiunto accanto (mai sostituire `requireProtectedAccess`).
- **Nota metodi di verifica**: suite esistente = `npm test` (migra + `node --test`); le nuove
  unità devono aggiungere test nella stessa convenzione (`test/*.test.js`).