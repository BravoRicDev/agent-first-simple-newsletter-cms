import { test } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { query } from "../../src/db.js";
import { createMockSource } from "./helpers/mock-source.mjs";
import { createSourceClient } from "../../src/services/source-sync/client.js";
import * as opportunitiesMapper from "../../src/services/source-sync/mappers/opportunities.js";
import * as calendarsMapper from "../../src/services/source-sync/mappers/calendars.js";
import * as conversationsMapper from "../../src/services/source-sync/mappers/conversations.js";

const SITE_ID = 9999;
const LOCATION_ID = "loc-test-001";

// Genera UUID per gli external_id
const UUIDs = {
  user: randomUUID(),
  pipeline: randomUUID(),
  stage1: randomUUID(),
  stage2: randomUUID(),
  calendar: randomUUID(),
  contact1: randomUUID(),
  contact2: randomUUID(),
  opp: randomUUID(),
  apt: randomUUID(),
  conv: randomUUID(),
  msg1: randomUUID(),
  msg2: randomUUID()
};

async function setupTestData() {
  // Crea il site di test
  const siteRes = await query(
    `INSERT INTO sites (domain, name)
     VALUES ($1, $2)
     ON CONFLICT (domain) DO NOTHING
     RETURNING id`,
    ["test.local", "Test Site"]
  );
  const siteId = siteRes.rows[0]?.id || (await query(
    "SELECT id FROM sites WHERE domain=$1",
    ["test.local"]
  )).rows[0].id;

  // Pulisci dati precedenti per questo site
  await query("DELETE FROM source_sync_config WHERE site_id = $1", [siteId]);
  await query("DELETE FROM contacts WHERE site_id = $1", [siteId]);
  await query("DELETE FROM users WHERE site_id = $1", [siteId]);
  await query("DELETE FROM pipelines WHERE site_id = $1", [siteId]);
  await query("DELETE FROM calendars WHERE site_id = $1", [siteId]);
  await query("DELETE FROM opportunities WHERE site_id = $1", [siteId]);
  await query("DELETE FROM booking_appointments WHERE site_id = $1", [siteId]);
  await query("DELETE FROM conversations WHERE site_id = $1", [siteId]);

  // Crea 1 utente di test
  const userRes = await query(
    `INSERT INTO users (site_id, email, name, role, status, external_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [siteId, "user@test.local", "Test User", "collaboratore", "active", UUIDs.user]
  );
  const userId = userRes.rows[0].id;

  // Crea 1 pipeline + 2 stages
  const pipelineRes = await query(
    `INSERT INTO pipelines (site_id, name, external_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [siteId, "Test Pipeline", UUIDs.pipeline]
  );
  const pipelineId = pipelineRes.rows[0].id;

  await query(
    `INSERT INTO pipeline_stages (pipeline_id, key, label, external_id)
     VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)`,
    [pipelineId, "stage1", "Stage 1", UUIDs.stage1, "stage2", "Stage 2", UUIDs.stage2]
  );

  // Crea 1 calendario con teamMembers
  const calRes = await query(
    `INSERT INTO calendars (site_id, name, description, slug, enabled, timezone, external_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [siteId, "Test Calendar", "Test description", "test-calendar", true, "Europe/Rome", UUIDs.calendar]
  );
  const calendarId = calRes.rows[0].id;

  await query(
    `INSERT INTO calendar_members (site_id, calendar_id, user_id)
     VALUES ($1, $2, $3)`,
    [siteId, calendarId, userId]
  );

  // Crea 2 contatti con external_id
  const contact1Res = await query(
    `INSERT INTO contacts (site_id, email, external_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [siteId, "contact1@test.local", UUIDs.contact1]
  );
  const contact1Id = contact1Res.rows[0].id;

  const contact2Res = await query(
    `INSERT INTO contacts (site_id, email, external_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [siteId, "contact2@test.local", UUIDs.contact2]
  );
  const contact2Id = contact2Res.rows[0].id;

  return {
    siteId,
    userId,
    pipelineId,
    calendarId,
    contact1Id,
    contact2Id,
    contact1Email: "contact1@test.local",
    contact2Email: "contact2@test.local"
  };
}

async function createFixture() {
  return {
    users: [
      {
        id: UUIDs.user,
        email: "user@test.local",
        name: "Test User",
        role: "admin",
        dateAdded: new Date("2026-08-01").toISOString(),
        dateUpdated: new Date("2026-08-01").toISOString()
      }
    ],
    pipelines: [
      {
        id: UUIDs.pipeline,
        name: "Test Pipeline",
        stages: [
          { id: UUIDs.stage1, name: "Stage 1", key: "stage1" },
          { id: UUIDs.stage2, name: "Stage 2", key: "stage2" }
        ],
        dateAdded: new Date("2026-08-01").toISOString(),
        dateUpdated: new Date("2026-08-01").toISOString()
      }
    ],
    calendars: [
      {
        id: UUIDs.calendar,
        name: "Test Calendar",
        description: "Test description",
        calendarSlug: "test-calendar",
        enabled: true,
        timezone: "Europe/Rome",
        teamMembers: [{ id: UUIDs.user, name: "Test User" }],
        dateAdded: new Date("2026-08-01").toISOString(),
        dateUpdated: new Date("2026-08-01").toISOString()
      }
    ],
    contacts: [
      {
        id: UUIDs.contact1,
        email: "contact1@test.local",
        opportunities: [
          {
            // Shape verificata su una chiamata REALE a GET /opportunities/search
            // in produzione (2026-08-26): assignedTo stringa piatta,
            // forecastProbability/lostReasonId/lastStatusChangeAt/createdAt/
            // updatedAt/contact.name — non i nomi "intuitivi" usati prima.
            id: UUIDs.opp,
            name: "Opportunity 1",
            monetaryValue: 5000.0,
            status: "open",
            pipelineId: UUIDs.pipeline,
            pipelineStageId: UUIDs.stage1,
            stage: "Stage 1",
            assignedTo: UUIDs.user,
            forecastProbability: 60,
            source: "web",
            lostReasonId: null,
            lastStatusChangeAt: new Date("2026-08-15").toISOString(),
            forecastExpectedCloseDate: new Date("2026-09-30").toISOString(),
            contact: { name: "Contact One" },
            createdAt: new Date("2026-08-01").toISOString(),
            updatedAt: new Date("2026-08-15").toISOString()
          }
        ],
        appointments: [
          {
            id: UUIDs.apt,
            title: "Meeting with Contact One",
            startTime: new Date("2026-09-01T10:00:00Z").toISOString(),
            endTime: new Date("2026-09-01T11:00:00Z").toISOString(),
            status: "noshow",
            calendarId: UUIDs.calendar,
            contactName: "Contact One",
            contactPhone: "555-1234",
            address: "Via Roma 1",
            timezone: "Europe/Rome",
            description: "Test appointment",
            dateAdded: new Date("2026-08-20").toISOString(),
            dateUpdated: new Date("2026-08-25").toISOString()
          }
        ],
        conversations: [
          {
            id: UUIDs.conv,
            type: "TYPE_SMS",
            lastMessageType: "TYPE_SMS",
            status: "open",
            lastMessageBody: "Hello, this is a test message",
            dateAdded: new Date("2026-08-10").toISOString(),
            dateUpdated: new Date("2026-08-25").toISOString(),
            messages: [
              {
                id: UUIDs.msg1,
                direction: "inbound",
                body: "Hello, this is a test message",
                message: "Hello, this is a test message",
                type: "TYPE_SMS",
                status: "received",
                dateAdded: new Date("2026-08-10T10:00:00Z").toISOString()
              },
              {
                id: UUIDs.msg2,
                direction: "outbound",
                body: "Thanks for contacting us",
                message: "Thanks for contacting us",
                type: "TYPE_SMS",
                status: "sent",
                dateAdded: new Date("2026-08-10T10:30:00Z").toISOString()
              }
            ]
          }
        ]
      },
      {
        id: UUIDs.contact2,
        email: "contact2@test.local",
        opportunities: [],
        appointments: [],
        conversations: []
      }
    ]
  };
}

function makeCtx(siteId, mockUrl, dryRun = false) {
  const stats = {};
  const addStat = (res, key, n = 1) => {
    stats[res] = stats[res] || {
      fetched: 0,
      upserted: 0,
      updated: 0,
      skipped: 0,
      errors: 0
    };
    stats[res][key] = (stats[res][key] || 0) + n;
  };

  const cfg = {
    site_id: siteId,
    base_url: mockUrl,
    location_id: LOCATION_ID,
    token: "test-token",
    throttle_rps: 100,
    budget_percent: 100
  };

  const client = createSourceClient(cfg);

  return {
    siteId,
    cfg,
    client,
    dryRun,
    stats,
    addStat,
    knownContacts: new Set(["contact-ext-001", "contact-ext-002"]),
    discoveredContacts: new Set(),
    log: (...args) => console.log("[test]", ...args)
  };
}

test("opportunities + calendars + conversations sync", async (t) => {
  const testData = await setupTestData();
  const fixture = await createFixture();
  const mock = await createMockSource(fixture);

  try {
    const ctx = makeCtx(testData.siteId, mock.url);

    // ─────────────────────────────────────────────────────────────
    // PRIMO RUN: Sync dei 3 mapper
    // ─────────────────────────────────────────────────────────────

    await calendarsMapper.syncAll(ctx);
    await calendarsMapper.syncAppointmentsForContacts(ctx, [UUIDs.contact1, UUIDs.contact2]);
    await opportunitiesMapper.syncForContacts(ctx, [UUIDs.contact1, UUIDs.contact2]);
    await conversationsMapper.syncForContacts(ctx, [UUIDs.contact1, UUIDs.contact2]);

    // Verifica stats del primo run
    assert.ok(ctx.stats.opportunities?.fetched >= 1, "opportunities fetched");
    assert.ok(ctx.stats.calendars?.fetched >= 1, "calendars fetched");
    assert.ok(ctx.stats.conversations?.fetched >= 1, "conversations fetched");

    // ─────────────────────────────────────────────────────────────
    // ASSERT: Opportunità
    // ─────────────────────────────────────────────────────────────

    const oppRow = (await query(
      `SELECT * FROM opportunities
       WHERE site_id=$1 AND external_id=$2
       LIMIT 1`,
      [testData.siteId, UUIDs.opp]
    )).rows[0];

    assert.ok(oppRow, "opportunity created");
    assert.strictEqual(oppRow.title, "Opportunity 1", "opp title");
    assert.strictEqual(oppRow.stage, "stage1", "opp stage key resolved");
    assert.strictEqual(oppRow.pipeline_id, testData.pipelineId, "opp pipeline_id");
    assert.strictEqual(oppRow.owner_id, testData.userId, "opp owner_id resolved");
    assert.strictEqual(oppRow.contact_email, testData.contact1Email, "opp contact_email");
    assert.strictEqual(oppRow.status, "open", "opp status");
    assert.strictEqual(oppRow.probability, 60, "opp probability");
    assert.strictEqual(parseFloat(oppRow.amount), 5000, "opp amount");

    // ─────────────────────────────────────────────────────────────
    // ASSERT: Appointment (Calendar)
    // ─────────────────────────────────────────────────────────────

    const aptRow = (await query(
      `SELECT * FROM booking_appointments
       WHERE site_id=$1 AND external_id=$2
       LIMIT 1`,
      [testData.siteId, UUIDs.apt]
    )).rows[0];

    assert.ok(aptRow, "appointment created");
    assert.strictEqual(aptRow.title, "Meeting with Contact One", "apt title");
    assert.strictEqual(aptRow.calendar_id, testData.calendarId, "apt calendar_id");
    assert.strictEqual(aptRow.contact_email, testData.contact1Email, "apt contact_email");
    assert.strictEqual(aptRow.appointment_status, "completed", "apt appointment_status (noshow→completed)");
    assert.strictEqual(aptRow.status, "completed", "apt status");
    assert.strictEqual(aptRow.contact_name, "Contact One", "apt contact_name");

    // ─────────────────────────────────────────────────────────────
    // ASSERT: Conversazioni
    // ─────────────────────────────────────────────────────────────

    const convRow = (await query(
      `SELECT * FROM conversations
       WHERE site_id=$1 AND external_id=$2
       LIMIT 1`,
      [testData.siteId, UUIDs.conv]
    )).rows[0];

    assert.ok(convRow, "conversation created");
    assert.strictEqual(convRow.contact_email, testData.contact1Email, "conv contact_email");
    assert.strictEqual(convRow.channel, "sms", "conv channel (SMS→sms)");
    assert.strictEqual(convRow.status, "open", "conv status");

    const messagesRows = (await query(
      `SELECT * FROM conversation_messages
       WHERE conversation_id=$1
       ORDER BY created_at`,
      [convRow.id]
    )).rows;

    assert.strictEqual(messagesRows.length, 2, "conversation has 2 messages");
    assert.strictEqual(messagesRows[0].direction, "in", "message 1 direction (inbound→in)");
    assert.strictEqual(messagesRows[0].body, "Hello, this is a test message", "message 1 body");
    assert.strictEqual(messagesRows[1].direction, "out", "message 2 direction (outbound→out)");
    assert.strictEqual(messagesRows[1].body, "Thanks for contacting us", "message 2 body");

    // ─────────────────────────────────────────────────────────────
    // SECONDO RUN: Idempotenza (nessun cambio = tutto skipped)
    // ─────────────────────────────────────────────────────────────

    const ctx2 = makeCtx(testData.siteId, mock.url);
    await calendarsMapper.syncAll(ctx2);
    await calendarsMapper.syncAppointmentsForContacts(ctx2, [UUIDs.contact1, UUIDs.contact2]);
    await opportunitiesMapper.syncForContacts(ctx2, [UUIDs.contact1, UUIDs.contact2]);
    await conversationsMapper.syncForContacts(ctx2, [UUIDs.contact1, UUIDs.contact2]);

    // Nel secondo run tutto dovrebbe essere skipped (updated_at identico)
    assert.strictEqual(
      (ctx2.stats.opportunities?.skipped || 0) >= 1,
      true,
      "second run opportunities skipped"
    );
    assert.strictEqual(
      (ctx2.stats.calendars?.skipped || 0) >= 1,
      true,
      "second run calendars skipped"
    );

    console.log("✓ All assertions passed");
  } finally {
    await mock.close();
    // Pool chiuso automaticamente dal db.js
  }
});

test("conversations with inline messages", async (t) => {
  const testData = await setupTestData();
  const fixture = await createFixture();
  const mock = await createMockSource(fixture);

  try {
    const ctx = makeCtx(testData.siteId, mock.url);

    await conversationsMapper.syncForContacts(ctx, [UUIDs.contact1]);

    const convRow = (await query(
      `SELECT id FROM conversations
       WHERE site_id=$1 AND external_id=$2`,
      [testData.siteId, UUIDs.conv]
    )).rows[0];

    assert.ok(convRow, "conversation exists");

    const msgs = (await query(
      `SELECT * FROM conversation_messages
       WHERE conversation_id=$1`,
      [convRow.id]
    )).rows;

    assert.strictEqual(msgs.length, 2, "messages synced correctly");

    console.log("✓ Conversations with messages test passed");
  } finally {
    await mock.close();
  }
});
