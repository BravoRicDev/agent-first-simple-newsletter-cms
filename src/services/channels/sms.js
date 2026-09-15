import crypto from "crypto";
import { query } from "../../db.js";
import { logger } from "../logger.js";
import config from "../../config.js";

// Onda F — Provider SMS abstraction: Twilio reale o mock per testing.
// Legge la configurazione da tenant_config (chiave 'sms_provider') per decidere
// il provider; ritorna shape uniforme {providerMessageId, status, simulated}.

export async function sendSms(siteId, toPhone, body) {
  if (!siteId || !toPhone || !body) {
    throw new Error("Parametri mancanti: siteId, toPhone, body");
  }

  const provider = await getSmsProvider(siteId);

  if (provider === "twilio") {
    return await sendViaTwilio(siteId, toPhone, body);
  }

  // Default: mock provider (sempre disponibile, non richiede credenziali)
  return sendViaMock(toPhone, body);
}

async function getSmsProvider(siteId) {
  try {
    const result = await query(
      `SELECT value->>'sms_provider' AS provider FROM tenant_config WHERE site_id = $1 AND key = 'sms_provider'`,
      [siteId]
    );
    const row = result.rows[0];
    if (row?.provider) return row.provider;
  } catch (err) {
    logger.debug(`Errore lettura sms_provider per site ${siteId}: ${err.message}`);
  }
  return "mock";
}

async function sendViaTwilio(siteId, toPhone, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    logger.warn(`Credenziali Twilio incomplete per site ${siteId}, fallback a mock`);
    return sendViaMock(toPhone, body);
  }

  try {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const params = new URLSearchParams();
    params.append("From", fromNumber);
    params.append("To", toPhone);
    params.append("Body", body);

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      }
    );

    if (!res.ok) {
      const errData = await res.text();
      throw new Error(`Twilio HTTP ${res.status}: ${errData}`);
    }

    const data = await res.json();
    return {
      providerMessageId: data.sid || null,
      status: "sent",
      provider: "twilio",
      simulated: false,
    };
  } catch (err) {
    logger.error(`Errore Twilio SMS: ${err.message}`);
    throw new Error(`Errore invio SMS via Twilio: ${err.message}`);
  }
}

function sendViaMock(toPhone, body) {
  const mockId = "mock_" + crypto.randomBytes(8).toString("hex");
  logger.info(`[MOCK SMS] to=${toPhone} body_len=${body.length} id=${mockId}`);
  return {
    providerMessageId: mockId,
    status: "sent",
    provider: "mock",
    simulated: true,
  };
}
