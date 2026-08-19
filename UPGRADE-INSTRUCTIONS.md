# Istruzioni di upgrade — dalla versione baseline a quella attuale

Questo documento serve a portare un'installazione in produzione ferma alla
**primissima versione** (commit `fc053c0`, "Baseline iniziale repo locale")
allo stato attuale del repo, senza rompere il sito già online.

Tra le due versioni ci sono **55 commit** e circa **7700 righe modificate**:
fix di sicurezza (privilege escalation, IDOR, SSRF, XSS, CSRF, ReDoS),
internazionalizzazione IT/EN, permessi granulari, newsletter, backup
automatico, export statico, MCP server. Non è un piccolo patch — trattalo
come un vero e proprio major upgrade, non come un `git pull` a cuor leggero.

Leggi tutto il documento **prima** di iniziare. I passi vanno fatti in ordine,
su **una macchina alla volta**.

---

## 0. Prerequisiti

- Accesso SSH alla macchina di produzione
- `docker` e `docker compose` funzionanti (l'installazione baseline già li usa)
- Circa 15-20 minuti di finestra di manutenzione per sito (il sito resta
  comunque servito dal fallback statico Caddy durante il riavvio del container
  CMS, quindi il downtime reale per i visitatori è minimo — ma l'admin non
  sarà utilizzabile per qualche minuto)

---

## 1. Backup (obbligatorio, non saltare)

```bash
cd /percorso/del/progetto

# Backup del database
docker compose exec db pg_dump -U cmsuser cms_sites | gzip > backup_pre_upgrade_$(date +%Y%m%d).sql.gz

# Backup di .env e della cartella media (se non già coperta da backup esterni)
cp .env .env.backup_pre_upgrade
tar czf media_backup_$(date +%Y%m%d).tar.gz media/

# Segnati il commit attuale, ti serve per il rollback
git rev-parse HEAD > .git_commit_pre_upgrade.txt
```

Le migrazioni SQL introdotte tra baseline e HEAD sono **tutte additive e
idempotente** (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
nessun `DROP TABLE`/`DROP COLUMN`): questo è stato verificato riga per riga.
Questo rende l'upgrade a basso rischio sul fronte schema — il backup resta
comunque la rete di sicurezza in caso di imprevisti applicativi.

---

## 2. Aggiornare il codice

```bash
git fetch origin
git checkout main
git pull origin main
```

Se il repo locale ha modifiche non committate specifiche del cliente (es. file
in `caddy-config/`, `media/`, `static/`), verifica che non vengano toccate —
sono già escluse da `.gitignore` sia nella baseline sia in HEAD.

---

## 3. Aggiornare `.env` — qui è dove si rompe se non stai attento

Confronta il tuo `.env` attuale con il nuovo `.env.example`:

```bash
diff .env .env.example
```

Il `.env` della baseline copriva solo: `PORT`, `NODE_ENV`, `DATABASE_URL`,
`DB_PASSWORD`, `JWT_SECRET`, `SMTP_*`, `EMAIL_FROM`, `MAGIC_LINK_BASE_URL`,
`LOG_LEVEL`, `STATIC_EXPORT_ENABLED`. Queste restano tutte valide, **non
toccarle**.

Sono state aggiunte le seguenti variabili **opzionali** (se non le imposti,
l'app parte comunque, ma con dei default *generici*, non quelli del cliente
— vedi punto 3.1 sotto):

```
APP_NAME=CMS Multi-sito
APP_TAGLINE=
APP_LOGO_TEXT=CMS
ADMIN_TITLE=Pannello di amministrazione
SITE_DEFAULT_BRAND=Il mio sito
DEFAULT_LANG=it

BACKUP_ENABLED=true
BACKUP_RETENTION_DAYS=14

OPENAI_API_KEY=
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=
CLOUDFLARE_ZONE_ID=
CLOUDFLARE_API_TOKEN=
DEPLOY_WEBHOOK_URL=
TWITTER_BEARER_TOKEN=
LINKEDIN_ACCESS_TOKEN=
FACEBOOK_PAGE_TOKEN=
```

Aggiungile in coda al tuo `.env` esistente, personalizzando almeno `APP_NAME`
e `SITE_DEFAULT_BRAND` con il nome del brand/cliente di quella macchina.

Se non usavi già queste integrazioni (OpenAI/LLM, Cloudflare, social) lascia
tutto vuoto: le relative funzionalità restano semplicemente disattivate, non
c'è nessun comportamento "di default attivo" da temere.

### 3.1 Cosa era hardcoded e ora NON lo è più (azione richiesta)

Questo è il punto che ci interessa di più. Nella baseline, testo e colori
del sito pubblico e del pannello admin erano **scritti a mano nei template**
(`views/layouts/site.ejs`, `views/partials/footer.ejs`,
`views/layouts/admin.ejs`), quindi specifici del cliente per cui quella
copia del CMS era stata fatta girare. Ora sono **configurabili**, con
fallback generici se non configurati:

| Prima (hardcoded nel template) | Ora (da dove viene) | Fallback se non configurato |
|---|---|---|
| Titolo pagina / logo sito pubblico | `site_variables.logo_text` → `SITE_DEFAULT_BRAND` | "Il mio sito" |
| Colori tema (`--primary`/`--secondary`) | `site_variables.primary_color`/`secondary_color` | `#37ca37`/`#188bf6` (**uguali** a quelli hardcoded in baseline — nessuna regressione qui) |
| Nome azienda nel footer | `site_variables.brand_name` → `SITE_DEFAULT_BRAND` | "Il mio sito" |
| Blocco contatti nel footer (in baseline: `WEB AGENCY` + indirizzo + EIN) | `site_variables.contact_email` | **vuoto** se non impostato — il blocco contatti sparisce |
| Copyright nel footer | `site_variables.legal_line` | `© {anno} {brand_name} - All rights reserved.` generico |
| Titolo/logo pannello admin | `APP_NAME` (env, globale per installazione) | "CMS Multi-sito" |

**Azione da fare per ogni sito gestito da questa installazione, dopo
l'upgrade**: nel pannello admin, per ciascun sito imposta le variabili
`brand_name`, `contact_email`, `legal_line`, `logo_text`,
`primary_color`, `secondary_color` (dove serve mantenere l'aspetto attuale
del sito pubblico) tramite la sezione variabili del sito
(`site_variables` — stessa tabella già usata per `{{var:...}}` nelle
pagine). Finché non lo fai, il sito pubblico mostrerà i valori generici
sopra, **non** i dati reali del cliente — non è un errore, è il
comportamento previsto in assenza di configurazione.

Se una macchina serve un solo sito/cliente, in alternativa puoi coprire il
caso comune impostando solo `SITE_DEFAULT_BRAND` in `.env` (si applica come
fallback ovunque non sia impostata una `site_variables` specifica), ma
`contact_email`/`legal_line` restano da impostare esplicitamente perché non
hanno un equivalente `.env` globale.

---

## 4. Rebuild dell'immagine Docker (obbligatorio)

Tra baseline e HEAD sono cambiate le dipendenze npm (`file-type`,
`@modelcontextprotocol/sdk`) e il `Dockerfile`:

- aggiunto `postgresql16-client` nell'immagine (serve al backup automatico,
  fa `pg_dump` da dentro il container)
- aggiunto `COPY locales ./locales` — **senza questo l'i18n fallisce in
  silenzio e mostra le chiavi grezze invece del testo** (bug già capitato
  una volta in questo stesso progetto, vedi commit `2ae07e0`)

Un semplice riavvio del container **non basta**, serve un rebuild:

```bash
docker compose build --no-cache gestione-siti
docker compose up -d
```

Le migrazioni del database (`db/*.sql`) e l'export statico partono
**automaticamente** ad ogni avvio del container (`scripts/start.sh`, invariato
dalla baseline) — non serve lanciarle a mano. Sono idempotenti: alla prima
esecuzione dopo l'upgrade rieseguiranno anche le migrazioni già applicate in
passato (001-016), che sono innocue perché scritte con `IF NOT EXISTS`, e poi
applicheranno le nuove (017-023: tentativi OTP falliti, tabella
`schema_migrations`, sequenze newsletter, ecc.).

Se `BACKUP_ENABLED=true`, assicurati che la cartella `./backups` esista sulla
macchina host con permessi di scrittura (il nuovo `docker-compose.yml` la
monta come volume):

```bash
mkdir -p backups
```

---

## 5. Verifica post-upgrade (checklist)

Dopo il riavvio, controlla in quest'ordine:

1. **Login**: prova un login completo (magic link + eventuale OTP). È stato
   aggiunto un flag `secure` sui cookie di sessione quando `NODE_ENV=production`
   — se il sito **non è servito su HTTPS**, i cookie non verranno accettati
   dal browser e il login sembrerà "non fare nulla". Se la macchina è dietro
   Caddy/proxyssl con TLS attivo (architettura standard di questo progetto),
   non c'è nulla da fare; se per qualche motivo gira ancora in HTTP puro,
   vanno risolto quello prima.
2. **Un submit di un form autenticato nel pannello** (es. modifica una
   pagina): è stata aggiunta una protezione CSRF basata su Origin/Referer.
   Se l'admin è raggiunto tramite un dominio/porta diversi da quello atteso
   (es. tunnel, proxy che riscrive l'Host), può bloccare il submit con "Origin
   non valida" — in tal caso verifica che il reverse proxy passi correttamente
   l'header `Host` originale.
3. **`/admin/media`**: nella baseline questa pagina era completamente rotta
   (view mancante, 404), ora funziona — verifica che carichi la lista dei
   file esistenti sul sito.
4. **Aspetto del sito pubblico e del footer**: confronta con come appariva
   prima (vedi punto 3.1). Se manca il blocco contatti o il nome è generico
   ("Il mio sito"), imposta le `site_variables` mancanti.
5. Se usi upload media: prova a caricare un file. È stata aggiunta una
   verifica del contenuto reale del file (magic-bytes) oltre all'estensione
   — un file valido non viene toccato da questo controllo, ma se noti un
   upload legittimo rifiutato con "il contenuto del file non corrisponde
   all'estensione dichiarata", segnalalo (non dovrebbe succedere con file
   integri).
6. Se usi la newsletter: verifica in `Impostazioni sito → Newsletter` che
   SMTP per-sito sia ancora configurato (tabella dedicata `newsletter_settings`,
   introdotta con l'upgrade, separata da `site_variables` per non esporre le
   credenziali nel rendering pubblico delle pagine).
7. Controlla i log del container per messaggi di errore all'avvio:
   ```bash
   docker compose logs -f gestione-siti
   ```

---

## 6. Rollback

Se qualcosa va storto e serve tornare indietro rapidamente:

```bash
git checkout $(cat .git_commit_pre_upgrade.txt)
docker compose build --no-cache gestione-siti
docker compose up -d
```

Il database **non va ripristinato dal backup** in questo caso: tutte le
modifiche allo schema tra baseline e HEAD sono additive (nuove tabelle/colonne
con default), quindi il codice vecchio continua a funzionare tranquillamente
anche con lo schema nuovo — ignora semplicemente le colonne/tabelle che non
conosce. Usa il backup del DB solo come ultima rete di sicurezza in caso di
problemi non previsti da questo documento.

---

## 7. Riferimento — cosa cambia, in sintesi

Per contesto, le aree principali toccate tra baseline e HEAD (dettagli nei
messaggi di commit, tutti in italiano, `git log --oneline fc053c0..HEAD`):

- **Sicurezza**: privilege escalation su gestione utenti, IDOR su risorse
  scoped per sito (pagine, media, social, template, snippet), SSRF su
  import da URL, XSS stored (onclick inline → event listener), CSRF su
  richieste autenticate via cookie, ReDoS su find&replace, lockout OTP,
  revoca token JWT effettiva, sanitizzazione SVG, rimozione js/css dai
  file caricabili, verifica magic-bytes sui media.
- **i18n**: pannello admin, documentazione agente, tool MCP, email
  transazionali in italiano/inglese.
- **Permessi**: RBAC granulare per risorsa (`src/constants/permissions.js`),
  non più solo per ruolo.
- **Feature nuove**: newsletter (broadcast + sequenze evergreen), backup DB
  automatico schedulato, dashboard analytics, export CSV, sitemap/robots.txt
  automatici, server MCP.
- **Branding**: da hardcoded per singola installazione a configurabile per
  installazione (`.env`) e per sito (`site_variables`) — vedi punto 3.1.
