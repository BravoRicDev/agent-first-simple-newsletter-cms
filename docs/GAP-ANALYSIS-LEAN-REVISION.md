# GAP ANALYSIS — REVISIONE LEAN (filosofia "generico + riciclo + automazione esterna")

> Revisione di `docs/GAP-ANALYSIS-EVENT-DRIVEN-FUNNEL.md` con la filosofia del proprietario:
> **un gap esiste SOLO se non c'è NESSUN modo — nemmeno componendo feature generiche
> esistenti in modo manuale, nemmeno delegando il follow-up a un umano/automazione esterna
> che legge/scrive via API agente — di ottenere il risultato.**
> Il documento originale resta come riferimento storico. Questo è un delta, non un rewrite.
> Data: 2026-08-28.

Verifiche nuove fatte su questo giro (API agente/`v1` oggi realmente esposte):

- L'API agente **scrive** tag/stato/score (`PUT /api/agent/sites/:siteId/contacts/:email`,
  `src/routes/agent.js:3513`; `PUT .../contacts/:email/extras`, `src/routes/crm-agent.js:545`)
  e **legge** lo storico eventi del contatto (`GET .../contacts/:email/extras` → `events`,
  `src/routes/crm-agent.js:539`; `GET /activities` e `GET /contacts/:id/workflow` in
  `src/routes/v1.js:719,1585`). Quindi un'automazione esterna può sapere se un contatto ha
  fatto `quiz_completed`, ha un tag, ha pagato.
- L'API agente gestisce i **payment link**: `POST` (crea e torna `/pay/:token`),
  `GET` (lista con filtro **solo status**), `mark-paid`
  (`src/routes/agent-payments.js:25-91`). I link hanno `contact_email` nel payload.
- L'API agente gestisce **tracked links** CRUD + stats (`src/routes/agent-tracked-links.js`),
  **segmenti** (CRUD + members + preview, `src/routes/crm-agent.js:38-138`), **workflow**
  (CRUD + test + runs, `src/routes/crm-agent.js:150-250`), **quiz** CRUD + submissions.
- **`media-protected` NON è leggibile via API agente** (solo route con auth admin, niente
  download pubblico né endpoint token): è il punto che sopravvive al filtro severo.

---

## 1) TABELLA RIASSUNTIVA — cosa cambia rispetto al primo documento

Legenda nuovi verdetti: ✅ = già ottenibile · ⚠️ = ottenibile componendo feature esistenti
(+ eventuale automazione esterna via API, **zero codice CMS nuovo**) · ❌ = gap residuo
(non aggirabile).

| # | Voce | Verdetto precedente | Nuovo verdetto | Perché |
|---|---|---|---|---|
| 2 | CORE — Routing "Perso + Motivo" | 🟡 | ✅ | Derubricato su indicazione del proprietario: si usano **tag già granulari** (`perso_nobudget`, `perso_dati-falsi`, …) al posto di "Perso + motivo separato con tabella di mapping". Il workflow esistente (trigger `tag_added` + filtro `config.tag`, `src/services/workflows.js:60` + azioni `add_tag`/`set_stage`/`send_campaign`) instrada ogni tag a un funnel. **Zero sviluppo** (eliminata unità U1/U8). |
| 3 | CORE — Quiz/survey qualificazione con redirect per score | 🟡 | ⚠️ | Il redirect per-soglia (Profit/Breakeven/KO) **si ottiene già oggi** senza toccare il CMS: l'endpoint pubblico `/quiz/:siteId/:slug` risponde JSON con `points` e `result` (`src/routes/quizzes.js:432-439`) e il widget mostra il verdetto inline senza redirect se `redirect_url` è vuoto (`src/services/page-renderer.js:407`). Una pagina può chiamarlo con JS custom e reindirizzare in base al risultato. Redirect **server-side** per-soglia = solo nice-to-have. |
| 5 | WEBINAR — Pagina profilazione step-2 | 🟡 | ⚠️ | Idem #3: lo score/result è già esposto al client; il routing post-quiz si fa con JS sulla pagina o con un solo `redirect_url` fisso. |
| 6 | WEBINAR — Checkout low-ticket per chi abbandona il funnel | 🟡 | ⚠️ | Automazione esterna (n8n/Zapier) che: legge `contact_events` via API (`quiz_completed` assente per email X da N giorni), crea il `payment_link` via `POST /payment-links` (torna il token) e invia l'email col link `/pay/:token`. **Zero codice CMS.** Serve solo il piccolo filtro API `contact_email` su GET payment-links (R2). |
| 7 | WEBINAR — Link invito gruppo WhatsApp | 🟡 | ⚠️ | Il "link d'invito" è già un `tracked_link` (CRUD + stats via API). La consegna: via email con le campagne esistenti, oppure WA da automazione **esterna** (provider WA a scelta). Niente feature CMS. |
| 8 | WEBINAR — Nurturing T-3 / T-1 / T-15min | ❌ | ⚠️ | Lo scheduling **relativo a evento con ore/minuti non serve dentro il CMS**: un n8n con cron legge i partecipanti (tag/segmento o submissions via API), genera a ogni scadenza il reminder (email/SMS/WA) col link d'accesso (un `tracked_link` per evento). Solo il gate server-side della stanza resta opzionale (#9). |
| 9 | WEBINAR — Stanza accesso (gate live/registrata) | ❌ | ⚠️ | Ottenibile in modo manuale senza CMS: pubblicare la pagina a **URL non indovinabile** e consegnare l'URL SOLO agli iscritti (tracked_link + email). "Live vs registrata" = switch manuale della pagina a fine evento. Un gate server-side automatico resta nice-to-have (rientra in R1). |
| 10 | WEBINAR — Landing vendita (Front/Back/Cross/Continuity) | 🟡 | ⚠️ | La landing è già contenuto (`pages`). La scala di offerte è **delegabile a una piattaforma esterna** (Stripe Checkout/Subscription o altro) che gestisce upsell/downsell/continuity; il CMS continua a fornire solo landing + pagamento singolo (`payment_links`). Non è un build CMS. |
| 11 | WEBINAR — Follow-up post-webinar | 🟡 | ⚠️ | Email replay+offerta: già fattibile (campagna/sequenza con `target_tag`/`target_segment_id`). Community WA e 1-1 tutor = invio WA da automazione esterna. |
| 14 | FLASH SALE — Sales page con timer/scarcity | 🟡 | ⚠️ | Un countdown è **JS client-side nel contenuto HTML della pagina** (funziona anche nell'export statico); la deadline può venire da `{{var:scadenza}}`. Il widget riusabile sarebbe comodo ma non è un gap. |
| 15 | FLASH SALE — Scala checkout FE→Upsell→Downsell→Continuity | ❌ | ⚠️ | Non è un build CMS: si delega a Stripe Checkout/Subscription (che nativamente fa prodotti, cadenza, offerte) o a un funnel esterno; il CMS resta su `payment_links` singolo. L'unica cosa "specifica funnel" (tabelle `orders`/`checkout_offers`) va scartata per la filosofia generica. |
| 16 | FLASH SALE — Abbandono carrello → alert venditore T+3 | ❌ | ✅ | **Derubricato esplicitamente dal proprietario.** I dati grezzi esistono già: `payment_links` con `contact_email` e `status` (draft/active = aperto, non pagato; `paid`/`paid_at` = pagato) leggibili via `GET /payment-links`. "Chi ha abbandonato" = link creato da ≥N giorni ancora non paid → un n8n/umano legge la lista e fa il follow-up. Niente tabella carrello, niente trigger T+3 nel CMS (occorre solo il filtro `contact_email` per comodità, R2). |
| 20 | CHALLENGE — Link gruppo WhatsApp temporaneo | 🟡 | ⚠️ | "Scadenza" si ottiene **pausando il link** via API esistente (`PUT /tracked-links/:id` con `status='paused'` — lo schema supporta già `active/paused`, `db/067_tracked_links.sql:23`). La gestione gruppo WA (creazione/espulsioni) è esterna. Niente colonna `expires_at`, niente migrazione. |
| 22 | CHALLENGE — Landing chiusura / offerta non vincitori | 🟡 | ✅ | Landing (contenuto) + pagamento singolo (`payment_links`) bastano. La scala offerte, se serve, è esterna (#15). |
| 21 | CHALLENGE — Accesso modulo gratuito (LMS), scadenza 7 giorni | ❌ | ❌ **RESIDUO R1** | Non aggirabile: `media-protected` richiede login CMS (admin/superadmin), non esiste una rotta pubblica a token per i file, non esiste un permesso per-utente, e l'API agente **non espone i file protetti** (un'automazione esterna non può servirli al posto del CMS). Vedi sezione 2. |
| 23 | AREA RISERVATA — videocorsi gated per-utente/per-acquisto | ❌ | ❌ **RESIDUO R1** | Stessa ragione di #21: serve servire file protetti a utenti finali con permesso nominativo + scadenza. È l'unico punto davvero non componibile. |
| 24 | AREA RISERVATA — tabelle corsi/moduli/progressi | ❌ | ⚠️ | La struttura "corso = cartella di file" è già gestibile con `media-protected` (sottocartelle per sito) **senza tabelle corsi**: basta il permesso R1. I "progressi" non richiedono tabella (vedi #25). |
| 25 | AREA RISERVATA — tracciamento progressi | ❌ | ⚠️ | Ogni "lezione" può essere un `tracked_link` (o un `page_view`); le visite si leggono via API (`GET /tracked-links/:id/stats`). Un'automazione esterna tiene i progressi fuori dal CMS. Nessun modulo progressi richiesto. |
| 26 | AREA RISERVATA — scadenza accesso (7 giorni / membership) | ❌ | ❌ **RESIDUO R1** | La scadenza è un attributo del permesso (in R1). Fuori da R1 non c'è nessun posto generico dove appenderla. |
| 27 | AREA RISERVATA — gating per acquisto (enrollment dall'ordine) | ❌ | ⚠️ | Non serve un ordine CMS: l'automazione esterna (o un webhook IN) che vede `payment_paid` (evento già emesso, `src/services/payments.js:228`, leggibile via `/activities` o webhook OUT) crea il permesso R1 via API agente. L'emissione del permesso è esterna. |
| 28 | AREA RISERVATA — accesso senza login via token con scadenza | ❌ | ❌ **RESIDUO R1** | Il pattern esiste per `/quote/:token` e `/pay/:token`, ma non per i **file** di `media-protected`. Serve la rotta pubblica a token (R1). |

**Verdetti invariati (✅ → ✅, non sviluppati qui):** #1 (webhook stato CRM), #4 (landing opt-in),
#12 (trigger storytelling), #13 (landing "scopri offerta"), #17 (trigger lancio sfida),
#18 (landing iscrizione challenge), #19 (pagina conferma/thank-you).

---

## 2) GAP RESIDUI — non ottenibili senza sviluppo

Dopo il filtro severo sopravvive **una sola feature CMS** (R1) + **due micro-gap API** (R2/R3).

### R1 — Servire contenuti protetti a utenti finali con permesso nominativo + scadenza
Copre le voci #21, #23, #26, #28 (e la parte "gate" di #24/#25/#27).

- **Perché NON è aggirabile**:
  1. `src/routes/media-protected.js:116` autorizza solo utenti CMS con ruolo admin/superadmin.
     Un iscritto/acquirente (lead) non ha e non avrà un account CMS.
  2. Non esiste una rotta pubblica a token per i file (il commento interno lo elenca tra le
     "implementazioni future", `src/routes/media-protected.js:67-70`).
  3. L'API agente **non espone il contenuto** di `media-protected` (nessun download): quindi
     nemmeno un'automazione esterna può proxyare i file. La sola alternativa esterna sarebbe
     copiare i contenuti fuori dal CMS, annullando di fatto il gating e l'area riservata.
- **Proposta minima e GENERICA** (utile a qualunque sito, non al funnel): modello "permesso di
  accesso a un contenuto protetto".
  - **Schema** (una tabella sola, idempotente):
    ```sql
    CREATE TABLE IF NOT EXISTS access_grants (
      id SERIAL PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL DEFAULT '',
      token VARCHAR(64) NOT NULL UNIQUE,
      media_path VARCHAR(500) NOT NULL,           -- sotto-cartella/file in media-protected
      expires_at TIMESTAMPTZ,
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      source VARCHAR(30) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','purchase','challenge','api')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ```
  - **Rotta pubblica** `GET /shared/:token` → risolve il grant, verifica `expires_at`/`max_uses`
    e serve il file da `media-protected` (riusando il serve sicuro esistente: validazione path,
    realpath, `Cache-Control: private,no-store`). Copia il pattern `/quote/:token`
    (`src/services/opportunities.js:277`) e di `/pay/:token` (`src/routes/public-payments.js`).
  - **Creazione**: admin (`src/routes/lms.js` → più genericamente `src/routes/access-grants.js`)
    + API agente (`POST /api/agent/sites/:siteId/access-grants`) così l'automazione esterna può
    emettere permessi (challenge 7 giorni = `expires_at`, acquisto = `source='purchase'`).
  - **Upload** del file protetto: riusare l'upload di `src/routes/media.js` salvando in
    `media-protected` (naming `timestamp-hash.ext` già documentato
    `src/routes/media-protected.js:212-229`).
  - **Niente** tabelle `courses/modules/enrollments/progress`: struttura = cartelle,
    progressi = `tracked_links` (vedi tabella #24/#25). Questo è il CMS generico minimo.

### R2 — API: filtro `contact_email` su GET payment-links
- **Perché serve**: l'automazione esterna (abbandono carrello, follow-up low-ticket) oggi può
  listare i link solo per `status` (`src/services/payments.js:82` + `src/routes/agent-payments.js:29`
  e `src/routes/v1.js:1453`). Per "chi ha aperto un checkout e non ha pagato" di UN contatto deve
  scaricare l'intera lista e filtrare in memoria: funziona ma è scomodo e non scalabile.
- **Minimo**: aggiungere il parametro `contact_email` a `listPaymentLinks` + esporlo nelle due
  GET. Nessuna tabella, nessuna logica nuova.

### R3 — API: `score` leggibile nel dettaglio contatto
- **Perché serve**: l'API agente **scrive** lo score (`PUT .../contacts/:email/extras`) ma il
  dettaglio letto non lo restituisce: `getContactRecord` (`src/services/contacts.js:88`) non
  seleziona `score`, quindi `GET /contacts/:email` e `GET /contacts/:email/extras` non lo
  espongono. Un'automazione esterna che deve classificare Profit/Breakeven/KO legge gli eventi
  `quiz_completed` (`points` nel payload) e funziona comunque, ma leggere lo `score` corrente
  del contatto è più diretto.
- **Minimo**: aggiungere `score` alla SELECT di `getContactRecord`. Nessuna altra modifica.

---

## 3) COSA SERVE ESPORRE VIA API AGENTE PER L'AUTOMAZIONE ESTERNA

Stato verificato oggi (nessun lavoro richiesto — già esposto):

| Dato | Endpoint esistenti |
|---|---|
| Leggere tags/status/notes/score(⚠ R3)/valore | `GET /api/agent/sites/:siteId/contacts/:email` e `GET .../contacts/:email/extras` (`src/routes/agent.js:3497`, `src/routes/crm-agent.js:539`) |
| Scrivere tags/status/notes/score | `PUT .../contacts/:email` e `PUT .../contacts/:email/extras` |
| Storico eventi contatto (quiz_completed, form_submitted, payment_paid, tag_added, …) | `GET .../contacts/:email/extras` (`events`), `GET /activities`, `GET /contacts/:id/workflow` (`src/routes/v1.js:719,1585`) |
| Creare/leggere/marcare payment link (→ "chi ha pagato/abbandonato") | `POST/GET/GET:id/PUT/:id/mark-paid /api/agent/sites/:siteId/payment-links` (`src/routes/agent-payments.js:25-91`) — ⚠ manca filtro `contact_email` (**R2**) |
| Creare/leggere/pausare tracked link (inviti WA, link d'accesso, progressi lezione) | CRUD + stats `src/routes/agent-tracked-links.js` |
| Segmenti e membership (targeting "non convertito/KO") | CRUD + members + preview `src/routes/crm-agent.js:38-138` |
| Workflow (config e test) | CRUD + test + runs `src/routes/crm-agent.js:150-250` |
| Quiz + submissions | CRUD + submissions `src/routes/agent.js:3321-3475` |
| Scrivere eventi/tag dall'esterno (webhook IN) | `POST /webhooks/in/:siteId/:token` (`src/routes/public-webhooks.js:25`, azioni in `src/services/webhooks.js:498-544`) |
| Leggere stato newsletter/campagne | `GET .../newsletter/campaigns`, `/subscribers`, `/settings` |

Mancano davvero (piccoli, elencati in sezione 2):
- **R2** — filtro `contact_email` su GET payment-links.
- **R3** — `score` nel dettaglio contatto.
- (Nice-to-have, non bloccanti) quiz_submissions per singolo contatto; un endpoint per inviare
  "ora" una campagna esistente a una lista — oggi l'esterno invia da sé, quindi non richiesto.

---

## 4) ROADMAP AGGIORNATA

Delle **22 unità originali** ne restano **3** (1 feature + 2 micro-API), tutte eseguibili in
parallelo (nessuna dipendenza tra loro) e ciascuna utile a QUALSIASI sito, non al solo funnel.

| ID | Titolo | File | Dipendenze | Done verificabile | Rischi |
|---|---|---|---|---|---|
| R1 | Accesso gated a contenuti protetti (permesso nominativo + token + scadenza) | `db/104_access_grants.sql`; `src/routes/access-grants.js` (admin CRUD + upload protetto); `src/routes/access-grants-public.js` (`GET /shared/:token`, serve da `media-protected`); `src/routes/agent-access-grants.js` (API agente); estensione di `src/services/media-utils.js` per salvare in `media-protected`; `src/index.js` (mount prima del catch-all); `test/access-grants.test.js` | nessuna | un file caricato protetto è servito con token valido entro `expires_at`, negato oltre/consumato; grant creato anche via API agente; `npm test` verde | sicurezza: non sostituire `requireProtectedAccess`, aggiungere solo il ramo token; riusare validazione path/realpath già esistente (`src/routes/media-protected.js:153-206`) |
| R2 | Filtro `contact_email` su lista payment-links | `src/services/payments.js` (`listPaymentLinks:82`), `src/routes/agent-payments.js:25`, `src/routes/v1.js:1453`, `test/payments.test.js` | nessuna | `GET /payment-links?contact_email=x` filtra; `npm test` verde | nessuno (parametro opzionale) |
| R3 | `score` nel dettaglio contatto agente | `src/services/contacts.js` (`getContactRecord:88`), `test/crm-conversations.test.js` o `onda1-contacts.test.js` | nessuna | `GET /contacts/:email` e `/extras` restituiscono `score`; `npm test` verde | nessuno (addizione, non breaking) |

**Unità eliminate rispetto alle 22 originali** (per filosofia, non per budget):
- U1 (recovery_routes), U8 (servizio recovery) → tag granulari, zero dev.
- U2 (expires_at tracked_links) → si usa `status='paused'` già esistente.
- U3/U10 (event scheduling + reminder) → scheduling esterno (n8n) via API.
- U4/U11 (countdown) → JS client-side + `{{var:}}`.
- U5/U12/U21/U22 (ordini, checkout scala, continuity, abbandono) → delegati a Stripe/piattaforma
  esterna; abbandono letto dai dati già esposti.
- U7 (redirect per-soglia server) → ottenibile via JS sulla pagina; diventa nice-to-have.
- U9 (trigger `no_event_after` + azione `send_payment_link`) → automazione esterna (crea link via
  API, invia da sé).
- U13/U15 → **fuse e ridotte** a R1 (la versione minima generica: permessi, non LMS ricco).
- U14 (enrollment da ordine) → automazione esterna emette grant su `payment_paid`.
- U16–U19 (landing/UI) → contenuto CMS già esistente, non unità di sviluppo.
- U20 (gateway WA) → integrazione esterna, non codice CMS.

**Riepilogo**: 3 unità residue, tutte parallele, 1 sola migrazione DB (`db/104_access_grants.sql`).
Tutto il resto della scaletta cliente è raggiungibile componendo feature esistenti (tag, segmenti,
workflow, campagne, tracked_links, payment_links, quiz, pagine) + automazioni esterne via API.