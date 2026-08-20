# Import dati — readiness v1 (tool IMPLEMENTATO, migrazione dati NON eseguita)

Obiettivo di questa nota: confermare che lo schema v1 (F0 + ONDA 1) sia
**coerente e pronto per un import dati esterno**, e descrivere il **tool di
import IMPLEMENTATO** (`scripts/import-crm-data.mjs`). La migrazione dati in sé
NON è stata eseguita (vincolo di progetto: le tabelle v1 partono vuote e la
struttura è "schema-ready", il tool si lancia solo quando esiste una sorgente
dati esterna reale da importare).

## Stato: schema pronto all'import (nessuna migrazione dati eseguita)

Lo storage v1 è multi-tenant per-sito (`site_id`) e usa **id stabili**
(`custom_fields.field_key`, `pipelines.stage.key`), quindi un import è
riproducibile e non dipende da id auto-generati del database sorgente.

Tabelle coinvolte per l'import di una base contatti/opportunità:

| Tabella | Ruolo nell'import | Vincolo/chiave |
|---|---|---|
| `sites` | tenant destinazione (già presente) | `id` |
| `contacts` | contatti nativi (email, tags, status, notes, value_estimate, is_client) | `email` per-tenant |
| `contact_custom_values` | custom field + profilo (name/firstName/phone/...) dei contatti | `UNIQUE(site_id, contact_id, object_key)` |
| `custom_fields` | definizione custom field per-tenant | `UNIQUE(site_id, object_key, field_key)` |
| `pipelines` / `pipeline_stages` | pipeline e stadi per-tenant | `stage.key` stabile |
| `opportunities` | opportunità su pipeline | `site_id`, `pipeline_id` |
| `opportunity_custom_values` | custom field delle opportunità (RIFINITURA v1) | `UNIQUE(site_id, opportunity_id)` |
| `contact_notes` | note contatto | `contact_email` |
| `contact_followers` | follower contatto | `UNIQUE(site_id, contact_id, user_id)` |

### Note di coerenza per l'import
- **Contatti**: `contacts.email` è la chiave di integrazione; il profilo
  esteso (name/firstName/lastName/phone/companyName/website) è nei custom
  values `object_key='contact'`, NON in colonne dedicate (`contacts` non le
  ha). Un import deve popolare entrambi: riga `contacts` + riga
  `contact_custom_values` (merge col profilo).
- **Custom field**: vanno prima creata la definizione in `custom_fields`
  (`field_key` stabile, `object_key='contact'|'opportunity'`), poi i valori in
  `contact_custom_values` / `opportunity_custom_values`. `setCustomValues`
  ignora i `field_key` non definiti (con warn): importare valori senza
  definizione li perderebbe silenziosamente.
- **Opportunità**: i custom field opportunità vivono in
  `opportunity_custom_values` (non in `contact_custom_values`, che ha FK su
  `contacts(id)`). Vedi migrazione `076_opportunity_custom_values.sql`.
- **Pipeline/stage**: gli stadi sono immutabili (`stage.key`); un import può
  riferirsi a `pipeline_id` già presenti.

## Tool di import IMPLEMENTATO (`scripts/import-crm-data.mjs`)

CLI (Node + pg) autonoma che carica un file JSON e popola le tabelle v1 in modo
**idempotente** (`ON CONFLICT` / upsert): può essere rieseguita senza duplicare.

Uso:
```bash
DATABASE_URL=postgres://... node scripts/import-crm-data.mjs <file.json> [--site <id>] [--dry-run] [--quiet]
```

Struttura del file JSON:
```json
{
  "site_id": 1,
  "custom_fields": [{ "object_key": "contact", "field_key": "citta", "name": "Città", "type": "text" }],
  "contacts": [{ "email": "...", "name": "...", "phone": "...", "tags": [], "status": "",
                 "notes": "", "value_estimate": 0, "customFields": { "citta": "Roma" } }],
  "opportunities": [{ "contactEmail": "...", "title": "...", "pipeline_id": 1, "stage": "open",
                      "amount": 1000, "probability": 50, "status": "open",
                      "expected_close_at": "2026-12-31", "notes": "",
                      "customFields": { "sorgente": "web" } }]
}
```

Comportamento (coerente con i servizi v1):
1. **custom_fields** (facoltativi): upsert definizioni (`ON CONFLICT (site_id,
   object_key, field_key) DO UPDATE`) così i valori importati hanno una
   definizione valida. Le definizioni possono anche essere già presenti.
2. **contacts**: upsert per `(site_id, email)` su `contacts` (`ON CONFLICT DO
   UPDATE`, preservando status/notes se il nuovo valore è vuoto). Il profilo
   (name/firstName/lastName/phone/companyName/website — `lastName`/`firstName`
   derivati dal nome se non espliciti) + i `customFields` non vuoti vengono
   scritti in `contact_custom_values` (`object_key='contact'`), validati contro
   le definizioni del tenant (chiavi non definite → scarto con warn, come in
   `custom-values.js`; le chiavi di profilo riservate sono sempre ammesse).
   Ogni contatto in una transazione.
3. **opportunities**: il contatto deve già esistere (importa i contatti prima);
   upsert per `(site_id, contact_email, title)` su `opportunities` (se esiste
   aggiorna pipeline/stage/importo/probabilità/stato/scadenze/note, altrimenti
   inserisce). `pipeline_id` facoltativo → prima pipeline del tenant. I
   `customFields` (object_key='opportunity') vanno in `opportunity_custom_values`,
   validati contro le definizioni (non definiti → scarto con warn).
4. **Idempotente**: rieseguibile senza duplicare (ON CONFLICT / upsert).
5. **Flag**: `--site <id>` sovrascrive `site_id`; `--dry-run` valida e stampa il
   piano senza scrivere; `--quiet` sopprime i log di avanzamento.
6. **Riepilogo**: conteggio custom fields / contatti creati-aggiornati /
   opportunità create-aggiornate + elenco `field_key` scartati.

Test: `test/import-crm-tool.test.js` (4 subtests: popolamento con profilo/custom,
idempotenza su doppia esecuzione, scarto chiavi non definite con mantenimento
del profilo, dry-run senza scritture).

### Perché la migrazione dati NON è stata eseguita
- Vincolo di progetto ("migrazione dati NON eseguita"): le tabelle v1 devono
  restare vuote finché non c'è una sorgente dati esterna reale da importare.
- Il tool è pronto: va lanciato solo quando esiste tale sorgente (es. esportare
  i dati dal CRM di origine in un file JSON con la struttura sopra).

## Verifica di coerenza (test)
- `test/onda1-opportunity-custom-fields.test.js` (RIFINITURA v1) verifica che
  `opportunity_custom_values` persista/legga i custom field opportunità, che i
  `field_key` sconosciuti vengano ignorati e che l'isolamento tenant sia
  rispettato.
- `test/import-crm-tool.test.js` (import tool) verifica che il tool popoli
  contatti/opportunità + custom field (con profilo), sia idempotente al doppio
  run, scarti le chiavi non definite mantenendo il profilo, e non scriva in
  dry-run.
- Suite F0/ONDA1/rifinitura verde dopo l'aggiunta della tabella 076 e del tool
  di import (nessuna regressione).
