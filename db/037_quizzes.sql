-- 1) Questionari con punteggi (quiz di qualifica, test, assessment...).
-- Ogni quiz ha un elenco di domande (questions JSONB) con opzioni a cui è
-- associato un punteggio, e una serie di soglie (thresholds JSONB) che
-- mappano l'intervallo di punteggio a un verdetto (titolo + messaggio).
-- Si integra nelle pagine con {{quiz:slug}} (stesso pattern di
-- {{form:slug}} e {{calendar:slug}}). Il calcolo del punteggio avviene sia
-- client-side (feedback immediato) sia server-side al submit (fonte di
-- verità per il salvataggio).
CREATE TABLE IF NOT EXISTS quizzes (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  intro TEXT NOT NULL DEFAULT '',
  questions JSONB NOT NULL DEFAULT '[]',
  thresholds JSONB NOT NULL DEFAULT '[]',
  submit_label VARCHAR(100) NOT NULL DEFAULT 'Calcola il risultato',
  success_message TEXT NOT NULL DEFAULT '',
  ask_email BOOLEAN NOT NULL DEFAULT false,
  contact_tag VARCHAR(100),
  newsletter_optin_key VARCHAR(100),
  newsletter_tag_key VARCHAR(100),
  newsletter_tag_value VARCHAR(100),
  redirect_url VARCHAR(500),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_quizzes_site ON quizzes(site_id);

-- 2) Risultati dei questionari: una riga per compilazione. `data` contiene le
-- risposte scelte (chiave domanda -> etichetta opzione), `total_points` il
-- punteggio calcolato server-side, `result_title` il verdetto della soglia
-- raggiunta. Come form_submissions, quiz_slug resta un testo libero (non FK)
-- così i quiz eliminati non perdono lo storico.
CREATE TABLE IF NOT EXISTS quiz_submissions (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  quiz_slug VARCHAR(255) NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  total_points INTEGER NOT NULL DEFAULT 0,
  result_title VARCHAR(255) NOT NULL DEFAULT '',
  ip_address VARCHAR(45),
  user_agent TEXT,
  referrer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_site_slug ON quiz_submissions(site_id, quiz_slug);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_created ON quiz_submissions(created_at DESC);
