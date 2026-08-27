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
    const calsResp = await client.get("/calendars", { locationId: cfg.location_id });
    const cals = Array.isArray(calsResp) ? calsResp : calsResp?.calendars || [];
    addStat("calendars", "fetched", cals.length);

    for (const cal of cals) {
      try {
        const slug = cal.calendarSlug || slugify(cal.name || "");
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
            "SELECT id FROM calendars WHERE external_id=$1 AND site_id=$2",
            [cal.id, siteId]
          )).rows[0]?.id;

          if (calendarId) {
            // Risolvi utenti per external_id
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
            // Risolvi calendar_id da calendarId (sorgente) → calendars.external_id → id
            let calendarId = null;
            if (apt.calendarId) {
              calendarId = await findInternalId("calendars", siteId, apt.calendarId);
            }

            // Risolvi contact_email dal contatto locale
            const contactRow = (await query(
              "SELECT email FROM contacts WHERE external_id=$1 AND site_id=$2",
              [contactExtId, siteId]
            )).rows[0];

            let contactEmail = contactRow?.email || `${contactExtId}@nomail.local`;
            let contactName = apt.contactName || "";

            // Legacy status mapping inverso: sorgente → appointment_status interno
            const appointmentStatus = statusMap[apt.status] || apt.status || "confirmed";
            const cancelled = apt.status === "cancelled" ? new Date(apt.cancelledAt || new Date()) : null;

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
