#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# seed-sync.sh — Bootstrap iniziale ONE-WAY (primary → nuovo nodo).
#
# Prima di attivare la sincronizzazione bidirezionale Syncthing, la copia
# iniziale di media/, media-protected/, static/, backups/ va fatta in modo
# deterministico ONE-WAY dal nodo "germoglio" al nuovo nodo "gemello".
# (Syncthing può comunque fare il primo sync da solo, ma su cartelle grandi
# un seed rsync è molto più veloce e prevedibile.)
#
# Uso (DA ESEGUIRE SUL NODO CHE HA I DATI, es. nodo A):
#   SEED_TARGET=user@10.0.0.2 SEED_REMOTE_REPO=/home/user/gestione-siti-riccardom \
#     infra/cluster/seed-sync.sh
#
# Variabili:
#   SEED_TARGET       obbligatoria: [user@]host del nuovo nodo (scp/rsync su SSH)
#   SEED_REMOTE_REPO  percorso assoluto della repo sul target (default: ~/gestione-siti-riccardom)
#   SEED_DIRS         spazi-separati, default "media media-protected static backups"
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SEED_TARGET="${SEED_TARGET:?SEED_TARGET obbligatoria, es. user@10.0.0.2}"
SEED_REMOTE_REPO="${SEED_REMOTE_REPO:-$HOME/gestione-siti-riccardom}"
SEED_DIRS="${SEED_DIRS:-media media-protected static backups}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CMS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "==> Seed one-way verso ${SEED_TARGET}:${SEED_REMOTE_REPO}"
for dir in $SEED_DIRS; do
  echo "   - ${dir}/"
  # -a      archivio (preserva permessi, ownership, date, symlink)
  # -H      hard link
  # -A      ACL
  # -X      xattr
  # --links i symlink di static/*.dominio devono rimanere symlink
  # -z      compressione
  # --delete: il target diventa GEMELLO (elimina ciò che non esiste più)
  rsync -aHAX --links -z --delete \
    --exclude '*.tmp' --exclude '*.tmp.*' \
    "${CMS_DIR}/${dir}/" \
    "${SEED_TARGET}:${SEED_REMOTE_REPO}/${dir}/"
done

echo "==> Seed completato. Ora configura Syncthing con le stesse 4 cartelle"
echo "    (condivisione bidirezionale) su entrambi i nodi e verifica con"
echo "    infra/cluster/verify-twin.sh"