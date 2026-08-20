# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- Stiamo partendo: v1 clone (F0 + Onda 1) NON ancora avviata.
- Il codice base è un clone del CMS di produzione (stesso schema: contacts,
  opportunities, pipelines, webhooks OUT, newsletters, forms, ecc.).

## PROSSIMO BLOCCO CONSIGLIATO (dal run precedente)
1. **F0 — Fondamenta** (abilitante): tenancy/auth Bearer + header Version ignorato
   + custom fields per-tenant + pipeline/stage per-tenant + config per-tenant +
   naming generico + struttura migration-ready.
2. Poi ONDA 1: contatti → opportunità → custom → webhook OUT.

## COSE GIÀ PRONTE
- Schema contacts / opportunities / pipelines esistenti (base per la compat).
- Sistema webhook OUT già presente (feature 35: firma HMAC + coda/retry).
- Naming generico da applicare in tutta la v1.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON migrate (nessuna migrazione dati esterna ora): solo schema pronto al import.
- NON usare il nome del CRM di origine nel codice/docs/README.
