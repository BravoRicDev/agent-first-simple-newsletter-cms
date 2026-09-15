import { test } from "node:test";
import assert from "node:assert";
import { calculateComplaintRate, suggestComplaintStatus } from "../src/services/complaints.js";

test("calculateComplaintRate: handles zero sends", () => {
  const rate = calculateComplaintRate(10, 0);
  assert.strictEqual(rate, null, "Rate should be null when sends is 0 (avoid division by zero)");
});

test("calculateComplaintRate: basic calculation", () => {
  const rate = calculateComplaintRate(1, 1000);
  assert.strictEqual(rate, 0.001, "Rate should be 0.001 for 1 complaint per 1000 sends");
});

test("calculateComplaintRate: zero complaints", () => {
  const rate = calculateComplaintRate(0, 1000);
  assert.strictEqual(rate, 0, "Rate should be 0 when no complaints");
});

test("calculateComplaintRate: high rate", () => {
  const rate = calculateComplaintRate(5, 1000);
  assert.strictEqual(rate, 0.005, "Rate should be 0.005 for 5 complaints per 1000 sends");
});

test("suggestComplaintStatus: ok for null rate", () => {
  const status = suggestComplaintStatus(null);
  assert.strictEqual(status, "ok", "Status should be ok when rate is null");
});

test("suggestComplaintStatus: ok for rate below threshold", () => {
  const status = suggestComplaintStatus(0.0005);
  assert.strictEqual(status, "ok", "Status should be ok when rate <= 0.1% (0.001)");
});

test("suggestComplaintStatus: ok at exactly 0.1% threshold", () => {
  const status = suggestComplaintStatus(0.001);
  assert.strictEqual(status, "ok", "Status should be ok at exactly 0.1% threshold");
});

test("suggestComplaintStatus: warn above threshold", () => {
  const status = suggestComplaintStatus(0.0011);
  assert.strictEqual(status, "warn", "Status should be warn when rate > 0.1% (0.001)");
});

test("suggestComplaintStatus: warn at high rate", () => {
  const status = suggestComplaintStatus(0.003);
  assert.strictEqual(status, "warn", "Status should be warn when rate > 0.1% (Google/Yahoo penalize at 0.3%)");
});
