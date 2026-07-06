/**
 * ValueShop25 Chat Widget v1.7.0
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
    console.log('%c[VS25-Widget] v1.7.0 script loaded', 'color: #128c7e; font-weight: bold');
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
  var url=location.pathname;
  var m=url.match(/\/product\/([^/?#]+)/);if(m)return m[1].replace(/-/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();});
  var cm=url.match(/\/category\/([^/?#]+)/);if(cm)return 'Kategorie: '+cm[1].replace(/-/g,' ');
  if(/\/checkout/i.test(url))return'Checkout';if(/\/cart|warenkorb/i.test(url))return'Warenkorb';
  if(url==='/'||url==='')return'Startseite';
  var t=(document.title||'').split(/\s[–|-]\s/)[0].trim();return t.length>50?t.substring(0,50)+'…':(t||'Seite');
}

// ── CSS ───────────────────────────────────────────────────────────────────────
var CSS = [
// ── CSS Custom Properties (Light Mode Default) ─────────────────────────────
'#vs25{',
'  --hdr:#008069;',
'  --pnl-bg:#efeae2;',
'  --msg-bg:#efeae2;',
'  --msg-pat:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'80\' height=\'80\'%3E%3Cg fill=\'%23e5ddd5\' fill-opacity=\'.3\'%3E%3Cpath d=\'M10 15h2v2h-2zm10 5h2v2h-2zm-10 15h2v2h-2zm20-10h2v2h-2zm10-10h2v2h-2zm10 20h2v2h-2zm10 10h2v2h-2zm-30 20h2v2h-2zm-10 10h2v2h-2zm20 10h2v2h-2zm10-10h2v2h-2zm10-10h2v2h-2zm10 20h2v2h-2zm10 10h2v2h-2z\'/%3E%3C/g%3E%3C/svg%3E");',
'  --bub-b:#fff;',
'  --bub-b-txt:#111b21;',
'  --bub-u:#d9fdd3;',
'  --bub-u-txt:#111b21;',
'  --ts-c:#8696a0;',
'  --date-bg:#fff;',
'  --date-c:#667781;',
'  --bar-bg:#f0f2f5;',
'  --inp-bg:#fff;',
'  --inp-c:#111b21;',
'  --chip-bg:#fff;',
'  --chip-bd:1.5px solid #008069;',
'  --chip-c:#008069;',
'  --chip-hbg:#008069;',
'  --chip-hc:#fff;',
'  --ft-c:#8696a0;',
'  --av-bd:#008069;',
'}',
// ── Dark Mode ─────────────────────────────────────────────────────────────
'#vs25.vs25-dark{',
'  --hdr:#202c33;',
'  --pnl-bg:#0b141a;',
'  --msg-bg:#0b141a;',
'  --msg-pat:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'80\' height=\'80\'%3E%3Cg fill=\'%23fff\' fill-opacity=\'.05\'%3E%3Cpath d=\'M10 15h2v2h-2zm10 5h2v2h-2zm-10 15h2v2h-2zm20-10h2v2h-2zm10-10h2v2h-2zm10 20h2v2h-2zm10 10h2v2h-2zm-30 20h2v2h-2zm-10 10h2v2h-2zm20 10h2v2h-2zm10-10h2v2h-2zm10-10h2v2h-2zm10 20h2v2h-2zm10 10h2v2h-2z\'/%3E%3C/g%3E%3C/svg%3E");',
'  --bub-b:#202c33;',
'  --bub-b-txt:#e9edef;',
'  --bub-u:#005c4b;',
'  --bub-u-txt:#e9edef;',
'  --ts-c:rgba(233,237,239,.6);',
'  --date-bg:#182229;',
'  --date-c:#8696a0;',
'  --bar-bg:#1f2c34;',
'  --inp-bg:#2a3942;',
'  --inp-c:#e9edef;',
'  --chip-bg:#202c33;',
'  --chip-bd:1.5px solid #00a884;',
'  --chip-c:#00a884;',
'  --chip-hbg:#00a884;',
'  --chip-hc:#fff;',
'  --ft-c:#8696a0;',
'  --av-bd:#202c33;',
'}',
// ── Base ─────────────────────────────────────────────────────────────────
'#vs25 *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
// Launch bubble
'#vs25-bbl{position:fixed;bottom:24px;right:22px;z-index:99998;width:60px;height:60px;border-radius:50%;background:#25d366;box-shadow:0 4px 16px rgba(37,211,102,.4);cursor:pointer;border:none;outline:none;display:flex;align-items:center;justify-content:center;transition:transform .2s,box-shadow .2s}',
'#vs25-bbl:hover{transform:scale(1.06)}',
'#vs25-bbl svg{width:28px;height:28px;fill:white}',
// Status dot on launch bubble
'#vs25-status-dot{position:absolute;bottom:2px;right:2px;width:13px;height:13px;border-radius:50%;border:2px solid white;background:#4caf50}',
'#vs25-status-dot.online{background:#25d366;box-shadow:0 0 0 2px rgba(37,211,102,.3);animation:vspulse 2s infinite}',
'#vs25-status-dot.manual{background:#ff9800;box-shadow:0 0 0 2px rgba(255,152,0,.3);animation:vspulse 2s infinite}',
'#vs25-status-dot.offline{background:#f44336;animation:none}',
'@keyframes vspulse{0%,100%{opacity:1}50%{opacity:.55}}',
// Proactive invite
'#vs25-inv{position:fixed;bottom:96px;right:22px;z-index:99997;background:var(--bub-b);color:var(--bub-b-txt);border-radius:12px 12px 2px 12px;padding:10px 28px 10px 14px;max-width:240px;box-shadow:0 4px 16px rgba(0,0,0,.15);font-size:.85rem;line-height:1.4;cursor:pointer;display:none;animation:vspop .3s ease-out}',
'#vs25-inv.on{display:block}',
'#vs25-inv::after{content:"";position:absolute;bottom:-6px;right:16px;border-left:6px solid transparent;border-top:6px solid var(--bub-b)}',
'.vs25-ix{position:absolute;top:4px;right:6px;font-size:.75rem;color:#8696a0;cursor:pointer;background:none;border:none;line-height:1}',
'@keyframes vspop{from{opacity:0;transform:scale(.88) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}',
// Panel (mobile first – full screen)
// Use 100svh (small viewport = excludes browser chrome bars) so widget never overflows.
// Fallback chain: 100svh → 100dvh → 100% for broadest browser support.
'#vs25-pnl{position:fixed;z-index:99999;display:none;flex-direction:column;top:0;left:0;width:100%;height:100%;height:100svh;max-height:100svh;border-radius:0;overflow:hidden;background:var(--pnl-bg);box-shadow:0 8px 32px rgba(11,20,26,.2);transform:translateY(100%);transition:transform .3s cubic-bezier(.32,.72,0,1)}',
'@supports(height:100dvh) and (not (height:100svh)){#vs25-pnl{height:100dvh;max-height:100dvh}}',
'#vs25-pnl.on{display:flex;transform:translateY(0)}',
// Desktop: portrait container
'@media(min-width:540px){',
'  #vs25-pnl{top:auto;bottom:90px;right:24px;left:auto;width:370px;height:min(620px,calc(100svh - 110px));border-radius:12px;border:1px solid rgba(11,20,26,.08);transform:translateY(120%)}',
'  #vs25-pnl.on{display:flex;transform:translateY(0)}',
'}',
// Mobile drag handle
'.vs25-drag{display:none;justify-content:center;padding:8px 0 4px;background:var(--hdr);flex-shrink:0}',
'.vs25-drag span{width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,.35)}',
'@media(max-width:539px){.vs25-drag{display:flex}}',
// Header
'.vs25-hdr{background:var(--hdr);padding:calc(10px + env(safe-area-inset-top,0px)) 12px 10px;display:flex;align-items:center;gap:8px;flex-shrink:0;box-shadow:0 1px 3px rgba(0,0,0,.15);transition:background .3s}',
// Back/close button
'.vs25-back{background:none;border:none;color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:8px;margin-right:4px;flex-shrink:0;border-radius:50%;transition:background .15s,transform .1s}',
'.vs25-back:hover{background:rgba(255,255,255,.15)}',
'.vs25-back:active{transform:scale(.9)}',
'.vs25-back svg{width:26px;height:26px;fill:white}',
// Avatar
'.vs25-hdr-av{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;position:relative}',
'.vs25-hdr-av .vs25-av-dot{position:absolute;bottom:0;right:0;width:9px;height:9px;border-radius:50%;border:1.5px solid var(--av-bd);background:#25d366}',
'.vs25-hdr-av .vs25-av-dot.manual{background:#ff9800}',
'.vs25-hdr-av .vs25-av-dot.offline{background:#f44336}',
'.vs25-hdr-info{flex:1;min-width:0}',
'.vs25-hdr-name{color:white;font-weight:700;font-size:.92rem;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.vs25-hdr-sub{color:rgba(255,255,255,.85);font-size:.72rem;margin-top:2px}',
// Theme toggle button
'.vs25-theme-btn{background:none;border:none;color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:8px;flex-shrink:0;border-radius:50%;transition:background .15s,transform .1s}',
'.vs25-theme-btn:hover{background:rgba(255,255,255,.15)}',
'.vs25-theme-btn:active{transform:scale(.9)}',
'.vs25-theme-btn svg{width:20px;height:20px;fill:white;display:block}',
'#vs25 .vs25-sun{display:none}',
'#vs25 .vs25-moon{display:block}',
'#vs25.vs25-dark .vs25-sun{display:block}',
'#vs25.vs25-dark .vs25-moon{display:none}',
// KI Toggle
'.vs25-toggle-wrap{display:flex;align-items:center;gap:4px;flex-shrink:0}',
'.vs25-toggle-label{color:rgba(255,255,255,.9);font-size:.7rem;font-weight:600}',
'.vs25-toggle{position:relative;width:34px;height:18px;cursor:pointer;flex-shrink:0}',
'.vs25-toggle input{opacity:0;width:0;height:0;position:absolute}',
'.vs25-slider{position:absolute;inset:0;background:rgba(255,255,255,.3);border-radius:18px;transition:.2s;cursor:pointer}',
'.vs25-slider::before{content:"";position:absolute;height:12px;width:12px;left:3px;bottom:3px;background:white;border-radius:50%;transition:.2s}',
'.vs25-toggle input:checked + .vs25-slider{background:#25d366}',
'.vs25-toggle input:checked + .vs25-slider::before{transform:translateX(16px)}',
// Messages area
'.vs25-msgs{flex:1;overflow-y:auto;padding:14px 14px 8px;display:flex;flex-direction:column;gap:6px;background-color:var(--msg-bg);background-image:var(--msg-pat);transition:background-color .3s}',
'.vs25-msgs::-webkit-scrollbar{width:4px}.vs25-msgs::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:2px}',
'.vs25-msg{display:flex;flex-direction:column;max-width:85%;margin-bottom:6px}',
'.vs25-msg.u{align-self:flex-end}',
'.vs25-msg.b{align-self:flex-start}',
// Message bubbles with real WA tails and generous padding
'.vs25-bub{padding:10px 14px 8px;font-size:.92rem;line-height:1.5;word-break:break-word;white-space:pre-wrap;position:relative;min-height:34px;box-shadow:0 1px 0.5px rgba(0,0,0,.13);display:block;overflow:hidden}',
'.vs25-txt{display:inline}',
'.vs25-msg.b .vs25-bub{background:var(--bub-b);color:var(--bub-b-txt);border-radius:0 10px 10px 10px}',
'.vs25-msg.b .vs25-bub::before{content:"";position:absolute;top:0;left:-6px;width:6px;height:10px;background:var(--bub-b);clip-path:polygon(100% 0,0 0,100% 100%)}',
'.vs25-msg.u .vs25-bub{background:var(--bub-u);color:var(--bub-u-txt);border-radius:10px 0 10px 10px}',
'.vs25-msg.u .vs25-bub::before{content:"";position:absolute;top:0;right:-6px;width:6px;height:10px;background:var(--bub-u);clip-path:polygon(0 0,100% 0,0 100%)}',
// Timestamp - float right (authentic WA behavior)
'.vs25-ts{display:inline-flex;align-items:center;gap:3px;float:right;margin-top:6px;margin-left:10px;font-size:.66rem;color:var(--ts-c);line-height:1;position:relative;top:4px}',
'.vs25-ticks{color:#53bdeb;font-size:.75rem;font-weight:bold;margin-left:2px}',
// Date separator
'.vs25-date-sep{text-align:center;margin:8px 0;font-size:.7rem;color:var(--date-c)}',
'.vs25-date-sep span{background:var(--date-bg);padding:4px 12px;border-radius:8px;box-shadow:0 1px 0.5px rgba(0,0,0,.13)}',
// Typing indicator
'.vs25-typ .vs25-bub{display:flex;align-items:center;gap:4px;padding:10px 14px;min-width:54px}',
'.vs25-typ span{width:6px;height:6px;border-radius:50%;background:#8696a0;animation:vsb 1.3s infinite}',
'.vs25-typ span:nth-child(2){animation-delay:.2s}.vs25-typ span:nth-child(3){animation-delay:.4s}',
'@keyframes vsb{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-4px)}}',
// FAQ suggestion chips – compact wrapping grid, always fully visible
'.vs25-fq{padding:6px 10px 4px;background:var(--bar-bg);flex-shrink:0;border-top:1px solid rgba(0,0,0,.06);box-shadow:0 -1px 4px rgba(0,0,0,.04)}',
'.vs25-fqg{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0}',
'.vs25-chip{',
'  display:inline-flex;align-items:center;gap:5px;',
'  background:var(--chip-bg);',
'  border:none;',
'  color:var(--chip-c);',
'  font-size:.78rem;font-weight:600;',
'  padding:7px 13px;',
'  border-radius:6px;',
'  cursor:pointer;line-height:1.2;',
'  transition:background .15s,color .15s,transform .1s;',
'  text-align:left;',
'  box-shadow:0 1px 3px rgba(0,0,0,.1);',
'  white-space:nowrap;flex-shrink:0;',
'  border-left:3px solid var(--chip-c)',
'}',
'.vs25-chip:hover{background:var(--chip-hbg);color:var(--chip-hc);border-left-color:var(--chip-hbg);transform:translateY(-1px)}',
'.vs25-chip:active{transform:translateY(0)}',
// Input area
'.vs25-ir{padding:7px 10px;background:var(--bar-bg);display:flex;gap:6px;align-items:center;flex-shrink:0;border-top:1px solid rgba(0,0,0,.05);transition:background .3s}',
'.vs25-inp{flex:1;background:var(--inp-bg);color:var(--inp-c);border:none;border-radius:20px;padding:9px 14px;font-size:.9rem;font-family:inherit;resize:none;max-height:80px;overflow-y:auto;line-height:1.4;outline:none;box-shadow:0 1px 2px rgba(0,0,0,.1);transition:background .3s,color .3s}',
'.vs25-inp::placeholder{color:var(--ts-c)}',
'.vs25-snd{width:40px;height:40px;border-radius:50%;flex-shrink:0;background:#00a884;border:none;color:white;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,transform .1s;box-shadow:0 2px 6px rgba(0,0,0,.2)}',
'.vs25-snd:hover{background:#008f72}',
'.vs25-snd:active{transform:scale(.92)}',
'.vs25-snd svg{width:19px;height:19px;fill:white}',
'.vs25-snd:disabled{background:#a6b9bc;cursor:not-allowed;box-shadow:none;transform:none}',
// Footer branding – very compact
'.vs25-ft{text-align:center;padding:3px 4px;color:var(--ft-c);font-size:.58rem;background:var(--bar-bg);flex-shrink:0;transition:background .3s}',
// Mobile safe area – push content up above browser nav bar
'@media(max-width:539px){',
'  .vs25-ft{padding-bottom:calc(4px + env(safe-area-inset-bottom,0px))}',
'  .vs25-ir{padding-bottom:calc(7px + env(safe-area-inset-bottom,0px))}',
'  .vs25-ir.vs25-is-last{padding-bottom:calc(9px + env(safe-area-inset-bottom,0px))}',
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
    '<button id="vs25-bbl" aria-label="Chat öffnen">'+
      '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>'+
      '<span id="vs25-status-dot" class="online"></span>'+
    '</button>'+
    '<div id="vs25-inv"><button class="vs25-ix" id="vs25-ix">✕</button>'+esc(inv)+'</div>'+
    '<div id="vs25-pnl">'+
      '<div class="vs25-drag"><span></span></div>'+
      '<div class="vs25-hdr">'+
        '<button class="vs25-back" id="vs25-back" title="Schließen" aria-label="Schließen">'+
          '<svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>'+
        '</button>'+
        '<div class="vs25-hdr-av">🤖<span class="vs25-av-dot" id="vs25-av-dot"></span></div>'+
        '<div class="vs25-hdr-info">'+
          '<div class="vs25-hdr-name">ValueShop25 Support</div>'+
          '<div class="vs25-hdr-sub" id="vs25-hdr-sub">KI Assistent · Online</div>'+
        '</div>'+
        // Theme toggle button (moon = switch to dark, sun = switch to light)
        '<button class="vs25-theme-btn" id="vs25-theme-btn" title="Design wechseln" aria-label="Hell/Dunkel wechseln">'+
          '<svg class="vs25-moon" viewBox="0 0 24 24"><path d="M12.3 22h-.1c-5.5 0-10-4.5-10-10 0-4.8 3.5-8.9 8.2-9.8.5-.1 1 .2 1.2.7.2.5 0 1.1-.4 1.4-2.8 2.2-4.2 5.7-3.4 9.3.8 3.5 3.7 6.1 7.3 6.5.5.1.9.4 1 .9.1.5-.1 1-.6 1.2-1.2.5-2.4.8-3.7.8z"/></svg>'+
          '<svg class="vs25-sun" viewBox="0 0 24 24"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41s-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.01c.39-.39.39-1.03 0-1.41s-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/></svg>'+
        '</button>'+
        '<div class="vs25-toggle-wrap">'+
          '<span class="vs25-toggle-label">KI</span>'+
          '<label class="vs25-toggle"><input type="checkbox" id="vs25-ki-toggle" checked><span class="vs25-slider"></span></label>'+
        '</div>'+
      '</div>'+
      '<div class="vs25-msgs" id="vs25-msgs"></div>'+
      '<div class="vs25-fq" id="vs25-fq"><div class="vs25-fqg" id="vs25-fqg"></div></div>'+
      '<div class="vs25-ir">'+
        '<textarea class="vs25-inp" id="vs25-inp" placeholder="Nachricht schreiben…" rows="1"></textarea>'+
        '<button class="vs25-snd" id="vs25-snd" aria-label="Senden"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>'+
      '</div>'+
      '<div class="vs25-ft"><span id="vs25-ft-text">Powered by ValueShop25 AI</span></div>'+
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

  // ─── Seitenwechsel-Tracking ───────────────────────────────────────────────
  // sessionStorage NICHT bei Navigation löschen — der Besucher soll über
  // alle Seiten hinweg als DERSELBE Besucher mit weiteren Seitenaufrufen
  // erkannt werden. sessionStorage endet automatisch beim Schließen des Tabs.
  // (Kein pagehide/beforeunload-Clear mehr.)
}

function passiveTrack(){
  var saved=_ssGet()||chatId;
  _postTrack('/api/widget/beacon', {fingerprint:fp(),pageUrl:location.href,pageTitle:smartTitle(),chatId:saved})
  .then(function(d){
    if(d && d.chatId && !_ssGet()) _ssSet(d.chatId);
  });
}

function startSession(){
  _safeFetch(API+'/api/widget/config').then(function(r){return r.json();}).then(function(d){
    var ft=document.getElementById('vs25-ft-text');
    if(ft){
      if(d.poweredBy===null||d.poweredBy===''){
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

  if(saved){
    chatId=saved;
    loadHist();
    startStatusPoll();
    passiveTrack();
    return;
  }

  _postTrack('/api/widget/init', {fingerprint:fp(),pageUrl:location.href,pageTitle:smartTitle(),chatId:null})
  .then(function(d){
    if(!d || d.banned) return;
    if(!d.chatId) return;
    chatId=d.chatId; _ssSet(chatId);
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
  var sub=document.getElementById('vs25-hdr-sub');
  var tog=document.getElementById('vs25-ki-toggle');
  if(dot){dot.className=status;}
  if(avDot){avDot.className='vs25-av-dot '+(status==='online'?'':status);}
  if(sub){
    sub.textContent=status==='online'?'KI Assistent · Online':status==='manual'?'Mitarbeiter angefordert':'KI Offline';
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
