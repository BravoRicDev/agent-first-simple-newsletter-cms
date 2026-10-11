-- Migration 159: override opzionale del titolo mostrato nelle card
-- (liste/homepage), distinto dal titolo "lungo" (pages.title, usato per
-- <title> SEO/pagina). NULL = usa pages.title anche nelle card.
-- Generale e riusabile: qualunque sito può avere un titolo SEO piu' lungo
-- e un titolo breve diverso per le card, due concetti distinti che non
-- vanno confusi in una sola colonna.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS card_title TEXT;
