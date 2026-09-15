import { query } from "../db.js";
import { logger } from "./logger.js";

// Classifica un errore SMTP in 'hard' bounce, 'soft' bounce, o null (non-SMTP).
// Hard: 5xx (permanente: utente non esiste, dominio rifiuta, etc.)
// Soft: 4xx (temporaneo: server occupato, full mailbox, etc.)
// Null: nessun codice SMTP rilevato (errore di connessione, auth, etc.)
export function classifySmtpError(err) {
  if (!err) return null;

  let code = err.responseCode;

  // Se responseCode non è presente, prova a estrarre il codice dal testo della risposta.
  if (!code && err.response) {
    const match = String(err.response).match(/^(\d{3})/);
    if (match) code = parseInt(match[1], 10);
  }

  if (!code) return null;

  if (code >= 500 && code <= 599) return "hard";
  if (code >= 400 && code <= 499) return "soft";
  return null;
}

// Logica pura di decisione: data la classificazione del bounce e il conteggio
// corrente di soft bounce, ritorna l'azione da intraprendere.
// Utile per test: non dipende da query al DB, solo da input/output.
export function decideBounceAction(kind, currentSoftCount) {
  if (kind === "hard") {
    return { action: "suppress", reason: "hard_bounce" };
  }
  if (kind === "soft") {
    // Se questo è il 3° soft bounce (dopo l'inserimento), supprimere.
    const nextSoftCount = currentSoftCount + 1;
    if (nextSoftCount >= 3) {
      return { action: "suppress", reason: "too_many_soft" };
    }
    return { action: "count_soft" };
  }
  return { action: "ignore" };
}

// Registra un bounce nel DB e aggiorna lo stato dello subscriber.
// Argomenti:
//   siteId: site_id
//   subscriber: oggetto con id, email (da newsletter_subscribers)
//   kind: "hard" o "soft" (risultato di classifySmtpError)
//   errorMessage: testo dell'errore per il campo reason
export async function recordBounce(siteId, subscriber, kind, errorMessage = "") {
  if (!subscriber || !subscriber.id) {
    logger.warn("recordBounce: subscriber mancante o senza id");
    return;
  }

  try {
    const decision = decideBounceAction(kind, subscriber.bounce_soft || 0);

    // Inserisci l'evento di bounce nella tabella storica.
    await query(
      `INSERT INTO newsletter_bounces (site_id, subscriber_id, email, kind, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [siteId, subscriber.id, subscriber.email, kind, errorMessage]
    );

    if (decision.action === "suppress") {
      // Hard bounce o troppi soft bounce: marcare come bounced/suppressed.
      await query(
        `UPDATE newsletter_subscribers
         SET bounce_${kind} = bounce_${kind} + 1,
             last_bounce_at = NOW(),
             status = 'bounced',
             suppressed_at = NOW(),
             suppression_reason = $1
         WHERE id = $2`,
        [decision.reason, subscriber.id]
      );
    } else if (decision.action === "count_soft") {
      // Incrementa il conteggio soft bounce senza sopprimere ancora.
      await query(
        `UPDATE newsletter_subscribers
         SET bounce_soft = bounce_soft + 1,
             last_bounce_at = NOW()
         WHERE id = $1`,
        [subscriber.id]
      );
    }
    // Per action === "ignore", non fare nulla.
  } catch (err) {
    logger.error(`recordBounce fallito (site=${siteId}, subscriber=${subscriber?.id}): ${err.message}`);
  }
}
