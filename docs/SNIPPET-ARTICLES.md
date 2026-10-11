# SNIPPET ARTICOLI/BLOG — contratto e parametri

> Documento tecnico operativo sugli snippet `{{articles:...}}` e `{{article:...}}`.
> Complementare a `docs/ROADMAP-ARTICOLI.md` (che descrive il modello dati e le
> fasi di costruzione): qui c'è solo il **contratto pubblico** degli snippet,
> cioè ciò che un autore di pagine può incollare nel contenuto di una pagina.

## 1. Contratto degli snippet

Due placeholder distinti, entrambi gestiti da `expandSnippets` in
`src/services/page-renderer.js`:

| Placeholder | Cosa rende | Parametri |
|---|---|---|
| `{{articles:...}}` | Lista di card articoli (da zero a N) | `category`, `date_from`, `date_to`, `limit`, `show_date` (tutti opzionali; `{{articles}}` nudo = default) |
| `{{article:<url_path>}}` | Il **singolo** articolo completo (titolo, data, corpo HTML) | Un solo parametro posizionale obbligatorio: l'`url_path` esatto dell'articolo |

**Dove si possono usare**: in qualunque pagina del sito, con qualunque
`layout_mode` (`wrapped` o `standalone`) — inclusa una homepage scritta a mano
in modalità standalone. Gli snippet sono puro testo dentro `content`: non
dipendono dal layout circostante.

**Come si innescano**: sono espansi dalla catena `expandSnippets`, già chiamata
da `serve.js` (rendering live) e da `static-export.js` (export statico) per
**ogni pagina**, indipendentemente dal layout. Non serve alcun innesco
aggiuntivo: qualunque pagina che contenga lo snippet, servita o esportata, lo
vede espanso.

## 2. Parametri di `{{articles:...}}`

I parametri si separano con `|`, ciascuno nella forma `chiave=valore`.
Parametri non riconosciuti o malformati sono **ignorati silenziosamente** (non
rompono mai la pagina).

| Chiave | Valori | Default | Note |
|---|---|---|---|
| `category` | uno slug (`viaggi`) o più slug separati da virgola (`viaggi,cibo`) | omesso = tutte le categorie | Internamente è **sempre un array** (anche con un solo slug). Se anche **uno solo** degli slug non esiste per il sito, l'intera combinazione non si espande (vedi §4) |
| `date_from` | data `YYYY-MM-DD` | nessun limite inferiore | Filtra `published_at >= 'YYYY-MM-DD 00:00:00'`. Valore non valido → ignorato silenziosamente |
| `date_to` | data `YYYY-MM-DD` | nessun limite superiore | Filtra `published_at <= 'YYYY-MM-DD 23:59:59'` (l'intero giorno finale è **incluso**). Valore non valido → ignorato silenziosamente |
| `limit` | intero | `6` | **Clampato 1–500**. NESSUNA paginazione per design: per un archivio completo usare le pagine generate `/blog` o `/blog/categoria/<slug>`. Il tetto (alzato da 24 a 500) resta un limite di sicurezza generico, non pensato per un sito specifico: evita un valore arbitrario che generi un blocco illimitato, ma consente di sostituire anche un feed homepage di dimensioni reali |
| `show_date` | `true`/`false` | `true` | Con `false` la data non è passata al template (`{{published_at}}`/`{{published_at_short}}` vuoti) |
| `enable_client_filter` | `true`/`false` | `false` | Con `true`, ogni card riceve `data-category="<slug>"` sul tag principale (per un filtro JS lato client sulle card della stessa lista). **Default `false`**: un sito che veicola già la categoria a modo suo (es. una classe nel proprio `card_template_override`) non deve vedersi aggiungere un attributo non richiesto — serve per riprodurre esattamente un markup esistente |

**Esempio**: `{{articles:category=viaggi,cibo|limit=8|show_date=false|date_from=2024-01-01}}`.

## 3. Sintassi di `{{article:<url_path>}}`

Un **solo parametro posizionale**, obbligatorio: l'`url_path` esatto
dell'articolo, che può contenere `/`.

```
{{article:/articoli/il-mio-pezzo}}
```

- A differenza di `{{articles:...}}` (dove il gruppo dei parametri è
  opzionale), qui il valore è **obbligatorio**: senza `url_path` non si sa
  quale articolo mostrare, quindi `{{article:}}` non viene riconosciuto.
- La data è **sempre** mostrata (è il singolo articolo completo, la data fa
  parte della sua presentazione: non esiste un parametro `show_date`).
- Usa il template per-sito `blog_article_embed_template` (vedi §5).

## 4. Comportamento senza risultati

Il contratto d'errore distingue due casi, in modo che un **typo dello slug o
dell'`url_path` resti visibile al proprietario** invece di sparire silenziosamente:

| Caso | `{{articles:...}}` | `{{article:...}}` |
|---|---|---|
| Categoria (o uno degli slug) **inesistente** | Placeholder lasciato **invariato** in HTML | — |
| `url_path` **inesistente** | — | Placeholder lasciato **invariato** in HTML |
| Categoria **esistente** ma senza articoli (o nessun articolo nel range di date) | **Stringa vuota** | — |

In pratica: se il placeholder resta scritto nella pagina, è un errore di
configurazione da correggere; se sparisce senza contenuto, la configurazione è
corretta ma semplicemente non c'è nulla da mostrare.

## 5. Template configurabili per sito

In `/admin/blog-settings` (persistiti in `settings`, per-sito) ci sono due
template HTML:

| Chiave (`settings.key`) | Superficie | Placeholder disponibili |
|---|---|---|
| `blog_card_template` | ogni card delle **liste** (`{{articles:...}}`, indice blog, pagine categoria) | `{{title}}`, `{{excerpt}}`, `{{url}}`, `{{image}}`, `{{image_url}}`, `{{published_at}}`, `{{published_at_short}}`, `{{category_name}}`, `{{category_url}}`, `{{category_slug}}`, `{{category_icon}}`, `{{reading_time}}` |
| `blog_article_embed_template` | il **singolo articolo** (`{{article:...}}`) | `{{title}}`, `{{excerpt}}`, `{{content}}`, `{{image}}`, `{{image_url}}`, `{{published_at}}`, `{{published_at_short}}`, `{{category_name}}`, `{{category_url}}`, `{{category_slug}}`, `{{category_icon}}`, `{{reading_time}}` |

Trattamento dei placeholder (identico per entrambi i template, via
`renderCardTemplate`):

- **testo escapato**: `title`, `excerpt`, `published_at`, `published_at_short`,
  `category_name`, `category_url`, `category_slug`, `category_icon`,
  `reading_time`, `url`, `image_url` (l'URL nudo dell'immagine, escapato —
  usarlo quando `{{image}}` non basta, es. per un `<img>` con `alt`/`style`/
  attributi diversi dal blocco pronto).
- **blocchi HTML pronti, NON escapati**: `image` (un `<img src="...">` già
  completo, `alt` vuoto — scelta semplice per il caso comune) e `content`
  (solo per l'embed del singolo articolo — il corpo HTML completo e fidato
  dell'articolo).

`reading_time` è stimato automaticamente (parole del `content` / 200 parole al
minuto, minimo 1 — `estimateReadingTime` in `blog-index.js`), **ma può essere
sovrascritto per singolo articolo**: colonna `pages.reading_time_minutes`
(intero, NULL = usa la stima). Serve per chi vuole controllare esattamente il
valore mostrato (es. riprodurre un calcolo storico diverso dalla stima a
parole/minuto) senza dover approssimare l'algoritmo generico. Non ancora
esposto nell'editor admin delle pagine: impostabile oggi via aggiornamento
diretto della riga `pages` (stesso livello della API agente, nessun vincolo
di sicurezza aggiuntivo).

`title` (nelle **liste**, `{{articles:...}}`/indice blog/sezioni homepage)
usa **`pages.card_title` se impostato, altrimenti `pages.title`** — due
concetti distinti: `title` è spesso pensato per il tag `<title>` SEO della
pagina (può includere un suffisso, es. "... - NomeSito"), `card_title` è il
titolo breve pensato per essere mostrato in una card di lista. NULL (il
default) = nessuna differenza, le card usano semplicemente `title`.
**L'embed del singolo articolo (`{{article:...}}`) usa sempre `title`**, mai
`card_title`: lì si mostra la pagina intera, non una card di lista.

Ogni categoria (da `/admin/categories`) ha `color`, `icon` e `custom_css`.

- `custom_css`: quando nel blocco espanso compare **almeno un articolo** di una
  categoria con `custom_css` non vuoto, il CSS viene iniettato una sola volta
  come `<style>...</style>` **prima** dell'HTML generato (card, o articolo
  singolo). Nessun duplicato nella stessa combinazione.
- `data-category="<slug>"` **sul primo tag HTML** di ogni card: SOLO in
  `{{articles:...}}` con `enable_client_filter=true` (default `false`, §2) —
  utile per un filtro JS lato client che nasconde/mostra card della stessa
  lista in base alla categoria (es. `[data-category="viaggi"] { … }`). Non
  esiste per l'embed del singolo articolo (`{{article:...}}`): il filtraggio
  ha senso solo tra più card di una lista. Un sito che veicola già la
  categoria a modo suo (es. una classe scritta nel proprio
  `card_template_override`, come `class="tag {{category_slug}}"`) può
  semplicemente non attivare `enable_client_filter` e scrivere il proprio CSS
  su quella classe invece che sull'attributo.

## 7. Sicurezza / sanitizzazione

Il CSS di categoria e il contenuto HTML dell'articolo sono scritti dal
**proprietario del sito**: stesso livello di fiducia già esistente per il
`content` delle pagine e per `homepage_custom_css`/`homepage_custom_js` (§9.4):
**nessun nuovo confine di sicurezza**. Il proprietario del sito A scrive codice
per i visitatori del sito A, mai eseguito nel contesto di un altro sito/utente.

I soli valori **generati dinamicamente dal sistema** (titolo, excerpt, date,
slug nell'attributo `data-category`) passano **sempre** per
`renderCardTemplate`, che HTML-escapa tutto. Le uniche eccezioni sono i due
blocchi esplicitamente trattati come HTML fidato per costruzione — `image` e
`content` — che vengono passati al renderer tramite **token dedicati** e poi
ripristinati non escapati.

## 8. Esempi d'uso

```
{{articles:category=viaggi|date_from=2024-01-01|date_to=2024-06-30}}
```
Lista degli articoli della categoria `viaggi` pubblicati nel primo semestre
2024 (estremi inclusi).

```
{{articles:category=viaggi,cibo|limit=10}}
```
Lista combinata degli articoli di `viaggi` **e** `cibo`, i 10 più recenti.

```
{{articles:limit=3}}
```
Le 3 card più recenti di tutte le categorie.

```
{{article:/articoli/il-mio-pezzo}}
```
Embed completo di un singolo articolo (titolo, data e corpo HTML) dentro
un'altra pagina.

## 9. Nota sul modello dati

Gli articoli **vivono nella tabella `pages`** (`post_type='article'`,
`category_id`, `excerpt`, `featured_image`, `published_at`, `author_id` —
accanto alle colonne già esistenti `url_path`/`layout_mode`/`managed_by`/
`published`). **Non è stata introdotta una tabella `articles` separata**: i
campi "nudi" dell'articolo (titolo, contenuto, estratto, immagine, data,
categoria) sono già colonne dirette, distinguibili senza ambiguità da quelle
di presentazione, e gli indici utili a categoria/data esistono già
(`idx_pages_category_id`; `idx_pages_published_at` su `(site_id, published_at
DESC)` filtrato per articoli pubblicati — `db/155_blog_articles.sql`).
Separare la tabella aggiungerebbe complessità di sincronizzazione (doppia
scrittura, join aggiuntivo ovunque) senza risolvere nessun problema reale oggi
esistente.
