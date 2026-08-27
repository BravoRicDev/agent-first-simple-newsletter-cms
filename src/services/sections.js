export function parseSections(html) {
  const sections = [];
  const re = /<!--\s*section:([a-zA-Z0-9_-]+)\s*-->([\s\S]*?)<!--\s*\/section:\1\s*-->/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    sections.push({
      name: m[1],
      content: m[2].trim(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return sections;
}

export function replaceSection(html, sectionName, newContent) {
  // Escaping dei metacharacter: sectionName arriva da un path param controllato
  // dall'agente — senza escaping, un valore tipo "(a+)+" è un vettore ReDoS
  // (backtracking catastrofico blocca l'event loop di Node).
  const escaped = String(sectionName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(<!--\\s*section:${escaped}\\s*-->)[\\s\\S]*?(<!--\\s*/section:${escaped}\\s*-->)`,
    "g"
  );
  if (!re.test(html)) throw new Error(`Sezione '${sectionName}' non trovata nella pagina`);
  re.lastIndex = 0;
  // Callback invece della stringa di sostituzione: se newContent contiene
  // pattern tipo $&, $1, $' il replace li interpreterebbe come riferimenti
  // al match e corromperebbe il contenuto della sezione.
  return html.replace(re, (_m, open, close) => `${open}\n${newContent}\n${close}`);
}
