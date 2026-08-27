#!/bin/sh
set -e
echo "Esecuzione migrazioni database..."
node db/migrate.js

echo "Export pagine statiche..."
# L'export è non-bloccante (l'app DEVE partire anche se fallisce: le pagine
# pubbliche restano servite da Caddy dall'ultimo export buono), ma l'errore
# va loggato in modo visibile nei log del container — prima il `|| echo`
# azzerava l'exit code e il fallimento era indistinguibile da un successo.
if ! node scripts/static-export-all.js 2>&1; then
  echo "ATTENZIONE: export statico fallito (le pagine pubbliche restano sull'ultimo export buono)" >&2
fi

echo "Avvio applicazione..."
exec node src/index.js
