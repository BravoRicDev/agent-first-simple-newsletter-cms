import { query } from "../../../db.js";
import { upsertByExternalId, findInternalId } from "../upsert.js";

function slugify(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]/g, "")
    .slice(0, 50);
}

export async function syncAll(ctx) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  try {
    // Slash finale OBBLIGATORIO: "/calendars" (senza) risponde 404 sull'API
    // reale, "/calendars/" risponde 200 — verificato dal vivo con probe
    // diretto (stesso client, stesso token). I calendari non venivano mai
    // sincronizzati prima di questo fix.
    const calsResp = await client.get("/calendars/", { locationId: cfg.location_id });
    const cals = Array.isArray(calsResp) ? calsResp : calsResp?.calendars || [];
    addStat("calendars", "fetched", cals.length);

    for (const cal of cals) {
      try {
        // Fallback quando il sorgente non fornisce calendarSlug: slugify(name)
        // da solo collide fra calendari con nome uguale o molto simile
        // (UNIQUE(site_id, slug) → "duplicate key value violates unique
        // constraint calendars_site_id_slug_key", riprodotto dal vivo).
        // Suffisso dagli ultimi 6 caratteri dell'id sorgente (sempre univoco
        // per costruzione) per garantire unicità senza toccare i calendari
        // che hanno già un calendarSlug proprio dal sorgente.
        const slug = cal.calendarSlug || `${slugify(cal.name || "")}-${String(cal.id || "").slice(-6)}`;
        const cols = {
          name: cal.name || "",
          description: cal.description || "",
          slug,
          enabled: cal.enabled === true,
          timezone: cal.timezone || "UTC"
        };

        const timestamps = {
          createdAt: cal.dateAdded,
          updatedAt: cal.dateUpdated
        };

        if (dryRun) {
          addStat("calendars", "upserted", 1);
        } else {
          const { action } = await upsertByExternalId({
            table: "calendars",
            siteId,
            externalId: cal.id,
            cols,
            timestamps
          });

          if (action === "inserted") addStat("calendars", "upserted", 1);
          else if (action === "updated") addStat("calendars", "updated", 1);
          else addStat("calendars", "skipped", 1);
        }

        // Sync calendar_members dal teamMembers[]
        if (!dryRun && cal.teamMembers && Array.isArray(cal.teamMembers)) {
          const calendarId = (await query(
            "SELECT id FROM calendars WHERE ghl_id=$1 AND site_id=$2",
            [cal.id, siteId]
          )).rows[0]?.id;

          if (calendarId) {
            // Risolvi utenti per ghl_id
            for (const member of cal.teamMembers) {
              try {
                const userId = await findInternalId("users", siteId, member.id);
                if (userId) {
                  await query(
                    `INSERT INTO calendar_members (site_id, calendar_id, user_id)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (calendar_id, user_id) DO NOTHING`,
                    [siteId, calendarId, userId]
                  );
                }
              } catch (err) {
                log(`calendar_member ${member.id}: ${err.message}`);
              }
            }
          }
        }
      } catch (err) {
        addStat("calendars", "errors", 1);
        log(`calendar ${cal.id}: ${err.message}`);
      }
    }
  } catch (err) {
    addStat("calendars", "errors", 1);
    log(`syncAll calendars fallito: ${err.message}`);
    throw err;
  }
}

export async function syncAppointmentsForContacts(ctx, extIds) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  if (!extIds?.length) return;

  const statusMap = {
    new: "pending",
    confirmed: "confirmed",
    showed: "completed",
    noshow: "completed",
    cancelled: "cancelled"
  };

  try {
    for (const contactExtId of extIds) {
      try {
        const apptsResp = await client.get(
          `/contacts/${contactExtId}/appointments`,
          { locationId: cfg.location_id }
        );

        const apts = Array.isArray(apptsResp) ? apptsResp : apptsResp?.events || [];
        addStat("calendars", "fetched", apts.length);

        for (const apt of apts) {
          try {
            // Risolvi calendar_id da calendarId (sorgente) → calendars.ghl_id → id
            let calendarId = null;
            if (apt.calendarId) {
              calendarId = await findInternalId("calendars", siteId, apt.calendarId);
            }

            // Risolvi contact_email dal contatto locale
            const contactRow = (await query(
              "SELECT email FROM contacts WHERE ghl_id=$1 AND site_id=$2",
              [contactExtId, siteId]
            )).rows[0];

            let contactEmail = contactRow?.email || `${contactExtId}@nomail.local`;
            let contactName = apt.contactName || "";

            // Legacy status mapping inverso: sorgente → appointment_status interno.
            // GHL espone lo stato come "appointmentStatus", non "status" (che
            // su un payload reale è sempre undefined) — bug che faceva
            // ricadere ogni appuntamento sincronizzato su "confirmed".
            const sourceStatus = apt.appointmentStatus || apt.status;
            const appointmentStatus = statusMap[sourceStatus] || sourceStatus || "confirmed";
            const cancelled = sourceStatus === "cancelled" ? new Date(apt.cancelledAt || new Date()) : null;

            const cols = {
              calendar_id: calendarId,
              title: apt.title || "",
              start_time: apt.startTime,
              end_time: apt.endTime,
              appointment_status: appointmentStatus,
              status: appointmentStatus,
              contact_name: contactName,
              contact_email: contactEmail,
              contact_phone: apt.contactPhone || "",
              description: apt.description || "",
              timezone: apt.timezone || "UTC",
              cancelled_at: cancelled
            };

            const timestamps = {
              createdAt: apt.dateAdded,
              updatedAt: apt.dateUpdated
            };

            if (dryRun) {
              addStat("calendars", "upserted", 1);
              continue;
            }

            const { action } = await upsertByExternalId({
              table: "booking_appointments",
              siteId,
              externalId: apt.id,
              cols,
              timestamps
            });

            if (action === "inserted") addStat("calendars", "upserted", 1);
            else if (action === "updated") addStat("calendars", "updated", 1);
            else addStat("calendars", "skipped", 1);
          } catch (err) {
            addStat("calendars", "errors", 1);
            log(`appointment ${apt.id}: ${err.message}`);
          }
        }
      } catch (err) {
        addStat("calendars", "errors", 1);
        log(`syncAppointmentsForContacts (${contactExtId}): ${err.message}`);
      }
    }
  } catch (err) {
    addStat("calendars", "errors", 1);
    log(`syncAppointmentsForContacts fallito: ${err.message}`);
  }
}
