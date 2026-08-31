import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { logger } from "../services/logger.js";
import { PROTECTED_ROOT, resolveProtectedFilePath } from "../services/media-utils.js";

// ═══════════════════════════════════════════════════════════════════════════
// MEDIA PROTETTI — cartella servita SOLO tramite Express/Node.js
// ═══════════════════════════════════════════════════════════════════════════
//
// ── CONTESTO / PERCHÉ ESISTE ────────────────────────────────────────────────
// Il CMS ha una cartella /media (volume Docker `./media:/app/media`) servita
// STATICAMENTE da `app.use("/media", express.static(...))` in src/index.js.
// Quella cartella contiene media pubblici (immagini, video, PDF dei siti):
// filename `timestamp-hash-sha256.ext` NON indovinabili e contenuti per
// natura pubblici → ok esporli via express.static.
//
// Questa cartella (media-protected) è VOLUTAMENTE SEPARATA e NON viene mai
// montata su express.static. È destinata a file che richiedono AUTORIZZAZIONE:
//   - registrazioni di chiamate (feature CRM calls)
//   - backup / dump / esportazioni dati (GDPR: export/erase)
//   - allegati privati (documenti contrattuali, preventivi firmati)
//   - qualunque file che NON deve essere raggiungibile conoscendo solo l'URL
//
// Riferimento: CORREZIONI-TRACCIATE_1.txt voce 2 ("/media statico espone i
// file di tutti i siti") — la nota diceva di NON mettere file sensibili in
// /media; questa cartella è la risposta strutturale: un posto dove i file
// sensibili POSSONO stare, con un unico punto di accesso controllato.
//
// ── REGOLE D'ORO (leggere prima di toccare) ────────────────────────────────
// 1. MAI aggiungere `express.static` su questa cartella in index.js.
//    Il giorno in cui qualcuno lo fa, tutti i file protetti diventano
//    pubblici. Se serve un accesso "semplice", si aggiunge un permesso
//    o un token alla route, NON uno static mount.
// 2. Il default è DENY: senza utente autenticato → 401; senza ruolo
//    autorizzato → 403. Qualunque nuova regola di accesso DEVE essere
//    aggiunta in requireProtectedAccess QUI SOTTO, mai aggirata con
//    espress.static o middleware permissivi.
// 3. I file vanno scritti SOLO da codice (upload route dedicata, job di
//    backup, export GDPR) con filename `timestamp-hash.ext`, MAI da un
//    utente direttamente con un nome a piacere (anti path-traversal e
//    anti collisioni/guess).
// 4. Quando si aggiunge un contenuto sensibile nuovo (es. registrazione
//    chiamata), valutare SEMPRE: (a) chi può leggerlo (ACL), (b) per quanto
//    tempo va conservato (retention/GDPR), (c) se deve essere escluso dai
//    backup pubblici o cifrato a riposo.
//
// ── COME SI CONFIGURA L'INFRASTRUTTURA ─────────────────────────────────────
// - docker-compose.yml: volume `./media-protected:/app/media-protected`
//   (stesso pattern del volume /media, MAI montato su express.static).
// - Dockerfile: `RUN mkdir -p /app/media-protected && chmod 700 /app/media-protected`
//   (700: solo l'utente del processo può leggere/elencare la directory).
// - .gitignore: `/media-protected/` (contenuti runtime, mai versionati).
//
// ── IMPLEMENTAZIONI FUTURE (roadmap suggerita) ─────────────────────────────
// 1. ACL per sito: i file potrebbero vivere in sottocartelle per sito
//    (es. `media-protected/5/calls/123.mp3` = sito 5). La route wildcard
//    sotto GIÀ accetta sottocartelle; basterà arricchire
//    requireProtectedAccess con un lookup `sites_users`/RBAC per decidere
//    se l'utente può leggere QUELLA sottocartella.
// 2. ACL per record: per le registrazioni chiamate serve il check
//    "l'utente è il proprietario della chiamata / è admin del sito della
//    chiamata" → lookup su `call_recordings`/`calls` prima di servire.
// 3. Token firmati one-shot: per condividere un file protetto con un
//    cliente/lead senza account. IMPLEMENTATO come access_grants
//    (db/104_access_grants.sql) + rotta pubblica `GET /shared/:token`
//    (src/routes/access-grants-public.js), che riusa la stessa validazione
//    path/realpath/anti-traversal di questa route via
//    resolveProtectedFilePath (src/services/media-utils.js).
// 4. Audit: loggare ogni accesso ai file protetti (chi, quando, quale
//    file) — usare `auditLog` come già fatto per le altre entità.
// 5. Retention: per file con dati personali (registrazioni, export GDPR)
//    programmare una pulizia (scheduler tick o cron) che elimini i file
//    oltre il periodo di conservazione previsto.
// 6. Cifratura a riposo: i file più sensibili possono essere cifrati con
//    una chiave da config (AES-256-GCM) e decifrati SOLO al momento del
//    serve — così un backup del volume non espone il contenuto in chiaro.
// ═══════════════════════════════════════════════════════════════════════════

// Root assoluta e validazione path condivise con la rotta pubblica
// /shared/:token: PROTECTED_ROOT e resolveProtectedFilePath vivono in
// src/services/media-utils.js (l'UNICO posto dove si valida il path dei
// file protetti — mai riscrivere a mano il check altrove).

const router = Router();

// ── Autorizzazione: DENY BY DEFAULT ────────────────────────────────────────
// Questo middleware è l'UNICO punto dove si decide chi può leggere un file
// protetto. Regola attuale (volutamente minima): utente autenticato con
// ruolo admin/superadmin.
//
// NOTA PER IL FUTURO: quando arriveranno le ACL per sito/record (vedi
// roadmap sopra), questo middleware va arricchito — NON sostituito con
// qualcosa di più permissivo. La firma consigliata per il futuro:
//   requireProtectedAccess(req, res, next, { siteId, recordId })
// con lookup su RBAC (feature 28) e proprietà del record prima del serve.
//
// Perché NON si usa qui `res.redirect("/login")` come requireAuth fa per le
// pagine: i file protetti vengono tipicamente referenziati da <audio>,
// <video>, <img> o fetch — un redirect HTML in quel contesto è inutile e
// confonde. Meglio un errore esplicito 401/403 JSON.
function requireProtectedAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Autenticazione richiesta" });
  }
  // Attuale: solo operatori umani admin/superadmin. Gli agenti (token API,
  // req.user.api_token === true) con ruolo admin passano: decidere in futuro
  // se gli agenti devono avere un permesso dedicato per i file protetti.
  const role = req.user.role;
  if (role !== "admin" && role !== "superadmin") {
    return res.status(403).json({ error: "Accesso negato" });
  }
  next();
}

// ── Route di servizio: GET /media-protected/* ──────────────────────────────
// L'unico modo per leggere un file protetto. NOTA: nessun `express.static`,
// nessun `res.sendFile` fuori da qui: tutto passa da questo handler.
//
// Sicurezza implementata (in ordine di difesa):
//  1. requireAuth: senza token/cookie → bloccato (redirect per browser,
//     ma comunque bloccato).
//  2. requireProtectedAccess: deny by default (401/403) — vedi sopra.
//  3. Validazione del path: solo segmenti [a-zA-Z0-9._-], profondità <= 4,
//     niente segmenti vuoti → il path traversal (`..`, `%2e%2e`, assoluti)
//     non può nemmeno arrivare a fs.
//  4. fs.realpath + prefisso root: anche se un symlink dentro la cartella
//     puntasse fuori (es. verso /etc/passwd o un'altra cartella), il check
//     sul path risolto lo blocca. Difesa in profondità dopo sendFile(root).
//  5. sendFile con `root` esplicita: Express normalizza e impedisce di
//     servire file fuori dalla root (dotfiles deny per .env/.git nascosti).
//  6. Cache-Control: private, no-store: i contenuti protetti non devono
//     finire in cache pubbliche (CDN/condivise) né sopravvivere nel browser.
//     Se in futuro un contenuto è meno sensibile (es. anteprima non
//     riservata) si può valutare `private, max-age=…` — MAI `public`.
//
// NOTA range request: res.sendFile gestisce automaticamente gli header
// Accept-Ranges/206 per audio/video (necessario per le registrazioni).
router.get("/media-protected/*", requireAuth, requireProtectedAccess, (req, res, next) => {
  try {
    // ── 3-4. Validazione path + anti-traversal/anti-symlink ─────────────
    // req.params[0] è tutto ciò che segue `/media-protected/` (wildcard
    // express), incluso l'eventuale sottocartella sito (es. "5/calls/123.mp3").
    // La validazione (segmenti [a-zA-Z0-9._-], profondità <= 4, realpath
    // dentro PROTECTED_ROOT) è condivisa con la rotta pubblica /shared/:token:
    // risiede in resolveProtectedFilePath (src/services/media-utils.js) e non
    // va riscritta a mano. siteId = null → filename è il percorso completo.
    const resolved = resolveProtectedFilePath(null, req.params[0]);
    if (!resolved) {
      // 404 (non 400) per non rivelare se un path "quasi giusto" esiste.
      return res.status(404).json({ error: "File non trovato" });
    }

    // ── 3bis. Scoping per TENANT ─────────────────────────────────────
    // Il primo segmento del path è il sito che possiede il file (es.
    // "5/calls/123.mp3"): un admin NON superadmin può leggere SOLO i file
    // del proprio sito. Prima un admin del sito A poteva richiedere
    // /media-protected/<sitoB>/... (registrazioni/export GDPR altrui).
    // La cartella top-level "calls/" (primo segmento NON numerico) resta
    // accessibile agli admin come in passato.
    if (req.user.role === "admin" && req.user.site_id) {
      const firstSeg = String(req.params[0] || "").split("/")[0];
      if (/^\d+$/.test(firstSeg) && Number(firstSeg) !== Number(req.user.site_id)) {
        return res.status(403).json({ error: "Accesso negato" });
      }
    }

    // ── 5. Serve con root esplicita ─────────────────────────────────────
    // `root` fa sì che Express risolva il path rispetto a PROTECTED_ROOT e
    // rifiuti qualsiasi tentativo di uscirne (anche percent-encoded).
    res.setHeader("Cache-Control", "private, no-store");
    res.sendFile(resolved.relPath, { root: PROTECTED_ROOT, dotfiles: "deny" }, (err) => {
      // sendFile invoca il callback SOLO in caso di errore (o a fine invio
      // se si passa err). Se il file non esiste o è una directory → 404.
      if (err) {
        // 403 = sendFile ha rifiutato un path che esce dalla root (difesa
        // 3, express stessa): trattato come 404 per non rivelare l'esistenza.
        if (err.status === 403 || err.status === 404 || err.code === "ENOENT" || err.code === "EISDIR") {
          return res.status(404).json({ error: "File non trovato" });
        }
        logger.error(`Media protetto: errore serve ${resolved.relPath}: ${err.message}`);
        return res.status(500).json({ error: "Errore durante il serve" });
      }
      return undefined;
    });
  } catch (err) {
    next(err);
  }
});

// ── HELPERS PER IL FUTURO (scrittura file) ─────────────────────────────────
// Quando si implementerà l'upload dei file protetti (registrazioni chiamate,
// export GDPR, backup), usare questi pattern:
//
//   import crypto from "crypto";
//   const filename = `${Date.now()}-${crypto.createHash("sha256")
//     .update(buffer).digest("hex").slice(0, 16)}.mp3`;
//   await fs.promises.writeFile(path.join(PROTECTED_ROOT, subdir, filename), buffer);
//
// - Naming: timestamp + hash del contenuto → niente collisioni, niente
//   guess, niente caratteri pericolosi (il filename è già validato dal
//   SEGMENT_RE della route).
// - Sottocartelle: creare con `fs.mkdir(..., { recursive: true })`.
// - Permessi: la cartella è 700; i file scritti dall'app ereditano
//   permessi sicuri. NON usare mai 777 su questa cartella.
// - Backup volume: i file protetti vivono nel volume Docker dedicato; se i
//   backup del server includono i volumi, valutare la cifratura a riposo
//   (roadmap punto 6) prima di copiarli fuori dal server.

export default router;
