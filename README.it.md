🇬🇧 [English](README.md) · 🇮🇹 Italiano

# Gestione Siti — CMS multi-sito

CMS multi-tenant per la gestione di più siti web da un unico pannello di amministrazione, pensato per essere pilotato sia da utenti umani sia da un agente AI via API dedicata.

## Funzionalità principali

- **Multi-sito / multi-dominio**: più siti indipendenti, ciascuno con più domini associati (`site_domains`).
- **Editor pagine** con versioning automatico, preview, pubblicazione programmata, redirect, SEO per pagina.
- **Snippet e template** riutilizzabili tra pagine, con placeholder `{{snippet:...}}` e variabili di sito `{{var:...}}`.
- **Media library**: upload, importazione da URL (inclusi link Google Drive), compressione video automatica, alt-text generato via LLM, trascrizione audio/video.
- **Form pubblici** con form builder (domande testo/email/telefono/testo lungo/menu a tendina/scelta singola/checkbox), raccolta invii e consultazione/export CSV da pannello admin.
- **Export statico**: ogni pagina pubblicata viene esportata come HTML statico, servito da un Caddy separato come fallback quando l'app Express è in manutenzione (zero downtime).
- **API Agente AI dedicata** (`/api/agent/...`, documentata in [`locales/en/AGENT.md`](locales/en/AGENT.md) / [`locales/it/AGENT.md`](locales/it/AGENT.md)): permette a un agente AI (Claude Code, OpenCode, ecc.) di leggere e modificare pagine/snippet/media in autonomia, con endpoint "bulk" pensati per ridurre il numero di chiamate. `GET /api/agent/guide` serve la versione nella lingua dell'installazione (`DEFAULT_LANG`).
- **Server MCP** (`/api/mcp`, documentato in [`locales/en/MCP.md`](locales/en/MCP.md) / [`locales/it/MCP.md`](locales/it/MCP.md)): stesse funzionalità dell'API agente esposte come tool MCP per client come Claude Desktop, generati per introspezione dalle route REST — sempre allineati automaticamente.
- **Branding e tema configurabili** per-installazione (`.env`) e per-sito (`site_variables`: colori, logo, footer).
- **i18n**: interfaccia admin disponibile in italiano/inglese (migrazione stringhe in corso). Documentazione agente (`AGENT.md`/`MCP.md`), tool MCP, messaggi delle API e email transazionali sono bilingue EN/IT con inglese come lingua base (vedi `locales/`).
- **RBAC**: ruoli `superadmin` / `admin` / `collaboratore` con permessi granulari per risorsa (`src/constants/permissions.js`).
- **CRM-lite**: contatti dedotti dagli invii form (tag, stato, note), ricerca cross-form, moduli opzionali attivabili per sito — pipeline vendite a stadi fissi e gestione chiamate (log + autoprenotazione pubblica).
- **Token API di lunga durata** (`/admin/api-tokens`) per integrazioni non interattive (n8n, altre automazioni), oltre al login OTP interattivo.
- **Surface API per integrazioni esterne** (`/v1`): REST API multi-tenant che parla il "dialetto CRM diffuso". Tenant risolto dall'header `Location-Id` (id numerico del sito, dominio, o identificativo esterno della location), API key per-sito con Bearer (salvate come hash), endpoint per custom fields, pipeline, contatti, opportunità, preventivi, segmenti, workflow, prenotazioni, payment link, conversazioni, report, attività, email stats e import. Documentazione OpenAPI interattiva su `/v1/docs` (spec su `/v1/openapi.json`).
- **App esterne via SSO**: le applicazioni satellite si autenticano con un token CMS verificato (`POST /api/agent/verify-token`) e consumano i dati CRM che gli servono tramite un'API in sola lettura (opportunità, pipeline, contatti, preventivi, agenda, clienti, verdetti chiamate).
- **Tracking & Analytics** (`/admin/settings/tracking`): Google Analytics 4, Google Tag Manager, Meta Pixel + Conversions API (lato server), Microsoft Clarity, verifica Search Console — con banner di consenso GDPR (Google Consent Mode v2) generato automaticamente appena configurato qualcosa.
- **Trasparenza contenuti IA** (AI Act art. 50, opzionale): dicitura configurabile in footer per chi pubblica contenuti IA senza revisione editoriale umana su temi di interesse pubblico.

## CRM, pipeline e gestione delle chiamate

Oltre alla gestione dei siti, il CMS include un **CRM completo** attivabile per sito tramite moduli opzionali (`site_modules`, toggle in `admin/sites/:id/edit`). Ci sono due moduli: **Pipeline vendite** (`sales_pipeline`) e **Chiamate** (`call_scheduling`). I dati CRM (contatti, opportunità, preventivi, chiamate) sono sempre legati a un sito (`site_id`) e gestiti con permessi RBAC granulari.

### Contatti (CRM-lite)

- **Origine**: i contatti vengono dedotti automaticamente dagli invii dei form pubblici (tag, stato, note) ed è possibile la ricerca cross-form.
- **Scheda contatto** (`/admin/contacts/:email`): stato, tag, note, storico attività, colonne collegate al modulo pipeline/chiamate quando attivi.
- **Operazioni**: aggiunta/rimozione note, modifica campi, export, eliminazione.

### Pipeline vendite (modulo `sales_pipeline`)

- **Scopo**: tenere traccia dell'avanzamento commerciale dei contatti su stadi fissi.
- **Stadi fissi** (vocabolario definito in `src/constants/pipeline.js`): `lead` → `contattato` → `chiamata_fissata` → `proposta_inviata` → `vinto` / `perso`. Un contatto con uno status non incluso in queste chiavi (vuoto o testo libero pre-esistente) compare nella colonna "Da assegnare".
- **Vista kanban** board (`/admin/pipeline`) per spostare i contatti tra gli stadi; valore stimato dell'affare associato.
- **Modifica stadio** con validazione: gli stadi sconosciuti vengono rifiutati.

### Opportunità e preventivi

- **Opportunità/affari** (`/admin/opportunities`, board `/admin/opportunities/board`, kanban con spostamento drag & drop): ogni opportunità è legata a un contatto e a una pipeline con **stadi personalizzabili** (`pipelines`, `db/043`); porta titolo, importo (`amount`), probabilità (`probability` 0-100), stato (`open`/`won`/`lost`), data di chiusura attesa e note.
- **Note & storico** su ogni opportunità (endpoint API dedicati), movimento tra stadi via API (per drag & drop e automazioni).
- **Preventivi** (`/admin/quotes`): documenti legati a un'opportunità e a un contatto, con righe (`items` JSONB: descrizione, quantità, prezzo), numero progressivo e stato che progredisce `draft` → `sent` → `viewed` → `signed`.
- **Token pubblico**: ogni preventivo ha un token univoco per il link al cliente (pattern `pref_token`), così il cliente può vederlo/firmarlo senza credenziali.

### Gestione chiamate (modulo `call_scheduling`)

- **Log chiamate**: programmazione e registrazione delle chiamate dalla scheda contatto, con esito (`outcome`).
- **Calendari** (`/admin/calls/calendars`): creazione, modifica, eliminazione di calendari di disponibilità per la chiamata.
- **Disponibilità settimanale** (`/admin/calls/availability`): slot ricorrenti settimanali.
- **Autoprenotazione pubblica** (`/book/:siteId/:calendarSlug`): il contatto può prenotarsi uno slot in autonomia; cancellazione della prenotazione via token.
- **Protezione**: rate limiting sugli endpoint pubblici di prenotazione.

### Registrazioni chiamate (call recordings)

- **Caricamento** (`/admin/call-recordings`): upload di file audio, ricerca e gestione.
- **Processamento** (`process`): estrazione automatica delle informazioni dalla registrazione (via LLM).
- **Review** singola o bulk (`review`, `bulk-review`): revisione e validazione delle trascrizioni estratte.
- **Metriche chiamate** (`/admin/call-recordings/metrics`): report settimanale con conteggio valide/dubbie/non valide e tasso di validità, con storico delle ultime settimane.
- **Protezione**: rate limiting sul processamento.

### Altri strumenti CRM (`/admin/crm`)

- **Dashboard** CRM con riepilogo attività.
- **Segmenti** (`segments`): definizione di insiemi di contatti.
- **Workflow** (`workflows`): automazioni/regole.
- **Attività/task** (`tasks`): gestione to-do con stato.
- **Funnel** (`funnel`): vista di analisi del flusso di conversione.
- **Conversazioni** (`conversations`): gestione thread con messaggi e stato.

### Newsletter e social

- **Newsletter** (`/admin/newsletter`): gestione iscritti (con export), campagne, template email, impostazioni SMTP con **test di connessione**.
- **Social poster** (`/admin/social`): **attualmente uno stub** (verifica la presenza del token, non pubblica realmente).

## API esterne e integrazioni

Il CMS espone una surface API per strumenti e integrazioni esterne (n8n, dashboard di agenzia, webhook, client CRM-compatibili). Parla il "dialetto CRM diffuso" senza essere legata a un vendor specifico.

### Tenancy con `Location-Id`

Ogni richiesta a `/v1` deve identificare il sito (tenant):

- **Header `Location-Id`** — l'id numerico del sito, il dominio del sito, oppure l'*identificativo esterno della location* (vedi "Mapping Location ↔ Site").
- **`Authorization: Bearer <api-key>`** — ogni sito ha le proprie API key, gestite in `/admin/sites/:id` o via `/v1/api-keys`; le chiavi sono salvate solo come hash SHA-256.
- L'header `Version:` viene accettato e ignorato, per compatibilità con client che lo inviano.

### Mapping Location ↔ Site

`GET /v1/location` legge l'identificativo esterno associato al tenant autenticato; `PUT /v1/location` lo imposta e `DELETE /v1/location` lo azzera. L'identificativo usato dal sistema esterno può poi essere passato in `Location-Id`.

### Endpoint (gruppi principali)

- **Custom fields** — `/custom-fields`
- **Pipeline & stadi** — `/pipelines`
- **Config per-tenant** — `/config`
- **Contatti** — `/contacts` (search, upsert, merge, controllo duplicati, note, tag, task, follower, campagne, workflow)
- **Opportunità** — `/opportunities` (search, upsert, board, status, move, follower)
- **Preventivi** — `/quotes` (CRUD + PDF)
- **Segmenti & workflow** — `/segments`, `/workflows`
- **Prenotazioni & payment link** — `/bookings`, `/booking-calendar-config`, `/payment-links`
- **Conversazioni & analisi** — `/conversations`, `/dashboard`, `/funnel`, `/activities`, `/email-stats` (export CSV)
- **Report** — `/reports`
- **Import** — `/import` (CSV/JSON)
- **API keys & capabilities** — `/api-keys`, `/capabilities`

### Webhook OUT

I webhook outbound inoltrano gli eventi del CMS (contatto creato/aggiornato/eliminato, opportunità creata/eliminata, form inviato, prenotazione creata, ...) verso URL esterni. I payload sono **arricchiti** con i dati completi di contatto/opportunità e custom fields, firmati HMAC-SHA256 (`X-Webhook-Signature`), con timeout e retry con backoff. Gestione via agent API; l'endpoint pubblico di webhook-IN è `/webhooks/in/:siteId/:token`.

### Documentazione interattiva

- `GET /v1/openapi.json` — spec OpenAPI 3.0 (pubblica, senza auth).
- `GET /v1/docs` — Swagger UI interattiva (pubblica).

### App satellite (SSO + dati in sola lettura)

Le applicazioni esterne possono integrarsi con il CMS come "satelliti":

- **`POST /api/agent/verify-token`** valida un JWT del CMS e restituisce identità e sito dell'utente, così il satellite condivide la stessa sessione (SSO).
- **API dati in sola lettura** espone ciò che serve a quelle app: `/api/opportunities`, `/api/pipeline`, `/api/contacts`, `/api/quotes`, `/api/calendar`, `/api/customers`, `/api/customers/activity`, `/api/call-verdict`.

## Stack

Node.js (Express, ESM) + EJS + PostgreSQL, containerizzato con Docker. Autenticazione via magic link + OTP email (nessuna password).

## Architettura di deploy

```
                      ┌──────────────────────────────────┐
                      │        proxyssl (Caddy)           │
                      │  (porte 80/443, SSL, routing)      │
                      └──────┬───────────────────────────┘
                             │
                    dominio richiesto
                             │
                      ┌──────▼───────────────────────────┐
                      │    caddy-gestito (Caddy:8080)     │
                      │  serve media/static dal disco,     │
                      │  proxy passa al CMS se necessario  │
                      └──────┬───────────────────────────┘
                             │
                ┌────────────┼────────────┐
                │            │            │
         file statici     media          API
     (./static/{host})  (./media)   reverse_proxy
                                          │
                                   ┌──────▼──────┐
                                   │ CMS Express │
                                   │  (porta 3000)│
                                   └──────┬──────┘
                                          │
                                   ┌──────▼──────┐
                                   │  Postgres   │
                                   └─────────────┘
```

### Componenti

1. **CMS** (`docker compose up -d`, root del progetto) — servizio `gestione-siti` (Express+EJS) + `db` (Postgres 16).
2. **Caddy gestito** (`docker compose -f caddy-gestito/docker-compose.yml up -d`) — serve `media/`/`static/` dal disco e fa da reverse proxy verso il CMS; è lo stack che resta in piedi anche se il CMS è fermo.
3. **Proxy SSL** (`proxyssl/`, infrastruttura separata) — termina TLS sulle porte 80/443 e inoltra al Caddy gestito.

### Reti Docker

| Nome | Tipo | Scopo |
|---|---|---|
| `edge_net` | external | Collegamento tra proxyssl e i servizi interni |
| `gestione_siti` | external | Collegamento tra CMS e caddy-gestito |
| `internal` | bridge | Collegamento CMS↔db (non accessibile dall'esterno) |

Creare le reti esterne prima di avviare:
```bash
docker network create edge_net
docker network create gestione_siti
```

## Quickstart (Docker)

```bash
# 1. Clonare il progetto e creare le reti (se non esistono)
docker network create edge_net
docker network create gestione_siti

# 2. Copiare .env.example → .env e personalizzare (obbligatorio: DB_PASSWORD, JWT_SECRET)
cp .env.example .env

# 3. Avviare il CMS (esegue anche le migrazioni DB ad ogni boot, vedi db/migrate.js)
docker compose up -d

# 4. Popolare la directory static
bash caddy-gestito/init-static.sh

# 5. Avviare il Caddy gestito
docker compose -f caddy-gestito/docker-compose.yml up -d

# 6. Eseguire il primo export statico di tutti i siti
docker compose exec gestione-siti node scripts/static-export-all.js
```

Configurazione Caddy per nuovi siti: il CMS monta `./caddy-config` e genera dinamicamente i file di configurazione per ogni sito dall'interfaccia admin. Il Caddy gestito non monta questa directory di default — la configurazione statica (media/static/proxy) basta per il funzionamento base.

## Variabili d'ambiente

Vedi [`.env.example`](.env.example) per l'elenco completo con i default. Le principali:

| Variabile | Obbligatoria | Note |
|---|---|---|
| `DATABASE_URL` | Sì | Connection string Postgres |
| `DB_PASSWORD` | Sì | Password Postgres (usata anche da `docker-compose.yml`) |
| `JWT_SECRET` | Sì | Chiave per i token JWT (`openssl rand -hex 64`) |
| `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`/`EMAIL_FROM` | No | Necessarie per l'invio dei magic link via email |
| `MAGIC_LINK_BASE_URL` | No | Base URL usata nei link di accesso via email |
| `APP_NAME`/`APP_TAGLINE`/`APP_LOGO_TEXT`/`ADMIN_TITLE`/`SITE_DEFAULT_BRAND`/`DEFAULT_LANG` | No | Branding dell'installazione, default neutri |
| `OPENAI_API_KEY` | No | Usata per trascrizione audio/video (Whisper) |
| `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY` | No | Provider LLM per rewrite testo e alt-text immagini (default: OpenAI, fallback a `OPENAI_API_KEY`) |
| `CLOUDFLARE_ZONE_ID`/`CLOUDFLARE_API_TOKEN` | No | Purge cache Cloudflare al deploy |
| `DEPLOY_WEBHOOK_URL` | No | Webhook chiamato ad ogni deploy |
| `TWITTER_BEARER_TOKEN`/`LINKEDIN_ACCESS_TOKEN`/`FACEBOOK_PAGE_TOKEN` | No | Social poster (attualmente uno **stub**: verifica solo che il token sia configurato, non pubblica realmente) |

## Struttura del progetto

```
src/
  index.js            Entry point, setup Express, middleware globali, mount delle route
  config.js            Tutta la configurazione da env, con default
  constants/            Costanti condivise (permessi RBAC)
  middleware/           auth, CSRF, i18n, resolve-site, authorize, ...
  routes/               Un file per area funzionale (pages, media, agent, settings, ...)
  services/              Logica di business e integrazioni (export statico, deploy, email, LLM, ...)
db/                    Migrazioni SQL numerate, eseguite in ordine da db/migrate.js
views/                 Template EJS (views/admin/* per il pannello, views/auth/* per il login)
locales/                File di traduzione (it.json, en.json) e documentazione multilingua per agenti (locales/en|it/AGENT.md, MCP.md)
scripts/                Script operativi (avvio container, export statico da CLI, login agente)
caddy-config/            Config Caddy generate dinamicamente per sito
caddy-gestito/           Stack Docker separato per il fallback statico
```

## Sviluppo locale

```bash
npm install
npm run dev      # node --watch src/index.js
npm run migrate  # applica le migrazioni DB non ancora eseguite
```

Richiede una connessione a Postgres raggiungibile (`DATABASE_URL`) e `ffmpeg`/`gdown` per compressione video e import da Google Drive.

## Test

```bash
npm test   # applica le migrazioni sul DB di test, poi node --test
```

Richiede una Postgres di test dedicata (mai quella di produzione: i test
scrivono dati) — es. un container usa-e-getta:

```bash
docker run -d -e POSTGRES_PASSWORD=test -e POSTGRES_DB=testdb -p 15999:5432 postgres:16-alpine
DATABASE_URL=postgres://postgres:test@localhost:15999/testdb JWT_SECRET=qualsiasi-valore npm test
```

Nessun framework esterno: `node:test` built-in. Copertura non esaustiva —
si concentra sui punti di attraversamento tra più moduli (form → CRM →
newsletter) e sulle regressioni di sicurezza note (`test/calls.test.js`
include il caso che ha scoperto la vulnerabilità sul `duration_minutes`
forgiato lato client).

## Licenza

MIT — vedi [`LICENSE`](LICENSE).
