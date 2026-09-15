import { query } from "../db.js";

function extractKeywords(text, maxWords = 50) {
  const words = text.toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9àèéìòù\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 3)
    .filter(w => !["che","con","per","della","delle","degli","nella","nello","sulla","sulle","sugli","degli","quale","quali","anche","degli","dagli","dalle","dalla","nella","nelle","nello","sugli","sulle","sugli","nella","quello","questa","questo","quindi","perché","perche","mentre","sempre","prima","dopo","anche","sono","delle","degli","nella","sulla","nello"].includes(w));

  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxWords)
    .map(([word]) => word);
}

function computeKeywordOverlap(sourceKeywords, targetText) {
  const targetLower = targetText.toLowerCase();
  let matches = 0;
  for (const kw of sourceKeywords) {
    if (targetLower.includes(kw)) matches++;
  }
  return sourceKeywords.length > 0 ? matches / sourceKeywords.length : 0;
}

export async function suggestInternalLinks(siteId, content, excludePageId) {
  const keywords = extractKeywords(content);
  if (keywords.length === 0) return [];

  const otherPages = await query(
    "SELECT id, url_path, title FROM pages WHERE site_id = $1 AND id != $2 AND published = true ORDER BY url_path",
    [siteId, excludePageId]
  );

  const suggestions = [];
  for (const page of otherPages.rows) {
    const score = computeKeywordOverlap(keywords, `${page.title} ${page.url_path}`);
    if (score > 0.2) {
      suggestions.push({ page_id: page.id, url: page.url_path, title: page.title, score: Math.round(score * 100) / 100 });
    }
  }

  return suggestions.sort((a, b) => b.score - a.score).slice(0, 5);
}
