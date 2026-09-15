import { query } from "../db.js";
import config from "../config.js";
import { getConversation } from "./conversations.js";
import { searchKb } from "./kb.js";
import { complete } from "./llm.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 34 — Proposta di risposta all'operatore.
//
// Partendo da una conversazione (thread email/whatsapp) e dalla knowledge
// base del sito, si genera una bozza di risposta al lead. La bozza viene
// salvata in reply_suggestions con uno status 'pending'; l'operatore la
// approva (status 'used') o la scarta (status 'dismissed') con un clic.
//
// Generazione: se config.llmApiKey è valorizzata si chiede al modello di
// scrivere la bozza (contesto conversazione + articoli KB), con fallback
// silenzioso al template in caso di errore; altrimenti si usa un template
// deterministico che cita i titoli degli articoli KB trovati (source 'kb')
// o promette un riscontro (source 'template').
// ─────────────────────────────────────────────────────────────────────────

export const SUGGESTION_SOURCES = ["llm", "template", "kb"];
export const SUGGESTION_STATUSES = ["pending", "used", "dismissed"];

const MAX_QUESTION_LEN = 2000;
const MAX_HISTORY_LEN = 1000;
const MAX_KB_SNIPPET_LEN = 800;

function buildTemplateText(articles) {
  let text = "Grazie per il tuo messaggio. ";
  if (articles.length > 0) {
    text += `Ti invio info utili: ${articles.map((a) => a.title).join(", ")}.`;
  } else {
    text += "Sto verificando e ti rispondo a breve.";
  }
  return text;
}

function buildLlmPrompt(siteName, conversation, messages, articles) {
  const history = messages.map((m) =>
    `${m.direction === "in" ? "Lead" : "Noi"}: ${String(m.body || m.subject || "").slice(0, MAX_HISTORY_LEN)}`
  ).join("\n") || "(nessun messaggio)";

  const kbText = articles.map((a) =>
    `- ${a.title}:\n${String(a.snippet || a.content || "").slice(0, MAX_KB_SNIPPET_LEN)}`
  ).join("\n\n");

  return [
    `Sei un assistente commerciale del team di "${siteName}".`,
    `Un lead ha scritto nella conversazione "${String(conversation.subject || conversation.channel || "").slice(0, 200)}".`,
    "Storico recente della conversazione:",
    history,
    kbText
      ? `Articoli della knowledge base pertinenti:\n${kbText}`
      : "Nessun articolo della knowledge base pertinente trovato.",
    "Scrivi una bozza di risposta in italiano, professionale ma cordiale, pronta da inviare al lead. Usa i fatti degli articoli KB quando disponibili; se non bastano, prometti un riscontro a breve senza inventare informazioni. Restituisci solo il testo della risposta, senza prefazioni.",
  ].join("\n");
}

// Genera e salva una proposta di risposta per la conversazione.
// Ritorna la riga inserita (con kb_article_ids già parsato da pg) oppure
// { error: "Conversazione non trovata" } se la conversazione non esiste.
export async function generateSuggestion(siteId, conversationId) {
  const sid = parseInt(siteId, 10);
  const cid = parseInt(conversationId, 10);
  if (!Number.isInteger(sid) || !Number.isInteger(cid)) {
    return { error: "Conversazione non trovata" };
  }

  const conversation = await getConversation(sid, cid);
  if (!conversation) return { error: "Conversazione non trovata" };

  // Ultimi 10 messaggi (più recenti per ultimi) — query diretta per non
  // caricare l'intera storia del thread.
  const messages = (await query(
    `SELECT id, direction, subject, body, created_at FROM conversation_messages
     WHERE conversation_id = $1 ORDER BY id DESC LIMIT 10`,
    [cid]
  )).rows.reverse();

  // Domanda del lead = ultimo messaggio ricevuto (direction='in').
  const lastIn = [...messages].reverse().find((m) => m.direction === "in");
  const question = String(lastIn?.body || lastIn?.subject || "").trim().slice(0, MAX_QUESTION_LEN);

  let articles = [];
  if (question) {
    try {
      articles = await searchKb(sid, question, { limit: 3 });
    } catch (err) {
      logger.warn(`generateSuggestion: ricerca KB fallita (${err.message})`);
    }
  }

  let suggestedText = "";
  let source = "template";
  if (config.llmApiKey) {
    try {
      const siteRow = (await query("SELECT name FROM sites WHERE id = $1", [sid])).rows[0];
      const prompt = buildLlmPrompt(siteRow?.name || "azienda", conversation, messages, articles);
      const raw = await complete(prompt, { maxTokens: 300, temperature: 0.5 });
      suggestedText = String(raw || "").trim();
      if (suggestedText) source = "llm";
    } catch (err) {
      // Fallback silenzioso al template: l'LLM non deve mai bloccare la
      // generazione di una proposta.
      logger.warn(`generateSuggestion: LLM non disponibile, fallback al template (${err.message})`);
      suggestedText = "";
    }
  }
  if (!suggestedText) {
    suggestedText = buildTemplateText(articles);
    source = articles.length > 0 ? "kb" : "template";
  }

  const result = await query(
    `INSERT INTO reply_suggestions (site_id, conversation_id, contact_email, suggested_text, source, kb_article_ids)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      sid,
      cid,
      String(conversation.contact_email || "").slice(0, 255),
      suggestedText,
      source,
      JSON.stringify(articles.map((a) => a.id)),
    ]
  );
  return result.rows[0];
}

// Elenco proposte del sito, con filtri status / conversation_id e
// paginazione limit/offset.
export async function listSuggestions(siteId, { status = null, conversation_id = null, limit = 50, offset = 0 } = {}) {
  const params = [parseInt(siteId, 10)];
  let where = "site_id = $1";
  if (status && SUGGESTION_STATUSES.includes(status)) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  if (conversation_id) {
    params.push(parseInt(conversation_id, 10));
    where += ` AND conversation_id = $${params.length}`;
  }
  params.push(
    Math.min(parseInt(limit, 10) || 50, 200),
    Math.max(parseInt(offset, 10) || 0, 0)
  );
  return (await query(
    `SELECT * FROM reply_suggestions WHERE ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )).rows;
}

// Approva la proposta (status -> 'used'). Solo se era 'pending' (niente
// doppio uso). Ritorna { suggestion } | { notFound } | { conflict, suggestion }.
export async function markUsed(siteId, id) {
  const result = await query(
    `UPDATE reply_suggestions SET status = 'used'
     WHERE id = $1 AND site_id = $2 AND status = 'pending'
     RETURNING *`,
    [parseInt(id, 10), parseInt(siteId, 10)]
  );
  if (result.rowCount === 0) {
    const existing = (await query(
      "SELECT * FROM reply_suggestions WHERE id = $1 AND site_id = $2",
      [parseInt(id, 10), parseInt(siteId, 10)]
    )).rows[0];
    if (!existing) return { notFound: true };
    return { conflict: true, suggestion: existing };
  }
  return { suggestion: result.rows[0] };
}

// Scarta la proposta (status -> 'dismissed'). Ritorna { suggestion } | { notFound }.
export async function dismissSuggestion(siteId, id) {
  const result = await query(
    `UPDATE reply_suggestions SET status = 'dismissed'
     WHERE id = $1 AND site_id = $2
     RETURNING *`,
    [parseInt(id, 10), parseInt(siteId, 10)]
  );
  if (result.rowCount === 0) return { notFound: true };
  return { suggestion: result.rows[0] };
}

// Elimina la proposta. Ritorna il numero di righe eliminate.
export async function deleteSuggestion(siteId, id) {
  return (await query(
    "DELETE FROM reply_suggestions WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), parseInt(siteId, 10)]
  )).rowCount;
}
