// ─────────────────────────────────────────────────────────────────────────
// Comment stripping per pagine pubbliche (live + export statico).
//
// Obiettivo: nessun commento HTML/JS/CSS visibile all'utente che visita le
// pagine. Il tutto deve essere identico tra rendering live (serve.js) ed
// export statico (static-export.js): un modulo condiviso garantisce la parità.
//
// Regole:
//  - Commenti HTML  (<!-- ... -->)      → rimossi nel markup (non dentro script)
//  - Commenti JS    (// ... e /* ... */)→ rimossi SOLO dentro <script>
//  - Commenti CSS   (/* ... */)         → rimossi SOLO dentro <style>
//  - <script> con type non-JS (JSON-LD, x-template) NON viene toccato: il suo
//    contenuto è JSON/template e contiene URL con `//` (es. https://schema.org).
//
// I commenti JS/CSS NON possono essere rimossi con semplici regex:
// `//` appare in URL, regex letterali, stringhe; `/` è sia divisione che
// apertura regex. Serve un tokenizer che tracci lo stato del parser
// (stringa/template/regex/commento) così da toccare SOLO i commenti veri.
// ─────────────────────────────────────────────────────────────────────────

const SCRIPT_NON_JS = new Set([
  "application/ld+json", "application/json",
  "application/ld-json", "application/importmap+json", "application/importmap",
  "text/x-template", "text/template", "text/html", "application/x-template",
]);

// ── Tokenizer JavaScript: rimuove // e /* */ senza toccare stringhe/regex ──
export function stripJsComments(code) {
  if (typeof code !== "string" || !code) return code;
  let out = "";
  let i = 0;
  const n = code.length;

  while (i < n) {
    const c = code[i];
    const c1 = code[i + 1];

    // Linea di commento: // (in stato code). Va riconosciuta PRIMA della
    // regex: `//` non può mai aprire una regex (il lexer JS la tratta come
    // commento). Lascia il newline per non fondere righe di codice.
    if (c === "/" && c1 === "/") {
      while (i < n && code[i] !== "\n") i++;
      if (i < n) { out += "\n"; i++; }
      continue;
    }

    // Commento a blocco: /* ... */
    if (c === "/" && c1 === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      continue;
    }

    // Stringa singolo/apice: '...' o "..."
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === quote) { closed = true; j++; break; }
        j++;
      }
      out += code.slice(i, closed ? j : n);
      i = closed ? j : n;
      continue;
    }

    // Template literal: `...` — con interpolazione ${...} che può contenere
    // code: processiamo l'interno dell'interpolazione ricorsivamente.
    if (c === "`") {
      let j = i + 1;
      let closed = false;
      let suffix = "";
      while (j < n) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === "`") { closed = true; j++; break; }
        if (code[j] === "$" && code[j + 1] === "{") {
          let depth = 1;
          let k = j + 2;
          while (k < n && depth > 0) {
            if (code[k] === "\\") { k += 2; continue; }
            if (code[k] === "{") depth++;
            else if (code[k] === "}") depth--;
            if (depth <= 0) break;
            k++;
          }
          const expr = code.slice(j + 2, k);
          const strippedExpr = stripJsComments(expr);
          suffix += "${" + strippedExpr + (code[k] || "") + "}";
          j = k + 1;
          continue;
        }
        j++;
      }
      const raw = code.slice(i + 1, closed ? j - 1 : n);
      out += "`" + raw + (closed ? "`" : "");
      out += suffix;
      i = closed ? j : n;
      continue;
    }

    // Regex literal: /.../ con eventuali classi [..] e flag.
    // Distinguere divisione (/) da regex: lo stato `prevTokenAllowsRegex`
    // decide. Dentro la regex, `//` o `/*` NON sono commenti. Qui arriviamo
    // solo quando c1 NON è '/' o '*' (già gestiti sopra).
    if (c === "/" && prevTokenAllowsRegex(out)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = code[j];
        if (ch === "\\") { j += 2; continue; }
        if (ch === "[") { inClass = true; j++; continue; }
        if (ch === "]") { inClass = false; j++; continue; }
        if (ch === "/" && !inClass) { closed = true; j++; break; }
        if (ch === "\n") break; // regex non chiusa sulla stessa riga → fallback
        j++;
      }
      if (closed) {
        // flag regex [a-z]* (es. /x/g, /x/im)
        let k = j;
        while (k < n && /[a-z]/i.test(code[k])) k++;
        out += code.slice(i, k);
        i = k;
        continue;
      }
      // Se la regex non si chiude, copia comunque il primo slash (divisione)
      // e si va avanti: /a/b con a,b identificatori resta divisione.
    }

    // Tutto il resto viene copiato as-is.
    out += c;
    i++;
  }
  return out;
}

// Decide se la `/` corrente apre una regex letterale guardando al testo già
// emesso (out). Regola pragma: dopo token che si aspettano un'espressione
// (— ( [ { , ; : = ! & | ? + - * % < > ~ ^ o inizio) → regex.
// Dopo identificatore/numero/stringa/) ] } → divisione.
const REGEX_PRECEDERS = new Set([... "([{,;:=!&|?+-*%<>~^"]);
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);
function prevTokenAllowsRegex(out) {
  const t = out.replace(/\s+$/, "");
  if (!t) return true; // inizio script
  const last = t[t.length - 1];
  if (REGEX_PRECEDERS.has(last)) return true;
  if (/[A-Za-z0-9_$]/.test(last)) {
    // se l'ultimo identificatore è una keyword che attende espressione
    const m = /[A-Za-z0-9_$]+$/.exec(t);
    if (m && REGEX_KEYWORDS.has(m[0])) return true;
    return false;
  }
  if (last === ")" || last === "]" || last === "}") return false;
  return true;
}

// ── Tokenizer CSS: rimuove /* ... */ senza toccare stringhe/url() ─────────
export function stripCssComments(css) {
  if (typeof css !== "string" || !css) return css;
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    const c = css[i];
    const c1 = css[i + 1];
    if (c === "/" && c1 === "*") {
      while (i < n && !(css[i] === "*" && css[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c; let j = i + 1;
      while (j < n && css[j] !== q) { if (css[j] === "\\") j++; j++; }
      out += css.slice(i, Math.min(n, j + 1));
      i = Math.min(n, j + 1);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ── Master: rimuove i commenti da un documento HTML completo ──────────────
export function stripAllComments(html) {
  if (typeof html !== "string" || !html) return html;

  // Passo 0: proteggi i blocchi <script> e <style> con placeholder, così il
  // successivo strip dei commenti HTML non tocca il contenuto (es. il JSON-LD
  // o un template x-template che contengono `<!--`/`//`). I tag <script>
  // vengono processati (JS) tranne i type non-JS; <style> sempre (CSS).
  const placeholders = [];
  let idx = 0;
  let result = html
    .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (full, attrs, body) => {
      const cleaned = `<style${attrs}>${stripCssComments(body)}</style>`;
      const ph = `\u0000CMSBLOCK${idx++}\u0000`;
      placeholders.push({ ph, full: cleaned });
      return ph;
    })
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs, body) => {
      const type = extractAttr(attrs, "type");
      let cleaned;
      if (type && SCRIPT_NON_JS.has(type.trim().toLowerCase())) {
        cleaned = full; // JSON-LD / template: NON toccare
      } else {
        cleaned = `<script${attrs}>${stripJsComments(body)}</script>`;
      }
      const ph = `\u0000CMSBLOCK${idx++}\u0000`;
      placeholders.push({ ph, full: cleaned });
      return ph;
    });

  // Passo 1: rimuovi i commenti HTML nel markup (fuori dai blocchi protetti,
  // ormai placeholder privi di `<!--`).
  result = result.replace(/<!--[\s\S]*?-->/g, "");

  // Passo 2: ripristina i blocchi processati.
  for (const { ph, full } of placeholders) {
    result = result.replace(ph, full);
  }

  return result;
}

// Estrae il valore di un attributo da una stringa di attributi HTML
// (es. attrs=' type="application/ld+json" data-x="y"'), case-insensitive.
function extractAttr(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(attrs);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
}