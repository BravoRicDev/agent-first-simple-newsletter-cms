-- Crea il sito principale
INSERT INTO sites (name, domain) VALUES ('IlMioSito', 'www.ilmiosito.it')
ON CONFLICT (domain) DO NOTHING;
