-- Feature — Registrazione e Valutazione Chiamate del Setter (integrato nel CMS)
--
-- Ogni chiamata "di vendita esterna" (es. il setter che compone le aziende target)
-- viene caricata qui come file audio (registrazione). Il CMS trascrive l'audio,
-- diarizza i turni Setter/Lead e produce un verdetto di VALIDITÀ della chiamata
-- (si / no / dubbia) secondo le regole del contratto: si paga il setter SOLO per
-- le chiamate valide (valida='si'), le dubbie vanno in revisione umana, le non
-- valide non si pagano.
--
-- I file audio vivono in media-protected (Mai serviti da express.static), la
-- trascrizione diarizzata è testo in questa tabella (retention GDPR: a fine
-- elaborazione il file audio può essere eliminato tenendo solo testo+verdetto).
--
-- Schema:
--   - call_recordings : una riga per chiamata (audio, trascrizione, verdetto)
--   - opportunities.call_verdict : snapshot JSONB del verdetto (per la board)
CREATE TABLE IF NOT EXISTS call_recordings (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
  contact_email VARCHAR(255) NOT NULL DEFAULT '',
  contact_name VARCHAR(255) NOT NULL DEFAULT '',
  setter_name VARCHAR(255) NOT NULL DEFAULT '',
  pipeline_id INTEGER REFERENCES pipelines(id) ON DELETE SET NULL,
  funnel_context JSONB NOT NULL DEFAULT '{}',
  audio_path VARCHAR(512) NOT NULL DEFAULT '',
  raw_text TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '',
  -- Verdetto di validità (JSON strutturato, validato lato server):
  -- { valida: 'si'|'no'|'dubbia', motivo_cap_classico, criteri, punteggio, motivazione }
  verdict JSONB NOT NULL DEFAULT '{}',
  review_status VARCHAR(20) NOT NULL DEFAULT 'auto'
    CHECK (review_status IN ('auto','revisione','confermato','scartato')),
  -- stato di lavorazione: caricato -> trascritto -> valutato
  status VARCHAR(20) NOT NULL DEFAULT 'caricato'
    CHECK (status IN ('caricato','trascritto','valutato','errore')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_recordings_site
  ON call_recordings(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_recordings_opp
  ON call_recordings(opportunity_id);

-- Snapshot del verdetto sull'opportunità (visualizzato dalla board kanban).
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS call_verdict JSONB NOT NULL DEFAULT '{}';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS call_recorded_at TIMESTAMPTZ;
