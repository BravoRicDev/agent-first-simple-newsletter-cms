# Directory public

Questa cartella viene copiata nell'immagine Docker (`COPY public ./public`) e
servita da Express (`express.static`). Git non traccia le cartelle vuote:
questo `.gitkeep` garantisce che la directory esista anche nei clone puliti,
così la build non fallisce.

Metti qui i file statici globali dell'app (favicon, logo, asset condivisi).
Per i contenuti dei clienti si usa `/media` e `/static` (ignorati da git).
