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
