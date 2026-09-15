-- 1) Tag newsletter assegnato dal form builder al contatto (CRM-lite).
-- Analogamente a newsletter_optin_key (che iscrive alla newsletter quando un
-- checkbox è spuntato), newsletter_tag_key punta a una chiave di campo del
-- form: alla compilazione, se quel campo è valorizzato, il tag viene
-- aggiunto a contacts.tags → le sequenze/campagne newsletter con
-- target_tag (es. '01-ferramenta') partono per quel contatto.
-- newsletter_tag_value è opzionale: se presente è IL tag da assegnare
-- (utile per checkbox "spunta per ricevere info X"); se assente, il tag è il
-- valore del campo stesso (utile per select/radio le cui opzioni sono i tag).
ALTER TABLE forms ADD COLUMN IF NOT EXISTS newsletter_tag_key VARCHAR(100);
ALTER TABLE forms ADD COLUMN IF NOT EXISTS newsletter_tag_value VARCHAR(100);

-- 2) Multi-calendario per il modulo call_scheduling: ogni calendario ha la
-- propria disponibilità settimanale e le proprie chiamate. Un calendario può
-- essere associato a un utente (proprietario/agente) e viene integrato nelle
-- pagine con {{calendar:slug}} (stesso pattern di {{form:slug}}).
CREATE TABLE IF NOT EXISTS calendars (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  slug VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_calendars_site ON calendars(site_id);

-- Regole di disponibilità per calendario: calendar_id NULL = regole
-- legacy site-wide (usate da /book/:siteId senza slug, comportamento
-- preesistente invariato). ON DELETE CASCADE: eliminare un calendario
-- elimina le sue regole.
ALTER TABLE call_availability ADD COLUMN IF NOT EXISTS calendar_id INTEGER
  REFERENCES calendars(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_call_availability_calendar
  ON call_availability(calendar_id);

-- Chiamate per calendario: calendar_id NULL = chiamate legacy site-wide.
-- ON DELETE SET NULL: eliminare un calendario non cancella lo storico
-- chiamate, le lascia senza calendario.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS calendar_id INTEGER
  REFERENCES calendars(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_calls_calendar ON calls(calendar_id);
