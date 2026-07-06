/**
 * notificationService.js v1.3 (1.6.76-2)
 *
 * Graceful Degradation: web-push ist optional.
 * Fehlendes Paket oder fehlende VAPID-Keys blockieren NIEMALS den Kern-Datenfluss.
 *
 * Neu in 1.6.76-2:
 *   - notifyNewVisitor()           - Erst-Besuch auf der Website (laut, sichtbar)
 *   - notifyVisitorActivity()      - Page-Wechsel/Verweilen (sichtbar, throttled)
 *   - In-Memory-Throttle pro Visitor verhindert Spam:
 *       * Neuer Besucher: nur 1x pro Visitor in 24h
 *       * Activity:        max 1x pro Visitor in 5 Minuten
 */

const supabase = require('../config/supabase');
const logger   = require('../utils/logger');

let _wp           = null;
let _wpReady      = false;
let _wpInitTried  = false;

// ── Throttle-Maps (in-memory) ────────────────────────────────────────────────
// Form: { "<chatId>": <timestamp_ms> } - letzte gesendete Notification
const _firstVisitSent      = new Map();  // 24h Dedup
const _lastActivitySent    = new Map();  // 5min Dedup
const FIRST_VISIT_TTL_MS   = 24 * 60 * 60 * 1000;
const ACTIVITY_THROTTLE_MS = 5 * 60 * 1000;

// Periodischer Cleanup damit Maps nicht unbegrenzt wachsen
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _firstVisitSent.entries()) {
    if (now - v > FIRST_VISIT_TTL_MS) _firstVisitSent.delete(k);
  }
  for (const [k, v] of _lastActivitySent.entries()) {
    const ts = (v && typeof v === 'object') ? v.ts : v;
    if (now - ts > ACTIVITY_THROTTLE_MS * 4) _lastActivitySent.delete(k);
  }
}, 60 * 60 * 1000).unref?.();

function _init() {
  if (_wpInitTried) return _wpReady;
  _wpInitTried = true;

  try {
    _wp = require('web-push');
  } catch {
    logger.info('[Push] web-push nicht installiert – Push deaktiviert (kein Fehler)');
    return false;
  }

  const rawPub  = process.env.VAPID_PUBLIC_KEY  || '';
  const rawPriv = process.env.VAPID_PRIVATE_KEY || '';

  if (!rawPub || !rawPriv) {
    logger.info('[Push] VAPID-Keys nicht gesetzt – Push deaktiviert');
    return false;
  }

  // VAPID-Keys säubern: web-push erwartet URL-safe Base64 OHNE Padding
  // (entfernt Whitespace/Zeilenumbrüche, konvertiert +/ zu -_, entfernt =)
  const sanitize = (k) => k.trim()
    .replace(/\s+/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  const pub  = sanitize(rawPub);
  const priv = sanitize(rawPriv);

  try {
    _wp.setVapidDetails('mailto:admin@valueshop25.com', pub, priv);
    _wpReady = true;
    logger.info('[Push] ✅ Web Push bereit');
  } catch (e) {
    logger.warn(`[Push] VAPID-Konfiguration fehlgeschlagen: ${e.message}`);
  }

  return _wpReady;
}

const notificationService = {

  isReady() { return _wpReady; },

  /** Sendet eine Test-Benachrichtigung und gibt Zustellstatus zurück */
  async sendTestNotification() {
    // Init erzwingen (falls beim ersten Versuch VAPID noch nicht geladen war)
    _wpInitTried = false;
    const ready = _init();
    if (!ready) {
      logger.warn('[Push] Test: Web Push nicht bereit (VAPID prüfen)');
      return { ready: false, sent: 0 };
    }
    let sent = 0;
    const expired = [];
    try {
      const { data: subs } = await supabase.from('admin_subscriptions').select('id, subscription_data');
      const json = JSON.stringify({
        title: '🔔 Test-Benachrichtigung',
        body:  'Push funktioniert! Du erhältst ab jetzt Benachrichtigungen.',
        tag:   'test-push-' + Date.now(),
        url:   '/admin'
      });
      for (const row of (subs || [])) {
        try {
          const sub = typeof row.subscription_data === 'string'
            ? JSON.parse(row.subscription_data) : row.subscription_data;
          if (sub?.endpoint) {
            await _wp.sendNotification(sub, json, { TTL: 3600, urgency: 'high' });
            sent++;
          }
        } catch (e) {
          if ([401, 403, 404, 410].includes(e.statusCode)) expired.push(row.id);
          logger.warn(`[Push] Test-Senden fehlgeschlagen (${row.id}): ${e.statusCode || ''} ${e.message}`);
        }
      }
      // Abgelaufene Subscriptions entfernen
      if (expired.length) {
        try { await supabase.from('admin_subscriptions').delete().in('id', expired); } catch (_) {}
      }
    } catch (e) {
      logger.warn('[Push] Test-Notification Fehler: ' + e.message);
    }
    logger.info(`[Push] Test → ${sent} zugestellt${expired.length ? `, ${expired.length} expired entfernt` : ''}`);
    return { ready: true, sent };
  },

  // ── Chat-Nachrichten ──────────────────────────────────────────────────────
  // ── Mitarbeiter angefordert → dringende Push an Admin ─────────────────
  async notifyHumanRequest({ chatId, firstName, platform, text }) {
    if (!_init()) return;
    const who = firstName || (platform === 'web_widget' ? 'Website-Besucher' : 'Telegram-Nutzer');
    await this._push({
      title: '🙋 Mitarbeiter angefordert',
      body:  `${who} möchte mit einem Menschen sprechen. Die KI wurde für diesen Chat deaktiviert.`,
      icon:  '/icon-192.png',
      tag:   `human-${String(chatId).substring(0, 12)}-${Date.now()}`,
      url:   '/admin#chats',
      chatId
    });
  },

  async sendNewMessageNotification({ chatId, text, firstName, platform, isFirstMessage }) {
    if (!_init()) return;

    const name = firstName || chatId || 'Kunde';
    const icon = platform === 'telegram' ? '✈️' : '🌐';

    await this._push({
      title:  isFirstMessage ? `${icon} Neuer Chat: ${name}` : `${icon} ${name}`,
      body:   text.substring(0, 100) + (text.length > 100 ? '…' : ''),
      icon:   '/icon-192.png',
      tag:    `chat-${chatId}`,
      url:    '/admin',
      chatId
    });
  },

  // ── NEUER Besucher auf der Website (1.6.76-2) ─────────────────────────────
  // Wird in widgetRoutes /init für jeden NEUEN Visitor aufgerufen.
  // Throttle: nur 1x pro chatId in 24h damit kein Spam bei Page-Reloads.
  async notifyNewVisitor({ chatId, pageTitle, pageUrl, isNew }) {
    if (!_init()) return;
    if (!chatId) return;

    const key = String(chatId);
    const now = Date.now();
    const last = _firstVisitSent.get(key) || 0;
    if (now - last < FIRST_VISIT_TTL_MS) {
      // Bereits in 24h notified → trotzdem als Activity behandeln
      return this.notifyVisitorActivity({ chatId, pageTitle, pageUrl });
    }
    _firstVisitSent.set(key, now);
    _lastActivitySent.set(key, { page: String(pageTitle || '').trim(), ts: now });  // Activity-Dedup synchronisieren

    const title = isNew === false
      ? `👋 Wiederkehrender Besucher`
      : `🆕 Neuer Besucher`;
    const body  = pageTitle
      ? `Schaut sich gerade "${String(pageTitle).substring(0, 60)}" an`
      : 'Ist gerade auf der Website';

    await this._push({
      title,
      body,
      icon: '/icon-192.png',
      tag:  `visitor-new-${key.substring(0, 8)}`,
      url:  '/admin#visitors',
      chatId
    });
  },

  // ── Besucher-Aktivität (Page-Wechsel/Verweilen) (1.6.76-2) ────────────────
  // Wird in widgetRoutes /beacon und /activity aufgerufen.
  // Throttle: pro chatId max 1x in 5min.
  async notifyVisitorActivity({ chatId, pageTitle, pageUrl }) {
    if (!_init()) return;
    if (!chatId) return;

    const key  = String(chatId);
    const now  = Date.now();
    const page = String(pageTitle || pageUrl || '').trim();

    // Dedup NUR exakte Doppel-Fires: gleiche Seite innerhalb 3 Sekunden
    // (z.B. beacon beim Laden + visibilitychange gleichzeitig).
    // Jeder echte Seitenwechsel löst eine Push aus.
    const lastEntry = _lastActivitySent.get(key);
    if (lastEntry && lastEntry.page === page && (now - lastEntry.ts) < 3000) {
      return;
    }
    _lastActivitySent.set(key, { page, ts: now });

    const body = page
      ? `Auf "${page.substring(0, 70)}"`
      : 'Ist weiterhin auf der Website';

    await this._push({
      title: `👁 Besucher`,
      body,
      icon:  '/icon-192.png',
      // Eindeutiger Tag pro Push → Benachrichtigungen ersetzen sich NICHT,
      // jeder Seitenwechsel erscheint einzeln.
      tag:   `visitor-act-${key.substring(0, 8)}-${now}`,
      url:   '/admin#visitors',
      chatId
    });
  },

  // ── Learning Case ────────────────────────────────────────────────────────
  async notifyNewLearningCase(question) {
    if (!_init()) return;
    const q = String(question || '').trim();
    await this._push({
      title: '🧠 Neue offene Frage',
      body:  q.substring(0, 140) + (q.length > 140 ? '…' : ''),
      icon:  '/icon-192.png',
      tag:   'learning-case',
      url:   '/admin#learning'
    });
  },

  async sendTestNotification() {
    if (!_init()) return false;
    await this._push({
      title: '✅ Push aktiv!',
      body:  'Benachrichtigungen funktionieren.',
      icon:  '/icon-192.png',
      tag:   'test',
      url:   '/admin'
    });
    return true;
  },

  // ── Debug-Helfer (1.6.76-2): Throttle-Status zurueckgeben ─────────────────
  _debugThrottleState() {
    return {
      firstVisits: _firstVisitSent.size,
      activities:  _lastActivitySent.size,
      ready:       _wpReady
    };
  },

  async _push(payload) {
    if (!_wpReady || !_wp) {
      logger.debug?.('[Push] _push aufgerufen aber nicht ready');
      return;
    }

    let subs;
    try {
      const { data } = await supabase.from('admin_subscriptions').select('id, subscription_data');
      subs = data || [];
    } catch (e) {
      logger.warn('[Push] Subscriptions laden fehlgeschlagen:', e.message);
      return;
    }

    if (!subs.length) {
      logger.info(`[Push] "${payload.tag || 'message'}" - Keine aktiven Subscriptions`);
      return;
    }

    // (1.6.76-2) Wir senden NIEMALS silent: true mehr - User wollte hörbare Notifications
    const sendPayload = { ...payload };
    delete sendPayload.silent;

    const json    = JSON.stringify(sendPayload);
    const expired = [];
    let ok = 0;

    await Promise.allSettled(subs.map(async (row) => {
      try {
        const sub = typeof row.subscription_data === 'string'
          ? JSON.parse(row.subscription_data)
          : row.subscription_data;
        if (!sub?.endpoint) {
          expired.push(row.id);
          return;
        }
        // TTL 24h: Push wird zugestellt sobald das Gerät wieder online ist (auch
        // nach langem Hintergrund/Standby). urgency 'high': sofortige Zustellung
        // trotz Energiesparmodus.
        await _wp.sendNotification(sub, json, { TTL: 86400, urgency: 'high' });
        ok++;
      } catch (e) {
        if ([401, 403, 404, 410].includes(e.statusCode)) {
          expired.push(row.id);
          logger.info(`[Push] Subscription ${row.id} expired (${e.statusCode}) — wird gelöscht`);
        } else if (e.statusCode === 413) {
          logger.warn(`[Push] Payload zu groß (${row.id})`);
        } else if (e.statusCode === 429) {
          logger.warn(`[Push] Rate-Limit (${row.id})`);
        } else {
          logger.warn(`[Push] Senden fehlgeschlagen (${row.id}, status=${e.statusCode || '?'}): ${e.message}`);
        }
      }
    }));

    logger.info(`[Push] "${payload.tag || 'message'}" → ${ok}/${subs.length} zugestellt${expired.length ? `, ${expired.length} expired` : ''}`);

    if (expired.length) {
      try {
        await supabase.from('admin_subscriptions').delete().in('id', expired);
      } catch (e) {
        logger.warn('[Push] Expired-Cleanup fehlgeschlagen:', e.message);
      }
    }
  }
};

// Vorab-Initialisierung (non-blocking)
setImmediate(() => _init());

module.exports = notificationService;
