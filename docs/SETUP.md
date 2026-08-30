# Setup & Environment Configuration

Guide for installing and configuring the CMS for development or production deployment.

## Prerequisites

- **Node.js**: 18+ (ESM modules)
- **PostgreSQL**: 16+ (or 13+ with compatibility settings)
- **Docker & Docker Compose**: for containerized deployment
- **ffmpeg**: optional, for video compression
- **gdown**: optional, for Google Drive media import

## Environment Variables

Copy `.env.example` to `.env` and customize for your environment. All variables are optional unless marked **Required**.

### Database

| Variable | Required | Default | Example |
|----------|----------|---------|---------|
| `DATABASE_URL` | **Yes** | — | `postgres://cmsuser:password@db:5432/cms_sites` |
| `DB_PASSWORD` | **Yes** | — | `your-secure-password` |

**Note**: `DB_PASSWORD` is also used by `docker-compose.yml` for the PostgreSQL container.

### Port & Node Environment

| Variable | Required | Default | Example |
|----------|----------|---------|---------|
| `PORT` | No | `3000` | `3000` |
| `NODE_ENV` | No | `production` | `production` \| `development` \| `test` |

### Security

| Variable | Required | Default | Example |
|----------|----------|---------|---------|
| `JWT_SECRET` | **Yes** | — | Generate with: `openssl rand -hex 64` |

**Do NOT** reuse the same `JWT_SECRET` across installations. Generate a new one for each.

### Email & Magic Links

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `SMTP_HOST` | No | — | SMTP server (e.g., `smtps.aruba.it`) |
| `SMTP_PORT` | No | `465` | Typically 465 (TLS) or 587 (STARTTLS) |
| `SMTP_USER` | No | — | SMTP username |
| `SMTP_PASS` | No | — | SMTP password |
| `EMAIL_FROM` | No | — | Sender email (e.g., `noreply@example.it`) |
| `MAGIC_LINK_BASE_URL` | No | — | Base URL for email access links (e.g., `https://admin.example.it`) |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |

**If SMTP is not configured**: the app falls back to `jsonTransport` (logs emails to console). Useful for development.

### Branding (Optional, Neutral Defaults)

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `APP_NAME` | No | `CMS Multi-sito` | Installation name |
| `APP_TAGLINE` | No | — | Short tagline (optional) |
| `APP_LOGO_TEXT` | No | `CMS` | Text logo in admin panel |
| `ADMIN_TITLE` | No | `Pannello di amministrazione` | Page title for admin panel |
| `SITE_DEFAULT_BRAND` | No | `Il mio sito` | Default site name when creating new sites |
| `DEFAULT_LANG` | No | `it` | Admin interface language: `it` or `en` |

### Storage & Backup

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `STATIC_EXPORT_ENABLED` | No | `true` | Enable static HTML export for pages |
| `BACKUP_ENABLED` | No | `true` | Enable automatic daily DB backup |
| `BACKUP_RETENTION_DAYS` | No | `14` | Keep backups for N days before delete |

Backups are stored in `./backups/` (docker volume or local directory).

### AI & LLM Integration

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `OPENAI_API_KEY` | No | — | OpenAI API key for audio transcription (Whisper) and LLM features |
| `LLM_BASE_URL` | No | `https://api.openai.com/v1` | LLM provider base URL |
| `LLM_MODEL` | No | `gpt-4o-mini` | LLM model ID for text rewriting and alt-text |
| `LLM_API_KEY` | No | — | LLM provider API key (if different from OpenAI) |

**Fallback behavior**: if `LLM_BASE_URL` and `LLM_API_KEY` are not set, the system uses `OPENAI_API_KEY`.

### Analytics & Tracking

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `CLOUDFLARE_ZONE_ID` | No | — | Cloudflare zone ID for cache purge on deploy |
| `CLOUDFLARE_API_TOKEN` | No | — | Cloudflare API token |
| `DEPLOY_WEBHOOK_URL` | No | — | Webhook URL called on every deploy (POST) |

### Social Media (Currently Stubs)

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `TWITTER_BEARER_TOKEN` | No | — | Twitter API bearer token (currently checks token only) |
| `LINKEDIN_ACCESS_TOKEN` | No | — | LinkedIn access token (currently checks token only) |
| `FACEBOOK_PAGE_TOKEN` | No | — | Facebook page token (currently checks token only) |

**Status**: social posting implementato. Il sistema chiama le API di Twitter/LinkedIn/Facebook quando i token sono configurati, e usa la modalità simulata quando non sono disponibili. I post sono marcati come `simulated: true` o `false` per distinguerli.

## Quick Start (Docker)

### 1. Clone and Setup

```bash
# Clone the repository into your own directory
git clone <repo-url>
cd <repo-dir>

# Create required Docker networks
docker network create edge_net
docker network create gestione_siti

# Copy and customize environment
cp .env.example .env
# Edit .env with your database password, JWT secret, SMTP settings, etc.
```

### 2. Initialize Database

```bash
# Start the database container
docker compose up -d db

# Run migrations (auto-runs on app boot, but you can test it)
docker compose run --rm gestione-siti npm run migrate

# Create first superadmin (idempotent — only inserts if not exists)
SUPERADMIN_EMAIL=admin@example.it docker compose run --rm gestione-siti node scripts/create-superadmin.js
```

### 3. Start the CMS

```bash
# Start both CMS and database
docker compose up -d

# Verify it's running
curl -s http://localhost:3000/health | head -20
```

### 4. Initialize Static Directory & Caddy

```bash
# Create static serving directories
bash caddy-gestito/init-static.sh

# Start the managed Caddy (fallback for static files/media when CMS is down)
docker compose -f caddy-gestito/docker-compose.yml up -d

# Export all published pages to static HTML
docker compose exec gestione-siti node scripts/static-export-all.js
```

### 5. Access the Admin Panel

1. Open `http://localhost:3000/admin`
2. Request a magic link with your superadmin email
3. Check email (or console if SMTP is not configured)
4. Click the link to set OTP and log in

## Local Development (Without Docker)

### 1. Setup Database

```bash
# Create local PostgreSQL database
createdb cms_sites
psql cms_sites -c "CREATE USER cmsuser WITH PASSWORD 'changeme';"
psql cms_sites -c "ALTER ROLE cmsuser WITH SUPERUSER;"

# Or use a Docker container:
docker run -d -e POSTGRES_PASSWORD=changeme -e POSTGRES_DB=cms_sites -p 5432:5432 postgres:16-alpine
```

### 2. Environment File

```bash
cp .env.example .env

# Update .env with local connection
DATABASE_URL=postgres://cmsuser:changeme@localhost:5432/cms_sites
DB_PASSWORD=changeme
JWT_SECRET=$(openssl rand -hex 64)
```

### 3. Install & Run

```bash
npm install
npm run migrate    # Apply database migrations
npm run dev        # Start with node --watch src/index.js
```

The app will be available at `http://localhost:3000`.

## Testing

### Setup Test Database

```bash
# Option 1: Docker container (recommended)
docker run -d -e POSTGRES_PASSWORD=test -e POSTGRES_DB=testdb -p 15999:5432 postgres:16-alpine

# Option 2: Create local database
createdb testdb
```

### Run Tests

```bash
# Using Docker test container
DATABASE_URL=postgres://postgres:test@localhost:15999/testdb JWT_SECRET=test-secret npm test

# Or if running locally:
npm test
```

Tests run migrations, execute all `.test.js` files sequentially, and exit. Coverage focuses on:
- Cross-module handoffs (form → CRM → newsletter)
- Security regressions (e.g., forged `duration_minutes` on calls)

## Troubleshooting

### "ECONNREFUSED" on Database

- Verify `DATABASE_URL` points to a running PostgreSQL instance
- Check firewall/network access
- For Docker: ensure networks (`edge_net`, `gestione_siti`, `internal`) exist

### Migrations Fail

- Check PostgreSQL version (16 recommended, 13+ supported)
- Verify database user has `SUPERUSER` or necessary permissions
- Clear cached migrations: `rm -rf db/.migrate_*` (if using migration state file)

### SMTP Not Working

- Verify `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` are correct
- Check firewall allows outbound SMTP (port 465/587)
- In dev mode without SMTP: emails log to console

### Static Export Fails

- Ensure `ffmpeg` is installed (for video compression)
- Check disk space for generated HTML
- Verify directory permissions on `./static/` and `./media/`

## Security Best Practices

1. **Always use HTTPS** in production (via reverse proxy or Caddy)
2. **Rotate `JWT_SECRET`** if it may have been exposed
3. **Keep `.env` and `/media-protected/` out of version control** (`.gitignore` handles this)
4. **Enable BACKUP_ENABLED** in production
5. **Use strong SMTP credentials** and enable TLS
6. **Restrict network access** to the database (not publicly accessible)
7. **Monitor audit logs** (`/admin/audit`) for suspicious activity
8. **Rate-limit login attempts** (already enabled)

## Performance Tuning

- **PostgreSQL connection pooling**: for multiple app instances, use pgBouncer or equivalent
- **Static export + CDN**: for very large sites, export to S3 and distribute via CloudFront
- **Caddy caching**: configure in `caddy-gestito/Caddyfile` for media/static assets
- **Email queue**: consider async job queue (Bull, Bullmq) if sending 1000s of emails per hour

## Support

For issues or questions:
1. Check the main [README.md](../README.md)
2. Review [ARCHITECTURE.md](./ARCHITECTURE.md) for design decisions
3. Open an issue on GitHub
