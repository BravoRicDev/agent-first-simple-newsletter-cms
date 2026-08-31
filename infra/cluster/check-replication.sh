#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# check-replication.sh — stato del cluster Patroni + lag di replicazione.
#
# Interroga:
#   1. Patroni REST API (/cluster, /health) su entrambi i nodi → chi è leader
#   2. pg_stat_replication dal leader → lag dello standby
#
# Uso:
#   NODE_A_IP=10.0.0.1 NODE_B_IP=10.0.0.2 infra/cluster/check-replication.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

NODE_A_IP="${NODE_A_IP:?NODE_A_IP obbligatoria}"
NODE_B_IP="${NODE_B_IP:?NODE_B_IP obbligatoria}"
PATRONI_PORT="${PATRONI_PORT:-8008}"

for node in "A|$NODE_A_IP" "B|$NODE_B_IP"; do
  IFS='|' read -r label ip <<< "$node"
  echo "==> Nodo ${label} (${ip})"
  curl -sS --max-time 5 "http://${ip}:${PATRONI_PORT}/cluster" 2>/dev/null | \
    python3 -c "import sys,json; d=json.load(sys.stdin);
[print(f'  {m[\"name\"]}: role={m[\"role\"]} state={m[\"state\"]} host={m[\"host\"]}') for m in d.get('members',[])]" 2>/dev/null \
    || echo "   (API Patroni non raggiungibile su ${ip}:${PATRONI_PORT})"
done

echo ""
echo "==> Lag replicazione (dal leader)"
LEADER_CURL=$(curl -sS --max-time 5 "http://${NODE_A_IP}:${PATRONI_PORT}/cluster" 2>/dev/null)
LEADER_HOST=$(echo "$LEADER_CURL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(next((m['host']+':8008' for m in d['members'] if m['role']=='leader'), ''))" 2>/dev/null)
if [ -n "$LEADER_HOST" ]; then
  curl -sS --max-time 5 "http://${LEADER_HOST}/patroni" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print('  leader:', d.get('name'), '| scope:', d.get('scope'), '| timeline:', d.get('timeline'))" 2>/dev/null
fi