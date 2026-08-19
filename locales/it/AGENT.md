# AGENT.md — Protocollo operativo IlMioSito CMS

> Client MCP-nativi (Claude Desktop e simili): vedi [`MCP.md`](MCP.md) —
> stesse funzionalità descritte qui, esposte come tool MCP invece che REST.

## REGOLE ASSOLUTE

### HOMEPAGE CARD — STRUTTURA OBBLIGATORIA

La homepage (`/`) contiene griglie di card suddivise per rubrica. Ogni griglia è un `<div class="cards">` (o `<div class="cards util">` per "La guida utile" a 2 colonne).

**REGOLA FERREA**: ogni nuovo articolo aggiunto a una rubrica DEVE:
1. Essere un `<article class="card">` (con `glossy` opzionale per "Cronaca")
2. Essere inserito PRIMA della chiusura `</div>` del rispettivo `.cards` div
3. MAI finire fuori dal `.cards` div (dopo `</div>\n    </div>`)

**Struttura obbligatoria:**
```html
<article class="card">
  <a class="headlink" href="/SLUG">
    <img src="URL_IMMAGINE" alt="TESTO ALT" style="width:100%;aspect-ratio:16/10;object-fit:cover;display:block;border-radius:2px" loading="lazy">
    <span class="ek">CATEGORIA</span>
    <h3>TITOLO</h3>
  </a>
  <p>DESCRIZIONE (max 2 righe).</p>
  <div class="meta">AUTORE · N min</div>
</article>
```

**Per "La guida utile"** (`.cards.util`, 2 colonne):
```html
<article class="card">
  <span class="lesson">CATEGORIA</span>
  <a class="headlink" href="/SLUG"><h3>TITOLO</h3></a>
  <p>DESCRIZIONE.</p>
  <div class="meta">Guida · N min · AUTORE</div>
</article>
```

**Sezione "Cronaca"**: usare `class="card glossy"` invece di `class="card"`.

**VERIFICA DOPO L'OPERAZIONE**: assicurati che nel contenuto NON ci siano pattern come `</div>\n    </div>\n  \n          <a class="headlink"` — quelli sono articoli orfani fuori dalla griglia.

1. **MAI** leggere il contenuto di una pagina se non serve.
   INVECE: usa `GET .../summary` per metriche, `GET .../full-report` per analisi.
   Leggere una pagina = fino a 500KB di JSON nel contesto. Inutile se vuoi solo sapere se ha base64.

2. **MAI** fare loop su pagine.
   INVECE: usa `bulk-find-replace`, `bulk-inline-to-files`, `bulk-extract-assets`.
   Loop su 10 pagine = 10 chiamate. Bulk = 1 chiamata. -90% token.

3. **MAI** chiamare `GET /versions` prima di find-replace.
   Il server SALVA AUTOMATICAMENTE una versione prima di ogni modifica.
   La risposta di find-replace include `saved_version_id`.

4. **MAI** mandare base64 in POST/PUT se puoi evitarlo.
   INVECE: carica prima con `POST /media/upload`, poi usa `/media/{id}/{file}` nel HTML.
   Auto-extract è automatico, ma caricare prima è meglio (JSON 10x più piccolo).

5. **MAI** chiamare `inline-to-files` dopo aver creato/aggiornato una pagina.
   Il server estrae AUTOMATICAMENTE tutti i base64 dopo POST/PUT.
   inline-to-files serve SOLO per pagine ESISTENTI con base64 residui.

6. **MAI** usare PUT per modifiche parziali. Usa SEMPRE find-replace.
   PUT sovrascrive tutto e può rompere script, snippet, e variabili.

7. **MAI** depubblicare una pagina mentre ci lavori.
   Meglio una pagina pubblicata con un errore piccolo che una pagina offline.
   L'utente preferisce vedere contenuto imperfetto piuttosto che 404.
   Se devi fare modifiche estese: usa find-replace in più step. Non toccare `published`.

8. **MAI** inventare path per gli endpoint. Usa solo quelli elencati qui.
   Per upload media il path ESATTO è:
   `POST /api/agent/sites/{siteId}/media/upload`
   NON `/upload`, NON `/api/agent/upload`, NON `/sites/:id/upload`.

9. **MAI** scaricare media esterni manualmente.
   Usa SEMPRE:
   POST /api/agent/sites/{siteId}/media/fetch-url
   body: { "url": "https://...", "force": true }
   
   Se fetch-url fallisce con "File troppo grande (max 20 MB)":
   - RICHEDI CON { "force": true } — DOPO AVER CHIESTO ALL'UTENTE
   - Non provare a scaricare il file in altro modo. Non funziona.
   - Non cercare URL alternative. Non funzionano.
   - Se anche force non funziona → informa l'utente e chiedi aiuto.
   
   I file >20MB possono essere scaricati con force.
   Le risposte API includono sempre `size_formatted` per leggibilità (KB se <1MB, MB se >=1MB).

## FORM PUBBLICI — anti-spam

Quando crei/modifichi una pagina che contiene un `<form>` che invia a
`POST /forms/{siteId}/{formSlug}`, aggiungi SEMPRE un campo honeypot nascosto:

```html
<input type="text" name="website" style="position:absolute;left:-9999px" tabindex="-1" autocomplete="off">
```

Il server accetta silenziosamente (`{ok:true}`, nessun salvataggio) qualunque
submit in cui `website` (o `_honeypot`/`url`) arrivi valorizzato — i bot che
compilano tutti i campi ci cascano, gli utenti umani non vedono il campo.
Oltre all'honeypot, il server applica automaticamente: rate-limit 5/min per
IP, cap 30 invii/giorno per IP+sito, e un filtro sul numero di link nei
campi (>3 URL in un submit → scartato silenziosamente). Non serve altro lato
pagina.

## AUTENTICAZIONE

Passo 1: POST /api/auth/login — body: { "email": "..." }
  Risposta attesa: { "sent": true }
  Se sent è false: l'email non esiste nel sistema, chiedi di verificarla.

Passo 2: chiedi all'utente il codice OTP ricevuto via email (6 cifre).

Passo 3: POST /api/agent/verify-otp — body: { "email": "...", "otp": "..." }
  Risposta attesa: { "token": "...", "user": { ... } }
  Salva il token. Usalo come header: Authorization: Bearer {token}
  Il token dura 7 giorni. Dopo la scadenza ripeti il flusso dall'inizio.

Passo 4: verifica identità con GET /api/agent/me
  Risposta attesa: { "user": { "role": "...", "site_id": ... }, "token_expires_at": "..." }
  Se role è "admin" o "collaboratore", site_id è il tuo sito assegnato.
  Se role è "superadmin", devi chiedere a quale sito lavorare e usare quell'id.

## TROVARE IL SITO E LE PAGINE

GET /api/agent/sites
  Risposta: { "sites": [ { "id": 1, "name": "Il mio sito", "domain": "..." } ] }
  Se c'è un solo sito, usa sempre quell'id.

GET /api/agent/sites/{siteId}/pages
  Risposta: { "pages": [ { "id": 5, "url_path": "/landing", "title": "Landing", "published": true } ] }
  Usa questa lista per trovare l'id numerico di una pagina dal suo url_path o titolo.

## GERARCHIA ENDPOINT — cosa usare IN ORDINE

Per OGNI operazione, usa la PRIMA opzione della lista. È sempre la più efficiente.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CERCARE TESTO in tutte le pagine
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1° scelta: POST /api/agent/pages/search          ← 1 chiamata, TUTTI i siti
2° scelta: GET /sites/:id/pages/search?q=...      ← 1 chiamata, 1 sito
MAI:       GET /pages e scorrere ogni pagina manualmente

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MODIFICARE TESTO su più pagine
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1° scelta: POST /sites/:id/pages/bulk-find-replace  ← 1 chiamata, TUTTE le pagine
2° scelta: POST /sites/:id/pages/:pid/find-replace  ← 1 chiamata, 1 pagina
MAI:       PUT /pages/:pid con tutto il contenuto

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANALIZZARE UNA PAGINA (senza leggerne il contenuto)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1° scelta: GET /sites/:id/pages/:pid/full-report   ← 1 chiamata, TUTTO
2° scelta: GET /sites/:id/pages/:pid/summary       ← 1 chiamata, solo metriche
MAI:       GET /pages/:pid per leggere contenuto inutile

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CARICARE UN'IMMAGINE (evitare base64)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1° scelta: POST /sites/:id/media/upload
           path ESATTO: /api/agent/sites/{siteId}/media/upload
           multipart, campo "file". Risposta include `size_formatted`
           NON /upload, NON /api/agent/upload, NON /sites/:id/upload
2° scelta: POST /sites/:id/media/fetch-url  ← importa da URL esterna
           Se >20MB, usa { "url": "...", "force": true }
MAI:       Incollare data:image/...;base64 nel JSON della pagina
MAI:       Provare a scaricare file esterni da soli. Usa fetch-url.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONVERTIRE BASE64 in file
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1° scelta: NON SERVE — il server lo fa automaticamente su POST/PUT
2° scelta: POST /sites/:id/pages/:pid/inline-to-files   ← pagina esistente
3° scelta: POST /sites/:id/pages/bulk-inline-to-files   ← più pagine
MAI:       Chiamare inline-to-files DOPO aver appena creato la pagina

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PUBBLICARE / NASCONDERE PAGINE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MAI:       Depubblicare una pagina mentre ci lavori
           Lascia published=true. Usa find-replace per modifiche parziali.
           L'utente preferisce errore piccolo a pagina offline.

## TABELLA COSTI — quanto risparmi usando l'endpoint giusto

| Operazione | Metodo VECCHIO | Chiamate | Metodo NUOVO | Chiamate | Risparmio |
|---|---|---|---|---|---|
| Cercare testo in 50 pagine | GET /pages + cerca manuale | 50 | GET /pages/search | 1 | -98% |
| Trovare pagine con snippet X | GET /pages + snippet-usage × 50 | 51 | GET /snippets/:id/usage | 1 | -98% |
| Sostituire testo in 10 pagine | find-replace × 10 | 10 | bulk-find-replace | 1 | -90% |
| Analizzare 1 pagina | page + snippet + asset = 3 | 3 | full-report | 1 | -66% |
| Cancellare 20 file orfani | DELETE × 20 | 20 | media/cleanup | 1 | -95% |
| Convertire base64 su 5 pagine | inline-to-files × 5 | 5 | bulk-inline-to-files | 1 | -80% |
| Duplicare 3 pagine | duplicate × 3 | 3 | bulk-duplicate | 1 | -66% |
| Aggiornare 5 variabili | PUT × 5 | 5 | PUT /variables/bulk | 1 | -80% |
| Caricare immagine + pagina | base64 in JSON (500KB) | 1 | /media/upload + URL (1KB) | 1 | -99.8% JSON |
| Cercare su TUTTI i siti | /sites × N + search × N | N+1 | POST /api/agent/pages/search | 1 | -90%+ |
| **Leggibilità dimensioni** | raw bytes (es. 1048576) | — | `size_formatted` (es. "1.0 MB") | — | **Leggibile** |

## RICETTE — sequenze esatte per ogni task

### Ricetta A: cambiare un testo in una pagina
1. POST /api/agent/sites/{siteId}/pages/{pageId}/find-replace
   body: { "find": "testo da cercare", "replace": "testo nuovo", "regex": false }
   Risposta attesa: { "matches": N, "message": "Sostituite N occorrenze", "saved_version_id": 42 }
2. Se matches è 0: il testo non è presente nel contenuto grezzo (potrebbe essere dentro uno snippet).
3. Informa l'utente del risultato.
4. NON chiamare GET /versions. Il server salva la versione automaticamente.
   [Risparmio: 1 chiamata invece di 2. -50% token.]

### Ricetta B: verificare cosa c'è in una pagina prima di modificarla
1. GET /api/agent/sites/{siteId}/pages/{pageId}/full-report
   → { "page": {...}, "snippets": {...}, "assets": {...}, "variables_used": [...] }
2. Se vuoi solo metriche: GET .../summary (ancora più leggero).
   [Risparmio: 1 chiamata invece di 3. -66% token.]

### Ricetta C: localizzare asset esterni in una pagina
1. GET .../asset-report → lista URL scaricabili (src, href, poster, CSS url(), video .mov, woff2...)
2. Mostra la lista all'utente e chiedi conferma.
3. POST .../extract-assets
   Risposta: { "converted": [...], "tooLarge": [...], "errors": [...], "pages_updated": {...} }
4. Campi utili: **reused: true** (già scaricato), **deduped: true** (stesso contenuto)
5. Se tooLarge non è vuoto: chiedi conferma, riprova con { "force": true }
6. Per più pagine: POST .../pages/bulk-extract-assets (1 chiamata invece di N)
   [Risparmio: 1 chiamata invece di N. -90% su più pagine.]

### Ricetta D: convertire base64 inline in file
1. POST /api/agent/sites/{siteId}/pages/{pageId}/inline-to-files
   Risposta: { "converted": N, "files": [...], "message": "..." }
2. Il contenuto della pagina viene aggiornato automaticamente.
3. Per risposte più leggere: aggiungi `?minimal=true` → { "converted": N } senza lista file.
4. Per più pagine: POST .../pages/bulk-inline-to-files
   [Risparmio: Non serve se hai appena creato la pagina (auto-extract).]

### Ricetta E: pubblicare o nascondere una pagina
POST /api/agent/sites/{siteId}/pages/{pageId}/publish-toggle
body: { "published": true } oppure { "published": false }
MAI usare PUT per questo. Il publish-toggle non tocca il contenuto.
MAI depubblicare mentre lavori. Lascia published=true.

### Ricetta F: duplicare una pagina e modificarla
1. POST /api/agent/sites/{siteId}/pages/{pageId}/duplicate
   body: { "new_url_path": "/nuova-pagina", "new_title": "Titolo copia" }
2. La pagina duplicata è sempre creata come bozza (published: false).
3. Per più pagine: POST .../pages/bulk-duplicate (1 chiamata invece di N)
   [Risparmio: 1 chiamata invece di N. -80% su più pagine.]

### Ricetta G: trovare un testo in tutte le pagine
1. GET /api/agent/sites/{siteId}/pages/search?q=testo+da+cercare
   Risposta: { "results": [ { "id": ..., "url_path": "...", "title": "..." } ] }
2. Per cercare su TUTTI i siti: POST /api/agent/pages/search
   [Risparmio: 1 chiamata invece di N+1. -90%+.]

### Ricetta H: ripristinare una versione precedente
**Metodo veloce (ultima versione):**
POST /api/agent/sites/{siteId}/pages/{pageId}/restore-last
(nessun body) → { "ok": true, "restored_version_id": 42, ... }

**Metodo specifico (versione precisa):**
1. GET /api/agent/sites/{siteId}/pages/{pageId}/versions → trova l'id
2. POST /api/agent/sites/{siteId}/pages/{pageId}/versions/{versionId}/restore

La versione corrente viene sempre salvata prima del restore.
[Risparmio: 1 chiamata invece di 2 con restore-last. -50%.]

### Ricetta I: modificare uno snippet usato in più pagine
**Sostituita da Ricetta V.** Usa quella: 1 chiamata invece di 51.
GET /api/agent/sites/{siteId}/snippets/{snippetId}/usage

### Ricetta L: validare una pagina dopo modifiche
POST /api/agent/sites/{siteId}/pages/{pageId}/validate
Risposta: { "ok": true/false, "issues": [ { "type": "broken_snippet", "detail": "..." } ] }

### Ricetta M: scaricare un file da Google Drive
Usa POST .../media/fetch-url con l'URL condiviso di Google Drive.
Il sistema lo converte automaticamente nell'URL di download diretto.

### Ricetta N: sapere se la compressione video è in corso
Quando carichi un video (upload o fetch-url), la risposta contiene:
- `compressed: false` — il file è subito disponibile, compressione in corso
- `size` — dimensione originale (pre-compressione)
La compressione sostituisce il file in background. Non blocca la risposta.

### Ricetta O: forzare l'export statico
1. POST /api/agent/sites/{siteId}/export-static
   Risposta: { "ok": true, "exported": N, "errors": 0 }
2. Per esportare TUTTI i siti:
   POST /api/agent/export-static-all
   Risposta: { "ok": true, "totalExported": N, "totalErrors": 0 }

### Ricetta P: lavorare con le variabili di sito
1. GET /api/agent/sites/{siteId}/variables
   Risposta: { "variables": [ { "key": "phone", "value": "+39..." } ] }
2. PUT /api/agent/sites/{siteId}/variables/{key}
   body: { "value": "nuovo valore", "description": "opzionale" }
3. DELETE /api/agent/sites/{siteId}/variables/{key}
4. Per più variabili: PUT .../variables/bulk (1 chiamata invece di N)
   [Risparmio: 1 chiamata invece di N. -80% su più variabili.]

### Ricetta Q: caricare immagini PRIMA di creare una pagina (NO base64)
1. POST /api/agent/sites/{siteId}/media/upload (multipart, campo "file")
   path ESATTO: /api/agent/sites/{siteId}/media/upload
   NON /upload, NON /api/agent/upload, NON /sites/:id/upload
   Risposta: { "file": { "url": "/media/{siteId}/{filename}", ... } }
2. Usa l'URL "/media/{siteId}/{filename}" nel HTML della pagina
3. Il JSON della pagina rimane LEGGERO (nessun base64 inline)
   [Risparmio: JSON 500KB → 1KB. -99.8% dimensione richiesta.]

### Ricetta R: creare pagina con base64 (auto-extract lato server)
1. POST /api/agent/sites/{siteId}/pages con contenuto HTML (anche con base64)
2. Il server estrae AUTOMATICAMENTE tutti i base64 in file locali
3. La risposta contiene già le URL /media/... sostituite
4. Non serve chiamare inline-to-files dopo la creazione
5. Stessa cosa per PUT /api/agent/sites/{siteId}/pages/{pageId}
   [Risparmio: 0 chiamate extra. Auto-extract è automatico.]

### Ricetta S: trovare e sostituire su TUTTE le pagine in 1 chiamata
1. POST /api/agent/sites/{siteId}/pages/bulk-find-replace
   body: { "find": "testo", "replace": "nuovo", "regex": false, "dry_run": false }
   Risposta: { "pages_affected": 3, "total_matches": 5, "results": [...] }
2. Con dry_run:true vedi l'impatto senza modificare nulla
3. Le pagine vengono riesportate automaticamente dopo la sostituzione
   [Risparmio: 1 chiamata invece di 10. -90% token.]

### Ricetta T: annullare l'ultima modifica a una pagina
1. POST /api/agent/sites/{siteId}/pages/{pageId}/undo (nessun body)
   Risposta: { "ok": true, "restored_version_id": 42, "restored_at": "..." }
2. Salva la versione corrente prima del rollback (non perdi nulla)
   [Risparmio: 0 chiamate extra se hai saved_version_id dalla modifica precedente.]

### Ricetta U: pulire i media orfani dopo conversioni
1. GET /api/agent/sites/{siteId}/media/unused → lista file orfani
2. POST /api/agent/sites/{siteId}/media/cleanup
   body: { "all_unused": true } ← ELIMINA TUTTI gli orfani in 1 colpo
   Oppure: { "filenames": ["file1.jpg", "file2.png"] }
   Risposta: { "deleted": 5, "freed_bytes": 1048576, "errors": [] }
3. Attenzione: all_unused=true elimina TUTTI i file non referenziati
   [Risparmio: 1 chiamata invece di N+1. -95% token.]

### Ricetta V: sapere quali pagine usano uno snippet (SOSTITUISCE Ricetta I)
1. GET /api/agent/sites/{siteId}/snippets/{snippetId}/usage
   Risposta: { "snippet_id": 3, "snippet_name": "header", "total_pages": 5,
              "pages": [ { "id": 10, "url_path": "/landing", "title": "Landing" }, ... ] }
2. Una sola chiamata. Nessun loop.
   [Risparmio: 1 chiamata invece di 51. -98% token.]

### Ricetta W: analisi COMPLETA di una pagina in 1 chiamata
1. GET /api/agent/sites/{siteId}/pages/{pageId}/full-report
   Risposta: { "page": {...}, "snippets": { total, list, broken },
              "assets": { external_urls, inline_base64, inline_size_kb },
              "variables_used": [...], "media_urls": N }
2. Sostituisce: GET /page + GET /snippet-usage + GET /asset-report
   [Risparmio: 1 chiamata invece di 3. -66% token.]

### Ricetta X: estrarre base64 o asset su più pagine in 1 chiamata
**Base64:** POST /api/agent/sites/{siteId}/pages/bulk-inline-to-files
  body: { "page_ids": [1, 2, 3] }
  → { "pages_processed": 3, "total_converted": 15, "results": [...] }

**Asset esterni:** POST /api/agent/sites/{siteId}/pages/bulk-extract-assets
  body: { "page_ids": [1, 2, 3], "force": false }
  → { "pages_processed": 3, "assets_converted": 12, "too_large": 0, "errors": 0 }
  [Risparmio: 1 chiamata invece di N. -90% su più pagine.]

### Ricetta Y: pulire TUTTI i media orfani in 1 colpo
1. GET /api/agent/sites/{siteId}/media/unused → vedi cosa c'è
2. POST /api/agent/sites/{siteId}/media/cleanup
   body: { "all_unused": true } ← ELIMINA TUTTI gli orfani
   Oppure: { "filenames": ["file1.jpg", "file2.png"] }
   → { "deleted": 5, "freed_bytes": 1048576, "errors": [] }
   [Risparmio: 1 chiamata invece di N+1. -95% token.]

### Ricetta Z: cercare su TUTTI i siti contemporaneamente
1. POST /api/agent/pages/search
   body: { "q": "testo", "site_ids": [1, 21] }  ← site_ids opzionale
   → { "results": [ { "site_id": 1, "site_name": "Negozio Online", "page_id": 5, ... } ], "total": 2 }
2. Se site_ids non specificato, cerca su TUTTI i siti accessibili.
3. Usa GET /api/agent/sites/{siteId}/pages/search per un singolo sito.
   [Risparmio: 1 chiamata invece di N+1. -90%+.]

## COMPRESSIONE VIDEO

I file MP4 vengono automaticamente compressi in background dopo l'upload o il fetch da URL.
- **Target**: ~60 MB per minuto di video
- **Codec**: H.264 (libx264), preset fast, CRF 28
- **Audio**: AAC 128 kbps
- **Fast start**: abilitato per streaming ottimale (metadata all'inizio del file)
- **Comportamento**: il file originale è subito disponibile; la compressione lo sostituisce atomicamente (`rename`) solo a encoding completato con successo
- **Se fallisce**: il file originale viene preservato, nessun crash
- **Dipende da**: ffmpeg deve essere installato nel container (alpine: `apk add ffmpeg`)

## STATIC EXPORT — Caddy Gestito (fallback manutenzione)

Il CMS esporta ogni pagina pubblicata come file HTML statico.
Un Caddy Gestito separato (stack docker indipendente) serve questi file
quando Express è in manutenzione. Zero downtime garantito.

### Regole per l'agente
1. L'export parte **automaticamente** dopo ogni modifica (testo, snippet,
   variabili, SEO, pubblicazione). Non serve chiamare nulla.
2. Se vuoi forzare l'export manualmente (operazioni batch complesse):
   POST /api/agent/sites/:id/export-static    ← solo quel sito
   POST /api/agent/export-static-all          ← tutti i siti
3. Il Caddy Gestito usa `{host}` dinamico → tutti i domini associati
   al sito funzionano senza duplicare file (symlink site_id → dominio).
4. Pagine NON pubblicate → nessun file statico.
5. Se Express è GIU':
   - Pagine esistenti → servite dallo statico (OK)
   - Pagine inesistenti → servita la homepage (404.html uguale al sito)
   - Il Caddy Gestito va su per conto suo, non dipende dal CMS
6. I media (immagini/video) sono su `/media/{siteId}/{file}` e funzionano
   identici sia da Express che dal Caddy. Caddy è PIU' VELOCE per i media.

### Cosa triggera l'export
- Ogni modifica a: pagine, snippet, variabili di sito, homepage_path
- Ogni aggiunta/rimozione di domini
- Ogni deploy (prima del purge Cloudflare)
- Ogni 5 minuti (scheduler interno)
- All'avvio del CMS

## NEWSLETTER

Due tipi di invio, stesso SMTP e stessa quota oraria per sito (si sommano
nello stesso limite, non due limiti separati):

- **Campagna broadcast** — invio singolo. Riceve chi è `confirmed` **al
  momento in cui il server processa l'invio** (ogni 60s, a lotti rispettando
  `rate_per_hour`) — un iscritto che si disiscrive dopo l'invio di ieri non
  riceve quello di oggi, e uno che si iscrive dopo la messa in coda riceve
  comunque quella campagna se ancora in corso di invio.
- **Sequenza evergreen** — N email ordinate (`step_order`), ciascuna inviata
  a un iscritto quando sono trascorsi `delay_days` giorni dalla **conferma
  della sua iscrizione** (non dallo step precedente — pattern "giorno 0/3/7
  dalla conferma", niente drift cumulativo). L'ordine è garantito: uno step
  non parte per un iscritto finché non ha ricevuto lo step precedente, anche
  se la quota oraria ha rallentato gli invii. Un iscritto che si disiscrive
  smette automaticamente di ricevere step successivi (il filtro è sempre
  `status='confirmed'`).

### Setup una tantum — PRIMA di qualunque invio

```
PUT /api/agent/sites/{siteId}/newsletter/settings
body: { "smtp_host": "...", "smtp_port": 465, "smtp_user": "...",
        "smtp_pass": "...", "from_email": "newsletter@sito.it",
        "rate_per_hour": 100, "signature_html": "<p>Il Team di ...</p>" }
```
Body parziale: i campi omessi mantengono il valore già salvato. `signature_html`
è la firma, va configurata una volta sola — viene aggiunta automaticamente
in fondo a OGNI email (campagna o step), insieme a link di disiscrizione e
pixel di apertura (questi ultimi due il server li aggiunge sempre, non
metterli tu nel contenuto). Nessun invio parte finché `newsletter_settings`
non esiste per il sito (niente fallback allo SMTP di sistema).

`GET /api/agent/sites/{siteId}/newsletter/settings` non restituisce mai la
password in chiaro, solo `smtp_pass_set: true/false`.

### Email template per sito (override testi email automatiche)

Ogni email di sistema può avere oggetto/corpo personalizzati per sito.
Se non configurato, si usa il default standard. Stesso sistema disponibile
in UI (`/admin/newsletter/email-templates`).

```
GET    /api/agent/sites/{siteId}/email-templates
       → { templates: [...], kinds: [{ kind, configured }] }

PUT    /api/agent/sites/{siteId}/email-templates/{kind}
       body: { "subject": "...", "body_html": "..." }   ← vuoto = default per quel campo

DELETE /api/agent/sites/{siteId}/email-templates/{kind}
       → rimuove l'override (torna al default)
```

Kinds supportati: `newsletter_confirm`, `newsletter_test`,
`call_confirmation`, `call_reminder`, `form_notify`, `deploy_notify`,
`review_reminder`. Placeholder nel subject/body (stessa sintassi `{var}`
dei locales): `{siteName}`, `{siteDomain}`, `{confirmUrl}`, `{cancelUrl}`,
`{when}`, `{formSlug}`, `{fieldsHtml}`, `{title}`, `{url}`, `{urlPath}`,
`{date}`, `{pageList}`, `{note}`, `{siteId}`. Es. per Example Site 3:

```
PUT /api/agent/sites/200/email-templates/newsletter_confirm
body: { "subject": "Benvenuto in Example Site 3: conferma la tua iscrizione",
        "body_html": "<p>Ciao, clicca per confermare:</p><a href=\"{confirmUrl}\">Conferma</a>" }
```

### Il "costruttore"

Il contenuto (campagne e step) passa per lo stesso motore snippet/variabili
delle pagine, espanso al momento dell'invio (non al salvataggio): usa
`{{snippet:nome}}` per riusare un blocco già gestito per il sito (es. un
articolo, una promo) e `{{var:chiave}}` per le variabili di sito. Componi
l'email così invece di riscrivere HTML da zero — se aggiorni lo snippet
dopo, i contenuti già in coda ma non ancora spediti riflettono la versione
aggiornata.

### Ricetta: campagna broadcast

```
1. POST /api/agent/sites/{siteId}/newsletter/campaigns
   body: { "subject": "...", "html_content": "{{snippet:promo-agosto}}" }
   → { "campaign": { "id": 3, "status": "draft", ... } }
2. POST /api/agent/sites/{siteId}/newsletter/campaigns/3/send
   → { "ok": true, "status": "sending" }
```
2 chiamate. Lo scheduler la processa a lotti nei minuti successivi.

### Ricetta: sequenza evergreen (es. onboarding in 3 email)

```
1. POST /api/agent/sites/{siteId}/newsletter/sequences
   body: { "name": "Onboarding nuovi iscritti" }
   → { "sequence": { "id": 5, "active": true, ... } }
2. PUT /api/agent/sites/{siteId}/newsletter/sequences/5/steps
   body: { "steps": [
     { "step_order": 1, "delay_days": 0, "subject": "Benvenuto!", "html_content": "{{snippet:benvenuto}}" },
     { "step_order": 2, "delay_days": 3, "subject": "Hai già provato...", "html_content": "{{snippet:tip-1}}" },
     { "step_order": 3, "delay_days": 7, "subject": "Un'offerta per te", "html_content": "{{snippet:offerta}}" }
   ] }
   → { "ok": true, "steps": [...] }
```
2 chiamate per l'intera sequenza (sostituzione atomica di tutti gli step,
non una chiamata per step). **ATTENZIONE**: richiamare di nuovo questo
endpoint su una sequenza già attiva con iscritti in corso cancella e
ricrea gli step — chi aveva già ricevuto uno step con un certo `step_order`
può riceverlo di nuovo (lo storico invii è legato all'id dello step, non al
suo ordine). Definisci gli step prima di lasciare che la sequenza raccolga
iscritti maturi, o accetta che una ridefinizione a sequenza già in corso
resetti il progresso su quegli step.

### Ricetta: invio di prova (prima di mettere in coda)

```
POST /api/agent/sites/{siteId}/newsletter/campaigns/{campaignId}/test-send
body: { "email": "tu@esempio.it" }        ← opzionale, default: email dell'account agente
POST /api/agent/sites/{siteId}/newsletter/sequences/{sequenceId}/steps/{stepId}/test-send
body: { "email": "tu@esempio.it" }        ← stesso comportamento, per un singolo step
```
Espande snippet/variabili e aggiunge la firma esattamente come un invio
reale, ma con oggetto prefissato `[PROVA]`, niente link di disiscrizione né
pixel funzionanti, e **non conta come invio** (non tocca `newsletter_sends`/
`newsletter_sequence_sends`, non consuma la quota oraria). Usalo sempre
prima di `POST .../send` su una campagna o prima di lasciare che una
sequenza raccolga iscritti maturi — se `email` non è indicata, arriva
all'indirizzo dell'account con cui l'agente è autenticato.

### Ricetta: import assistito di iscritti esistenti

```
POST /api/agent/sites/{siteId}/newsletter/subscribers
body: { "email": "cliente@esempio.it", "confirmed": true }
```
`confirmed:true` salta il doppio opt-in (email di conferma) — usalo solo
per liste di cui l'utente ha già la titolarità del consenso (es. clienti
esistenti che hanno già acconsentito altrove). Default `confirmed:false`:
l'iscritto va in `pending` e riceve l'email di conferma standard.

## SOCIAL — post pianificati (NON pubblicano davvero)

`social_posts_create`/`social-posts` **non pubblica realmente** su
Twitter/LinkedIn/Facebook: verifica solo che il token della piattaforma sia
configurato, poi registra il post come "simulato" (colonna `simulated=true`)
e ritorna successo. Nessuna chiamata reale alle API social viene fatta.

Se l'utente chiede di "pubblicare un post social", il post pianificato
risulterà visibile in `/admin/social` con lo stato "Simulato" — comunicalo
esplicitamente all'utente invece di far intendere che sia stato pubblicato
davvero. Implementare l'integrazione reale è bassa priorità, non ancora fatto.

## REMINDER — Auto-contesto (anti-compattazione)

Ogni ~12 chiamate API, il servizio include un campo `_reminder` nella
risposta JSON. Contiene una sezione a caso di questo file.

**Cosa fare quando vedi `_reminder`:**
- Leggilo. Contiene una regola o ricetta che potresti aver dimenticato
  dopo una compattazione del contesto.
- Se il reminder dice "Non usare PUT per modifiche parziali" e stavi per
  fare un PUT → fermati e usa find-replace.
- Se il reminder elenca un endpoint che non ricordavi → usalo.
- Se il reminder mostra un risparmio token → usalo.

Il reminder NON modifica il comportamento delle API. È solo un memo.

## ERRORI COMUNI E COME GESTIRLI

- 401 Unauthorized: token scaduto o non valido. Ripeti il flusso di autenticazione dall'inizio.
- 403 Forbidden: non hai accesso a quel sito. Verifica con GET /api/agent/me quale site_id hai assegnato.
- 404 Not Found: l'id pagina o snippet non esiste. Ricarica la lista con GET .../pages o .../snippets. Se il path è tipo `/upload`, probabilmente è sbagliato: controlla la sezione GERARCHIA ENDPOINT.
- 409 Conflict: url_path già esistente. Scegli un path diverso.
- matches: 0 da find-replace: il testo cercato non è nel contenuto grezzo. Potrebbe essere
  espanso da uno snippet: controlla con GET .../snippet-usage e poi modifica lo snippet direttamente.

## ENDPOINT COMPLETI

GET    /api/agent/me
GET    /api/agent/sites
GET    /api/agent/sites/:id/pages
GET    /api/agent/sites/:id/pages/:pid
POST   /api/agent/sites/:id/pages
PUT    /api/agent/sites/:id/pages/:pid                    ← solo se devi riscrivere tutto
GET    /api/agent/sites/:id/pages/search?q=...
POST   /api/agent/sites/:id/pages/bulk-publish
POST   /api/agent/sites/:id/pages/bulk-find-replace         ← cerca/sostituisci su TUTTE le pagine
POST   /api/agent/sites/:id/pages/:pid/publish-toggle
POST   /api/agent/sites/:id/pages/:pid/duplicate
POST   /api/agent/sites/:id/pages/:pid/rename-url
POST   /api/agent/sites/:id/pages/:pid/find-replace       ← preferisci sempre questo al PUT
POST   /api/agent/sites/:id/pages/:pid/extract-assets     ← scarica URL esterni in locale
POST   /api/agent/sites/:id/pages/:pid/inline-to-files    ← converte base64 in file
GET    /api/agent/sites/:id/pages/:pid/asset-report       ← analisi asset prima di modificare
POST   /api/agent/sites/:id/pages/:pid/validate           ← controlla errori dopo modifiche
GET    /api/agent/sites/:id/pages/:pid/versions
POST   /api/agent/sites/:id/pages/:pid/versions/:vid/restore
GET    /api/agent/sites/:id/pages/:pid/summary              ← metriche pagina (senza contenuto)
GET    /api/agent/sites/:id/pages/:pid/full-report          ← analisi completa (snippet+asset+metriche)
POST   /api/agent/sites/:id/pages/:pid/undo                 ← annulla ultima modifica
POST   /api/agent/sites/:id/pages/:pid/restore-last         ← ripristina ultima versione (senza GET)
POST   /api/agent/sites/:id/pages/bulk-inline-to-files      ← converti base64 su più pagine
POST   /api/agent/sites/:id/pages/bulk-extract-assets       ← scarica asset su più pagine
POST   /api/agent/sites/:id/pages/bulk-duplicate            ← duplica più pagine in 1 colpo
POST   /api/agent/pages/search                              ← cerca su TUTTI i siti
GET    /api/agent/sites/:id/pages/:pid/snippet-usage
GET    /api/agent/sites/:id/pages/:pid/rendered
GET    /api/agent/sites/:id/pages/:pid/diff/:vid
GET    /api/agent/sites/:id/snippets
GET    /api/agent/sites/:id/snippets/:sid
GET    /api/agent/sites/:id/snippets/:sid/usage              ← pagine che usano lo snippet
POST   /api/agent/sites/:id/snippets
PUT    /api/agent/sites/:id/snippets/:sid
POST   /api/agent/sites/:id/snippets/:sid/find-replace
GET    /api/agent/sites/:id/media
POST   /api/agent/sites/:id/media/upload                 ← multipart campo "file" — path ESATTO
POST   /api/agent/sites/:id/media/fetch-url              ← supporta link Google Drive condivisi
DELETE /api/agent/sites/:id/media/:filename
GET    /api/agent/sites/:id/media/unused                    ← media orfani non referenziati
POST   /api/agent/sites/:id/media/cleanup                  ← elimina media orfani in blocco
GET    /api/agent/sites/:id/settings
PUT    /api/agent/sites/:id/settings/:key
GET    /api/agent/sites/:id/audit-log
GET    /api/agent/sites/:id/stats
POST   /api/auth/login
POST   /api/agent/verify-otp
POST   /api/agent/sites/:id/export-static              ← forza export statico del sito
POST   /api/agent/export-static-all                    ← forza export TUTTI i siti
GET    /api/agent/sites/:id/newsletter/settings         ← config SMTP+firma (password mai in chiaro)
PUT    /api/agent/sites/:id/newsletter/settings         ← setup una tantum, body parziale
GET    /api/agent/sites/:id/newsletter/subscribers      ← ?status=&limit=&offset=
GET    /api/agent/sites/:id/newsletter/subscribers/stats
POST   /api/agent/sites/:id/newsletter/subscribers      ← import assistito, { email, confirmed? }
DELETE /api/agent/sites/:id/newsletter/subscribers/:email
GET    /api/agent/sites/:id/newsletter/campaigns
GET    /api/agent/sites/:id/newsletter/campaigns/:cid
POST   /api/agent/sites/:id/newsletter/campaigns        ← crea bozza broadcast
PUT    /api/agent/sites/:id/newsletter/campaigns/:cid   ← solo se draft
POST   /api/agent/sites/:id/newsletter/campaigns/:cid/send
POST   /api/agent/sites/:id/newsletter/campaigns/:cid/test-send   ← { email? }, non conta come invio
DELETE /api/agent/sites/:id/newsletter/campaigns/:cid   ← solo bozze
GET    /api/agent/sites/:id/newsletter/sequences
POST   /api/agent/sites/:id/newsletter/sequences        ← crea sequenza vuota
GET    /api/agent/sites/:id/newsletter/sequences/:sid   ← con steps[]
PUT    /api/agent/sites/:id/newsletter/sequences/:sid   ← { name?, active? }
DELETE /api/agent/sites/:id/newsletter/sequences/:sid
PUT    /api/agent/sites/:id/newsletter/sequences/:sid/steps  ← sostituzione atomica di tutti gli step, 1 chiamata
POST   /api/agent/sites/:id/newsletter/sequences/:sid/steps/:stid/test-send  ← { email? }, non conta come invio
GET    /api/agent/sites/:id/variables                  ← elenca variabili di sito
PUT    /api/agent/sites/:id/variables/:key             ← crea/aggiorna variabile
PUT    /api/agent/sites/:id/variables/bulk             ← aggiorna più variabili in 1 colpo
DELETE /api/agent/sites/:id/variables/:key             ← elimina variabile
PATCH  /api/agent/sites/:id/pages/:pid/sections/:name  ← modifica sezione atomica
GET    /api/agent/sites/:id/forms                      ← elenco form con conteggio invii
GET    /api/agent/sites/:id/forms/:slug/submissions    ← invii di un form, paginati (?since=)
GET    /api/agent/sites/:id/forms/search?q=...         ← cerca un valore in TUTTI gli invii del sito
GET    /api/agent/sites/:id/contacts?tag=...            ← contatti dedotti dagli invii (CRM-lite, per email), filtrabile per tag
GET    /api/agent/sites/:id/contacts/tags               ← tag distinti in uso sul sito
GET    /api/agent/sites/:id/contacts/:email             ← storico invii di un contatto + tag/stato/note
PUT    /api/agent/sites/:id/contacts/:email             ← imposta tag/stato/note/valore stimato (crea il contatto se non esiste)
GET    /api/agent/sites/:id/contacts/:email/export      ← diritto GDPR di accesso: export JSON completo
DELETE /api/agent/sites/:id/contacts/:email             ← diritto GDPR alla cancellazione: elimina tutto, permanente
GET    /api/agent/sites/:id/modules                     ← stato moduli opzionali per il sito
PUT    /api/agent/sites/:id/modules/:key                ← attiva/disattiva un modulo
GET    /api/agent/sites/:id/pipeline                    ← board pipeline vendite per stadio (richiede modulo)
GET    /api/agent/sites/:id/calls                       ← elenco chiamate (richiede modulo)
POST   /api/agent/sites/:id/calls                       ← programma chiamata manuale
PUT    /api/agent/sites/:id/calls/:callId               ← imposta stato/esito chiamata
GET    /api/agent/sites/:id/calls/availability           ← regole disponibilità settimanale
PUT    /api/agent/sites/:id/calls/availability           ← sostituzione atomica regole
GET    /api/agent/sites/:id/calls/slots                  ← slot liberi calcolati
POST   /api/agent/sites/:id/calls/book                   ← prenota per conto di qualcuno
GET    /api/agent/sites/:id/tracking                     ← config GA4/GTM/Meta Pixel/CAPI/Clarity (token mascherato)
PUT    /api/agent/sites/:id/tracking                     ← imposta config tracking
GET    /api/agent/sites/:id/pages/:pid/seo               ← meta/canonical/noindex/OG di una pagina
PUT    /api/agent/sites/:id/pages/:pid/seo               ← imposta SEO pagina (effetto su tutti i layout_mode, vedi sezione SEO)
GET    /api/agent/sites/:id/seo                          ← default SEO del sito (immagine OG, handle Twitter, robots.txt extra)
PUT    /api/agent/sites/:id/seo                          ← imposta default SEO del sito
GET    /api/agent/sites/:id/calendars                    ← elenca calendari prenotabili (multi-agenda)
POST   /api/agent/sites/:id/calendars                    ← crea calendario { name, slug?, description?, user_id?, enabled?, ty_page? }
PUT    /api/agent/sites/:id/calendars/:calendarId        ← aggiorna nome/slug/descrizione/proprietario/enabled/ty_page
DELETE /api/agent/sites/:id/calendars/:calendarId        ← elimina calendario (regole a cascata, prenotazioni scollegate)
GET    /api/agent/sites/:id/quizzes                      ← elenca questionari con punteggi (domande/soglie + conteggio risultati)
POST   /api/agent/sites/:id/quizzes                      ← crea questionario { name, slug?, intro?, questions, thresholds, ask_email?, contact_tag?, redirect_url?, enabled? }
PUT    /api/agent/sites/:id/quizzes/:quizId              ← aggiorna questionario (campi omessi invariati)
DELETE /api/agent/sites/:id/quizzes/:quizId              ← elimina definizione questionario (risultati restano)
GET    /api/agent/sites/:id/quizzes/:quizSlug/submissions ← risultati: risposte + punteggio ricalcolato + verdetto

## CONTATTI (CRM-lite)

Nessuna anagrafica separata dai dati dei form: l'email di ogni invio viene
dedotta dal campo marcato tipo `email` nel form (creato con il form builder
in admin), o per euristica sul nome del campo per i form scritti a mano
nelle pagine. Un contatto con `forms_count > 1` ha compilato più form
diversi — utile per capire se un lead ha interagito più volte prima di
essere ricontattato. Se un invio non ha nessun campo email riconoscibile,
resta visibile solo tramite `forms/:slug/submissions` o `forms/search`, non
in `/contacts`.

Tag/stato/note sono invece persistiti (tabella `contacts`, creata/aggiornata
automaticamente ad ogni invio con email riconosciuta) perché non derivabili
dai dati inviati — assegnali con `PUT .../contacts/:email`.

### Segmentazione newsletter per tag

Campagne broadcast e sequenze evergreen accettano `target_tag` in creazione
(`newsletter_campaigns_create`/`newsletter_sequences_create`) o modifica
(`newsletter_campaigns_update`/`newsletter_sequences_update`, passa
`target_tag: ""` per rimuoverlo): se valorizzato, solo gli iscritti
confermati il cui contatto ha quel tag ricevono l'invio; omesso/vuoto =
comportamento invariato, tutti gli iscritti confermati del sito.

### Iscrizione automatica alla newsletter da un form

Nel form builder admin, un form con un campo checkbox può essere impostato
come "consenso newsletter" (`newsletter_optin_key`): se quel checkbox è
spuntato e un'email è identificata nell'invio, iscrive automaticamente alla
newsletter del sito con lo stesso doppio opt-in dell'iscrizione manuale
(email di conferma, nessuna iscrizione istantanea). Non gestibile via API
agente: solo dal builder in admin.

**Tag newsletter da form** (`newsletter_tag_key` + `newsletter_tag_value`
opzionale, sempre dal builder admin): al submit, al contatto derivato
dall'email dell'invio viene assegnato il tag indicato (idempotente, stesso
meccanismo di `PUT .../contacts/:email`). È il ponte tra i form e la
segmentazione: una sequenza/campagna con `target_tag` su quel tag parte da
sola per chi si iscrive da quel form, senza azione agente.

**Pagina di ringraziamento** (`redirect_url`, dal builder admin): dopo un
invio riuscito il browser viene reindirizzato al path indicato (es. `/grazie`)
invece di mostrare il messaggio di conferma. Per i client AJAX il redirect
arriva nel campo `redirect` del JSON (`{ok:true, redirect:"/grazie"}`) e va
seguito lato client. Il server accetta solo path relativi o URL dello stesso
dominio (un `_redirect` esterno arbitrario viene ignorato, anche se presente
nel form).

## TOKEN API DI LUNGA DURATA (per n8n/automazioni)

Oltre al login OTP + `refresh-token` (pensato per sessioni interattive tipo
Claude Code), esiste un secondo tipo di credenziale per automazioni non
interattive: token generati da `/admin/api-tokens` (interfaccia web, un
utente umano li crea), validi 30-365 giorni (default 120), revocabili
singolarmente senza toccare le altre sessioni dell'utente. Usali identici a
un JWT agente: `Authorization: Bearer agtok_...` su qualsiasi endpoint
`/api/agent/...`. Non esiste un endpoint per crearli via API — vanno
generati una volta dall'interfaccia web e incollati nella configurazione di
n8n (o altro sistema).

## MODULI OPZIONALI (attivabili per sito)

Pipeline vendite e Chiamate sono moduli disattivati di default — le loro
route rispondono 403 finché non attivati per quel sito (tranne per
superadmin, che li vede sempre). Attivazione: da `/admin/sites/:id/edit`
(umano) o via `modules_toggle` (agente/n8n).

```
GET    /api/agent/sites/:id/modules                     ← stato moduli per il sito
PUT    /api/agent/sites/:id/modules/:key                ← { enabled: true|false }, key: sales_pipeline | call_scheduling
```

### Pipeline vendite

Riusa `contacts.status` (già esistente) con un vocabolario fisso di stadi:
`lead`, `contattato`, `chiamata_fissata`, `proposta_inviata`, `vinto`,
`perso` (status vuoto o non riconosciuto = "da assegnare"). Aggiunge
`value_estimate` (numerico) al contatto.

```
GET    /api/agent/sites/:id/pipeline                    ← board raggruppata per stadio, con valore totale
```

Sposta uno stadio o aggiorna il valore con `contact_update` (PUT
`/contacts/:email`, campi `status`/`value_estimate`) — nessun endpoint
dedicato, riusa quello dei contatti.

### Chiamate

Log manuale (programmate dall'admin dalla scheda contatto) + autoprenotazione
pubblica su `/book/:siteId` (calcolo slot da disponibilità settimanale
ricorrente, doppio controllo anti-conflitto alla prenotazione, email di
conferma con link di annullamento). Orari interpretati nel fuso orario del
server (nessuna gestione multi-timezone per sito).

**Promemoria automatico**: un'email di promemoria parte da sola (scheduler,
ogni 60s) un'ora prima di ogni chiamata `programmata`, una sola volta
(`reminder_sent_at`) — nessuna azione agente richiesta, visibile in
`GET .../calls` come campo `reminder_sent_at` (null = non ancora inviato).

``` 
GET    /api/agent/sites/:id/calls?email=...              ← elenco chiamate, o storico di un contatto; ?calendar_id= filtra per calendario
POST   /api/agent/sites/:id/calls                        ← programma manualmente { email, scheduled_at, duration_minutes?, calendar_id? }
PUT    /api/agent/sites/:id/calls/:callId                ← { status, outcome_notes } — status: programmata|completata|no_show|annullata
GET    /api/agent/sites/:id/calls/availability?calendar_id=  ← regole disponibilità settimanale (generali o di un calendario)
PUT    /api/agent/sites/:id/calls/availability           ← sostituzione atomica { rules: [{weekday, start_time, end_time, slot_minutes?}], calendar_id? }
GET    /api/agent/sites/:id/calls/slots?days=14&calendar_id= ← slot liberi calcolati (generali o di un calendario)
POST   /api/agent/sites/:id/calls/book                   ← prenota per conto di qualcuno { email, start, notify?, calendar_id? } — ri-verifica il conflitto
GET    /api/agent/sites/:id/calendars                    ← elenca calendari prenotabili (multi-agenda)
POST   /api/agent/sites/:id/calendars                    ← crea calendario { name, slug?, description?, user_id?, enabled?, ty_page? }
PUT    /api/agent/sites/:id/calendars/:calendarId        ← aggiorna nome/slug/descrizione/proprietario/enabled/ty_page
DELETE /api/agent/sites/:id/calendars/:calendarId        ← elimina calendario (regole a cascata, prenotazioni scollegate)
```

`weekday`: 0=domenica...6=sabato (convenzione JS `Date.getDay()`). Orari
come stringa `"HH:MM"`.

**Multi-calendario**: ogni calendario è un'"agenda" prenotabile (es.
"Consulenza", "Demo", "Assistenza") con la propria disponibilità settimanale,
le proprie chiamate e un eventuale proprietario (users.id). Si integra nelle
pagine con `{{calendar:slug}}` (espanso dal page-renderer come `{{form:slug}}`)
e ha una pagina pubblica dedicata `/book/:siteId/:slug` (il vecchio
`/book/:siteId` resta invariato e usa il primo calendario attivo, o le regole
generali se non ce ne sono). `calendar_id` omesso nelle route calls =
comportamento legacy site-wide. Un calendario con `enabled=false` non viene
più espanso nelle pagine né risolto da `/book/:siteId/:slug`, ma le
prenotazioni esistenti restano collegate; l'eliminazione le scollega
(calendar_id → NULL) senza cancellarle.

**Pagina di ringraziamento per calendario** (`ty_page`): dopo una
prenotazione riuscita il visitatore viene portato alla pagina configurata
invece del messaggio di conferma standard. Valida solo un path relativo
(es. `/grazie`) o un URL dello stesso dominio (mai un dominio esterno). Il
widget `{{calendar:slug}}` la segue automaticamente (`window.location` sul
campo `redirect` del JSON); la pagina pubblica `/book/:siteId/:slug` fa un
redirect HTTP 302; `calls_book` (agente) NON reindirizza, risponde col JSON
normale. Settabile in admin (form calendario) o via agent:
`POST/PUT .../calendars` con `ty_page` (stringa vuota = la rimuove).

## QUESTIONARI (quiz con punteggi)

Questionari a risposta singola dove ogni opzione ha un punteggio: al submit i
punti si sommano e il visitatore vede il verdetto corrispondente alla soglia
raggiunta. Il caso d'uso classico è la **qualifica lead** (es. framework
BANT: Budget, Authority, Need, Timeline) ma vanno bene anche assessment,
test e checklist. Si integrano nelle pagine con `{{quiz:slug}}` (espanso dal
page-renderer come `{{form:slug}}` e `{{calendar:slug}}`).

```
GET    /api/agent/sites/:id/quizzes                      ← elenca questionari (domande, soglie, conteggio risultati)
POST   /api/agent/sites/:id/quizzes                      ← crea questionario
PUT    /api/agent/sites/:id/quizzes/:quizId              ← aggiorna (campi omessi invariati)
DELETE /api/agent/sites/:id/quizzes/:quizId              ← elimina definizione (i risultati restano)
GET    /api/agent/sites/:id/quizzes/:quizSlug/submissions ← risultati con punteggio ricalcolato e verdetto
```

**Struttura di `questions`** (array di domande, max 30, opzioni max 12):
```json
[
  { "key": "budget", "label": "Qual è il budget disponibile?",
    "options": [
      { "label": "Meno di 1.000 €", "points": 0 },
      { "label": "1.000-5.000 €", "points": 1 },
      { "label": "5.000-20.000 €", "points": 2 },
      { "label": "Oltre 20.000 €", "points": 3 }
    ] },
  { "key": "authority", "label": "Sei tu il decisore?",
    "options": [
      { "label": "Sì, decido io", "points": 3 },
      { "label": "Posso influenzare", "points": 1 },
      { "label": "No, devo chiedere", "points": 0 }
    ] }
]
```

**Struttura di `thresholds`** (soglie di verdetto, ordinate per `min`; `max`
null/omesso = fino all'infinito):
```json
[
  { "min": 0,  "max": 3,  "title": "Lead freddo", "message": "Va coltivato con contenuti.", "class": "cold" },
  { "min": 4,  "max": 7,  "title": "Lead tiepido", "message": "Interessato, da qualificare meglio.", "class": "warn" },
  { "min": 8,  "max": null, "title": "Lead qualificato 🔥", "message": "Contattare entro 24 ore.", "class": "ok" }
]
```

**Punteggio**: calcolato due volte — client-side nel widget (feedback
immediato, funziona anche nell'export statico) e server-side al submit
(`POST /quiz/:siteId/:slug`), che è la fonte di verità salvata in
`quiz_submissions`. Un client modificato non può gonfiare il proprio
punteggio.

**Lead nel CRM**: con `ask_email: true` il widget mostra un campo email
facoltativo; se compilato, il lead viene creato/aggiornato in `/contacts` e
gli viene assegnato `contact_tag` (es. `qualifica-lead-caldo`) — le
sequenze/campagne newsletter con `target_tag` corrispondente partono da sole.

**`redirect_url`**: pagina di ringraziamento dopo il submit (path relativo o
URL stesso dominio), stesso comportamento dei form. I client AJAX ricevono
la destinazione nel campo `redirect` del JSON e la seguono col widget.

## CRM AUTOMATION (segmenti, workflow, scoring, task, funnel)

Funzionalità "tipo CRM/ActiveCampaign" native, costruite su `contacts`.
Niente connettori esterni. Ogni azione significativa (form, quiz, email,
chiamata, tag, stadio) genera un **evento contatto** (`contact_events`) che
alimenta segmenti, workflow e scoring.

### Segmenti dinamici
Query salvate sui contatti; la membership è materializzata e aggiornata a
ogni evento. Regole: `[{field, op, value, days?}]` con `match_mode all|any`.
Campi: `tag` (has), `status`/`email`/`notes`/`utm_source`/`utm_medium`/
`utm_campaign`/`first_source` (eq/neq/contains/...), `score`/
`value_estimate` (gt/gte/lt/lte), `event` (gte_days_ago/lt_days_ago/exists,
`days` = finestra). Preview con `GET .../segments/preview?rules=<json>`.
```text
GET    /api/agent/sites/:id/segments                ← elenco con n° membri
POST   /api/agent/sites/:id/segments                ← crea { name, rules, match_mode? }
PUT    /api/agent/sites/:id/segments/:segmentId     ← aggiorna
DELETE /api/agent/sites/:id/segments/:segmentId     ← elimina
GET    /api/agent/sites/:id/segments/:segmentId/members ← email nel segmento
POST   /api/agent/sites/:id/segments/:segmentId/recount ← ricalcolo manuale
GET    /api/agent/sites/:id/segments/preview        ← dry-run senza salvare
```

### Workflow a trigger (automazioni)
Regole "se evento → azioni". `trigger_type`: `form_submitted`,
`quiz_completed`, `email_opened`, `email_clicked`, `call_booked`,
`call_status_changed`, `stage_changed`, `tag_added`, `contact_created`,
`score_threshold`, `segment_entered`, `manual`. `trigger_config` filtra
(es. `{"quiz_slug":"qualifica-lead","min_score":8}`). Azioni ordinate:
`add_tag`, `remove_tag`, `set_stage`, `send_campaign`, `send_sequence`,
`create_task`, `notify_email`, `wait_days` (coda differita nel tick).
Idempotente: stessa campagna non viene re-inviata allo stesso contatto.
```text
GET    /api/agent/sites/:id/workflows               ← elenco
POST   /api/agent/sites/:id/workflows               ← crea { name, trigger_type, trigger_config?, actions:[{action_type, action_config}] }
PUT    /api/agent/sites/:id/workflows/:workflowId   ← aggiorna (actions sostituisce tutto)
DELETE /api/agent/sites/:id/workflows/:workflowId   ← elimina
GET    /api/agent/sites/:id/workflows/:workflowId/runs ← log esecuzioni
POST   /api/agent/sites/:id/workflows/:workflowId/test ← dry-run (elenca azioni senza eseguirle)
```

### Lead scoring
Regole evento→punti + soglie min_score→azione (set_stage/add_tag/
notify_email). Decadimento automatico: score × 0.95 per ogni giorno senza
eventi (tick scheduler). `score`/`add_score` aggiornabili anche a mano.
```text
GET/POST/PUT/DELETE /api/agent/sites/:id/scoring-rules
GET/POST/DELETE     /api/agent/sites/:id/scoring-thresholds
```

### Task vendite + funnel
Task assegnate agli utenti (filtri assignee/status/email, `status done` →
`done_at`). Funnel snapshot giornaliero per canale UTM (visite → lead →
chiamate → vinti + revenue), calcolato dallo scheduler.
```text
GET/POST/PUT/DELETE /api/agent/sites/:id/tasks
GET    /api/agent/sites/:id/funnel                  ← snapshot per canale/giorno
```

### Email tracking (open/click) + UTM
Le email (campagne e sequenze) includono già il pixel open esistente; i link
http/https vengono riscritti con `/track/click/:kind/:sendId?u=...` (redirect
sicuro, solo http/https, niente userinfo/javascript). Le statistiche:
```text
GET /api/agent/sites/:id/email-stats/:campaignId        ← open/click campagna
GET /api/agent/sites/:id/email-stats/sequence/:sequenceId ← per step
```
UTM: i form catturano `utm_source`/`utm_medium`/`utm_campaign` (campi
nascosti o query params); la PRIMA origine vince su `contacts.utm_*` +
`first_source`. Disattivabile con variabile di sito `tracking_email_enabled=0`.

### Preferenze contatto (GDPR granulare)
Consenso per canale (`pref_email/sms/phone/whatsapp/marketing`) + pagina
pubblica `/preferences/:token` (link nelle email con `{{pref_url}}`).
Disattivando email/marketing si disiscrive anche dalla newsletter.
```text
POST /api/agent/sites/:id/contacts/:email/pref-token   ← genera token
GET  /api/agent/sites/:id/contacts/:email/extras       ← score+utm+preferenze+eventi
PUT  /api/agent/sites/:id/contacts/:email/extras       ← aggiorna score/prefs/utm
```

### Note lead (timeline)
Oltre al campo singolo `notes` (compatibilità), ogni contatto ha una
timeline di note multiple con autore (`author_type: human|agent|system`,
`author_name`). Ogni nota genera l'evento `note_added` (workflow/scoring).
Usale dopo ogni interazione significativa: la storia del lead resta
leggibile dagli umani.
```text
GET    /api/agent/sites/:id/contacts/:email/notes        ← timeline
POST   /api/agent/sites/:id/contacts/:email/notes        ← aggiungi
       body: { body, author_type?, author_name? }
DELETE /api/agent/sites/:id/contacts/:email/notes/:noteId ← elimina
```

### Conversazioni (email/WhatsApp)
Un thread per contatto+canale con la storia dei messaggi `in/out`.
Le email inviate da campagne/sequenze vengono registrate qui
automaticamente (outbound). Il canale **whatsapp NON viene inviato dal
CMS**: un bot esterno (Baileys, es. ExampleBot) registra i messaggi in/out
via API — il CMS è solo l'archivio unico della conversazione.
Ogni messaggio genera l'evento `conversation_message`; il cambio stato
`open|pending|closed` genera `conversation_status_changed`.
```text
GET    /api/agent/sites/:id/conversations                 ← thread (filtri email/channel/status)
GET    /api/agent/sites/:id/conversations/:convId/messages ← storia completa
POST   /api/agent/sites/:id/contacts/:email/conversations/:channel/messages
       channel: email|whatsapp — body: { direction: in|out, subject?, body, meta? }
PATCH  /api/agent/sites/:id/conversations/:convId          ← status o subject
DELETE /api/agent/sites/:id/conversations/:convId          ← elimina thread
```

### Opportunità/affari + preventivi PDF (26)
Affare legato a un contatto e a una pipeline: importo, probabilità (0-100),
stadio, stato open/won/lost. I preventivi hanno righe `items:
[{description, qty, price}]` e stato `draft → sent → viewed → signed`;
il link cliente è `/quote/:token` (pagina pubblica + PDF generato al volo
con pdfkit, nessun file su disco). Eventi: `opportunity_stage_changed`,
`opportunity_status_changed`, `quote_sent`, `quote_viewed`, `quote_signed`.
```text
GET/POST            /api/agent/sites/:id/opportunities
GET/PUT/DELETE      /api/agent/sites/:id/opportunities/:oppId
GET                 /api/agent/sites/:id/opportunities/:oppId   ← con preventivi
GET/POST            /api/agent/sites/:id/quotes
GET/PUT/DELETE      /api/agent/sites/:id/quotes/:quoteId
POST                /api/agent/sites/:id/quotes/:quoteId/status  ← sent|viewed|signed
Pagine pubbliche:   GET /quote/:token · GET /quote/:token/pdf · POST /quote/:token/sign
```

### Clienti + servizi (area clienti GENERICA)
Un contatto può essere marcato "cliente" (`is_client`) con uno stato
(`active` | `suspended` | `inactive`). Il catalogo servizi è configurabile
(es. `portale`, `whatsapp`, `calendario`) e ogni servizio si attiva/disattiva
per singolo cliente. Un servizio ESTERNO (es. area clienti dedicata) interroga
la verifica di accesso per sapere se un cliente può usare un servizio: true
solo se cliente attivo + servizio attivo nel catalogo + servizio assegnato.
Un'opportunità che passa a `won` marca automaticamente il contatto come
cliente attivo (se non lo era già).
```text
GET/POST            /api/agent/sites/:id/services-catalog          ← catalogo
PATCH/DELETE        /api/agent/sites/:id/services-catalog/:key
GET                 /api/agent/sites/:id/clients?status=active     ← clienti
GET                 /api/agent/sites/:id/clients/:contactId
POST                /api/agent/sites/:id/clients/:contactId/mark   ← { is_client, client_status }
GET                 /api/agent/sites/:id/clients/:contactId/services
POST                /api/agent/sites/:id/clients/:contactId/services/:serviceKey/set ← { active, config? }
GET                 /api/agent/sites/:id/clients/:contactId/access/:serviceKey  ← { has_access }
GET                 /api/agent/sites/:id/clients/access-by-email?email=…&service=… ← per servizio esterno
```

### Merge contatti
Unisce un contatto in un altro: tags union, score/value max, stadio più
avanzato, primo UTM; riaggancia invii/chiamate/task/eventi; elimina il
sorgente. Transazionale.
```text
POST /api/agent/sites/:id/contacts/:email/merge  body: { into_email: "..." }
```

### Pipeline multiple
Più board con stadi custom (una per servizio/nicchia). `contacts.pipeline_id`
NULL → pipeline default del sito (o board legacy).
```text
GET/POST/PUT/DELETE /api/agent/sites/:id/pipelines
```

## TRACKING & ANALYTICS (GA4, Meta Pixel/CAPI, GTM, Clarity)

```
GET    /api/agent/sites/:id/tracking                    ← config attuale (token CAPI mascherato)
PUT    /api/agent/sites/:id/tracking                    ← { ga4Id?, gtmId?, metaPixelId?, metaCapiToken?, metaCapiTestCode?, clarityId?, searchConsoleVerification?, consentBannerText?, consentAcceptLabel?, consentRejectLabel?, consentPrivacyUrl? }
```

Nessun modulo da attivare: appena una di queste chiavi è valorizzata (GA4,
GTM, Pixel o Clarity), lo script relativo e il **banner di consenso GDPR**
(Consent Mode v2: `ad_storage`/`analytics_storage`/`ad_user_data`/
`ad_personalization`, negati di default) compaiono automaticamente sul sito
pubblico — per TUTTI i layout_mode. Le pagine `wrapped` li ricevono dal
layout (`views/partials/tracking-head.ejs` nel `<head>` e
`tracking-body.ejs` prima di `</body>`); le pagine `standalone` li ricevono
cuciti nell'HTML salvato da `injectTrackingIntoStandalone` (`serve.js` +
`static-export.js`, stessa logica del semi-wrapped SEO). Sotto il cofano
riusa la tabella `settings` generica per-sito già esistente (chiavi
`tracking_*`), quindi è raggiungibile anche via `GET/PUT
/api/agent/sites/:id/settings/:key` con quelle chiavi, se preferito.

⚠️ **NON combinare il tracking nativo con banner/script manuali già nel
template di una pagina standalone**: attivando GA4 via API, il banner CMS
compare accanto a quello scritto a mano e GA4 viene caricato due volte
(doppio conteggio). Se un sito standalone usa già un banner manuale
GDPR-compliant (es. Example Site 1), tieni vuote le chiavi `tracking_*` — è la
configurazione attuale.

**Testi del banner personalizzabili** (`consentBannerText`,
`consentAcceptLabel`, `consentRejectLabel`, `consentPrivacyUrl` per un link
"Scopri di più" opzionale, es. alla pagina privacy policy del sito): se
lasciati vuoti/non impostati, usano default in italiano sensati. Stessa
logica di `ai_disclosure_text` sotto: proponi di personalizzarli solo se
l'utente lo chiede o ha un contesto specifico (tono di voce del brand,
lingua diversa dall'italiano, ecc.), non modificarli "di default".

**Non inviare mai GA4 e GTM insieme se GA4 è già gestito dentro GTM**:
doppio conteggio delle visite.

### Meta Conversions API (lato server)

Se `metaPixelId` + `metaCapiToken` sono configurati, l'app invia da sola
(nessuna azione agente richiesta) tre eventi standard Meta ai momenti di
conversione reali già presenti:

| Evento Meta | Quando |
|---|---|
| `Lead` | invio di un form pubblico |
| `CompleteRegistration` | conferma iscrizione newsletter (click sul link nell'email) |
| `Schedule` | prenotazione chiamata da `/book/:siteId` |

Ogni invio è **condizionato al consenso marketing** del visitatore (cookie
`consent_marketing=1`, impostato dal banner) — se il consenso non risulta
concesso, l'evento non parte, senza errore. Nessun evento PageView
server-side: le pagine esportate staticamente sono servite da Caddy, fuori
dalla visibilità di Express, e il pixel client-side copre già il PageView.
`metaCapiToken` non è mai restituito in chiaro da `GET .../tracking` (solo
`GET .../me`/audit non lo vedono comunque); per generarlo: Gestione Eventi
Meta → l'evento del Pixel → Impostazioni → Conversions API → Genera token
d'accesso.

## SEO (canonical, Open Graph, JSON-LD, noindex, robots.txt/sitemap)

```
GET    /api/agent/sites/:id/pages/:pid/seo             ← meta/canonical/noindex/OG di una pagina
PUT    /api/agent/sites/:id/pages/:pid/seo             ← { meta_title?, meta_description?, meta_keywords?, canonical_url?, noindex?, og_image? }
GET    /api/agent/sites/:id/seo                        ← default SEO del sito
PUT    /api/agent/sites/:id/seo                        ← { defaultOgImage?, twitterHandle?, robotsExtra? }
```

**Leggi questo prima di usare `pages/:pid/seo`**: i campi hanno effetto su
TUTTI i layout_mode. Sulle pagine `layout_mode="wrapped"` i tag arrivano dal
layout del CMS (`views/layouts/site.ejs`). Sulle pagine
`layout_mode="standalone"` — il caso più comune su questa piattaforma, es.
tutte le pagine di example-site-2.it e example-site-1.it — l'HTML è quello
salvato in `content`, ma i campi SEO vengono cuciti nel `<head>` al momento
del rendering live (serve.js) e dell'export statico (Caddy): override NON
distruttivo — un campo vuoto lascia intatto il tag scritto a mano nel
template (es. il `<title>` dell'articolo), un campo valorizzato sostituisce
il tag esistente o lo inserisce prima di `</head>`.

Campi supportati: `meta_title` (sostituisce/inserisce `<title>`),
`meta_description`, `meta_keywords`, `canonical_url` (canonical + og:url),
`og_image` (og:image + twitter:image), `noindex` (header `X-Robots-Tag` nel
live + `<meta name="robots" content="noindex,follow">` nell'HTML esportato
staticamente — Caddy serve i file statici senza passare da Express,
l'header da solo non basterebbe), più i tag Open Graph/Twitter derivati e
il JSON-LD WebPage (iniettato SOLO se l'HTML non ne contiene già uno: uno
schema scritto a mano, es. Article, ha priorità).

Quindi per la SEO di una pagina standalone NON è più necessario scrivere i
tag a mano nell'HTML: basta `PUT .../seo`. I tag scritti a mano nel
template restano validi come fallback finché i campi sono vuoti. Esempio:
```html
<!-- scritto a mano nel template: resta finché meta_title è vuoto -->
<title>Titolo articolo</title>
```

**Default di sito** (`GET/PUT .../seo`): `defaultOgImage` è il fallback per
le pagine che non impostano un proprio `og_image` — sia `wrapped` che
`standalone` (per queste ultime vale quando il campo `og_image` di
`page_seo` è vuoto, e l'immagine viene comunque cucita nel `<head>`).
`robotsExtra`: una
direttiva robots.txt per riga (`User-agent`, `Disallow`, `Allow`,
`Crawl-delay`, `Sitemap`, o commenti `#`) — righe non conformi scartate
silenziosamente. Utile per bloccare crawler AI specifici:
```
User-agent: GPTBot
Disallow: /
```
**Non usare `Disallow` per una pagina che deve solo essere `noindex`**: un
`Disallow` impedisce ai crawler di leggere la pagina, quindi anche di
vederne il tag `noindex` — i due meccanismi vanno in conflitto, non si
sommano.

Sotto il cofano riusa la tabella `settings` generica per-sito (chiavi
`seo_*`), quindi `GET/PUT .../seo` è raggiungibile anche via `GET/PUT
/api/agent/sites/:id/settings/:key` con quelle chiavi, se preferito —
stesso pattern di `/tracking`.

La sitemap (`GET /sitemap.xml`) esclude automaticamente le pagine
`noindex`; il robots.txt (`GET /robots.txt`) include le `robotsExtra` del
sito.

## TRASPARENZA CONTENUTI IA (AI Act art. 50)

Non un endpoint dedicato: è una site_variable come le altre (`brand_name`,
`legal_line`, ecc.), chiave `ai_disclosure_text`, gestibile con gli
endpoint già esistenti:

```
PUT    /api/agent/sites/:id/variables/ai_disclosure_text   ← { value: "testo dicitura" }
DELETE /api/agent/sites/:id/variables/ai_disclosure_text   ← rimuove la dicitura
```

Se valorizzata, il testo compare in fondo a ogni pagina pubblica del sito
(footer). **Non impostarla di default o "per sicurezza"**: l'art. 50
richiede la dicitura solo per testo generato/modificato da IA "pubblicato
per informare il pubblico su temi di interesse pubblico" (es. articoli,
approfondimenti) — **non si applica** se un umano rivede il testo e ne ha
la responsabilità editoriale prima della pubblicazione, che è il flusso
normale di questo CMS (l'IA propone, un utente salva/pubblica). Proponila
solo se l'utente descrive un caso reale di pubblicazione IA con revisione
minima o nulla su temi di interesse pubblico — in caso di dubbio, chiedi
prima di attivarla, non è una decisione tecnica.

## FOOTER TAGLINE

Il footer dei siti pubblici può mostrare una tagline sotto il nome/brand.
Due modi equivalenti (la variabile di sito vince sul .env):

- **Globale**: variabile d'ambiente `FOOTER_TAGLINE` nel `.env` del server
  (vuota = riga nascosta, il default).
- **Per sito** (raccomandato se i siti hanno toni diversi): site_variable
  `footer_tagline`, gestibile con gli endpoint variabili esistenti:

```
PUT    /api/agent/sites/:id/variables/footer_tagline   ← { value: "La tua tagline" }
DELETE /api/agent/sites/:id/variables/footer_tagline   ← rimuove (riga nascosta)
```

Il footer è un partial condiviso (`views/partials/footer.ejs`): la riga
compare in tutte le pagine del sito che usano il layout CMS. Sui siti
standalone (HTML salvato in `content`) la tagline va messa a mano nel
template, come le altre parti del footer — non viene iniettata
automaticamente. Non inventare tagline di default: se nessuna delle due è
configurata, la riga non viene renderizzata.

## DIRITTI GDPR SUI DATI DI UN CONTATTO (accesso, portabilità, cancellazione)

I dati di una persona sono sparsi su più tabelle senza una FK comune
(invii form, riga contatto, chiamate, iscrizione newsletter — l'email è
l'unico collegamento). `contact_export`/`contact_erase` li raccolgono/
eliminano in un colpo solo invece di dover incrociare a mano
`forms_submissions`, `pipeline_board`, `calls_list`, ecc.

`contact_erase` è **permanente e non reversibile** (cancellazione vera,
non un flag "cancellato"): usalo solo su richiesta esplicita dell'utente
per rispondere a una richiesta di cancellazione GDPR di un visitatore
reale — mai come pulizia dati generica, mai "per essere sicuri", mai senza
che l'utente abbia confermato l'email esatta da cancellare. In caso di
dubbio sull'identità del contatto, mostra prima `contact_export` (o
`contact_timeline`) e fai confermare all'utente prima di procedere con la
cancellazione.

---

## Advanced Features — Roadmap Implementation

All core features are implemented, tested (312 test suite) and exposed
as agent routes + MCP tools (301 tools total). Panoramica:

- **27 — Task ricorrenti + follow-up intelligente**: `recurring-tasks`
  (cadence daily/weekly/monthly/custom, generazione automatica via tick),
  `followup-rules` (se conversazione in attesa di risposta da N giorni →
  create_task/notify_email/add_tag), log `followup-runs` idempotente.
- **28 — Ruoli/permessi granulari, turni, audit**: `roles` custom con
  permissions per modulo (`crm_list_roles`...), `shifts` operatori,
  `operators-on-duty`, ricerca `audit-events` con filtri.
- **29 — Runtime conversazionale per canale**: `agent-runtimes` con regole
  ordinate (contains/starts/equals/regex), match per contatto/segmento/tag,
  preferenze GDPR rispettate (pref_whatsapp=false → skip), LLM opzionale,
  test dry-run. WhatsApp MAI inviato dal CMS (registro + bot Baileys esterno).
- **30 — Knowledge base + ricerca full-text**: `kb` articoli (categoria,
  tag), indice GIN `to_tsvector('italian')`, ricerca `kb/search` con rank.
- **31 — Agent builder + sandbox**: `agent-definitions` (config prompt/
  canali/tools), test sandbox dry-run (`/test`), storico `sandbox-runs`.
- **32 — Human-in-the-loop**: `approvals` (kind outbound_message/task/quote/
  campaign/contact_change/custom), approve esegue il payload, reject/delete.
- **33 — Riepilogo IA chiamate**: `call-summaries` (LLM se configurato,
  template fallback), azioni + next step, correzione manuale.
- **34 — Proposta risposta operatore**: `reply-suggestions` generate da
  conversazione + KB, approva/scarta con un clic.
- **35 — Webhook in/out**: endpoint pubblico `/webhooks/in/:siteId/:token`
  (mapping eventi → azioni), webhook out con firma HMAC, coda
  `webhook-deliveries` con retry/backoff (agganciato a `emitContactEvent`).
- **36 — OAuth Google**: `oauth-apps` + flusso auth code (auth-url/exchange/
  refresh/disconnect), callback `/oauth/callback/:provider`.
- **37 — Sync calendario bidirezionale**: `calendar-sync-configs`
  (calls ↔ Google Calendar, push/pull), log esecuzioni; senza OAuth fallisce
  pulito.
- **38 — Link pagamento Stripe**: `payment-links` con token pubblico
  `/pay/:token` (pagina + conferma), Stripe reale se `STRIPE_SECRET_KEY`
  configurata, evento `payment_paid`.
- **39 — Export/import completo**: `data-export` (JSON multi-tabella o CSV
  contatti), `data-import` (upsert contatti/task con log `import-jobs`).
- **40 — Dashboard realtime**: `dashboard/kpis` (lead per canale, valore
  pipeline, SLA task, attività recente), viste salvabili, UI `/admin/dashboard`.
- **41 — Report periodici**: `report-configs` (weekly/monthly, sezioni,
  destinatari), generate (dry-run) / send (email) / runs; tick scheduler.
- **42 — Sandbox/staging**: `sandbox/run` dry-run per segment/workflow/
  agent/quote con log `sandbox-runs` e scenari riutilizzabili.
- **43 — Backup con storico**: `backup-jobs` (esecuzione manuale, elenco,
  dettaglio, eliminazione; registra anche i fallimenti).
- **44 — Rate-limit per canale con avvisi**: `channel-limits` (email/
  whatsapp/call/sms/chat per hour/day), `consume` atomico, avviso email al
  superamento, storico `channel-usage`.
- **45 — Link tracciati (QR/link corto)**: `tracked-links` per sito con
  `target_url`, `slug` univoco, `channel`/`utm_campaign` (aggancio al
  funnel), `qr_enabled`; endpoint pubblico `/go/:slug` (conta visita +
  302) e `/go/:slug.qr` (PNG QR); stats visite (totali/unici/giorno).

Vincolo invariato: **WhatsApp mai nativo** — il CMS registra solo i messaggi;
l'invio resta a motori Baileys esterni (ExampleBot) via API agent/MCP.
