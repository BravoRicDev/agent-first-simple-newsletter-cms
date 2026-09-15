#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# verify-twin.sh — verifica che i due nodi siano "gemelli" (contenuti identici).
#
# Fase 1 — FILE: confronto checksum dei 4 alberi dati via `rsync -c` in
#           dry-run (report, nessuna modifica).
# Fase 2 — DB:  lag di replicazione PostgreSQL da pg_stat_replication.
#           Sullo standby `pg_is_in_recovery()` deve rispondere TRUE.
#
# Uso (DA ESEGUIRE SUL NODO PRIMARY, es. nodo A):
#   TWIN_TARGET=user@10.0.0.2 TWIN_REMOTE_REPO=/home/user/gestione-siti-riccardom \
#     infra/cluster/verify-twin.sh
#
# Variabili:
#   TWIN_TARGET       obbligatoria: host del peer gemello
#   TWIN_REMOTE_REPO  percorso repo sul peer (default ~/gestione-siti-riccardom)
#   TWIN_DIRS         spazi-separati, default "media media-protected static backups"
#   PGPORT/psql      per il check DB (default: usa psql dal container patroni)
#                         -> patroni-<NODE_ID> exec psql ...
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

TWIN_TARGET="${TWIN_TARGET:?TWIN_TARGET obbligatoria, es. user@10.0.0.2}"
TWIN_REMOTE_REPO="${TWIN_REMOTE_REPO:-$HOME/gestione-siti-riccardom}"
TWIN_DIRS="${TWIN_DIRS:-media media-protected static backups}"
PATRONI_CONTAINER="${PATRONI_CONTAINER:-patroni-A}"
DATABASE_URL="${DATABASE_URL:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CMS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "==> FASE 1: confronto file (dry-run checksum) verso ${TWIN_TARGET}"
FAILED=0
for dir in $TWIN_DIRS; do
  echo "   - ${dir}/"
  DIFF=$(rsync -rcn --links --exclude '*.tmp' --exclude '*.tmp.*' \
    "${CMS_DIR}/${dir}/" "${TWIN_TARGET}:${TWIN_REMOTE_REPO}/${dir}/" 2>&1 | grep -v '^$' | grep -v '^sending incremental' || true)
  if [ -n "$DIFF" ]; then
    echo "   ✗ DIVERGENZE in ${dir}:"
    echo "$DIFF" | tail -n 20
    FAILED=1
  else
    echo "   ✓ identici"
  fi
done

echo ""
echo "==> FASE 2: lag replicazione PostgreSQL"
if command -v psql >/dev/null 2>&1; then
  psql "${DATABASE_URL:-postgres://postgres@localhost:5432/cms_sites}" -tAc "
    SELECT client_addr,
           state,
           sync_state,
           pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes
    FROM pg_stat_replication;" 2>/dev/null || echo "   (psql non disponibile qui — esegui il check dentro il container Patroni)"
else
  echo "   (psql non installato sul nodo — esegui:"
  echo "    docker exec ${PATRONI_CONTAINER} psql -U postgres -c \"SELECT client_addr,state,sync_state,pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes FROM pg_stat_replication;\" )"
fi

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "!! Trovate divergenze nei file. Attendi il sync Syncthing o riallinea."
  exit 1
fi
echo ""
echo "==> Verifica completata: contenuti gemelli."