# ROADMAP — Clone opensource API-compatibile (agent-first)

Obiettivo: trasformare questo CMS in un **clone opensource** API-compatibile con
CRM diffusi ("API compatibili con CRM diffusi" — naming generico, nessuna traccia
del CRM di origine nel codice/docs).

Target (validato con l'umano, 20/08/2026):
**v1 del clone = F0 + ONDA 1** (prodotto chiuso e coerente). Le onde 2-4 si
aggiungono SOLO dopo che la v1 è completa e verificata.

## PERIMETRO v1 (da completare)
- F0 — Fondamenta:
  - Tenancy: header Location-Id + API key per-sito; header "Version: ..." IGNORATO.
  - Auth: Bearer token per-sito.
  - Modello CAMPI CUSTOM per-tenant (id stabili).
  - Modello PIPELINE/STAGE per-tenant (id immutabili).
  - Config per-tenant generalizzato (credenziali esterne come campo di config).
  - Substrato agent-first (capability registry + permessi).
  - Naming generico nei commenti/README; struttura PRONTA per import dati
    (tool progettato, migrazione NON eseguita).
- ONDA 1 — Core CRM:
  - Contatti: POST/GET /contacts/ · POST /contacts/search · GET/PUT/DELETE
    /contacts/{id} · POST /contacts/{id} (nota) + /contacts/{id}/notes{/id} ·
    /{id}/tags · /{id}/tasks(+completed) · /{id}/followers · /{id}/campaigns ·
    /{id}/workflow · contacts/upsert · contacts/search/duplicate.
  - Opportunità: POST /opportunities/ · GET&POST /opportunities/search ·
    GET/PUT/DELETE /opportunities/{id} · PUT /opportunities/{id}/status ·
    POST /opportunities/upsert · /{id}/followers · GET /opportunities/lost-reason ·
    GET /opportunities/pipelines.
  - Custom fields: POST /custom-fields/ · GET/PUT/DELETE /custom-fields/{id} ·
    /custom-fields/folder · /custom-fields/object-key/{objectKey}.
  - Webhook OUT eventi verso n8n (nuovo contatto, cambio fase, ecc.).

## OUT OF SCOPE v1 (da non fare ora)
Onde 2-4 (calendario/booking con Google Calendar per-tenant, conversazioni
outbound, payments, funnels, ecc.) → fanno parte del backlog, NON della v1.

## FONTE ISPIRAZIONE ENDPOINT (per compatibilità)
Inventario completo: e' nel repo sorgente di produzione (file dedicato) — i percorsi
e i nomi-campo della risposta devono combaciare con quanto dichiarato nel piano
CRON/ROADMAP. Non reinventare i nomi di campo.
