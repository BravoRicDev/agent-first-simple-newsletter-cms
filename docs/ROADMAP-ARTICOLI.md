# ROADMAP ARTICOLI/BLOG — piano di implementazione a prova di scemo

> Stato: **PIANIFICAZIONE, zero codice scritto**. Questo documento è l'unica fonte
> di verità per questa feature finché non viene aggiornato. Se un passo qui
> descritto risulta sbagliato una volta aperto il codice, **fermarsi e
> aggiornare questo file prima di continuare**, non improvvisare in corsa.

## 0. Decisioni già prese (non riaprire la discussione)

Confermate dall'utente il 2026-10-10, non sono più negoziabili senza una
nuova conversazione esplicita:

1. **Modello dati**: si estende la tabella `pages` esistente (NON una nuova
   entità `articles` separata). Motivo: riusa SEO (`page_seo`), versioning
   (`page_versions`), export statico, audit log, agent API — già scritti e
   testati per `pages`.
2. **Categorie**: **una sola categoria per articolo** (niente many-to-many,
   niente tabella ponte). URL categoria: `/blog/categoria/<slug>`, univoca.
3. **Migrazione contenuti reali**: **NON in questa fase**. Si costruisce
   prima tutta l'infrastruttura su un sito di test; la migrazione dei 302
   articoli di `neparliamoasettembre.it` e dei 355 di `vicchina.it` è un
   lavoro successivo, separato, con revisione umana obbligatoria (sono pagine
   scritte a mano, non tutte sono "articoli": `/newsletter`, pagine di
   servizio, ecc. — un backfill automatico sbaglierebbe).

### 0.4 Round aggiunto il 2026-10-10: compatibilità 100% `vicchina.it` + template configurabile da UI

Richiesta esplicita dell'utente, verificata a DB: **`vicchina.it` (site_id=7)
ha 355 pagine, TUTTE `layout_mode='standalone'`** (355/355, nessuna
`wrapped`), 353 pubblicate. **Nessuna di queste pagine deve cambiare
`url_path`, `content`, `layout_mode` o rendering in alcun modo** — la
migrazione è **esclusivamente un'aggiunta di metadati** (`post_type`,
`category_id`, `published_at`, eventualmente `excerpt`) su righe che
restano altrimenti bit-per-bit identiche. Questo era già implicito nel
design delle Fasi 1-6 (nessuna di esse tocca `content`/`layout_mode`/
`url_path`), ma va reso **esplicito e verificabile**, non lasciato per
deduzione. Vedi §7 per il piano di dettaglio di questo round.

**Conseguenza immediata sul design già scritto in questo documento**: la
Fase 5 (template articolo, breadcrumb) presumeva un impatto sul rendering
della pagina articolo stessa. **Per `vicchina.it` questo non è applicabile:
una pagina standalone è già HTML completo scritto a mano, non esiste un
"intorno" in cui inserire breadcrumb/meta senza modificare il contenuto**.
Il template configurabile (§7) si applica quindi SOLO a due superfici che
NON sono le pagine articolo stesse: (a) la card nell'indice/categoria blog
(contenuto nuovo, generato da `syncBlogListingPages`, non tocca l'articolo),
(b) opzionalmente, in futuro, un header/breadcrumb per articoli NUOVI creati
con `layout_mode='wrapped'` — mai retroattivo sulle pagine esistenti.

### 0.5 Risposte dell'utente alle 5 domande del round finale (2026-10-10)

Risolte le ultime condizioni aperte del documento. Dettaglio completo di
ciascuna nella sezione referenziata, qui solo il verdetto:

1. **JSON-LD `BlogPosting` sulle standalone migrate (era §7.4)**: SÌ,
   applicarlo — ma solo dopo un backup del sito e una verifica esplicita
   che il risultato **lato client** (ciò che un visitatore vede/ottiene nel
   browser) resti identico. Dettaglio e protocollo in §7.4 (aggiornato).
2. **Pubblicazione agente → homepage live**: previsto uno stato "in attesa
   di approvazione" — **anche un agente (un "revisore di bozze" dedicato)
   può approvare**, non solo un umano. Nuovo design in §8.7.
3. **Homepage dinamica per `vicchina.it`**: SÌ, è l'obiettivo reale, non
   solo un pattern generico — ma solo dopo backup + verifica in un
   container di test, e si considera "fatto" **solo quando l'output della
   pagina dinamica è esattamente identico a quello attuale**. Protocollo
   in §9.9 (nuovo).
4. **Categorizzazione assistita da agente per i 355/302 articoli reali**:
   confermato che serve, pianificato come round futuro separato — §12
   (nuovo, solo annunciato, non ancora dettagliato: richiederà un giro di
   pianificazione dedicato quando si arriva a quel punto).
5. **Procedere con un altro giro di pianificazione** (questo), non ancora
   con l'implementazione.

## 1. Scoperta architetturale cruciale (letta nel codice, non ipotizzata)

**`static-export.js` esporta un file HTML per ogni riga della tabella
`pages` pubblicata** (`exportPage()` → `urlPathToFilename(page.url_path)` →
un file). Non esiste alcun concetto di "pagina virtuale" generata da una
query. `cleanupOrphanedFiles()` cancella qualsiasi `.html` sul disco che non
corrisponda a una riga pubblicata in `pages`. `getPublishedPagesForSitemap()`
(usata per sitemap.xml e llms.txt) legge semplicemente `pages`.

**Conseguenza di design (il cuore di questa roadmap)**: le pagine
"automatiche" del blog — indice `/blog`, paginazione `/blog/pagina/2`,
categoria `/blog/categoria/<slug>` e sua paginazione — **devono essere righe
reali nella tabella `pages`**, con `content` HTML pre-renderizzato (le card
degli articoli) scritto da un servizio dedicato ogni volta che qualcosa negli
articoli cambia. **NON** si scrive un sistema di export parallelo per
"pagine virtuali": si riusa al 100% `exportPage`, `cleanupOrphanedFiles`,
`getPublishedPagesForSitemap`, `generate404Page`, tutto l'export esistente,
perché quelle righe sono `pages` normali agli occhi di quel codice.

Questo è il motivo per cui **`src/services/static-export.js` non va quasi
toccato** (una sola aggiunta isolata per il feed RSS, vedi Fase 5) — tutto il
resto del lavoro è: scrivere le righe giuste in `pages` con il `content`
giusto, al momento giusto, e lasciare che l'export esistente faccia il resto.

Le pagine-indice generate vanno marcate per distinguerle dalle pagine scritte
a mano (serve per non farle apparire editabili a mano nell'editor, e per
poterle ritrovare/cancellare quando non servono più): colonna
`pages.managed_by` (vedi Fase 1).

## 2. Modello dati — schema esatto

### 2.1 Nuova tabella `categories`

```sql
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_categories_site_id ON categories(site_id);
```

Nota: NON riusare la tabella `tags` (`db/143_tags_folders.sql`) — è il
sistema di tag dei **contatti CRM**, dominio completamente diverso. Non
toccarla, non fare join con essa.

### 2.2 Estensione `pages`

```sql
-- Decisione di design (seconda revisione di questo documento): post_type ha
-- SOLO 2 valori, 'page' e 'article'. Le pagine indice/categoria generate
-- dal blog restano post_type='page' (sono pagine di navigazione, non
-- articoli) e si distinguono ESCLUSIVAMENTE tramite managed_by (sotto).
-- Un solo segnale ("managed_by IS NOT NULL" = generata dal sistema, non
-- editabile a mano) invece di due segnali che dovrebbero restare sincronizzati
-- (post_type E managed_by) — meno superficie per un bug di disallineamento.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS post_type VARCHAR(20) NOT NULL DEFAULT 'page'
  CHECK (post_type IN ('page', 'article'));
ALTER TABLE pages ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS excerpt TEXT NOT NULL DEFAULT '';
ALTER TABLE pages ADD COLUMN IF NOT EXISTS featured_image TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS author_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
-- Pagine generate automaticamente da syncBlogListingPages (indice/categoria):
-- NULL = pagina scritta a mano (comportamento attuale, intatto, il 100% dei
-- casi oggi). Valore 'blog_index' o 'blog_category:<category_id>' se generata.
-- MAI scritto da un endpoint pubblico/agent — solo da syncBlogListingPages.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS managed_by VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_pages_post_type ON pages(site_id, post_type);
CREATE INDEX IF NOT EXISTS idx_pages_category_id ON pages(category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pages_managed_by ON pages(site_id, managed_by) WHERE managed_by IS NOT NULL;
-- published_at: ordinamento principale del blog (NON created_at, che è
-- tecnico/non editabile dall'utente oggi).
CREATE INDEX IF NOT EXISTS idx_pages_published_at ON pages(site_id, published_at DESC) WHERE post_type = 'article' AND published = true;
```

**IMPORTANTE — valore di default per righe esistenti**: `post_type` default
`'page'` significa che TUTTE le 302+355+altre pagine esistenti di TUTTI i
siti restano `post_type='page'` automaticamente, **zero comportamento
cambiato per loro**. Nessun backfill in questa migrazione. Questo è
intenzionale (vedi §0.3).

### 2.3 Estensione `page_versions` (obbligatoria, spesso dimenticata)

Il versioning attuale (`page_versions`) NON salva `category_id`, `excerpt`,
`featured_image`, `published_at`. Se non si estende anche questa tabella,
**il restore di una versione precedente di un articolo cancella
silenziosamente categoria/excerpt/immagine** (torna a NULL perché la colonna
non esiste nella riga di versione). Questo è un bug facile da introdurre e
facile da non notare in test superficiali — va coperto esplicitamente da un
test (Fase 2).

```sql
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS post_type VARCHAR(20) NOT NULL DEFAULT 'page';
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS category_id INTEGER;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS excerpt TEXT NOT NULL DEFAULT '';
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS featured_image TEXT;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
```

Nessuna FK su `category_id` qui (una versione vecchia può riferire una
categoria già cancellata — deve restare un numero "storico", non bloccare
l'INSERT con un vincolo).

### 2.4 Numero migrazione

Ultima esistente ad oggi: `154_agent_tasks_queue.sql`. **Verificare con `ls
db/ | sort -t_ -k1 -n | tail -3` immediatamente prima di scrivere il file**
— altre migrazioni potrebbero essere arrivate nel frattempo da altre
sessioni. Non assumere "155" per certo: controllare sempre.

Nome file proposto: `155_blog_articles.sql` (contiene 2.1+2.2+2.3 in un solo
file, è tutto correlato e idempotente — stesso stile delle migrazioni
esistenti, `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`).

## 3. File da toccare — lista esaustiva, per fase

### Fase 1 — Migrazione DB + categorie (nessun impatto sul sito pubblico)

| File | Azione |
|---|---|
| `db/155_blog_articles.sql` (o numero corretto verificato) | **Nuovo**. Contenuto: §2.1 + §2.2 + §2.3 |
| `src/routes/categories.js` | **Nuovo**. CRUD `/admin/categories` (list/new/edit/delete), stesso pattern di `src/routes/pages.js` (vedi §4.1 per dettaglio ownership/IDOR) |
| `views/admin/categories/index.ejs`, `new.ejs`, `edit.ejs` | **Nuovi**. Stesso stile di `views/admin/pages/*.ejs` |
| `src/index.js` | Verificato: l'import è `import pagesRoutes from "./routes/pages.js"` (riga 23) e il mount è `app.use(pagesRoutes)` (riga 312). Aggiungere `import categoriesRoutes from "./routes/categories.js"` subito dopo la riga 23, e `app.use(categoriesRoutes)` subito dopo la riga 312 |
| `views/layouts/admin.ejs` | Verificato: la sidebar (righe 45-57) usa `<a href="/admin/pages"><%= t('nav.pages') %></a>` — stesso pattern. Aggiungere `<a href="/admin/categories<%= user && user.site_id ? '?site_id=' + user.site_id : '' %>"><%= t('nav.categories') %></a>` subito dopo la riga della voce "Pagine" |
| `locales/it.json` **e** `locales/en.json` | Aggiungere la chiave `nav.categories` in **entrambi** i file (verificato: `nav.pages` esiste in entrambi con lo stesso schema a punti, es. `nav.pages = "Pagine"` in it.json). **Regola generale per tutte le fasi**: qualunque nuova stringa passata a `res.locals.t(...)` o `t(...)` nelle view va aggiunta in ENTRAMBI i file locale, mai uno solo — altrimenti l'interfaccia in inglese mostra la chiave grezza invece del testo |
| `test/categories.test.js` | **Nuovo**. CRUD + ownership (IDOR: utente non-superadmin non deve poter leggere/modificare categorie di un altro sito) + unicità slug per sito. Per evitare dipendenza fragile dal markup EJS, usare lo stesso trick già adottato in questa sessione (`test/admin-agent-token-scopes.test.js`): `app.use((req,res,next)=>{res.render=(view,locals)=>res.json(locals);next();})` prima di montare il router, così si asserisce sui `locals` passati a `res.render`, non sull'HTML |

**Verifica di fine fase**: `npm test` verde, nessuna pagina pubblica
cambiata (nessun sito ha ancora articoli, quindi zero impatto visibile).

### Fase 2 — Campi articolo nell'editor esistente

| File | Azione |
|---|---|
| `src/routes/pages.js` | `pageSchema` (riga 25-31): aggiungere campi opzionali `post_type`, `category_id`, `excerpt`, `featured_image`, `published_at`, **`author_id`** (quest'ultimo elencato anche in Fase 5 per la UI, va incluso nello schema qui). `POST /admin/pages` (riga 73-95) e `POST /admin/pages/:id` (riga 197-305): leggere e salvare questi campi nell'INSERT/UPDATE. **Tutte le 3 occorrenze di `INSERT INTO page_versions`** (righe 231-235, 364-367, 403-406) e la query di restore (righe 516-533): estendere per includere i nuovi campi — altrimenti si riproduce esattamente il bug descritto in §2.3 |
| `views/admin/pages/edit.ejs` | Aggiungere sezione "Articolo" (visibile solo se `post_type === 'article'`, con un toggle per impostarlo): select categoria (popolata da `categories` del sito), campo excerpt (textarea breve), campo `featured_image` (**verificato: NON esiste alcun componente "media-picker" nell'admin** — `og_image`, riga 110 di questo file, è un semplice `<input type="text">` con placeholder `"https://... oppure /media/..."`; `featured_image` va fatto identico, un `<input type="text">`, con eventualmente un link `<a href="/admin/media..." target="_blank">Apri libreria media</a>` a fianco per copiare l'URL — **non inventare/costruire un widget di selezione**, sarebbe scope creep), date-picker `published_at`. **Aggiunto dal round §8.7 (review_status non esisteva ancora quando questa riga è stata scritta)**: se `review_status IS NOT NULL`, mostrare un badge di stato ("In attesa di approvazione"/"Rifiutato"/"Approvato") + un checkbox "mantieni in rifiuto" (visibile solo se `review_status='rejected'`) — necessario per il comportamento descritto in §8.7 (salvare da admin un articolo pending/rejected lo approva implicitamente, a meno che il checkbox non sia spuntato) |
| `views/admin/pages/new.ejs` | **SUPERATO da §9.6** — non implementare questo toggle: l'utente ha chiesto esplicitamente un entry point dedicato "Nuovo articolo" separato da "Nuova pagina", non un'opzione nascosta qui. Questa riga resta solo come traccia storica del piano iniziale, vedi §9.6 per il piano definitivo |
| `views/admin/pages/index.ejs` | Aggiungere colonna/filtro "Tipo" (pagina/articolo) e "Categoria" nella lista; filtro per categoria nella query string (`?post_type=article&category_id=N`) |
| `src/routes/pages.js` → `GET /admin/pages` (riga 33-61) | Estendere la `SELECT` e il filtro per includere `post_type`/`category_id` quando presenti in query string |
| `test/pages-articles-fields.test.js` | **Nuovo**. Create/update con i nuovi campi; verifica che il restore di una versione precedente ripristini correttamente categoria/excerpt/immagine (il test che blinda il bug di §2.3); `published=true` senza `published_at` esplicito → il server imposta `published_at` a un timestamp recente (§4.6); `published=true` CON `published_at` esplicito → quel valore resta esattamente quello fornito, non sovrascritto |

**NON toccare in questa fase**: `src/routes/serve.js`, `src/services/
static-export.js` — i nuovi campi non influenzano ancora il rendering
pubblico (un articolo con `post_type='article'` oggi si vede identico a una
pagina normale finché non arriva la Fase 4).

### Fase 3 — Motore di sincronizzazione indice/categoria (il cuore del lavoro)

Nuovo file: `src/services/blog-index.js`.

Funzione principale: `export async function syncBlogListingPages(siteId)`.

**Logica esatta** (passo-passo, per non lasciare ambiguità):

1. Leggere la configurazione: quanti articoli per pagina (vedi §3.1,
   impostazione per-sito con default, es. 10).
2. `SELECT id, title, excerpt, featured_image, published_at, url_path,
   category_id, content FROM pages WHERE site_id=$1 AND post_type='article'
   AND published=true AND (review_status IS NULL OR review_status='approved')
   ORDER BY published_at DESC NULLS LAST, id DESC`. **`content` nella
   SELECT è per il fallback excerpt del punto 2bis sotto** — serve solo in
   RAM per generare la card, non viene mai scritto da nessuna parte.
   **Il filtro `review_status` è stato aggiunto in §8.7** (round successivo a questa
   fase): una bozza creata da agente in attesa di approvazione non deve
   mai comparire nell'indice/categoria, anche se `published=true`.
2bis. **Lacuna trovata in questo giro: non era mai definito cosa mostra
   la card quando `excerpt` è vuoto** — caso tutt'altro che raro: dato
   reale verificato su `vicchina.it`, solo 12 dei 353 articoli pubblicati
   hanno un `meta_description` compilato (3.4%), ed `excerpt` di per sé
   è sempre `''` per ogni riga non ancora editata a mano dopo la
   migrazione (default di colonna, §2.2). Senza un fallback, le card
   dell'indice mostrerebbero un paragrafo vuoto per il 96%+ degli
   articoli migrati — un indice blog con card senza alcun testo
   sarebbe un risultato inaccettabile per questo round. **Fix**: in
   `renderArticleCard(page)`, se `page.excerpt` è vuoto, derivare un
   excerpt al volo da `page.content` (mai scritto su `pages.excerpt`,
   solo usato per questo render — resta sempre aggiornato se il
   contenuto cambia, a differenza di un valore salvato una volta e poi
   stantio). Funzione dedicata e piccola, duplicata (non importata) da
   `extractTextFromHtml` di `src/services/ingest.js` (quella funzione è
   privata al modulo, non esportata, e appartiene a un domino diverso —
   import URL esterni — stessa motivazione già usata altrove in questo
   documento per non accoppiare moduli di domini diversi):
   ```js
   function deriveExcerptFromContent(html, maxLen = 200) {
     const text = String(html || "")
       .replace(/<script[\s\S]*?<\/script>/gi, "")
       .replace(/<style[\s\S]*?<\/style>/gi, "")
       .replace(/<[^>]+>/g, " ")
       .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
       .replace(/\s{2,}/g, " ").trim();
     if (text.length <= maxLen) return text;
     // Tronca all'ultimo spazio prima del limite, mai a metà parola.
     const cut = text.slice(0, maxLen);
     const lastSpace = cut.lastIndexOf(" ");
     return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "…";
   }
   ```
   Risultato passato a `renderCardTemplate` esattamente come un `excerpt`
   normale (stesso escaping HTML già previsto in §7.2, nessun trattamento
   speciale a valle). **Stesso fallback va applicato in §9.3 e §10.3** —
   coerenza con tutte le altre superfici che mostrano card, stesso schema
   già visto più volte in questo documento per il filtro `review_status`.
3. Calcolare `totalPages = Math.ceil(count / perPage)` per l'indice globale.
   Se `count === 0`, **non creare alcuna pagina indice** (vedi punto 6).
4. Per ogni pagina `1..totalPages`: calcolare lo slice di articoli,
   renderizzare l'HTML delle card (template interno a questo file, non EJS —
   vedi nota sotto). **PRIMA di scrivere, controllare se esiste già una riga
   `pages` con quel `url_path` per questo sito CON `managed_by IS NULL`**
   (cioè una pagina scritta a mano da un umano, non da questo motore): se
   esiste, **non sovrascriverla** — loggare un errore (`logger.error`, non
   silenzioso) con url_path e site_id, saltare quella specifica pagina di
   listing, continuare con le altre. Questo copre il caso (plausibile: molti
   siti hanno già pagine manuali, un sito potrebbe già avere una pagina
   `/blog` scritta a mano prima che questa feature esista) in cui attivare
   il blog altrimenti **cancellerebbe silenziosamente contenuto umano**
   tramite lo UPSERT del punto successivo. Se non esiste, o esiste già con
   `managed_by` non NULL (quindi è già nostra da un giro precedente),
   procedere con l'**UPSERT**:
   - `url_path`: `/blog` per pagina 1, `/blog/pagina/N` per N≥2.
   - `post_type = 'page'`, `managed_by = 'blog_index'`,
     `layout_mode = 'wrapped'`, `published = true` (sempre pubblicata finché
     esiste: non ha senso un indice blog "in bozza", è una pagina derivata,
     non editoriale).
   - `content` = HTML generato ora.
   - `title` = "Blog" (pagina 1) o "Blog — pagina N".
   - `ON CONFLICT (site_id, url_path) DO UPDATE SET content=EXCLUDED.content,
     title=EXCLUDED.title, updated_at=NOW()` — **riusa il vincolo UNIQUE
     (site_id, url_path) già esistente su `pages`**, nessun nuovo vincolo
     necessario.
5. Stessa logica del punto 3-4 (incluso il controllo anti-sovrascrittura)
   **per ogni categoria che ha almeno un articolo pubblicato**: `url_path =
   /blog/categoria/<slug>` (pagina 1), `/blog/categoria/<slug>/pagina/N`,
   `managed_by = 'blog_category:<id categoria>'`.
6. **Pulizia**: dopo aver scritto/aggiornato tutte le righe necessarie,
   cancellare le righe `pages` con `managed_by` che punta a questo sito e
   che **non sono state appena scritte in questo giro** (es. una categoria
   che non ha più articoli pubblicati, o una pagina di paginazione 3 che non
   serve più perché gli articoli sono scesi sotto soglia). Pattern SQL:
   raccogliere in un array JS gli `id` scritti/aggiornati al passo 4-5, poi
   `DELETE FROM pages WHERE site_id=$1 AND managed_by IS NOT NULL AND id !=
   ALL($2::int[])`. **Questo DELETE fa sì che `cleanupOrphanedFiles` (già
   esistente in static-export.js, NON modificato) cancelli da solo il file
   statico orfano al prossimo export** — non serve scrivere logica di
   cancellazione file qui.
7. La funzione **non chiama `exportPublishedPages` da sola** — è compito del
   chiamante (Fase 4, i punti di innesco in `pages.js`) farlo DOPO aver
   chiamato `syncBlogListingPages`, così un solo export esporta sia gli
   articoli che gli indici aggiornati nello stesso giro.
8. La funzione deve essere **idempotente e sicura da chiamare a vuoto** (sito
   senza nessun articolo): deve limitarsi a cancellare eventuali righe
   `managed_by` residue (caso: l'unico articolo del sito viene cancellato) e
   ritornare, senza errori.
9. **Cambio di categoria di un articolo — nessuna logica ad hoc necessaria**:
   la funzione è **stateless**, ricalcola sempre tutto da zero leggendo lo
   stato attuale del DB al punto 2. Se un articolo passa dalla categoria A
   alla B, la chiamata successiva a `syncBlogListingPages` scrive/aggiorna
   la pagina categoria B (ora lo contiene) e, se A non ha più altri
   articoli, la riga categoria A viene naturalmente cancellata al punto 6.
   **Non scrivere un "diff" tra vecchia e nuova categoria — è uno spreco di
   complessità, il ricalcolo completo lo fa già gratis.**

**Nota sul rendering delle card — AGGIORNATA dal round di §7**: non è più un
template JS hardcoded come ipotizzato nella prima stesura. Il template della
card (e dell'intro dell'indice/categoria) è **configurabile da UI per sito**
(§7.2) e caricato da `blog-settings.js` prima di generare l'HTML. Resta
valido: il risultato è salvato come `pages.content` con `layout_mode=
'wrapped'`, passato attraverso il layout del sito esattamente come qualsiasi
altra pagina wrapped — zero codice nuovo in `serve.js`/`static-export.js`
per questo.

| File | Azione |
|---|---|
| `src/services/blog-index.js` | **Nuovo**. `syncBlogListingPages(siteId)` come sopra, più un helper interno `renderArticleCard(page)`, `renderPaginationNav(currentPage, totalPages, basePath)` e **`export function deriveExcerptFromContent(html, maxLen=200)`** (punto 2bis — esportata, riusata da §9.3/§10.3) |
| **ATTENZIONE — NON usare `src/services/settings.js`** | Verificato: quel file (`loadSettings`/`getSetting`/`setSetting`) è una cache in-process **esclusivamente per i settings GLOBALI** (`WHERE site_id IS NULL` — riga 6 e 19 del file), usata per impostazioni cross-sito. **Non è quello che serve qui e usarlo per un valore per-sito sarebbe un bug silenzioso** (il valore di un sito sovrascriverebbe quello di tutti gli altri nella stessa cache). Per `blog_articles_per_page` (per-sito), copiare invece il pattern già usato da `src/services/site-seo.js` (`getSiteSeoConfig`/`setSiteSeoConfig`, righe 20-45): query diretta su `settings` con `WHERE site_id = $1 AND key = ANY($2)`, nessun file nuovo necessario — una funzione in più dentro `blog-index.js` stesso, o un piccolo add-on a `site-seo.js` se si preferisce centralizzare lì. Default 10 se la chiave non è impostata |
| `test/blog-index-sync.test.js` | **Nuovo**. Casi: 0 articoli → nessuna riga indice; N articoli < perPage → 1 sola pagina indice, nessuna `/blog/pagina/2`; N articoli > perPage → pagine corrette; articolo spubblicato → esce dall'indice e dalla sua categoria; categoria senza più articoli → la sua riga viene cancellata (verificare con una query diretta che la riga non esiste più in `pages`, NON solo che l'HTML non la contenga); chiamata a vuoto su sito senza articoli non lancia eccezioni; articolo cambia categoria da A a B → compare in B, e se A resta senza altri articoli la sua riga viene cancellata (§3 punto 9); **pagina `/blog` scritta a mano (`managed_by NULL`) non viene mai sovrascritta dalla sync** (§4.5, il test più importante di questo file); articolo con `excerpt=''` → card con testo derivato da `content` (troncato a 200 caratteri, mai a metà parola — il test che blinda il fallback di 2bis); articolo con `excerpt` compilato → quello vince, nessuna derivazione |

### Fase 4 — Innesco della sincronizzazione sui punti di mutazione

**File da toccare, riga per riga, in `src/routes/pages.js`** (il file letto
per intero in questa sessione, i numeri di riga sono quelli ATTUALI — **da
riverificare con `grep -n` prima di editare**, potrebbero essere shiftati
dalla Fase 2):

| Punto | Riga (prima della Fase 2) | Cosa aggiungere |
|---|---|---|
| `POST /admin/pages` (creazione) | dopo riga 86 (INSERT), prima della riga 88 (`exportPublishedPages`) | `if (data.post_type === 'article') await syncBlogListingPages(siteId).catch(() => {});` |
| `POST /admin/pages/:id` (update) | dopo riga 226 (UPDATE), prima della riga 298 (`exportPublishedPages`) | stesso pattern — **attenzione**: va chiamato anche se l'articolo **cambia categoria** o **viene spubblicato da qui** (il campo `published` è nello stesso form), quindi la condizione giusta è "era O è un articolo", non solo "è un articolo adesso": `if (data.post_type === 'article' || page.post_type === 'article')` |
| `POST /admin/pages/:id/publish-toggle` (riga 307-330) | dopo riga 322 (UPDATE published), prima di riga 324-328 | leggere anche `post_type` nella SELECT di riga 309, poi `if (existing.post_type === 'article') await syncBlogListingPages(existing.site_id).catch(() => {});` prima del branch export/delete |
| `POST /admin/pages/:id/delete` (riga 462-480) | dopo riga 470 (DELETE), prima di riga 478 | leggere `post_type` nella SELECT di riga 464, poi sync se era un articolo |
| `POST /admin/pages/:id/versions/:versionId/restore` (riga 503-538) | dopo riga 533 (UPDATE da versione), prima di riga 536 | sync incondizionato (la versione ripristinata potrebbe essere passata da articolo a pagina o viceversa — più semplice chiamare sempre sync qui, costo trascurabile su un singolo restore) |

**Import da aggiungere in testa a `src/routes/pages.js`**:
```js
import { syncBlogListingPages } from "../services/blog-index.js";
```

**NON toccare**: `inline-to-files` (riga 332-376) e `extract-assets` (riga
378-460) — modificano solo il body HTML di un articolo già pubblicato, non
title/excerpt/categoria/published_at, quindi non serve ri-sincronizzare le
card dell'indice (motivato in §1 dell'analisi iniziale).

**File agent API da toccare** (`src/routes/agent.js`):

| Endpoint | Azione |
|---|---|
| `agentPageSchema` (riga 625) | Aggiungere gli stessi campi opzionali di `pageSchema` in pages.js (§Fase 2) |
| `POST /api/agent/sites/:siteId/pages` (riga 634) | Salvare i nuovi campi nell'INSERT (riga ~649-653); chiamare `syncBlogListingPages` se `post_type==='article'` prima della riga `exportPublishedPages({siteId, pageIds:[page.id]}).catch(()=>{})` — **attenzione**: qui l'export è per singolo `pageId`, mentre il sync scrive/aggiorna ANCHE le righe indice: va chiamato `exportPublishedPages({siteId})` **senza** filtro `pageIds` dopo il sync (altrimenti le righe indice aggiornate non vengono ri-esportate) |
| `PUT /api/agent/sites/:siteId/pages/:pageId` (riga ~695+) | Stesso trattamento di `POST /admin/pages/:id` sopra |

**Aggiornamento dal round §8**: l'endpoint `GET /api/agent/sites/:siteId/
categories` (qui indicato inizialmente come facoltativo) **è diventato
necessario**, non più rimandabile — è il modo in cui l'agente scopre quali
categorie esistono prima di creare un articolo "senza fare casino" (§8.2).
Dettaglio completo in §8.

**Verificato — non esiste alcun `DELETE /api/agent/sites/:siteId/pages/:pageId`**
oggi (grep esplicito su `src/routes/agent.js`, nessun match): niente da
trattare lì. Se in futuro verrà aggiunto un delete lato agent, andrà
replicato lo stesso trattamento del delete admin (sync + export), ma non è
lavoro di questa roadmap.

**`agentPageSchema` verificato** (righe 625-632 di `src/routes/agent.js`):
```js
const agentPageSchema = z.object({
  url_path: z.string().min(1),
  title: z.string().optional().default(""),
  content: z.string().optional().default(""),
  layout_mode: z.enum(["standalone", "wrapped"]).optional().default("wrapped"),
  published: z.boolean().optional().default(false),
  publish_at: z.string().datetime({ offset: true }).nullable().optional(),
});
```
Da estendere con: `post_type: z.enum(["page","article"]).optional().default("page")`
(coerente con il CHECK a 2 valori di §2.2 — `managed_by` **non va mai
aggiunto a questo schema zod**: resta un campo scrivibile solo da
`syncBlogListingPages`, mai da un body esterno. Nota a margine: anche senza
questa precauzione esplicita, `z.object()` di default scarta silenziosamente
le chiavi non dichiarate nello schema — ma non fare affidamento solo su
questo comportamento implicito, dichiararlo esplicitamente qui per chi
legge il codice in futuro), `category_id:
z.number().int().positive().nullable().optional()`, `excerpt:
z.string().optional().default("")`, `featured_image:
z.string().optional().nullable()`, `published_at:
z.string().datetime({offset:true}).nullable().optional()`.

### Fase 5 — Rendering pubblico: template articolo, breadcrumb, JSON-LD, RSS

**CORREZIONE IMPORTANTE trovata in un giro di verifica successivo**: la
prima stesura di questa fase presumeva di dover scrivere una nuova
`buildBlogPostingJsonLd` da zero. **Verificato ora, non ipotizzato**:
`src/services/seo.js` contiene **già** due funzioni pronte, scritte in un
lavoro precedente non legato a questa roadmap e **oggi non usate da
nessuna parte del codice** (`grep -rn` conferma zero chiamate a entrambe):

```js
// già presente, riga 104 di seo.js
export function buildArticleJsonLd({ headline, description, url, image, datePublished, dateModified, authorName, publisherName }) {
  const jsonld = { "@context": "https://schema.org", "@type": "Article", headline, url };
  if (description) jsonld.description = description;
  if (image) jsonld.image = image;
  if (datePublished) jsonld.datePublished = datePublished;
  if (dateModified) jsonld.dateModified = dateModified;
  if (authorName) jsonld.author = { "@type": "Organization", name: authorName };
  if (publisherName) jsonld.publisher = { "@type": "Organization", name: publisherName };
  return jsonld;
}

// già presente, riga 125 di seo.js — BreadcrumbList generato dal path URL
export function buildBreadcrumbJsonLd({ baseUrl, urlPath, pageTitle }) { /* ... */ }
```

**Non scrivere `buildBlogPostingJsonLd`: riusare `buildArticleJsonLd`
com'è.** `@type: "Article"` è semanticamente corretto e accettato da Google
Rich Results al pari di `BlogPosting` (`BlogPosting` è una sottoclasse più
specifica, ma `Article` è già valido e richiede zero modifiche a codice
esistente — il minimo intervento possibile, coerente con "surgical
patching"). Risparmia l'intera riga 392 originale di questo piano.

**`buildBreadcrumbJsonLd` NON è riusabile tale e quale per un articolo con
URL piatto** (es. `vicchina.it`, `/slang-lavoro-genz-cina-2026` — nessun
prefisso `/blog/categoria/...` nel path reale, per design di §0.4/§7.1: la
migrazione non cambia gli `url_path`). La funzione deriva i livelli del
breadcrumb SPEZZANDO l'`url_path` sui `/` — su un path piatto produrrebbe
un breadcrumb a 2 soli livelli ("Home > slang lavoro genz cina 2026"),
perdendo il livello categoria che invece esiste concettualmente (`category_id`
della riga, non nel path). **Per un articolo, costruire l'array
`itemListElement` a mano** (non chiamare `buildBreadcrumbJsonLd` per gli
articoli, resta valida/riusabile solo per le pagine normali il cui path
rispecchia la gerarchia reale — es. le pagine `/blog`, `/blog/categoria/
<slug>` stesse, generate da `syncBlogListingPages`, per QUELLE la funzione
esistente va benissimo):
```js
function buildArticleBreadcrumbJsonLd({ baseUrl, article, category }) {
  const base = baseUrl.replace(/\/$/, "");
  const items = [
    { "@type": "ListItem", position: 1, name: "Home", item: base },
    { "@type": "ListItem", position: 2, name: "Blog", item: base + "/blog" },
  ];
  if (category) {
    items.push({ "@type": "ListItem", position: 3, name: category.name, item: base + "/blog/categoria/" + category.slug });
  }
  items.push({ "@type": "ListItem", position: items.length + 1, name: article.title, item: base + article.url_path });
  return { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items };
}
```
(funzione nuova, piccola, in `seo.js` — l'URL dell'ultimo elemento è
sempre quello reale della pagina, mai inventato).

**`author_id` — lacuna trovata: definito nello schema (§2.2) ma mai usato
da nessuna parte di questo documento prima di questa correzione.**
`buildArticleJsonLd.authorName` produce sempre `"@type": "Organization"`
(scelta già presente nel codice esistente, deliberata per un CMS
multi-tenant dove il default sicuro è "il brand è l'autore", non una
persona) — usarla direttamente con il nome di una persona (`users.name`)
produrrebbe uno schema.org semanticamente sbagliato (`Organization` con
nome di persona). **Fix minimo, additivo, non invasivo**: estendere
`buildArticleJsonLd` con un parametro opzionale `authorType` (default
`"Organization"`, **comportamento identico per qualunque chiamante
esistente/futuro che non lo passa** — zero rischio di regressione):
```js
export function buildArticleJsonLd({ ..., authorName, authorType = "Organization", publisherName }) {
  // ...
  if (authorName) jsonld.author = { "@type": authorType, name: authorName };
  // ...
}
```
Risoluzione di `authorName`/`authorType` per un articolo: se
`article.author_id` è impostato, `authorName = users.name` (query join),
`authorType = "Person"`; altrimenti `authorName = brandName` (già
disponibile come `themeVars.brandName`, Fase 3/§7.2), `authorType`
omesso (default `"Organization"`, comportamento di oggi).
**`author_id` lato UI**: select popolato con gli utenti del sito.
**Verificato, query esatta già in uso**: `src/routes/admin-crm.js` riga
451 fa esattamente `SELECT id, name, email FROM users WHERE site_id = $1
OR role = 'superadmin' ORDER BY name` per lo stesso scopo (popolare un
select di utenti assegnabili per un sito, incluso il superadmin che non
ha un `site_id` proprio) — riusare la stessa query (senza `email`, non
serve qui) in `views/admin/pages/edit.ejs`, sezione "Articolo" (§Fase 2);
default alla creazione: l'utente che sta creando l'articolo
(`req.user.sub`), sovrascrivibile. **Byline pubblica**: il
`blog_card_template`/template articolo può opzionalmente includere
`{{author_name}}` tra i placeholder di §7.2 (escapato come testo, stesso
trattamento di `title`/`excerpt`) — mostrare "di <nome>" solo se
`author_id` è impostato, altrimenti omettere la riga (nessun "di" seguito
dal nome del brand, sarebbe ridondante col footer del sito).

**Lacuna CRITICA trovata in questo giro — `og:type` è sempre `"website"`,
anche per un articolo, in ENTRAMBI i percorsi di rendering**. Verificato:
`views/partials/seo-meta.ejs` (riga 12, usata dalle pagine `wrapped`) ha
`<meta property="og:type" content="website">` **scritto letterale, non
condizionale**. `injectSeoIntoStandalone` (`src/services/seo.js`, riga 301,
usata dalle pagine `standalone`) fa lo stesso: `upsert(metaPropRe("og:type"),
'<meta property="og:type" content="website">')` — e **`upsert`
SOVRASCRIVE il tag se esiste già**, non lo lascia stare. Entrambi i percorsi
verificati nel codice reale (seo-meta.ejs riga 12 letterale, seo.js riga 301
in `injectSeoIntoStandalone`).

**Prova concreta sui dati reali**: un articolo di `vicchina.it` (site_id=7,
355 pagine totali, tutte standalone, 353 pubblicate — numeri confermati su
DB) ha **già**, scritto a mano nel suo HTML, `<meta property="og:type"
content="article">` — verificato con query diretta su colonna `content` del DB
(id=392, `/slang-cinese-internet-...`). Oggi, ad ogni export statico, questo
tag viene **silenziosamente sovrascritto a `"website"`** dalla pipeline
esistente (un bug pre-esistente, non introdotto da questa roadmap,
indipendente da essa — ma scoperto verificando i dati reali in preparazione
di questa fase). Le anteprime di condivisione social (Facebook/LinkedIn) di
quell'articolo perdono quindi il rendering "Article" (data di pubblicazione,
autore) che l'HTML scritto a mano intendeva ottenere. Questo fix è un
prerequisito per Fase 5.

**Fix, stesso pattern additivo di `authorType` sopra**: `seo-meta.ejs`
diventa `<meta property="og:type" content="<%= (typeof ogType !==
'undefined' && ogType) ? ogType : 'website' %>">` (default identico a
oggi se nessun chiamante passa `ogType`); `injectSeoIntoStandalone`
riceve `seoLocals.ogType` con lo stesso default. `serve.js`/
`static-export.js` passano `ogType: 'article'` quando `page.post_type
==='article'`, altrimenti omesso (comportamento di oggi, invariato per
tutte le pagine normali).

**Questo è lo stesso tipo di eccezione già accettata in §7.4** (un
miglioramento SEO che cambia l'output esportato, anche se non il
rendering visibile sullo schermo) — **va trattato con lo stesso
protocollo backup+verifica di §7.4**, non applicato silenziosamente. Per
`vicchina.it` specificamente, questo fix in realtà **ripristina** quello
che l'autore originale aveva scritto a mano e che la pipeline esistente
già cancellava — un argomento in più a favore dell'applicarlo, ma la
decisione formale resta quella già presa dall'utente in §7.4 (si applica,
con backup e verifica).

| File | Azione |
|---|---|
| `src/services/seo.js` | Estendere `buildArticleJsonLd` con `authorType` (sopra, additivo); nuova `buildArticleBreadcrumbJsonLd` (sopra) |
| `src/routes/serve.js` | Nel branch che costruisce `seoLocals`, se `page.post_type === 'article'` usare `buildArticleJsonLd` (non `buildWebPageJsonLd`) + `buildArticleBreadcrumbJsonLd` invece del generico, e passare `ogType: 'article'` (fix og:type, sopra). **Serve leggere la query che seleziona la pagina (righe 298 e 305) e aggiungere `post_type, category_id, excerpt, featured_image, published_at, author_id` alle colonne selezionate**, più una query aggiuntiva per nome categoria/autore se presenti (2 query leggere, con `id`, non un join pesante — un articolo singolo, non una lista) |
| `views/partials/seo-meta.ejs` | Riga 12: `og:type` diventa condizionale su `ogType` (fix sopra, additivo, default `'website'` identico a oggi) |
| `src/services/seo.js` → `injectSeoIntoStandalone` | Stesso fix `ogType` (sopra) nel branch standalone |
| `src/services/static-export.js` → `buildSeoLocals` (riga 49-62) e la query in `exportPublishedPagesInner` (righe 344-353) | Stessa estensione: aggiungere le nuove colonne alla SELECT, usare `buildArticleJsonLd`/`buildArticleBreadcrumbJsonLd` quando `post_type==='article'`. **Questa è la ragione per cui ho scritto in §1 "quasi non va toccato": l'unica modifica a questo file è qui + il punto RSS sotto, NON nel loop di export principale** |
| `src/services/static-export.js` → nuova funzione `generateRssFeed(siteId, baseUrl)` | **Nuova funzione** nello stesso file, stesso stile di `generateSeoFiles` (riga 220-239, da cui copiare il pattern: query articoli pubblicati, costruire XML, scrivere `fs.writeFileSync(path.join(dir, "blog", "feed.xml"), xml)`). Query: stesso filtro di Fase 3/§8.7 (`post_type='article' AND published=true AND (review_status IS NULL OR review_status='approved')`), **`ORDER BY published_at DESC LIMIT 30`** (dettaglio trovato in questo giro, prima mai specificato: un feed RSS non elenca TUTTA la storia di un sito — per `vicchina.it`, 353 articoli, sarebbe un file enorme e non è la convenzione del formato; 30 è lo standard de facto per la maggior parte dei feed, confermato da WordPress/altri CMS che usano lo stesso numero di default). Chiamarla da `exportPublishedPagesInner`, riga 406, subito dopo `await generateSeoFiles(...)` — una riga in più, non un refactor |
| `src/services/seo.js` | `buildRssXml(siteName, baseUrl, articles)` — funzione pura separata (testabile senza DB), chiamata da `generateRssFeed`. **Mapping esatto dei campi RSS 2.0, trovato sottospecificato in un giro precedente**:
  - `<title>` = `article.title`, `<link>`/`<guid isPermaLink="true">` = `baseUrl + article.url_path` (lo stesso URL, mai un id numerico — il link è sempre quello reale e stabile, coerente con §7.1: l'`url_path` non cambia mai per design)
  - `<description>` = `article.excerpt` **o** `deriveExcerptFromContent(article.content)` se vuoto (stesso fallback di Fase 3/2bis, importato da `blog-index.js`, non duplicato una quarta volta)
  - `<pubDate>` = **`new Date(article.published_at).toUTCString()`, non `.toISOString()`** — RSS 2.0 richiede RFC 822/1123 (es. `"Wed, 24 Sep 2026 10:00:00 GMT"`), non ISO 8601. `toUTCString()` di JS produce esattamente questo formato nativamente, zero librerie. **Errore comune da evitare esplicitamente**: usare `toISOString()` qui produrrebbe un `<pubDate>` che molti reader RSS non interpretano correttamente (data "non valida" o ignorata).
  - `<channel><title>`/`<description>` = `siteName`/`brandName` del sito, `<link>` = `baseUrl`, `<atom:link rel="self">` = `baseUrl + "/blog/feed.xml"` (buona prassi RSS, dichiara l'URL del feed stesso)
  - **Escaping**: riusare `escapeXml` già presente in `seo.js` (riga 20, oggi non esportata — **aggiungere `export`**, stesso principio additivo già applicato più volte in questo documento, usata internamente da `buildSitemapXml` con lo stesso identico bisogno di escaping XML, nessuna ragione di duplicarla) |
| Nuovo partial `views/partials/blog-card.ejs` (opzionale) | Se si preferisce EJS a template string per le card — **decisione da prendere in Fase 3**, non bloccante: lo pseudocodice sopra assume template string JS per semplicità/testabilità, ma è una scelta di stile, non un vincolo tecnico |
| `test/blog-rendering.test.js` | **Nuovo**. Un articolo pubblicato produce JSON-LD `Article` corretto (sia live via serve.js sia export statico), con `author: {"@type":"Organization"}` quando `author_id` è NULL e `{"@type":"Person"}` quando è impostato; breadcrumb con 3 o 4 livelli (con/senza categoria) e URL finale sempre quello reale della pagina; feed RSS contiene gli articoli pubblicati nell'ordine giusto, non contiene articoli non pubblicati, non approvati, o pagine normali; **`<pubDate>` è in formato RFC 822 valido** (parsing con `new Date(pubDate)` deve dare una data valida — il test che blinda l'errore `toISOString()` vs `toUTCString()` trovato in questo giro); con più di 30 articoli pubblicati → il feed ne contiene esattamente 30, i più recenti per `published_at`; **`og:type="article"` per un articolo, `"website"` (invariato) per una pagina normale, sia wrapped sia standalone** (il test che blinda il fix trovato in questo giro, incluso il caso "tag già presente scritto a mano" — deve finire sovrascritto a `"article"`, non lasciato al valore scritto a mano se diverso, coerenza col resto dei meta tag gestiti da `page_seo`) |

**File che restano intoccati in questa fase** (verificarlo esplicitamente,
non per assunzione): `exportPage()` (riga 64-121), `cleanupOrphanedFiles()`
(riga 155-212), `exportPublishedPagesInner` loop principale (righe 386-390),
`createSymlinks()`, `fullExport()`. Tutti questi continuano a trattare le
righe con `managed_by` impostato (indice/categoria) e `post_type='article'`
come `pages` qualsiasi, che è esattamente il punto di §1.

### Fase 6 — Sitemap e llms.txt

**Aggiornato — non più "probabilmente zero modifiche"**: `getPublishedPagesForSitemap`
(`src/services/seo.js`, righe 3-18 — letta per intero) già fa `SELECT p.url_path,
p.updated_at, p.title, s.meta_title, s.meta_description, s.og_image FROM
pages p LEFT JOIN page_seo s ON s.page_id = p.id WHERE p.site_id=$1 AND
p.published=true AND s.noindex IS NOT TRUE` — senza filtrare per
`post_type`, quindi articoli, indice blog e pagine categoria **finiscono
già in sitemap.xml automaticamente**, confermato, nessuna modifica per
quello. **Ma una modifica è comunque necessaria, trovata nel round §8.7**:
questa stessa query è anche l'unica fonte di `llms.txt` (via
`groupPagesForLlms`, chiamata da `generateSeoFiles` in
`static-export.js`), e **non filtra `review_status`** — un articolo
`pending` (agente, non ancora approvato) finirebbe comunque in
`sitemap.xml`/`llms.txt`, proposto ai motori di ricerca prima
dell'approvazione. Fix esatto descritto in §8.7 (aggiunta al `WHERE`):
`AND (p.review_status IS NULL OR p.review_status = 'approved')`.

**Nota aggiuntiva su `groupPagesForLlms`** (`seo.js` riga 216-241, letta
per intero): raggruppa le pagine per **primo segmento del path**
(`parts[0]`) — `/blog/categoria/viaggi` finisce correttamente sotto il
gruppo "Blog", ma un **articolo con URL piatto** (il caso di
`vicchina.it`, post-migrazione, per design di §7.1: gli `url_path` non
cambiano) ha un solo segmento → `parts.length < 2` → `prefix = "/"` →
**finisce raggruppato sotto "Home" in `llms.txt`**, non sotto "Blog".
Non è un bug di sicurezza (llms.txt è solo informativo per agenti/crawler
AI, non influenza SEO reale né visibilità pubblica) ma è impreciso.
**Decisione presa qui, enhancement minimo**: estendere
`getPublishedPagesForSitemap` per restituire anche `post_type`/il nome
categoria (join aggiuntivo leggero), e `groupPagesForLlms` per controllare
`p.post_type === 'article'` **prima** della logica a path-prefix esistente
(che resta invariata per tutto il resto, `post_type` di default è
`'page'` per ogni riga non toccata da questa feature — zero impatto sui
siti senza blog) — se è un articolo, raggruppare sotto `"Blog"` (o
`"Blog — " + categoryName` se la categoria è nota), ignorando la
profondità reale del path. Isolato, additivo, non cambia l'output per
nessuna pagina che non sia un articolo.

| File | Azione |
|---|---|
| `src/services/seo.js` → `getPublishedPagesForSitemap` | Aggiungere il filtro `review_status` (correzione critica, sopra); estendere la SELECT con `p.post_type`, nome categoria (join leggero su `categories`) |
| `src/services/seo.js` → `groupPagesForLlms` | Branch `post_type==='article'` → gruppo "Blog"/"Blog — categoria", prima della logica a path-prefix esistente (invariata per il resto) |
| `test/sitemap-review-gate.test.js` | **Nuovo**. Articolo `pending` + `published=true` → assente da `getPublishedPagesForSitemap` (query diretta, non solo HTML); articolo approvato → presente; articolo con URL piatto (stile vicchina.it) → raggruppato sotto "Blog" in `groupPagesForLlms`, non sotto "Home"; pagina normale (`post_type='page'`) → comportamento di oggi invariato (nessuna regressione) |

## 4. Sicurezza — checklist esplicita (facile da dimenticare)

### 4.1 IDOR su categorie + permessi (`authorize`)

`src/routes/categories.js` **deve** replicare ESATTAMENTE il pattern IDOR
già presente in `pages.js` (es. righe 207-210, 311-313, 467-469): un utente
non-superadmin può leggere/modificare/cancellare **solo categorie del
proprio `site_id`**, mai tramite un `site_id` arbitrario nel body/query.
Testare esplicitamente (come fa `test/access-grants.test.js` per altre
risorse) un tentativo di un utente del sito A di toccare una categoria del
sito B → deve risultare 403 o 404, mai 200.

**Permessi — verificato, dettaglio importante**: `authorize(resource,
action)` (in `src/middleware/authorize.js`) legge da `PERMISSIONS` in
`src/constants/permissions.js` (un oggetto JS in-memory), **NON** dalla
tabella DB `roles_permissions`. Quella tabella esiste ed è usata, ma da un
sistema diverso e non correlato (`src/services/capabilities.js`, le
"capability" lette/scritte dinamicamente per i satelliti/agent — dominio
estraneo a questa feature, **non toccare `capabilities.js` né
`roles_permissions`**, il blog non ha bisogno di nulla lì). In
`src/constants/permissions.js`, sia `admin` che `collaboratore` hanno già
`pages: { create: true, read: true, update: true, delete: true }` — quindi
**riusare `authorize("pages", azione)` per tutte le route di
`categories.js` funziona senza aggiungere nulla**: nessuna nuova chiave
`categories` in `permissions.js`, nessuna riga in `roles_permissions`.
Decisione: fare esattamente questo (riuso diretto), non introdurre un
permesso separato per le categorie — sarebbe complessità extra senza un
requisito che la richieda (nessuna richiesta di "un ruolo può editare
pagine ma non categorie").

### 4.2 Le pagine `managed_by` non devono essere editabili a mano

`GET /admin/pages/:id/edit`, `POST /admin/pages/:id` **e** `POST
/admin/pages/:id/versions/:versionId/restore` **devono rifiutare** (400 o
redirect con errore) un tentativo di modificare/ripristinare una pagina con
`managed_by IS NOT NULL` dall'editor normale — altrimenti un utente modifica
a mano `/blog`, e al giro successivo `syncBlogListingPages` la sovrascrive
silenziosamente (bug "al contrario" rispetto a quello di §4.5: lì è il
motore che non deve sovrascrivere l'umano, qui è l'umano che non deve
poter corrompere ciò che il motore gestisce). **Il restore versione va
controllato esplicitamente**: anche se nella pratica una pagina
`managed_by` non passa mai da `POST /admin/pages/:id` (quindi non accumula
mai righe in `page_versions` nel flusso normale), il controllo va messo
comunque sull'endpoint restore stesso, non solo sull'update — difesa in
profondità, non fidarsi del fatto che "nella pratica non dovrebbe succedere".
Mostrare un messaggio chiaro ("Questa pagina è generata automaticamente dal
blog, non è editabile qui") in tutti e 3 i punti — chiave i18n
`api.pages.managedPageNotEditable` in entrambi i file locale (stessa
convenzione di nomi usata per gli errori nuovi dell'agent API, §8.2.1).

### 4.3 category_id cross-site

Il form di editing articolo deve popolare il select categoria **solo con le
categorie dello stesso `site_id` dell'articolo** — mai una query `SELECT *
FROM categories` senza filtro `site_id`, altrimenti un admin di un sito
potrebbe assegnare (o peggio, scoprire l'esistenza di) categorie di un altro
sito. Stesso discorso lato server: `POST /admin/pages/:id` deve verificare
che il `category_id` ricevuto appartenga allo stesso `site_id` della pagina
prima di salvarlo (altrimenti un payload malevolo con `category_id` di un
altro sito passerebbe silenziosamente, violando l'isolamento multi-tenant).

### 4.4 Validazione slug categoria

**Verificato — `normalizeUrlPath` (in `src/services/urls.js`) NON è
riusabile per lo slug categoria**: la funzione restituisce sempre una
stringa con `/` iniziale (`return "/" + stripped`, ultima riga), perché è
pensata per `url_path` di pagina, non per uno slug nudo. Usarla tale e quale
su uno slug produrrebbe `/moda-uomo` invece di `moda-uomo`, rompendo
`UNIQUE(site_id, slug)` e la costruzione di `/blog/categoria/<slug>`
(diventerebbe `/blog/categoria//moda-uomo`). Serve una funzione dedicata,
piccola, in `src/routes/categories.js` o in un nuovo helper in `urls.js`:
```js
function normalizeCategorySlug(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)) throw new Error("Slug non valido");
  return v;
}
```
Non derivarla automaticamente dal nome con una libreria esterna (niente
nuove dipendenze, vedi regola CLAUDE.md su approvazione esplicita) — un
campo slug esplicito nel form, con questa sola validazione, basta.

### 4.5 Non sovrascrivere mai una pagina scritta a mano con lo stesso `url_path`

Trovato nel secondo giro di revisione di questo documento, non nel primo:
se un sito ha **già** una pagina scritta a mano a `/blog` (plausibile: è un
path comune, un sito potrebbe averla creata prima che questa feature
esistesse) e si attiva il blog, `syncBlogListingPages` **non deve in alcun
caso eseguire l'UPSERT su quella riga** — altrimenti il contenuto umano
viene sostituito silenziosamente dalla card generata, senza nessun avviso,
alla primissima chiamata della sync. Il controllo esatto è descritto al
punto 4 della Fase 3 (`managed_by IS NULL` sulla riga esistente = non
toccare, logga un errore, salta). **Questo va testato esplicitamente** in
`test/blog-index-sync.test.js`: creare a mano una pagina `/blog` (`managed_by
NULL`), poi chiamare `syncBlogListingPages` con almeno un articolo
pubblicato, verificare che (a) il contenuto della pagina manuale non sia
stato toccato, (b) la sync non abbia lanciato un'eccezione che blocca il
resto (categoria, altre pagine di paginazione continuano a generarsi).

### 4.6 `published_at` NULL — ordinamento imprevedibile se non gestito

Un articolo creato con `published=true` ma senza `published_at` esplicito
(campo opzionale) avrebbe `published_at IS NULL` e finirebbe sempre in fondo
all'ordinamento `ORDER BY published_at DESC NULLS LAST` (Fase 3, punto 2) —
**un utente che pubblica un articolo e non vede comparirlo in testa al blog
è un bug percepito, anche se tecnicamente "corretto" rispetto allo schema**.
Fix da applicare in `src/routes/pages.js` (`POST /admin/pages` e `POST
/admin/pages/:id`) e in `src/routes/agent.js` (stessi 2 endpoint lato
agent): se il campo `published` nella richiesta è `true` (o diventa `true`
rispetto allo stato precedente) **e** `published_at` non è stato fornito
esplicitamente nella stessa richiesta, impostare `published_at = NOW()`
automaticamente lato server. Se l'utente fornisce `published_at` a mano
(retrodatazione di un articolo importato, caso reale e legittimo), quel
valore vince sempre — l'auto-set copre solo il caso "non l'ho specificato".

## 5. File da NON toccare in nessuna fase (lista esplicita)

- `src/services/static-export.js` → `exportPage()`, `cleanupOrphanedFiles()`,
  `deleteStaticPage()`, `createSymlinks()`, `fullExport()`, `exportAllSites()`,
  il loop principale in `exportPublishedPagesInner` (righe 386-390) — **il
  punto di design di tutta questa roadmap è che queste funzioni non sanno e
  non devono sapere che esiste un blog**.
- `db/001_schema.sql` e qualsiasi altra migrazione già applicata in
  produzione — si aggiunge sempre una **nuova** migrazione, non si edita
  mai una vecchia (regola generale del repo, non specifica di questa feature).
- `src/services/page-renderer.js` (`expandSnippets`) — gli articoli
  continuano a usare `{{snippet:...}}` esattamente come le pagine normali,
  nessuna estensione necessaria.
- Tabella `tags` e `custom_field_folders` (`db/143_tags_folders.sql`) — CRM
  contatti, dominio estraneo, nessuna relazione con le categorie blog.
  **Non riusarle "perché il nome assomiglia", sono concetti diversi.**
- `src/routes/sites.js` — `homepage_path` non cambia significato; la
  homepage di un sito resta quello che è oggi, il blog è un sotto-ramo
  (`/blog`), non sostituisce la home.
- `views/layouts/site.ejs` — il layout condiviso non ha bisogno di modifiche:
  le pagine blog sono `layout_mode='wrapped'` come già previsto, passano dal
  layout esistente senza toccarlo. Se in futuro si vuole un layout dedicato
  al blog (header diverso), sarebbe un `layout_template` diverso per sito,
  non una modifica a questo file condiviso.
- `src/routes/serve.js` — **tranne** la piccola estensione di query descritta
  in Fase 5 (aggiungere colonne alla SELECT esistente). Non toccare la logica
  di routing/redirect/homepage-fallback già presente.
- **Qualsiasi dato reale** di `neparliamoasettembre.it` / `vicchina.it`: in
  questa roadmap NON si fa alcun UPDATE sulle 302/355 pagine esistenti di
  questi due siti. Il lavoro si verifica su un sito di test creato ad-hoc
  (`createTestSite` nei test, o un sito reale ma vuoto/di prova in staging se
  si vuole un giro manuale prima dei test automatici).

## 6. Ordine di esecuzione e criteri di stop

1. Fase 1 (migrazione + categorie) → `npm test` verde → commit+deploy
   possibile indipendentemente (zero impatto pubblico).
2. Fase 2 (campi editor) → `npm test` verde, **incluso il test del bug
   versioning §2.3** → commit+deploy possibile indipendentemente.
3. Fase 3 (motore sync) → test unitari del motore verdi, **nessuna rotta
   ancora lo chiama** → sicuro da deployare, dead code attivabile.
4. Fase 4 (inneschi) → da qui in avanti creare un articolo in admin produce
   davvero `/blog` popolato. Verifica manuale su un sito di test PRIMA del
   deploy: creare 2-3 articoli finti, controllare `/blog` e `/blog/categoria/
   <slug>` nell'export statico generato in locale.
5. Fase 5 (SEO/RSS) → verifica JSON-LD con un validatore (es. richiesta
   manuale, confronto con output atteso) + feed RSS valido (XML ben
   formato, controllabile con un parser).
6. Fase 6 (verifica sitemap) → probabilmente zero modifiche, solo conferma.

**Non passare alla fase successiva se la fase corrente non ha `npm test`
verde E la verifica manuale descritta non è stata fatta.** Ogni fase è
singolarmente deployabile e a basso rischio — non serve fare tutto in un
colpo solo, ed è fortemente raccomandato NON farlo tutto in un colpo solo.

### 6.1 Non ancora rispettato in questo documento: delega a opencode

**Trovato in questo giro**: le direttive permanenti dell'operatore
(`~/.claude/CLAUDE.md`, §5 "DELEGA A SUBAGENT OPENCODE") impongono che
"la scrittura fisica del codice, le ricerche massive e i refactoring
ripetitivi DEVONO essere delegati a sessioni tmux `opencode` già pronte
sul server" — questo documento, fin qui, non menziona mai questo vincolo
nella descrizione dell'esecuzione, nonostante sia una regola permanente
di questa macchina, non una scelta di questa feature. Da applicare quando
si passa dalla pianificazione (questo file) all'esecuzione:
- Ogni Fase/round di questo documento, quando eseguito, segue comunque le
  4 fasi standard (ANALISI → PIANO → MONTAGGIO → VERIFICA) della stessa
  direttiva: il "MONTAGGIO" di ciascuna Fase/round **va delegato a
  opencode** (istruzioni con percorsi assoluti, stesso protocollo delle
  sessioni precedenti), non scritto direttamente in questa sessione.
- La VERIFICA (test, isolamento Docker, diff byte-per-byte già descritti
  in §7.1/§7.4/§9.9) **resta in questa sessione**, non va delegata — è
  lei che controlla il lavoro di opencode, non il contrario (coerente con
  "non fidarsi mai ciecamente di un self-report di successo", disciplina
  già osservata in questa stessa sessione per altri round di questo
  progetto).
- Questo vincolo **non cambia nulla del contenuto tecnico già pianificato
  in questo documento** — è solo un chiarimento su CHI scriverà il codice
  quando si passerà all'esecuzione, non ancora rilevante mentre si è in
  pura pianificazione (stato attuale di questo file).

### 6.2 Non ancora rispettato: nessun gate di conferma esplicita prima di un deploy reale

**Trovato in questo giro**: le stesse direttive permanenti (§6
"PROTOCOLLO DI SICUREZZA") richiedono conferma esplicita dell'operatore
per azioni difficili da invertire — un deploy su un sito di produzione
reale (`vicchina.it`, `neparliamoasettembre.it`) con contenuto/traffico
vero rientra in questa categoria, anche con un backup appena fatto (il
backup riduce il danno di un errore, non sostituisce la decisione di
procedere). **Questo documento finora descrive backup e verifiche
(§7.4, §9.9) ma non dichiara mai esplicitamente che il passo successivo —
il deploy reale — richiede un via libera esplicito dell'operatore in quel
momento**, non solo "seguire il piano scritto qui". Va aggiunto come
regola esplicita, non assunto per implicito:

- **§7.3 (bulk-categorize su `vicchina.it`/`neparliamoasettembre.it`
  reali)**, **§7.4 (attivazione `BlogPosting` su un sito reale)**, **§9.9
  punto 6 (deploy della homepage dinamica su `vicchina.it` reale)**:
  ciascuno di questi 3 passi, quando si arriva ad eseguirlo per davvero
  (non nel container di test), **richiede di fermarsi e chiedere
  conferma esplicita all'operatore prima di procedere**, anche se tutte le
  verifiche automatiche/manuali precedenti sono già verdi. Il backup
  resta comunque obbligatorio PRIMA di chiedere quella conferma (un
  backup fatto dopo la conferma ma prima del deploy reale è already
  troppo tardi se la conferma stessa viene data "al buio").
- Il lavoro nel **container di test isolato** (§9.9 punti 1-5, e lo stesso
  principio per §7.3/§7.4 quando verificati prima su un sito di prova) non
  richiede questo gate — è lì che l'esecuzione (anche delegata a opencode,
  §6.1) può procedere autonomamente fino alla verifica, perché non tocca
  nulla di reale. Il gate si attiva solo al passaggio dal container di
  test al sito di produzione vero.

## 7. ESTENSIONE — Migrazione `vicchina.it` zero-impatto + template/categorie configurabili da UI

Round di pianificazione aggiunto il 2026-10-10. Riusa e si aggancia alle
Fasi 1-6 già descritte (non le sostituisce) — questo è il dettaglio che
mancava per renderle davvero applicabili a un sito con contenuti reali
senza "fare casino".

### 7.1 Garanzia di compatibilità — cosa significa esattamente "zero modifiche"

Per ciascuna delle 355 pagine di `vicchina.it`, la migrazione (bulk
categorizzazione, §7.3) scrive **solo** su `post_type`, `category_id`,
`published_at` (e opzionalmente `excerpt`, se compilato a mano in un
secondo momento — mai obbligatorio). **Non scrive mai** su `content`,
`layout_mode`, `url_path`, `title`. `updated_at` cambierà (è una UPDATE
reale sulla riga) — **questo è accettabile e corretto**, non è "la pagina è
cambiata" nel senso che conta qui (il contenuto pubblico è identico).

**Verifica di accettazione per questo round** (da eseguire manualmente su
un export locale prima di considerare la fase chiusa): prendere una pagina
di `vicchina.it`, fare un export statico PRIMA della categorizzazione
bulk, salvare il file; fare la categorizzazione; fare un secondo export;
`diff` byte-per-byte i due file HTML esportati. **Devono essere
identici**. Se non lo sono, qualcosa nella Fase 5 (SEO locals, JSON-LD) sta
leggendo le nuove colonne in un modo che altera l'output anche per una
pagina `standalone` — da correggere prima di procedere, non da ignorare.

Nota tecnica sul perché ci si aspetta che siano identici: `page_seo` (da cui
vengono meta_title/meta_description/JSON-LD) non viene toccato da questa
migrazione; `exportPage()` per le pagine `standalone` inietta SEO/tracking
nel markup ma non legge `post_type`/`category_id` per farlo (verificare che
resti così anche dopo la Fase 5 — l'estensione della query descritta lì
aggiunge le colonne alla SELECT, ma l'uso di `buildArticleJsonLd` (vedi
correzione in Fase 5: funzione già esistente in `seo.js`, riusata invece
di scriverne una nuova) invece di `buildWebPageJsonLd` **cambia il JSON-LD
anche per le standalone**: va deciso esplicitamente, vedi §7.4, se questo
è voluto per `vicchina.it` o no).

**Verificato a DB in questo giro finale**: né `vicchina.it` né
`neparliamoasettembre.it` hanno oggi alcuna pagina a `/blog` o sotto
`/blog/*` — zero collisioni reali con i path che il blog genererà. La
guardia anti-sovrascrittura di §4.5 resta comunque necessaria come difesa
generale (altri siti futuri potrebbero avercela), ma per questi due siti
specifici **non è un rischio concreto oggi**, solo una rete di sicurezza.

### 7.2 Categorie e template configurabili da UI — dettaglio

Nuovo file: `src/services/blog-settings.js`, stesso pattern di
`src/services/site-seo.js` (`getSiteSeoConfig`/`setSiteSeoConfig`, query
diretta su `settings` con `site_id = $1`, non il file `settings.js` globale
— vedi il bug già segnalato in Fase 3/§237 di questo stesso documento,
**stesso errore da non ripetere qui**).

```js
// src/services/blog-settings.js
const DEFAULTS = {
  blog_articles_per_page: "10",
  // Placeholder supportati: {{title}} {{excerpt}} {{image}} {{url}}
  // {{published_at}} {{category_name}} {{category_url}}. Sintassi identica
  // a quella già usata per il payload_template dei webhook OUT (stesso
  // {{path}}), per non introdurre una seconda sintassi di template nel
  // prodotto — ma la FUNZIONE di rendering è nuova (vedi nota sotto, NON
  // riusare renderTemplate di webhooks.js).
  blog_card_template: `<article class="blog-card">
  {{image}}
  <h2><a href="{{url}}">{{title}}</a></h2>
  <p class="meta">{{category_name}} — {{published_at}}</p>
  <p>{{excerpt}}</p>
</article>`,
  blog_index_title: "Blog",
  blog_index_intro_html: "",
};

export async function getBlogConfig(siteId) { /* query settings, merge coi DEFAULTS */ }
export async function setBlogConfig(siteId, fields) { /* upsert settings, stesso pattern site-seo.js */ }
```

**Perché i default sono importanti**: `vicchina.it` deve "funzionare" (avere
un `/blog` leggibile) **senza che l'utente configuri nulla prima** — i
default sopra sono quello che si usa finché l'admin non li cambia da UI.
Questo è un requisito di questo round, non un dettaglio opzionale.

**Sulla funzione di rendering del template — ATTENZIONE, bug verificato in
`renderTemplate` (webhooks.js, riga 296-298)**: quella funzione ha un
controllo `if (!template || typeof template !== "object" || ...) return
template;` **PRIMA** del branch `if (typeof template === "string")` — il
branch stringa è quindi **irraggiungibile** (dead code): passare una
stringa a `renderTemplate` la ritorna invariata, senza sostituire nessun
placeholder. **Non riusare `renderTemplate` per il template della card**:
scrivere una funzione nuova, piccola, dedicata in `blog-index.js`
(**esportata fin da subito**, non solo interna al modulo — serve anche a
`page-renderer.js` per il widget `{{articles:...}}` di §10, non solo a
`blog-index.js` stesso):
```js
export function renderCardTemplate(template, data) {
  return String(template || "").replace(/\{\{([^}]+)\}\}/g, (_, path) => {
    const val = path.trim().split(".").reduce((o, k) => (o == null ? o : o[k]), data);
    if (val === undefined || val === null) return "";
    // Escape HTML: titolo/excerpt sono testo utente, mai iniettarli grezzi
    // (un titolo con "<" o "&" romperebbe il markup della card, non è un
    // vero rischio XSS essendo contenuto del proprietario del sito, ma è
    // comunque un bug di correttezza facile da far scattare per sbaglio:
    // es. un titolo articolo con una "e commerciale" o un confronto "<").
    return String(val).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  });
}
```
Nota: il placeholder `{{image}}` e `{{url}}` nel template di default sopra
sono in realtà già HTML/attributi pronti (es. `{{image}}` espande a
`<img src="...">` già costruito da `blog-index.js`, non un URL nudo da
mettere dentro un `<img src="{{image}}">` scritto nel template) — **per
evitare la doppia insidia "a volte placeholder = valore nudo, a volte =
HTML già pronto" che confonderebbe chi personalizza il template**, definire
chiaramente nella UI (vicino alla textarea del template) quali placeholder
sono "testo" (`title`, `excerpt`, `category_name`, `published_at`,
escapati) e quali sono "blocco HTML già pronto" (`image` — vuoto se
`featured_image` non è impostato, mai un tag rotto; `url` resta testo/attributo,
va scritto come `href="{{url}}"` nel template, NON come blocco pronto —
coerenza: solo `image` è "pronto", perché è l'unico caso con una condizione
(presente/assente) che converrebbe risolvere una volta nel generatore
invece che forzare ogni template a scrivere un `{{#if image}}` che la
sintassi mustache-lite qui non supporta).

**Admin UI**: nuova pagina `/admin/blog-settings` (o una nuova sezione in
`/admin/categories`, da decidere in fase di implementazione — **non
bloccante per la pianificazione**, è una scelta di IA, non di dati/sicurezza):
form con i 4 campi di `DEFAULTS` sopra, più la lista categorie esistente
(CRUD già previsto in Fase 1) con, per OGNI categoria, un campo
`description` (già nello schema §2.1) usabile come intro della pagina
categoria.

| File | Azione |
|---|---|
| `src/services/blog-settings.js` | **Nuovo**. `getBlogConfig`/`setBlogConfig`, pattern `site-seo.js` |
| `src/routes/categories.js` (o nuovo `src/routes/blog-settings.js`) | Aggiungere `GET/POST /admin/blog-settings` (o inglobarlo nella pagina categorie esistente) |
| `views/admin/categories/index.ejs` (o nuova view) | Form template/config, con anteprima testuale dei placeholder disponibili (non serve un live-preview renderizzato, sarebbe scope creep per questo round) |
| `locales/it.json`, `locales/en.json` | Nuove chiavi per le label del form (stessa regola già scritta altrove in questo documento: sempre entrambi i file) |
| `src/services/blog-index.js` | `renderArticleCard` (già previsto in Fase 3) ora chiama `getBlogConfig(siteId)` + `renderCardTemplate` invece di un template JS fisso |
| `test/blog-settings.test.js` | **Nuovo**. get/set config, default quando non configurato, placeholder HTML-escapati correttamente (test esplicito: un titolo con `<script>` nel testo produce una card con `&lt;script&gt;`, non uno script eseguibile — anche se qui il "rischio" è il proprietario del sito contro sé stesso, non un attaccante esterno, la correttezza dell'escaping va comunque verificata) |

### 7.3 Bulk-categorizzazione: come si migrano 355 pagine senza apritele una per una

Nuova azione admin, stesso pattern di `POST /admin/pages/bulk-import`
(righe 115-144 di `pages.js`, già verificato e letto in questo documento):
multi-select nella lista `/admin/pages`, un'azione "Assegna a categoria
come articoli".

```
POST /admin/pages/bulk-categorize
body: { site_id, page_ids: [...], category_id, post_type: 'article' }
```

Logica server (`src/routes/pages.js`, nuova route):
1. IDOR guard identico alle altre route di `pages.js`: tutti i `page_ids`
   devono appartenere a `site_id`, e `site_id` deve essere quello
   dell'utente (o un superadmin che l'ha scelto esplicitamente).
2. Verificare che `category_id` appartenga allo stesso `site_id` (stessa
   guardia di §4.3).
3. **Backfill di `published_at`**: `UPDATE pages SET post_type='article',
   category_id=$1, published_at = COALESCE(published_at, created_at),
   updated_at = NOW() WHERE id = ANY($2::int[]) AND site_id=$3`. Il
   `COALESCE` è deliberato: **le 355 pagine di `vicchina.it` non hanno mai
   avuto un `published_at` editoriale distinto, l'unico dato temporale
   reale disponibile è `created_at`** — ometterlo lascerebbe tutte le
   pagine con `published_at IS NULL`, finendo in fondo all'ordinamento
   dell'indice blog (`ORDER BY published_at DESC NULLS LAST`) in un ordine
   arbitrario (deciso dal tie-break `id DESC`, non dalla cronologia reale).
   Se l'utente vuole poi correggere la data editoriale di un singolo
   articolo, lo fa dall'editor normale (campo `published_at` già previsto
   in Fase 2) — il bulk è solo il punto di partenza sensato, non il valore
   finale per forza.
3bis. **Trovato in questo giro, dato reale concreto che cambia il
   backfill**: ho interrogato `page_seo` per i 353 articoli pubblicati
   di `vicchina.it` — **231 (65%) hanno già `og_image` impostato**, quasi
   tutti path locali `/media/7/...cover...jpg` (immagine di copertina già
   presente, mai sfruttata finora in questo piano). **Solo 12 (3.4%)
   hanno `meta_description`** — troppo pochi per essere una fonte
   affidabile di `excerpt` in bulk (vedi punto 3ter in Fase 3 per
   l'excerpt). **Estendere il backfill del punto 3**: `UPDATE pages p SET
   featured_image = COALESCE(p.featured_image, (SELECT s.og_image FROM
   page_seo s WHERE s.page_id = p.id AND s.og_image LIKE '/media/%')) WHERE
   ...` — **solo se `og_image` è un path locale** (`LIKE '/media/%'`, mai
   un URL esterno: un `og_image` remoto non ancora scaricato nei media del
   sito non va promosso a `featured_image` senza passare dal download
   SSRF-safe già descritto per l'agent API, §8.2.2 — stesso principio,
   qui applicato ai dati esistenti). Risultato pratico: **231 dei 353
   articoli di `vicchina.it` avranno un'immagine in evidenza già pronta
   al primo giro di bulk-categorize**, zero lavoro manuale.
4. Una sola chiamata a `syncBlogListingPages(siteId)` **dopo** il loop (non
   una per pagina — 355 chiamate sarebbero lente e inutili, il motore è
   stateless e ricalcola tutto comunque).
5. **Correzione aggiunta nel giro finale di revisione** (la bulk-categorize
   è stata scritta prima di §9, quindi non la includeva): se §9 è stato
   implementato, chiamare anche `syncHomepageSections(siteId)` qui, stesso
   motivo di §8.5 — un sito con homepage dinamica attiva e una sezione
   `category_band`/`all_feed` deve reagire anche a una categorizzazione in
   blocco di 355 articoli, non solo alle mutazioni singole.
6. Una sola chiamata a `exportPublishedPages({siteId})` (full re-export del
   sito) dopo i due sync sopra — **side-effect noto e accettabile**: un
   export di 355 pagine richiede qualche secondo, è fire-and-forget
   (`.catch(()=>{})`) come ovunque già nel repo, non blocca la risposta
   HTTP.

| File | Azione |
|---|---|
| `src/routes/pages.js` | Nuova route `POST /admin/pages/bulk-categorize`, import di `syncBlogListingPages` (già previsto in Fase 4, nessun import aggiuntivo). **Verificato**: `src/index.js` monta già globalmente sia `express.json()` sia `express.urlencoded()` (righe 212-213) — `req.body` funziona identico sia che il bulk-categorize arrivi come JSON via `fetch()` (vedi nota tecnica sotto su `index.ejs`) sia come form tradizionale, nessun middleware aggiuntivo da montare |
| `views/admin/pages/index.ejs` | **Dettaglio tecnico verificato nel markup reale di questo file** (righe 53-95, lette per intero): la tabella NON è oggi dentro un `<form>` — ogni riga ha i propri mini-`<form>` indipendenti per `publish-toggle`/`delete` (es. riga 76-80, 88-92). **Non si può avvolgere l'intera tabella in un nuovo `<form>` per il bulk-categorize**: i form HTML non si annidano, il browser "chiuderebbe" il form esterno al primo form interno trovato, con risultati imprevedibili. Soluzione: checkbox `<input type="checkbox" name="page_ids" value="<%= p.id %>">` per riga, **fuori da qualunque form** (semplici elementi liberi nella cella), + un select categoria e un bottone "Assegna" nella toolbar (vicino al bottone "Nuova pagina", riga 30), gestiti con un piccolo blocco `<script>` che raccoglie i checkbox spuntati e fa una `fetch('/admin/pages/bulk-categorize', {method:'POST', ...})` al click — stesso stile già presente in questo progetto per interazioni analoghe (es. `copyToClipboard`/i blocchi script di `views/admin/agent/index.ejs`), non un form HTML tradizionale. **Visibile solo se esiste almeno una categoria per il sito** (altrimenti è un'azione che non può avere successo, meglio non mostrarla che mostrare un errore) |
| `test/pages-bulk-categorize.test.js` | **Nuovo**. Caso centrale (il più importante di questo round): selezionare N pagine `standalone` con contenuto reale, categorizzarle in bulk, poi verificare byte-per-byte che `content`/`layout_mode`/`url_path` di OGNUNA siano rimasti identici a prima (query diretta, confronto stringa) — questo è il test che garantisce in automatico quanto descritto in §7.1, non solo manualmente. IDOR: tentare di categorizzare una pagina di un altro sito → nessun effetto, 403/404. `category_id` di un altro sito → rifiutato (§4.3). `published_at` preesistente non viene sovrascritto dal `COALESCE`; `published_at` assente viene riempito con `created_at` esatto della riga; **`featured_image` vuoto + `og_image` locale (`/media/...`) già presente in `page_seo`** → `featured_image` backfillato da `og_image` (il test che blinda il dato reale trovato in questo giro: 231/353 articoli di vicchina.it hanno già questa condizione); `og_image` remoto (`http...`, non ancora scaricato) → **non** backfillato (resta vuoto, nessun download automatico silenzioso qui); `featured_image` già compilato → non sovrascritto dal backfill |

### 7.4 DECISO: `BlogPosting` sì, ma solo dopo backup + verifica "identico lato client"

**Risposta dell'utente (§0.5 punto 1)**: applicare `BlogPosting` anche alle
pagine standalone migrate (è un miglioramento SEO voluto, non un effetto
collaterale) — **a condizione che**: (a) si faccia un backup del sito
prima di attivarlo in produzione, (b) si verifichi esplicitamente che il
risultato **lato client** resti identico.

**Nota di implementazione (non cambia la decisione)**: la Fase 5 (corretta
in un giro successivo) implementa questo usando `@type: "Article"`
(funzione `buildArticleJsonLd`, già esistente in `seo.js`, non una nuova
`buildBlogPostingJsonLd`) — `Article` è valido per i rich result di Google
tanto quanto `BlogPosting` (che ne è una sottoclasse più specifica), e
riusa codice già scritto invece di duplicarlo. **"`BlogPosting`" in questo
paragrafo e nei successivi è il nome con cui la decisione è stata
discussa con l'utente — nel codice reale il type esatto è `Article`.**

**Estensione trovata in un giro successivo, stessa decisione/stesso
protocollo si applica anche a questa**: `og:type` è oggi hardcoded a
`"website"` per ogni pagina (sia `wrapped` sia `standalone`) — Fase 5
lo rende `"article"` per `post_type='article'`. **Dato concreto su
vicchina.it**: il suo articolo `/slang-lavoro-genz-cina-2026` ha già
`og:type="article"` scritto a mano, oggi silenziosamente sovrascritto a
`"website"` dalla pipeline di export esistente — questo fix lo
ripristina. Stesso protocollo di verifica di questo paragrafo (backup +
controllo body visibile byte-identico, il cambio è solo nei meta tag
`<head>`, non nel body renderizzato).

**Chiarimento necessario, perché "identico" qui ha 2 significati diversi
che vanno tenuti separati**: il JSON-LD è dentro un `<script
type="application/ld+json">`, **invisibile al rendering** — quindi "identico
lato client" NON può voler dire "il file HTML è byte-identico" (non lo sarà
mai: il blocco JSON-LD cambia `@type` e aggiunge campi, questo è l'intento
stesso del punto 1). Significa invece: **tutto ciò che un visitatore vede o
con cui interagisce nel browser resta invariato** — stile, layout, testo
visibile, comportamento di script visibili, performance di caricamento.
Il protocollo di verifica di questa fase va quindi diviso in due controlli
distinti, non uno solo:
1. **Diff del body visibile**: estrarre il DOM renderizzato (o più
   semplicemente il file HTML con il blocco `<script type="application/
   ld+json">` del WebPage/BlogPosting rimosso prima del confronto) tra la
   versione pre- e post-attivazione — questo **deve** restare byte-identico
   (stesso principio di §7.1, applicato qui solo al body visibile).
2. **Validazione del JSON-LD nuovo**: il blocco `BlogPosting` generato deve
   essere JSON valido, con i campi richiesti da Google per il rich result
   "Article" (`headline`, `datePublished`, `author`, `image` se presente) —
   verificabile con un validatore (es. richiesta manuale al [Rich Results
   Test di Google](https://search.google.com/test/rich-results) su una
   pagina di test, o un controllo di schema JSON offline equivalente).

**Backup — riusa il sistema esistente, non inventarne un altro**:
`runBackup({siteId, kind: 'full', created_by: 'migration-blogposting'})`
(già esistente, `src/services/backup-jobs.js` riga 184, esposto anche via
`/admin/backups` e `POST /api/agent/sites/:siteId/backup`) **prima** di
attivare `buildArticleJsonLd` sulle pagine standalone di un sito reale.
Il backup è la rete di sicurezza per un rollback rapido se la verifica (1)
sopra fallisce in produzione dopo il deploy, non un passo puramente
burocratico.

**Dove si inserisce nell'ordine di esecuzione (§6)**: questa verifica va
fatta **per sito**, non una volta per tutto il codice — prima di attivare
la Fase 5 su un sito reale con pagine standalone (es. `vicchina.it`),
ripetere: backup del sito → deploy → generare un export locale di una
pagina campione → diff del body (controllo 1) → validare il JSON-LD
(controllo 2) → solo allora considerare la Fase 5 "chiusa" per quel sito.

## 8. ESTENSIONE 2 — API agenti per creare articoli "senza fare casino"

Round aggiunto il 2026-10-10 (secondo di due richiesti in questo giro).
Obiettivo dell'utente: un agente AI deve poter creare un articolo
specificando **solo** nome, immagine, categoria (il minimo), mantenendo
**la possibilità di passare HTML custom come oggi**, ma con meno margine
d'errore di quanto ne abbia oggi l'endpoint generico `/pages`.

### 8.1 Decisione: endpoint dedicato, non l'endpoint `/pages` esteso

`POST /api/agent/sites/:siteId/pages` (generico) resta per le pagine
normali. Per gli articoli si aggiunge un endpoint **nuovo e separato**:

```
POST /api/agent/sites/:siteId/articles
PUT  /api/agent/sites/:siteId/articles/:pageId
GET  /api/agent/sites/:siteId/categories
POST /api/agent/sites/:siteId/categories
```

**Perché un endpoint separato e non solo campi opzionali su `/pages`**: un
endpoint dedicato può avere default DIVERSI e più sicuri senza rompere la
compatibilità di chi già chiama `/pages` oggi (agenti esterni esistenti
che non si aspettano che una chiamata a `/pages` possa ora anche
comportarsi da "crea articolo con default magici"). Inoltre rende
impossibile, per costruzione, creare un articolo senza passare dal percorso
pensato per essere "senza casino" — chi chiama `/articles` ottiene sempre
quei default, non deve ricordarsi di impostarli.

**Due dettagli verificati nel codice reale prima di scrivere le nuove
route (`agent.js`)**:
1. **`requireAgent`/`canAccessSite` esistono in 2 copie divergenti** nel
   repo: una locale in `agent.js` (righe 177-182, messaggio d'errore
   i18n via `res.locals.t(...)`), una condivisa in `agent-helpers.js`
   (usata da `crm-agent.js`, messaggio d'errore hardcoded in italiano,
   senza i18n — divergenza pre-esistente, non introdotta da questa
   roadmap e **non va corretta qui**, sarebbe un refactor fuori scope).
   **Le nuove route di questo round devono importare/usare le versioni
   LOCALI di `agent.js`** (coerenza con tutte le altre route già presenti
   in quello stesso file, che usano quelle locali), non quelle di
   `agent-helpers.js`.
2. **Il controllo scope `write` (richiesto in §8.7 per approve/reject) è
   già automatico, non va scritto riga per riga**: `apiTokenScopeGate`
   (`src/middleware/auth.js`, chiamata alla riga 128 dentro `requireAuth`
   stesso) scatta per OGNI richiesta con metodo di scrittura
   (POST/PUT/DELETE/PATCH) autenticata con un token API, **a meno che il
   path non sia nella `READ_ONLY_POST_ALLOWLIST`** (riga 48-58 dello
   stesso file). **Verificato**: nessuna delle nuove route di questo
   round (`/articles`, `/categories`, `/articles/:id/approve`, `/reject`)
   è né sarà in quella allowlist — quindi un token con solo scope `read`
   riceve già oggi, automaticamente, 403 su qualunque POST/PUT verso
   questi endpoint, **senza scrivere nessun controllo scope esplicito nel
   codice delle nuove route**. Il requisito "serve scope write" di §8.7
   è quindi già soddisfatto dall'infrastruttura esistente, zero righe
   aggiuntive — l'unica cosa da NON fare per sbaglio è aggiungere questi
   path a `READ_ONLY_POST_ALLOWLIST` (quella lista è per endpoint che
   sono POST solo per forma ma non scrivono nulla, es. una ricerca — non
   è questo il caso).

### 8.2 `POST /api/agent/sites/:siteId/articles` — contratto esatto

Campi accettati (zod, nuovo schema `agentArticleSchema` in `agent.js`):

```js
const agentArticleSchema = z.object({
  title: z.string().min(1).max(255),
  category: z.string().min(1).optional(),      // nome o slug, vedi 8.2.1
  category_id: z.number().int().positive().optional(), // alternativa a `category`
  excerpt: z.string().max(500).optional(),
  featured_image: z.string().optional(),  // URL remoto O path locale /media/..., vedi 8.2.2 — **mai `.url()` qui**: rigetterebbe un path locale, che è un input legittimo (8.2.2)
  content: z.string().optional(),               // HTML custom, vedi 8.2.3 — OMISSIBILE
  url_path: z.string().optional(),              // OMISSIBILE, auto-slug da title (8.2.4)
  published: z.boolean().optional().default(true), // default TRUE qui, diverso da /pages (8.2.5)
  published_at: z.string().datetime({ offset: true }).nullable().optional(),
});
```

Non accettati (e se presenti nel body, **scartati silenziosamente da zod**,
coerente con quanto già scritto in Fase 4 per `agentPageSchema`): `post_type`
(sempre forzato `'article'` server-side), `managed_by`, `layout_mode` come
valore libero (vedi 8.2.3 — è vincolato, non libero come in `/pages`).

#### 8.2.1 Risoluzione categoria — mai creazione automatica silenziosa

Se arriva `category` (stringa): risolvere per `slug` esatto o `name` esatto
(case-insensitive) tra le categorie del sito. **Se non trovata, rispondere
400** con la lista delle categorie esistenti nel messaggio di errore (così
l'agente si autocorregge al tentativo successivo, senza dover fare un'altra
chiamata GET prima) — **non creare automaticamente** una categoria nuova
al volo: un agente che scrive "Viaggio" invece di "Viaggi" (typo plausibile)
creerebbe altrimenti una categoria duplicata, esattamente il tipo di
"casino" che questo round deve evitare. Creare una categoria è un'azione
esplicita (`POST /api/agent/sites/:siteId/categories`, séparata, mai
implicita in un'altra chiamata).

**Formato esatto della risposta 400 — verificato, non generico**: questo
NON è un errore di validazione zod (la stringa `category` è sintatticamente
valida, il problema è che non risolve a nulla), quindi **non passa da
`handleAgentError`/`sendValidationError`** (quelle gestiscono `ZodError`,
righe 196-206 di `agent.js` — formato `{error:"validation_failed", code,
fields:[...]}`, non adatto qui). Serve una risposta dedicata, nello stesso
stile `{error, code}` già usato ovunque in questo file:
```json
{ "error": "category_not_found", "code": "category_not_found",
  "available_categories": [{ "id": 3, "name": "Viaggi", "slug": "viaggi" }, ...] }
```
Chiave i18n coerente con la convenzione già in uso (`locales/it.json`,
schema `api.pages.xyzCamelCase` — es. `api.pages.notFound`,
`api.pages.invalidPlatform`, già verificati esistenti): aggiungere
`api.pages.categoryNotFound` in **entrambi** i file locale (regola già
ripetuta altrove in questo documento). Stesso trattamento per gli altri
errori di business-logic nuovi di questo round, stessi nomi suggeriti:
`api.pages.categoryMismatch` (8.2.1 sotto), `api.pages.notAnArticle`
(§8.3), `api.pages.managedPageNotEditable` (§4.2).

Se arriva `category_id` (numero): stessa guardia IDOR già scritta in §4.3
(deve appartenere al sito). Se arrivano entrambi `category`/`category_id` e
sono in conflitto (risolvono a categorie diverse): 400 con
`api.pages.categoryMismatch`, mai "ne scelgo uno a caso".

Se **nessuno dei due** arriva: l'articolo si crea comunque (categoria
`NULL` è uno stato valido, già previsto da `ON DELETE SET NULL` in §2.2) —
comparirà nell'indice `/blog` generale ma non in nessuna categoria. Non
bloccare la creazione per questo: a volte un agente scrive un articolo
prima che esista ancora una categorizzazione chiara, e forzarlo a
inventarsi una categoria sarebbe un casino peggiore di non averne una.

#### 8.2.2 `featured_image` — scaricata in locale, non un hotlink esterno fidato

**Validazione a 2 rami, non nello schema zod** (lo schema accetta solo una
stringa generica, vedi la correzione sopra): in codice, testare
`/^https?:\/\//i.test(featured_image)`. Se remoto: **non salvarlo com'è**
in `pages.featured_image` — usare `fetchUrlToMedia(siteId, url)` (già
esistente, usata da `extract-assets` in `pages.js`, riga 417: SSRF-safe,
già testata, già usata per lo stesso identico scopo "scarica un URL esterno
e portalo nei media del sito") e salvare l'URL locale risultante
(`result.url`). Se il download fallisce (URL morto, troppo grande, non
immagine — gli stessi casi già gestiti da `fetchUrlToMedia`): **non
bloccare la creazione dell'articolo**, crearlo comunque con
`featured_image = null` e un campo nella risposta JSON
(`featured_image_error: "..."`) che l'agente può leggere e segnalare
all'operatore umano — un articolo senza immagine è un problema minore
rispetto a un articolo che non si crea affatto per colpa di un'immagine
rotta.

**Lacuna trovata in questo giro: `fetchUrlToMedia` NON è image-only**.
Verificato: `ALLOWED_EXT` in `src/routes/media.js` (riga 26) accetta
`jpg|jpeg|png|gif|webp|svg|mp4|mp3|pdf|zip|woff|woff2|ttf|otf|eot|ico|mov`
— un agente che passa un URL che risolve a un `.pdf` o `.zip` otterrebbe
un `featured_image` "scaricato con successo" ma non un'immagine, risultato:
un tag `<img src=".../file.pdf">` rotto nella card, un bug percepito senza
nessun errore riportato (il download sarebbe "riuscito" dal punto di vista
di `fetchUrlToMedia`, che non sa che qui serve specificamente un'immagine).
**Fix**: dopo la chiamata a `fetchUrlToMedia`, controllare l'estensione del
`result.url` risultante contro un set più ristretto, solo immagini
(`jpg|jpeg|png|gif|webp|svg`) — se non corrisponde, trattarlo come lo
stesso caso di "download fallito" sopra (`featured_image=null` +
`featured_image_error`, mai bloccare la creazione). Non serve toccare
`fetchUrlToMedia`/`ALLOWED_EXT` (resta generico per tutti gli altri usi,
media upload compreso) — il controllo più stretto vive solo qui, nel
codice specifico di `/articles`.

Se **non** remoto (path locale `/media/...`, caso: un agente che ha
già caricato l'immagine con l'endpoint media upload esistente e passa quel
path) — **non ri-scaricarlo**, usarlo com'è.

#### 8.2.3 `content` omesso — generazione di un corpo sicuro di default

Se `content` non è fornito: generare un body minimale e sicuro,
`layout_mode` forzato a `'wrapped'` (MAI `'standalone'` quando il contenuto
è generato automaticamente — uno standalone richiede un documento HTML
completo con `<html><head>`, generarlo da zero per un agente che non ha
dato istruzioni sarebbe fragile e sarebbe "inventare" molto più di quanto
chiesto). Contenuto generato:
```html
<article class="agent-article">
  <p>{{excerpt_or_placeholder}}</p>
</article>
```
(con lo stesso escaping HTML già previsto in §7.2 per i placeholder). Se
`excerpt` non c'è nemmeno quello, usare un paragrafo vuoto — **non
inventare testo con un modello linguistico qui**, non è compito di questo
endpoint, è compito dell'agente chiamante se vuole contenuto vero; questo
endpoint garantisce solo che la pagina non sia HTML rotto.

Se `content` **è** fornito: **qui resta disponibile l'HTML custom "come
oggi"**, esattamente la richiesta dell'utente. Unica differenza dal
comportamento di `/pages`: se il body HTML sembra un documento completo
(contiene `<html` case-insensitive), **forzare `layout_mode='standalone'`**
anche se non richiesto esplicitamente (altrimenti un `<html>` dentro il
`content` di una pagina `wrapped` finirebbe annidato dentro il layout del
sito, producendo HTML invalido — bug facile da introdurre per un agente che
non conosce la distinzione `standalone`/`wrapped` di questo CMS). Se non
contiene `<html`, resta `wrapped` di default (l'agente scrive solo il
corpo, il sito ci metta header/footer) — **questa euristica va scritta
chiaramente nei commenti del codice**, è un comportamento "magico" che
altrimenti sorprenderebbe in revisione futura.

Stesso trattamento già esistente per gli umani va applicato anche qui,
senza eccezioni: `extractAndReplaceBase64(siteId, content)` (base64 inline
→ file media reali, pattern già in uso in `pages.js`), per evitare righe
`pages.content` gigantesche se l'agente incolla immagini in base64.

#### 8.2.4 `url_path` omesso — auto-slug dal titolo, con gestione collisioni

Se `url_path` non è fornito: generare uno slug dal `title`. **Nuova
funzione piccola e dedicata** (NON riusare `normalizeUrlPath`, stesso
motivo già scritto in §4.4 per lo slug categoria — quella funzione
richiede già un path con `/`, non un titolo libero da trasformare):
```js
function slugifyTitle(title) {
  return String(title)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // o grave -> o, a grave -> a, ecc. (rimuove i diacritici dopo NFD)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "articolo";
}
```
(scritto con l'escape ASCII `\u0300-\u036f` esplicito, non caratteri
combinanti letterali nel codice — più sicuro da copiare/incollare in un
editor senza che venga alterato invisibilmente da una normalizzazione
automatica del testo).
(scritto con l'escape `̀-ͯ` esplicito, non caratteri combinanti
letterali nel codice — più sicuro da copiare/incollare in un editor senza
che venga alterato invisibilmente, es. da una normalizzazione automatica).
Se lo slug risultante collide già con un `url_path` esistente nel sito,
**appendere `-2`, `-3`, ...** fino a trovarne uno libero (query `SELECT 1
FROM pages WHERE site_id=$1 AND url_path=$2` in loop, con un limite di
sicurezza — es. max 50 tentativi, poi 409 "troppi articoli con titolo
simile, specifica un url_path"). **Non usare mai un suffisso casuale
(timestamp/random)**: un agente che rilegge l'URL dell'articolo appena
creato dalla risposta JSON (il `201` ritorna sempre `url_path` effettivo,
mai solo quello richiesto) deve poter prevedere/riconoscere URL leggibili,
non `articolo-a8f3c91`.

#### 8.2.5 `published` default `true` — scelta deliberata, diversa da `/pages`

Su `/pages` generico il default è `false` (una pagina creata da un agente
generico resta bozza finché un umano non la pubblica esplicitamente — scelta
prudente per contenuto arbitrario). Su `/articles` il default è **`true`**:
il caso d'uso descritto dall'utente è un agente che scrive un articolo con
l'intento di pubblicarlo subito (workflow editoriale assistito, non una
bozza sperimentale) — se si vuole il comportamento prudente, basta passare
`published: false` esplicitamente. **Questa asimmetria va documentata bene
in `AGENT.md`** (il file di istruzioni per gli agenti, già esistente — vedi
`/api/agent/guide`), altrimenti è il tipo di dettaglio che genera un bug
report "l'agente ha pubblicato senza chiedere" quando in realtà è il
comportamento di design voluto.

Stessa regola di §4.6 (`published_at` auto-impostato a `NOW()` se
`published=true` e non specificato) si applica identica qui.

### 8.3 `PUT /api/agent/sites/:siteId/articles/:pageId` — solo su articoli già tali

Se la pagina target NON ha `post_type='article'`: **400**,
`{error:"not_an_article", code:"not_an_article"}` (chiave i18n
`api.pages.notAnArticle`, messaggio "questa non è un articolo, usa PUT
/pages per modificarla") — tiene separate le due responsabilità (§8.1). Stessi campi di `POST`, tutti opzionali
(update parziale) tranne che ovviamente non si può omettere tutto. Stessa
gestione `category`/`category_id`/`featured_image`/`content` di 8.2.1-8.2.3.
Se `url_path` non è fornito nell'update, **non cambiarlo** (diverso dalla
creazione: qui "omesso" significa "lascialo com'è", non "generane uno
nuovo" — un auto-slug silenzioso su un update romperebbe link già
condivisi, un comportamento molto più dannoso che utile).

### 8.4 `GET /api/agent/sites/:siteId/categories` + `POST` per crearne una

`GET`: lista `{id, name, slug, description, color, icon}` (i 2 campi
`color`/`icon` sono l'aggiunta di §9.5, patch allo schema di §2.1 — se
questo round viene implementato PRIMA di §9, questi 2 campi semplicemente
non esistono ancora e l'endpoint li omette, nessun problema di ordine).
`POST`: stesso schema/validazioni di `src/routes/categories.js` (§Fase 1),
sotto `/api/agent/`, con lo stesso controllo slug (§4.4) e la stessa guardia
IDOR (§4.1 — qui non serve, l'agente opera già nel proprio `siteId` verificato
da `canAccessSite`, stesso pattern di tutte le altre route agent).

### 8.5 Lacuna trovata in questo giro finale di revisione: innesco sync/export mai collegato

**Gap reale, non solo teorico**: §8.2/8.3 descrivono `POST`/`PUT .../articles`
ma non specificano mai la chiamata a `syncBlogListingPages` (Fase 3/4) né,
se §9 è implementato, a `syncHomepageSections` (§9.7) — perché questi due
endpoint sono stati pianificati in un round successivo a Fase 4 e a §9, e
nessuno dei due è stato aggiornato per includerli. **Senza questa
correzione, un articolo creato via `/articles` non apparirebbe mai in
`/blog` né in una homepage dinamica**, esattamente il tipo di bug che
questa roadmap esiste per evitare. Correzione: `POST`/`PUT
.../articles[/:pageId]` devono, dopo aver scritto la riga `pages`,
eseguire **esattamente la stessa sequenza già stabilita per `POST
/admin/pages/:id`** (Fase 4 + §9.7): `await syncBlogListingPages(siteId)
.catch(()=>{})`, poi (se §9 è stato implementato) `await
syncHomepageSections(siteId).catch(()=>{})`, poi `exportPublishedPages(
{siteId}).catch(()=>{})` **senza filtro `pageIds`** (stesso motivo già
spiegato per `POST /api/agent/sites/:siteId/pages` in Fase 4: l'export deve
coprire anche le righe indice/homepage appena risincronizzate, non solo
l'articolo appena creato).

### 8.6 Lacuna trovata in questo giro finale: `Idempotency-Key` mai menzionato

**Verificato**: `POST /api/agent/sites/:siteId/pages` (l'endpoint generico
esistente) supporta già l'header `Idempotency-Key` (funzioni locali
`checkIdempotency`/`storeIdempotency`, righe 100-109 e 642/678 di
`agent.js`) — un agente che ritenta una richiesta dopo un timeout di rete
non crea una pagina duplicata. **§8.2/8.3 non menzionavano questo
comportamento per i nuovi endpoint `/articles`**, un'omissione reale: senza
lo stesso supporto, un agente che non riceve risposta (es. timeout mentre
l'export gira) e ritenta la stessa richiesta creerebbe un SECONDO
articolo quasi identico (con uno `url_path` diverso per via del suffisso
`-2` di 8.2.4, che lo rende pure difficile da notare come duplicato).
Correzione: `POST /api/agent/sites/:siteId/articles` deve leggere
`Idempotency-Key` e applicare lo stesso `checkIdempotency`/
`storeIdempotency` già esistente, stesso pattern esatto della riga 642/678.

### 8.7 `review_status` — bozze in attesa di approvazione (DECISO, §0.5 punto 2)

**Risposta dell'utente**: gli articoli creati da un agente non vanno live
subito — restano "in attesa di approvazione" finché qualcuno (umano O
un **altro agente autorizzato a fare da revisore**) li approva. Design:

```sql
ALTER TABLE pages ADD COLUMN IF NOT EXISTS review_status VARCHAR(20)
  CHECK (review_status IN ('pending', 'approved', 'rejected'));
```
(stesso file di migrazione di §2.2/§9.5 se non ancora applicato in
produzione, altrimenti una migrazione aggiuntiva — stessa regola di §2.4).
`NULL` = non soggetto a revisione (**il comportamento di ENTRAMBE le
pagine normali e degli articoli creati da un umano via "Nuovo articolo",
§9.6 — la revisione riguarda SOLO gli articoli creati dall'endpoint
agente**, non introduce un passaggio di approvazione per chi lavora già
dentro l'admin, che è già "la revisione" per definizione).

**Scope preciso — dove si applica**: `POST /api/agent/sites/:siteId/
articles` (§8.2) imposta **sempre** `review_status='pending'` sulla riga
appena creata, **indipendentemente** dal valore di `published` ricevuto —
`published` resta il "intento" dell'agente (vuole che vada live), ma il
**gate reale di visibilità ovunque** (indice blog, pagine categoria,
sezioni homepage §9, widget `{{articles:...}}` §10, **e la sitemap/llms.txt,
vedi lacuna sotto**) diventa `published = true AND (review_status IS NULL
OR review_status = 'approved')`. Un articolo `pending` non appare in
NESSUNA di queste 5 superfici, anche se `published=true` — è visibile
solo via accesso diretto (anteprima admin, GET agent con l'id esatto),
non nelle liste pubbliche né proposto ai motori di ricerca.

**Lacuna CRITICA trovata in questo giro — una 5ª superficie dimenticata**:
`getPublishedPagesForSitemap` (`src/services/seo.js` riga 3-18) è la fonte
condivisa di **sia** `sitemap.xml` **sia** `llms.txt` (commento nel file
stesso: "p.title / s.meta_title / s.meta_description servono anche a
buildLlmsTxt") — filtra solo `p.published = true AND s.noindex IS NOT
TRUE`, **senza alcun filtro `review_status`**. Senza correggerla, un
articolo creato da agente con `published=true` ma ancora `pending`
**verrebbe elencato in `sitemap.xml` e proposto a Google per
l'indicizzazione prima di qualunque approvazione umana** — esattamente
l'opposto dello scopo di questo paragrafo: la revisione diventerebbe
invisibile sul sito ma visibile ai motori di ricerca, il leak peggiore
possibile per questa feature. **Fix**: aggiungere `AND (p.review_status
IS NULL OR p.review_status = 'approved')` alla query, e aggiungere
`p.review_status` alla `SELECT` solo se serve altrove (non serve al
chiamante oggi, può restare fuori dalla SELECT, serve solo nel WHERE).

**Patch cross-cutting necessarie — ora 5, non 4** (query già scritte
nelle sezioni precedenti di questo documento, da correggere tutte — altrimenti
la feature di questo paragrafo non ha alcun effetto reale):
1. Fase 3 punto 2 (query di `syncBlogListingPages`): `AND published=true`
   diventa `AND published=true AND (review_status IS NULL OR
   review_status='approved')`.
2. §9.3 (query di `category_feed`/`all_feed`/`category_band` in
   `syncHomepageSections`): stessa aggiunta.
3. §10.3 punto 2 (query di `expandArticleLists`): stessa aggiunta.
4. **`getPublishedPagesForSitemap` (`seo.js`, Fase 6) — la lacuna appena
   trovata, da correggere qui**: stessa aggiunta nel WHERE.
5. `GET /api/agent/sites/:siteId/pages` (allowlist campi, round §8 nota a
   Fase 4): aggiungere `review_status` ai campi leggibili, così un agente
   (incluso un eventuale "revisore") può filtrare/scoprire le bozze in
   attesa (`?review_status=pending`).

**Test**: il caso "un articolo `pending` non deve apparire in sitemap/
llms.txt" è coperto da `test/sitemap-review-gate.test.js` (Fase 6, nuovo
file dedicato — non duplicarlo anche in `article-review.test.js`, un solo
posto per questo test).

**Approvazione — chi può farlo e come**:
- `POST /admin/pages/:id/approve` e `/reject` (umano, admin UI) —
  richiede lo stesso `authorize("pages","update")` già esistente, nessun
  nuovo permesso.
- `POST /api/agent/sites/:siteId/articles/:pageId/approve` e `/reject`
  (agente) — **richiede scope `write`** sul token, **già applicato
  automaticamente** da `apiTokenScopeGate` dentro `requireAuth` (verificato
  con precisione in §8.1 punto 2 — zero codice da scrivere per questo,
  basta non aggiungere questi path a `READ_ONLY_POST_ALLOWLIST`): un
  token di sola lettura non può approvare. **Nessun nuovo livello di
  permesso oltre a `write`** — un "agente revisore" (menzionato
  dall'utente come idea futura) è semplicemente un token con scope
  `write` dedicato a questo compito, non richiede un meccanismo di
  autorizzazione nuovo. Entrambe le azioni
  (umano e agente) **loggano in `audit_log`** (`auditLog({...action:
  'approve'|'reject'...})`, funzione già esistente, `action VARCHAR(20)`
  in `audit_log` — entrambe le stringhe ci stanno) — così resta sempre
  tracciabile chi ha approvato cosa, dato che può essere un agente diverso
  da chi ha creato la bozza.
- `approve`: `review_status='approved'` — se `published=true` era già
  impostato, l'articolo diventa visibile al prossimo
  `syncBlogListingPages`/`syncHomepageSections`/export (serve comunque
  chiamarli dopo l'approvazione, stesso pattern di innesco già visto
  ovunque in questo documento — **non dimenticarlo qui**, è lo stesso tipo
  di lacuna già corretto 2 volte in questo giro finale, §8.5/§7.3).
- `reject`: `review_status='rejected'` — l'articolo resta nel DB (non
  cancellato, per tracciabilità/possibile revisione futura) ma non è e non
  sarà mai visibile in nessuna delle 4 superfici finché qualcuno non lo
  riporta manualmente a `pending`/`approved`.
- **Chiarimento trovato in questo giro, mai esplicitato**: `approve`/
  `reject` **non creano una riga in `page_versions`** — non sono modifiche
  di contenuto (`content`/`title`/ecc. restano identici), solo un cambio
  di stato, quindi non c'è nulla di cui fare uno snapshot "prima" (sarebbe
  uno snapshot del tutto identico alla riga corrente, inutile). Diverso
  dal PUT agente sopra (quello SÌ cambia contenuto, quindi passa per la
  stessa logica di versioning già prevista in Fase 2 per ogni update).
- **Modifica di un articolo già approvato** (PUT agente, §8.3): se
  `review_status` era `'approved'` e l'update cambia `content`/`title`/
  `category_id`/`excerpt`, **torna a `'pending'`** — un agente non deve
  poter aggirare la revisione modificando silenziosamente un articolo già
  approvato. Se l'update NON tocca questi campi (es. solo
  `published_at`), `review_status` approvato resta tale.

**Lacuna trovata in questo giro: cosa succede se un UMANO modifica via
admin un articolo `pending`/`rejected` creato da un agente — non era mai
stato definito**. Lo scope dichiarato all'inizio di §8.7 ("la revisione
riguarda SOLO gli articoli creati dall'endpoint agente... chi lavora già
dentro l'admin è già 'la revisione'") copre la CREAZIONE umana, ma non
dice cosa fare quando un umano **edita** (`POST /admin/pages/:id`) un
articolo che esiste già con `review_status='pending'` o `'rejected'`
(perché creato da un agente). Senza una regola esplicita, l'umano
salverebbe le modifiche lasciando lo stato invariato — l'articolo resta
tecnicamente "non revisionato" anche se un umano lo ha appena guardato e
modificato, uno stato illogico (un umano con accesso admin che salva un
contenuto È la revisione, per la stessa logica già usata per la
creazione). **Regola**: `POST /admin/pages/:id` (route umana, non agente),
quando la pagina esistente ha `post_type='article'` e `review_status IN
('pending','rejected')`, imposta `review_status='approved'` al salvataggio
— **a meno che l'umano non spunti esplicitamente un checkbox "mantieni in
rifiuto"** nel form (serve per il caso: un admin apre una bozza scartata
solo per leggerla/correggerla senza ancora voler pubblicarla). Di default,
salvare = approvare, coerente con tutto il resto di questo paragrafo.
**Mostrare lo stato attuale (`review_status`) in `views/admin/pages/
edit.ejs`** è quindi necessario anche solo per questo — un admin deve
vedere che sta per approvare implicitamente, non scoprirlo indirettamente.

### 8.8 Lacuna CRITICA trovata in questo giro: `duplicate`/`bulk-duplicate` bypasserebbero la revisione

**Verificato nel codice reale, non ipotizzato**: `POST /api/agent/sites/
:siteId/pages/:pageId/duplicate` e `.../pages/bulk-duplicate` **esistono
già oggi** in `agent.js` (righe 791 e 838), **indipendenti da questa
roadmap** — non sono stati toccati finora da nessuna fase/round di questo
documento. Entrambi fanno un `INSERT INTO pages (site_id, url_path, title,
content, layout_mode, published) VALUES (...)` con colonne **elencate
esplicitamente**, sempre `published = false` per la copia. Questo è un
problema reale e serio una volta aggiunta la colonna `review_status`
(§8.7): **nessuno dei due endpoint la imposta**, quindi la riga duplicata
avrebbe `review_status = NULL` di default — e il filtro di visibilità
ovunque è `published=true AND (review_status IS NULL OR review_status=
'approved')`. **`NULL` supera il filtro esattamente come `'approved'`.**

Concretamente: oggi questo non è ancora un problema (`post_type`/
`category_id` non esistono ancora nell'INSERT, quindi una pagina duplicata
diventerebbe comunque `post_type='page'` di default, non un articolo — il
`PUT /api/agent/.../articles/:pageId` la rifiuterebbe per §8.3). **Ma è
una bomba a innesco ritardato**: se in futuro qualcuno estende questi 2
INSERT per includere anche `post_type`/`category_id`/`excerpt`/
`featured_image` (una modifica naturale e probabile — "perché duplicare un
articolo lo trasforma in una pagina normale?" è una domanda che qualcuno
si farà), e lo fa senza conoscere §8.7, **duplicare un articolo già
approvato produrrebbe un secondo articolo "approvato" senza che nessuno
l'abbia mai approvato** — bypass completo della revisione, esattamente il
contrario di quanto deciso dall'utente in §0.5 punto 2.

**Decisione presa qui per chiudere la lacuna in modo permanente**:
quando (in un round successivo, non necessariamente ora) questi 2 INSERT
verranno estesi per portare `post_type`/`category_id`/`excerpt`/
`featured_image` nella copia, **`review_status` deve essere impostato
esplicitamente**:
```sql
INSERT INTO pages (site_id, url_path, title, content, layout_mode,
                    published, post_type, category_id, excerpt,
                    featured_image, review_status)
VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9,
        CASE WHEN $6 = 'article' THEN 'pending' ELSE NULL END)
```
**Mai `published_at`** nella copia (resta `NULL`, si auto-imposta a
`NOW()` solo alla pubblicazione reale, §4.6) — un duplicato non eredita la
data editoriale dell'originale, avrebbe poco senso (è contenuto "nuovo",
anche se il testo è copiato). **Questa regola vale sia che la duplicazione
la faccia un agente sia che in futuro venga esposta anche in admin**
(oggi non esiste un `duplicate` per pagine nell'admin UI, verificato —
solo lato agent).

**Azione per questa roadmap, da fare adesso e non rimandare**: aggiungere
un test di regressione che blinda questo comportamento **anche se i 2
INSERT non vengono toccati in questo round** — un test che fallisce nel
momento esatto in cui qualcuno (umano o agente di sessione futura) estende
quegli INSERT senza applicare questa regola, invece di scoprirlo in
produzione:

| File | Azione |
|---|---|
| `test/agent-duplicate-review-gate.test.js` | **Nuovo**. Duplicare un articolo con `review_status='approved'` tramite `POST .../pages/:pageId/duplicate` → la copia, SE e quando avrà `post_type='article'`, deve avere `review_status='pending'`, mai `NULL`/`'approved'`. **Se oggi (prima che gli INSERT vengano estesi) il test scopre che la copia è `post_type='page'`** (comportamento attuale, non ancora un bug), il test documenta questo come baseline e fallisce esplicitamente in futuro SOLO quando qualcuno aggiunge `post_type` all'INSERT senza aggiungere anche `review_status` — va scritto per fallire in quel momento, non per passare silenziosamente oggi e sempre |

| File | Azione (aggiuntiva a §8.9 sotto) |
|---|---|
| `db/<N>_review_status.sql` (o inglobata nella migrazione base se non ancora applicata) | `ALTER TABLE pages ADD COLUMN review_status` come sopra |
| `src/services/blog-index.js` | Fase 3 punto 2: patch del filtro query (sopra) |
| `src/services/homepage-sections.js` | §9.3: patch dei filtri query (sopra) |
| `src/services/page-renderer.js` | §10.3: patch del filtro query (sopra) |
| `src/routes/pages.js` | Nuove route `POST /admin/pages/:id/approve`, `/reject` |
| `src/routes/agent.js` | Nuove route `POST /api/agent/sites/:siteId/articles/:pageId/approve`, `/reject`; `agentArticleSchema` forza sempre `review_status='pending'` alla creazione (non accettato da input, come `managed_by`) |
| `test/article-review.test.js` | **Nuovo**. Articolo creato da agente → `review_status='pending'`, non appare in `/blog` nemmeno con `published=true`; approvazione umana → appare dopo il sync; approvazione via token agente con scope `write` → stesso effetto, loggato in `audit_log` con l'id del token/agente che approva; token con solo scope `read` → 403 su approve/reject; rejection → mai visibile, resta nel DB; update di un articolo approvato che cambia `content` → torna `pending` (richiede nuova approvazione); update che cambia solo `published_at` → `review_status` resta `approved`; **un umano che salva via `POST /admin/pages/:id` un articolo `pending`/`rejected`** → diventa `approved` di default; con il checkbox "mantieni in rifiuto" spuntato → resta `rejected` (il test che blinda la lacuna appena trovata sull'edit umano) |

### 8.9 File da toccare in questo round

| File | Azione |
|---|---|
| `src/routes/agent.js` | Nuovo `agentArticleSchema`, nuove route `POST/PUT .../articles[/:pageId]`, `GET/POST .../categories`. **Verificato**: `fetchUrlToMedia` (riga 18, da `media.js`) ed `extractAndReplaceBase64` (riga 22, da `media-utils.js`) sono **già importate** in questo file — nessun nuovo import necessario, solo riuso. `syncBlogListingPages` va importata (nuova, da Fase 4) |
| `src/services/urls.js` (o un nuovo piccolo file `src/services/slugify.js`) | `slugifyTitle` (8.2.4) — funzione pura, facilmente testabile isolata |
| `locales/it/AGENT.md` **e** `locales/en/AGENT.md` | **Verificato il path esatto** (`GET /api/agent/guide`, riga 3072 di `agent.js`, legge questi 2 file via `readLocaleMarkdown`). Documentare i 2 nuovi endpoint in **entrambi** i file (stessa regola dei `locales/*.json`, ma qui sono file markdown separati per lingua, non un unico file con chiavi), inclusa l'asimmetria del default `published` (8.2.5) |
| `test/agent-articles.test.js` | **Nuovo**. Caso minimo: solo `title` → 201, `url_path` auto-generato, `content` sicuro non vuoto, `published=true`, `published_at` auto-impostato; categoria per nome risolta correttamente; categoria con typo → 400 con lista categorie nel messaggio; `featured_image` remoto → scaricato in locale (mockare `fetchUrlToMedia` o usare un server HTTP locale di test, stesso pattern già visto in questa sessione per i webhook); `featured_image` che fallisce il download → articolo creato comunque, `featured_image_error` presente; `content` con `<html` → `layout_mode` forzato standalone; `content` senza → wrapped; collisione `url_path` → suffisso `-2`; `PUT` su una pagina `post_type='page'` → 400; **un articolo creato via `/articles` compare poi in `/blog`** (query diretta sulla riga `managed_by='blog_index'` dopo la chiamata — il test che blinda la lacuna di §8.5); **stessa richiesta ripetuta con lo stesso `Idempotency-Key`** → stesso articolo ritornato, nessun secondo articolo creato (il test che blinda la lacuna di §8.6); `featured_image` che risolve a un `.pdf`/`.zip` → trattato come download fallito, `featured_image=null` + `featured_image_error`, **mai** un `<img src>` rotto (il test che blinda la lacuna di 8.2.2) |

**Rate limiting — verificato, nessuna azione necessaria**: `agentLimiter`
e `agentPerTokenLimiter` (`src/index.js`, righe 302-303) sono montati
globalmente su `app.use("/api/agent", ...)`, **prima** che il router venga
popolato con le route specifiche — qualunque nuova route aggiunta sotto
`/api/agent/*` (compresi `/articles`, `/categories` di questo round) **è
già coperta automaticamente**, nessun middleware aggiuntivo da applicare
riga per riga.

## 9. ESTENSIONE 3 — Flusso "Nuovo articolo" + Homepage dinamica a sezioni personalizzabili

Round aggiunto il 2026-10-10 (secondo degli obiettivi descritti
nell'ultimo messaggio). **Verificato a DB, non ipotizzato**: l'homepage
reale di `vicchina.it` (`pages.id=283`, url_path `/`, 250KB di HTML) è già
oggi strutturata esattamente come il risultato che l'utente vuole ottenere
in modo automatico: una sezione hero, una sezione "I format editoriali"
(8 categorie — ponte, radar/trend, tech, cultura, cibo, viaggi, lingua,
business — ciascuna con un glifo cinese, un colore, titolo e descrizione),
e una sezione "feed" con ~230 card articolo filtrabili via JS per categoria
(`.tag.<slug>`, mostra/nascondi, nessuna richiesta server). **`vicchina.it`
è quindi usato qui non solo come il sito da migrare, ma come lo schema di
riferimento concreto per generalizzare la homepage dinamica** — esattamente
la richiesta dell'utente ("usiamo vicchina come esempio di progetto da
scalare").

### 9.1 Vincolo non negoziabile: zero impatto finché non è una scelta esplicita

Coerente con tutto il resto di questa roadmap (§7.1): l'homepage ESISTE già
come riga `pages` per ogni sito. La homepage dinamica è **opt-in per sito**,
mai attiva di default. Nuova chiave in `settings` (stesso pattern già usato
ovunque, `site_id=$1`): `homepage_dynamic_enabled` (`'true'`/`'false'`,
default assente = `false`). **Finché questa chiave non è esplicitamente
`'true'`, nessun codice nuovo di questo round tocca la riga homepage di
nessun sito** — per `vicchina.it`, subito dopo la migrazione (§7), la
homepage resta i 250KB scritti a mano, identici, punto.

### 9.2 Attivazione: mai partire da una pagina bianca

Quando l'utente attiva `homepage_dynamic_enabled` per la prima volta su un
sito che ha già una homepage scritta a mano (il caso normale, non solo
`vicchina.it`): **il contenuto attuale della homepage viene automaticamente
copiato in una sezione `homepage_sections` di tipo `custom_html` in
posizione 0**, PRIMA di attivare il flag. Risultato: il sito owner attiva
la homepage dinamica e **non vede cambiare nulla visivamente** al primo
giro — ha semplicemente trasformato "una pagina scritta a mano" in "una
sezione scritta a mano dentro un sistema a sezioni", da cui può poi togliere
pezzi (es. staccare il blocco feed cards scritto a mano) e sostituirli con
sezioni dinamiche (`category_feed`/`all_feed`/`category_band`), un pezzo
alla volta, verificando ogni volta il risultato. **Questo è il passo che
rende l'attivazione "senza fare casino" anche per un sito con contenuto
reale complesso come vicchina — nessuna migrazione a sezioni è "big bang"**.

**Disattivazione (edge case da non dimenticare)**: se l'utente rimette
`homepage_dynamic_enabled='false'` dopo averla attivata, `managed_by` sulla
riga homepage va rimesso a `NULL` (torna editabile a mano, §4.2 smette di
bloccarla) e `syncHomepageSections` non la tocca più — **il `content`
scritto fin lì dal motore RESTA sulla riga** (non si cancella, non si
torna magicamente al contenuto di prima dell'attivazione): la
disattivazione congela l'ultimo risultato generato come punto di partenza
per tornare a editare a mano, esattamente come se l'utente l'avesse scritto
così. Comportamento scelto per simmetria con tutto il resto della roadmap
("non cancellare mai contenuto silenziosamente", stesso principio di §4.5).

### 9.3 Schema dati — nuova tabella `homepage_sections`

```sql
CREATE TABLE IF NOT EXISTS homepage_sections (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  section_type VARCHAR(30) NOT NULL
    CHECK (section_type IN ('custom_html', 'category_band', 'category_feed', 'all_feed')),
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE, -- solo per 'category_feed'
  title VARCHAR(255) NOT NULL DEFAULT '',
  articles_limit INTEGER NOT NULL DEFAULT 6,
  custom_html TEXT NOT NULL DEFAULT '',      -- solo per 'custom_html'
  card_template_override TEXT,                -- NULL = usa blog_card_template di sito (§7.2)
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_homepage_sections_site_id ON homepage_sections(site_id, position);
```

4 tipi di sezione, deliberatamente pochi e semplici:
- `custom_html`: blocco scritto a mano (hero, banner, qualunque cosa) —
  l'owner mantiene **pieno controllo manuale** dove vuole, esattamente
  "come oggi", solo incorniciato in una posizione configurabile invece che
  fuso nell'unico blob HTML della pagina.
- `category_band`: la sezione "I format editoriali" generalizzata — lista
  automaticamente TUTTE le categorie del sito con almeno un articolo
  pubblicato **e approvato** (vedi filtro sotto), una card per categoria
  (nome, descrizione, glifo/colore se impostati — §9.5, link a `/blog/
  categoria/<slug>`).
- `category_feed`: gli ultimi `articles_limit` articoli di **una**
  categoria (`category_id` obbligatorio per questo tipo).
- `all_feed`: gli ultimi `articles_limit` articoli di **tutte** le
  categorie insieme (equivalente al "feed" di vicchina).

**Filtro `review_status` (aggiunto in §8.7)**: tutte e 3 le query sopra
(`category_band`/`category_feed`/`all_feed`) devono includere `AND
(review_status IS NULL OR review_status='approved')` oltre a
`published=true` — una bozza di un agente in attesa di approvazione non
deve mai comparire sulla homepage, nemmeno in una sezione che altrimenti
la includerebbe per categoria/recency. **Fallback excerpt (aggiunto in
Fase 3, punto 2bis)**: le query di `category_feed`/`all_feed` devono
selezionare anche `content` e passare per `deriveExcerptFromContent`
quando `excerpt` è vuoto — stessa funzione, importata da
`blog-index.js`, non duplicata una seconda volta qui. Supporta un flag
  opzionale `enable_client_filter` (colonna aggiuntiva booleana, o
  riusabile un valore dentro `card_template_override`/una colonna dedicata
  `config_json` — **decisione di dettaglio da prendere in implementazione,
  non bloccante per la pianificazione**: serve comunque un posto dove
  salvare "mostra anche i pulsanti filtro categoria + JS di filtraggio
  client-side") — se attivo, il markup generato include esattamente il
  pattern di filtraggio già verificato in `vicchina.it` (classe `.tag.
  <slug>` su ogni card, pulsanti filtro con `data-category`, JS di
  show/hide). **Questo JS diventa il valore di default proposto per
  `homepage_custom_js` (9.4) quando si attiva per la prima volta un `all_feed`
  con filtro client-side** — coerente con "usiamo vicchina come esempio da
  scalare": il codice che oggi vive scritto a mano dentro l'homepage di
  vicchina diventa il template di default offerto a chiunque altro.

**Nessuna FK `ON DELETE RESTRICT` da `category_id`**: cancellare una
categoria con una sezione `category_feed` che la referenzia cancella anche
la sezione (CASCADE, già scritto sopra) — comportamento corretto: una
sezione che punta a una categoria sparita non ha senso da tenere orfana.

### 9.4 Stile/CSS/JS personalizzabili — dove vivono

Estensione di `blog-settings.js` (§7.2, stesso file, non uno nuovo — è lo
stesso concetto "configurazione per sito", non serve separarlo):
```js
const DEFAULTS = {
  // ... campi già previsti in §7.2 ...
  homepage_custom_css: "",
  homepage_custom_js: "",
};
```
Iniettati come `<style>`/`<script>` inline **dentro il blocco `content`
della homepage** (mai nel `<head>` del layout condiviso — `views/layouts/
site.ejs` **non va toccato**, coerente con §5; un `<style>`/`<script>`
inline in qualunque punto del body è HTML5 valido e funziona identico).
**Nessun nuovo rischio di sicurezza introdotto**: il proprietario del sito
scrive già oggi HTML/CSS/JS arbitrario nelle pagine standalone — questo è
lo stesso livello di fiducia (è il suo sito, scrive codice che eseguirà sui
browser dei suoi visitatori, come fa già). Non è un multi-tenant dove un
utente scrive codice eseguito nel contesto di un ALTRO utente — resta
sempre "il proprietario del sito A scrive codice per i visitatori del sito
A", nessun confine di sicurezza nuovo da proteggere.

### 9.5 Categorie con colore/icona — amendment allo schema di §2.1

Per replicare il pattern vicchina (ogni categoria ha un glifo e un colore
che la identificano in `category_band`): aggiungere 2 colonne OPZIONALI
alla tabella `categories` già definita in §2.1 — **amendment, non una
nuova migrazione separata se §7/§8/§9 vengono implementati nello stesso
giro della migrazione base; se la migrazione base (§2.4) è già stata
applicata in produzione quando si arriva a questo punto, serve invece una
migrazione aggiuntiva** (`ALTER TABLE categories ADD COLUMN ...`, verificare
il numero progressivo al momento, stessa regola di §2.4):
```sql
ALTER TABLE categories ADD COLUMN IF NOT EXISTS color VARCHAR(20);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS icon VARCHAR(10);
```
Entrambi liberi/opzionali (NULL = nessuna personalizzazione, il
`category_band`/template rendono senza colore/icona — grazioso, non un
errore). Esposti nel form categorie (§Fase 1, `views/admin/categories/
edit.ejs`) con un color-picker HTML nativo (`<input type="color">`, zero
dipendenze nuove) e un campo testo libero per l'icona (un carattere/emoji,
non un upload — tenerlo semplice).

### 9.6 Flusso "Nuovo articolo" — entry point dedicato, non un checkbox nascosto

**Correzione al piano della Fase 2** (§3): inizialmente si era previsto un
toggle "è un articolo?" dentro `views/admin/pages/new.ejs` condiviso con le
pagine normali. L'utente ha chiarito la UX voluta: un punto d'ingresso
**separato e dedicato**, "Nuovo articolo" invece di "Nuova pagina" — non
un'opzione nascosta dentro il flusso esistente.

| File | Azione (sostituisce la riga corrispondente di Fase 2) |
|---|---|
| `views/admin/pages/new-article.ejs` | **Nuovo**, non un toggle in `new.ejs`. Stesso editor di contenuto HTML di `new.ejs` (**identico, "esattamente come sono oggi"** — nessuna differenza nella capacità di scrivere HTML custom), ma con categoria/excerpt/immagine in evidenza VISIBILI sempre (non dietro un toggle), `post_type=article` precompilato in un campo hidden |
| `src/routes/pages.js` | Nuova route `GET /admin/pages/new-article` (stessa logica di `GET /admin/pages/new`, resa separata solo per servire la view dedicata — il `POST` di destinazione resta lo stesso `POST /admin/pages` già esteso in Fase 2, nessun handler duplicato) |
| `views/admin/pages/index.ejs` | Due bottoni distinti nella toolbar: "+ Nuova pagina" (link a `/admin/pages/new`) e "+ Nuovo articolo" (link a `/admin/pages/new-article`) |
| `locales/it.json`, `locales/en.json` | Label dei 2 bottoni (regola già scritta altrove: sempre entrambi i file) |

`views/admin/pages/new.ejs` **non ha più bisogno** del toggle previsto
originariamente in Fase 2 — quella riga del piano va considerata superata
da questa, non cumulativa (evitare di costruire sia il toggle che l'entry
point dedicato: sarebbero due modi di fare la stessa cosa, confusione
inutile).

### 9.7 Motore di sync homepage — nuovo file, stesso principio di `blog-index.js`

Nuovo file: `src/services/homepage-sections.js`, funzione principale
`syncHomepageSections(siteId)`.

Logica (stesso principio stateless/ricalcola-tutto di `syncBlogListingPages`,
§Fase 3 punto 9):
1. Leggere `homepage_dynamic_enabled` (9.1) — se non `'true'`, **ritornare
   subito, non toccare nulla** (guardia più importante di questo intero
   round).
2. Leggere `homepage_sections` ordinate per `position`, solo `enabled=true`.
3. Per ciascuna, renderizzare l'HTML secondo il `section_type` (9.3).
4. Concatenare le sezioni + `homepage_custom_css`/`homepage_custom_js` (9.4)
   in un unico blocco HTML.
5. Scrivere il risultato in `pages.content` della riga homepage del sito
   (risolta da `sites.homepage_path` o `/` di default, stessa risoluzione
   già usata da `serve.js`/`static-export.js` — **riusare la stessa
   query/logica, non reinventarla**), **sempre con `layout_mode='wrapped'`**
   (mai forzare standalone qui: la homepage dinamica vive dentro il layout
   del sito, come qualunque altra pagina wrapped), `managed_by='homepage'`
   SOLO ora che è attiva (9.1).
6. Non chiama `exportPublishedPages` da sola — stesso contratto di
   `syncBlogListingPages`, il chiamante lo fa dopo.

**Innesco**: stessi punti di mutazione della Fase 4 (creazione/update/
publish-toggle/delete di un articolo) **più** ogni modifica a
`homepage_sections` o a `homepage_custom_css`/`homepage_custom_js` o al
flag `homepage_dynamic_enabled` stesso. In pratica: ovunque `pages.js` oggi
chiama già `syncBlogListingPages(siteId)` (Fase 4), aggiungere subito dopo
`await syncHomepageSections(siteId).catch(() => {})` — stesso punto, stesso
pattern, una riga in più per innesco, non uno nuovo.

| File | Azione |
|---|---|
| `db/<N>_homepage_sections.sql` | **Nuovo** (numero da verificare al momento, §2.4). Contenuto: §9.3 + §9.5 |
| `src/services/homepage-sections.js` | **Nuovo**. `syncHomepageSections`, riusa `renderCardTemplate`/l'estrazione excerpt da `blog-index.js` (import, non duplicazione — a differenza di `ingest.js` in §7.2, qui i due file sono nello stesso dominio "blog", la condivisione è corretta) |
| `src/services/blog-settings.js` | Estendere `DEFAULTS` con `homepage_custom_css`/`homepage_custom_js` (9.4) |
| `src/routes/pages.js` | Aggiungere la chiamata a `syncHomepageSections` nei punti già individuati in Fase 4 |
| `src/routes/homepage-sections.js` | **Nuovo**. CRUD `/admin/homepage-sections` (list/create/update/delete/reorder) + `POST /admin/homepage-sections/activate` (seeding automatico, 9.2) + `POST /admin/homepage-sections/deactivate` (rimette `managed_by=NULL`, congela il content, 9.2 edge case) |
| `views/admin/homepage-sections/*.ejs` | **Nuove**. Lista sezioni con `position` numerico editabile (niente drag-and-drop in questa fase, scope creep), form per sezione con campi condizionali per `section_type`, toggle "Attiva homepage dinamica" con avviso esplicito del comportamento di 9.2 |
| `src/index.js`, `views/layouts/admin.ejs`, `locales/*.json` | Stesso trattamento di registrazione router/voce di menu/traduzioni già descritto per `categories.js` in Fase 1 — stesso pattern, non ripetuto qui per brevità |
| `test/homepage-sections-sync.test.js` | **Nuovo**. Caso centrale: sito con `homepage_dynamic_enabled` assente/false → `syncHomepageSections` non modifica la riga homepage (verificare `content` e `updated_at` invariati); attivazione → la riga homepage copia il content precedente in una sezione `custom_html` prima di attivare (9.2), verificabile leggendo `homepage_sections` dopo l'attivazione; `category_band` lista solo categorie con articoli pubblicati; `category_feed`/`all_feed` rispettano `articles_limit` e l'ordine `published_at DESC`; **disattivazione**: `managed_by` torna `NULL`, il `content` generato fino a quel momento resta intatto (non si cancella, non torna al valore pre-attivazione), una chiamata successiva a `syncHomepageSections` con il flag `false` non lo modifica più |

### 9.8 Mappatura esplicita vicchina.it → configurazione generalizzata

**Aggiornato con §0.5 punto 3**: questo non è più solo un esempio
illustrativo — è **l'obiettivo reale confermato** per `vicchina.it`. Come
l'homepage attuale si traduce nella configurazione a sezioni:

| Blocco reale oggi in vicchina.it | `homepage_sections` corrispondente |
|---|---|
| `<section class="hero">` | `custom_html`, position 0 (contenuto copiato 1:1 da 9.2) |
| `<section class="formats-band">` ("I format editoriali", 8 card categoria) | `category_band`, position 1 — le 8 categorie (ponte, radar, tech, cultura, cibo, viaggi, lingua, business) diventano righe `categories` con `color`/`icon` (9.5) invece di card HTML scritte a mano |
| `id="feed"` (~230 card articolo, filtro JS per categoria) | `all_feed` con `enable_client_filter=true`, position 2 — le card diventano generate da `blog_card_template` invece che scritte a mano una per una |

### 9.9 DECISO: protocollo di accettazione per l'attivazione reale su `vicchina.it`

**Risposta dell'utente (§0.5 punto 3)**: prima backup + container di
test; "fatto" significa **l'output della pagina dinamica è esattamente
identico a quello attuale** — una barra più alta del semplice "non rompere
nulla" già richiesto per la migrazione metadati (§7.1): qui il `content`
della homepage **viene effettivamente rigenerato** (non solo arricchito di
metadati), quindi l'equivalenza va costruita e verificata, non è
automatica per design come in §7.1.

**Perché è un lavoro di "tuning", non solo di collegamento**: `category_band`
e `all_feed` generano HTML da `blog_card_template`/template categoria
configurabili (§7.2/§9.4) — per essere identici all'HTML scritto a mano
oggi (classi `fcard`, `card`, `card-top`, `card-meta`, struttura esatta
vista in §9 di questo documento), **questi template vanno configurati
per produrre esattamente quella struttura**, non la struttura di default
generica di §7.2. Questo è lavoro di configurazione (via UI, nessun codice
nuovo), ma non banale: va fatto con cura e verificato, non assunto.

**Protocollo passo-passo**:
1. **Backup** del sito `vicchina.it` prima di qualunque modifica:
   `runBackup({siteId: 7, kind: 'full', created_by: 'homepage-dynamic-test'})`
   (stesso meccanismo di §7.4, `src/services/backup-jobs.js`).
2. **Container di test isolato** — stesso protocollo già in uso in questo
   progetto per ogni verifica di questa portata (Docker Postgres
   throwaway, migrazioni, dati reali copiati o un dump del sito), **non un
   meccanismo nuovo da inventare**: è la stessa disciplina di verifica
   isolata già applicata in questa sessione per ogni modifica precedente
   al codice di produzione.
3. Nel container di test: creare le 8 categorie (con color/icon da §9.5,
   valori letti dai glifi/colori reali di vicchina.it), categorizzare gli
   articoli rilevanti (nota: questo passo dipende da §12, non pianificato
   ancora in dettaglio — vedi §11), configurare `category_band` e
   `all_feed` con template tunati per riprodurre la struttura HTML attuale.
4. Attivare `homepage_dynamic_enabled` (seeding automatico da 9.2: il
   contenuto attuale resta come `custom_html` di fallback finché non si
   sostituisce pezzo per pezzo con le sezioni dinamiche, com'è già
   descritto in 9.2 — qui si usa esattamente quel meccanismo di sicurezza,
   non uno nuovo).
5. **Verifica di accettazione**: export statico della homepage nel
   container di test, diff contro l'homepage reale attuale **del body
   visibile** (stesso principio a due controlli di §7.4: body visibile
   byte-identico; eventuali differenze SEO/JSON-LD trattate separatamente,
   non mescolate nello stesso controllo). Iterare la configurazione dei
   template finché il diff è vuoto.
6. **Solo quando il diff è vuoto**: deploy in produzione su `vicchina.it`
   reale, con un secondo backup immediatamente prima (il backup del punto 1
   era per il container di test; un sito reale che sta per cambiare
   davvero la sua homepage merita il proprio backup immediatamente prima
   del deploy reale, non riusare quello più vecchio del test).

**Questo round si considera "fatto" solo al punto 6 completato con
successo** — non prima, non con un'approssimazione "quasi identica".

## 10. ESTENSIONE 4 — Snippet `{{articles:...}}` per liste articoli in qualsiasi pagina

Round aggiunto il 2026-10-10 (richiesto durante la scrittura di §9).
Obiettivo: un blocco riusabile, inseribile a mano in **qualunque** pagina
(non solo nella homepage dinamica di §9) che mostra gli articoli filtrati
per categoria (o tutti, per la homepage) con le date — stesso bisogno delle
sezioni `category_feed`/`all_feed` di §9.3, ma utilizzabile come snippet
libero dentro il contenuto di una pagina qualsiasi, non solo come sezione
homepage strutturata.

### 10.1 Verificato: il sistema snippet esistente è il posto giusto

`src/services/page-renderer.js` (`expandSnippets`, riga 466) già espande
più tipi di placeholder nello stesso contenuto — `{{snippet:nome}}`,
`{{var:nome}}`, `{{form:slug}}`, `{{calendar:slug}}`, `{{quiz:slug}}` — ciascuno
con una propria regex e una propria funzione `expandX`, chiamate in
sequenza dentro lo stesso orchestratore. **Si aggiunge un quinto tipo,
`{{articles:...}}`, stesso pattern esatto, nessuna architettura nuova.**

**Comportamento in caso di errore — verificato e riusato da
`expandCalendars` (riga 249-260)**: se lo slug/parametro non risolve a
nulla, la funzione **lascia il placeholder originale invariato nell'HTML**
(`return full`), non lo rimuove e non lo sostituisce con una stringa vuota
— così un owner che sbaglia a scrivere la categoria SI ACCORGE del
problema guardando la pagina (vede ancora `{{articles:...}}` scritto, non
un buco silenzioso). Stessa scelta anche per `{{articles:...}}`, per
coerenza con lo stile già stabilito in questo file.

### 10.2 Sintassi

```
{{articles:category=viaggi|limit=5|show_date=true}}
{{articles:limit=6}}                         ← nessuna categoria = tutte (caso "in home tutte")
{{articles}}                                 ← tutti i parametri di default
```

Parsing: una nuova regex `ARTICLES_RE = /\{\{articles(?::([^}]*))?\}\}/g`
(il gruppo parametri è intero opzionale, a differenza degli altri 5 tipi
che hanno sempre un identificatore obbligatorio dopo `:` — qui è legittimo
scrivere `{{articles}}` nudo, "dammi gli ultimi articoli con i default").
Parametri (dentro il gruppo, se presente) separati da `|`, ciascuno
`chiave=valore`:
- `category` — slug categoria (non l'id numerico: qui scrive un umano, non
  un agente, lo slug leggibile è quello giusto). Omesso = tutte le
  categorie.
- `limit` — intero, default 6, **tetto massimo 24** (clampare, mai un
  numero arbitrario che potrebbe generare un blocco enorme in una pagina
  pensata per un widget, non per una lista completa — per quello esiste
  già `/blog`, non è lo scopo di questo snippet, vedi 10.4).
- `show_date` — `true`/`false`, default `true` (la richiesta dell'utente
  menziona esplicitamente le date, quindi il default le mostra; disattivabile
  per chi vuole un widget più compatto).

Parametri non riconosciuti: ignorati silenziosamente (non un errore — un
typo in un parametro opzionale non deve rompere la pagina, diverso dal caso
"categoria non trovata" che invece lascia il placeholder visibile perché lì
l'intento era chiaramente quello di mostrare qualcosa di specifico che non
esiste).

### 10.3 Implementazione — riusa il motore già pianificato in §7/§9, non ne crea un altro

`expandArticleLists(siteId, html)` (nuova funzione in `page-renderer.js`):
1. Trova i match di `ARTICLES_RE`, estrae `category`/`limit`/`show_date` per
   ciascuno (parsing dei parametri, funzione pura riusabile).
2. Per ogni combinazione UNICA di parametri trovata nella pagina (una
   pagina può avere più blocchi `{{articles:...}}` con parametri diversi,
   es. uno per "viaggi" e uno per "cibo"): query `pages` con lo stesso
   filtro già usato da `syncBlogListingPages`/`syncHomepageSections`
   (`post_type='article' AND published=true AND (review_status IS NULL OR
   review_status='approved')` — filtro aggiunto in §8.7, stesso motivo
   delle altre 2 superfici —, filtro `category_id` se presente, `ORDER BY
   published_at DESC`, `LIMIT`; `content` nella SELECT per il fallback
   excerpt sotto).
3. Render di ciascun articolo con **lo stesso `renderCardTemplate` +
   `blog_card_template` di sito (§7.2)** — stesso template che genera le
   card dell'indice blog e delle sezioni homepage. **Un solo template da
   configurare in tutto il CMS, non tre template diversi per tre
   meccanismi diversi** — coerenza esplicita, decisione di design di
   questo round. Se `excerpt` è vuoto, stesso fallback `deriveExcerptFromContent`
   di Fase 3/punto 2bis (importata da `blog-index.js`, non duplicata una
   terza volta). Se `show_date=false`, il template viene reso con
   `published_at` sostituito da stringa vuota invece di omettere
   interamente il rendering della data (più semplice: il placeholder
   `{{published_at}}` nel template esiste sempre, qui si passa solo un
   valore vuoto quando non richiesto).
4. Sostituisce ogni match con l'HTML generato (o lo lascia invariato se
   zero risultati per quella combinazione categoria/limite — **zero
   risultati non è un errore**, es. una categoria appena creata senza
   ancora articoli: qui l'HTML generato è semplicemente vuoto, diverso dal
   caso "categoria non trovata" di 10.1 che lascia il placeholder grezzo).

Punto di innesco nell'orchestratore (riga 487-489 di `page-renderer.js`,
già letta in questo documento): aggiungere `result =
await expandArticleLists(siteId, result);` nella stessa catena, dopo
`expandQuizzes` (ultimo, ordine non critico — i 6 tipi di placeholder usano
prefissi diversi, `{{articles` non confonde mai `{{snippet:`/`{{form:`/ecc.,
quindi l'ordine di espansione tra loro è irrilevante per costruzione).

### 10.4 Confine esplicito con `/blog` e con le sezioni homepage (§9) — per non costruire 3 motori che si sovrappongono

- `/blog`, `/blog/categoria/<slug>` (Fase 3): pagine SSR dedicate, con
  paginazione reale, pensate per essere linkate/indicizzate come pagine a
  sé — l'elenco "completo" di un archivio.
- `homepage_sections` (§9.3): composizione STRUTTURATA della sola homepage,
  gestita da UI dedicata (ordine sezioni, attivazione/disattivazione).
- `{{articles:...}}` (questo round): un widget **libero**, incollabile a
  mano in **qualunque** pagina (comprese pagine standalone esistenti come
  quelle di `vicchina.it`, se l'owner decide di incollarci dentro questo
  snippet — anche senza attivare la homepage dinamica di §9), senza
  paginazione, con un tetto massimo (10.2) perché non è pensato per
  sostituire un archivio.

Tutti e 3 condividono lo stesso `blog_card_template` (§7.2) per il
rendering di una singola card — **un solo posto dove personalizzare
l'aspetto delle card**, che si rifletta ovunque. Nessuna duplicazione di
template a 3 velocità diverse.

### 10.5 Compatibilità con l'export statico — nessun innesco nuovo necessario

**Verificato, non assunto**: `expandSnippets` (quindi anche il nuovo
`expandArticleLists`) viene chiamato sia da `serve.js` (rendering live) sia
da `static-export.js` (`exportPage`, riga 67: `await expandSnippets(siteId,
page.content || "")`) per **ogni** pagina esportata, non solo per quelle
`managed_by`. Questo significa che una pagina scritta a mano con dentro un
`{{articles:...}}` (es. una pagina di vicchina.it in cui l'owner decide di
incollare questo snippet, SENZA aver toccato nulla del resto della pagina)
**viene già ri-esportata correttamente quando un articolo cambia**, grazie
al trigger già previsto in Fase 4: lì si chiama sempre
`exportPublishedPages({siteId})` **senza filtro `pageIds`** (export
completo del sito), non solo delle pagine indice/homepage. **Nessun nuovo
punto di innesco da aggiungere in questo round** — è già tutto coperto
dal disegno di Fase 4, una semplice conseguenza fortunata di come era già
stato pianificato, non un caso.

### 10.6 File da toccare in questo round

| File | Azione |
|---|---|
| `src/services/page-renderer.js` | Nuova regex `ARTICLES_RE`, nuova funzione `expandArticleLists(siteId, html)`, innesco nella catena di `expandSnippets` (riga 487-489) |
| `src/services/blog-index.js` | Nessuna modifica necessaria qui: `renderCardTemplate` è già esportata dal round §7 (patch applicata direttamente in §7.2) — questo round si limita a importarla |
| `test/article-snippet.test.js` | **Nuovo**. `{{articles:category=viaggi|limit=3}}` → 3 card della categoria giusta, ordine `published_at DESC`; `{{articles}}` nudo → default (limit 6, tutte le categorie); categoria inesistente → placeholder lasciato invariato nell'HTML (non vuoto, non un errore 500); `limit=999` → clampato a 24; `show_date=false` → nessuna data nell'HTML generato; **zero articoli per una categoria valida ma vuota** → stringa vuota (diverso dal caso categoria inesistente); una pagina con 2 blocchi `{{articles:...}}` diversi (categorie diverse) nello stesso contenuto → entrambi espansi correttamente, nessuna interferenza reciproca |

## 11. Cosa resta esplicitamente fuori scope (per ora)

- **L'esecuzione reale** della migrazione di `vicchina.it`/
  `neparliamoasettembre.it`: il *meccanismo* (bulk-categorize, §7.3) è ora
  pianificato in dettaglio, e le 8 categorie di `vicchina.it` sono state
  **già identificate concretamente** leggendo l'homepage reale (§9.8: Il
  Ponte, Trend & Social, Tech & Innovation, Cultura, Cibo, Viaggi, Lingua,
  Business) — ma **quale delle 355 pagine va in quale delle 8 categorie**
  resta un lavoro editoriale umano (richiede leggere ogni articolo, non
  solo conoscere la lista delle categorie). **Aggiornamento (§0.5 punto
  4)**: l'utente ha confermato che questo lavoro verrà fatto da un agente
  assistito (proposta categoria per articolo, revisione umana) — **round
  futuro, pianificato come §12 ma non ancora dettagliato**: richiederà un
  giro di pianificazione dedicato quando si arriva a questo punto
  dell'esecuzione (dopo §7-§10), non ora. `neparliamoasettembre.it` (302
  pagine) non ha nemmeno un equivalente noto di "I format editoriali": le
  sue categorie restano completamente da definire da zero, probabilmente
  nello stesso round §12 (un agente potrebbe proporre ANCHE le categorie
  stesse leggendo il corpus, non solo assegnare articoli a categorie già
  note come per vicchina.it — dettaglio da decidere quando si arriva lì).
- Tag multipli/multi-categoria (§0.2, deciso contro).
- Ricerca full-text nel blog, filtri avanzati, archivio per data.
- Commenti agli articoli, contatore "visualizzazioni" dedicato (esiste già
  `page_views` generico, riusabile senza modifiche se in futuro serve
  mostrare "articolo più letto").
- Editor WYSIWYG diverso da quello già esistente per `content` — gli
  articoli si scrivono con lo stesso editor HTML delle pagine normali.
- Qualsiasi modifica al layout/design del sito pubblico oltre al minimo
  indispensabile per rendere leggibili indice/categoria/articolo (niente
  redesign dei siti esistenti).
- Riordino drag-and-drop delle `homepage_sections` (§9.7: solo un campo
  `position` numerico in questa fase) e anteprima live del CSS/JS custom
  prima di salvare (§9.4: si salva e si verifica sul sito, nessun editor
  WYSIWYG per lo stile).
- Paginazione dentro il widget `{{articles:...}}` (§10.4: è un widget con
  tetto massimo, non un archivio — per quello restano `/blog` e
  `/blog/categoria/<slug>`, già previsti in Fase 3).

## 12. ESTENSIONE 5 (futura) — Categorizzazione assistita da agente

**Confermata necessaria dall'utente (§0.5 punto 4), non ancora pianificata
in dettaglio** — questa sezione è un segnaposto deliberato, non un piano:
serve a far sì che ogni riferimento a "§12" in questo documento punti a
qualcosa di reale, non a una sezione inesistente.

Quando si arriverà a questo punto (dopo aver completato §7-§10 ed essere
pronti per la migrazione reale dei contenuti), andrà fatto un giro di
pianificazione dedicato che copra almeno: come un agente legge un corpus
di articoli esistenti e propone categoria (e, per `neparliamoasettembre.it`,
probabilmente anche le categorie stesse, non solo l'assegnazione — vedi
§11) per ciascuno; come viene presentata la proposta per la revisione
umana (prima di un'assegnazione in blocco, non dopo); come si integra con
`review_status` (§8.7, già pianificato) — una "proposta di categoria" non
è la stessa cosa di una "bozza di articolo in attesa di approvazione", ma
il meccanismo di revisione umana è concettualmente simile e **andrebbe
valutato se riusarlo invece di inventare un terzo stato** parallelo. Punto
da tenere a mente quando si pianifica §12 davvero, non da risolvere ora.

## 13. APPENDICE — Schema SQL finale consolidato (solo riferimento, non sostituisce le fasi)

**Questo non è un passo da eseguire in un colpo solo** — è un indice
rapido di TUTTE le modifiche allo schema sparse nelle sezioni precedenti
(§2.1-§2.3, §8.7, §9.3, §9.5), raccolte in un unico posto per chi deve
implementare e non vuole rileggere 1800 righe per ricostruire lo schema
finale. **Il piano di esecuzione reale resta quello di §6**: una
migrazione per fase/round, mai tutto insieme (altrimenti si perde la
possibilità di fermarsi dopo ogni fase con `npm test` verde, principio
cardine di §6).

```sql
-- ═══ Fase 1 (§2.1) ═══
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_categories_site_id ON categories(site_id);

-- ═══ Fase 1 (§2.2) — pages ═══
ALTER TABLE pages ADD COLUMN IF NOT EXISTS post_type VARCHAR(20) NOT NULL DEFAULT 'page'
  CHECK (post_type IN ('page', 'article'));
ALTER TABLE pages ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS excerpt TEXT NOT NULL DEFAULT '';
ALTER TABLE pages ADD COLUMN IF NOT EXISTS featured_image TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS author_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS managed_by VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_pages_post_type ON pages(site_id, post_type);
CREATE INDEX IF NOT EXISTS idx_pages_category_id ON pages(category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pages_managed_by ON pages(site_id, managed_by) WHERE managed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pages_published_at ON pages(site_id, published_at DESC) WHERE post_type = 'article' AND published = true;

-- ═══ Fase 1 (§2.3) — page_versions ═══
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS post_type VARCHAR(20) NOT NULL DEFAULT 'page';
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS category_id INTEGER;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS excerpt TEXT NOT NULL DEFAULT '';
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS featured_image TEXT;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- ═══ Round §8.7 — pages.review_status (dopo Fase 1, prima di attivare l'agent API) ═══
ALTER TABLE pages ADD COLUMN IF NOT EXISTS review_status VARCHAR(20)
  CHECK (review_status IN ('pending', 'approved', 'rejected'));

-- ═══ Round §9.3 — homepage_sections (solo se si implementa §9) ═══
CREATE TABLE IF NOT EXISTS homepage_sections (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  section_type VARCHAR(30) NOT NULL
    CHECK (section_type IN ('custom_html', 'category_band', 'category_feed', 'all_feed')),
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL DEFAULT '',
  articles_limit INTEGER NOT NULL DEFAULT 6,
  custom_html TEXT NOT NULL DEFAULT '',
  card_template_override TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_homepage_sections_site_id ON homepage_sections(site_id, position);

-- ═══ Round §9.5 — categories.color/icon (solo se si implementa §9) ═══
ALTER TABLE categories ADD COLUMN IF NOT EXISTS color VARCHAR(20);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS icon VARCHAR(10);
```

**Nuove tabelle**: `categories`, `homepage_sections` (2 totali).
**Tabelle estese**: `pages` (+7 colonne: `post_type`, `category_id`,
`excerpt`, `featured_image`, `published_at`, `author_id`, `managed_by`,
`review_status` — 8 in realtà, contando `review_status` del round §8.7),
`page_versions` (+5 colonne), `categories` stessa (+2 colonne, `color`/
`icon`, se si arriva a §9). **Nessuna tabella esistente viene mai
cancellata o rinominata**, nessuna colonna esistente viene mai rimossa —
solo aggiunte, coerente con `IF NOT EXISTS`/`ADD COLUMN` ovunque (stesso
stile di ogni migrazione già presente in `db/`).

**Numerazione file migrazione effettiva**: da verificare SEMPRE al
momento con `ls db/ | sort -t_ -k1 -n | tail -3` (§2.4) — non assumere i
numeri scritti nelle sezioni precedenti di questo documento, potrebbero
essere stati presi da altro lavoro nel frattempo (verificato realmente
accaduto in questa stessa sessione di pianificazione: un'altra sessione
ha aggiunto un commit al repo — `ee47303`, sicurezza pagamenti/OAuth/SSRF
— mentre questo documento veniva scritto, senza toccare `db/` ma
dimostrando che il repo è condiviso e cambia sotto i piedi).
