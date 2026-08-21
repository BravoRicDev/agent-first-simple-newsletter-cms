# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **ONDA 4 — Webhook OUT event enrichment (21/08/2026) — COMPLETATO**:
  - Working tree pulita dopo commit `a60626e`.
  - **COSTRUITO**: eventi `contact_deleted` e `opportunity_deleted` ora emessi
    via emitContactEvent() (e quindi accodati ai webhook OUT automaticamente).
  - Nuovo test `onda1-webhook-out-v2.test.js` (5 test) copre: contact_created,
    contact_updated, contact_deleted, opportunity_stage_changed,
    opportunity_deleted, + isolamento tenant.
  - OpenAPI spec aggiornato con i nuovi eventi.

## COSTRUITO IN QUESTO RUN

1. **ONDA 4 — Webhook OUT event enrichment**:
   - `src/services/contacts-v1.js`: `deleteContact()` ora SELECT email, emette
     `contact_deleted` con `{contact_id, email}` prima della DELETE.
   - `src/services/opportunities.js`: `deleteOpportunity()` ora fetch prima della
     DELETE (getOpportunity per avere email + title), emette `opportunity_deleted`
     con `{opportunity_id, title}`.
   - `src/openapi.js`: documentazione Webhook OUT include `contact_deleted` e
     `opportunity_deleted`.
   - `test/onda1-webhook-out-v2.test.js` (5 test nuovi):
     - contact_created → delivery + payload + isolamento
     - contact_updated → delivery
     - contact_deleted → delivery
     - opportunity_stage_changed (creazione + cambio stage) + opportunity_deleted
     - Isolamento tenant: eventi A non filtrano in B

2. **Verifica regressioni** (323 test, 0 fail):
   - 7 suite webhook (onda1 + v2): 11 test, 0 fail
   - f0-foundations + f0-location-mapping: 18/18
   - onda1-contacts + opportunità + custom-fields: 17/17
   - export-import + v1-openapi + pipeline + rate-limit + csv-export + planning-onda3: 49/49
   - onda2-booking + calendar + public + payment + conversations + runtime-events: 53/53
   - v1-dashboard-funnel + reports + activities + email-stats + import-file: 29/29
   - crm-opportunities + suite + workflows + segments + webhooks + import-tool: 49/49
   - dashboard + opportunity-board + conversations + payments + http suites: 57/57

## PUNTI DI VERIFICA (questo run)
- ✅ **323 test eseguiti in 31 suite**, 0 fail — nessuna regressione
- ✅ **Sintassi OK**: `node --check` su tutti i file toccati
- ✅ **Nessun segreto**, nessun riferimento CRM-specifico nel codice
- ✅ **Migrazioni SQL**: nessuna migrazione nuova necessaria (solo logica JS)
- ✅ **Nessuna decisione [APERTA]** in DECISIONI_UMANE.md
- ✅ **Commit locale** `a60626e` (main): 4 file, 236 insertions

## PROSSIMO BLOCCO CONSIGLIATO
1. **ONDA 4 tuning (continuazione)**: arricchimento payload webhook (es. dati
   completi contatto/opportunità nel delivery invece del solo payload evento).
2. **Oppure**: attendere input umano per definire ONDA 4 scope rimanente.
3. **Review ROADMAP**: ONDA 4 non ancora definita formalmente nella roadmap;
   valutare se documentare lo scope con l'umano.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-6 (booking, calendar sync, public page, payments, conversations, event-driven triggers).
- ONDA 3 (Dashboard/Funnel, Analitica & Reporting, export CSV, import avanzato file CSV/JSON).
- ONDA 4 (Webhook OUT event enrichment — eventi cancellazione + test multipli).

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano.
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).