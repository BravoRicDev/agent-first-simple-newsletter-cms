import { query } from "../db.js";
import config from "../config.js";
import { logger } from "./logger.js";
import { getContactRecord, setContactFields } from "./contacts.js";
import { createTask } from "./tasks.js";
import {
  getOrCreateConversation,
  addConversationMessage,
  setConversationStatus,
  CONVERSATION_CHANNELS,
} from "./conversations.js";
import { emitContactEvent } from "./events.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 29 — Runtime conversazionale per canale.
//
// Un agent_runtime risponde automaticamente ai messaggi in arrivo su un
// canale (whatsapp | email | chat) con regole ordinate per contatto,
// rispettando SEMPRE le preferenze GDPR del contatto (contacts.pref_whatsapp
// / pref_email / pref_phone).
//
// The WhatsApp channel is not sent from the CMS: the runtime only writes the
// outbound message to the conversation log (conversation_messages) and an external
// Baileys bot delivers it. The 'chat' channel does not exist in conversations
// (CONVERSATION_CHANNELS = email|whatsapp): chat messages are logged as part of
// the contact's email thread with meta.source_channel.
//
// Tutte le funzioni pubbliche sono robuste: try/catch ovunque, mai crash.
// ─────────────────────────────────────────────────────────────────────────

const RUNTIME_CHANNELS = ["whatsapp", "email", "chat"];
const RULE_WHEN_TYPES = ["contains", "starts", "equals", "regex"];
const ACTION_TYPES = ["add_tag", "create_task", "set_stage", "close_conversation"];

const MAX_RULES = 50;
const MAX_RULES_PER_BATCH = 50;
const MAX_ACTIONS_PER_RULE = 10;

function statusError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sanitizeEventTriggers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 10).map((t) => {
    if (!t || typeof t !== "object") return null;
    const eventType = String(t.event_type || "").trim().slice(0, 100);
    if (!eventType) return null;
    return {
      event_type: eventType,
      enabled: t.enabled === undefined ? true : !!t.enabled,
      initial_message: String(t.initial_message || "").trim().slice(0, 5000),
      auto_close_days: Number.isInteger(parseInt(t.auto_close_days, 10)) ? parseInt(t.auto_close_days, 10) : null,
    };
  }).filter(Boolean);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// ── Sanitizzazione input ─────────────────────────────────────────────────

function sanitizeActionConfig(type, raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  switch (type) {
    case "add_tag":
      return { tag: String(cfg.tag || "").trim().slice(0, 100) };
    case "create_task":
      return {
        title: String(cfg.title || "").trim().slice(0, 255),
        notes: String(cfg.notes || "").slice(0, 2000),
        due_at: cfg.due_at ? String(cfg.due_at).slice(0, 40) : null,
        assignee_id: Number.isInteger(parseInt(cfg.assignee_id, 10)) ? parseInt(cfg.assignee_id, 10) : null,
      };
    case "set_stage":
      return { stage: String(cfg.stage || "").trim().slice(0, 100) };
    case "close_conversation":
      return {};
    default:
      return {};
  }
}

// Restituisce la regola pulita, o null se da scartare. Lancia 400 se una
// regex è invalida (meglio segnalare subito che ignorare in produzione).
function sanitizeRule(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const when = raw.when && typeof raw.when === "object" ? raw.when : {};
  const type = String(when.type || "").trim().toLowerCase();
  if (!RULE_WHEN_TYPES.includes(type)) return null;
  const text = String(when.text || "").slice(0, 500);
  if (!text) return null;
  if (type === "regex") {
    try {
      new RegExp(text);
    } catch {
      throw statusError(400, `Regex non valida nella regola ${index}: "${text}"`);
    }
  }

  const reply = raw.reply && typeof raw.reply === "object" ? raw.reply : {};
  const replyText = String(reply.text || "").slice(0, 5000);
  const actions = [];
  if (Array.isArray(reply.actions)) {
    for (const a of reply.actions.slice(0, MAX_ACTIONS_PER_RULE)) {
      if (!a || typeof a !== "object") continue;
      const at = String(a.type || "").trim();
      if (!ACTION_TYPES.includes(at)) continue;
      actions.push({ type: at, config: sanitizeActionConfig(at, a.config) });
    }
  }
  if (!replyText && actions.length === 0) return null;

  return { when: { type, text }, reply: { text: replyText, actions } };
}

function sanitizeRuntimeInput(data = {}) {
  const name = String(data.name || "").trim().slice(0, 255);
  const channel = String(data.channel || "").trim().toLowerCase();
  if (!RUNTIME_CHANNELS.includes(channel)) {
    throw statusError(400, `Canale non valido (attesi: ${RUNTIME_CHANNELS.join(", ")})`);
  }
  const enabled = data.enabled === undefined ? true : !!data.enabled;

  // match: {contact_email?, segment_id?, tag?} — vuoto = tutti i contatti.
  const match = {};
  const rawMatch = data.match && typeof data.match === "object" ? data.match : {};
  if (rawMatch.contact_email) {
    match.contact_email = normalizeEmail(rawMatch.contact_email).slice(0, 255);
  }
  const segId = parseInt(rawMatch.segment_id, 10);
  if (Number.isInteger(segId) && segId > 0) match.segment_id = segId;
  if (rawMatch.tag) match.tag = String(rawMatch.tag).trim().slice(0, 100);

  const rules = [];
  if (Array.isArray(data.rules)) {
    for (const raw of data.rules.slice(0, MAX_RULES_PER_BATCH)) {
      const rule = sanitizeRule(raw, rules.length + 1);
      if (rule) rules.push(rule);
    }
  }
  if (rules.length > MAX_RULES) rules.length = MAX_RULES;

  return {
    name,
    channel,
    enabled,
    match,
    rules,
    fallback_text: String(data.fallback_text || "").slice(0, 5000),
    llm_prompt: String(data.llm_prompt || "").slice(0, 5000),
    event_triggers: sanitizeEventTriggers(data.event_triggers),
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────

export async function listRuntimes(siteId) {
  return (await query(
    "SELECT * FROM agent_runtimes WHERE site_id = $1 ORDER BY created_at DESC, id DESC",
    [siteId]
  )).rows;
}

export async function getRuntime(siteId, id) {
  const row = (await query(
    "SELECT * FROM agent_runtimes WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rows[0];
  return row || null;
}

export async function createRuntime(siteId, data) {
  const clean = sanitizeRuntimeInput(data);
  const row = (await query(
    `INSERT INTO agent_runtimes (site_id, name, channel, enabled, match, rules, fallback_text, llm_prompt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [siteId, clean.name, clean.channel, clean.enabled,
      JSON.stringify(clean.match), JSON.stringify(clean.rules),
      clean.fallback_text, clean.llm_prompt]
  )).rows[0];
  return row;
}

export async function updateRuntime(siteId, id, data) {
  const current = await getRuntime(siteId, id);
  if (!current) return null;
  // Merge: i campi non passati restano quelli salvati (match/rules arrivano
  // come JSONB già parsati in oggetti — la sanitizzazione li riaccetta).
  const merged = { ...current, ...(data || {}) };
  const clean = sanitizeRuntimeInput(merged);
  const row = (await query(
    `UPDATE agent_runtimes SET name = $1, channel = $2, enabled = $3, match = $4, rules = $5,
       fallback_text = $6, llm_prompt = $7, updated_at = NOW()
     WHERE id = $8 AND site_id = $9 RETURNING *`,
    [clean.name, clean.channel, clean.enabled,
      JSON.stringify(clean.match), JSON.stringify(clean.rules),
      clean.fallback_text, clean.llm_prompt, parseInt(id, 10), siteId]
  )).rows[0];
  return row;
}

export async function deleteRuntime(siteId, id) {
  return (await query(
    "DELETE FROM agent_runtimes WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rowCount;
}

// ── Logica di risposta ───────────────────────────────────────────────────

async function findActiveRuntime(siteId, channel) {
  const row = (await query(
    "SELECT * FROM agent_runtimes WHERE site_id = $1 AND channel = $2 AND enabled = true ORDER BY id ASC LIMIT 1",
    [siteId, channel]
  )).rows[0];
  return row || null;
}

// Match contatto: contact_email esatto, tag presente sul contatto,
// membership segmento (segment_members). match vuoto = tutti.
async function contactMatches(runtime, siteId, email) {
  const match = runtime.match || {};
  if (match.contact_email && normalizeEmail(match.contact_email) !== email) return false;
  if (match.tag) {
    const contact = await getContactRecord(siteId, email);
    if (!(contact.tags || []).includes(String(match.tag).trim())) return false;
  }
  if (match.segment_id) {
    const row = (await query(
      "SELECT 1 FROM segment_members WHERE segment_id = $1 AND email = $2",
      [parseInt(match.segment_id, 10), email]
    )).rows[0];
    if (!row) return false;
  }
  return true;
}

function ruleMatches(rule, message) {
  const when = rule.when || {};
  const text = String(when.text || "");
  const msg = String(message || "");
  switch (when.type) {
    case "contains":
      return msg.toLowerCase().includes(text.toLowerCase());
    case "starts":
      return msg.toLowerCase().startsWith(text.toLowerCase());
    case "equals":
      return msg.toLowerCase() === text.toLowerCase();
    case "regex":
      try {
        return new RegExp(text).test(msg);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

// Prima regola che matcha vince; -1 = nessuna.
function findMatchingRuleIndex(rules, message) {
  const list = Array.isArray(rules) ? rules : [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] && ruleMatches(list[i], message)) return i;
  }
  return -1;
}

// Risposta LLM se llm_prompt valorizzato E LLM configurato; altrimenti null
// (il chiamante usa reply.text). Fallback silenzioso su qualsiasi errore.
async function generateLlmReply(runtime, message, email) {
  if (!runtime.llm_prompt || !config.llmApiKey) return null;
  try {
    const { complete } = await import("./llm.js");
    const prompt = [
      runtime.llm_prompt,
      "",
      "Contesto:",
      `- Contatto: ${email}`,
      `- Messaggio ricevuto: ${String(message || "").slice(0, 2000)}`,
      "",
      "Rispondi come se fossi l'agente del sito:",
    ].join("\n");
    const text = await complete(prompt, { maxTokens: 500 });
    return String(text || "").trim() || null;
  } catch (err) {
    logger.warn(`agent-runtime: LLM non disponibile (runtime ${runtime.id}): ${err.message}`);
    return null;
  }
}

// Esegue le azioni della regola in ordine; ritorna l'esito di ciascuna.
async function executeAction(action, { siteId, email, conversationId }) {
  const type = action?.type;
  const cfg = action?.config || {};
  try {
    switch (type) {
      case "add_tag": {
        const tag = String(cfg.tag || "").trim().slice(0, 100);
        if (tag) {
          const contact = await getContactRecord(siteId, email);
          const tags = Array.isArray(contact.tags) ? contact.tags : [];
          if (!tags.includes(tag)) {
            await setContactFields(siteId, email, { ...contact, tags: [...tags, tag] });
          }
        }
        return { type, tag: cfg.tag || null, ok: true };
      }
      case "create_task": {
        const task = await createTask(siteId, {
          title: String(cfg.title || "").trim().slice(0, 255),
          email,
          notes: String(cfg.notes || "").slice(0, 2000),
          dueAt: cfg.due_at ? new Date(cfg.due_at) : null,
          assigneeId: cfg.assignee_id || null,
          createdBy: null,
        });
        return { type, task_id: task?.id || null, ok: !!task };
      }
      case "set_stage": {
        const stage = String(cfg.stage || "").trim().slice(0, 100);
        if (stage) {
          const contact = await getContactRecord(siteId, email);
          await setContactFields(siteId, email, { ...contact, status: stage });
        }
        return { type, stage, ok: !!stage };
      }
      case "close_conversation": {
        if (conversationId) await setConversationStatus(siteId, conversationId, "closed");
        return { type, ok: true };
      }
      default:
        return { type, ok: false, skipped: "tipo azione non supportato" };
    }
  } catch (err) {
    logger.error(`agent-runtime: azione "${type}" fallita (site ${siteId}): ${err.message}`);
    return { type, ok: false, error: err.message };
  }
}

// ── Ingresso messaggio ───────────────────────────────────────────────────
//
// Flusso: (a) runtime attivo per canale → (b) match contatto → (c) GDPR
// preferences → (d) regole (o LLM) → (e) messaggio OUT nel registro
// conversazioni → (f) azioni → (g) evento agent_runtime_replied.
export async function processIncomingMessage({ siteId, channel, contactEmail, message, conversationId }) {
  try {
    const ch = String(channel || "").trim().toLowerCase();
    const email = normalizeEmail(contactEmail);
    if (!siteId || !RUNTIME_CHANNELS.includes(ch) || !email || !message) {
      return { handled: false, error: "Parametri mancanti (siteId, channel, contact_email, message)" };
    }

    // (a) runtime attivo per canale.
    const runtime = await findActiveRuntime(siteId, ch);
    if (!runtime) return { handled: false };

    // (b) match contatto (contact_email / tag / segment_id; vuoto = tutti).
    let matched = false;
    try {
      matched = await contactMatches(runtime, siteId, email);
    } catch (err) {
      logger.warn(`agent-runtime: contactMatches fallito (site ${siteId}): ${err.message}`);
      return { handled: false };
    }
    if (!matched) return { handled: false };

    // (c) preferenze GDPR: whatsapp → pref_whatsapp, email/chat → pref_email.
    let contact = { tags: [], status: "", notes: "", value_estimate: null };
    try {
      contact = await getContactRecord(siteId, email);
    } catch (err) {
      logger.warn(`agent-runtime: getContactRecord fallito (site ${siteId}): ${err.message}`);
    }
    const prefField = ch === "whatsapp" ? "pref_whatsapp" : "pref_email";
    if (contact[prefField] === false) return { handled: true, skipped: "pref", channel: ch };

    // (d) regole in ordine; prima che matcha vince.
    const rules = Array.isArray(runtime.rules) ? runtime.rules : [];
    const ruleIndex = findMatchingRuleIndex(rules, message);
    const rule = ruleIndex >= 0 ? rules[ruleIndex] : null;
    const ruleReply = rule?.reply?.text || "";
    const ruleActions = rule?.reply?.actions || [];

    let replyText = rule ? ruleReply : (runtime.fallback_text || "");
    if (rule) {
      const llmText = await generateLlmReply(runtime, message, email);
      if (llmText) replyText = llmText;
    }
    if (!replyText) return { handled: false, error: "Nessuna risposta generata" };

    // (e) messaggio OUT nel registro conversazioni. 'chat' non è un canale
    // conversations: registra nel thread email, con meta.source_channel.
    const convChannel = CONVERSATION_CHANNELS.includes(ch) ? ch : "email";
    let conversation = null;
    try {
      conversation = await getOrCreateConversation(siteId, email, convChannel);
    } catch (err) {
      logger.warn(`agent-runtime: getOrCreateConversation fallito (site ${siteId}): ${err.message}`);
    }
    let convId = conversation?.id || (conversationId ? parseInt(conversationId, 10) : null);

    const msg = await addConversationMessage(siteId, email, convChannel, {
      direction: "out",
      body: replyText,
      meta: { runtime_id: runtime.id, source_channel: ch, rule_index: ruleIndex },
    });
    if (msg?.conversation_id) convId = msg.conversation_id;

    if (convId) {
      try {
        await setConversationStatus(siteId, convId, "open");
      } catch (err) {
        logger.warn(`agent-runtime: setConversationStatus fallito (conv ${convId}): ${err.message}`);
      }
    }

    // (f) azioni in ordine.
    const executed = [];
    for (const action of ruleActions) {
      executed.push(await executeAction(action, { siteId, email, conversationId: convId }));
    }

    // (g) evento (fire-and-forget interno a emitContactEvent).
    try {
      await emitContactEvent(siteId, email, "agent_runtime_replied", {
        runtime_id: runtime.id,
        channel: ch,
        rule_index: ruleIndex,
        reply: String(replyText).slice(0, 2000),
      });
    } catch (err) {
      logger.warn(`agent-runtime: evento non emesso (site ${siteId}): ${err.message}`);
    }

    return {
      handled: true,
      reply: replyText,
      matched_rule_index: ruleIndex,
      actions: executed,
      conversation_id: convId,
      runtime_id: runtime.id,
    };
  } catch (err) {
    logger.error(`agent-runtime: processIncomingMessage fallito (site ${siteId}, ${channel}): ${err.message}`);
    return { handled: false, error: err.message };
  }
}

// ── Test (DRY-RUN) ───────────────────────────────────────────────────────
// Stessa logica di match/regole ma SENZA side-effect: nessun messaggio
// scritto, nessuna azione eseguita, nessun evento.
export async function testRuntime(siteId, runtimeId, { message, contactEmail } = {}) {
  try {
    const runtime = await getRuntime(siteId, runtimeId);
    if (!runtime) return { error: "Runtime non trovato" };
    const email = normalizeEmail(contactEmail);
    if (!email) return { error: "contact_email obbligatoria" };
    if (!message) return { error: "message obbligatorio" };

    const matched = await contactMatches(runtime, siteId, email).catch(() => false);
    if (!matched) {
      return { matched: false, matched_rule_index: null, reply: null, would_actions: [], pref_ok: null };
    }

    // Preferenza GDPR (solo informativa nel dry-run).
    let prefOk = null;
    try {
      const contact = await getContactRecord(siteId, email);
      const prefField = runtime.channel === "whatsapp" ? "pref_whatsapp" : "pref_email";
      prefOk = contact[prefField] !== false;
    } catch {
      prefOk = null;
    }

    const rules = Array.isArray(runtime.rules) ? runtime.rules : [];
    const ruleIndex = findMatchingRuleIndex(rules, message);
    if (ruleIndex < 0) {
      return {
        matched: true,
        matched_rule_index: null,
        reply: runtime.fallback_text || null,
        would_actions: [],
        pref_ok: prefOk,
      };
    }
    const rule = rules[ruleIndex];
    return {
      matched: true,
      matched_rule_index: ruleIndex,
      reply: rule?.reply?.text || null,
      would_actions: rule?.reply?.actions || [],
      pref_ok: prefOk,
    };
  } catch (err) {
    logger.error(`agent-runtime: testRuntime fallito (runtime ${runtimeId}): ${err.message}`);
    return { error: err.message };
  }
}

// ── Event-driven conversation triggers (ONDA 2 Phase 6) ────────────────────
// Quando un evento CRM (booking_created, contact_created, form_submitted) viene
// emesso, cerca runtimes attivi con event_triggers configurati per quel
// event_type. Se trova un match, avvia una conversazione proattiva con il contatto.
//
// Chiamato da events.js con import dinamico (nessun ciclo statico).

export async function triggerRuntimeForEvent({ siteId, eventType, contactEmail, payload = {} }) {
  try {
    const email = normalizeEmail(contactEmail);
    if (!siteId || !eventType || !email) return { triggered: false };

    const runtimes = (await query(
      "SELECT * FROM agent_runtimes WHERE site_id = $1 AND enabled = true ORDER BY id ASC",
      [siteId]
    )).rows;

    const matching = runtimes.filter((r) => {
      const triggers = Array.isArray(r.event_triggers) ? r.event_triggers : [];
      return triggers.some((t) => t && t.event_type === eventType && t.enabled !== false);
    });

    if (matching.length === 0) return { triggered: false };

    let contact = { tags: [], pref_whatsapp: null, pref_email: null };
    try {
      contact = await getContactRecord(siteId, email);
    } catch { /* graceful fallback */ }

    const results = [];
    for (const runtime of matching) {
      try {
        const triggers = Array.isArray(runtime.event_triggers) ? runtime.event_triggers : [];
        const matchedTrigger = triggers.find((t) => t.event_type === eventType && t.enabled !== false);

        const channel = runtime.channel || "email";
        const convChannel = CONVERSATION_CHANNELS.includes(channel) ? channel : "email";

        const prefField = channel === "whatsapp" ? "pref_whatsapp" : "pref_email";
        if (contact && contact[prefField] === false) {
          results.push({ runtime_id: runtime.id, triggered: false, skipped: "pref", channel });
          continue;
        }

        let conversation = null;
        try {
          conversation = await getOrCreateConversation(siteId, email, convChannel);
        } catch (err) {
          logger.warn(`triggerRuntimeForEvent: getOrCreateConversation fallito (runtime ${runtime.id}): ${err.message}`);
        }

        const initialMessage = String(
          matchedTrigger?.initial_message || runtime.fallback_text || ""
        ).trim().slice(0, 5000);

        let messageSent = false;
        if (initialMessage && conversation?.id) {
          try {
            await addConversationMessage(siteId, email, convChannel, {
              direction: "out",
              body: initialMessage,
              meta: {
                runtime_id: runtime.id,
                source_channel: channel,
                event_triggered_by: eventType,
                event_payload: payload,
              },
            });
            messageSent = true;
          } catch (err) {
            logger.warn(`triggerRuntimeForEvent: addConversationMessage fallito (runtime ${runtime.id}): ${err.message}`);
          }
        }

        if (messageSent && conversation?.id) {
          try {
            await setConversationStatus(siteId, conversation.id, "open");
          } catch (err) {
            logger.warn(`triggerRuntimeForEvent: setConversationStatus fallito (conv ${conversation.id}): ${err.message}`);
          }
        }

        try {
          await emitContactEvent(siteId, email, "agent_runtime_triggered", {
            runtime_id: runtime.id,
            event_type: eventType,
            channel: channel,
            initial_message: initialMessage.slice(0, 500),
          });
        } catch { /* fire-and-forget */ }

        results.push({
          runtime_id: runtime.id,
          triggered: true,
          conversation_id: conversation?.id || null,
          message_sent: messageSent,
          initial_message: initialMessage ? initialMessage.slice(0, 200) : null,
        });
      } catch (err) {
        logger.error(`triggerRuntimeForEvent: runtime ${runtime.id} fallito: ${err.message}`);
        results.push({ runtime_id: runtime.id, triggered: false, error: err.message });
      }
    }

    return { triggered: results.length > 0, results };
  } catch (err) {
    logger.error(`triggerRuntimeForEvent fallito (site ${siteId}, ${eventType}): ${err.message}`);
    return { triggered: false, error: err.message };
  }
}
