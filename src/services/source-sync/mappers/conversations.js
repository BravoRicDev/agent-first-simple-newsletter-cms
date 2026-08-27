import { query } from "../../../db.js";
import { upsertByExternalId } from "../upsert.js";

export async function syncForContacts(ctx, extIds) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  if (!extIds?.length) return;

  // Doc CRM sorgente 2021-07-28 (Search Conversations / Get Messages): il canale è
  // esposto come enum TYPE_* (TYPE_SMS, TYPE_EMAIL, TYPE_WHATSAPP,
  // TYPE_PHONE, TYPE_FB_MESSENGER, TYPE_GROUP_SMS, ...), NON come "SMS"/
  // "Email"/"WhatsApp". Il valore compare sia su conv.type (canale primario)
  // che su conv.lastMessageType: guardiamo entrambi. Il DB locale accetta
  // solo {email, whatsapp, sms} (db/100_conversations_clone.sql), quindi
  // tutto ciò che non è email/whatsapp viene normalizzato a "sms".
  const channelMap = {
    TYPE_EMAIL: "email",
    TYPE_CAMPAIGN_EMAIL: "email",
    TYPE_CUSTOM_EMAIL: "email",
    TYPE_CUSTOM_PROVIDER_EMAIL: "email",
    TYPE_WHATSAPP: "whatsapp",
    TYPE_SMS: "sms",
    TYPE_PHONE: "sms",
    TYPE_CALL: "sms",
    TYPE_GROUP_SMS: "sms",
    TYPE_FB_MESSENGER: "sms",
    TYPE_INSTAGRAM: "sms",
    TYPE_REVIEW: "sms",
    TYPE_LIVE_CHAT: "sms",
    TYPE_WEBCHAT: "sms",
    TYPE_GMB: "sms"
  };

  try {
    for (const contactExtId of extIds) {
      try {
        // Doc CRM sorgente 2021-07-28 (Search Conversations):
        //   GET /conversations/search?locationId&contactId
        // La risposta è { conversations: [...], total } dove "conversations"
        // è un ARRAY piatto (NON { conversation: [...] }). client.get()
        // estrae già data.conversations, quindi qui abbiamo l'array diretto.
        const convsResp = await client.get("/conversations/search", {
          contactId: contactExtId,
          locationId: cfg.location_id
        });

        const convsList = (
          Array.isArray(convsResp)
            ? convsResp
            : convsResp?.conversations || convsResp?.conversation || []
        );
        addStat("conversations", "fetched", convsList.length);

        for (const conv of convsList) {
          try {
            // Risolvi contact_email dal contatto locale
            const contactRow = (await query(
              "SELECT email FROM contacts WHERE external_id=$1 AND site_id=$2",
              [contactExtId, siteId]
            )).rows[0];

            let contactEmail = contactRow?.email || `${contactExtId}@nomail.local`;

            // Mappa channel: type/lastMessageType sorgente (enum TYPE_*) →
            // channel locale. Fallback "sms" per canali non mappati.
            const channel =
              channelMap[conv.type] ||
              channelMap[conv.lastMessageType] ||
              "sms";

            // Gestisci conflitto UNIQUE(site_id, contact_email, channel):
            // cerca prima per email+channel e riusa se esiste
            let conversationId;
            if (!dryRun) {
              const existing = (await query(
                `SELECT id FROM conversations
                 WHERE site_id=$1 AND contact_email=$2 AND channel=$3
                 LIMIT 1`,
                [siteId, contactEmail, channel]
              )).rows[0];

              if (existing) {
                conversationId = existing.id;
                // Aggiorna la riga esistente
                await query(
                  `UPDATE conversations
                   SET subject=$1, status=$2, updated_at=NOW()
                   WHERE id=$3`,
                  [conv.lastMessageBody?.slice(0, 100) || "", conv.status || "open", conversationId]
                );
                addStat("conversations", "updated", 1);
              } else {
                // Inserisci nuova conversazione
                const cols = {
                  subject: conv.lastMessageBody?.slice(0, 100) || "",
                  status: conv.status || "open"
                };

                const timestamps = {
                  createdAt: conv.dateAdded,
                  updatedAt: conv.dateUpdated
                };

                const { row, action } = await upsertByExternalId({
                  table: "conversations",
                  siteId,
                  externalId: conv.id,
                  cols: {
                    contact_email: contactEmail,
                    channel,
                    ...cols
                  },
                  timestamps
                });

                conversationId = row.id;
                if (action === "inserted") addStat("conversations", "upserted", 1);
                else if (action === "updated") addStat("conversations", "updated", 1);
                else addStat("conversations", "skipped", 1);
              }
            } else {
              addStat("conversations", "upserted", 1);
              conversationId = null;
            }

            // Sync messaggi della conversazione
            if (!dryRun && conversationId) {
              try {
                const msgsResp = await client.get(`/conversations/${conv.id}/messages`, {
                  locationId: cfg.location_id
                });

                // Doc CRM sorgente 2021-07-28 (Get Messages): la risposta è
                //   { messages: { lastMessageId, nextPage, messages: [...] } }
                // L'array è quindi in messages.messages, NON in messages.
                const msgs = Array.isArray(msgsResp)
                  ? msgsResp
                  : (msgsResp?.messages?.messages || msgsResp?.messages || []);

                for (const msg of msgs) {
                  try {
                    const direction = msg.direction === "outbound" ? "out" : "in";

                    await query(
                      `INSERT INTO conversation_messages
                       (conversation_id, direction, body, subject, meta, created_at)
                       VALUES ($1, $2, $3, $4, $5, $6)`,
                      [
                        conversationId,
                        direction,
                        msg.body || msg.message || "",
                        msg.subject || "",
                        JSON.stringify({ type: msg.type, status: msg.status } || {}),
                        msg.dateAdded
                      ]
                    );
                    addStat("conversations", "upserted", 1);
                  } catch (err) {
                    // Ignora duplicati: il messaggio potrebbe già esistere
                    if (!err.message?.includes("duplicate")) {
                      addStat("conversations", "errors", 1);
                      log(`message in conv ${conv.id}: ${err.message}`);
                    }
                  }
                }
              } catch (err) {
                addStat("conversations", "errors", 1);
                log(`messages for conv ${conv.id}: ${err.message}`);
              }
            }
          } catch (err) {
            addStat("conversations", "errors", 1);
            log(`conversation ${conv.id}: ${err.message}`);
          }
        }
      } catch (err) {
        addStat("conversations", "errors", 1);
        log(`syncForContacts conversations (${contactExtId}): ${err.message}`);
      }
    }
  } catch (err) {
    addStat("conversations", "errors", 1);
    log(`syncForContacts conversations fallito: ${err.message}`);
  }
}
