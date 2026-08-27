import fs from "fs";
import path from "path";

// Rimuove vettori di stored XSS via SVG: <script>, handler on* inline,
// URI javascript: in href/xlink:href/src, e interi elementi che permettono
// di eseguire codice per vie indirette (foreignObject+iframe, tag SMIL che
// possono costruire dinamicamente un attributo href/src "javascript:...").
// Approccio a regex (non un parser XML completo): non copre casi patologici
// (es. entità XML annidate), ma neutralizza i vettori noti sfruttabili
// quando l'SVG viene aperto direttamente (content-type image/svg+xml).
function stripTagAndContents(svg, tagName) {
  const paired = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}\\s*>`, "gi");
  const selfClosing = new RegExp(`<${tagName}\\b[^>]*\\/>`, "gi");
  return svg.replace(paired, "").replace(selfClosing, "");
}

export function sanitizeSvgBuffer(buffer) {
  let svg = buffer.toString("utf8");
  // Bypass noto: le entità numeriche (&#99;, &#x63;) NON vengono decodificate
  // dal parser a regex, ma il browser le decodifica quando apre l'SVG —
  // un payload `on&#99;lick="alert(1)"` o `href="&#106;avascript:..."`
  // sopravviveva intatto. Decodifica preventiva: il contenuto finale che il
  // browser vede è comunque la forma decodificata, quindi sanitizzare la
  // forma decodificata è corretto (caso limite `&#38;` per un `&` letterale:
  // irrilevante in un SVG di marketing, e comunque piu' sicuro).
  svg = svg
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  svg = stripTagAndContents(svg, "script");
  svg = stripTagAndContents(svg, "foreignObject");
  svg = stripTagAndContents(svg, "iframe");
  // Tag SMIL che possono modificare a runtime attributi come href/src su altri elementi.
  for (const tag of ["animate", "animateMotion", "animateTransform", "animateColor", "set"]) {
    svg = stripTagAndContents(svg, tag);
  }
  svg = svg.replace(/\son\w+\s*=\s*"(?:[^"]|\\")*"/gi, "");
  svg = svg.replace(/\son\w+\s*=\s*'(?:[^']|\\')*'/gi, "");
  svg = svg.replace(/\son\w+\s*=\s*[^\s"'>]+/gi, "");
  svg = svg.replace(/((?:xlink:)?href\s*=\s*)"javascript:[^"]*"/gi, '$1""');
  svg = svg.replace(/((?:xlink:)?href\s*=\s*)'javascript:[^']*'/gi, "$1''");
  svg = svg.replace(/(\bsrc\s*=\s*)"javascript:[^"]*"/gi, '$1""');
  svg = svg.replace(/(\bsrc\s*=\s*)'javascript:[^']*'/gi, "$1''");
  return Buffer.from(svg, "utf8");
}

export function sanitizeSvgFileIfNeeded(filePath) {
  if (path.extname(filePath).toLowerCase() !== ".svg") return;
  const buffer = fs.readFileSync(filePath);
  fs.writeFileSync(filePath, sanitizeSvgBuffer(buffer));
}
