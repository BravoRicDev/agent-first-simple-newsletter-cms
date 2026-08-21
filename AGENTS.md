# AGENTS — Regole di sviluppo per gli agenti (e i cron)

Questo repo è sviluppato da agenti autonomi (cron) + claude-code. Regole da
SEGUIRE OBBLIGATORIAMENTE.

## Modalità di approccio
Aspettare discorso diretto già definito dalla roadmap: niente domande all'umano
se la risposta è già in ROADMAP.md / DECISIONI_UMANE.md / HANDOFF.md.

## Delega a Claude Code + fallback litellm
- **Primario**: Claude Code CLI (`claude -p '<task ampio>' --model
  claude-sonnet-4-20250514 --dangerously-skip-permissions --max-turns 300`)
  — scrive il codice, usa la propria auth Anthropic.
- **Fallback**: se Claude va in errore (rate limit, credito esaurito, errori),
  usa i tool nativi dell'agente (deepseek-v4-flash via litellm-proxy a
  http://127.0.0.1:4000).
- Task AMPI e autosufficienti (3-5 endpoint correlati per volta — servizi,
  test, migrazioni tutti insieme). Non microtask.
- Verifica solo a fine blocco, non dopo ogni file.

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
