/**
 * PureSim Chat Widget v1.7.0
 * WhatsApp-inspiriertes Design, Hell/Dunkel-Modus, Status-Dot, Toggle-Switch, Session-Tracking
 *
 * v1.7.0:
 *   • Hell/Dunkel-Modus per Mond/Sonne-Button im Header (Präferenz in localStorage)
 *   • Alle Farben über CSS Custom Properties (Variables) gesteuert
 *   • Verbesserte Bubble-Abstände und WhatsApp-style Tails
 *   • Float-right Timestamp (kein Overflow-Problem mehr bei kurzem Text)
 *   • Professionellere FAQ-Chips, größerer Exit-Button
 *   • Mobile: height:100dvh verhindert Cutoff unter Browser-Leiste
 */
(function(){
'use strict';

try {
  window.__VS25_LOADED = true;
  window.__VS25_VERSION = '1.7.0';
  window.__VS25_BOOT_AT = Date.now();
  if (window.console && console.log) {
    console.log('%c[VS25-Widget] v1.7.0 script loaded', 'color: #2563eb; font-weight: bold');
  }
} catch(_) {}

var _safeFetch = (typeof fetch === 'function') ? fetch : function(){
  return { then: function(){ return { then: function(){ return { catch: function(){} }; }, catch: function(){} }; }, catch: function(){} };
};

function _postTrack(path, body, tries){
  tries = (typeof tries === 'number') ? tries : 3;
  try {
    return _safeFetch(API+path, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'X-Chat-ID': (chatId||'') },
      body: JSON.stringify(body),
      keepalive: true
    }).then(function(r){
      if(r && r.ok === false && tries > 1) throw new Error('http_'+r.status);
      return (r && r.json) ? r.json().catch(function(){ return {}; }) : {};
    }).catch(function(){
      if(tries > 1){
        return new Promise(function(res){ setTimeout(res, 900); })
          .then(function(){ return _postTrack(path, body, tries-1); });
      }
      return {};
    });
  } catch(_) {
    return Promise.resolve({});
  }
}

var API=(function(){var s=document.querySelectorAll('script[src*="widget.js"]');return s.length?s[s.length-1].src.replace('/widget.js',''):'https://puresimaisupport.autoacts.link';})();
var chatId=null,isOpen=false,isTyping=false,_proDone=false,_handover=false,_faqUsed=false,_proTimer=null,_statusInt=null,_lastMsgTs=0;

var STORAGE_KEY='vs25_cid';
function _ssGet(){ try { return sessionStorage.getItem(STORAGE_KEY); } catch(_) { return null; } }
function _ssSet(v){ try { sessionStorage.setItem(STORAGE_KEY,v); } catch(_) {} }
function _ssClear(){
  try { sessionStorage.removeItem(STORAGE_KEY); } catch(_) {}
  try { localStorage.removeItem(STORAGE_KEY); } catch(_) {}
}
try {
  var _legacy = localStorage.getItem(STORAGE_KEY);
  if (_legacy && !_ssGet()) _ssSet(_legacy);
  if (_legacy) localStorage.removeItem(STORAGE_KEY);
} catch(_) {}

function smartTitle(){
  var path=location.pathname;
  var search=location.search;
  // Startseite
  if(path==='/'||path==='')return'Startseite';
  // Warenkorb
  if(/\/(cart|warenkorb)/i.test(path))return'Warenkorb';
  // Checkout
  if(/\/checkout/i.test(path)){
    if(/order[-_]?received|thank/i.test(path))return'Bestellung abgeschlossen ✅';
    return'Checkout';
  }
  // PureSim: Tarif-Detailseite /tariffs/slug
  var td=path.match(/\/tariffs\/([^/?#]+)/i);
  if(td)return'Tarif: '+td[1].replace(/-/g,' ');
  // PureSim: Tarif-Suche /tariffs?q=Deutschland
  if(/\/tariffs/i.test(path)){
    var qp=new URLSearchParams(search).get('q')||new URLSearchParams(search).get('search')||'';
    if(qp)return'Tarif-Suche: '+decodeURIComponent(qp).substring(0,40);
    return'Tarifübersicht';
  }
  // Account
  if(/\/account|\/my-account|\/mein-konto/i.test(path))return'Mein Konto';
  // eSIM aktivieren
  if(/\/activat|\/aktivier|\/install/i.test(path))return'eSIM aktivieren';
  // Über uns / Kontakt / FAQ
  if(/\/about|\/ueber-uns/i.test(path))return'Über uns';
  if(/\/contact|\/kontakt/i.test(path))return'Kontakt';
  if(/\/faq|\/hilfe|\/help/i.test(path))return'FAQ & Hilfe';
  // Blog
  var bp=path.match(/\/blog\/([^/?#]+)/i);
  if(bp)return'Blog: '+bp[1].replace(/-/g,' ').substring(0,40);
  if(/\/blog/i.test(path))return'Blog';
  // Produkt (WooCommerce)
  var pm=path.match(/\/product\/([^/?#]+)/i);
  if(pm)return pm[1].replace(/-/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();});
  // Kategorie
  var cm=path.match(/\/categor[yi]\/([^/?#]+)/i);
  if(cm)return'Kategorie: '+cm[1].replace(/-/g,' ');
  // Rechtliches
  if(/\/datenschutz|\/privacy/i.test(path))return'Datenschutz';
  if(/\/impressum|\/imprint/i.test(path))return'Impressum';
  if(/\/agb|\/terms/i.test(path))return'AGB';
  // Fallback: Browser-Titel, Markenname abschneiden
  var t=(document.title||'')
    .split(/\s[–\-|]\s/)[0]
    .replace(/\s*[\|–\-]\s*PureSim.*$/i,'')
    .trim();
  return t.length>60?t.substring(0,60)+'…':(t||'Seite');
}

// ── CSS ───────────────────────────────────────────────────────────────────────
var CSS = [
// ── CSS Custom Properties (Light Mode Default) ─────────────────────────────
'#vs25{',
'  --hdr-from:#1d4ed8;--hdr-to:#2563eb;',       // blue gradient header
'  --pnl-bg:#f8fafc;',
'  --msg-bg:#f0f4ff;',                            // subtle blue-tinted chat bg
'  --bub-b:#ffffff;',
'  --bub-b-txt:#0f172a;',
'  --bub-b-shadow:0 1px 2px rgba(37,99,235,.08);',
'  --bub-u:#2563eb;',                              // user bubble = brand blue
'  --bub-u-txt:#ffffff;',
'  --ts-c:#94a3b8;',
'  --date-bg:rgba(37,99,235,.08);',
'  --date-c:#2563eb;',
'  --bar-bg:#ffffff;',
'  --inp-bg:#f1f5f9;',
'  --inp-c:#0f172a;',
'  --inp-focus:#e0e7ff;',
'  --chip-bg:#eff6ff;',
'  --chip-c:#2563eb;',
'  --chip-hbg:#2563eb;',
'  --chip-hc:#ffffff;',
'  --chip-border:rgba(37,99,235,.2);',
'  --ft-c:#94a3b8;',
'  --av-bd:rgba(255,255,255,.3);',
'  --divider:rgba(0,0,0,.06);',
'}',
// ── Dark Mode ─────────────────────────────────────────────────────────────
'#vs25.vs25-dark{',
'  --hdr-from:#0f172a;--hdr-to:#1e293b;',
'  --pnl-bg:#0f172a;',
'  --msg-bg:#0f172a;',
'  --bub-b:#1e293b;',
'  --bub-b-txt:#e2e8f0;',
'  --bub-b-shadow:0 1px 3px rgba(0,0,0,.4);',
'  --bub-u:#1d4ed8;',
'  --bub-u-txt:#f1f5f9;',
'  --ts-c:rgba(148,163,184,.8);',
'  --date-bg:rgba(30,41,59,.8);',
'  --date-c:#60a5fa;',
'  --bar-bg:#1e293b;',
'  --inp-bg:#0f172a;',
'  --inp-c:#f1f5f9;',
'  --inp-focus:#1e293b;',
'  --chip-bg:#1e293b;',
'  --chip-c:#60a5fa;',
'  --chip-hbg:#2563eb;',
'  --chip-hc:#ffffff;',
'  --chip-border:rgba(96,165,250,.25);',
'  --ft-c:#64748b;',
'  --av-bd:rgba(15,23,42,.5);',
'  --divider:rgba(255,255,255,.06);',
'}',
// ── Base reset ────────────────────────────────────────────────────────────
'#vs25 *{box-sizing:border-box;margin:0;padding:0;font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-tap-highlight-color:transparent}',
// ── Launch FAB (Floating Action Button) ──────────────────────────────────
'#vs25-bbl{position:fixed;bottom:28px;right:24px;z-index:99998;width:62px;height:62px;border-radius:50%;background:linear-gradient(135deg,#1d4ed8,#2563eb,#3b82f6);box-shadow:0 6px 24px rgba(37,99,235,.45),0 2px 8px rgba(37,99,235,.25);cursor:pointer;border:none;outline:none;display:flex;align-items:center;justify-content:center;transition:transform .25s cubic-bezier(.34,1.56,.64,1),box-shadow .2s}',
'#vs25-bbl:hover{transform:scale(1.08) translateY(-2px);box-shadow:0 10px 32px rgba(37,99,235,.55),0 4px 12px rgba(37,99,235,.3)}',
'#vs25-bbl:active{transform:scale(.96)}',
'#vs25-bbl svg{width:30px;height:30px;fill:white;filter:drop-shadow(0 1px 2px rgba(0,0,0,.2))}',
// Status dot on launch FAB
'#vs25-status-dot{position:absolute;bottom:2px;right:2px;width:14px;height:14px;border-radius:50%;border:2.5px solid white;background:#22c55e;box-shadow:0 0 0 1px rgba(0,0,0,.1)}',
'#vs25-status-dot.online{background:#22c55e;animation:vspulse 2.5s ease infinite}',
'#vs25-status-dot.manual{background:#f59e0b;animation:vspulse 2s ease infinite}',
'#vs25-status-dot.offline{background:#ef4444;animation:none}',
'@keyframes vspulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.7;transform:scale(1.1)}}',
// ── Proactive invite bubble ───────────────────────────────────────────────
'#vs25-inv{position:fixed;bottom:104px;right:24px;z-index:99997;background:white;color:#0f172a;border-radius:16px 16px 4px 16px;padding:12px 34px 12px 16px;max-width:220px;box-shadow:0 8px 32px rgba(37,99,235,.18),0 2px 8px rgba(0,0,0,.08);font-size:.875rem;line-height:1.5;font-weight:500;cursor:pointer;display:none;animation:vspop .35s cubic-bezier(.34,1.56,.64,1)}',
'#vs25-inv.on{display:block}',
'#vs25-inv::after{content:"";position:absolute;bottom:-8px;right:18px;border-left:8px solid transparent;border-top:8px solid white}',
'.vs25-ix{position:absolute;top:6px;right:8px;font-size:.65rem;color:#94a3b8;cursor:pointer;background:none;border:none;line-height:1;padding:4px;border-radius:50%;transition:color .15s}',
'.vs25-ix:hover{color:#2563eb}',
'@keyframes vspop{from{opacity:0;transform:scale(.82) translateY(12px)}to{opacity:1;transform:scale(1) translateY(0)}}',
// ── Panel container ───────────────────────────────────────────────────────
'#vs25-pnl{position:fixed;z-index:99999;display:none;flex-direction:column;top:0;left:0;width:100%;height:100%;height:100svh;max-height:100svh;border-radius:0;overflow:hidden;background:var(--pnl-bg);box-shadow:0 20px 60px rgba(0,0,0,.25);transform:translateY(105%);transition:transform .38s cubic-bezier(.32,.72,0,1)}',
'@supports(height:100dvh) and (not (height:100svh)){#vs25-pnl{height:100dvh;max-height:100dvh}}',
'#vs25-pnl.on{display:flex;transform:translateY(0)}',
'@media(min-width:540px){',
'  #vs25-pnl{top:auto;bottom:104px;right:24px;left:auto;width:388px;height:min(640px,calc(100svh - 120px));border-radius:20px;border:1px solid rgba(37,99,235,.12);transform:translateY(120%) scale(.96);transition:transform .32s cubic-bezier(.32,.72,0,1),opacity .25s}',
'  #vs25-pnl.on{transform:translateY(0) scale(1);opacity:1}',
'}',
// ── Mobile drag handle ─────────────────────────────────────────────────────
'.vs25-drag{display:none;justify-content:center;align-items:center;padding:10px 0 6px;background:linear-gradient(135deg,var(--hdr-from),var(--hdr-to));flex-shrink:0;cursor:grab}',
'.vs25-drag span{width:40px;height:4px;border-radius:4px;background:rgba(255,255,255,.4)}',
'@media(max-width:539px){.vs25-drag{display:flex}}',
// ── Header ────────────────────────────────────────────────────────────────
'.vs25-hdr{background:linear-gradient(135deg,var(--hdr-from),var(--hdr-to));padding:calc(14px + env(safe-area-inset-top,0px)) 14px 14px;display:flex;align-items:center;gap:10px;flex-shrink:0;position:relative}',
'.vs25-hdr::after{content:"";position:absolute;bottom:0;left:0;right:0;height:1px;background:rgba(0,0,0,.12)}',
// Back/close button – large touch target
'.vs25-back{background:rgba(255,255,255,.12);border:none;color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;width:42px;height:42px;flex-shrink:0;border-radius:50%;transition:background .15s,transform .1s;backdrop-filter:blur(4px)}',
'.vs25-back:hover{background:rgba(255,255,255,.22)}',
'.vs25-back:active{transform:scale(.88)}',
'.vs25-back svg{width:22px;height:22px;fill:white}',
// Avatar with ring
'.vs25-hdr-av{width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;position:relative;border:2px solid rgba(255,255,255,.3);backdrop-filter:blur(4px)}',
'.vs25-hdr-av .vs25-av-dot{position:absolute;bottom:1px;right:1px;width:11px;height:11px;border-radius:50%;border:2px solid white;background:#22c55e;box-shadow:0 0 0 1px rgba(0,0,0,.1)}',
'.vs25-hdr-av .vs25-av-dot.manual{background:#f59e0b}',
'.vs25-hdr-av .vs25-av-dot.offline{background:#ef4444}',
// Header info text
'.vs25-hdr-info{flex:1;min-width:0}',
'.vs25-hdr-name{color:white;font-weight:700;font-size:1rem;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}',
'.vs25-hdr-sub{color:rgba(255,255,255,.8);font-size:.73rem;margin-top:3px;display:flex;align-items:center;gap:5px}',
'.vs25-hdr-sub-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.6);display:inline-block}',
'.vs25-hdr-sub-dot.online{background:#4ade80}',
'.vs25-hdr-sub-dot.manual{background:#fbbf24}',
'.vs25-hdr-sub-dot.offline{background:#f87171}',
// Theme toggle – large touch target
'.vs25-theme-btn{background:rgba(255,255,255,.12);border:none;color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;width:40px;height:40px;flex-shrink:0;border-radius:50%;transition:background .15s,transform .1s}',
'.vs25-theme-btn:hover{background:rgba(255,255,255,.22)}',
'.vs25-theme-btn:active{transform:scale(.88)}',
'.vs25-theme-btn svg{width:20px;height:20px;fill:white;display:block}',
'#vs25 .vs25-sun{display:none}',
'#vs25 .vs25-moon{display:block}',
'#vs25.vs25-dark .vs25-sun{display:block}',
'#vs25.vs25-dark .vs25-moon{display:none}',
// KI Toggle – bigger for touch
'.vs25-toggle-wrap{display:flex;align-items:center;gap:5px;flex-shrink:0;padding:6px 10px;background:rgba(255,255,255,.12);border-radius:20px;backdrop-filter:blur(4px)}',
'.vs25-toggle-label{color:rgba(255,255,255,.95);font-size:.7rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}',
'.vs25-toggle{position:relative;width:38px;height:21px;cursor:pointer;flex-shrink:0}',
'.vs25-toggle input{opacity:0;width:0;height:0;position:absolute}',
'.vs25-slider{position:absolute;inset:0;background:rgba(255,255,255,.25);border-radius:21px;transition:.2s;cursor:pointer}',
'.vs25-slider::before{content:"";position:absolute;height:15px;width:15px;left:3px;bottom:3px;background:white;border-radius:50%;transition:.22s cubic-bezier(.34,1.56,.64,1);box-shadow:0 1px 3px rgba(0,0,0,.2)}',
'.vs25-toggle input:checked + .vs25-slider{background:#60a5fa}',
'.vs25-toggle input:checked + .vs25-slider::before{transform:translateX(17px)}',
// ── Messages area ─────────────────────────────────────────────────────────
'.vs25-msgs{flex:1;overflow-y:auto;padding:16px 14px 10px;display:flex;flex-direction:column;gap:4px;background:var(--msg-bg);scroll-behavior:smooth}',
'.vs25-msgs::-webkit-scrollbar{width:3px}',
'.vs25-msgs::-webkit-scrollbar-thumb{background:rgba(37,99,235,.15);border-radius:3px}',
// Message row wrapper
'.vs25-msg{display:flex;flex-direction:column;max-width:82%;margin-bottom:4px}',
'.vs25-msg.u{align-self:flex-end}',
'.vs25-msg.b{align-self:flex-start}',
// Bubbles – clean flat modern style
'.vs25-bub{padding:11px 15px 9px;font-size:.935rem;line-height:1.55;word-break:break-word;white-space:pre-wrap;position:relative;min-height:38px;display:block;overflow:hidden}',
'.vs25-txt{display:inline}',
'.vs25-msg.b .vs25-bub{background:var(--bub-b);color:var(--bub-b-txt);border-radius:4px 18px 18px 18px;box-shadow:var(--bub-b-shadow)}',
'.vs25-msg.b .vs25-bub::before{content:"";position:absolute;top:0;left:-6px;width:7px;height:12px;background:var(--bub-b);clip-path:polygon(100% 0,0 0,100% 100%)}',
'.vs25-msg.u .vs25-bub{background:var(--bub-u);color:var(--bub-u-txt);border-radius:18px 4px 18px 18px;box-shadow:0 2px 8px rgba(37,99,235,.25)}',
'.vs25-msg.u .vs25-bub::before{content:"";position:absolute;top:0;right:-6px;width:7px;height:12px;background:var(--bub-u);clip-path:polygon(0 0,100% 0,0 100%)}',
// Timestamp
'.vs25-ts{display:inline-flex;align-items:center;gap:3px;float:right;margin-top:6px;margin-left:12px;font-size:.64rem;color:var(--ts-c);line-height:1;position:relative;top:4px;opacity:.85}',
'.vs25-msg.u .vs25-ts{color:rgba(255,255,255,.65)}',
'.vs25-ticks{font-size:.7rem;font-weight:700;margin-left:1px;opacity:.9}',
// Date separator pill
'.vs25-date-sep{text-align:center;margin:14px 0 8px;font-size:.68rem}',
'.vs25-date-sep span{background:var(--date-bg);color:var(--date-c);padding:4px 14px;border-radius:12px;font-weight:600;letter-spacing:.02em;display:inline-block}',
// Typing indicator
'.vs25-typ .vs25-bub{display:flex;align-items:center;gap:5px;padding:14px 18px;min-width:60px}',
'.vs25-typ span{width:7px;height:7px;border-radius:50%;background:#94a3b8;animation:vsb 1.4s ease-in-out infinite}',
'.vs25-typ span:nth-child(2){animation-delay:.2s}.vs25-typ span:nth-child(3){animation-delay:.4s}',
'@keyframes vsb{0%,60%,100%{transform:translateY(0);opacity:.6}30%{transform:translateY(-5px);opacity:1}}',
// ── FAQ chips bar ─────────────────────────────────────────────────────────
'.vs25-fq{padding:10px 12px 8px;background:var(--bar-bg);flex-shrink:0;border-top:1px solid var(--divider)}',
'.vs25-fq-label{font-size:.65rem;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px}',
'.vs25-fqg{display:flex;flex-wrap:wrap;gap:7px;padding-bottom:2px}',
'.vs25-chip{',
'  display:inline-flex;align-items:center;',
'  background:var(--chip-bg);',
'  color:var(--chip-c);',
'  border:1.5px solid var(--chip-border);',
'  font-size:.8rem;font-weight:600;',
'  padding:9px 16px;',
'  border-radius:24px;',               // pill shape
'  cursor:pointer;line-height:1.2;',
'  transition:all .18s cubic-bezier(.34,1.56,.64,1);',
'  text-align:left;white-space:nowrap;flex-shrink:0;',
'  touch-action:manipulation;',
'}',
'.vs25-chip:hover{background:var(--chip-hbg);color:var(--chip-hc);border-color:var(--chip-hbg);transform:translateY(-2px);box-shadow:0 4px 12px rgba(37,99,235,.25)}',
'.vs25-chip:active{transform:scale(.95)}',
// ── Input area ────────────────────────────────────────────────────────────
'.vs25-ir{padding:10px 12px;background:var(--bar-bg);display:flex;gap:8px;align-items:flex-end;flex-shrink:0;border-top:1px solid var(--divider);transition:background .3s}',
'.vs25-inp{flex:1;background:var(--inp-bg);color:var(--inp-c);border:1.5px solid transparent;border-radius:24px;padding:12px 18px;font-size:.95rem;font-family:inherit;resize:none;max-height:100px;overflow-y:auto;line-height:1.45;outline:none;transition:background .2s,border-color .2s,box-shadow .2s;box-shadow:0 1px 3px rgba(0,0,0,.06)}',
'.vs25-inp:focus{border-color:rgba(37,99,235,.3);box-shadow:0 0 0 3px rgba(37,99,235,.1),0 1px 3px rgba(0,0,0,.06);background:var(--inp-focus)}',
'.vs25-inp::placeholder{color:#94a3b8;font-weight:400}',
// Send button – larger touch target
'.vs25-snd{width:48px;height:48px;border-radius:50%;flex-shrink:0;background:linear-gradient(135deg,#1d4ed8,#2563eb);border:none;color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s cubic-bezier(.34,1.56,.64,1);box-shadow:0 3px 12px rgba(37,99,235,.4);touch-action:manipulation}',
'.vs25-snd:hover{background:linear-gradient(135deg,#1e40af,#1d4ed8);transform:scale(1.06);box-shadow:0 5px 16px rgba(37,99,235,.5)}',
'.vs25-snd:active{transform:scale(.92)}',
'.vs25-snd svg{width:20px;height:20px;fill:white}',
'.vs25-snd:disabled{background:linear-gradient(135deg,#cbd5e1,#e2e8f0);cursor:not-allowed;box-shadow:none;transform:none;opacity:.7}',
// ── Footer branding ───────────────────────────────────────────────────────
'.vs25-ft{text-align:center;padding:5px 8px;color:var(--ft-c);font-size:.6rem;background:var(--bar-bg);flex-shrink:0;transition:background .3s;letter-spacing:.02em}',
// ── Mobile safe area ──────────────────────────────────────────────────────
'@media(max-width:539px){',
'  .vs25-ft{padding-bottom:calc(5px + env(safe-area-inset-bottom,0px))}',
'  .vs25-ir{padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}',
'  .vs25-ir.vs25-is-last{padding-bottom:calc(12px + env(safe-area-inset-bottom,0px))}',
'  .vs25-inp{font-size:1rem}',              // prevent iOS zoom on focus
'  .vs25-chip{padding:10px 18px;font-size:.83rem}',
'}'
].join('');

var INVITES=['💬 Fragen zur eSIM? Ich helfe sofort!','🤔 Noch unsicher? Kostenlose Beratung!','👋 Passende eSIM finden – frag mich!','🔍 Ich finde den richtigen Tarif für dich!'];

function build(){
  if(document.getElementById('vs25')) return;
  var w=document.createElement('div'); w.id='vs25';
  var st=document.createElement('style'); st.textContent=CSS; document.head.appendChild(st);
  var inv=INVITES[Math.floor(Math.random()*INVITES.length)];

  // Load saved theme preference
  try { if(localStorage.getItem('vs25_theme')==='dark') w.classList.add('vs25-dark'); } catch(_) {}

  w.innerHTML=
    // ── Launch FAB
    '<button id="vs25-bbl" aria-label="Chat öffnen">'+
      '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>'+
      '<span id="vs25-status-dot" class="online"></span>'+
    '</button>'+
    // ── Proactive invite
    '<div id="vs25-inv"><button class="vs25-ix" id="vs25-ix" aria-label="Schließen">✕</button>'+esc(inv)+'</div>'+
    // ── Chat panel
    '<div id="vs25-pnl" role="dialog" aria-label="PureSim Support Chat">'+
      // Drag handle (mobile only)
      '<div class="vs25-drag"><span></span></div>'+
      // Header
      '<div class="vs25-hdr">'+
        '<button class="vs25-back" id="vs25-back" title="Schließen" aria-label="Schließen">'+
          '<svg viewBox="0 0 24 24"><path d="M19 11H7.83l4.88-4.88c.39-.39.39-1.03 0-1.42-.39-.39-1.02-.39-1.41 0l-6.59 6.59c-.39.39-.39 1.02 0 1.41l6.59 6.59c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L7.83 13H19c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>'+
        '</button>'+
        // Avatar with status ring
        '<div class="vs25-hdr-av">'+
          '<span style="line-height:1">🤖</span>'+
          '<span class="vs25-av-dot online" id="vs25-av-dot"></span>'+
        '</div>'+
        // Name + subtitle
        '<div class="vs25-hdr-info">'+
          '<div class="vs25-hdr-name">PureSim Support</div>'+
          '<div class="vs25-hdr-sub" id="vs25-hdr-sub">'+
            '<span class="vs25-hdr-sub-dot online" id="vs25-hdr-sub-dot"></span>'+
            '<span id="vs25-hdr-sub-text">KI Assistent · Online</span>'+
          '</div>'+
        '</div>'+
        // Theme toggle
        '<button class="vs25-theme-btn" id="vs25-theme-btn" title="Hell/Dunkel" aria-label="Hell/Dunkel wechseln">'+
          '<svg class="vs25-moon" viewBox="0 0 24 24"><path d="M12.3 22h-.1c-5.5 0-10-4.5-10-10 0-4.8 3.5-8.9 8.2-9.8.5-.1 1 .2 1.2.7.2.5 0 1.1-.4 1.4-2.8 2.2-4.2 5.7-3.4 9.3.8 3.5 3.7 6.1 7.3 6.5.5.1.9.4 1 .9.1.5-.1 1-.6 1.2-1.2.5-2.4.8-3.7.8z"/></svg>'+
          '<svg class="vs25-sun" viewBox="0 0 24 24"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41s-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.01c.39-.39.39-1.03 0-1.41s-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/></svg>'+
        '</button>'+
        // KI toggle pill
        '<div class="vs25-toggle-wrap">'+
          '<span class="vs25-toggle-label">KI</span>'+
          '<label class="vs25-toggle"><input type="checkbox" id="vs25-ki-toggle" checked><span class="vs25-slider"></span></label>'+
        '</div>'+
      '</div>'+
      // Messages
      '<div class="vs25-msgs" id="vs25-msgs" role="log" aria-live="polite"></div>'+
      // FAQ chips
      '<div class="vs25-fq" id="vs25-fq">'+
        '<div class="vs25-fq-label">Schnellfragen</div>'+
        '<div class="vs25-fqg" id="vs25-fqg"></div>'+
      '</div>'+
      // Input row
      '<div class="vs25-ir">'+
        '<textarea class="vs25-inp" id="vs25-inp" placeholder="Schreib eine Nachricht…" rows="1" autocomplete="off" autocorrect="on" autocapitalize="sentences"></textarea>'+
        '<button class="vs25-snd" id="vs25-snd" aria-label="Nachricht senden">'+
          '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>'+
        '</button>'+
      '</div>'+
      // Footer
      '<div class="vs25-ft"><span id="vs25-ft-text">Powered by PureSim AI</span></div>'+
    '</div>';

  document.body.appendChild(w);

  document.getElementById('vs25-bbl').onclick=openChat;
  document.getElementById('vs25-back').onclick=closeChat;
  document.getElementById('vs25-snd').onclick=sendMsg;
  document.getElementById('vs25-ki-toggle').onchange=toggleKI;
  document.getElementById('vs25-inv').onclick=function(e){if(e.target.id==='vs25-ix'){hideInv();return;}hideInv();openChat();};
  document.getElementById('vs25-ix').onclick=function(e){e.stopPropagation();hideInv();};
  document.getElementById('vs25-inp').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}});
  document.getElementById('vs25-inp').addEventListener('input',function(){
    this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px';
    hideFaq();
  });

  // Theme toggle
  document.getElementById('vs25-theme-btn').onclick=function(){
    var isDark=w.classList.toggle('vs25-dark');
    try { localStorage.setItem('vs25_theme', isDark ? 'dark' : 'light'); } catch(_) {}
  };

  passiveTrack();startSession();loadFaq();
  _proTimer=setTimeout(showInv,28000);

  // ─── Seiten-Verlassen erkennen ────────────────────────────────────────────
  // Wenn der User die Seite verlässt (Tab schließt, navigiert weg, App
  // minimiert) → Session als inaktiv markieren.
  function _sendLeave(){
    var id=chatId||_ssGet(); if(!id) return;
    // navigator.sendBeacon ist verlässlicher als fetch beim Schließen
    var url=API+'/api/widget/leave';
    var data=JSON.stringify({chatId:id});
    try{
      if(navigator.sendBeacon){
        var blob=new Blob([data],{type:'application/json'});
        navigator.sendBeacon(url,blob);
      } else {
        _postTrack('/api/widget/leave',{chatId:id},1);
      }
    }catch(_){}
  }
  // pagehide: zuverlässigster Event (mobile Safari, bfcache)
  window.addEventListener('pagehide',_sendLeave);
  // visibilitychange hidden: Tab-Wechsel, Minimieren
  document.addEventListener('visibilitychange',function(){
    if(document.visibilityState==='hidden') _sendLeave();
  });
}

function passiveTrack(){
  // Nur tracken wenn sich die URL geändert hat (verhindert doppeltes
  // Inkrement beim Verweilen auf derselben Seite).
  var currentUrl=location.href;
  if(passiveTrack._lastSent===currentUrl) return;
  passiveTrack._lastSent=currentUrl;

  var saved=_ssGet()||chatId;
  _postTrack('/api/widget/beacon',{fingerprint:fp(),pageUrl:currentUrl,pageTitle:smartTitle(),chatId:saved})
  .then(function(d){
    if(d&&d.chatId&&!_ssGet()) _ssSet(d.chatId);
  });
}
passiveTrack._lastSent=null;

function startSession(){
  _safeFetch(API+'/api/widget/config').then(function(r){return r.json();}).then(function(d){
    var ft=document.getElementById('vs25-ft-text');
    if(ft){
      if(d.poweredBy===null||d.poweredBy===''||d.poweredBy===false){
        ft.parentElement.style.display='none';
        var ir = document.querySelector('.vs25-ir');
        if(ir) ir.classList.add('vs25-is-last');
      }else if(d.poweredBy){
        ft.textContent=d.poweredBy;  // Server-Wert gewinnt (z.B. "Powered by PureSim AI")
      }
      // Falls poweredBy undefined/nicht im Response: Fallback bleibt "Powered by PureSim AI"
    }
    if(d.botName){
      var nameEl = document.querySelector('.vs25-hdr-name');
      if (nameEl) nameEl.textContent = d.botName;
    }
  }).catch(function(){});

  var saved=_ssGet();

  if(saved){
    chatId=saved;
    loadHist();
    startStatusPoll();
    // Kein zusätzlicher passiveTrack hier — wird bereits in build() aufgerufen
    return;
  }

  _postTrack('/api/widget/init', {fingerprint:fp(),pageUrl:location.href,pageTitle:smartTitle(),chatId:null})
  .then(function(d){
    if(!d || d.banned) return;
    if(!d.chatId) return;
    chatId=d.chatId; _ssSet(chatId);
    // passiveTrack._lastSent synchronisieren damit /init + /beacon nicht doppeln
    passiveTrack._lastSent=location.href;
    if(d.welcome) addMsg('b',d.welcome);
    loadHist(); startStatusPoll();
  });
}

function loadHist(){
  if(!chatId) return;
  _safeFetch(API+'/api/widget/history',{headers:{'X-Chat-ID':chatId}})
  .then(function(r){return r.json();}).then(function(d){
    var msgs=d.messages||[],el=document.getElementById('vs25-msgs');
    if(msgs.length&&el&&!el.children.length){msgs.slice(-20).forEach(function(m){addMsg(m.role==='user'?'u':'b',m.content,true);});scrl();}
    if(msgs.length){ var last=msgs[msgs.length-1]; _lastMsgTs = last.created_at ? new Date(last.created_at).getTime() : Date.now(); }
  }).catch(function(){});
}

function pollNewMessages(){
  if(!chatId) return;
  _safeFetch(API+'/api/widget/history',{headers:{'X-Chat-ID':chatId}})
  .then(function(r){return r.json();}).then(function(d){
    var msgs=d.messages||[];
    msgs.forEach(function(m){
      var ts = m.created_at ? new Date(m.created_at).getTime() : 0;
      if(ts > _lastMsgTs && m.role!=='user'){
        addMsg('b', m.content);
        _lastMsgTs = ts;
      }
    });
  }).catch(function(){});
}

function loadFaq(){
  _safeFetch(API+'/api/widget/faq').then(function(r){return r.json();}).then(function(d){
    var bar=document.getElementById('vs25-fqg'); if(!bar) return; bar.innerHTML='';
    (d.faqs||[]).forEach(function(q){
      var btn=document.createElement('button'); btn.className='vs25-chip'; btn.textContent=q;
      btn.onclick=function(){openChat();document.getElementById('vs25-inp').value=q;hideFaq();sendMsg();};
      bar.appendChild(btn);
    });
  }).catch(function(){});
}

function hideFaq(){if(_faqUsed) return;_faqUsed=true;var el=document.getElementById('vs25-fq');if(el)el.style.display='none';}

function sendMsg(){
  if(isTyping||!chatId) return;
  var inp=document.getElementById('vs25-inp'),text=(inp.value||'').trim();
  if(!text) return;
  inp.value='';inp.style.height='auto';
  hideFaq();addMsg('u',text);showTyp(true);
  document.getElementById('vs25-snd').disabled=true;
  _safeFetch(API+'/api/widget/message',{method:'POST',headers:{'Content-Type':'application/json','X-Chat-ID':chatId},body:JSON.stringify({message:text,chatId})})
  .then(function(r){return r.json();}).then(function(d){
    showTyp(false);document.getElementById('vs25-snd').disabled=false;
    if(d.reply) addMsg('b',d.reply);
    _lastMsgTs = Date.now();
  }).catch(function(){showTyp(false);document.getElementById('vs25-snd').disabled=false;addMsg('b','Bitte erneut versuchen.');});
}

function toggleKI(){
  var tog=document.getElementById('vs25-ki-toggle');
  var isKIon=tog.checked;
  _handover=!isKIon;
  if(!chatId) return;
  _safeFetch(API+'/api/widget/handover',{method:'POST',headers:{'Content-Type':'application/json','X-Chat-ID':chatId},
    body:JSON.stringify({chatId,request:_handover})}).catch(function(){});
  if(_handover){
    addMsg('b','👤 Ein Mitarbeiter wurde benachrichtigt und meldet sich bald. Die KI ist pausiert.');
    setStatusUI('manual');
  } else {
    addMsg('b','✅ KI-Support ist wieder aktiv.');
    setStatusUI('online');
  }
}

function setStatusUI(status){
  var dot=document.getElementById('vs25-status-dot');
  var avDot=document.getElementById('vs25-av-dot');
  var subDot=document.getElementById('vs25-hdr-sub-dot');
  var subTxt=document.getElementById('vs25-hdr-sub-text');
  var tog=document.getElementById('vs25-ki-toggle');
  if(dot){dot.className=status;}
  if(avDot){avDot.className='vs25-av-dot '+(status==='online'?'online':status);}
  if(subDot){subDot.className='vs25-hdr-sub-dot '+(status==='online'?'online':status);}
  if(subTxt){
    subTxt.textContent=status==='online'?'KI Assistent · Online':status==='manual'?'Mitarbeiter angefordert':'KI Offline';
  }
  if(tog&&status!=='offline'){tog.checked=status==='online';}
}

function startStatusPoll(){
  if(_statusInt) clearInterval(_statusInt);
  _statusInt=setInterval(function(){
    if(!chatId) return;
    pollNewMessages();
    _safeFetch(API+'/api/widget/status',{headers:{'X-Chat-ID':chatId}})
    .then(function(r){return r.json();}).then(function(d){setStatusUI(d.status||'online');}).catch(function(){});
  }, 15000);
}

function openChat(){
  if(isOpen) return;isOpen=true;hideInv();_proDone=true;clearTimeout(_proTimer);
  document.getElementById('vs25-pnl').classList.add('on');
  setTimeout(function(){var i=document.getElementById('vs25-inp');if(i)i.focus();scrl();},80);
  trackPage();
}
function closeChat(){isOpen=false;document.getElementById('vs25-pnl').classList.remove('on');}
function showInv(){if(_proDone||isOpen) return;document.getElementById('vs25-inv').classList.add('on');_proDone=true;}
function hideInv(){document.getElementById('vs25-inv').classList.remove('on');}

function trackPage(){
  if(!chatId){setTimeout(trackPage,2000);return;}
  _postTrack('/api/widget/activity', {pageUrl:location.href,pageTitle:smartTitle(),chatId});
}

function addMsg(role,text,noScroll){
  var el=document.getElementById('vs25-msgs'); if(!el) return;
  var d=document.createElement('div'); d.className='vs25-msg '+role;
  var t=new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
  var ticks = role === 'u' ? '<span class="vs25-ticks">✓✓</span>' : '';
  d.innerHTML='<div class="vs25-bub"><span class="vs25-txt">'+esc(text)+'</span><span class="vs25-ts">'+t+ticks+'</span></div>';
  el.appendChild(d); if(!noScroll) scrl();
}

function showTyp(show){
  isTyping=show;var ex=document.getElementById('vs25-typ');
  if(!show){if(ex)ex.remove();return;}if(ex) return;
  var d=document.createElement('div');d.id='vs25-typ';d.className='vs25-msg b vs25-typ';
  d.innerHTML='<div class="vs25-bub"><span></span><span></span><span></span></div>';
  document.getElementById('vs25-msgs').appendChild(d);scrl();
}

function scrl(){var e=document.getElementById('vs25-msgs');if(e)e.scrollTop=e.scrollHeight;}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');}
function fp(){return btoa([navigator.userAgent,navigator.language,screen.width+'x'+screen.height,Intl.DateTimeFormat().resolvedOptions().timeZone].join('|')).substring(0,32);}

var _lastUrl=location.href;
setInterval(function(){
  if(location.href!==_lastUrl){
    _lastUrl=location.href;
    passiveTrack();
    if(chatId) trackPage();
    if(!isOpen){_proDone=false;clearTimeout(_proTimer);_proTimer=setTimeout(showInv,28000);}
  }
},1500);

function _safeBuild(){
  try {
    build();
    if (window.console && console.log) {
      console.log('%c[VS25-Widget] v1.7.0 widget visible', 'color: #4caf50; font-weight: bold');
    }
  } catch (e) {
    if (window.console && console.error) {
      console.error('[VS25-Widget] build() Fehler:', e);
    }
    setTimeout(function(){
      try { build(); } catch(_) {}
    }, 200);
  }
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',_safeBuild); else _safeBuild();
})();
