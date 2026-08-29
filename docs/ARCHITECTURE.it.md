# Architettura — Gestione Siti CMS

Un CMS multi-tenant completo per l'automazione di newsletter via email, CRM e gestione pipeline vendite, costruito su Node.js + Express + PostgreSQL.

## Concetti Fondamentali

### Multi-tenant per Sito
Il CMS gestisce più siti web indipendenti (`sites` table), ciascuno con:
- Più domini associati (`site_domains`)
- Contenuti, contatti e impostazioni isolati per sito (tramite `site_id` su tutte le tabelle)
- Moduli per-sito attivabili (funzionalità CRM abilitabile/disabilitabile per sito)
- Branding e variabili per-sito (`site_variables`)

### Modello di Autorizzazione
- **RBAC**: Tre ruoli (`superadmin`, `admin`, `collaboratore`) con permessi granulari per risorsa (`src/constants/permissions.js`)
- **Magic-link + OTP**: Nessuna password; autenticazione via email con token HMAC firmati e rate limiting

### Eventi Basati su Dati
- Tutte le azioni significative emettono `contact_events` (form inviato, email aperta, link cliccato, chiamata completata, ecc.)
- Gli eventi alimentano workflow, segmenti, lead scoring e dashboard

## Stack

| Strato | Tecnologia |
|---------|------------|
| **Runtime** | Node.js 18+ (moduli ESM) |
| **HTTP** | Express.js 4.x |
| **Template** | EJS + express-ejs-layouts |
| **Database** | PostgreSQL 16 (migrazioni in `db/`) |
| **Styling** | CSS semplice (nessun framework) |
| **Deploy** | Docker + docker-compose |
| **Static fallback** | Caddy reverse proxy (serve `media/`/`static/` offline) |

## Panoramica Moduli

### Autenticazione & Controllo Accesso
- **Login magic link** (`services/magic-link.js`): autenticazione via email, token HMAC firmati, rate limiting per IP/email
- **Token JWT** (`config.js`): firmati con `JWT_SECRET`, inclusi in cookie e header bearer
- **RBAC & autorizzazione** (`middleware/authorize.js`, `services/rbac.js`): controlli di permesso per rotta
- **Token API** (`routes/api-tokens.js`, `services/api-tokens.js`): token lunghi per integrazioni non interattive (n8n, altre automazioni), alongside login OTP interattivo

### Gestione Contenuti
- **Pagine** (`routes/admin-pages.js`): pagine versionate, preview, pubblicazione programmata, redirect, SEO per pagina
- **Snippet** (`routes/admin-snippets.js`): frammenti di template riutilizzabili con placeholder `{{snippet:...}}`
- **Variabili di sito** (`routes/admin-site-variables.js`): variabili dinamiche tramite `{{var:...}}`
- **Media** (`routes/media.js`, `services/media-utils.js`): upload/file, importazione da URL (inclusi link Google Drive), compressione video automatica, alt-text generato via LLM, trascrizione audio/video
- **Media protette** (`routes/media-protected.js`): file serviti solo ad utenti autenticati o tramite token HMAC

### Rendering Pagine & Export
- **Rendering live** (`services/site-render.js`): risolve snippet/variabili, inietta SEO fields, serve HTML
- **Export statico** (`services/static-export.js`): genera HTML per tutte le pagine pubblicate, servito da Caddy come fallback
- **SEO** (`services/seo.js`): per-pagina titolo, meta, og-image overrides
- **Layouts** (`views/layouts/`): wrappati (CMS header/nav) vs. standalone (template HTML personal)

### Email & Newsletter
- **Invio email** (`services/email.js`): via Nodemailer (SMTP o JSON transport per dev)
- **Campagne newsletter** (`routes/admin-newsletter-campaigns.js`): email HTML/text con variabili di template, schedulazione
- **Sequenze newsletter** (`routes/admin-newsletter-sequences.js`): email automatizzate multi-step
- **Tracking email** (`services/tracking-email.js`): open/click tracking, UTM parameters, proxy linking
- **Email templates** (`services/email-templates.js`): email system (magic link, conferma, ecc.) con personalizzazione per-sito
- **Email transazionali** (`services/email.js`): notifiche deploy, invii form, chiamate di promemoria, ecc.

### Form & Contatti
- **Form builder** (`routes/admin-forms.js`, `services/contacts.js`): tipi testo/email/tel/textarea/select/radio/checkbox
- **Invii form → upsert contatto** con tag, stato, punteggio
- **Contatti** (`services/contacts.js`): CRM-lite — email, nome, tag, stato, note, custom fields
- **Ricerca contatti** (`routes/admin-contacts.js`): ricerca cross-form, dedupe
- **Unione contatti** (`services/merge.js`): unisci record contatto duplicati

### CRM & Pipeline Vendita
- **Opportunità** (`services/opportunities.js`): bozza/invio/visto/giocato workflow, GDPR-compliant link generazione
- **Pipeline** (`services/opportunities.js`): stadi (lead, contattato, chiamata fissata, proposta inviata, vinto/perso) con valori configurabili
- **Task** (`services/tasks.js`): to-do assegnati a utenti con date di scadenza, stato tracciamento
- **Chiamate** (`services/calls.js`): log chiamate in entrata/uscita, attach a contatti, tracciamento disponibilità/promemoria
- **Registrazioni chiamate** (`services/call-recordings.js`): upload + estrazione automatica trascrizione (Whisper API), conservazione crittografata
- **Sommari chiamate** (`services/call-summaries.js`): riassunti AI di trascrizioni
- **Workflow** (`services/workflows.js`): automazioni — trigger su evento → azione (email, tag, stadio, task, webhook)
- **Segmenti** (`services/segments.js`): gruppi dinamici (ha evento X in ultimi N giorni, tag matches, ecc.)
- **Punteggio** (`services/scoring.js`): accumulo punti per contatto (compilazione form +10, email aperta +5, ecc.), decadimento nel tempo

### AI & Automazione
- **API Agente** (`routes/agent-*.js`): endpoint dedicati per agenti AI (Claude Code, OpenCode) per leggere/scrivere contenuti, media, campagne, CRM
- **Server MCP** (`routes/mcp.js`, `services/mcp-tools.js`): Model Context Protocol — stesse funzionalità esposte come tool per Claude Desktop
- **Runtime Agente** (`services/agent-runtime.js`): gestisce credenziali agente, chiamate LLM, stato conversazione
- **Builder Agente** (`services/agent-builder.js`): definiamo agenti personalizzati con prompt, tool, knowledge base
- **Knowledge base** (`services/kb.js`): archiviazione documenti per riferimento agenti

### Analisi & Reportistica
- **Tracking** (`routes/tracking.js`, `services/tracking.js`): GA4, GTM, Meta Pixel + Conversions API lato server, Microsoft Clarity, verifica Search Console — con banner consenso GDPR (Google Consent Mode v2) appena configurato qualcosa
- **Tracciamento email** (`services/tracking-email.js`): analisi open/click per campagna
- **Statistiche newsletter** (`services/newsletter-stats.js`): tasso consegna, apertura, click per campagna
- **Dashboard** (`services/dashboard.js`): KPI chiave (revenue, valore pipeline, conta lead, ecc.)
- **Report** (`services/reports.js`): costruttore report personalizzabile (filtri, raggruppamento, export PDF)
- **Funnel tracciamento** (`services/tasks.js`, `services/scoring.js`): attribuzione canale, analisi funnel di conversione

### Internazionalizzazione (i18n)
- **Localizzazione** (`locales/it.json`, `locales/en.json`): stringhe interfaccia admin
- **Documentazione multilingua** (`locales/en/AGENT.md`, `locales/it/AGENT.md`, `locales/en/MCP.md`, `locales/it/MCP.md`): documentazione agente e MCP in inglese e italiano
- **Email transazionali** (`services/email.js`): email system generate nella lingua dell'utente

### Integrazioni Esterne
- **OAuth** (`services/oauth.js`): Google login, calendar sync, drive integration
- **Social posting** (`services/social-poster.js`): stub per Twitter/LinkedIn/Facebook (attualmente solo controllo token)
- **Webhooks** (`services/webhooks.js`): notifiche outbound su eventi (form inviato, chiamata completata, ecc.)
- **Calendar sync** (`services/calendar-sync.js`): integrazione Google Calendar per riunioni, disponibilità
- **Pagamenti** (`services/payments.js`): generazione link pagamento (non processamento pagamento completo)
- **Export/import** (`services/export-import.js`): bulk export contatti/forms/campagne come JSON

### System & Operazioni
- **Migrazioni DB** (`db/migrate.js`): controllo versione per cambiamenti schema, numerate e idempotenti
- **Backup** (`services/backup.js`, `routes/admin-backup.js`): backup DB giornalieri (compressi), retention configurabile
- **Attività programmate** (`services/scheduler.js`): esegue workflow, sequenze newsletter, promemorie, decadimento punteggio
- **Audit log** (`services/audit.js`): record di azioni admin (pagine modificate, form pubblicate, ecc.)
- **Webhook deploy** (`services/deploy.js`): notifica sistemi esterni su deploy
- **Impostazioni** (`routes/admin-settings.js`, `services/settings.js`): configurazione globale (per-sito) (branding, codici tracking, ecc.)

## Schema Database

**68 migrazioni** (numerata `001_schema.sql` through `068_call_recordings.sql`), coprent:
- Core: sites, users, pages, snippets, media, forms
- CRM: contacts, opportunities, tasks, calls, recordings, summaries
- Email: campaigns, sequences, templates, tracking
- Automazione: workflows, segments, scoring, eventi, conversazioni
- Admin: audit logs, API tokens, settings, calendar sync
- Analytics: tracking pixels, report configs, dashboard views

Tutti con `created_at`/`updated_at` timestamps e `site_id` per multi-tenancy.

## Esempio Flusso Richiesta: Invio Form → Contatto → Email

1. **Frontend** invia form a `/public/forms/:formId`
2. **Backend** valida, crea record `form_submission`
3. **Upsert contatto** (`services/contacts.js`): trova o crea contatto per email, unisce campi, aggiunge tag
4. **Evento fire** (`services/events.js`): emette `form_submitted` → trigger workflow
5. **Match workflow** (`services/workflows.js`): trova workflow con `trigger: form_submitted`
6. **Azioni**: invia email (template campagna), aggiungi tag, cambia stato, crea task
7. **Coda email** (`services/newsletter.js`): compone con variabili template, invia via SMTP
8. **Tracciamento** (`services/tracking-email.js`): inietta pixel open/click, proxy link
9. **Risultato** in timeline contatto, metriche dashboard, analisi

## Sicurezza

- **CSRF protection** (`middleware/csrf.js`): validazione token su richieste state-changing
- **SSRF guard** (`services/ssrf.js`): blocco IP interni in URL di importazione
- **Rate limiting** (`middleware/auth.js`): max 10 tentativi login per IP/email per 15 min
- **Rotazione JWT** (`middleware/auth.js`): refresh token su login
- **Iniezione SQL** prevenzione: query parameterizzate (modulo pg)
- **XSS** prevenzione: auto-escape EJS, DOMPurify su HTML generato dall'utente
- **Iniezione email** prevenzione: parsing header, CRLF stripping
- **Validazione tipo file** (`services/media-utils.js`): solo MIME image/video/audio/document permessi
- **Media protezione** (`routes/media-protected.js`): HMAC-signed tokens per condivisione file
- **Validazione host header** (`src/index.js:210-219`): regex contro host header poisoning
- **Open redirect prevenzione** (`src/routes/forms.js:210-218`): solo path relativi o host della request
- **OTP brute force** (`src/services/magic-link.js:57-75`): contatore tentativi falliti con tetto, invalidazione dopo N tentativi
- **ReDoS protezione** (`src/services/regex-worker.js:56-60`): timeout su .match() + .replace() per find-replace

## Deploy & Scalabilità

### Docker Compose Stack
- `gestione-siti` service: Express app (porta 3000)
- `db` service: PostgreSQL 16 (porta 5432)
- Reti esterne (`edge_net`, `gestione_siti`) per coordinamento multi-servizio

### Caddy Reverse Proxy
- Stack separato (`caddy-gestito/docker-compose.yml`): serve `media/`/`static/` dal disco
- Fallback quando CMS è down (zero downtime per contenuto statico)
- TLS termination, caching, gzip compression

### Considerazioni Scalabilità
- **Stateless Express** (esegui istanze multiple, bilanciate)
- **PostgreSQL connection pooling**: per istanze multiple app, usa pgBouncer o equivalente
- **Static export + CDN**: per siti molto grandi, esporta a S3 e distribuisci via CloudFront
- **Caddy caching**: configura in `caddy-gestito/Caddyfile` per asset media/static

## Modificare l'Architettura

### Aggiungere un Nuovo Modulo
1. Crea `src/routes/admin-<feature>.js` (interfaccia admin) e/o `src/routes/api-<feature>.js` (API)
2. Crea corrispondente `src/services/<feature>.js` (logica di business)
3. Aggiungi migrazione database in `db/` (numerata sequenzialmente)
4. Aggiungi permessi RBAC a `src/constants/permissions.js`
5. Aggiungi stringhe i18n a `locales/it.json` e `locales/en.json`
6. Monta rotta in `src/index.js`

### Aggiungere una Migrazione Database
```bash
# Crea migrazione
cat > db/NNN_feature.sql << EOF
CREATE TABLE new_table (id SERIAL PRIMARY KEY, site_id INT NOT NULL, ...);
EOF

# Verrà eseguita automaticamente al prossimo avvio dell'app (db/migrate.js)
```

### Aggiungere Endpoint API Agente
- Aggiungi a `src/routes/agent-<feature>.js`
- Incluendi documentazione query params, schema risposta
- Server MCP auto-sincronizza tool tramite introspezione

## Licenza

MIT — vedi [`LICENSE`](LICENSE).
