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
- **Tracking & Analytics** (`/admin/settings/tracking`): Google Analytics 4, Google Tag Manager, Meta Pixel + Conversions API (lato server), Microsoft Clarity, verifica Search Console — con banner di consenso GDPR (Google Consent Mode v2) generato automaticamente appena configurato qualcosa.
- **Trasparenza contenuti IA** (AI Act art. 50, opzionale): dicitura configurabile in footer per chi pubblica contenuti IA senza revisione editoriale umana su temi di interesse pubblico.

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
