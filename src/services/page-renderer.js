import { query } from "../db.js";
import { renderCardTemplate, deriveExcerptFromContent, estimateReadingTime, formatShortDate } from "./blog-index.js";
import { getBlogConfig } from "./blog-settings.js";

const SNIPPET_RE = /\{\{snippet:([a-zA-Z0-9_-]+)\}\}/g;
const VARIABLE_RE = /\{\{var:([a-zA-Z0-9_-]+)\}\}/g;
const FORM_RE = /\{\{form:([a-zA-Z0-9_-]+)\}\}/g;
const CALENDAR_RE = /\{\{calendar:([a-zA-Z0-9_-]+)\}\}/g;
const QUIZ_RE = /\{\{quiz:([a-zA-Z0-9_-]+)\}\}/g;
// Il gruppo dei parametri è opzionale: `{{articles}}` nudo è valido (default).
const ARTICLES_RE = /\{\{articles(?::([^}]*))?\}\}/g;
// `article:` (SINGOLO, non `articles:`): il gruppo url_path è OBBLIGATORIO —
// senza un url_path non si sa quale articolo mostrare.
const ARTICLE_RE = /\{\{article:([^}]+)\}\}/g;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderFormField(field) {
  const key = escapeHtml(field.key);
  const label = escapeHtml(field.label || field.key) + (field.required ? " *" : "");
  const required = field.required ? " required" : "";
  const id = `field_${key}`;

  if (field.type === "textarea") {
    return `<div class="cms-form-field"><label for="${id}">${label}</label><textarea id="${id}" name="${key}"${required}></textarea></div>`;
  }
  if (field.type === "select") {
    const options = (field.options || []).map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
    return `<div class="cms-form-field"><label for="${id}">${label}</label><select id="${id}" name="${key}"${required}><option value="">—</option>${options}</select></div>`;
  }
  if (field.type === "radio") {
    const options = (field.options || []).map((o, i) =>
      `<label class="cms-form-radio-option"><input type="radio" id="${id}_${i}" name="${key}" value="${escapeHtml(o)}"${required}> ${escapeHtml(o)}</label>`
    ).join("");
    return `<fieldset class="cms-form-field"><legend>${label}</legend>${options}</fieldset>`;
  }
  if (field.type === "checkbox") {
    return `<div class="cms-form-field cms-form-checkbox"><label><input type="checkbox" id="${id}" name="${key}" value="1"${required}> ${label}</label></div>`;
  }
  const inputType = field.type === "email" || field.type === "tel" ? field.type : "text";
  return `<div class="cms-form-field"><label for="${id}">${label}</label><input type="${inputType}" id="${id}" name="${key}"${required}></div>`;
}

// Genera l'HTML del form dai campi definiti dall'utente in admin/forms/builder
// (voluti liberi, quindi sempre escapati) — l'action punta alla route
// pubblica generica /forms/:siteId/:slug, già esistente e invariata.
function renderFormHtml(siteId, form) {
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const fieldsHtml = fields.map(renderFormField).join("\n  ");
  const submitLabel = escapeHtml(form.submit_label || "Invia");
  return `<form class="cms-form" action="/forms/${siteId}/${escapeHtml(form.slug)}" method="POST">
  <input type="text" name="_honeypot" style="position:absolute;left:-9999px;top:-9999px;" tabindex="-1" autocomplete="off" aria-hidden="true">
  ${fieldsHtml}
  <button type="submit">${submitLabel}</button>
  <script>
  (function () {
    // UTM standard (Meta/Google Ads): legge i 5 parametri dall'URL della
    // landing e li inietta come hidden input -> il server li cattura anche
    // se il form NON dichiara alcun campo utm. Nessuna modifica ai singoli
    // form: è il comportamento attivo ovunque dopo il deploy, anche nelle
    // pagine esportate staticamente.
    var keys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
    var params = new URLSearchParams(location.search);
    var form = document.currentScript ? document.currentScript.closest("form") : null;
    if (!form) return;
    keys.forEach(function (k) {
      var v = params.get(k);
      if (v === null || v === "") return;
      if (v.length > 255) v = v.slice(0, 255);
      var h = form.querySelector('input[name="' + k + '"]');
      if (!h) { h = document.createElement("input"); h.type = "hidden"; h.name = k; form.appendChild(h); }
      h.value = v;
    });
  })();
  </script>
</form>`;
}

async function expandForms(siteId, html) {
  const matches = [...html.matchAll(FORM_RE)];
  if (matches.length === 0) return html;
  const slugs = [...new Set(matches.map(m => m[1]))];
  const placeholders = slugs.map((_, i) => `$${i + 2}`);
  const rows = (await query(
    `SELECT slug, submit_label, fields FROM forms WHERE site_id = $1 AND slug IN (${placeholders.join(",")})`,
    [siteId, ...slugs]
  )).rows;
  const map = {};
  for (const row of rows) map[row.slug] = row;
  return html.replace(FORM_RE, (full, slug) => (map[slug] ? renderFormHtml(siteId, map[slug]) : full));
}

async function expandVariables(siteId, html) {
  const matches = [...html.matchAll(VARIABLE_RE)];
  if (matches.length === 0) return html;
  const keys = [...new Set(matches.map(m => m[1]))];
  const placeholders = keys.map((_, i) => `$${i + 2}`);
  const rows = (await query(
    `SELECT key, value FROM site_variables WHERE site_id = $1 AND key IN (${placeholders.join(",")})`,
    [siteId, ...keys]
  )).rows;
  const map = {};
  for (const row of rows) map[row.key] = row.value;
  return html.replace(VARIABLE_RE, (_, key) => map[key] ?? "");
}

// Widget calendario prenotazioni: genera HTML autonomo (markup + CSS scoped +
// JS inline) che carica gli slot via GET /book/:siteId/:slug/slots e prenota
// via POST sullo stesso path. Funziona identico sia quando la pagina è servita
// da Express sia dopo l'export statico (il fetch va comunque a Express, che
// resta dietro Caddy per i path non statici). I nomi arrivano dal DB admin
// quindi sono escapati; i valori ISO degli slot sono generati dal server.
function renderCalendarWidget(siteId, calendar) {
  const name = escapeHtml(calendar.name);
  const slug = escapeHtml(calendar.slug);
  const description = escapeHtml(calendar.description || "");
  return `<div class="cms-calendar" data-site="${siteId}" data-slug="${slug}">
  <div class="cms-calendar-head">
    <strong>${name}</strong>
    ${description ? `<span class="cms-calendar-desc">${description}</span>` : ""}
  </div>
  <div class="cms-calendar-slots" aria-live="polite"><p class="cms-calendar-empty">Caricamento disponibilità…</p></div>
  <form class="cms-calendar-form" hidden>
    <input type="hidden" name="slot">
    <input type="text" name="_honeypot" style="position:absolute;left:-9999px;top:-9999px;" tabindex="-1" autocomplete="off" aria-hidden="true">
    <div class="cms-calendar-field"><label>Nome</label><input type="text" name="name" required></div>
    <div class="cms-calendar-field"><label>Email</label><input type="email" name="email" required></div>
    <button type="submit">Prenota</button>
  </form>
  <div class="cms-calendar-msg" role="status"></div>
</div>
<style>
.cms-calendar{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;color:#333;border:1px solid #e5e7eb;border-radius:8px;padding:16px;max-width:480px;background:#fff}
.cms-calendar-head{display:flex;flex-direction:column;gap:2px;margin-bottom:12px}
.cms-calendar-head strong{font-size:16px}
.cms-calendar-desc{font-size:13px;color:#666}
.cms-calendar-day{margin:12px 0 6px;font-size:12px;font-weight:600;color:#666;text-transform:capitalize}
.cms-calendar-slots{display:flex;flex-wrap:wrap;gap:8px}
.cms-calendar-slot{background:#f3f4f6;border:1px solid #ddd;border-radius:6px;padding:6px 10px;font-size:13px;cursor:pointer}
.cms-calendar-slot:hover{background:#e5e7eb}
.cms-calendar-slot.selected{background:#4f46e5;color:#fff;border-color:#4f46e5}
.cms-calendar-empty{color:#999;font-size:13px;margin:4px 0}
.cms-calendar-form{margin-top:14px;display:flex;flex-direction:column;gap:10px}
.cms-calendar-field{display:flex;flex-direction:column;gap:3px}
.cms-calendar-field label{font-size:12px;font-weight:600}
.cms-calendar-field input{padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:14px}
.cms-calendar-form button{padding:10px;background:#4f46e5;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer}
.cms-calendar-form button:disabled{background:#c7c7c7;cursor:not-allowed}
.cms-calendar-msg{margin-top:10px;font-size:13px}
.cms-calendar-msg.ok{color:#065f46;background:#d1fae5;border-radius:6px;padding:8px 10px}
.cms-calendar-msg.err{color:#991b1b;background:#fee2e2;border-radius:6px;padding:8px 10px}
</style>
<script>
(function(){
  function initCalendar(root){
    var siteId = root.getAttribute('data-site');
    var slug = root.getAttribute('data-slug');
    var endpoint = '/book/' + siteId + '/' + slug;
    var slotsBox = root.querySelector('.cms-calendar-slots');
    var form = root.querySelector('.cms-calendar-form');
    var msg = root.querySelector('.cms-calendar-msg');
    var selected = null;
    function setMsg(text, isError){
      msg.textContent = text || '';
      msg.className = 'cms-calendar-msg' + (isError ? ' err' : (text ? ' ok' : ''));
    }
    function renderSlots(groups){
      slotsBox.textContent = '';
      if (!groups || groups.length === 0){
        var p = document.createElement('p');
        p.className = 'cms-calendar-empty';
        p.textContent = 'Nessuno slot disponibile al momento.';
        slotsBox.appendChild(p);
        return;
      }
      groups.forEach(function(g){
        var day = document.createElement('div');
        day.className = 'cms-calendar-day';
        day.textContent = new Date(g.day + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
        slotsBox.appendChild(day);
        var wrap = document.createElement('div');
        wrap.className = 'cms-calendar-slots';
        g.slots.forEach(function(s){
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'cms-calendar-slot';
          btn.textContent = new Date(s.start).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
          btn.addEventListener('click', function(){
            if (selected) selected.classList.remove('selected');
            btn.classList.add('selected');
            selected = btn;
            form.hidden = false;
            form.querySelector('input[name="slot"]').value = s.start;
          });
          wrap.appendChild(btn);
        });
        slotsBox.appendChild(wrap);
      });
    }
    fetch(endpoint + '/slots', { headers: { 'Accept': 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function(data){ renderSlots(data.groups); })
      .catch(function(){ 
        slotsBox.textContent = '';
        var p = document.createElement('p');
        p.className = 'cms-calendar-empty';
        p.textContent = 'Disponibilità non disponibile al momento.';
        slotsBox.appendChild(p);
      });
    form.addEventListener('submit', function(ev){
      ev.preventDefault();
      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      setMsg('');
      var body = new URLSearchParams();
      body.set('slot', form.querySelector('input[name="slot"]').value);
      body.set('name', form.querySelector('input[name="name"]').value);
      body.set('email', form.querySelector('input[name="email"]').value);
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      }).then(function(r){
        return r.json().catch(function(){ return {}; }).then(function(data){ return { status: r.status, data: data }; });
      }).then(function(res){
        if (res.status === 200 && res.data.ok){
          if (res.data.redirect){ window.location.href = res.data.redirect; return; }
          setMsg("Prenotazione confermata! Riceverai un'email di conferma.");
          form.hidden = true;
          form.reset();
          if (selected) selected.classList.remove('selected');
          selected = null;
          slotsBox.textContent = '';
          var p = document.createElement('p');
          p.className = 'cms-calendar-empty';
          p.textContent = 'Slot prenotato.';
          slotsBox.appendChild(p);
        } else {
          setMsg(res.data.error || 'Errore durante la prenotazione. Riprova.', true);
          btn.disabled = false;
        }
      }).catch(function(){
        setMsg('Errore di rete durante la prenotazione. Riprova.', true);
        btn.disabled = false;
      });
    });
  }
  var roots = document.querySelectorAll('.cms-calendar');
  for (var i = 0; i < roots.length; i++) initCalendar(roots[i]);
})();
</script>`;
}

async function expandCalendars(siteId, html) {
  const matches = [...html.matchAll(CALENDAR_RE)];
  if (matches.length === 0) return html;
  const slugs = [...new Set(matches.map(m => m[1]))];
  const placeholders = slugs.map((_, i) => `$${i + 2}`);
  const rows = (await query(
    `SELECT slug, name, description, enabled FROM calendars WHERE site_id = $1 AND slug IN (${placeholders.join(",")})`,
    [siteId, ...slugs]
  )).rows;
  const map = {};
  for (const row of rows) map[row.slug] = row;
  return html.replace(CALENDAR_RE, (full, slug) => (map[slug] && map[slug].enabled ? renderCalendarWidget(siteId, map[slug]) : full));
}

// Questionario con punteggi: domande a risposta singola, ogni opzione ha un
// punteggio; al submit si sommano i punti, si trova la soglia (threshold) e
// si mostra il verdetto (titolo + messaggio). Il calcolo avviene client-side
// per feedback immediato (funziona anche nell'export statico), ma al submit
// il server RICALCOLA il punteggio dalle definizioni (fonte di verità) e
// salva la submission in quiz_submissions — un client modificato non può
// gonfiare il proprio punteggio.
function renderQuizWidget(siteId, quiz) {
  const name = escapeHtml(quiz.name);
  const slug = escapeHtml(quiz.slug);
  const intro = escapeHtml(quiz.intro || "");
  const submitLabel = escapeHtml(quiz.submit_label || "Calcola il risultato");
  const questions = Array.isArray(quiz.questions) ? quiz.questions : [];
  const thresholds = Array.isArray(quiz.thresholds) ? quiz.thresholds : [];

  const questionsHtml = questions.map((q, qi) => {
    const key = escapeHtml(q.key || `q_${qi + 1}`);
    const label = escapeHtml(q.label || `Domanda ${qi + 1}`);
    const options = Array.isArray(q.options) ? q.options : [];
    const optionsHtml = options.map((opt, oi) => {
      const optLabel = escapeHtml(opt.label || `Opzione ${oi + 1}`);
      const points = Number.isFinite(Number(opt.points)) ? Number(opt.points) : 0;
      return `<label class="cms-quiz-option"><input type="radio" name="${key}" value="${optLabel}" data-points="${points}"${oi === 0 ? " checked" : ""}> <span>${optLabel} <em class="cms-quiz-points">(${points > 0 ? "+" : ""}${points} pt)</em></span></label>`;
    }).join("\n      ");
    return `<fieldset class="cms-quiz-question"><legend>${label}</legend>\n      ${optionsHtml}\n    </fieldset>`;
  }).join("\n  ");

  const emailField = quiz.ask_email
    ? `\n    <div class="cms-quiz-field"><label for="${slug}_email">Email (per ricevere il risultato, facoltativa)</label><input type="email" id="${slug}_email" name="email" autocomplete="email"></div>`
    : "";

  // JSON per il calcolo client-side: etichette opzioni -> punti (per
  // ricostruire il totale senza fidarsi di data-points manipolabili).
  const pointsMap = {};
  for (const q of questions) {
    for (const opt of (q.options || [])) {
      if (opt.label !== undefined && opt.label !== null && opt.label !== "") {
        pointsMap[String(opt.label)] = Number.isFinite(Number(opt.points)) ? Number(opt.points) : 0;
      }
    }
  }
  const pointsJson = JSON.stringify(pointsMap).replace(/</g, "\\u003c");
  const thresholdsJson = JSON.stringify(thresholds).replace(/</g, "\\u003c");
  const successMessage = escapeHtml(quiz.success_message || "");

  return `<div class="cms-quiz" data-site="${siteId}" data-slug="${slug}">
  <div class="cms-quiz-head">
    <strong>${name}</strong>
    ${intro ? `<p class="cms-quiz-intro">${intro}</p>` : ""}
  </div>
  <form class="cms-quiz-form">
    <input type="text" name="_honeypot" style="position:absolute;left:-9999px;top:-9999px;" tabindex="-1" autocomplete="off" aria-hidden="true">
    <div class="cms-quiz-questions">
      ${questionsHtml}
    </div>
    ${emailField}
    <button type="submit" class="cms-quiz-submit">${submitLabel}</button>
  </form>
  <div class="cms-quiz-result" hidden>
    <div class="cms-quiz-badge"></div>
    <p class="cms-quiz-message"></p>
  </div>
  <div class="cms-quiz-msg" role="status"></div>
</div>
<style>
.cms-quiz{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;color:#333;border:1px solid #e5e7eb;border-radius:8px;padding:16px;max-width:560px;background:#fff}
.cms-quiz-head{display:flex;flex-direction:column;gap:4px;margin-bottom:14px}
.cms-quiz-head strong{font-size:17px}
.cms-quiz-intro{font-size:13px;color:#666;margin:0}
.cms-quiz-question{border:1px solid #eef0f3;border-radius:8px;padding:12px 14px;margin-bottom:10px}
.cms-quiz-question legend{font-size:14px;font-weight:600;padding:0 4px}
.cms-quiz-option{display:flex;align-items:flex-start;gap:8px;padding:7px 4px;font-size:14px;cursor:pointer}
.cms-quiz-option input{margin-top:3px}
.cms-quiz-points{font-style:normal;font-size:11px;color:#9ca3af}
.cms-quiz-submit{display:inline-block;margin-top:6px;padding:10px 18px;background:#4f46e5;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer}
.cms-quiz-submit:disabled{background:#c7c7c7;cursor:not-allowed}
.cms-quiz-field{display:flex;flex-direction:column;gap:4px;margin:10px 0}
.cms-quiz-field label{font-size:12px;font-weight:600}
.cms-quiz-field input{padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:14px;max-width:320px}
.cms-quiz-result{margin-top:14px;border-radius:8px;padding:14px 16px}
.cms-quiz-result.ok{background:#d1fae5;border:1px solid #6ee7b7}
.cms-quiz-result.warn{background:#fef3c7;border:1px solid #fcd34d}
.cms-quiz-result.cold{background:#f3f4f6;border:1px solid #e5e7eb}
.cms-quiz-badge{font-size:16px;font-weight:700;margin-bottom:4px}
.cms-quiz-message{margin:0;font-size:13px;line-height:1.5}
.cms-quiz-msg{margin-top:10px;font-size:13px}
.cms-quiz-msg.err{color:#991b1b;background:#fee2e2;border-radius:6px;padding:8px 10px}
</style>
<script>
(function(){
  var POINTS = ${pointsJson};
  var THRESHOLDS = ${thresholdsJson};
  function findThreshold(points){
    var best = null;
    for (var i = 0; i < THRESHOLDS.length; i++){
      var t = THRESHOLDS[i];
      var min = Number(t.min);
      if (isNaN(min)) min = -Infinity;
      // max null/undefined/vuoto = open-ended: Number(null)===0 romperebbe
      // la soglia finale, quindi il check deve venire PRIMA del cast.
      var max;
      if (t.max === null || t.max === undefined || t.max === '') { max = Infinity; }
      else { max = Number(t.max); if (isNaN(max)) max = Infinity; }
      if (points >= min && points <= max){ best = t; }
    }
    return best || null;
  }
  function initQuiz(root){
    var siteId = root.getAttribute('data-site');
    var slug = root.getAttribute('data-slug');
    var endpoint = '/quiz/' + siteId + '/' + slug;
    var form = root.querySelector('.cms-quiz-form');
    var resultBox = root.querySelector('.cms-quiz-result');
    var badge = root.querySelector('.cms-quiz-badge');
    var message = root.querySelector('.cms-quiz-message');
    var msg = root.querySelector('.cms-quiz-msg');
    var submitBtn = form.querySelector('.cms-quiz-submit');
    function setMsg(text, isError){
      msg.textContent = text || '';
      msg.className = 'cms-quiz-msg' + (isError ? ' err' : '');
    }
    function collectAnswers(){
      var answers = {};
      var radios = form.querySelectorAll('input[type="radio"]');
      for (var i = 0; i < radios.length; i++){
        if (radios[i].checked){
          answers[radios[i].name] = radios[i].value;
        }
      }
      return answers;
    }
    function computePoints(answers){
      var total = 0;
      for (var k in answers){
        if (Object.prototype.hasOwnProperty.call(answers, k)){
          total += Number(POINTS[answers[k]] || 0);
        }
      }
      return total;
    }
    function showResult(points, threshold){
      resultBox.hidden = false;
      resultBox.className = 'cms-quiz-result' + (threshold && threshold.class ? ' ' + threshold.class : '');
      badge.textContent = threshold && threshold.title ? threshold.title : ('Punteggio: ' + points);
      message.textContent = threshold && threshold.message ? threshold.message : '';
    }
    form.addEventListener('submit', function(ev){
      ev.preventDefault();
      submitBtn.disabled = true;
      setMsg('');
      var answers = collectAnswers();
      var points = computePoints(answers);
      var threshold = findThreshold(points);
      showResult(points, threshold);
      var emailInput = form.querySelector('input[name="email"]');
      var payload = { answers: answers, points: points };
      if (emailInput) payload.email = emailInput.value.trim();
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function(r){
        return r.json().catch(function(){ return {}; }).then(function(data){ return { status: r.status, data: data }; });
      }).then(function(res){
        if (res.status === 200 && res.data.ok){
          if (res.data.redirect){ window.location.href = res.data.redirect; return; }
          if (res.data.points !== undefined && res.data.points !== points){
            points = Number(res.data.points);
            showResult(points, findThreshold(points));
          }
          if (res.data.message && ${JSON.stringify(successMessage)}){
            setMsg(${JSON.stringify(successMessage)});
          }
        } else {
          setMsg(res.data.error || 'Errore durante il salvataggio del risultato.', true);
        }
        submitBtn.disabled = false;
      }).catch(function(){
        // Export statico senza rete: il risultato locale resta visibile.
        submitBtn.disabled = false;
      });
    });
  }
  var roots = document.querySelectorAll('.cms-quiz');
  for (var i = 0; i < roots.length; i++) initQuiz(roots[i]);
})();
</script>`;
}

async function expandQuizzes(siteId, html) {
  const matches = [...html.matchAll(QUIZ_RE)];
  if (matches.length === 0) return html;
  const slugs = [...new Set(matches.map(m => m[1]))];
  const placeholders = slugs.map((_, i) => `$${i + 2}`);
  const rows = (await query(
    `SELECT slug, name, description, intro, questions, thresholds, submit_label, success_message, ask_email, enabled FROM quizzes WHERE site_id = $1 AND slug IN (${placeholders.join(",")})`,
    [siteId, ...slugs]
  )).rows;
  const map = {};
  for (const row of rows) map[row.slug] = row;
  return html.replace(QUIZ_RE, (full, slug) => (map[slug] && map[slug].enabled ? renderQuizWidget(siteId, map[slug]) : full));
}

// Solo date "nude" YYYY-MM-DD, nessun orario. Un valore che non rispetta il
// pattern o che new Date() non sa interpretare viene ignorato silenziosamente
// (stesso trattamento degli altri parametri malformati: non deve mai rompere
// la pagina).
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateOnly(value) {
  return DATE_ONLY_RE.test(value) && !Number.isNaN(new Date(value).getTime());
}

// Tetto massimo di `limit`: resta un widget con un limite esplicito (non una
// paginazione), ma 24 si è rivelato troppo basso per un caso reale legittimo
// — un sito che vuole sostituire un intero feed homepage scritto a mano
// (es. 222 articoli) con lo snippet, senza inventare un meccanismo diverso.
// Alzato a un tetto comunque bounded (nessun sito può passare un numero
// arbitrario che generi un blocco illimitato): generale, non specifico per
// nessun sito.
const MAX_ARTICLES_LIMIT = 500;

// Parsing parametri dello snippet {{articles:...}}: gruppo opzionale
// (undefined/null = nessun parametro), parametri separati da `|`, ciascuno
// `chiave=valore`. Riconosciute 6 chiavi: category (uno o più slug separati
// da virgola — SEMPRE un array se presente, con un solo elemento per il caso
// singolo, per uniformità), limit (intero, default 6, clampato
// 1..MAX_ARTICLES_LIMIT), show_date (booleano, default true), date_from/
// date_to (date YYYY-MM-DD inclusive, solo se valide), enable_client_filter
// (booleano, default FALSE: solo se true inietta data-category="<slug>" sul
// tag principale di ogni card, per un eventuale filtro JS lato client — un
// sito che veicola già la categoria a modo suo, es. nel proprio
// card_template_override, non deve vedersi aggiungere un attributo non
// richiesto). Parametri non riconosciuti/malformati: ignorati silenziosamente.
function parseArticlesParams(raw) {
  const params = {
    category: null, limit: 6, show_date: true, date_from: null, date_to: null,
    enable_client_filter: false,
  };
  if (!raw) return params;
  for (const part of raw.split("|")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "category") {
      const slugs = value.split(",").map(s => s.trim()).filter(s => s !== "");
      if (slugs.length > 0) params.category = slugs;
    } else if (key === "limit") {
      const n = parseInt(value, 10);
      if (Number.isFinite(n)) params.limit = Math.min(MAX_ARTICLES_LIMIT, Math.max(1, n));
    } else if (key === "show_date") {
      params.show_date = value !== "false";
    } else if (key === "date_from") {
      if (isValidDateOnly(value)) params.date_from = value;
    } else if (key === "date_to") {
      if (isValidDateOnly(value)) params.date_to = value;
    } else if (key === "enable_client_filter") {
      params.enable_client_filter = value === "true";
    }
  }
  return params;
}

// data-category sul primo tag HTML (stesso trucco di homepage-sections.js e
// già in uso per le card di expandArticleLists): SOLO se l'articolo ha una
// categoria risolta. Estratta in funzione condivisa per non duplicarla tra
// liste e singolo articolo.
function injectDataCategory(html, slug) {
  return html.replace(/^<([a-zA-Z0-9]+)/,
    (m, tag) => `<${tag} data-category="${escapeHtml(slug)}"`);
}

// Widget {{articles:...}} (roadmap §10): liste articoli filtrabili per
// categoria incollabili in qualunque pagina. Riusa lo stesso
// renderCardTemplate/blog_card_template del blog e delle homepage. Stesso
// contratto d'errore degli altri expand*: se lo slug categoria non esiste per
// il sito, il placeholder resta invariato in HTML (così l'owner si accorge
// dell'errore); "categoria trovata ma zero articoli" → stringa vuota.
export async function expandArticleLists(siteId, html) {
  const matches = [...html.matchAll(ARTICLES_RE)];
  if (matches.length === 0) return html;

  // Raggruppa per combinazione UNICA di parametri: stessa category+limit+
  // show_date → stessa query, eseguita una sola volta anche se identica in
  // più punti della pagina.
  const combos = new Map();
  for (const m of matches) {
    const params = parseArticlesParams(m[1]);
    const key = JSON.stringify(params);
    if (!combos.has(key)) combos.set(key, { params, results: null });
  }

  const config = await getBlogConfig(siteId);
  const imageToken = "ARTICLES_IMAGE_BLOCK_TOKEN";

  for (const combo of combos.values()) {
    const { params } = combo;

    // Se category è presente, risolvi TUTTI gli slug → id con UNA sola query.
    // Se ANCHE UNO SOLO degli slug richiesti manca, l'intera combinazione
    // produce "categoria non trovata" (placeholder invariato) — stessa
    // filosofia dello slug singolo: un typo nello slug deve essere visibile
    // all'owner, non ignorato silenziosamente. DIVERSO da "categorie risolte
    // ma zero articoli" (stringa vuota).
    let categoryIds = null;
    if (params.category) {
      const rows = (await query(
        "SELECT id, slug FROM categories WHERE site_id = $1 AND slug = ANY($2::text[])",
        [siteId, params.category]
      )).rows;
      const found = new Set(rows.map(r => r.slug));
      if (params.category.some(slug => !found.has(slug))) {
        combo.results = { miss: true };
        continue;
      }
      categoryIds = rows.map(r => r.id);
    }

    let sql = `SELECT p.id, p.title, p.excerpt, p.featured_image, p.published_at, p.url_path, p.content,
       p.reading_time_minutes,
       c.slug AS category_slug, c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
       c.custom_css AS category_custom_css
       FROM pages p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.site_id = $1 AND p.post_type = 'article' AND p.published = true`;
    const queryParams = [siteId];
    if (categoryIds) {
      queryParams.push(categoryIds);
      sql += ` AND p.category_id = ANY($${queryParams.length}::int[])`;
    }
    if (params.date_from) {
      queryParams.push(`${params.date_from} 00:00:00`);
      sql += ` AND p.published_at >= $${queryParams.length}`;
    }
    if (params.date_to) {
      queryParams.push(`${params.date_to} 23:59:59`);
      sql += ` AND p.published_at <= $${queryParams.length}`;
    }
    queryParams.push(params.limit);
    sql += ` ORDER BY p.published_at DESC NULLS LAST, p.id DESC LIMIT $${queryParams.length}`;
    const articles = (await query(sql, queryParams)).rows;

    const cards = [];
    const cssBlocks = [];
    const cssSeen = new Set();
    for (const article of articles) {
      const excerpt = article.excerpt || deriveExcerptFromContent(article.content);
      const imageHtml = article.featured_image ? `<img src="${escapeHtml(article.featured_image)}" alt="">` : "";
      const publishedAt = params.show_date && article.published_at
        ? new Date(article.published_at).toLocaleDateString("it-IT")
        : "";
      const publishedAtShort = params.show_date ? formatShortDate(article.published_at) : "";
      let cardHtml = renderCardTemplate(config.blog_card_template, {
        title: article.title,
        excerpt,
        url: article.url_path,
        image: imageToken,
        image_url: article.featured_image || "",
        published_at: publishedAt,
        published_at_short: publishedAtShort,
        category_name: article.category_name || "",
        category_url: article.category_slug ? `/blog/categoria/${article.category_slug}` : "",
        category_slug: article.category_slug || "",
        category_icon: article.category_icon || "",
        reading_time: article.reading_time_minutes ?? estimateReadingTime(article.content),
      }).replaceAll(imageToken, imageHtml);
      // data-category sul primo tag HTML della card: SOLO se richiesto
      // esplicitamente (enable_client_filter=true, default false — un sito
      // può già veicolare la categoria a modo suo, es. una classe CSS scritta
      // nel proprio card_template_override, e non deve vedersi aggiungere un
      // attributo che non ha chiesto) E se l'articolo ha una categoria risolta.
      if (params.enable_client_filter && article.category_slug) {
        cardHtml = injectDataCategory(cardHtml, article.category_slug);
      }
      cards.push(cardHtml);
      // CSS per categoria distinta (custom_css non vuoto), senza duplicati
      // nella stessa combinazione — anche per il caso "senza filtro
      // categoria", dove più categorie possono comparire tra gli articoli.
      if (article.category_custom_css && !cssSeen.has(article.category_slug)) {
        cssSeen.add(article.category_slug);
        cssBlocks.push(`<style>${article.category_custom_css}</style>`);
      }
    }

    // Zero articoli (categoria risolta o non richiesta) → stringa vuota.
    // Con articoli → style dei CSS di categoria (se presenti) + card.
    combo.results = { html: cssBlocks.join("\n") + cards.join("\n") };
  }

  return html.replace(ARTICLES_RE, (full, raw) => {
    const combo = combos.get(JSON.stringify(parseArticlesParams(raw)));
    if (combo.results && combo.results.miss) return full;
    return combo.results.html;
  });
}

// Widget {{article:<url_path>}}: embed del SINGOLO articolo completo (titolo,
// data, corpo HTML) incollabile in qualunque pagina. Riusa lo stesso
// renderCardTemplate/blog_article_embed_template del blog. Stesso contratto
// d'errore degli altri expand*: se l'url_path non esiste per il sito, il
// placeholder resta invariato in HTML (così l'owner si accorge dell'errore);
// la data è SEMPRE mostrata (snippet del singolo articolo completo, non c'è
// un parametro show_date). Contenuto e immagine passano per token dedicati
// perché renderCardTemplate li escaperebbe — sono HTML fidato per costruzione
// (scritto dal proprietario dello stesso sito).
export async function expandSingleArticles(siteId, html) {
  const matches = [...html.matchAll(ARTICLE_RE)];
  if (matches.length === 0) return html;

  // Stesso url_path incollato più volte → una sola query per articolo unico.
  const urlPaths = [...new Set(matches.map(m => m[1].trim()))];
  const map = {};
  for (const urlPath of urlPaths) {
    const row = (await query(
      `SELECT p.id, p.title, p.excerpt, p.featured_image, p.published_at, p.content,
         p.reading_time_minutes,
         c.slug AS category_slug, c.name AS category_name, c.color AS category_color,
         c.icon AS category_icon, c.custom_css AS category_custom_css
       FROM pages p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.site_id = $1 AND p.post_type = 'article' AND p.published = true AND p.url_path = $2`,
      [siteId, urlPath]
    )).rows[0];
    if (row) map[urlPath] = row;
  }

  const config = await getBlogConfig(siteId);
  const imageToken = "ARTICLE_IMAGE_BLOCK_TOKEN";
  const contentToken = "ARTICLE_CONTENT_BLOCK_TOKEN";

  return html.replace(ARTICLE_RE, (full, raw) => {
    const urlPath = raw.trim();
    const article = map[urlPath];
    if (!article) return full;
    const excerpt = article.excerpt || deriveExcerptFromContent(article.content);
    const imageHtml = article.featured_image ? `<img src="${escapeHtml(article.featured_image)}" alt="">` : "";
    const contentHtml = article.content || "";
    const publishedAt = article.published_at
      ? new Date(article.published_at).toLocaleDateString("it-IT")
      : "";
    let embedHtml = renderCardTemplate(config.blog_article_embed_template, {
      title: article.title,
      excerpt,
      content: contentToken,
      image: imageToken,
      image_url: article.featured_image || "",
      published_at: publishedAt,
      published_at_short: formatShortDate(article.published_at),
      category_name: article.category_name || "",
      category_url: article.category_slug ? `/blog/categoria/${article.category_slug}` : "",
      category_slug: article.category_slug || "",
      category_icon: article.category_icon || "",
      reading_time: article.reading_time_minutes ?? estimateReadingTime(article.content),
    })
      .replaceAll(imageToken, () => imageHtml)
      .replaceAll(contentToken, () => contentHtml);
    // Nessun data-category qui: è un embed di UN SOLO articolo, il
    // filtraggio client-side (data-category, vedi enable_client_filter in
    // expandArticleLists) ha senso solo tra più card di una lista.
    // CSS di categoria (custom_css non vuoto): <style> prima dell'HTML.
    const styleBlock = article.category_custom_css ? `<style>${article.category_custom_css}</style>` : "";
    return styleBlock + embedHtml;
  });
}

export async function expandSnippets(siteId, html) {
  let result = await expandVariables(siteId, html);
  let prev = "";
  let iterations = 0;
  const MAX_ITERATIONS = 10;
  while (result !== prev && iterations < MAX_ITERATIONS) {
    prev = result;
    iterations++;
    const matches = [...result.matchAll(SNIPPET_RE)];
    if (matches.length === 0) break;
    const names = [...new Set(matches.map(m => m[1]))];
    const placeholders = names.map((_, i) => `$${i + 2}`);
    const dbResult = await query(
      `SELECT name, content FROM snippets WHERE site_id = $1 AND name IN (${placeholders.join(",")})`,
      [siteId, ...names]
    );
    const map = {};
    for (const row of dbResult.rows) {
      map[row.name] = row.content;
    }
    result = result.replace(SNIPPET_RE, (_, name) => (map[name] !== undefined ? map[name] : ""));
    result = await expandVariables(siteId, result);
  }
  result = await expandForms(siteId, result);
  result = await expandCalendars(siteId, result);
  result = await expandQuizzes(siteId, result);
  result = await expandArticleLists(siteId, result);
  result = await expandSingleArticles(siteId, result);
  return result;
}
