# Roadmap CRM — Multi-tenant Platform Features & Extensions

> Versione evolutiva del CMS CMS Admin: niente connettori esterni,
> tutto nativo su Express + Postgres + Caddy. Costruito sopra l'esistente:
> form builder, contatti (CRM-lite con tag/stato/note/valore), pipeline
> vendite, chiamate/calendari, newsletter (campagne+sequenze), quiz con
> punteggi, route agent + tool MCP auto-scoperti.

---

## GIRO 1 — PANORAMICA E SCOPE

### Le 9 funzionalità da integrare

| # | Funzionalità | Cosa risolve | Priorità | Dipendenze |
|---|---|---|---|---|
| F1 | **Segmenti dinamici** | Invii mirati senza liste statiche: query salvate su contatti | 🔴 Alta | contatti esistenti |
| F2 | **Workflow a trigger** | Automazioni "se evento → azioni" (email, tag, stadio, task, notifica) | 🔴 Alta | segmenti, contatti, pipeline, newsletter |
| F3 | **Open/click tracking + UTM** | Dati reali di interazione email e sorgente dei lead | 🔴 Alta | newsletter sends, forms |
| F4 | **Lead scoring continuo** | Punteggio accumulato sul contatto con decadimento + soglie → cambio stadio | 🔴 Alta | contatti, F2/F3 (eventi) |
| F5 | **Task vendite + dashboard funnel** | To-do assegnati agli utenti + vista conversione per canale | 🟠 Media | contatti, pipeline |
| F6 | **A/B test email** | Oggetto/contenuto con variante, vincente al resto | 🟠 Media | newsletter |
| F7 | **Centro preferenze contatto** | Consenso granulare GDPR per canale | 🟠 Media | newsletter, contatti |
| F8 | **Merge contatti duplicati** | Unire stessa email con nomi/tag diversi | 🟢 Bassa | contatti |
| F9 | **Pipeline multiple + stadi custom** | Una board per servizio/nicchia, stadi configurabili | 🟢 Bassa | pipeline |

### Vincoli
- Zero connettori esterni (niente Zapier/Stripe/Slack ecc.) — al momento.
- Tutto esposto all'agente: route `/api/agent/...` + tool MCP auto-scoperti.
- Tutto bilingue (it/en) come l'esistente.
- Ogni funzionalità con test su DB separato `cms_sites_test`.
- Schema: migrazioni numerate incrementali (038+), IF NOT EXISTS.

---

## GIRO 2 — ARCHITETTURA GENERALE

### Principio unificatore: "il contatto è il centro"

Tutte le nuove feature ruotano attorno a `contacts` (già esistente) e a una
nuova **tabella eventi** `contact_events` che registra OGNI azione
significativa: form inviato, quiz completato, email aperta, link cliccato,
chiamata conclusa, tag aggiunto, stadio cambiato. Gli eventi alimentano:
- **F1 segmenti** (filtri su "ha evento X da N giorni"),
- **F2 workflow** (trigger = evento),
- **F4 scoring** (regole = evento → punti),
- **F5 timeline/funnel** (già parzialmente in getContactTimeline).

### Moduli nuovi (file)

| File | Ruolo |
|---|---|
| `db/038_segments.sql` | segmenti + membership |
| `db/039_workflows.sql` | workflow, trigger, azioni |
| `db/040_email_tracking.sql` | eventi email + UTM |
| `db/041_scoring.sql` | regole scoring + punteggio su contatto |
| `db/042_tasks_funnel.sql` | task vendite + vista funnel |
| `db/043_preferences.sql` | preferenze canale contatto |
| `src/services/segments.js` | valutazione segmenti (SQL dinamico) |
| `src/services/workflows.js` | engine trigger→azioni (sync hook + scheduler) |
| `src/services/tracking-email.js` | pixel open + redirect click |
| `src/services/scoring.js` | applica regole, decadimento, soglie |
| `src/services/tasks.js` | CRUD task + scadenze |
| `src/services/preferences.js` | centro preferenze + unsubscribe granulare |

### Punti di aggancio all'esistente (senza toccare il flusso attuale)

1. **Form submit** (`routes/forms.js`): dopo il salvataggio → emetti evento
   `form_submitted` + UTM (se presenti) → `emitContactEvent()`.
2. **Quiz submit** (`routes/quizzes.js`): dopo il salvataggio → evento
   `quiz_completed` con punteggio.
3. **Email** (`services/newsletter.js`): il render HTML ora include pixel
   open (`/track/open/:sendId`) e link riscritti
   (`/track/click/:sendId?u=...`); `newsletter_sends.opened_at` già
   esistente, aggiungiamo `newsletter_send_events` per click.
4. **Chiamate** (`services/calls.js`): al cambio stato → evento
   `call_status_changed`.
5. **Pipeline** (`services/contacts.js setContactStage`): evento
   `stage_changed`.
6. **Scheduler** (`services/scheduler.js`): nuovo tick `runWorkflowEngine()`
   per azioni differite (ritardi, sequenze) + `applyScoringDecay()`.

### Flusso dati tipico (es. qualifica lead)

```
form/quiz submit → upsertContact (esistente)
                → emitContactEvent('quiz_completed', points=12)
                → workflows: trigger match → azioni:
                    add_tag('qualifica-lead-caldo')
                    set_stage('chiamata_fissata')
                    send_email (sequenza/campagna)
                    create_task('Chiama entro 24h', assignee=owner)
                → scoring: +10 punti evento, soglia 50 → stage 'contattato'
                → segmenti: il contatto ora matcha 'Lead caldi' → prossima
                  campagna con target_segment lo include
```

### Regole trasversali
- `emitContactEvent()` è **fire-and-forget con catch** (mai bloccare il
  flusso pubblico con un errore di workflow/scoring).
- L'engine workflow valuta i trigger in modo **asincrono** (coda nel tick)
  per eventi non critici; azioni immediate (tag/stadio) partono subito.
- Tutte le query di segmento usano **parametri** (mai interpolazione).
- Ogni nuovo servizio ha export esplicito e niente side-effect all'import.

---

## GIRO 3 — SCHEMA DB DETTAGLIATO

### 038_segments.sql — Segmenti dinamici

```sql
-- Definizione del segmento: regole JSONB (AND/OR, operatori), valutate da
-- src/services/segments.js contro contact_events + contacts.
CREATE TABLE IF NOT EXISTS segments (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rules JSONB NOT NULL DEFAULT '[]',     -- [{field,op,value,event?,days?}]
  match_mode VARCHAR(10) NOT NULL DEFAULT 'all', -- 'all'|'any'
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, name)
);

-- Membership valutata a ogni evento (o su richiesta): email contatto →
-- segmenti matchati. Serve per target_segment senza ricalcolare tutto.
CREATE TABLE IF NOT EXISTS segment_members (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (segment_id, email)
);
CREATE INDEX IF NOT EXISTS idx_segment_members_site_email ON segment_members(site_id, email);
```

**Formato `rules`** — ogni regola è un oggetto:
```json
{ "field": "tag", "op": "has", "value": "qualifica-lead" }
{ "field": "status", "op": "eq", "value": "lead" }
{ "field": "event", "op": "gte_days_ago", "value": "quiz_completed", "days": 30 }
{ "field": "score", "op": "gte", "value": 50 }
{ "field": "value_estimate", "op": "gte", "value": 5000 }
```
Operatori: `has` (tag), `eq`, `neq`, `gt`, `gte`, `lt`, `lte`,
`contains` (note/email), `gte_days_ago` (evento negli ultimi N giorni),
`lt_days_ago` (evento NON negli ultimi N giorni), `exists` (email non vuota).

### 039_workflows.sql — Workflow a trigger

```sql
CREATE TABLE IF NOT EXISTS workflows (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  trigger_type VARCHAR(50) NOT NULL,  -- form_submitted|quiz_completed|email_opened|email_clicked|call_status_changed|stage_changed|tag_added|contact_created|score_threshold|segment_entered
  trigger_config JSONB NOT NULL DEFAULT '{}',  -- {form_slug?, quiz_slug?, stage?, tag?, min_score?, segment_id?}
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_actions (
  id SERIAL PRIMARY KEY,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  action_order INTEGER NOT NULL,
  action_type VARCHAR(50) NOT NULL,  -- add_tag|remove_tag|set_stage|send_campaign|send_sequence|create_task|notify_email|wait_days|apply_segment
  action_config JSONB NOT NULL DEFAULT '{}',
  UNIQUE(workflow_id, action_order)
);

-- Log esecuzioni: chi ha triggerato cosa e quando (debug + idempotenza).
CREATE TABLE IF NOT EXISTS workflow_runs (
  id SERIAL PRIMARY KEY,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL,
  email VARCHAR(255) NOT NULL,
  trigger_type VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ok',  -- ok|error|skipped
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id, created_at DESC);
```

**Config trigger** (esempi):
```json
{ "trigger_type": "form_submitted", "trigger_config": { "form_slug": "contatti" } }
{ "trigger_type": "quiz_completed", "trigger_config": { "quiz_slug": "qualifica-lead", "min_score": 8 } }
{ "trigger_type": "stage_changed", "trigger_config": { "to_stage": "chiamata_fissata" } }
{ "trigger_type": "score_threshold", "trigger_config": { "min_score": 50 } }
{ "trigger_type": "segment_entered", "trigger_config": { "segment_id": 3 } }
```

**Config azioni** (esempi):
```json
{ "action_type": "add_tag", "action_config": { "tag": "lead-caldo" } }
{ "action_type": "set_stage", "action_config": { "stage": "chiamata_fissata" } }
{ "action_type": "send_campaign", "action_config": { "campaign_id": 12 } }
{ "action_type": "create_task", "action_config": { "title": "Chiama il lead", "due_in_days": 1 } }
{ "action_type": "notify_email", "action_config": { "to": "vendi@dominio.it", "subject": "…", "body": "…" } }
{ "action_type": "wait_days", "action_config": { "days": 2 } }  -- solo in coda differita
```

### 040_email_tracking.sql — Open/click + UTM

```sql
-- Eventi granularità click (open resta su newsletter_sends.opened_at esistente
-- per compatibilità; qui aggiungiamo i click con URL).
CREATE TABLE IF NOT EXISTS newsletter_send_events (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  send_id INTEGER NOT NULL,             -- id in newsletter_sends o newsletter_sequence_sends (decidiamo: email_send_id + kind)
  kind VARCHAR(10) NOT NULL,            -- 'campaign'|'sequence'
  event_type VARCHAR(10) NOT NULL,      -- 'open'|'click'
  url TEXT NOT NULL DEFAULT '',
  email VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nl_send_events_email ON newsletter_send_events(site_id, email, created_at DESC);

-- UTM sul contatto: sorgente del lead, settata dal primo form con utm.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS utm_source VARCHAR(255);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS utm_medium VARCHAR(255);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(255);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_source VARCHAR(255) NOT NULL DEFAULT '';
```

### 041_scoring.sql — Lead scoring

```sql
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS score_updated_at TIMESTAMPTZ;

-- Regola: evento/condizione → punti. Evaluata da services/scoring.js.
CREATE TABLE IF NOT EXISTS scoring_rules (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  event_type VARCHAR(50) NOT NULL,     -- form_submitted|quiz_completed|email_opened|email_clicked|call_status_changed|tag_added|stage_changed|contact_created|manual
  event_filter JSONB NOT NULL DEFAULT '{}',  -- {form_slug?, quiz_slug?, min_score?, tag?, stage?}
  points INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Soglia: quando score >= min_score → azione (es. set_stage, add_tag).
CREATE TABLE IF NOT EXISTS scoring_thresholds (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  min_score INTEGER NOT NULL,
  action_type VARCHAR(50) NOT NULL DEFAULT 'set_stage',  -- set_stage|add_tag|notify_email
  action_config JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(site_id, min_score)
);
```

**Decadimento**: `score = score * 0.95` per ogni giorno senza eventi
(applicato nel tick scheduler, max 1 volta/giorno per contatto).

### 042_tasks_funnel.sql — Task + funnel

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL DEFAULT '',   -- contatto associato (vuoto = generico)
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'open',  -- open|done|cancelled
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tasks_site_status ON tasks(site_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);

-- Funnel: snapshot giornaliero per canale (utm_source) — visite/lead/chiamate/vinti.
CREATE TABLE IF NOT EXISTS funnel_snapshots (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  channel VARCHAR(255) NOT NULL DEFAULT '',
  visits INTEGER NOT NULL DEFAULT 0,
  leads INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  revenue NUMERIC(12,2) NOT NULL DEFAULT 0,
  UNIQUE(site_id, day, channel)
);
```

### 043_preferences.sql — Preferenze contatto

```sql
-- Consenso per canale: 'email'|'sms'|'phone'|'whatsapp' — 'email' esistente
-- via newsletter_subscribers, qui gli altri canali + flag marketing.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pref_email BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pref_sms BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pref_phone BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pref_whatsapp BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pref_marketing BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pref_updated_at TIMESTAMPTZ;

-- Link pubblico "gestisci preferenze": token unico per contatto.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pref_token VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_contacts_pref_token ON contacts(pref_token);
```

---

## GIRO 4 — API AGENT + TOOL MCP

Ogni endpoint sotto `/api/agent/sites/:siteId/...` diventa un tool MCP
auto-scoperto (stesso pattern di forms/quiz). Nomi tool MCP in snake_case.

### F1 — Segmenti
| Metodo | Path | Tool MCP | Descrizione |
|---|---|---|---|
| GET | `/api/agent/sites/:siteId/segments` | `segments_list` | Elenco segmenti |
| POST | `/api/agent/sites/:siteId/segments` | `segments_create` | Crea segmento `{name, rules, match_mode?}` |
| PUT | `/api/agent/sites/:siteId/segments/:segmentId` | `segments_update` | Aggiorna (campi omessi invariati) |
| DELETE | `/api/agent/sites/:siteId/segments/:segmentId` | `segments_delete` | Elimina |
| GET | `/api/agent/sites/:siteId/segments/:segmentId/members` | `segments_members` | Email nel segmento (paginato) |
| POST | `/api/agent/sites/:siteId/segments/:segmentId/recount` | `segments_recount` | Rivaluta membership |
| GET | `/api/agent/sites/:siteId/segments/preview?rules=...` | — | Anteprima match senza salvare (per l'agente) |

### F2 — Workflow
| Metodo | Path | Tool MCP | Descrizione |
|---|---|---|---|
| GET | `/api/agent/sites/:siteId/workflows` | `workflows_list` | Elenco workflow |
| POST | `/api/agent/sites/:siteId/workflows` | `workflows_create` | Crea `{name, trigger_type, trigger_config, actions:[...]}` |
| PUT | `/api/agent/sites/:siteId/workflows/:workflowId` | `workflows_update` | Aggiorna |
| DELETE | `/api/agent/sites/:siteId/workflows/:workflowId` | `workflows_delete` | Elimina |
| GET | `/api/agent/sites/:siteId/workflows/:workflowId/runs` | `workflows_runs` | Log esecuzioni |
| POST | `/api/agent/sites/:siteId/workflows/:workflowId/test` | `workflows_test` | Esegue contro un'email fittizia (dry run) |

### F3 — Tracking email + UTM
| Metodo | Path | Tool MCP | Descrizione |
|---|---|---|---|
| GET | `/track/open/:sendId/:kind` | — (pubblico, pixel) | Registra open, 1x1 gif |
| GET | `/track/click/:sendId/:kind?u=...` | — (pubblico, redirect) | Registra click, 302 alla URL |
| GET | `/api/agent/sites/:siteId/email-stats/:campaignId` | `email_stats_campaign` | Open/click per campagna |
| GET | `/api/agent/sites/:siteId/email-stats/:sequenceId` | `email_stats_sequence` | Open/click per sequenza |
| GET | `/api/agent/sites/:siteId/contacts/:email` | (esistente `contact_timeline`) | + eventi email/UTM nella timeline |

UTM: catturati nei form (`utm_source` ecc. come campi nascosti o query
params) e salvati su `contacts.utm_*` al primo contatto.

### F4 — Scoring
| Metodo | Path | Tool MCP | Descrizione |
|---|---|---|---|
| GET | `/api/agent/sites/:siteId/scoring-rules` | `scoring_rules_list` | Elenco regole |
| POST | `/api/agent/sites/:siteId/scoring-rules` | `scoring_rules_create` | Crea `{name, event_type, event_filter?, points}` |
| PUT | `/api/agent/sites/:siteId/scoring-rules/:ruleId` | `scoring_rules_update` | Aggiorna |
| DELETE | `/api/agent/sites/:siteId/scoring-rules/:ruleId` | `scoring_rules_delete` | Elimina |
| GET | `/api/agent/sites/:siteId/scoring-thresholds` | `scoring_thresholds_list` | Elenco soglie |
| POST | `/api/agent/sites/:siteId/scoring-thresholds` | `scoring_thresholds_create` | Crea `{min_score, action_type, action_config}` |
| DELETE | `/api/agent/sites/:siteId/scoring-thresholds/:thresholdId` | `scoring_thresholds_delete` | Elimina |
| PUT | `/api/agent/sites/:siteId/contacts/:email` | (esistente `contact_update`) | + `score`, `add_score`, `utm_*` nel body |

### F5 — Task + funnel
| Metodo | Path | Tool MCP | Descrizione |
|---|---|---|---|
| GET | `/api/agent/sites/:siteId/tasks` | `tasks_list` | Elenco (filtri: assignee_id, status, email) |
| POST | `/api/agent/sites/:siteId/tasks` | `tasks_create` | Crea `{title, email?, assignee_id?, due_at?, notes?}` |
| PUT | `/api/agent/sites/:siteId/tasks/:taskId` | `tasks_update` | Aggiorna (status done → done_at) |
| DELETE | `/api/agent/sites/:siteId/tasks/:taskId` | `tasks_delete` | Elimina |
| GET | `/api/agent/sites/:siteId/funnel` | `funnel_overview` | Snapshot conversione per canale/giorno |

### F7 — Preferenze
| Metodo | Path | Tool MCP | Descrizione |
|---|---|---|---|
| GET | `/preferences/:token` | — (pubblico) | Pagina centro preferenze |
| POST | `/preferences/:token` | — (pubblico) | Aggiorna preferenze |
| GET | `/api/agent/sites/:siteId/contacts/:email` | (esistente) | + `pref_*` nella risposta |
| PUT | `/api/agent/sites/:siteId/contacts/:email` | (esistente) | + `pref_*` nel body |
| POST | `/api/agent/sites/:siteId/contacts/:email/pref-token` | `contact_pref_token` | Genera token (per link in email) |

### F8 — Merge
| Metodo | Path | Tool MCP | Descrizione |
|---|---|---|---|
| POST | `/api/agent/sites/:siteId/contacts/:email/merge` | `contact_merge` | Unisce un contatto in un altro `{into_email, strategy?}` |

### F9 — Pipeline multiple + stadi
| Metodo | Path | Tool MCP | Descrizione |
|---|---|---|---|
| GET | `/api/agent/sites/:siteId/pipelines` | `pipelines_list` | Elenco pipeline |
| POST | `/api/agent/sites/:siteId/pipelines` | `pipelines_create` | Crea `{name, stages:[{key,label}]}` |
| PUT | `/api/agent/sites/:siteId/pipelines/:pipelineId` | `pipelines_update` | Aggiorna stadi |
| DELETE | `/api/agent/sites/:siteId/pipelines/:pipelineId` | `pipelines_delete` | Elimina (contatti → pipeline default) |
| PUT | `/api/agent/sites/:siteId/contacts/:email` | (esistente) | + `pipeline_id` nel body |

### Autenticazione e autorizzazione
- Route agent: `requireAuth + requireAgent + canAccessSite` (stesso pattern).
- Route pubbliche (`/track/*`, `/preferences/:token`): rate-limit dedicato,
  niente auth (token opaco nell'URL = chiave di accesso).
- `pref_token`: generato con `crypto.randomBytes(32).toString('hex')`.

---

## GIRO 5 — ADMIN UI

Nuove viste sotto `views/admin/`, stesse convenzioni (layout admin,
bootstrap-like inline, sidebar con `t('nav.*')`).

### Sidebar (aggiunte)
```
Segmenti     → /admin/segments
Automazioni  → /admin/workflows
Task         → /admin/tasks
Funnel       → /admin/funnel
```
(Scoring, preferenze e tracking sono gestiti dentro Contatti/Newsletter,
non voci separate per non affollare.)

### F1 — Segmenti (`views/admin/segments/`)
- `index.ejs`: lista con nome, n° membri (COUNT da segment_members), stato.
- `builder.ejs`: editor regole visuale — righe "campo operatore valore",
  match_mode all/any, aggiungi/rimuovi regola, JSON preview.
- `members.ejs`: elenco email nel segmento con ricerca e paginazione.

### F2 — Workflow (`views/admin/workflows/`)
- `index.ejs`: lista workflow con trigger e stato attivo/disattivo.
- `builder.ejs`: form a 3 sezioni:
  1. Trigger: select tipo + config dinamica (form_slug/quiz_slug/stage/...),
  2. Azioni: lista ordinata con tipo + config per riga,
  3. Test: box "email di prova" → esegue dry-run e mostra azioni che
     sarebbero partite.
- `runs.ejs`: tabella esecuzioni (email, trigger, status, errore, data).

### F5 — Task (`views/admin/tasks/`)
- `index.ejs`: board/list con filtri (assignee, status, scadenza) + checkbox
  "done", link al contatto.
- Form creazione task con autocomplete email contatti.

### F5 — Funnel (`views/admin/funnel/`)
- `index.ejs`: tabella conversione per canale e per giorno (visite → lead →
  chiamate → vinti + revenue), selettore range date.

### F3 — Tracking (dentro Newsletter)
- `views/admin/newsletter/campaign_stats.ejs` (nuova): open rate, click rate,
  top URL cliccati, per destinatario.
- Riusa `views/admin/newsletter/sequence_stats.ejs` per le sequenze.

### F7 — Preferenze
- Pagina pubblica `views/preferences.ejs` (no layout admin): checkboxes
  email/sms/phone/whatsapp/marketing + button salva.
- Nel dettaglio contatto (`views/admin/contacts/detail.ejs`): sezione
  preferenze con link "copia link preferenze" (pref_token).

### F9 — Pipeline multiple
- `views/admin/pipeline/index.ejs` (modificata): dropdown pipeline in alto +
  board per la pipeline selezionata.
- `views/admin/pipeline/edit.ejs` (nuova): crea/edita pipeline con stadi
  (key+label), riordino.

### Pattern comuni
- Ogni builder serializza la config in un `<input type="hidden">` JSON al
  submit (come `fields_json` dei form / `questions_json` dei quiz).
- Conferma su delete (`confirm()`), badge attivo/disattivo.
- Tutte le stringhe via `t()` it/en.

---

## GIRO 6 — INTEGRAZIONI CON L'ESISTENTE (dettaglio di aggancio)

### 6.1 Form submit (`routes/forms.js`)
Dopo `INSERT INTO form_submissions` e prima del redirect:
```js
// UTM: catturati da campi nascosti nel form o query params della pagina.
const utm = {
  utm_source: req.body.utm_source || req.query.utm_source || null,
  utm_medium: req.body.utm_medium || req.query.utm_medium || null,
  utm_campaign: req.body.utm_campaign || req.query.utm_campaign || null,
};
if (email) {
  await recordContactUtm(siteId, email, utm);          // solo se vuoti (prima origine)
  emitContactEvent(siteId, email, "form_submitted", { form_slug: formSlug, utm });
}
```
`emitContactEvent` è importato da `services/events.js` (nuovo, centrale):
```js
export async function emitContactEvent(siteId, email, eventType, payload = {}) {
  try {
    await query(
      `INSERT INTO contact_events (site_id, email, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [siteId, email, eventType, JSON.stringify(payload)]
    );
    // sincrono (ma con try/catch): workflow immediati + scoring + segmenti
    await applyWorkflows(siteId, email, eventType, payload).catch(...);
    await applyScoring(siteId, email, eventType, payload).catch(...);
    await refreshSegmentsForContact(siteId, email).catch(...);
  } catch (err) { logger.error(...); }
}
```
**Decisione**: `contact_events` è una tabella nuova (migrazione 038) che
unisce la timeline eventi — evita di fare query separate per workflow/
scoring/segmenti e dà il dettaglio per la timeline contatto.

### 6.2 Quiz submit (`routes/quizzes.js`)
Dopo il salvataggio in `quiz_submissions`:
```js
if (email || true) {
  const contactEmail = email || /* email dal quiz se ask_email */ null;
  if (contactEmail) {
    emitContactEvent(siteId, contactEmail, "quiz_completed",
      { quiz_slug: quizSlug, points: totalPoints, result: resultTitle });
  }
}
```
Nota: se il quiz NON ha ask_email, non c'è email → niente evento contatto
(ma la submission resta). L'evento `quiz_completed` con `min_score` nel
trigger workflow copre il caso "punteggio alto → azione".

### 6.3 Email send (`services/newsletter.js`)
- `renderEmailHtml()` (nuovo helper in `services/tracking-email.js`):
  ```js
  export function injectTracking(html, { siteId, sendId, kind, baseUrl }) {
    // 1. pixel open: <img src="BASE/track/open/SENDID/KIND" width="1" height="1">
    // 2. riscrive TUTTI i <a href="..."> con /track/click/SENDID/KIND?u=URL_ENCODED
    //    (solo URL http/https; mailto/tel/# lasciati invariati)
  }
  ```
- Chiamato in `sendCampaignBatch()` e `sendSequenceSteps()` dopo il render,
  con `sendId` = id della riga `newsletter_sends`/`newsletter_sequence_sends`
  (già creata prima dell'invio).
- Route pubbliche in `routes/tracking.js`:
  - `GET /track/open/:sendId/:kind` → aggiorna `opened_at`/`open_count` se
    vuoto, inserisce `newsletter_send_events`, risponde 1x1 trasparente GIF.
  - `GET /track/click/:sendId/:kind?u=...` → stesso + inserisce click,
    302 verso `u` (validato: http/https, altrimenti "/").
- **Validazione URL click**: niente `javascript:`, niente protocolli strani,
  max 2048 char. Redirect a URL non validi → 302 a "/".

### 6.4 Chiamate (`services/calls.js`)
Dove `updateCall` cambia `status`:
```js
emitContactEvent(siteId, call.email, "call_status_changed", { status, call_id });
```
(Chiamata anche da `calls_book` → evento `call_booked`.)

### 6.5 Pipeline (`services/contacts.js setContactStage`)
Dopo l'UPDATE di `status`:
```js
emitContactEvent(siteId, email, "stage_changed", { to_stage: stage });
```
E su `setContactFields` con `tags`: se aggiungiamo un tag → evento
`tag_added` con `{tag}` (uno per tag nuovo).

### 6.6 Newsletter target
- `newsletter_campaigns.target_tag` resta (compatibilità). Aggiungiamo
  `target_segment_id INTEGER REFERENCES segments(id) ON DELETE SET NULL`
  su `newsletter_campaigns` e `newsletter_sequences` (migrazione 043):
  - se valorizzato → destinatari = segment_members del segmento
    ∩ iscritti confermati;
  - se valorizzato insieme a target_tag → intersezione (entrambi).
- In `sendCampaignBatch()`: la query di destinatari cambia in
  `SELECT s.id, s.email FROM newsletter_subscribers s
   JOIN segment_members m ON m.email = s.email AND m.segment_id = $X
   WHERE s.site_id = $1 AND s.status = 'confirmed' ...`

### 6.7 Contatti detail (`views/admin/contacts/`)
- Mostra score, UTM, preferenze, ultimi eventi (da contact_events).
- Bottone "mergia in..." (F8).
- Bottone "copia link preferenze" (F7).

### 6.8 Pipeline (F9) — minimo invasivo
- Tabella `pipelines` con `stages JSONB` + `contacts.pipeline_id`:
  ```sql
  CREATE TABLE IF NOT EXISTS pipelines (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    stages JSONB NOT NULL DEFAULT '[]',   -- [{key,label}]
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pipeline_id INTEGER
    REFERENCES pipelines(id) ON DELETE SET NULL;
  ```
- Se `contacts.pipeline_id` NULL → pipeline di default del sito (o la
  legacy board con stadi fissi se nessuna pipeline custom).
- `PIPELINE_STAGES` legacy resta per compatibilità: una pipeline "default"
  con quegli stadi viene creata al seed se il sito non ne ha.

### 6.9 Merge (F8)
`POST /contacts/:email/merge {into_email}`:
1. Upsert del contatto destinazione.
2. Unisce tags (union), notes (concat), score (max), value_estimate (max),
   status (del più avanzato per ordine pipeline), UTM (primo non vuoto).
3. Riaggancia: form_submissions.email → into (aggiorna), quiz_submissions,
   calls, tasks, newsletter_subscribers (se assente), segment_members,
   contact_events → into (aggiorna email).
4. Elimina il contatto sorgente.

---

## GIRO 7 — PIANO TEST DETTAGLIATO

Tutti i test su DB separato `cms_sites_test`, pattern `node:test` +
helpers esistenti (`createTestSite`, `createTestUser`, `closeDb`).

### File di test nuovi

| File | Copre |
|---|---|
| `test/segments.test.js` | F1: CRUD segmenti, valutazione regole, membership |
| `test/workflows.test.js` | F2: engine trigger→azioni, idempotenza, errori |
| `test/email-tracking.test.js` | F3: pixel open, click redirect, UTM su contatto |
| `test/scoring.test.js` | F4: regole, accumulo, soglie, decadimento |
| `test/tasks-funnel.test.js` | F5: CRUD task, chiusura, snapshot funnel |
| `test/preferences.test.js` | F7: token, pagina pubblica, aggiornamento |
| `test/merge.test.js` | F8: unione contatti con riaggancio |
| `test/pipelines.test.js` | F9: CRUD pipeline, stadi custom, contatti |

### Casi chiave per modulo

**F1 segments**
1. Crea segmento con regola `tag has X` → membership vuota finché non c'è il
   tag.
2. Aggiungi tag al contatto → evento → refresh segmenti → contatto in
   `segment_members`.
3. Regola `event gte_days_ago quiz_completed days 30` → match solo se evento
   recente; evento vecchio (backdate) → no match.
4. `match_mode: any` → basta una regola su due.
5. `preview` senza salvare: stessi risultati del salvataggio.
6. Delete segmento → membership pulita (cascade).

**F2 workflows**
1. Trigger `form_submitted` con `form_slug` → submit form con email → le
   azioni partono (add_tag, set_stage).
2. Trigger `quiz_completed` con `min_score` → punteggio sotto soglia →
   nessuna azione; sopra → azioni.
3. Idempotenza: stesso evento duplicato non ri-esegue `send_campaign` (check
   su workflow_runs + flag già inviato).
4. `wait_days` azione: crea riga in coda differita, il tick scheduler la
   processa dopo N giorni (test con backdate).
5. Workflow disattivato → nessuna esecuzione.
6. `workflows_test` dry-run: nessun side-effect, elenca azioni.

**F3 email-tracking**
1. `injectTracking` aggiunge pixel e riscrive link http/https; NON tocca
   mailto/tel/#.
2. GET `/track/open/:sendId/campaign` → 1x1 gif, `opened_at` settato,
   `newsletter_send_events` con open.
3. GET `/track/click/:sendId/campaign?u=https://...` → 302 a URL, evento
   click registrato.
4. Click con `u=javascript:...` → 302 a "/" (mai eseguire).
5. UTM: form submit con `utm_source=facebook` → contatto `utm_source`=facebook
   al primo contatto; secondo submit con utm diverso → invariato (prima
   origine).

**F4 scoring**
1. Regola `quiz_completed points +10` → evento → score 10.
2. Soglia `min_score 10 → set_stage contattato` → scatta al raggiungimento.
3. Decadimento: backdate score_updated_at di 2 giorni → tick → score *0.95².
4. Regola disabilitata → nessun punto.

**F5 tasks-funnel**
1. CRUD task, `status done` → `done_at` settato.
2. Filtro per assignee/status.
3. Snapshot funnel: chiama `buildFunnelSnapshot(siteId)` → righe per canale
   con conteggi coerenti (visite da page_views, lead da form_submissions,
   calls da calls, wins da contacts status=vinto, revenue sum value_estimate).

**F7 preferences**
1. Genera pref_token → pagina GET `/preferences/:token` 200.
2. POST aggiorna `pref_sms` → persistito.
3. Token inesistente → 404.
4. Link in email: `{{pref_url}}` placeholder sostituito nel render.

**F8 merge**
1. Due contatti con tag diversi → merge → tags union, contatti riagganciati,
   sorgente eliminato.
2. Merge su stesso email → idempotente (niente errori).

**F9 pipelines**
1. Crea pipeline con stadi custom → contatto assegnato → board mostra la
   pipeline giusta.
2. Delete pipeline → contatti tornano a pipeline default.
3. Pipeline default seed → esiste per sito senza pipeline.

### Regressione
- Suite completa esistente (113 test) deve restare verde.
- Test route-order: nuove route `/api/agent/.../segments` ecc. NON devono
  collidere con le route parametriche esistenti (es. `/contacts/:email`).
  Attenzione: `GET /api/agent/sites/:siteId/segments/preview` va registrata
  PRIMA di `/segments/:segmentId` (stessa regola di `/forms/search`).

---

## GIRO 8 — SICUREZZA, GDPR, PERFORMANCE

### Sicurezza
1. **SQL injection**: tutte le query nuove con parametri `$n`. Le regole dei
   segmenti NON vengono interpolate in SQL: il valutatore traduce ogni
   regola in una condizione con placeholder (whitelist di campi/operatori).
   Regola sconosciuta → ignorata, mai errore.
2. **Rate limiting**:
   - `/track/open` e `/track/click`: limiter dedicato (es. 60/min per IP,
     skip per bot noti) — un pixel può essere colpito migliaia di volte.
   - `/preferences/:token`: 10/min per IP.
   - Route agent: già coperto da `agentLimiter` (120/min).
3. **pref_token**: 32 byte random hex, comparazione case-sensitive; il token
   è l'unica chiave per la pagina pubblica (niente auth). Generato
   on-demand, rigenerabile. Invalidate vecchi token su merge.
4. **Open/click tracking e privacy**: l'email del contatto è nel path del
   pixel? NO — usiamo `send_id` (numero opaco). L'email si risale lato
   server dalla riga `newsletter_sends` (join con subscriber). Mai email in
   chiaro negli URL pubblici.
5. **URL click**: solo `http:`/`https:`, max 2048 char, niente `@` come
   username (evita `https://evil.com@trusted.com`), niente CRLF. Redirect
   con `res.redirect(302, url)`.
6. **Workflow azioni**: `send_campaign` con `campaign_id` inesistente →
   errore loggato, non crash. `notify_email` destinatario libero ma limitato
   a email valida (regex). `create_task` assignee deve appartenere al sito.
7. **Merge**: solo admin/agent autorizzati, verifica `canAccessSite` su
   entrambe le email. Transazione unica (BEGIN/COMMIT/ROLLBACK) — se un
   passaggio fallisce, niente merge parziale.
8. **Auth agent**: ogni nuova route `requireAuth + requireAgent +
   canAccessSite`, stesso pattern.

### GDPR
1. **Base giuridica**: il tracking open/click è legittimo interesse se
   dichiarato nella privacy policy (già esistente sul sito); il consenso
   marketing resta per l'email (doppio opt-in esistente). Le preferenze
   canale (F7) danno il controllo granulare all'utente.
2. **Right to erasure** (`DELETE /contacts/:email` esistente): ora deve
   pulire ANCHE `contact_events`, `newsletter_send_events`,
   `segment_members`, `workflow_runs`, `tasks` (email del contatto) —
   aggiornare la cancellazione GDPR esistente.
3. **Right to access** (`GET /contacts/:email` esistente): includere
   `contact_events` (storico azioni), `newsletter_send_events`,
   `tasks`, `score`, UTM, preferenze — export JSON completo.
4. **Data retention**: `contact_events` — opzione di cleanup dopo X mesi
   (config per sito, default off; se attiva, DELETE eventi > X mesi).
5. **Pixel e consenso**: il pixel open parte solo su email già inviate a
   chi ha acconsentito alla newsletter (la sequenza/campagna arriva solo a
   iscritti confermati). Nessun nuovo consenso necessario per il
   tracciamento interno della delivery, ma va dichiarato in privacy policy.

### Performance
1. **Index**: tutte le nuove colonne filtrate hanno index (già in schema):
   `contact_events(email, created_at)`, `newsletter_send_events(email)`,
   `segment_members(segment_id)`, `tasks(site_id,status,due_at)`,
   `funnel_snapshots(site_id,day)`.
2. **Segmenti**: la membership è materializzata (segment_members) e
   aggiornata incrementalmente a ogni evento — mai ricalcolo full-scan al
   momento dell'invio. `recount` è l'eccezione, manuale.
3. **Eventi**: `contact_events` cresce — limitare le INSERT con batch,
   niente loop per singolo evento (emitContactEvent fa 1 INSERT + i
   consumatori in parallelo con `Promise.allSettled`).
4. **Workflow engine**: un tick elabora max N workflow (es. 50) per sito
   per evitare picchi; azioni email passano dal rate-limit newsletter
   esistente (rate_per_hour).
5. **Tracking redirect**: `/track/click` è hot path — 1 UPDATE + 1 INSERT,
   poi 302. Nessuna query pesante. La GIF open è servita da costante
   statica (buffer in memoria).
6. **Funnel snapshot**: calcolo giornaliero nel tick (una query per sito),
   non al volo sulla dashboard (che legge funnel_snapshots).

### Robustezza
- `emitContactEvent` è dentro try/catch: un errore di workflow/scoring NON
  deve mai far fallire il submit del form pubblico (già regola trasversale).
- Workflow ricorsivi (workflow A → azione che triggera workflow B → ...):
  max 3 livelli di profondità, poi stop (guard su workflow_runs in catena).
- Loop di segmenti: refresh segmenti non ri-triggera workflow `segment_entered`
  in modo infinito (flag `source=segment_refresh` ignorato dai trigger).

---

## GIRO 9 — ROLLOUT E RISCHI

### Ordine di implementazione (per dipendenze)

| Step | Functionality | Rationale |
|---|---|---|
| 1 | F3 base: `contact_events` + `emitContactEvent` | Fondamento di tutto (eventi centrali) |
| 2 | F1 Segmenti | Consuma eventi; è prerequisito di F2 (segment_entered) |
| 3 | F4 Scoring | Consuma eventi; soglie usano azioni di F2 |
| 4 | F2 Workflow | Engine che consuma eventi + segmenti + scoring |
| 5 | F5 Task + Funnel | Indipendente, consuma eventi/chiamate/pipeline |
| 6 | F3 email tracking (pixel/click/UTM) | Tocca newsletter; eventi email |
| 7 | F7 Preferenze | Dipende da contatti; link in email dopo F3 |
| 8 | F8 Merge | Consolida contatti; utile dopo le altre |
| 9 | F9 Pipeline multiple | Ultima perché tocca la board esistente |

Each step: database migration → service implementation → agent route → MCP tool → admin view →
tests → deployment (following the iterative development cycle).

### Rischi e mitigazioni

| Rischio | Prob. | Impatto | Mitigazione |
|---|---|---|---|
| Workflow ricorsivi (loop A→B→A) | Media | Alto (spam email, DB pieno) | Guard profondità 3, idempotenza via workflow_runs, max azioni/tick |
| Segmento malformato rompe l'invio newsletter | Bassa | Medio (campagna a lista sbagliata) | Valutatore con whitelist: regola sconosciuta ignorata; preview prima di salvare; test |
| `contact_events` cresce senza limite | Alta | Medio (disco/performance) | Retention configurabile, index, cleanup periodico |
| Tracking email visto come spam | Media | Alto (deliverability) | Pixel leggero, dominio tracking sul proprio dominio, SPF/DKIM già ok |
| Merge sbagliato perde dati | Bassa | Alto | Transazione unica + backup contatto pre-merge nel log |
| Pipeline custom rompe la board legacy | Media | Medio | Pipeline default con stadi legacy al seed; fallback se pipeline_id NULL |
| Route `/segments/preview` catturata da `:segmentId` | Media | Medio (400/404) | Registrare route statiche PRIMA di parametriche (test route-order) |
| Emoji/entità nelle label tag | Bassa | Basso | Normalizzazione tag, limiti length |

### Rollout per sito
1. Le feature nuove sono **globali ma opt-in per sito**: nessun workflow/
   segmento/scoring attivo finché l'admin non ne crea uno. Zero impatto sui
   siti che non le usano (Site A, Example Site restano identici).
2. `emitContactEvent` parte subito (registra eventi) ma i consumatori
   (workflow/scoring/segmenti) non fanno nulla senza definizioni.
3. F3 email tracking: attivo solo se il sito ha SMTP configurato (come
   oggi) — le email inviate ora includono pixel/link riscritti. Se un sito
   non vuole tracking, variabile `tracking_email_enabled` (default true).
4. Verifica post-deploy per each iteration: health, endpoint multi-tenant,
   log senza errori.

### Verifica finale pre-merge
- `npm test` su `cms_sites_test` → suite completa verde (113 + nuovi).
- `node --check` su tutti i file modificati.
- Test manuale: crea segmento → compila form → contatto nel segmento →
  workflow parte → score aumenta → task creata.

---

## GIRO 10 — METRICHE E MANUTENZIONE

### KPI da misurare (dashboard analytics)

**Email**
- Open rate = destinatari con ≥1 open / inviati
- Click rate = destinatari con ≥1 click / inviati
- CTOR = click / aperti (qualità oggetto+contenuto)
- Top URL cliccati (per campagna/sequenza)

**Funnel (per canale UTM)**
- Visite → lead (form compilati) → chiamate → vinti
- Conversion rate per stadio, tempo medio lead→vinto
- Revenue attesa (somma value_estimate dei vinti) per canale

**Pipeline**
- Numero lead per stadio, valore totale per stadio
- Velocità: giorni da lead a vinto (mediana)
- Win rate = vinti / (vinti+persi)

**Workflow/automazione**
- Esecuzioni per workflow (da workflow_runs), errori, azioni più usate
- Segmenti: n° membri per segmento, crescita nel tempo

**Task**
- Aperti/scaduti/completati per assignee, tasso completamento

### Manutenzione programmata (scheduler tick, già ogni 60s)

| Task | Frequenza | Nota |
|---|---|---|
| `applyScoringDecay()` | giornaliero (1×/giorno per contatto) | score * 0.95 per giorno senza eventi |
| `buildFunnelSnapshots()` | giornaliero | snapshot per sito/canale |
| `runWorkflowEngine()` | ogni tick | azioni differite (wait_days) |
| `refreshSegmentsForContact()` | su evento | incrementale, non batch |
| Cleanup `contact_events` | settimanale (se retention attiva) | DELETE eventi > N mesi |
| Cleanup `workflow_runs` | settimanale | DELETE runs > 90 giorni |

### Estensioni future (in future versions)
- **A/B test email** (F6): variante soggetto/contenuto, split 50/50, dopo X
  ore la vincente al resto — richiede solo una colonna `variant_of` su
  newsletter_campaigns + logica in sendCampaignBatch.
- **Campagne multi-step a tempo** (workflow con `wait_days` già previsto).
- **Notifiche Slack/Telegram** (unico "connettore" che potrebbe servire
  presto — da decidere quando serve).
- **Import CSV contatti** (per iniziare a usare il CRM senza dover creare
  lead a mano).
- **API webhook in uscita** (quando servirà sincronizzare con altri
  sistemi — oggi escluso per scelta).

### Convenzioni di codice per chi mantiene
- Servizi nuovi in `src/services/*.js` con export esplicito, niente
  side-effect all'import.
- Route agent in `src/routes/agent.js` (o modulo dedicato importato da
  agent.js) — le route nuove vanno SEMPRE con `requireAuth, requireAgent`.
- Tool MCP: aggiungere entry in `TOOL_META` di `mcp-tools.js` per nome/
  descrizione/schema leggibili; senza entry il tool esiste comunque
  (generico), quindi un endpoint dimenticato non rompe nulla.
- Migrazioni: numerate, idempotenti (`IF NOT EXISTS`), una per feature.
- Test: un file per modulo, sempre su DB test separato.
- Docs: AGENT.md/MCP.md bilingual, updated after each deployment
  (the `cms-api` documentation reflects the current API state).

### Stato finale atteso dopo questa roadmap
```
form/quiz submit
   └→ contact_events (storico azioni)
       ├→ segmenti dinamici (membership materializzata)
       ├→ workflow a trigger (tag/stadio/email/task/notifica)
       ├→ lead scoring (punti + decadimento + soglie)
       └→ timeline contatto (admin + GDPR export)
email inviate → open/click tracking (pixel + redirect sicuri)
contatti → UTM sorgente, preferenze canale, merge duplicati
pipeline → multiple per servizio, stadi custom
task → to-do assegnati, funnel → conversione per canale
tutto esposto all'agente via REST + MCP, tutto testato
```

---

# Future roadmap — Roadmap operativa (26-44) — 15/08/2026

> ✅ **STATO: COMPLETATA (15/08/2026)** — tutte le 18 voci (27-44)
> implementate, 312 test verdi, 301 tool MCP. Dettagli nella sezione
> "Future roadmap — Roadmap operativa completata" in AGENT.md (it/en).

> Dopo la Core features (segmenti, workflow, scoring, task/funnel, tracking,
> preferenze, merge, pipeline, note + conversazioni). Obiettivo: far
> diventare il CMS il **sistema operativo del lavoro di vendita e del
> collega digitale**, mantenendo il principio "tutto nativo, tutto via
> API agent/MCP, tutto testato".

## Vincolo architetturale — WhatsApp esterno (NON nativo)

**Il CMS NON integra WhatsApp direttamente** (niente API cloud native, niente
provider). La tabella `conversations` ha già il canale `whatsapp` come
**registro unico**: i messaggi in/out li scrive un **motore esterno Baileys**
(es. WhatsApp bot) chiamando `POST /api/agent/.../conversations/whatsapp/messages`.
Il CMS resta l'archivio, il bot resta il trasporto. Ogni futuro canale
(chat, Instagram, Telegram) seguirà lo stesso pattern: registro nel CMS +
trasporto esterno.

## P1 — Vendite e CRM avanzato (26-28)

| # | Funzionalità | Cosa risolve | Dipendenze |
|---|---|---|---|
| 26 | **Opportunità/affari** (stadi, importo, probabilità) + **preventivi PDF** con stato inviato/visto/firmato | Pipeline senza buchi: valore × probabilità, documenti tracciabili | pipeline (F9), media, variabili |
| 27 | **Task ricorrenti + follow-up intelligente** ("aspetta risposta → se 3 giorni senza risposta avvisa") | Niente dimenticanze, re-engagement automatico | tasks (F5), workflow (F2), contatti |
| 28 | **Ruoli/permessi granulari, turni operatori, audit log** | Multi-operatore sicuro, chi ha fatto cosa | users, audit_log esistente |

### Preventivi PDF — nota di design
PDF generati **server-side senza dipendenze esterne** (modulo `pdfkit`
nativo Node, nessun microservizio): template da variabile/snippet,
stato `inviato → visto → firmato` su tabella dedicata, link di visualizzazione
firmato con token (pattern `pref_token` già esistente). La firma può essere
un click di conferma (niente firma grafometrica per ora).

## P2 — Agenti AI: il collega eseguito (29-34)

| # | Funzionalità | Cosa risolve | Dipendenze |
|---|---|---|---|
| 29 | **Runtime conversazionale per canale** | Risponde su WA/chat/email con regole per contatto | conversazioni (044), preferenze, workflow |
| 30 | **Knowledge base aziendale** (listini, FAQ, procedure) + ricerca semantica | Risposte coerenti, non inventate | variabili, snippet, ricerca |
| 31 | **Agent builder visuale + sandbox di test** | Configurare il collega senza codice | admin, workflow |
| 32 | **Human-in-the-loop**: coda di approvazione, takeover con un clic | L'umano controlla sempre | task, notifiche, conversazioni |
| 33 | **Riepilogo IA delle chiamate** | Chiamata → riassunto, azioni, next step | calls, workflow |
| 34 | **Proposta di risposta all'operatore** | L'operatore risponde in un clic | conversazioni, KB |

### Runtime conversazionale (29) — nota tecnica
**Pezzo grosso, pensato come servizio SEPARATO** che parla col CMS via API
(nessuna modifica al core): legge le conversazioni con
`GET /api/agent/.../conversations/:id/messages`, decide la risposta
(regole per contatto + KB), la scrive come `direction: out` e — per
WhatsApp — **delega l'invio al bot Baileys** (WhatsApp bot), che a sua volta
registra l'esito. n8n può fare da orchestratore. Ogni canale rispetta le
**preferenze GDPR già esistenti** (`pref_whatsapp`, `pref_email`, ecc.):
mai scrivere né inviare su un canale non consentito.

## P3 — Integrazioni e dati (35-44)

| # | Funzionalità | Priorità |
|---|---|---|
| 35 | Webhook in/out (collegare n8n) | alta |
| 36 | OAuth Google (Gmail, Calendar, Drive) | media |
| 37 | Sync calendario bidirezionale | media |
| 38 | Link di pagamento Stripe | media |
| 39 | Export/import completo | alta |
| 40 | Dashboard realtime (lead per canale, SLA, KPI) | alta |
| 41 | Report periodici ai clienti | bassa |
| 42 | Sandbox/staging | media |
| 43 | Backup automatici | alta |
| 44 | Quote/rate-limit per canale con avvisi | media |

## Percorso consigliato (ordine di implementazione)

1. **26 preventivi PDF** (alto valore, dipende solo dal già esistente) →
2. **27 follow-up intelligente** (un trigger workflow in più) →
3. **28 ruoli/permessi** (sblocca multi-operatore) →
4. **35 webhook in/out + 39 export/import** (fondamenta integrazioni) →
5. **29 runtime conversazionale + 30 KB + 32 HITL** (il collega digitale,
   con WhatsApp bot/Baileys come trasporto WhatsApp) →
6. **40 dashboard realtime** (rendere visibile tutto) →
7. resto del P3 a seguire.

## Regole invarianti (restano valide dalla Core features)
- Zero dipendenze cloud-native per WhatsApp; trasporto esterno via API.
- Ogni canale nuovo rispetta le preferenze GDPR del contatto.
- Route agent + tool MCP per OGNI funzionalità (agenti AI come utenti di prima classe).
- UI admin sempre presente (gli umani consultano, gli agenti eseguono).
- Migrazioni numerate idempotenti, test su DB separato, docs bilingue.
