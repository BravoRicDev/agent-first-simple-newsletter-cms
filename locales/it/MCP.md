# MCP — Model Context Protocol

Il CMS espone anche un server MCP (Streamable HTTP) come alternativa all'uso diretto dell'API REST agente. **Copre esattamente le stesse funzionalità di [`AGENT.md`](AGENT.md)** — è lo stesso `/api/agent/...` visto da un protocollo diverso, non un sistema separato: ogni tool MCP esegue una chiamata interna alla route REST corrispondente, stesso codice, stessa logica, stessa autorizzazione. Un endpoint aggiunto o rimosso da `agent.js` compare/scompare automaticamente come tool al riavvio del servizio, senza bisogno di aggiornare nulla a mano — le due superfici non possono andare fuori sincrono.

## Connessione

- **Endpoint**: `POST https://<dominio-cms>/api/mcp` (transport Streamable HTTP, stateless — nessuna sessione da gestire).
- **Autenticazione**: stesso token JWT agente usato per l'API REST (`Authorization: Bearer <token>`), ottenuto con il flusso descritto in `AGENT.md` (`POST /api/auth/login` → OTP → `POST /api/agent/verify-otp`). Un client MCP che supporta un header `Authorization` statico funziona senza altro setup. Un token Bearer esplicito ha la precedenza su un cookie di sessione. I tool di scrittura richiedono un token con scope di scrittura.
- Senza token valido: `401` (non un redirect HTML — il montaggio sotto `/api/mcp` garantisce risposta JSON anche per client non-browser).

## Tool Set & Flusso di Navigazione

`tools/list` restituisce ORA SOLI 6 tool di navigazione: `agent_guide`, `tools_tree`, `tools_in_category`, `tools_describe`, `tools_run_read` (solo GET) e `tools_run` (qualsiasi tool).

Flusso di scoperta:
1. `tools_tree`
2. `tools_in_category {category}`
3. `tools_describe {name}`
4. `tools_run_read` / `tools_run {name, args}`

Tutti i tool precedenti restano richiamabili direttamente per nome (con gli stessi argomenti di prima). `GET /api/mcp` non viene usato. Effettuando una richiesta a `POST /api/mcp?tools=all`, `tools/list` restituisce l'elenco piatto completo (con annotazioni `readOnlyHint`/`destructiveHint`).

## Errori & Limiti

- **Errori**: I tool sconosciuti restituiscono un risultato `isError` con suggerimenti "Did you mean ..." e un puntatore a `tools_tree`/`tools_in_category`/`tools_describe`. Argomenti non validi restituiscono la lista dei campi non validi + un puntatore a `tools_describe`.
- **Limiti**:
  - Le richieste batch JSON-RPC vengono rifiutate (`-32600`, una richiesta per chiamata).
  - Rate limit: 120 richieste/min per token su `/api/mcp` (oltre al limite per-IP).
  - Risposte di testo limitate a 1.000.000 di caratteri (troncate con una nota: usare limit/offset/fields).
  - Risposte binarie massimo 15 MB.
  - Dimensione massima del corpo della richiesta 50 MB (le immagini vengono caricate in base64 tramite il tool di caricamento media `content_base64`, ~1.33x la dimensione del file, file massimo 20 MB).

## Sicurezza & Audit

- Un token Bearer esplicito ha la precedenza su un cookie di sessione.
- Ogni chiamata viene registrata nell'audit log (utente, tool, stato; gli argomenti non vengono registrati).
- I tool di scrittura richiedono un token con scope di scrittura.

Le regole operative (MAI fare loop, preferire bulk/find-replace, non depubblicare mentre si lavora, ecc.) restano quelle di `AGENT.md` — si applicano identiche indipendentemente dal protocollo usato per chiamarle.

## Dettagli tecnici (per chi tocca il codice)

- `src/services/mcp-tools.js`: introspezione del router `agent.js` (`agentRouter.stack`) + tabella di arricchimento `TOOL_META` + handler proxy generico.
- `src/services/mcp-tree.js`: generatore dell'albero di navigazione, categorie, aree e logica di gestione.
- `src/routes/mcp.js`: monta `/api/mcp`, un `Server` MCP + transport nuovi per ogni richiesta (nessuno stato condiviso), rate limiting, rifiuto batch e precedenza di autenticazione.
- Il proxy inoltra l'header `Authorization` originale alla chiamata interna (`http://127.0.0.1:<porta>/api/agent/...`) — stessa identità, nessun nuovo meccanismo di autenticazione da mantenere.
- Risposte binarie (es. lo ZIP di backup) arrivano come blocco `resource` in base64, non come testo.

## Nuove aree e strumenti

Categorie aggiunte all'albero di navigazione (`src/services/mcp-tree.js`):

- `feeds`, `search`, `editorial`, `releases`: area **Contenuti e sito** (`content`).
- `openapi.json`: area **Amministrazione, report e sistema** (`admin`).
- Le route sotto `pages/:pageId/...` e `media/...` restano nelle categorie esistenti `pages` e `media`.

Nuovi tool (per nome):

- **Feed**: `feeds_list`.
- **Ricerca**: `search_pages`, `search_reindex`.
- **Workflow editoriale**: `editorial_queue`, `pages_editorial_get`, `pages_editorial_transition` (azioni: `submit`, `withdraw`, `approve`, `reject`, `publish`, `unpublish`, `reopen`).
- **Release**: `releases_list`, `releases_create`, `releases_get`, `releases_update`, `releases_delete`, `releases_items_add`, `releases_item_remove`, `releases_preview`, `releases_schedule`, `releases_cancel`, `releases_rebase`, `releases_run`.
- **OpenAPI**: `agent_openapi_get`.
- **Versioni pagina**: `pages_version_get`, `pages_version_diff`, `pages_version_checkpoint`, `pages_restore_version`.
- **Varianti immagine**: `media_variants_get`, `media_focal_set`, `media_variants_regenerate`.

Impostazioni e campi pagina:

- `blog_settings_update` ora accetta `feed_enabled`, `feed_item_limit`, `feed_full_content`, `search_enabled`, `search_language`, `editorial_workflow_enabled` e `images_srcset_mode`. I flag sono le stringhe `"1"` / `"0"`.
- `pages_create` e `pages_replace` accettano `unpublish_at` (scadenza automatica, ISO 8601 con offset; `null` lo annulla; omesso in replace = invariato) e i campi articolo `post_type`, `category_id`, `excerpt`, `featured_image`, `published_at`.
