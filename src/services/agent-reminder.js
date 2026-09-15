import { readLocaleMarkdown } from "../middleware/i18n.js";

const sectionsByLang = new Map();
const SECTIONS_CACHE_TTL_MS = 60 * 1000;
let callCounter = 0;
const NEXT_REMINDER_AT = 12;

function parseSections(md) {
  const lines = md.split("\n");
  const result = [];
  let currentSection = null;

  for (const line of lines) {
    const headerMatch = line.match(/^## (.+)/);
    if (headerMatch) {
      if (currentSection) result.push(currentSection);
      currentSection = { header: headerMatch[1].trim(), content: "" };
    } else if (currentSection) {
      currentSection.content += line + "\n";
    }
  }
  if (currentSection) result.push(currentSection);
  return result;
}

function getSections(lang) {
  // Cache con TTL: prima le sezioni venivano cacheate per sempre — una
  // modifica ad AGENT.md non si rifletteva fino al restart del processo.
  const cached = sectionsByLang.get(lang);
  if (cached && Date.now() - cached.loadedAt < SECTIONS_CACHE_TTL_MS) return cached.sections;
  let sections;
  try {
    sections = parseSections(readLocaleMarkdown(lang, "AGENT.md"));
  } catch {
    sections = [
      {
        header: "ABSOLUTE RULES",
        content: "1. Don't use PUT for partial edits, use find-replace.\n2. Save versions before editing.\n3. Check snippet-usage before changing a snippet.\n4. Don't invent endpoints.\n",
      },
    ];
  }
  sectionsByLang.set(lang, { sections, loadedAt: Date.now() });
  return sections;
}

function getRandomSection(lang) {
  const sections = getSections(lang);
  if (sections.length === 0) return null;
  const section = sections[Math.floor(Math.random() * sections.length)];
  const lines = section.content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const tip =
    lines.length > 0
      ? lines[Math.floor(Math.random() * Math.min(lines.length, 3))]
      : "";
  return {
    section: section.header,
    tip: tip.length > 200 ? tip.slice(0, 200) + "..." : tip,
  };
}

export function reminderMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);

  callCounter++;

  res.json = function (body) {
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      if (callCounter >= NEXT_REMINDER_AT) {
        const reminder = getRandomSection(res.locals.lang || "en");
        if (reminder) {
          body._reminder = reminder;
        }
        callCounter = 0;
      }
    }
    return originalJson(body);
  };

  next();
}
