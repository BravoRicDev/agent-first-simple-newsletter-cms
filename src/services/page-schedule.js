export class ScheduleError extends Error {
  constructor(code, field) { super(`schedule_${code}`); this.name = "ScheduleError"; this.code = code; this.field = field; }
}

function parseDate(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new ScheduleError("invalid_date", field);
  return d;
}

// Ritorna { publish_at, unpublish_at } (Date|null). Lancia ScheduleError.
// existingUnpublishAt: valore gia' salvato; se invariato non si applica il controllo "nel passato"
// (pagina scaduta ma non ancora processata dallo scheduler che viene ri-salvata dal form).
export function validateSchedule({ publish_at, unpublish_at } = {}, { now = new Date(), existingUnpublishAt = null } = {}) {
  const pub = parseDate(publish_at, "publish_at");
  const unpub = parseDate(unpublish_at, "unpublish_at");
  if (unpub) {
    const unchanged = existingUnpublishAt && new Date(existingUnpublishAt).getTime() === unpub.getTime();
    if (!unchanged && unpub.getTime() <= now.getTime()) throw new ScheduleError("unpublish_in_past", "unpublish_at");
    if (pub && unpub.getTime() <= pub.getTime()) throw new ScheduleError("unpublish_before_publish", "unpublish_at");
  }
  return { publish_at: pub, unpublish_at: unpub };
}
