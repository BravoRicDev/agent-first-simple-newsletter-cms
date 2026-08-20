# AGENTS — Regole di sviluppo per gli agenti (e i cron)

Questo repo è sviluppato da agenti autonomi (cron) + claude-code. Regole da
SEGUIRE OBBLIGATORIAMENTE.

## Modalità di approccio
Aspettare discorso diretto già definito dalla roadmap: niente domande all'umano
se la risposta è già in ROADMAP.md / DECISIONI_UMANE.md / HANDOFF.md.

## Delega produttiva a claude-code (come nel CMS di produzione)
- Dare a claude-code UN task AMPIO e autosufficiente, con dentro: contesto del
  progetto, file da creare/modificare, schema SQL, vincoli, istruzioni multiple
  in una sola invocazione. NON frammentare in microtask.
- Modello più economico: `claude -p '<task ampio>' --model haiku
  --dangerously-skip-permissions --max-turns 60`
- Se claude non ce la fa (errore/limite), fallback sul solito stack
  (deepseek-v4-flash) via i tool dell'agente.
- L'agente del cron verifica UNA volta a fine lavoro (test + anti-leak), come da
  prassi del progetto.

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
