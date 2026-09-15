export function renderTemplate(content, values = {}) {
  return content.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    return match;
  });
}

export function extractPlaceholders(content) {
  const matches = [...content.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)];
  return [...new Set(matches.map(m => m[1]))];
}
