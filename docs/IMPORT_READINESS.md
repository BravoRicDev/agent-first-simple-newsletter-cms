# Import dati — readiness v1 (+ tool progettato, NON eseguito)

Obiettivo di questa nota: confermare che lo schema v1 (F0 + ONDA 1) sia
**coerente e pronto per un import dati esterno**, e descrivere il **tool di
import PROGETTATO** (migrazione dati NON eseguita ora, come da vincolo di
progetto: le tabelle partono vuote e la struttura è "schema-ready").

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

## Tool di import PROGETTATO (design; NON implementato/ESEGUITO)

Per il vincolo del progetto, ora si documenta SOLO il design di un tool
`scripts/import-crm-data.mjs` (CLI, Node + pg), da realizzare quando servirà
l'import reale. Non è stato scritto né eseguito.

Comportamento previsto:
1. Legge un file JSON con struttura
   `{ site_id, contacts: [...], opportunities: [...] }` (o mapping CSV→JSON).
2. Per ogni contatto:
   - `INSERT ... ON CONFLICT (site_id, email)` su `contacts` (upsert),
   - profilo+custom in `contact_custom_values` via `setCustomValues`
     (`object_key='contact'`), avendo creato prima le definizioni
     `custom_fields` del tenant.
3. Per ogni opportunità: upsert su `opportunities` (per `contact_email` +
   `title`), custom in `opportunity_custom_values`.
4. Idempotente: può essere rieseguito senza duplicare (ON CONFLICT).
5. Trasazione per batch + log di scarto per i `field_key` ignorati.

### Perché NON eseguito ora
- Vincolo di progetto ("migrazione dati NON eseguita"): le tabelle v1 devono
  restare vuote finché non c'è una sorgente dati esterna reale da importare.
- Il design qui sopra è il riferimento per il DEV che implementerà il tool.

## Verifica di coerenza (test)
- `test/onda1-opportunity-custom-fields.test.js` (RIFINITURA v1) verifica che
  `opportunity_custom_values` persista/legga i custom field opportunità, che i
  `field_key` sconosciuti vengano ignorati e che l'isolamento tenant sia
  rispettato.
- Suite F0/ONDA1/rifinitura verde (27/27) dopo l'aggiunta della tabella 076.
