# DECISIONI_UMANE

Coda di decisioni che richiedono l'ok dell'umano (Riccardo).
- [RISOLTO] = l'umano ha deciso: i cron le applicano al run successivo.
- [APERTA] = in attesa: i cron NON le risolvono da soli, le lasciano qui.

## RISOLTO
- [RISOLTO] Scope: target v1 = F0 + ONDA 1 (contatti + opportunità/pipeline +
  custom fields + webhook OUT + migration-ready + naming generico). Onde 2-4
  solo dopo. (20/08/2026)
- [RISOLTO] Repo di lavoro: nuovo "clone" (questo repo), clonato dal CMS di
  produzione per avere schema/test utili. NON si lavora sul CMS di produzione.
- [RISOLTO] Bobine/delega: uso claude-code col MODELLO PIÙ ECONOMICO disponibile
  (haiku), task AMPI e autosufficienti (non microtask), fallback su
  deepseek-v4-flash se claude non ce la fa.
- [RISOLTO] Git: si può usare git in LOCALE (commit), MA niente push su GitHub
  finché il progetto non è finito.
- [RISOLTO] Google Calendar: credenziali NON presenti ora → la funzionalità
  (Onda 2) deve essere CONFIGURABILE per tenant (campo di config), non hardcoded.
- [RISOLTO] Webhook: il sistema di automazione emette eventi (webhook OUT) verso
  n8n — riusare il sistema webhook esistente del CMS.
- [RISOLTO] Naming: nel prodotto usare SEMPRE "API compatibili con CRM diffusi".
  Mai il nome del CRM di origine. Nessun fork di testo/docs altrui.

## APERTA
- (nessuna al momento)
