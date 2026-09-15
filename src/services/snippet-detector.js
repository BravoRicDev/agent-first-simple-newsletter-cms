import crypto from "crypto";
import * as cheerio from "cheerio";
import { query } from "../db.js";

// Tag considerati candidati "a blocco" per la rilevazione snippet: elementi
// semantici/di layout tipicamente duplicati tali e quali fra pagine cloni
// (footer, header, nav, blocchi CTA...). Non includiamo <script>/<style>
// da soli: sono spesso condivisi per motivi generici (analytics) e non è
// quello il pattern che l'utente vuole intercettare (blocchi di contenuto).
const CANDIDATE_TAGS = new Set(["header", "footer", "nav", "aside", "section", "div", "form", "ul"]);

// Sotto questa soglia un blocco è troppo piccolo per valere uno snippet
// dedicato (rumore: wrapper vuoti, singoli bottoni...).
const MIN_BLOCK_SIZE = 80;

// Quanti candidati risultato al massimo (i più rilevanti prima).
const MAX_CANDIDATES = 20;

function normalizeHtml(html) {
  return html.replace(/\s+/g, " ").trim();
}

function hashBlock(normalizedHtml) {
  return crypto.createHash("sha256").update(normalizedHtml).digest("hex");
}

// Estrae i blocchi candidati di una pagina: i figli diretti di <body> più,
// un livello sotto, i loro figli con class o id (footer/header/nav sono già
// coperti al primo livello; un blocco CTA innestato in un <div class="wrap">
// lo è al secondo). Evita l'esplosione combinatoria di scendere a ogni
// livello di nesting.
//
// Il blocco "html" restituito è sempre una substring LETTERALE del sorgente
// originale (via sourceCodeLocation di parse5), non la serializzazione di
// cheerio: quest'ultima normalizza entità/attributi (es. "&" non escapato ->
// "&amp;") e produrrebbe un HTML che non coincide byte-per-byte col
// contenuto salvato — rompendo sia il replace in scrittura sia qualunque
// "content.includes(blocco)" a valle.
export function extractCandidateBlocks(html) {
  const source = html || "";
  const $ = cheerio.load(source, { sourceCodeLocationInfo: true });
  const blocks = [];
  const seen = new Set();

  function consider(el) {
    if (!el.sourceCodeLocation) return; // nodi sintetici (auto-inseriti da parse5): niente offset, skip
    const $el = $(el);
    const tag = (el.tagName || "").toLowerCase();
    if (!CANDIDATE_TAGS.has(tag)) return;
    const hasClassOrId = $el.attr("class") || $el.attr("id");
    if (tag === "div" && !hasClassOrId) return; // <div> generico senza identità: troppo rumoroso
    const { startOffset, endOffset } = el.sourceCodeLocation;
    const raw = source.slice(startOffset, endOffset);
    if (!raw || raw.length < MIN_BLOCK_SIZE) return;
    const normalized = normalizeHtml(raw);
    const hash = hashBlock(normalized);
    if (seen.has(hash)) return; // stesso blocco ripetuto più volte nella stessa pagina: contalo una volta
    seen.add(hash);
    blocks.push({ tag, html: raw, hash, sizeBytes: Buffer.byteLength(raw, "utf8"), attrClass: $el.attr("class") || null, attrId: $el.attr("id") || null });
  }

  $("body").children().each((_, el) => {
    consider(el);
    $(el).children().each((__, child) => consider(child));
  });

  return blocks;
}

function suggestName(block, existingNames) {
  const base = block.attrId || (block.attrClass ? block.attrClass.split(/\s+/)[0] : block.tag);
  const slug = String(base).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || block.tag;
  let candidate = slug;
  let i = 2;
  while (existingNames.has(candidate)) {
    candidate = `${slug}-${i++}`;
  }
  return candidate;
}

// Confronta la pagina di riferimento con tutte le altre pagine dello stesso
// sito e restituisce i blocchi identici (hash su HTML whitespace-normalizzato)
// presenti in almeno un'altra pagina oltre a quella di riferimento.
export async function findSnippetCandidates(siteId, pageId, { minOccurrences = 2 } = {}) {
  const refRow = (await query(
    "SELECT id, url_path, title, content FROM pages WHERE id = $1 AND site_id = $2",
    [pageId, siteId]
  )).rows[0];
  if (!refRow) return null;

  const otherPages = (await query(
    "SELECT id, url_path, title, content FROM pages WHERE site_id = $1 AND id != $2",
    [siteId, pageId]
  )).rows;

  const existingNames = new Set(
    (await query("SELECT name FROM snippets WHERE site_id = $1", [siteId])).rows.map((r) => r.name)
  );

  const refBlocks = extractCandidateBlocks(refRow.content);

  // hash -> lista occorrenze (pagina + blocco) nelle ALTRE pagine
  const occurrenceIndex = new Map();
  for (const page of otherPages) {
    const blocks = extractCandidateBlocks(page.content);
    for (const b of blocks) {
      if (!occurrenceIndex.has(b.hash)) occurrenceIndex.set(b.hash, []);
      occurrenceIndex.get(b.hash).push({ page_id: page.id, url_path: page.url_path, title: page.title });
    }
  }

  const candidates = [];
  for (const block of refBlocks) {
    const others = occurrenceIndex.get(block.hash) || [];
    const occurrenceCount = others.length + 1; // + la pagina di riferimento stessa
    if (occurrenceCount < minOccurrences) continue;
    candidates.push({
      hash: block.hash,
      tag: block.tag,
      suggested_name: suggestName(block, existingNames),
      full_html: block.html,
      size_bytes: block.sizeBytes,
      occurrence_count: occurrenceCount,
      occurrences: [
        { page_id: refRow.id, url_path: refRow.url_path, title: refRow.title },
        ...others,
      ],
    });
  }

  // Dedup: quando un blocco più grande è già candidato e uno più piccolo è
  // interamente contenuto al suo interno (es. <section> e il suo unico
  // <div> figlio), suggerire solo il più grande — applicarlo copre già
  // l'altro, ed è ridondante mostrare entrambi.
  candidates.sort((a, b) => b.size_bytes - a.size_bytes);
  const deduped = [];
  for (const c of candidates) {
    const containedInAccepted = deduped.some((bigger) => bigger.full_html.includes(c.full_html));
    if (!containedInAccepted) deduped.push(c);
  }

  deduped.sort((a, b) => (b.occurrence_count - a.occurrence_count) || (b.size_bytes - a.size_bytes));

  return {
    reference_page: { id: refRow.id, url_path: refRow.url_path, title: refRow.title },
    candidates: deduped.slice(0, MAX_CANDIDATES).map((c) => ({
      hash: c.hash,
      tag: c.tag,
      suggested_name: c.suggested_name,
      preview: c.full_html.length > 400 ? c.full_html.slice(0, 400) + "…" : c.full_html,
      size_bytes: c.size_bytes,
      occurrence_count: c.occurrence_count,
      occurrences: c.occurrences,
    })),
  };
}

// Ritrova sulla pagina di riferimento il blocco che corrisponde all'hash
// approvato dall'utente (ri-estrazione, mai fidarsi di HTML client-side:
// la pagina potrebbe essere cambiata dopo la ricerca candidati).
export async function findBlockByHash(siteId, pageId, hash) {
  const refRow = (await query(
    "SELECT id, content FROM pages WHERE id = $1 AND site_id = $2",
    [pageId, siteId]
  )).rows[0];
  if (!refRow) return null;
  const blocks = extractCandidateBlocks(refRow.content);
  return blocks.find((b) => b.hash === hash) || null;
}

// Sostituisce, in ogni pagina del sito che contiene un blocco con questo
// hash, il blocco con il tag {{snippet:name}}. Stessa estrazione/hash usata
// da findSnippetCandidates (non un semplice `content.includes()` sul testo
// del blocco di riferimento): così ogni pagina usa il PROPRIO blocco come
// substring da sostituire, sempre corretto per costruzione anche se
// l'attributo class/id ha un ordine diverso da pagina a pagina. Ritorna solo
// le pagine effettivamente modificate (col contenuto precedente, per il
// versioning a carico del chiamante) — le pagine senza quel blocco non sono
// un "errore", semplicemente non lo contenevano, e non vengono elencate.
export async function replaceBlockAcrossPages(siteId, hash, snippetName) {
  const pages = (await query(
    "SELECT id, url_path, title, content, layout_mode, published FROM pages WHERE site_id = $1",
    [siteId]
  )).rows;

  const tag = `{{snippet:${snippetName}}}`;
  const updated = [];

  for (const page of pages) {
    const match = extractCandidateBlocks(page.content).find((b) => b.hash === hash);
    if (!match) continue;
    const newContent = page.content.split(match.html).join(tag);
    await query("UPDATE pages SET content = $1, updated_at = NOW() WHERE id = $2", [newContent, page.id]);
    updated.push({
      id: page.id,
      url_path: page.url_path,
      title: page.title,
      oldContent: page.content,
      layoutMode: page.layout_mode,
      published: page.published,
    });
  }

  return { updated };
}
