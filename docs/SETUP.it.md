# Setup & Configurazione Ambiente

Guida per installare e configurare il CMS per sviluppo o deploy in produzione.

## Prerequisiti

- **Node.js**: 18+ (moduli ESM)
- **PostgreSQL**: 16+ (o 13+ con impostazioni di compatibilità)
- **Docker & Docker Compose**: per deploy containerizzato
- **ffmpeg**: opzionale, per compressione video
- **gdown**: opzionale, per importazione media da Google Drive

## Variabili d'ambiente

Copia `.env.example` in `.env` e personalizza per il tuo ambiente. Tutte le variabili sono opzionali salvo dove indicato **Obbligatoria**.

### Database

| Variabile | Obbligatoria | Default | Esempio |
|----------|----------|---------|---------|
| `DATABASE_URL` | **Sì** | — | `postgres://cmsuser:password@db:5432/cms_sites` |
| `DB_PASSWORD` | **Sì** | — | `your-secure-password` |

**Nota**: `DB_PASSWORD` è usata anche da `docker-compose.yml` per il container PostgreSQL.

### Porta & Ambiente Node

| Variabile | Obbligatoria | Default | Esempio |
|----------|----------|---------|---------|
| `PORT` | No | `3000` | `3000` |
| `NODE_ENV` | No | `production` | `production` \| `development` \| `test` |

### Sicurezza

| Variabile | Obbligatoria | Default | Esempio |
|----------|----------|---------|---------|
| `JWT_SECRET` | **Sì** | — | Genera con: `openssl rand -hex 64` |
| `ENCRYPTION_KEY` | No | — | Chiave per cifratura token satelliti (32 byte hex a 64 caratteri o base64) |

**Non** riutilizzare lo stesso `JWT_SECRET` tra installazioni. Generane uno nuovo per ciascuna.

### Email & Magic Link

| Variabile | Obbligatoria | Default | Note |
|----------|----------|---------|-------|
| `SMTP_HOST` | No | — | Server SMTP (es. `smtps.aruba.it`) |
| `SMTP_PORT` | No | `465` | Tipicamente 465 (TLS) o 587 (STARTTLS) |
| `SMTP_USER` | No | — | Username SMTP |
| `SMTP_PASS` | No | — | Password SMTP |
| `EMAIL_FROM` | No | — | Email mittente (es. `noreply@example.it`) |
| `MAGIC_LINK_BASE_URL` | No | — | Base URL per link di accesso via email (es. `https://admin.example.it`) |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |

**Se SMTP non è configurato**: l'app usa `jsonTransport` (logga email in console). Utile in sviluppo.

### Branding (Opzionale, Default Neutri)

| Variabile | Obbligatoria | Default | Note |
|----------|----------|---------|-------|
| `APP_NAME` | No | `CMS Multi-sito` | Nome installazione |
| `APP_TAGLINE` | No | — | Breve tagline (opzionale) |
| `APP_LOGO_TEXT` | No | `CMS` | Logo testuale nel pannello admin |
| `ADMIN_TITLE` | No | `Pannello di amministrazione` | Titolo pagina per pannello admin |
| `SITE_DEFAULT_BRAND` | No | `Il mio sito` | Nome sito predefinito alla creazione |
| `DEFAULT_LANG` | No | `it` | Lingua interfaccia admin: `it` o `en` |

### Storage & Backup

| Variabile | Obbligatoria | Default | Note |
|----------|----------|---------|-------|
| `STATIC_EXPORT_ENABLED` | No | `true` | Abilita export HTML statico per pagine |
| `BACKUP_ENABLED` | No | `true` | Abilita backup DB giornaliero automatico |
| `BACKUP_RETENTION_DAYS` | No | `14` | Mantieni backup per N giorni prima dell'eliminazione |
| `AUDIO_RETENTION_DAYS` | No | `0` | Giorni di retention per audio registrazioni chiamate (0 = disabilitato) |

I backup sono salvati in `./backups/` (volume Docker o directory locale).

### Integrazione AI & LLM

| Variabile | Obbligatoria | Default | Note |
|----------|----------|---------|-------|
| `OPENAI_API_KEY` | No | — | Chiave API OpenAI per trascrizione audio (Whisper) e funzionalità LLM |
| `LLM_BASE_URL` | No | `https://api.openai.com/v1` | URL base provider LLM |
| `LLM_MODEL` | No | `gpt-4o-mini` | Modello LLM per rewrite testo e alt-text |
| `LLM_API_KEY` | No | — | Chiave API provider LLM (se diversa da OpenAI) |

**Comportamento fallback**: se `LLM_BASE_URL` e `LLM_API_KEY` non sono impostate, il sistema usa `OPENAI_API_KEY`.

### Analytics & Tracking

| Variabile | Obbligatoria | Default | Note |
|----------|----------|---------|-------|
| `CLOUDFLARE_ZONE_ID` | No | — | Zone ID Cloudflare per purge cache al deploy |
| `CLOUDFLARE_API_TOKEN` | No | — | Token API Cloudflare |
| `DEPLOY_WEBHOOK_URL` | No | — | URL webhook chiamato ad ogni deploy (POST) |

### Social Media (Attualmente Stub)

| Variabile | Obbligatoria | Default | Note |
|----------|----------|---------|-------|
| `TWITTER_BEARER_TOKEN` | No | — | Token bearer Twitter (attualmente solo controllo token) |
| `LINKEDIN_ACCESS_TOKEN` | No | — | Token accesso LinkedIn (attualmente solo controllo token) |
| `FACEBOOK_PAGE_TOKEN` | No | — | Token pagina Facebook (attualmente solo controllo token) |

**Stato**: il social posting è uno stub. Il sistema valida i token ma non pubblica ancora.

## Avvio Rapido (Docker)

### 1. Clona e Setup

```bash
# Clona il repository
git clone <repo-url>
cd <repo-dir>

# Crea le reti Docker richieste
docker network create edge_net
docker network create gestione_siti

# Copia e personalizza l'ambiente
cp .env.example .env
# Modifica .env con password database, JWT secret, SMTP, ecc.
```

### 2. Inizializza Database

```bash
# Avvia il container database
docker compose up -d db

# Esegui migrazioni (auto-run all'avvio app, ma puoi testarlo)
docker compose run --rm gestione-siti npm run migrate

# Crea primo superadmin (idempotente — inserisce solo se non esiste)
SUPERADMIN_EMAIL=admin@example.it docker compose run --rm gestione-siti node scripts/create-superadmin.js
```

### 3. Avvia il CMS

```bash
# Avvia CMS e database
docker compose up -d

# Verifica che sia in esecuzione
curl -s http://localhost:3000/health | head -20
```

### 4. Inizializza Directory Static & Caddy

```bash
# Crea directory per servire file statici
bash caddy-gestito/init-static.sh

# Avvia Caddy gestito (fallback per file statici/media quando CMS è down)
docker compose -f caddy-gestito/docker-compose.yml up -d

# Esporta tutte le pagine pubblicate come HTML statico
docker compose exec gestione-siti node scripts/static-export-all.js
```

### 5. Accedi al Pannello Admin

1. Apri `http://localhost:3000/admin`
2. Richiedi un magic link con la tua email superadmin
3. Controlla l'email (o la console se SMTP non è configurato)
4. Clicca il link per inserire l'OTP e accedere

## Sviluppo Locale (Senza Docker)

### 1. Setup Database

```bash
# Crea database PostgreSQL locale
createdb cms_sites
psql cms_sites -c "CREATE USER cmsuser WITH PASSWORD 'changeme';"
psql cms_sites -c "ALTER ROLE cmsuser WITH SUPERUSER;"

# Oppure usa un container Docker:
docker run -d -e POSTGRES_PASSWORD=changeme -e POSTGRES_DB=cms_sites -p 5432:5432 postgres:16-alpine
```

### 2. File Ambiente

```bash
cp .env.example .env

# Aggiorna .env con connessione locale
DATABASE_URL=postgres://cmsuser:changeme@localhost:5432/cms_sites
DB_PASSWORD=changeme
JWT_SECRET=$(openssl rand -hex 64)
```

### 3. Installa & Avvia

```bash
npm install
npm run migrate    # Applica migrazioni database
npm run dev        # Avvia con node --watch src/index.js
```

L'app sarà disponibile su `http://localhost:3000`.

## Test

### Setup Database di Test

```bash
# Opzione 1: Container Docker (consigliato)
docker run -d -e POSTGRES_PASSWORD=test -e POSTGRES_DB=testdb -p 15999:5432 postgres:16-alpine

# Opzione 2: Crea database locale
createdb testdb
```

### Esegui Test

```bash
# Usando container Docker di test
DATABASE_URL=postgres://postgres:test@localhost:15999/testdb JWT_SECRET=test-secret npm test

# Oppure se in esecuzione locale:
npm test
```

I test eseguono le migrazioni, lanciano tutti i file `.test.js` sequenzialmente ed escono. La copertura si concentra su:
- Scambi cross-modulo (form → CRM → newsletter)
- Regressioni di sicurezza (es. `duration_minutes` forgiato lato client sulle chiamate)

## Risoluzione Problemi

### "ECONNREFUSED" sul Database

- Verifica che `DATABASE_URL` punti a un'istanza PostgreSQL in esecuzione
- Controlla firewall/accesso di rete
- Per Docker: assicurati che le reti (`edge_net`, `gestione_siti`, `internal`) esistano

### Migrazioni Falliscono

- Controlla versione PostgreSQL (16 consigliato, 13+ supportato)
- Verifica che l'utente database abbia `SUPERUSER` o permessi necessari
- Pulisci migrazioni cached: `rm -rf db/.migrate_*`

### SMTP Non Funziona

- Verifica `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` siano corretti
- Controlla che il firewall permetta SMTP in uscita (porta 465/587)
- In dev mode senza SMTP: le email vengono loggate in console

### Export Statico Fallisce

- Assicurati che `ffmpeg` sia installato (per compressione video)
- Controlla spazio su disco per HTML generato
- Verifica permessi directory su `./static/` e `./media/`

## Best Practice di Sicurezza

1. **Usa sempre HTTPS** in produzione (via reverse proxy o Caddy)
2. **Ruota `JWT_SECRET`** se può essere stato esposto
3. **Mantieni `.env` e `/media-protected/` fuori dal versionamento** (`.gitignore` gestisce questo)
4. **Abilita `BACKUP_ENABLED`** in produzione
5. **Usa credenziali SMTP forti** e abilita TLS
6. **Limita accesso di rete** al database (non accessibile pubblicamente)
7. **Monitora log di audit** (`/admin/audit`) per attività sospette
8. **Rate-limit tentativi di login** (già abilitato)

## Ottimizzazione Performance

- **Connection pooling PostgreSQL**: per istanze app multiple, usa pgBouncer o equivalente
- **Static export + CDN**: per siti molto grandi, esporta a S3 e distribuisci via CloudFront
- **Caching Caddy**: configura in `caddy-gestito/Caddyfile` per asset media/static
- **Coda email**: considera una coda asincrona (Bull, Bullmq) se invii 1000+ email/ora

## Supporto

Per problemi o domande:
1. Controlla il [README](../README.it.md) principale
2. Rivedi [ARCHITECTURE.it.md](./ARCHITECTURE.it.md) per decisioni di design
3. Apri una issue su GitHub
