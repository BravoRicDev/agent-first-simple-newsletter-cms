import { query } from "../db.js";
import config from "../config.js";
import { complete } from "./llm.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 31 — Agent builder visuale + sandbox di test.
//
// Definizioni di agente configurabili via API (agent_definitions) e storico
// dei test dry-run (sandbox_runs). Il test sandbox NON scrive conversazioni,
// task o tag: genera solo una risposta simulata (LLM se configurato, altrimenti
// default_reply o template) e la registra in sandbox_runs per valutazione.
// ─────────────────────────────────────────────────────────────────────────

export const CHANNELS_WHITELIST = ["whatsapp", "email", "chat", "all"];

const MAX_CONFIG_BYTES = 100 * 1024; // 100KB
const MAX_PROMPT_CHARS = 50000;
const MAX_TOOLS = 50;

function sanitizeConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const channels = Array.isArray(raw.channels)
    ? [...new Set(
        raw.channels
          .map((c) => String(c || "").trim().toLowerCase())
          .filter((c) => CHANNELS_WHITELIST.includes(c))
      )].slice(0, CHANNELS_WHITELIST.length)
    : [];

  const toolsAllowed = Array.isArray(raw.tools_allowed)
    ? raw.tools_allowed
        .filter((t) => t !== null && t !== undefined)
        .map((t) => String(t).trim().slice(0, 100))
        .filter(Boolean)
        .slice(0, MAX_TOOLS)
    : [];

  let temperature = 0.7;
  if (raw.temperature !== undefined && raw.temperature !== null && raw.temperature !== "") {
    const n = Number(raw.temperature);
    if (Number.isFinite(n)) {
      temperature = Math.min(2, Math.max(0, n));
    }
  }

  const clean = {
    prompt: raw.prompt !== undefined && raw.prompt !== null ? String(raw.prompt).slice(0, MAX_PROMPT_CHARS) : "",
    model: raw.model !== undefined && raw.model !== null ? String(raw.model).trim().slice(0, 255) : "",
    channels,
    tools_allowed: toolsAllowed,
    reply_style: raw.reply_style !== undefined && raw.reply_style !== null ? String(raw.reply_style).trim().slice(0, 2000) : "",
    default_reply: raw.default_reply !== undefined && raw.default_reply !== null ? String(raw.default_reply).slice(0, 10000) : "",
    temperature,
  };

  if (JSON.stringify(clean).length > MAX_CONFIG_BYTES) {
    const err = new Error("config troppo grande (max 100KB)");
    err.status = 400;
    throw err;
  }
  return clean;
}

function sanitizeDefinitionData(raw) {
  if (!raw || typeof raw !== "object") {
    const err = new Error("Dati definizione mancanti");
    err.status = 400;
    throw err;
  }
  const name = String(raw.name || "").trim().slice(0, 255);
  if (!name) {
    const err = new Error("Nome obbligatorio");
    err.status = 400;
    throw err;
  }
  return {
    name,
    description: raw.description !== undefined && raw.description !== null ? String(raw.description).slice(0, 5000) : "",
    config: sanitizeConfig(raw.config),
    sandbox: raw.sandbox === true,
    active: raw.active !== false,
  };
}

export async function listDefinitions(siteId) {
  const result = await query(
    `SELECT id, site_id, name, description, config, sandbox, active, created_at, updated_at
     FROM agent_definitions WHERE site_id = $1 ORDER BY name`,
    [siteId]
  );
  return result.rows;
}

export async function getDefinition(siteId, id) {
  const result = await query(
    `SELECT id, site_id, name, description, config, sandbox, active, created_at, updated_at
     FROM agent_definitions WHERE id = $1 AND site_id = $2`,
    [id, siteId]
  );
  return result.rows[0] || null;
}

export async function createDefinition(siteId, data) {
  const clean = sanitizeDefinitionData(data);
  const result = await query(
    `INSERT INTO agent_definitions (site_id, name, description, config, sandbox, active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [siteId, clean.name, clean.description, JSON.stringify(clean.config), clean.sandbox, clean.active]
  );
  return result.rows[0];
}

export async function updateDefinition(siteId, id, data) {
  const current = (await query(
    "SELECT * FROM agent_definitions WHERE id = $1 AND site_id = $2",
    [id, siteId]
  )).rows[0];
  if (!current) return null;

  const name = data.name !== undefined && data.name !== null
    ? String(data.name).trim().slice(0, 255) || current.name
    : current.name;
  const description = data.description !== undefined
    ? String(data.description).slice(0, 5000)
    : current.description;
  const configClean = data.config !== undefined ? sanitizeConfig(data.config) : current.config;
  const sandbox = data.sandbox !== undefined ? data.sandbox === true : current.sandbox;
  const active = data.active !== undefined ? data.active !== false : current.active;

  const result = await query(
    `UPDATE agent_definitions
     SET name = $1, description = $2, config = $3, sandbox = $4, active = $5, updated_at = NOW()
     WHERE id = $6 AND site_id = $7 RETURNING *`,
    [name, description, JSON.stringify(configClean), sandbox, active, id, siteId]
  );
  return result.rows[0] || null;
}

export async function deleteDefinition(siteId, id) {
  const result = await query(
    "DELETE FROM agent_definitions WHERE id = $1 AND site_id = $2",
    [id, siteId]
  );
  return result.rowCount > 0;
}

// ── Sandbox (dry-run) ────────────────────────────────────────────────────

function buildFallbackReply(definition, message) {
  const defConfig = definition.config || {};
  if (defConfig.default_reply && String(defConfig.default_reply).trim()) {
    return String(defConfig.default_reply);
  }
  return `[Simulazione] Nessuna risposta configurata per: ${String(message || "").slice(0, 500)}`;
}

// DRY-RUN: genera la risposta simulata SENZA scrivere conversazioni, task o
// tag. Registra solo la riga in sandbox_runs per lo storico dei test.
export async function runSandboxTest({ siteId, definitionId, message, contact_email, channel }) {
  const definition = (await query(
    "SELECT * FROM agent_definitions WHERE id = $1 AND site_id = $2",
    [definitionId, siteId]
  )).rows[0];
  if (!definition) {
    const err = new Error("Definizione non trovata");
    err.status = 404;
    throw err;
  }

  const defConfig = definition.config || {};
  const msg = String(message || "").slice(0, 5000);
  let reply = null;
  let llm_used = false;

  // LLM attivo solo se la definizione ha un prompt E la chiave globale è configurata.
  if (defConfig.prompt && String(defConfig.prompt).trim() && config.llmApiKey) {
    try {
      reply = await complete(defConfig.prompt + "\n\nMessaggio contatto: " + msg, {
        system: defConfig.reply_style
          ? `Stile di risposta richiesto: ${defConfig.reply_style}`
          : "Sei un assistente commerciale. Rispondi in italiano, in modo diretto e conciso, senza prefazioni.",
        temperature: typeof defConfig.temperature === "number" ? defConfig.temperature : 0.7,
        model: defConfig.model || undefined,
      });
      llm_used = true;
    } catch {
      // Fallback silenzioso: se l'LLM fallisce (timeout, quota, errore),
      // il dry-run usa comunque default_reply o il template di simulazione.
      reply = buildFallbackReply(definition, msg);
    }
  } else {
    reply = buildFallbackReply(definition, msg);
  }

  const runResult = await query(
    `INSERT INTO sandbox_runs (site_id, agent_definition_id, kind, input, output)
     VALUES ($1, $2, 'agent_test', $3, $4) RETURNING id, created_at`,
    [
      siteId,
      definitionId,
      JSON.stringify({ message: msg, contact_email: contact_email || null, channel: channel || null }),
      JSON.stringify({
        reply,
        matched_definition: { id: definition.id, name: definition.name },
        llm_used,
      }),
    ]
  );

  return {
    reply,
    definition_id: definitionId,
    sandbox_run_id: runResult.rows[0].id,
  };
}

export async function listSandboxRuns(siteId, { limit = 50, definition_id } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const params = [siteId];
  let sql = `SELECT id, site_id, agent_definition_id, kind, input, output, created_at
             FROM sandbox_runs WHERE site_id = $1`;
  if (definition_id) {
    params.push(parseInt(definition_id, 10));
    sql += ` AND agent_definition_id = $${params.length}`;
  }
  params.push(lim);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const result = await query(sql, params);
  return result.rows;
}
