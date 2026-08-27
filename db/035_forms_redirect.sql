-- Pagina di ringraziamento (thank-you) configurabile dal form builder:
-- dopo l'invio il visitatore (browser classico) viene reindirizzato qui.
-- Deve essere un path relativo (es. /grazie) o un URL dello stesso dominio
-- (validato lato server con la stessa isSafeRedirect usata per _redirect).
ALTER TABLE forms ADD COLUMN IF NOT EXISTS redirect_url VARCHAR(500);
