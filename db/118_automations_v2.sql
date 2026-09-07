-- 118: Automazioni v2 - nuove funzionalità per workflow, scoring, webhook
-- ────────────────────────────────────────────────────────────────────────

-- 1. workflow_actions.condition: condizioni if/else per il branching condizionale
--    Es. { "if": "contact.email", "op": "!=", "value": "test@test.com" }
--    Azioni: go_to_order, skip, o next_action_type/config per il next step.
ALTER TABLE workflow_actions ADD COLUMN IF NOT EXISTS condition JSONB NOT NULL DEFAULT '{}';

-- 2. pipelines.decay_rate / decay_days: scoring decay configurabile per pipeline
--    Se nulle, il valore globale (settings) viene usato.
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS decay_rate NUMERIC(5,4) NOT NULL DEFAULT NULL;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS decay_days INTEGER NOT NULL DEFAULT NULL;

-- Aggiorna le pipeline esistenti con i valori di default (lasciare NULL per usare globale)
UPDATE pipelines SET decay_rate = 0.95 WHERE decay_rate IS NULL;

-- 3. workflow_runs.duration_ms: tempo di esecuzione in ms per analytics/SLA
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS duration_ms INTEGER NOT NULL DEFAULT 0;

-- 4. webhooks.payload_template: modello mustache/handlebar per il payload OUT
--    Le chiavi sono dot-path dal payload arricchito (es. {{contact.name}}, {{opportunity.stage}})
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS payload_template JSONB NOT NULL DEFAULT '{}';

-- 5. Conditional flow per wait_days: next_action_type e next_action_config
--    Dopo wait_days, quale azione eseguire automaticamente.
ALTER TABLE workflow_delayed_actions ADD COLUMN IF NOT EXISTS next_action_type VARCHAR(50);
ALTER TABLE workflow_delayed_actions ADD COLUMN IF NOT EXISTS next_action_config JSONB NOT NULL DEFAULT '{}';

-- Indici per performance
CREATE INDEX IF NOT EXISTS idx_workflow_actions_condition ON workflow_actions(condition);
CREATE INDEX IF NOT EXISTS idx_pipelines_decay ON pipelines(site_id, decay_rate, decay_days);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_duration ON workflow_runs(site_id, duration_ms);
CREATE INDEX IF NOT EXISTS idx_webhooks_template ON webhooks(payload_template);

-- Note: altre colonne tabelle esistenti già presenti (allowed_ips, verify_secret in webhooks)
-- worklow_delayed_actions già creato in 039_workflows.sql
-- scoring già in scoring.js con decay globale via settings