function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  // CSV injection: un valore che inizia con =, +, -, @ viene interpretato
  // come formula da Excel/Sheets (es. =HYPERLINK(...), =cmd|...) quando l'admin
  // apre l'export. Neutralizza con un apostrofo iniziale, che Excel mostra
  // come testo letterale senza eseguirlo.
  const neutralized = /^[=+\-@]/.test(str) ? "'" + str : str;
  if (/[",\n\r]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

// columns: [{ key, label }]. rows: array di oggetti piatti (key -> valore primitivo).
export function buildCsv(columns, rows) {
  const header = columns.map(c => csvEscape(c.label)).join(",");
  const lines = rows.map(row => columns.map(c => csvEscape(row[c.key])).join(","));
  return [header, ...lines].join("\r\n") + "\r\n";
}

export function sendCsv(res, filename, columns, rows) {
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
  });
  res.send(buildCsv(columns, rows));
}

// ── Parser CSV lato import ────────────────────────────────────────────────
// Decodifica un documento CSV in array di oggetti. Supporta quote (`"`),
// doppie quote escaped (`""`), virgole/a-capo dentro le quote e terminatori
// di riga `\r\n` e `\n`. La prima riga è usata come header (se `hasHeader`).
// Righe vuote o di solo whitespace vengono scartate. Colonne vuote diventano
// stringhe vuote (mai `undefined`), così l'upsert le tratta come "non
// valorizzate". Cap di righe per proteggere da input abnormi.
export function parseCsv(text, { hasHeader = true, maxRows = 100000 } = {}) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++; // salta il \n di \r\n
      row.push(field); field = ""; rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }

  // Scarta righe completamente vuote (spazio/`,` vecchi a-capo finali).
  const clean = rows.filter((r) => !(r.length === 1 && r[0].trim() === ""))
    .slice(0, maxRows);
  if (clean.length === 0) return [];

  if (!hasHeader) {
    return clean.map((r) => {
      const obj = {};
      r.forEach((v, i) => { obj[String(i)] = v !== undefined ? v : ""; });
      return obj;
    });
  }

  const headers = clean[0].map((h) => h.trim());
  return clean.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = r[i] !== undefined ? r[i] : ""; });
    return obj;
  });
}
