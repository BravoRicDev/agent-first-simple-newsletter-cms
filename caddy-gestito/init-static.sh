#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CMS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATIC_DIR=$CMS_DIR/static

# Domini da inizializzare (spazio-separati). Sovrascrivibili con:
#   STATIC_DOMAINS="www.esempio.it esempio.it" ./init-static.sh
STATIC_DOMAINS="${STATIC_DOMAINS:-www.ilmiosito.it ilmiosito.it}"
# Nome del container dell'app (per l'export statico). Sovrascrivibile con:
#   CMS_CONTAINER="altro-nome-container" ./init-static.sh
CMS_CONTAINER="${CMS_CONTAINER:-gestione-siti-cms-gestione-siti-1}"

echo "=== Inizializzazione directory static ==="

mkdir -p "$STATIC_DIR/1"

for domain in $STATIC_DOMAINS; do
  mkdir -p "$STATIC_DIR/$domain"
  rmdir "$STATIC_DIR/$domain" 2>/dev/null || true
done

echo "Directory static create."

echo ""
echo "Ora esegui:"
echo "  docker exec $CMS_CONTAINER node scripts/static-export-all.js"
echo ""
