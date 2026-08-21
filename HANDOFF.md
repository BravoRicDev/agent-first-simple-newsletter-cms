# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **ONDA 4 — Webhook OUT event enrichment (21/08/2026) — COMPLETATO**:
  - Working tree pulita dopo commit locale.
  - **COSTRUITO**: Arricchimento payload webhook OUT con dati completi contatto/opportunità + custom fields.
  - Nuovo test `onda4-webhook-enrichment.test.js` (6 test) copre: contact_created, contact_updated, opportunity_stage_changed, opportunity_deleted (best-effort), isolamento tenant, enrichPayload standalone.

## COSTRUITO IN QUESTO RUN

1. **Webhook OUT event enrichment — `src/services/webhooks.js`**:
   - Funzione `enrichPayload(delivery)` — arricchisce il payload di una delivery con dati completi:
     - `contact` sub-oggetto: tutti i campi (id, email, name, firstName, lastName, phone, companyName, website, tags, status, notes, value_estimate, is_client, client_status, customFields, createdAt, updatedAt)
     - `opportunity` sub-oggetto: tutti i campi (id, contactEmail, pipelineId, pipelineName, stage, title, amount, probability, status, expectedCloseDate, notes, customFields, createdAt, updatedAt)
   - `shouldEnrich(eventType)` — riconosce tutti gli eventi CRM (contact_*, opportunity_*, quote_*, tag_added, stage_changed, custom_field_updated)
   - `loadFullContact(siteId, contactId)` — JOIN tra contacts e contact_custom_values
   - `loadFullOpportunity(siteId, opportunityId)` — JOIN tra opportunities, pipelines e opportunity_custom_values
   - Risoluzione contatto per email (fallback) quando manca contact_id ma c'è email nel payload
   - Risoluzione contatto da opportunity.contactEmail per eventi opportunità
   - Best-effort per eventi di cancellazione (record potrebbe non esistere più in DB)
   - Salvataggio payload arricchito SOLO se ci sono modifiche (nessun UPDATE superfluo)
   - `deliverPending()` integrata: chiama `enrichPayload()` prima di ogni delivery per eventi CRM

2. **Test (6 test, 0 fail)**:
   - `test/onda4-webhook-enrichment.test.js`: 6 test — tutti pass
     - contact_created → payload con contatto completo + custom fields
     - contact_updated → payload con dati aggiornati
     - opportunity_stage_changed → payload con opportunità completa + custom fields + contatto associato
     - opportunity_deleted → arricchimento best-effort (payload originale preservato)
     - Isolamento tenant: eventi di A non filtrano in B
     - enrichPayload standalone: non crasha su contatto inesistente

## PUNTI DI VERIFICA (questo run)
- ✅ **6 test nuovi = 746 test totali, 0 fail** — nessuna regressione
- ✅ **Sintassi OK**: `node --check` su tutti i file toccati
- ✅ **Nessun segreto**, nessun riferimento CRM-specifico nel codice
- ✅ **Migrazioni SQL**: nessuna migrazione nuova (tabelle già esistenti)
- ✅ **Nessuna decisione [APERTA]** in DECISIONI_UMANE.md
- ✅ **Commit locale** — 2 file modificati

## PROSSIMO BLOCCO CONSIGLIATO
1. **ONDA 2 Phase 6 — Event-driven triggers avanzati**: scheduler tick per delayed actions,
   scoring decay, segment refresh periodico.
2. **Oppure**: ONDA 4 — Quote/Board/Merge v1 API (se non ancora completo).
3. **Oppure**: attendere input umano per definire prossimo backlog.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-6 (booking, calendar sync, public page, payments, conversations, event-driven triggers).
- ONDA 3 (Dashboard/Funnel, Analitica & Reporting, export CSV, import avanzato file CSV/JSON).
- ONDA 4 (Webhook OUT event enrichment + Quotes/Board/Merge v1 API + Segmenti/Workflow/Scoring v1 API).

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano.
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).