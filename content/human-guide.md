# Guida Gestione Siti — CMS multi-sito + CRM

Questa guida spiega le sezioni principali della dashboard Gestione Siti. Ogni sezione è raggiungibile dal menu laterale (voci `nav.*`).

## Panoramica

Gestione Siti è un CMS che gestisce più siti web da un'unica installazione, con CRM, automazioni e strumenti di comunicazione integrati. Ogni sito ha i suoi contenuti, contatti e impostazioni isolati.

## Sezioni della dashboard

- **Dashboard**: panoramica generale con KPI, attività recenti e stato dei siti. Punto di partenza dopo il login.
- **Siti**: gestione multi-sito — creazione, dominio, impostazioni per sito, selezione del sito corrente su cui operare.
- **Pagine**: CRUD pagine, versioni e storico, SEO (meta title/description, canonical, noindex, OG image), pubblicazione/bozza, programmazione pubblicazione, duplicazione e rinomina URL.
- **Snippet**: blocchi di contenuto riusabili richiamabili nelle pagine con `{{snippet:nome}}`. Modifica centralizzata che si propaga a tutte le pagine che li usano.
- **Template**: template di pagina con placeholder — crei un modello e lo istanzi come nuove pagine sostituendo i valori.
- **Media**: libreria file per sito (immagini, documenti, audio/video). Upload, import da URL esterno, trascrizione audio, pulizia file orfani.
- **Form**: form pubblici del sito e relative submission ricevute, con ricerca libera su tutti i campi.
- **Questionari (Quiz)**: quiz con punteggi, soglie e verdetti. Integrabili nelle pagine con `{{quiz:slug}}`, con raccolta email opzionale verso i contatti CRM.
- **Sondaggi (Survey)**: sondaggi configurabili per raccogliere feedback dai visitatori.
- **Segmenti**: segmenti dinamici di contatti basati su regole (tag, stato, punteggio, UTM, eventi). Ricalcolo automatico a ogni evento del contatto.
- **Automazioni (Workflow)**: workflow a trigger (form inviato, quiz completato, tag aggiunto, soglia punteggio, ecc.) con azioni ordinate (tag, stage, invio campagna, task, webhook).
- **Task**: task commerciali assegnabili, con scadenza, stato open/done/cancelled e filtro per assegnatario o contatto.
- **Funnel**: snapshot di conversione per canale/giorno (visite, lead, chiamate, vinti, revenue) con filtri data.
- **Conversazioni**: thread email/WhatsApp per contatto, con cronologia messaggi, stato open/pending/closed e invio messaggi.
- **Opportunità / Pipeline vendite (Board Kanban)**: pipeline vendite con stadi custom, opportunità per contatto (importo, probabilità, stato open/won/lost), board kanban e preventivi collegati.
- **Chiamate (Registrazioni)**: gestione chiamate — prenotazione, disponibilità settimanale, slot liberi, calendari multipli, esito e note, registrazioni con riepilogo IA opzionale.
- **Clienti (Area clienti)**: contatti marcati come clienti, con catalogo servizi assegnabili e verifica accesso per servizi esterni.
- **Agent Builder**: creazione di agenti AI personalizzati per i siti dei clienti, con runtime conversazionali per canale (WhatsApp/email/chat) e sandbox di test.
- **Newsletter**: gestione completa — impostazioni SMTP/firma, iscritti (pending/confirmed/unsubscribed), campagne broadcast e sequenze evergreen con invio a lotti e tracking aperture/click.
- **Utenti / Permessi**: gestione utenti del sistema, ruoli, permessi granulari per modulo e assegnazione ruoli custom per sito.
- **Impostazioni**: configurazioni globali e per sito (tracking GA4/GTM/Meta Pixel/Clarity, SEO, email template, webhook, OAuth, ecc.).
- **Segnalazioni bug**: apertura e consultazione ticket verso lo sviluppatore (stato aperto/in lavorazione/risolto/chiuso, priorità, note sviluppatore). Lo sviluppatore le legge 1-2 volte a settimana: ogni ticket deve essere autosufficiente con passi di riproduzione.

## Token API e agenti
Gli agenti AI si collegano via MCP su `POST /api/mcp` con header `Authorization: Bearer agtok_...`. I token si generano da `/admin/api-tokens` (solo admin loggato, nessun endpoint pubblico self-service). Dettagli tecnici completi in `GET /agent`.

## Supporto
Se qualcosa non funziona, apri una segnalazione dalla sezione Bug Reports descrivendo pagina, passi per riprodurre, comportamento atteso e osservato.
