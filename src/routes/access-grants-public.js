import { Router } from "express";
import { checkAndConsumeGrant } from "../services/access-grants.js";
import { PROTECTED_ROOT, resolveProtectedFilePath } from "../services/media-utils.js";

// ─────────────────────────────────────────────────────────────────────────
// R1 — Rotta pubblica GET /shared/:token per contenuti protetti.
//
// Nessuna auth CMS: il gate è SOLO sul token (stesso pattern di /quote/:token
// e /pay/:token). Il grant risolve un file di media-protected e lo serve con
// la STESSA validazione path/realpath/anti-path-traversal della route admin
// (/media-protected/*) — condivisa via resolveProtectedFilePath, MAI
// riscritta a mano.
//
// Sicurezza:
//   - se il grant non è valido (inesistente/scaduto/esaurito) o il file non
//     esiste → STESSO 404 generico in tutti i casi (mai rivelare se un token
//     esisteva). Il messaggio non discrimina la causa.
//   - consumo atomico del grant (checkAndConsumeGrant) PRIMA del serve.
//   - Cache-Control: private, no-store (mai cache pubbliche/CDN).
//   - sendFile con root esplicita + dotfiles deny (come la route admin).
// ─────────────────────────────────────────────────────────────────────────

const GENERIC_ERROR = { error: "Contenuto non disponibile" };

const router = Router();

router.get("/shared/:token", async (req, res, next) => {
  try {
    const result = await checkAndConsumeGrant(req.params.token);
    if (!result || !result.ok) {
      return res.status(404).json(GENERIC_ERROR);
    }

    // media_path è relativo alla sottocartella del sito in media-protected
    // (es. `video.mp4` → media-protected/<site_id>/video.mp4).
    const resolved = resolveProtectedFilePath(result.grant.site_id, result.grant.media_path);
    if (!resolved) {
      return res.status(404).json(GENERIC_ERROR);
    }

    res.setHeader("Cache-Control", "private, no-store");
    res.sendFile(resolved.relPath, { root: PROTECTED_ROOT, dotfiles: "deny" }, (err) => {
      if (err) {
        // File sparito/rimosso dopo il check: stesso 404 generico (mai
        // rivelare la causa, mai rivelare che il token era valido).
        return res.status(404).json(GENERIC_ERROR);
      }
      return undefined;
    });
  } catch (err) {
    next(err);
  }
});

export default router;