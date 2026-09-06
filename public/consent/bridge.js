/*!
 * CMS CookieConsent bridge — versione nativa, generica e corretta.
 *
 * Sostituisce il vecchio "bridge.js" custom per-sito (media/<site>/consent/).
 * Le differenze chiave che CORREGGONO il bug "banner non appare / pixel morto":
 *
 * 1. RI-BANNER ATTIVO: il vecchio codice faceva `return` appena vedeva un
 *    cookie `cc_cookie`/`consent_*` (anche '0' o datato), quindi chi aveva un
 *    consenso revocato o scaduto NON vedeva più il banner e non poteva MAI
 *    concedere marketing → il pixel restava morto. Qui il banner si mostra
 *    se il consenso NON è "attivo" (marketing === '1'), indipendentemente
 *    dalla presenza di cookie storici.
 * 2. FALLBACK REALE: se la libreria non riesce a inizializzarsi, si invoca
 *    window.__cmsConsentFallbackNative() (che riattiva il banner nativo CMS,
 *    che sa mostrare banner + spara pixel). NIENTE più "nessun banner".
 * 3. POLLING ROBUSTO: attende window.CookieConsent con limiti, non un singolo
 *    onload fragile.
 * 4. REVISION: un numero di revisione nelle settings forza il ri-banner quando
 *    testi/config della libreria cambiano.
 * 5. Config DINAMICA (testi, posizione, lingua, 3 categorie) letta da
 *    window.__cmsConsentConfig, iniettata dal template Tracking (per-sito).
 *
 * La libreria viene servita staticamente da /consent/consent.js (nel repo).
 */
(function () {
  'use strict';

  // ── Config iniettata dal CMS ─────────────────────────────────────────────
  var C = window.__cmsConsentConfig || {};
  var POSITION = (C.position && ['bottom right','bottom left','bottom center','top center','middle'].indexOf(C.position) > -1)
    ? C.position
    : 'bottom right';
  var LANG = C.language || 'it';
  var REVISION = parseInt(C.revision, 10) || 0;

  function cookieDomain() {
    var h = location.hostname;
    if (!h || h === 'localhost' || /^[\d.]+$/.test(h)) return null;
    var p = h.split('.');
    if (p.length >= 2) return '.' + p.slice(-2).join('.');
    return null;
  }
  function setCookie(name, value, days) {
    var expires = new Date(Date.now() + days * 86400000).toUTCString();
    var secure = location.protocol === 'https:' ? '; Secure' : '';
    var d = cookieDomain();
    document.cookie = name + '=' + encodeURIComponent(value) +
      '; expires=' + expires + '; path=/; SameSite=Lax' + (d ? '; Domain=' + d : '') + secure;
  }
  function getCookie(name) {
    var m = document.cookie.match('(?:^|; )' + name + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : '';
  }

  // ── Consent Mode v2 + Pixel ──────────────────────────────────────────────
  // Riusa window.__cmsApplyConsent (esposto dal template CMS a ogni page
  // load). Così il re-apply qui usa la guardia anti-doppio PageView
  // (__cmsPageViewFired) e rispetta trackPageview: se il template ha già
  // ri-applicato il consenso al load, il bridge NON spara un secondo
  // PageView. Fallback locale di sicurezza se il template non l'ha esposto.
  var applyConsent = (typeof window.__cmsApplyConsent === 'function')
    ? window.__cmsApplyConsent
    : function (analytics, marketing) {
        if (window.gtag) {
          try {
            gtag('consent', 'update', {
              'analytics_storage': analytics ? 'granted' : 'denied',
              'ad_storage': marketing ? 'granted' : 'denied',
              'ad_user_data': marketing ? 'granted' : 'denied',
              'ad_personalization': marketing ? 'granted' : 'denied'
            });
          } catch (e) {}
        }
        try {
          if (marketing) {
            if (window.fbq) { fbq('consent', 'grant'); fbq('track', 'PageView'); }
            window.__cmsMarketingGranted = true;
            window.dispatchEvent(new Event('cms:marketing-granted'));
          } else if (window.fbq) {
            fbq('consent', 'revoke');
          }
        } catch (e) {}
      };

  // Converte le categorie della lib nei cookie che il resto del CMS legge.
  function bridge(cookie) {
    var cats = (cookie && cookie.categories) || [];
    var a = cats.indexOf('analytics') > -1;
    var m = cats.indexOf('marketing') > -1;
    setCookie('consent_analytics', a ? '1' : '0', 365);
    setCookie('consent_marketing', m ? '1' : '0', 365);
    try { if (window.__cmsConsentGtagUpdate) window.__cmsConsentGtagUpdate(a, m); } catch (e) {}
    applyConsent(a, m);
  }

  // ── Costruzione traduzioni (per-sito, XSS-safe lato server) ─────────────
  function t(key, fallback) {
    var v = C[key];
    return (typeof v === 'string' && v.length) ? v : fallback;
  }
  function translations() {
    return {
      consentModal: {
        title: t('title', 'Privacy & Cookie'),
        description: t('description', 'Utilizziamo cookie tecnici e, previo tuo consenso, cookie di analisi e marketing.'),
        acceptAllBtn: t('acceptAllLabel', 'Accetta tutto'),
        acceptNecessaryBtn: t('rejectLabel', 'Rifiuta non essenziali'),
        showPreferencesBtn: t('preferencesLabel', 'Preferenze')
      },
      preferencesModal: {
        title: t('preferencesTitle', 'Preferenze Cookie'),
        acceptAllBtn: t('acceptAllLabel', 'Accetta tutto'),
        acceptNecessaryBtn: t('rejectAllLabel', 'Rifiuta tutto'),
        savePreferencesBtn: t('saveLabel', 'Salva preferenze'),
        closeIconLabel: t('closeLabel', 'Chiudi'),
        sections: [
          { title: t('necessaryTitle', 'Necessari'), description: t('necessaryDesc', 'Cookie strettamente necessari al funzionamento del sito. Sempre attivi.'), toggle: { value: 'necessary', enabled: true, readonly: true } },
          { title: t('analyticsTitle', 'Analisi'), description: t('analyticsDesc', 'Ci aiutano a capire come utilizzi il sito (in forma aggregata).'), toggle: { value: 'analytics', enabled: true, readonly: false } },
          { title: t('marketingTitle', 'Marketing'), description: t('marketingDesc', 'Usati per tracciare e personalizzare annunci pubblicitari.'), toggle: { value: 'marketing', enabled: true, readonly: false } }
        ]
      }
    };
  }

  // ── Avvio con fallback reale ─────────────────────────────────────────────
  var attempts = 0;
  function start() {
    if (!window.CookieConsent) {
      // fallback REALE: se la lib non arriva entro ~2.5s, riattiva banner nativo.
      if (attempts++ < 50) { setTimeout(start, 50); return; }
      try { if (window.__cmsConsentFallbackNative) window.__cmsConsentFallbackNative(); } catch (e) {}
      return;
    }

    // Consenso ATTIVO (marketing === '1' via cookie nativi o cc_cookie) →
    // riapplichiamo il consenso e NON mostriamo di nuovo il banner. Se invece
    // il consenso è revocato ('0') o assente → NON torniamo e lasciamo che la
    // lib mostri il banner (autoShow di default). Questo CORREGGE il bug del
    // vecchio bridge: un consenso revocato/datato NON dev'essere più un motivo
    // per bloccare il banner (che era il caso "pixel morto su ritorno").
    var storedM = getCookie('consent_marketing');
    var storedA = getCookie('consent_analytics');
    var cc = null;
    try { cc = JSON.parse(getCookie('cc_cookie') || '{}'); } catch (e) { cc = null; }
    var ccM = !!(cc && cc.categories && cc.categories.indexOf('marketing') > -1);
    if (storedM === '1' || storedA === '1' || ccM) {
      var a = storedA === '1';
      var m = storedM === '1' || ccM;
      applyConsent(a, m);
      return;
    }
    try {
      CookieConsent.run({
        root: 'body',
        hideFromBots: false,
        revision: REVISION,
        guiOptions: {
          consentModal: { layout: 'box', position: POSITION },
          preferencesModal: { layout: 'box' }
        },
        categories: {
          necessary: { read_only: true, enabled: true },
          analytics: { enabled: true },
          marketing: { enabled: true }
        },
        language: { default: LANG, translations: (function () { var o = {}; o[LANG] = translations(); return o; })() },
        cookie: { name: 'cc_cookie', domain: cookieDomain() || undefined, path: '/', expires: 365 },
        onFirstConsent: function (p) { bridge(p.cookie); },
        onConsent: function (p) { bridge(p.cookie); }
      });
      // Dopo il run, se l'utente ha un consenso ATTIVO non mostriamo nulla;
      // altrimenti la lib mostra il banner da sola (autoShow di default).
    } catch (e) {
      try { if (window.__cmsConsentFallbackNative) window.__cmsConsentFallbackNative(); } catch (e2) {}
    }
  }
  start();
})();