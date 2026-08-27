#!/usr/bin/env bash
# run-tick.sh — Invoca POST /api/agent/tick (azioni differite dei workflow,
# decay scoring, refresh segmenti dinamici) via curl, per triggerarlo da
# cron esterno oltre allo scheduler interno del processo.
#
# Uso:
#   TICK_TOKEN=<api-token-agente> scripts/run-tick.sh [site_id]
#
# Variabili d'ambiente:
#   BASE_URL    default http://localhost:3000
#   TICK_TOKEN  obbligatoria — token API di un utente agente (superadmin se
#               si omette site_id, altrimenti utente con accesso al sito)
#   RUN_DECAY / RUN_SEGMENTS  opzionali ("true"/"false") per forzare o
#               saltare quei due step indipendentemente dal contatore interno

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
SITE_ID="${1:-}"

if [ -z "${TICK_TOKEN:-}" ]; then
  echo "Errore: variabile TICK_TOKEN mancante (token API di un utente agente)" >&2
  exit 1
fi

BODY="{}"
if [ -n "$SITE_ID" ]; then
  BODY=$(printf '{"site_id": %s}' "$SITE_ID")
fi
if [ -n "${RUN_DECAY:-}" ]; then
  BODY=$(echo "$BODY" | node -e "const b=JSON.parse(require('fs').readFileSync(0,'utf8'));b.run_decay=process.argv[1]==='true';process.stdout.write(JSON.stringify(b));" "$RUN_DECAY")
fi
if [ -n "${RUN_SEGMENTS:-}" ]; then
  BODY=$(echo "$BODY" | node -e "const b=JSON.parse(require('fs').readFileSync(0,'utf8'));b.run_segments=process.argv[1]==='true';process.stdout.write(JSON.stringify(b));" "$RUN_SEGMENTS")
fi

curl -sS -X POST "${BASE_URL%/}/api/agent/tick" \
  -H "Authorization: Bearer ${TICK_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$BODY"
echo
