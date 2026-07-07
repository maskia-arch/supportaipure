const express        = require('express');
const router         = express.Router();
const messageProcessor = require('../services/messageProcessor');
const visitorService   = require('../services/visitorService');
const supabase         = require('../config/supabase');
const logger           = require('../utils/logger');

router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Chat-ID');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// (1.6.78) Diagnose-Endpoint - der User kann von seiner Website aus pruefen
// ob das Widget-Backend lebt.
// Nutzung: window.fetch('https://puresimaisupport.autoacts.link/api/widget/health').then(r=>r.json()).then(console.log)
router.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok:        true,
    version:   '1.6.78',
    widget:    '1.6.78',
    timestamp: new Date().toISOString(),
    uptime:    Math.floor(process.uptime())
  });
});

router.post('/beacon', async (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const ip = visitorService._getClientIp(req);
      const { chatId, isNew, visitorNumber } = await visitorService.getOrCreateVisitor(
        ip, req.headers['user-agent'], req.body.fingerprint
      );
      const banCheck = await visitorService.isBanned(ip, chatId);
      if (banCheck.banned) return;

      const pageUrl   = req.body.pageUrl || '';
      const pageTitle = req.body.pageTitle || getSmartTitle(pageUrl, req.body.pageTitle);

      // Sicherstellen dass ein chats-Eintrag existiert (auch ohne Chat-Öffnung)
      await _ensureChatRecord(chatId, ip, isNew);

      // Visitor-Session aktualisieren (damit Live-Dashboard aktuell bleibt)
      await _upsertSession(chatId, pageTitle, pageUrl, supabase, isNew);

      // Activity-Log (mit voller URL)
      await visitorService.logActivity(chatId, `Besucht: ${pageTitle}`, pageUrl, pageTitle).catch(() => {});

      // Push-Notification (throttled, nur wenn VAPID konfiguriert)
      const notifService = require('../services/notificationService');
      await notifService.notifyVisitorActivity({
        chatId,
        visitorNumber,
        pageTitle,
        pageUrl
      }).catch(() => {});

    } catch (_) {}
  });
});

function getSmartTitle(url, titleFromBrowser) {
  // Browser liefert den echten Seiten-Titel → Markenname abschneiden
  if (titleFromBrowser) {
    return titleFromBrowser
      .split(/\s[–\-|]\s/)[0]   // "Startseite – PureSim" → "Startseite"
      .replace(/\s*[\|–\-]\s*PureSim.*$/i, '')
      .trim()
      .substring(0, 60) || 'Seite';
  }
  if (!url) return 'Seite';
  try {
    const u    = new URL(url);
    const path = u.pathname;
    const q    = u.searchParams;

    // ── Startseite ────────────────────────────────────────────────────────────
    if (path === '/' || path === '') return 'Startseite';

    // ── Warenkorb / Cart ──────────────────────────────────────────────────────
    if (/\/(cart|warenkorb)/i.test(path)) return 'Warenkorb';

    // ── Checkout ──────────────────────────────────────────────────────────────
    if (/\/checkout/i.test(path)) {
      if (/order[-_]?received|thank/i.test(path)) return 'Bestellung abgeschlossen ✅';
      return 'Checkout';
    }

    // ── PureSim: Tarif-Detailseite  /tariffs/ckh993 ───────────────────────────
    const tariffDetail = path.match(/\/tariffs\/([^/?#]+)/i);
    if (tariffDetail) {
      const slug = tariffDetail[1].replace(/-/g, ' ');
      return `Tarif: ${slug}`;
    }

    // ── PureSim: Tarif-Suche  /tariffs?q=Deutschland ─────────────────────────
    if (/\/tariffs/i.test(path)) {
      const qParam = q.get('q') || q.get('search') || q.get('query');
      if (qParam) return `Tarif-Suche: ${decodeURIComponent(qParam).substring(0, 40)}`;
      return 'Tarifübersicht';
    }

    // ── PureSim: Account / Meine Bestellungen ────────────────────────────────
    if (/\/account|\/my-account|\/mein-konto/i.test(path)) return 'Mein Konto';

    // ── PureSim: eSIM aktivieren / Installation ───────────────────────────────
    if (/\/activat|\/aktivier|\/install/i.test(path)) return 'eSIM aktivieren';

    // ── PureSim: Über uns / Kontakt / FAQ ────────────────────────────────────
    if (/\/about|\/ueber-uns/i.test(path)) return 'Über uns';
    if (/\/contact|\/kontakt/i.test(path)) return 'Kontakt';
    if (/\/faq|\/hilfe|\/help/i.test(path)) return 'FAQ & Hilfe';

    // ── PureSim: Blog ────────────────────────────────────────────────────────
    const blogPost = path.match(/\/blog\/([^/?#]+)/i);
    if (blogPost) return `Blog: ${blogPost[1].replace(/-/g, ' ').substring(0, 40)}`;
    if (/\/blog/i.test(path)) return 'Blog';

    // ── Generisches Produkt (WooCommerce o.ä.) ────────────────────────────────
    const prod = path.match(/\/product\/([^/?#]+)/i);
    if (prod) return prod[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).substring(0, 50);

    // ── Kategorie ─────────────────────────────────────────────────────────────
    const cat = path.match(/\/categor[yi]\/([^/?#]+)/i);
    if (cat) return `Kategorie: ${cat[1].replace(/-/g, ' ')}`;

    // ── Datenschutz / Impressum ───────────────────────────────────────────────
    if (/\/datenschutz|\/privacy/i.test(path)) return 'Datenschutz';
    if (/\/impressum|\/imprint/i.test(path)) return 'Impressum';
    if (/\/agb|\/terms/i.test(path)) return 'AGB';

    // ── Alles andere: leserlicher Pfad ───────────────────────────────────────
    return path.replace(/^\//, '').replace(/[-\/]/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 50) || 'Seite';
  } catch { return 'Seite'; }
}

router.post('/init', async (req, res) => {
  try {
    const ip = visitorService._getClientIp(req);
    const { chatId, isNew, visitorNumber } = await visitorService.getOrCreateVisitor(ip, req.headers['user-agent'], req.body.fingerprint);
    const banCheck = await visitorService.isBanned(ip, chatId);
    if (banCheck.banned) return res.json({ banned: true, message: 'Zugang gesperrt.' });

    const pageUrl    = req.body.pageUrl || '';
    const smartTitle = req.body.pageTitle || 'Website';

    // Sicherstellen dass ein chats-Eintrag existiert (auch ohne Chat-Öffnung)
    await _ensureChatRecord(chatId, ip, isNew);

    await visitorService.logActivity(chatId, `Besucht: ${smartTitle}`, pageUrl, smartTitle);
    await _upsertSession(chatId, smartTitle, pageUrl, supabase, isNew);

    let welcome = 'Hallo! 👋 Wie kann ich dir helfen?';
    const { data: s } = await supabase.from('settings').select('welcome_message').single();
    if (s?.welcome_message) welcome = s.welcome_message;

    res.json({ chatId, isNew, welcome, banned: false });

    // Push-Notification fuer JEDEN /init - throttled in notificationService
    setImmediate(() => {
      try {
        const notifService = require('../services/notificationService');
        notifService.notifyNewVisitor({
          chatId,
          visitorNumber,
          pageTitle: smartTitle,
          pageUrl,
          isNew
        }).catch(() => {});
      } catch (_) {}
    });
  } catch (err) { res.status(500).json({ error: 'Fail' }); }
});

router.post('/message', async (req, res) => {
  try {
    const chatId = req.headers['x-chat-id'] || req.body.chatId;
    const text = (req.body.message || '').trim();
    const ip = visitorService._getClientIp(req);

    if (!chatId || !text) return res.status(400).json({ error: 'Missing data' });
    const banCheck = await visitorService.isBanned(ip, chatId);
    if (banCheck.banned) return res.json({ banned: true, reply: 'Gesperrt.' });

    const reply = await messageProcessor.handle({
      platform: 'web_widget',
      chatId,
      text,
      metadata: { ip, user_agent: req.headers['user-agent'] }
    });

    res.json({ reply: reply || 'Bitte erneut senden.', type: 'ai' });
  } catch (err) { res.status(500).json({ error: 'Fail' }); }
});

router.get('/history', async (req, res) => {
  try {
    const chatId = req.headers['x-chat-id'] || req.query.chatId;
    const { data: msgs } = await supabase.from('messages').select('role, content, created_at')
      .eq('chat_id', chatId).neq('role', 'system').order('created_at', { ascending: true });
    res.json({ messages: msgs || [] });
  } catch (err) { res.json({ messages: [] }); }
});

router.post('/activity', async (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const chatId = req.headers['x-chat-id'] || req.body.chatId;
      if (!chatId) return;

      const rawTitle  = req.body.pageTitle || '';
      const pageTitle = rawTitle || getSmartTitle(req.body.pageUrl, rawTitle);
      const pageUrl   = req.body.pageUrl || '';

      // Log the activity (inkl. voller URL)
      await visitorService.logActivity(chatId, `Besucht: ${pageTitle}`, pageUrl, pageTitle);

      // Session-Update mit voller URL
      await _upsertSession(chatId, pageTitle, pageUrl, supabase, false);

      // Activity push (throttled) — visitorNumber aus DB laden
      const { data: vData } = await supabase
        .from('widget_visitors')
        .select('visitor_number')
        .eq('chat_id', chatId)
        .maybeSingle();

      const notifService = require('../services/notificationService');
      await notifService.notifyVisitorActivity({
        chatId,
        visitorNumber: vData?.visitor_number || null,
        pageTitle,
        pageUrl
      }).catch(() => {});
    } catch (_) {}
  });
});

router.get('/faq', async (req, res) => {
  const faqs = ['Welche eSIMs habt ihr?', 'Wie aktiviere ich?', 'Bestellstatus?', 'Unlimited vs Travel?', 'Gültigkeit?'];
  res.json({ faqs });
});

// ── Besucher hat die Seite verlassen ──────────────────────────────────────────
// Wird via navigator.sendBeacon ausgelöst wenn Tab geschlossen / Seite verlassen.
// Markiert die aktive Session als inaktiv damit Live-Dashboard korrekt ist.
router.post('/leave', async (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const chatId = req.headers['x-chat-id'] || req.body?.chatId;
      if (!chatId) return;

      // Aktive Sessions für diesen Visitor als inaktiv markieren
      await supabase
        .from('visitor_sessions')
        .update({ is_active: false })
        .eq('chat_id', chatId)
        .eq('is_active', true);

      // widget_visitors last_seen aktuell halten
      await supabase
        .from('widget_visitors')
        .update({ last_seen: new Date() })
        .eq('chat_id', chatId);

      logger.debug(`[Leave] Session inaktiv gesetzt: ${chatId}`);
    } catch (_) {}
  });
});

router.get('/config', async (req, res) => {
  try {
    const { data: s } = await supabase.from('settings').select('welcome_message, widget_powered_by').single();
    res.json({
      enabled:        true,
      botName:        'PureSim Support',
      welcomeMessage: s?.welcome_message || 'Hallo!',
      poweredBy:      s?.widget_powered_by || 'Powered by PureSim AI'
    });
  } catch { res.json({ enabled: true, botName: 'PureSim Support', poweredBy: 'Powered by PureSim AI' }); }
});

// ── Chat-Record sicherstellen ────────────────────────────────────────────────
// Erstellt einen Eintrag in der chats-Tabelle für JEDEN Besucher,
// auch wenn der Chat nie geöffnet wurde — für den vollständigen Klickpfad
// im Admin-Dashboard.
async function _ensureChatRecord(chatId, ip, isNew) {
  try {
    const { data: existing } = await supabase
      .from('chats')
      .select('id')
      .eq('id', chatId)
      .maybeSingle();
    if (existing) return; // bereits vorhanden

    await supabase.from('chats').insert([{
      id:          chatId,
      platform:    'web_widget',
      status:      'ki',
      visitor_ip:  ip || null,
      created_at:  new Date(),
      updated_at:  new Date()
    }]);
  } catch (_) { /* Fehler ignorieren - nie blockieren */ }
}

// ── Session-Upsert mit voller URL-Tracking ───────────────────────────────────
async function _upsertSession(chatId, pageTitle, pageUrl, supabase, isNew) {
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: active } = await supabase.from('visitor_sessions').select('id, page_count')
      .eq('chat_id', chatId).eq('is_active', true).gte('last_seen', cutoff).maybeSingle();

    if (active) {
      await supabase.from('visitor_sessions').update({
        last_seen:     new Date(),
        page_count:    (active.page_count || 0) + 1,
        last_page:     pageTitle,
        last_page_url: pageUrl || null
      }).eq('id', active.id);
      return active.id;
    }
    const { data: created } = await supabase.from('visitor_sessions').insert([{
      chat_id:       chatId,
      started_at:    new Date(),
      last_seen:     new Date(),
      entry_page:    pageTitle,
      entry_page_url: pageUrl || null,
      last_page:     pageTitle,
      last_page_url: pageUrl || null,
      is_active:     true
    }]).select('id').single();
    return created?.id;
  } catch { return null; }
}

module.exports = router;
