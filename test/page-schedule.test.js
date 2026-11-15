import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateSchedule, ScheduleError } from "../src/services/page-schedule.js";

const NOW = new Date("2026-01-01T10:00:00Z");
const future = (h) => new Date(NOW.getTime() + h * 3600 * 1000).toISOString();
const past = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

describe("validateSchedule", () => {
  test("(1) empty / undefined / '' -> both null", () => {
    assert.deepEqual(validateSchedule({}, { now: NOW }), { publish_at: null, unpublish_at: null });
    assert.deepEqual(validateSchedule({ publish_at: "", unpublish_at: null }, { now: NOW }), { publish_at: null, unpublish_at: null });
    assert.deepEqual(validateSchedule(undefined, { now: NOW }), { publish_at: null, unpublish_at: null });
  });

  test("(2) future unpublish is accepted", () => {
    const r = validateSchedule({ unpublish_at: future(5) }, { now: NOW });
    assert.equal(r.unpublish_at.getTime(), new Date(future(5)).getTime());
    assert.equal(r.publish_at, null);
  });

  test("(3) past unpublish -> unpublish_in_past", () => {
    assert.throws(
      () => validateSchedule({ unpublish_at: past(1) }, { now: NOW }),
      (e) => e instanceof ScheduleError && e.code === "unpublish_in_past" && e.field === "unpublish_at"
    );
  });

  test("(4) unpublish == publish -> unpublish_before_publish", () => {
    const t = future(2);
    assert.throws(
      () => validateSchedule({ publish_at: t, unpublish_at: t }, { now: NOW }),
      (e) => e instanceof ScheduleError && e.code === "unpublish_before_publish" && e.field === "unpublish_at"
    );
  });

  test("(5) unpublish < publish -> unpublish_before_publish", () => {
    assert.throws(
      () => validateSchedule({ publish_at: future(4), unpublish_at: future(3) }, { now: NOW }),
      (e) => e instanceof ScheduleError && e.code === "unpublish_before_publish"
    );
  });

  test("(6) not-a-date -> invalid_date on unpublish_at", () => {
    assert.throws(
      () => validateSchedule({ unpublish_at: "not-a-date" }, { now: NOW }),
      (e) => e instanceof ScheduleError && e.code === "invalid_date" && e.field === "unpublish_at"
    );
  });

  test("(7) past unpublish equal to existingUnpublishAt is accepted", () => {
    const stored = past(1);
    const r = validateSchedule({ unpublish_at: stored }, { now: NOW, existingUnpublishAt: stored });
    assert.equal(r.unpublish_at.getTime(), new Date(stored).getTime());
  });
});
