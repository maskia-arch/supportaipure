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

// ── Persistente Besucher-ID (vs25_vid) ───────────────────────────────────────
// Primärer stabiler Identifier. Gespeichert in localStorage → überlebt
// In-App-Browser-Neustarts (Instagram, TikTok, WhatsApp etc.).
// Funktioniert auch wenn sessionStorage zurückgesetzt wird.
var STORAGE_KEY    = 'vs25_cid';  // Chat-ID (Session)
var VID_KEY        = 'vs25_vid';  // Visitor-ID (persistent, UUID)

function _ssGet(){
  try { return sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY); } catch(_) { return null; }
}
function _ssSet(v){
  if (!v) return;
  try { sessionStorage.setItem(STORAGE_KEY, v); } catch(_) {}
  try { localStorage.setItem(STORAGE_KEY, v); } catch(_) {}
}
function _ssClear(){
  try { sessionStorage.removeItem(STORAGE_KEY); } catch(_) {}
  try { localStorage.removeItem(STORAGE_KEY); } catch(_) {}
}

// UUID v4 generator (kryptographisch ausreichend für Besucher-IDs)
function _uuid4(){
  try {
    if(crypto && crypto.randomUUID) return crypto.randomUUID();
    var b=new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6]=(b[6]&0x0f)|0x40; b[8]=(b[8]&0x3f)|0x80;
    var h=Array.from(b).map(function(x){return x.toString(16).padStart(2,'0');}).join('');
    return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
  } catch(_){
    // Fallback ohne crypto
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){
      var r=Math.random()*16|0;return(c==='x'?r:(r&0x3|0x8)).toString(16);
    });
  }
}

// Stabile Besucher-ID lesen oder neu erstellen
function _getOrCreateVid(){
  var vid=null;
  // 1. localStorage (persistenteste Speicherung)
  try{ vid=localStorage.getItem(VID_KEY); }catch(_){}
  // 2. sessionStorage als Backup
  if(!vid){ try{ vid=sessionStorage.getItem(VID_KEY); }catch(_){} }
  // 3. Neu erstellen falls nichts gefunden
  if(!vid || vid.length < 10){
    vid = _uuid4();
    try{ localStorage.setItem(VID_KEY, vid); }catch(_){}
    try{ sessionStorage.setItem(VID_KEY, vid); }catch(_){}
  } else {
    // Synchronisieren: sicherstellen dass beide Stores die ID haben
    try{ localStorage.setItem(VID_KEY, vid); }catch(_){}
    try{ sessionStorage.setItem(VID_KEY, vid); }catch(_){}
  }
  return vid;
}

var _visitorId = _getOrCreateVid();

// Legacy chatId Migration (localStorage → sessionStorage)
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
'@import url("https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap");',
'#vs25{',
'  --hdr-from:#0f172a;--hdr-via:#1e293b;--hdr-to:#1d4ed8;',
'  --pnl-bg:#f8fafc;',
'  --pnl-border:rgba(37,99,235,.15);',
'  --pnl-shadow:0 24px 64px -12px rgba(15,23,42,.25), 0 0 0 1px rgba(255,255,255,.1);',
'  --msg-bg:#f1f5f9;',
'  --bub-b:#ffffff;',
'  --bub-b-txt:#0f172a;',
'  --bub-b-shadow:0 4px 16px -2px rgba(15,23,42,.06), 0 1px 2px rgba(0,0,0,.04);',
'  --bub-u:linear-gradient(135deg,#1d4ed8,#2563eb);',
'  --bub-u-txt:#ffffff;',
'  --bub-u-shadow:0 4px 16px rgba(37,99,235,.3);',
'  --ts-c:#94a3b8;',
'  --date-bg:rgba(37,99,235,.08);',
'  --date-c:#1d4ed8;',
'  --bar-bg:#ffffff;',
'  --inp-bg:#f8fafc;',
'  --inp-c:#0f172a;',
'  --inp-border:rgba(226,232,240,.9);',
'  --inp-focus-border:rgba(37,99,235,.4);',
'  --inp-focus-glow:0 0 0 4px rgba(37,99,235,.12);',
'  --chip-bg:rgba(37,99,235,.06);',
'  --chip-c:#1d4ed8;',
'  --chip-hbg:#2563eb;',
'  --chip-hc:#ffffff;',
'  --chip-border:rgba(37,99,235,.18);',
'  --ft-c:#94a3b8;',
'  --av-bd:rgba(255,255,255,.25);',
'  --divider:rgba(0,0,0,.06);',
'}',
'#vs25.vs25-dark{',
'  --hdr-from:#090d16;--hdr-via:#0f172a;--hdr-to:#1e1b4b;',
'  --pnl-bg:#0b0f19;',
'  --pnl-border:rgba(255,255,255,.1);',
'  --pnl-shadow:0 24px 64px -12px rgba(0,0,0,.65), 0 0 0 1px rgba(255,255,255,.08);',
'  --msg-bg:#090d16;',
'  --bub-b:#1e293b;',
'  --bub-b-txt:#f8fafc;',
'  --bub-b-shadow:0 4px 16px -2px rgba(0,0,0,.4);',
'  --bub-u:linear-gradient(135deg,#2563eb,#4f46e5);',
'  --bub-u-txt:#ffffff;',
'  --bub-u-shadow:0 4px 16px rgba(37,99,235,.4);',
'  --ts-c:rgba(148,163,184,.7);',
'  --date-bg:rgba(30,41,59,.9);',
'  --date-c:#60a5fa;',
'  --bar-bg:#0f172a;',
'  --inp-bg:#1e293b;',
'  --inp-c:#f8fafc;',
'  --inp-border:rgba(255,255,255,.08);',
'  --inp-focus-border:rgba(96,165,250,.4);',
'  --inp-focus-glow:0 0 0 4px rgba(96,165,250,.15);',
'  --chip-bg:rgba(30,41,59,.8);',
'  --chip-c:#60a5fa;',
'  --chip-hbg:#2563eb;',
'  --chip-hc:#ffffff;',
'  --chip-border:rgba(96,165,250,.25);',
'  --ft-c:#64748b;',
'  --av-bd:rgba(255,255,255,.15);',
'  --divider:rgba(255,255,255,.06);',
'}',
'#vs25 *{box-sizing:border-box;margin:0;padding:0;font-family:"Plus Jakarta Sans","Inter",-apple-system,BlinkMacSystemFont,sans-serif;-webkit-tap-highlight-color:transparent}',
'#vs25-bbl{position:fixed;bottom:28px;right:24px;z-index:99998;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#1d4ed8 0%,#2563eb 50%,#4f46e5 100%);box-shadow:0 8px 28px rgba(37,99,235,.45),0 2px 8px rgba(37,99,235,.25);cursor:pointer;border:1px solid rgba(255,255,255,.25);outline:none;display:flex;align-items:center;justify-content:center;transition:transform .28s cubic-bezier(.34,1.56,.64,1),box-shadow .25s,background .25s;animation:vsbblpulse 4s infinite ease-in-out}',
'#vs25-bbl:hover{transform:scale(1.08) translateY(-2px);box-shadow:0 12px 36px rgba(37,99,235,.6),0 4px 12px rgba(37,99,235,.3)}',
'#vs25-bbl:active{transform:scale(.94)}',
'@keyframes vsbblpulse{0%,100%{box-shadow:0 8px 28px rgba(37,99,235,.45),0 0 0 0 rgba(37,99,235,.35)}50%{box-shadow:0 12px 36px rgba(37,99,235,.6),0 0 0 12px rgba(37,99,235,0)}}',
'#vs25-bbl svg{width:30px;height:30px;fill:white;filter:drop-shadow(0 2px 4px rgba(0,0,0,.2))}',
'#vs25-status-dot{position:absolute;bottom:2px;right:2px;width:15px;height:15px;border-radius:50%;border:2.5px solid white;background:#22c55e;box-shadow:0 0 0 1px rgba(0,0,0,.15)}',
'#vs25-status-dot.online{background:#22c55e;animation:vspulse 2.5s ease infinite}',
'#vs25-status-dot.manual{background:#f59e0b;animation:vspulse 2s ease infinite}',
'#vs25-status-dot.offline{background:#ef4444;animation:none}',
'@keyframes vspulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.7;transform:scale(1.1)}}',
'#vs25-bbl.vs25-open{background:linear-gradient(135deg,#1e3a8a,#0f172a);animation:none}',
'#vs25-bbl.vs25-open .vs25-bbl-chat{display:none}',
'#vs25-bbl.vs25-open .vs25-bbl-close{display:flex}',
'#vs25-bbl .vs25-bbl-chat{display:flex;align-items:center;justify-content:center}',
'#vs25-bbl .vs25-bbl-close{display:none;align-items:center;justify-content:center;font-size:1.5rem;line-height:1;color:white;font-weight:300}',
'#vs25-inv{position:fixed;bottom:106px;right:24px;z-index:99997;background:rgba(255,255,255,.95);color:#0f172a;border-radius:20px 20px 4px 20px;padding:14px 36px 14px 18px;max-width:240px;box-shadow:0 12px 36px rgba(15,23,42,.15),0 2px 8px rgba(0,0,0,.06);border:1px solid rgba(255,255,255,.8);backdrop-filter:blur(12px);font-size:.875rem;line-height:1.5;font-weight:600;cursor:pointer;display:none;animation:vspop .35s cubic-bezier(.34,1.56,.64,1)}',
'#vs25-inv.on{display:block}',
'#vs25-inv::after{content:"";position:absolute;bottom:-8px;right:20px;border-left:8px solid transparent;border-top:8px solid rgba(255,255,255,.95)}',
'.vs25-ix{position:absolute;top:8px;right:10px;font-size:.7rem;color:#94a3b8;cursor:pointer;background:none;border:none;line-height:1;padding:4px;border-radius:50%;transition:color .15s}',
'.vs25-ix:hover{color:#2563eb}',
'@keyframes vspop{from{opacity:0;transform:scale(.85) translateY(12px)}to{opacity:1;transform:scale(1) translateY(0)}}',
'#vs25-pnl{position:fixed;z-index:99999;display:none;flex-direction:column;top:0;left:0;width:100%;height:100%;height:100svh;max-height:100svh;border-radius:0;overflow:hidden;background:var(--pnl-bg);box-shadow:var(--pnl-shadow);transform:translateY(105%);transition:transform .38s cubic-bezier(.16,1,.3,1)}',
'@supports(height:100dvh) and (not (height:100svh)){#vs25-pnl{height:100dvh;max-height:100dvh}}',
'#vs25-pnl.on{display:flex;transform:translateY(0)}',
'@media(min-width:540px){',
'  #vs25-pnl{top:auto;bottom:104px;right:24px;left:auto;width:400px;height:min(660px,calc(100svh - 120px));border-radius:24px;border:var(--pnl-border);transform:translateY(120%) scale(.95);transition:transform .35s cubic-bezier(.16,1,.3,1),opacity .25s}',
'  #vs25-pnl.on{transform:translateY(0) scale(1);opacity:1}',
'}',
'.vs25-drag{display:none;justify-content:center;align-items:center;padding:10px 0 6px;background:linear-gradient(135deg,var(--hdr-from),var(--hdr-to));flex-shrink:0;cursor:grab}',
'.vs25-drag span{width:40px;height:4px;border-radius:4px;background:rgba(255,255,255,.4)}',
'@media(max-width:539px){.vs25-drag{display:flex}}',
'.vs25-hdr{background:linear-gradient(135deg,var(--hdr-from),var(--hdr-via),var(--hdr-to));padding:calc(16px + env(safe-area-inset-top,0px)) 16px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0;position:relative;box-shadow:0 4px 20px rgba(0,0,0,.15)}',
'.vs25-hdr::after{content:"";position:absolute;bottom:0;left:0;right:0;height:1px;background:rgba(255,255,255,.1)}',
'.vs25-back{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;width:40px;height:40px;flex-shrink:0;border-radius:50%;transition:all .18s;backdrop-filter:blur(8px)}',
'.vs25-back:hover{background:rgba(255,255,255,.24);transform:scale(1.05)}',
'.vs25-back:active{transform:scale(.9)}',
'.vs25-back svg{width:20px;height:20px;fill:white}',
'.vs25-hdr-av{width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;flex-shrink:0;position:relative;border:2px solid var(--av-bd);backdrop-filter:blur(8px);box-shadow:0 2px 8px rgba(0,0,0,.2)}',
'.vs25-bot-icon{width:24px;height:24px;fill:white;filter:drop-shadow(0 1px 2px rgba(0,0,0,.3))}',
'.vs25-hdr-av .vs25-av-dot{position:absolute;bottom:1px;right:1px;width:11px;height:11px;border-radius:50%;border:2px solid white;background:#22c55e;box-shadow:0 0 0 1px rgba(0,0,0,.15)}',
'.vs25-hdr-av .vs25-av-dot.manual{background:#f59e0b}',
'.vs25-hdr-av .vs25-av-dot.offline{background:#ef4444}',
'.vs25-hdr-info{flex:1;min-width:0}',
'.vs25-hdr-name{color:white;font-weight:800;font-size:1.05rem;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.015em;text-shadow:0 1px 2px rgba(0,0,0,.2)}',
'.vs25-hdr-sub{color:rgba(255,255,255,.85);font-size:.74rem;font-weight:500;margin-top:3px;display:flex;align-items:center;gap:6px}',
'.vs25-hdr-sub-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.6);display:inline-block;box-shadow:0 0 6px rgba(74,222,128,.6)}',
'.vs25-hdr-sub-dot.online{background:#4ade80}',
'.vs25-hdr-sub-dot.manual{background:#fbbf24}',
'.vs25-hdr-sub-dot.offline{background:#f87171}',
'.vs25-theme-btn{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;width:38px;height:38px;flex-shrink:0;border-radius:50%;transition:all .18s;backdrop-filter:blur(8px)}',
'.vs25-theme-btn:hover{background:rgba(255,255,255,.24);transform:scale(1.05)}',
'.vs25-theme-btn:active{transform:scale(.9)}',
'.vs25-theme-btn svg{width:18px;height:18px;fill:white;display:block}',
'#vs25 .vs25-sun{display:none}',
'#vs25 .vs25-moon{display:block}',
'#vs25.vs25-dark .vs25-sun{display:block}',
'#vs25.vs25-dark .vs25-moon{display:none}',
'.vs25-toggle-wrap{display:flex;align-items:center;gap:6px;flex-shrink:0;padding:5px 10px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);border-radius:20px;backdrop-filter:blur(8px)}',
'.vs25-toggle-label{color:rgba(255,255,255,.95);font-size:.7rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase}',
'.vs25-toggle{position:relative;width:36px;height:20px;cursor:pointer;flex-shrink:0}',
'.vs25-toggle input{opacity:0;width:0;height:0;position:absolute}',
'.vs25-slider{position:absolute;inset:0;background:rgba(255,255,255,.25);border-radius:20px;transition:.25s;cursor:pointer}',
'.vs25-slider::before{content:"";position:absolute;height:14px;width:14px;left:3px;bottom:3px;background:white;border-radius:50%;transition:.25s cubic-bezier(.34,1.56,.64,1);box-shadow:0 1px 3px rgba(0,0,0,.2)}',
'.vs25-toggle input:checked + .vs25-slider{background:#3b82f6}',
'.vs25-toggle input:checked + .vs25-slider::before{transform:translateX(16px)}',
'.vs25-msgs{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:10px;background:var(--msg-bg);scroll-behavior:smooth}',
'.vs25-msgs::-webkit-scrollbar{width:4px}',
'.vs25-msgs::-webkit-scrollbar-thumb{background:rgba(37,99,235,.2);border-radius:4px}',
'.vs25-msg{display:flex;margin-bottom:2px}',
'.vs25-msg.u{align-self:flex-end;max-width:82%;margin-left:36px}',
'.vs25-msg.b{align-self:flex-start;max-width:85%;margin-right:36px;display:flex;align-items:flex-start;gap:8px}',
'.vs25-bub{padding:10px 14px;font-size:.9rem;line-height:1.5;position:relative;display:flex;flex-direction:column;min-width:75px}',
'.vs25-bub-content{display:flex;flex-direction:column}',
'.vs25-txt{display:block;word-break:break-word;white-space:pre-wrap}',
'.vs25-msg.b .vs25-bub{background:var(--bub-b);color:var(--bub-b-txt);border-radius:4px 16px 16px 16px;box-shadow:0 1px 3px rgba(0,0,0,.05);border:1px solid rgba(0,0,0,.06)}',
'.vs25-msg.u .vs25-bub{background:var(--bub-u);color:var(--bub-u-txt);border-radius:16px 16px 4px 16px;box-shadow:0 3px 12px rgba(37,99,235,.28)}',
'.vs25-ts-bar{display:flex;align-items:center;justify-content:flex-end;gap:3px;margin-top:4px;font-size:.65rem;white-space:nowrap;user-select:none;opacity:.85}',
'.vs25-msg.u .vs25-ts-bar{color:rgba(255,255,255,.85)}',
'.vs25-msg.b .vs25-ts-bar{color:var(--ts-c)}',
'.vs25-ticks{font-size:.72rem;font-weight:700;margin-left:2px}',
'.vs25-date-sep{text-align:center;margin:14px 0 8px;font-size:.7rem}',
'.vs25-date-sep span{background:var(--date-bg);color:var(--date-c);padding:4px 14px;border-radius:12px;font-weight:700;letter-spacing:.02em;display:inline-block;box-shadow:0 1px 4px rgba(0,0,0,.03)}',
'.vs25-typ .vs25-bub{display:flex;align-items:center;gap:6px;padding:12px 18px;min-width:60px}',
'.vs25-typ-dots{display:flex;align-items:center;gap:5px}',
'.vs25-typ-dots span{width:6px;height:6px;border-radius:50%;background:#94a3b8;animation:vsb 1.4s ease-in-out infinite}',
'.vs25-typ-dots span:nth-child(2){animation-delay:.2s}.vs25-typ-dots span:nth-child(3){animation-delay:.4s}',
'@keyframes vsb{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-5px);opacity:1}}',
'.vs25-fq{padding:10px 14px 8px;background:var(--bar-bg);flex-shrink:0;border-top:1px solid var(--divider)}',
'.vs25-fq-label{font-size:.68rem;color:var(--chip-c);font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;display:flex;align-items:center;gap:4px}',
'.vs25-fqg{display:flex;flex-wrap:wrap;gap:6px}',
'.vs25-chip{display:inline-flex;align-items:center;gap:5px;background:var(--chip-bg);color:var(--chip-c);border:1.5px solid var(--chip-border);font-size:.8rem;font-weight:600;padding:7px 13px;border-radius:9999px;cursor:pointer;line-height:1.2;transition:all .2s cubic-bezier(.34,1.56,.64,1);box-shadow:0 1px 4px rgba(0,0,0,.03);touch-action:manipulation}',
'.vs25-chip:hover{background:var(--chip-hbg);color:var(--chip-hc);border-color:var(--chip-hbg);transform:translateY(-2px);box-shadow:0 6px 18px rgba(37,99,235,.3)}',
'.vs25-chip:active{transform:scale(.95)}',
'.vs25-bot-avatar{width:32px;height:32px;border-radius:50%;background:#ffffff;border:1px solid #e2e8f0;object-fit:contain;padding:2px;flex-shrink:0;margin-top:2px;box-shadow:0 2px 6px rgba(0,0,0,.06)}',
'.vs25-input-card{margin:8px 12px 12px;background:var(--bar-bg);border:1.5px solid var(--inp-border);border-radius:18px;padding:10px 12px 8px;box-shadow:0 4px 16px rgba(15,23,42,.06);display:flex;flex-direction:column;gap:4px;position:relative;flex-shrink:0;transition:all .2s}',
'.vs25-input-card:focus-within{border-color:var(--inp-focus-border);box-shadow:var(--inp-focus-glow)}',
'.vs25-inp{width:100%;background:transparent;color:var(--inp-c);border:none;outline:none;font-size:.9rem;font-family:inherit;resize:none;min-height:38px;max-height:90px;overflow-y:auto;line-height:1.45}',
'.vs25-inp::placeholder{color:#94a3b8;font-weight:400}',
'.vs25-input-footer{display:flex;align-items:center;justify-content:between;padding-top:4px;border-top:1px solid rgba(0,0,0,.03)}',
'.vs25-input-tools{display:flex;align-items:center;gap:10px;color:#94a3b8;flex:1}',
'.vs25-tool-btn{background:none;border:none;color:#94a3b8;cursor:pointer;padding:4px;display:flex;align-items:center;justify-content:center;border-radius:50%;transition:color .18s,background .18s}',
'.vs25-tool-btn:hover{color:#2563eb;background:rgba(37,99,235,.08)}',
'.vs25-snd-btn{background:none;border:none;color:#94a3b8;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:4px;border-radius:50%;transition:all .2s cubic-bezier(.34,1.56,.64,1);touch-action:manipulation}',
'.vs25-snd-btn:hover{color:#2563eb;transform:scale(1.1)}',
'.vs25-snd-btn:active{transform:scale(.92)}',
'.vs25-snd-btn.has-text{color:#2563eb;transform:scale(1.05)}',
'.vs25-snd-btn svg{width:20px;height:20px;fill:currentColor}',
'.vs25-snd-btn:disabled{color:#cbd5e1;cursor:not-allowed;transform:none;opacity:.6}',
'.vs25-ft{text-align:center;padding:3px 8px 6px;color:var(--ft-c);font-size:.62rem;font-weight:500;background:var(--bar-bg);flex-shrink:0;transition:background .3s;letter-spacing:.02em}',
'@media(max-width:539px){',
'  .vs25-ft{padding-bottom:calc(6px + env(safe-area-inset-bottom,0px))}',
'  .vs25-input-card{margin:6px 10px 10px}',
'  .vs25-inp{font-size:1rem}',
'  .vs25-chip{padding:8px 14px;font-size:.82rem}',
'}'
].join('');

var INVITES=['💬 Fragen zur eSIM? Ich helfe sofort!','🤔 Noch unsicher? Kostenlose Beratung!','👋 Passende eSIM finden – frag mich!','🔍 Ich finde den richtigen Tarif für dich!'];

function build(){
  if(document.getElementById('vs25')) return;
  var w=document.createElement('div'); w.id='vs25';
  var st=document.createElement('style'); st.textContent=CSS; document.head.appendChild(st);
  var inv=INVITES[Math.floor(Math.random()*INVITES.length)];

  try { if(localStorage.getItem('vs25_theme')==='dark') w.classList.add('vs25-dark'); } catch(_) {}

  w.innerHTML=
    '<button id="vs25-bbl" aria-label="Chat öffnen">'+
      '<span class="vs25-bbl-chat"><svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg></span>'+
      '<span class="vs25-bbl-close">✕</span>'+
      '<span id="vs25-status-dot" class="online"></span>'+
    '</button>'+
    '<div id="vs25-inv"><button class="vs25-ix" id="vs25-ix" aria-label="Schließen">✕</button>'+esc(inv)+'</div>'+
    '<div id="vs25-pnl" role="dialog" aria-label="PureSim Support Chat">'+
      '<div class="vs25-drag"><span></span></div>'+
      '<div class="vs25-hdr">'+
        '<button class="vs25-back" id="vs25-back" title="Schließen" aria-label="Schließen">'+
          '<svg viewBox="0 0 24 24"><path d="M19 11H7.83l4.88-4.88c.39-.39.39-1.03 0-1.42-.39-.39-1.02-.39-1.41 0l-6.59 6.59c-.39.39-.39 1.02 0 1.41l6.59 6.59c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L7.83 13H19c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>'+
        '</button>'+
        '<div class="vs25-hdr-av">'+
          '<img src="/logo.png" alt="PureSim Logo" style="width:34px;height:34px;object-fit:contain;border-radius:50%;background:white;padding:2px;" onError="this.onerror=null;this.src=\'https://puresim.net/logo.png\';" />'+
          '<span class="vs25-av-dot online" id="vs25-av-dot"></span>'+
        '</div>'+
        '<div class="vs25-hdr-info">'+
          '<div class="vs25-hdr-name">Questions? Chat with us.</div>'+
          '<div class="vs25-hdr-sub" id="vs25-hdr-sub">'+
            '<span class="vs25-hdr-sub-dot online" id="vs25-hdr-sub-dot"></span>'+
            '<span id="vs25-hdr-sub-text">Typically replies under 2 hours.</span>'+
          '</div>'+
        '</div>'+
        '<button class="vs25-theme-btn" id="vs25-theme-btn" title="Hell/Dunkel" aria-label="Hell/Dunkel wechseln">'+
          '<svg class="vs25-moon" viewBox="0 0 24 24"><path d="M12.3 22h-.1c-5.5 0-10-4.5-10-10 0-4.8 3.5-8.9 8.2-9.8.5-.1 1 .2 1.2.7.2.5 0 1.1-.4 1.4-2.8 2.2-4.2 5.7-3.4 9.3.8 3.5 3.7 6.1 7.3 6.5.5.1.9.4 1 .9.1.5-.1 1-.6 1.2-1.2.5-2.4.8-3.7.8z"/></svg>'+
          '<svg class="vs25-sun" viewBox="0 0 24 24"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41s-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.01c.39-.39.39-1.03 0-1.41s-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/></svg>'+
        '</button>'+
        '<div class="vs25-toggle-wrap">'+
          '<span class="vs25-toggle-label">KI</span>'+
          '<label class="vs25-toggle"><input type="checkbox" id="vs25-ki-toggle" checked><span class="vs25-slider"></span></label>'+
        '</div>'+
      '</div>'+
      '<div class="vs25-msgs" id="vs25-msgs" role="log" aria-live="polite"></div>'+
      '<div class="vs25-fq" id="vs25-fq">'+
        '<div class="vs25-fq-label">✨ Schnellfragen</div>'+
        '<div class="vs25-fqg" id="vs25-fqg"></div>'+
      '</div>'+
      '<div class="vs25-input-card">'+
        '<textarea class="vs25-inp" id="vs25-inp" placeholder="Compose your message…" rows="2" autocomplete="off" autocorrect="on" autocapitalize="sentences"></textarea>'+
        '<div class="vs25-input-footer">'+
          '<div class="vs25-input-tools">'+
            '<button type="button" class="vs25-tool-btn" id="vs25-emoji-btn" title="Emoji einfügen">'+
              '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">'+
                '<circle cx="12" cy="12" r="10" />'+
                '<path d="M8 14s1.5 2 4 2 4-2 4-2" />'+
                '<line x1="9" y1="9" x2="9.01" y2="9" stroke-width="3" stroke-linecap="round" />'+
                '<line x1="15" y1="9" x2="15.01" y2="9" stroke-width="3" stroke-linecap="round" />'+
              '</svg>'+
            '</button>'+
          '</div>'+
          '<button class="vs25-snd-btn" id="vs25-snd" aria-label="Nachricht senden">'+
            '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">'+
              '<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>'+
            '</svg>'+
          '</button>'+
        '</div>'+
      '</div>'+
      '<div class="vs25-ft"><span id="vs25-ft-text">Powered by PureSim AI</span></div>'+
    '</div>';

  document.body.appendChild(w);

  document.getElementById('vs25-bbl').onclick=toggleChat;
  document.getElementById('vs25-back').onclick=closeChat;
  document.getElementById('vs25-snd').onclick=sendMsg;
  document.getElementById('vs25-ki-toggle').onchange=toggleKI;
  document.getElementById('vs25-inv').onclick=function(e){if(e.target.id==='vs25-ix'){hideInv();return;}hideInv();openChat();};
  document.getElementById('vs25-ix').onclick=function(e){e.stopPropagation();hideInv();};
  document.getElementById('vs25-inp').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}});
  document.getElementById('vs25-emoji-btn').onclick=function(){
    var i=document.getElementById('vs25-inp');
    if(i){ i.value += ' 😊'; i.focus(); }
  };
  document.getElementById('vs25-inp').addEventListener('input',function(){
    this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px';
    var snd=document.getElementById('vs25-snd');
    if(snd){ if(this.value.trim().length > 0) snd.classList.add('has-text'); else snd.classList.remove('has-text'); }
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

function _autoDetectIdentity() {
  var data = {};
  try {
    var sp = new URLSearchParams(location.search);
    if (sp.get('email')) data.email = sp.get('email');
    if (sp.get('ref')) data.checkoutRef = sp.get('ref');
    if (sp.get('iccid')) data.iccid = sp.get('iccid');

    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && (key.indexOf('sb-') === 0 || key.indexOf('auth') >= 0 || key.indexOf('user') >= 0)) {
        try {
          var val = localStorage.getItem(key);
          if (val && val.indexOf('@') >= 0) {
            var parsed = JSON.parse(val);
            if (parsed && parsed.user && parsed.user.email) {
              data.email = parsed.user.email;
              data.userId = parsed.user.id;
              if (parsed.user.user_metadata && (parsed.user.user_metadata.full_name || parsed.user.user_metadata.name)) {
                data.customerName = parsed.user.user_metadata.full_name || parsed.user.user_metadata.name;
              }
            } else if (parsed && parsed.email) {
              data.email = parsed.email;
              if (parsed.name || parsed.full_name) data.customerName = parsed.name || parsed.full_name;
            }
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return data;
}

window.PureSimSupport = {
  identify: function(details) {
    if (!details || typeof details !== 'object') return;
    var id = chatId || _ssGet();
    if (!id) return;
    _postTrack('/api/widget/identify', Object.assign({ chatId: id }, details), 2);
  }
};

function passiveTrack(){
  var currentUrl=location.href;
  if(passiveTrack._lastSent===currentUrl) return;
  passiveTrack._lastSent=currentUrl;

  var saved=_ssGet()||chatId;
  var identity=_autoDetectIdentity();

  _postTrack('/api/widget/beacon', Object.assign({
    fingerprint:fp(),
    visitorId:_visitorId,
    pageUrl:currentUrl,
    pageTitle:smartTitle(),
    chatId:saved
  }, identity))
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
        ft.textContent=d.poweredBy;
      }
    }
    if(d.botName){
      var nameEl = document.querySelector('.vs25-hdr-name');
      if (nameEl) nameEl.textContent = d.botName;
    }
  }).catch(function(){});

  var saved=_ssGet();
  var identity=_autoDetectIdentity();

  if(saved){
    chatId=saved;
    if(identity.email || identity.checkoutRef || identity.iccid) {
      window.PureSimSupport.identify(identity);
    }
    // WICHTIG: Auch bei bestehendem chatId den Seitenaufruf per /beacon an das Backend melden!
    passiveTrack();
    loadHist();
    startStatusPoll();
    return;
  }

  _postTrack('/api/widget/init', Object.assign({
    fingerprint:fp(),
    visitorId:_visitorId,
    pageUrl:location.href,
    pageTitle:smartTitle(),
    chatId:null
  }, identity))
  .then(function(d){
    if(!d || d.banned) return;
    if(!d.chatId) return;
    chatId=d.chatId; _ssSet(chatId);
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

function toggleChat(){if(isOpen) closeChat(); else openChat();}
function openChat(){
  if(isOpen) return;isOpen=true;hideInv();_proDone=true;clearTimeout(_proTimer);
  document.getElementById('vs25-pnl').classList.add('on');
  var bbl=document.getElementById('vs25-bbl');
  if(bbl){bbl.classList.add('vs25-open');bbl.setAttribute('aria-label','Chat schließen');}
  setTimeout(function(){var i=document.getElementById('vs25-inp');if(i)i.focus();scrl();},80);
  trackPage();
}
function closeChat(){
  isOpen=false;
  document.getElementById('vs25-pnl').classList.remove('on');
  var bbl=document.getElementById('vs25-bbl');
  if(bbl){bbl.classList.remove('vs25-open');bbl.setAttribute('aria-label','Chat öffnen');}
}
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
  var avatar = role === 'b' ? '<img src="/logo.png" alt="PureSim Logo" class="vs25-bot-avatar" onError="this.onerror=null;this.src=\'https://puresim.net/logo.png\';" />' : '';
  d.innerHTML=avatar+
    '<div class="vs25-bub">'+
      '<div class="vs25-bub-content">'+
        '<span class="vs25-txt">'+esc(text)+'</span>'+
        '<div class="vs25-ts-bar"><span>'+t+'</span>'+ticks+'</div>'+
      '</div>'+
    '</div>';
  el.appendChild(d); if(!noScroll) scrl();
}

function showTyp(show){
  isTyping=show;var ex=document.getElementById('vs25-typ');
  if(!show){if(ex)ex.remove();return;}if(ex) return;
  var d=document.createElement('div');d.id='vs25-typ';d.className='vs25-msg b vs25-typ';
  var avatar = '<img src="/logo.png" alt="PureSim Logo" class="vs25-bot-avatar" onError="this.onerror=null;this.src=\'https://puresim.net/logo.png\';" />';
  d.innerHTML=avatar+'<div class="vs25-bub"><div class="vs25-typ-dots"><span></span><span></span><span></span></div></div>';
  document.getElementById('vs25-msgs').appendChild(d);scrl();
}

function scrl(){var e=document.getElementById('vs25-msgs');if(e)e.scrollTop=e.scrollHeight;}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');}

// ── Erweiterter Fingerprint ───────────────────────────────────────────────────
// Kombiniert mehrere Signale damit auch identische In-App-Browser
// (Instagram, TikTok) auseinandergehalten werden können.
// visitor_id (UUID) ist jedoch der primäre Identifier — fp() nur als Ergänzung.
function fp(){
  var parts=[
    navigator.userAgent||'',
    navigator.language||'',
    (screen.width||0)+'x'+(screen.height||0),
    (screen.colorDepth||0)+'bit',
    Intl.DateTimeFormat().resolvedOptions().timeZone||'',
    (navigator.hardwareConcurrency||0)+'cpu',
    (navigator.deviceMemory||0)+'gb',
    navigator.platform||'',
    (navigator.maxTouchPoints||0)+'tp'
  ];
  // Canvas-Fingerprint (rendert Text → Grafikkarte + Font-Unterschiede)
  try{
    var c=document.createElement('canvas'),g=c.getContext('2d');
    if(g){
      g.textBaseline='top';g.font='14px Arial';
      g.fillStyle='#f60';g.fillRect(125,1,62,20);
      g.fillStyle='#069';g.fillText('PureSim',2,15);
      g.fillStyle='rgba(102,204,0,0.7)';g.fillText('PureSim',4,17);
      parts.push(c.toDataURL().slice(-32));
    }
  }catch(_){}
  // WebGL renderer (GPU-Bezeichnung)
  try{
    var wc=document.createElement('canvas');
    var gl=wc.getContext('webgl')||wc.getContext('experimental-webgl');
    if(gl){
      var ext=gl.getExtension('WEBGL_debug_renderer_info');
      if(ext) parts.push(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL).slice(0,20));
    }
  }catch(_){}
  return btoa(unescape(encodeURIComponent(parts.join('|')))).substring(0,48);
}

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
