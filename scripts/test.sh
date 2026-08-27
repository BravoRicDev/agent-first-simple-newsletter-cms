#!/usr/bin/env bash
# test.sh — Lancia la suite di test del repo puntando al DB di test locale.
#
# Il DB di test è il container Docker `cms-test-pg` (postgres:16-alpine),
# esposto su localhost:15999, DB testdb.
#   docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=testdb -p 15999:5432 postgres:16-alpine
#
# Uso:
#   scripts/test.sh                 # migrate + tutta la suite
#   scripts/test.sh <file.test.js>  # migrate + solo i file indicati
#
# Il comando imposta DATABASE_URL e JWT_SECRET per la suite, quindi
# non serve esportarli a mano. Importante: DEVE essere lanciato dall'host
# (non da dentro un container né dal path di rete Docker `db:5432`).

set -euo pipefail
cd "$(dirname "$0")/.."

DB_URL="${DATABASE_URL:-postgres://postgres:***@localhost:15999/testdb}"
JWT="${JWT_SECRET:-test-jwt-secret-per-la-suite-locale-non-usa-in-produzione}"

echo "==> Migrazioni su DB di test (${DB_URL%%@*}@...)"
DATABASE_URL="$DB_URL" node db/migrate.js

echo "==> Suite di test"
if [ "$#" -gt 0 ]; then
  DATABASE_URL="$DB_URL" JWT_SECRET="$JWT" \
    node --test --test-force-exit --test-concurrency=1 "$@"
else
  DATABASE_URL="$DB_URL" JWT_SECRET="$JWT" \
    node --test --test-force-exit --test-concurrency=1
fi
