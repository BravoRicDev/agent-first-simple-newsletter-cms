# AGENTS — Regole di sviluppo per gli agenti (e i cron)

Questo repo è sviluppato da agenti autonomi (cron) + claude-code. Regole da
SEGUIRE OBBLIGATORIAMENTE.

## Modalità di approccio
Aspettare discorso diretto già definito dalla roadmap: niente domande all'umano
se la risposta è già in ROADMAP.md / DECISIONI_UMANE.md / HANDOFF.md.

## Provider: litellm-proxy (come l'ambiente di Riccardo)
- Usare SEMPRE litellm-proxy (http://127.0.0.1:4000) come provider primario.
- L'agente lavora coi propri tool nativi (terminal, read_file, write_file,
  patch, search_files, execute_code) — NON delegare a claude-code.
- Claude-code è SOLO un fallback se i tool nativi falliscono per errore/limite.
- Lavorare a BLOCCHI FUNZIONALI INTERI (3-5 endpoint correlati per volta) —
  non microtask. Verifica solo a fine blocco, non dopo ogni file.

## VINCOLI
- Niente `git reset --hard` / force.
- Niente commit+push su GitHub (nessun remote). SOLO git locale (commit/branch).
- Migrazioni idempotenti (IF NOT EXISTS / DO block) — vedi 069 come esempio di
  pitfall (niente "ADD CONSTRAINT IF NOT EXISTS").
- A fine lavoro: codice sintatticamente valido (node --check), test che non
  regrediscono, nessun segreto nel codice (repo pubblica se mai pubblicata).
- Aggiornare HANDOFF.md con la fase corrente, task fatti, punti di verifica.
- Applicare i [RISOLTO] di DECISIONI_UMANE.md; NON risolvere i [APERTA].

## Naming
- Nel prodotto/documentazione: "API compatibili con CRM diffusi". MAI il nome del
  CRM di origine. Nessun fork di testo/docs altrui.
