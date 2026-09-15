-- 112: report_configs.last_error_at — evita il retry INFINITO a ogni tick.
--
-- Se TUTTI gli invii di un report falliscono (SMTP giù, destinatari errati),
-- last_sent_at NON viene aggiornato e la config resta "in scadenza":
-- runDueReports la ritentava ad OGNI tick dello scheduler (60s), per
-- sempre. Con last_error_at il retry viene limitato a una volta all'ora
-- (comunque dentro la finestra settimanale/mensile).
--
-- Idempotente.

ALTER TABLE report_configs ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;