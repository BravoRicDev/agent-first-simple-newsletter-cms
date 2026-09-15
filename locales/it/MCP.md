# MCP — Model Context Protocol

Il CMS espone anche un server MCP (Streamable HTTP) come alternativa all'uso diretto dell'API REST agente. **Copre esattamente le stesse funzionalità di [`AGENT.md`](AGENT.md)** — è lo stesso `/api/agent/...` visto da un protocollo diverso, non un sistema separato: ogni tool MCP esegue una chiamata interna alla route REST corrispondente, stesso codice, stessa logica, stessa autorizzazione. Un endpoint aggiunto o rimosso da `agent.js` compare/scompare automaticamente come tool al riavvio del servizio, senza bisogno di aggiornare nulla a mano — le due superfici non possono andare fuori sincrono.

## Connessione

- **Endpoint**: `POST https://<dominio-cms>/api/mcp` (transport Streamable HTTP, stateless — nessuna sessione da gestire).
- **Autenticazione**: stesso token JWT agente usato per l'API REST (`Authorization: Bearer <token>`), ottenuto con il flusso descritto in `AGENT.md` (`POST /api/auth/login` → OTP → `POST /api/agent/verify-otp`). Un client MCP che supporta un header `Authorization` statico funziona senza altro setup.
- Senza token valido: `401` (non un redirect HTML — il montaggio sotto `/api/mcp` garantisce risposta JSON anche per client non-browser).

## Tool set

312 tool, uno per ogni endpoint `/api/agent/...` esistente, con nomi e
schemi leggibili (es. `pages_find_replace`, `newsletter_campaigns_send`,
`media_upload`, `calendars_list`, `quizzes_create`, `segments_create`,
`workflows_create`, `scoring_rules_create`, `tasks_create`, `contact_merge`,
`pipelines_list`, `contact_note_add`, `conversation_message_send`,
`opportunities_create`, `quotes_create`, `clients_list`,
`client_services_set`, `client_access_check`). Per un endpoint aggiunto in futuro senza
un nome/schema dedicato, il tool esiste comunque con schema generico (campi
path riconosciuti singolarmente, resto in un oggetto `extra`) — mai
assente, solo meno comodo da usare finché qualcuno non gli aggiunge una
entry dedicata in `src/services/mcp-tools.js`.

Le regole operative (MAI fare loop, preferire bulk/find-replace, non depubblicare mentre si lavora, ecc.) restano quelle di `AGENT.md` — si applicano identiche indipendentemente dal protocollo usato per chiamarle.

## Dettagli tecnici (per chi tocca il codice)

- `src/services/mcp-tools.js`: introspezione del router `agent.js` (`agentRouter.stack`) + tabella di arricchimento `TOOL_META` + handler proxy generico.
- `src/routes/mcp.js`: monta `/api/mcp`, un `McpServer` + transport nuovi per ogni richiesta (nessuno stato condiviso).
- Il proxy inoltra l'header `Authorization` originale alla chiamata interna (`http://127.0.0.1:<porta>/api/agent/...`) — stessa identità, nessun nuovo meccanismo di autenticazione da mantenere.
- Risposte binarie (es. lo ZIP di backup) arrivano come blocco `resource` in base64, non come testo.
