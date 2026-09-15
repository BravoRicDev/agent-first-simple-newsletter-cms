// ─────────────────────────────────────────────────────────────────────────
// Comment stripping per pagine pubbliche (live + export statico).
//
// Obiettivo: nessun commento HTML/JS/CSS visibile all'utente che visita le
// pagine, e nessuna riga vuota residua lasciata dai commenti rimossi.
// Il tutto deve essere identico tra rendering live (serve.js) ed export
// statico (static-export.js): un modulo condiviso garantisce la parità.
//
// Regole:
//  - Commenti HTML  (<!-- ... -->)      → rimossi nel markup (non dentro script)
//  - Commenti JS    (// ... e /* ... */)→ rimossi SOLO dentro <script>
//  - Commenti CSS   (/* ... */)         → rimossi SOLO dentro <style>
//  - Righe vuote create dalla rimozione → collassate (2+ newline → 1), ma
//    SEMPRE rispetto di: stringhe, template literal `${...}`, regex letterali
//    e contenuto <pre>/<textarea> (whitespace significativo). Il primo newline
//    viene conservato a protezione dell'ASI (automatic semicolon insertion).
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

// Aggiunge un newline a `out` SOLO se non ce n'è già uno in coda. Collassa
// così le righe vuote consecutive a una sola, conservando il primo newline
// (ESSENZIALE per la ASI del JavaScript: `return\nfoo` deve restare su
// righe separate, altrimenti `return foo` cambierebbe semantica).
function appendNewline(out) {
  if (out.length > 0 && out[out.length - 1] === "\n") return out;
  return out + "\n";
}

// Rimuove lo spazio/tab in coda (lasciato da un commento inline rimosso).
// Solo whitespace orizzontale: mai dentro la riga, mai tocca stringhe.
function trimTrailingWhitespace(out) {
  return out.replace(/[ \t]+$/, "");
}

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
    // commento). Lascia un sola newline (collassata) per non fondere righe.
    if (c === "/" && c1 === "/") {
      while (i < n && code[i] !== "\n") i++;
      if (i < n) { out = trimTrailingWhitespace(out); out = appendNewline(out); i++; }
      continue;
    }

    // Commento a blocco: /* ... */
    if (c === "/" && c1 === "*") {
      // Se il commento si estende su più righe, conserva UNA newline per
      // non unire istruzioni consecutive (ASI protected).
      const hadNewline = /[\r\n]/.test(code.slice(i + 2));
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      if (hadNewline) { out = trimTrailingWhitespace(out); out = appendNewline(out); }
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

    // Newline in stato code: collassa le righe vuote (2+ newline → 1).
    if (c === "\n" || c === "\r") {
      // salta \r\n / \n\r come un'unità
      if ((c === "\r" && c1 === "\n") || (c === "\n" && c1 === "\r")) i++;
      out = appendNewline(out);
      i++;
      continue;
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
      const hadNewline = /[\r\n]/.test(css.slice(i + 2));
      while (i < n && !(css[i] === "*" && css[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      if (hadNewline) { out = trimTrailingWhitespace(out); out = appendNewline(out); }
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c; let j = i + 1;
      while (j < n && css[j] !== q) { if (css[j] === "\\") j++; j++; }
      out += css.slice(i, Math.min(n, j + 1));
      i = Math.min(n, j + 1);
      continue;
    }
    // Newline in stato code: collassa le righe vuote.
    if (c === "\n" || c === "\r") {
      if ((c === "\r" && c1 === "\n") || (c === "\n" && c1 === "\r")) i++;
      out = appendNewline(out);
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Tag il cui contenuto è whitespace-significativo: NON collassare mai le
// righe vuote al loro interno (la rimozione commenti HTML non li tocca).
const NO_COLLAPSE_REGEX = /(<pre\b[^>]*>[\s\S]*?<\/pre>|<textarea\b[^>]*>[\s\S]*?<\/textarea>)/gi;

// Collassa le righe vuote e le righe di soli spazi/tab in un flusso di
// codice (JS/CSS): ogni sequenza di 2+ newline (con eventuale whitespace
// orizzontale in mezzo) viene ridotta a UN solo newline. State-aware: salta
// stringhe ('...', "..."), template literal (`...` con ${...}) e regex
// letterali, così il loro contenuto (spazi/righe significative) resta intatto.
export function collapseBlankLines(code) {
  if (typeof code !== "string" || !code) return code;
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const c1 = code[i + 1];
    // stringhe
    if (c === "'" || c === '"') {
      const q = c; let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === q) { j++; break; }
        j++;
      }
      out += code.slice(i, Math.min(n, j));
      i = Math.min(n, j);
      continue;
    }
    // template literal
    if (c === "`") {
      let j = i + 1; let depth = 0;
      while (j < n) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === "`" && depth === 0) { j++; break; }
        if (code[j] === "`" && depth > 0) { j++; continue; }
        if (code[j] === "${") { depth++; j += 2; continue; }
        if (code[j] === "}" && depth > 0) { depth--; j++; continue; }
        j++;
      }
      out += code.slice(i, Math.min(n, j));
      i = Math.min(n, j);
      continue;
    }
    // regex letterale: /.../ (solo se il contesto lascia intendere regex)
    if (c === "/" && prevTokenAllowsRegex(out)) {
      let j = i + 1; let inClass = false; let closed = false;
      while (j < n) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === "[") { inClass = true; j++; continue; }
        if (code[j] === "]") { inClass = false; j++; continue; }
        if (code[j] === "/" && !inClass) { closed = true; j++; break; }
        if (code[j] === "\n") break;
        j++;
      }
      if (closed) {
        let k = j; while (k < n && /[a-z]/i.test(code[k])) k++;
        out += code.slice(i, k);
        i = k; continue;
      }
    }
    // newline: collassa (2+ newline → 1; riga di soli spazi → eliminata)
    if (c === "\n" || c === "\r") {
      if ((c === "\r" && c1 === "\n") || (c === "\n" && c1 === "\r")) i++;
      if (out.endsWith("\n")) {
        // riga già chiusa: non aggiungere un secondo newline (riga vuota tolta)
      } else if (/(?:^|\n)[ \t]*$/.test(out)) {
        // la riga corrente è di soli spazi/tab: eliminarla del tutto,
        // senza lasciare newline vuoto
        out = out.replace(/[ \t]+$/, "");
      } else {
        out += "\n";
      }
      i++;
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

  // Passo 0: proteggi con placeholder i blocchi che NON vanno collassati né
  // toccati dai commenti HTML: <script> (processato JS, o JSON-LD non-tocco),
  // <style> (processato CSS) e <pre>/<textarea> (contenuto letterale).
  const placeholders = [];
  let idx = 0;
  let result = html
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>|<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi, (full) => {
      const ph = `\u0000CMSBLOCK${idx++}\u0000`;
      placeholders.push({ ph, full });
      return ph;
    })
    .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (full, attrs, body) => {
      const cleaned = `<style${attrs}>${collapseBlankLines(stripCssComments(body))}</style>`;
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
        cleaned = `<script${attrs}>${collapseBlankLines(stripJsComments(body))}</script>`;
      }
      const ph = `\u0000CMSBLOCK${idx++}\u0000`;
      placeholders.push({ ph, full: cleaned });
      return ph;
    });

  // Passo 1: rimuovi i commenti HTML nel markup (fuori dai blocchi protetti,
  // ormai placeholder privi di `<!--`).
  result = result.replace(/<!--[\s\S]*?-->/g, "");

  // Passo 2: collassa le righe vuote residue nel markup. Ogni riga che dopo
  // lo strip contiene solo spazi/tab (o è vuota) viene eliminata: è lo
  // "scheletro" lasciato da un commento rimosso o da un indent vuoto.
  // I blocchi protetti sono placeholder senza spazi/nuoveline, quindi il
  // pattern non li attraversa. Una riga di contenuto resta intatta.
  result = result
    // toglie eventuali spazi finali di riga (es. "var a = 1; ")
    .replace(/[ \t]+(?=\r?\n)/g, "")
    // righe di soli spazi/vuote → rimosse (2+ newline → 1), conservando un
    // unico newline laddove il contenuto richiede una separazione di riga.
    .replace(/\r?\n(?:[ \t]*\r?\n)+/g, "\n");

  // Passo 3: ripristina i blocchi processati.
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