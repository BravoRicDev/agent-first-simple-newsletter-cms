import config from "../config.js";
import { translate } from "../middleware/i18n.js";
import { getBlogSetting } from "./blog-settings.js";

export const SEARCH_RE = /\{\{search(?::([^}]*))?\}\}/g;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const jsStr = (s) => JSON.stringify(String(s)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
const STYLE = "<style>.cms-search{max-width:640px;margin:1rem 0}.cms-search__form{display:flex;gap:.5rem}.cms-search__input{flex:1;padding:.6rem .8rem;border:1px solid #ccc;border-radius:6px;font:inherit}.cms-search__btn{padding:.6rem 1rem;border:0;border-radius:6px;background:#111;color:#fff;font:inherit;cursor:pointer}.cms-search__results{list-style:none;margin:1rem 0 0;padding:0}.cms-search__results li{margin:0 0 1rem}.cms-search__results a{font-weight:600}.cms-search__results p{margin:.2rem 0 0;color:#444}.cms-search__results mark{background:#fff3a3}</style>";

export function renderSearchWidget(placeholder, index) {
  const lang = config.defaultLang;
  const ph = placeholder || translate(lang, "search.placeholder");
  const label = translate(lang, "search.button");
  const empty = translate(lang, "search.empty");
  const id = `cms-search-${index}`;
  const js = `(function(){var root=document.getElementById(${jsStr(id)});if(!root)return;var form=root.querySelector("form"),input=root.querySelector("input"),list=root.querySelector("ul"),timer=null,last="";`
    + `function render(items){list.innerHTML="";if(!items.length){var e=document.createElement("li");e.textContent=${jsStr(empty)};list.appendChild(e);return;}`
    + `items.forEach(function(r){if(!r.url||r.url.charAt(0)!=="/"||r.url.charAt(1)==="/")return;var li=document.createElement("li"),a=document.createElement("a"),p=document.createElement("p");a.href=r.url;a.textContent=r.title||r.url;p.innerHTML=r.snippet||"";li.appendChild(a);li.appendChild(p);list.appendChild(li);});}`
    + `function run(){var q=input.value.trim();if(q.length<2||q===last)return;last=q;var x=new XMLHttpRequest();x.open("GET","/api/public/search?q="+encodeURIComponent(q)+"&limit=10");x.onload=function(){if(x.status===200){try{render(JSON.parse(x.responseText).results||[]);}catch(err){}}};x.send();}`
    + `input.addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(run,300);});form.addEventListener("submit",function(ev){ev.preventDefault();run();});})();`;
  return (index === 0 ? STYLE : "")
    + `<div class="cms-search" id="${id}"><form class="cms-search__form" role="search"><input class="cms-search__input" type="search" name="q" minlength="2" maxlength="100" placeholder="${esc(ph)}" aria-label="${esc(ph)}"><button class="cms-search__btn" type="submit">${esc(label)}</button></form><ul class="cms-search__results" aria-live="polite"></ul></div>`
    + `<script>${js}</script>`;
}

export async function expandSearch(siteId, html) {
  if (typeof html !== "string" || !html.includes("{{search")) return html;
  const enabled = (await getBlogSetting(siteId, "search_enabled")) === "1";
  let i = 0;
  return html.replace(SEARCH_RE, (_m, ph) => (enabled ? renderSearchWidget(String(ph || "").trim(), i++) : ""));
}
