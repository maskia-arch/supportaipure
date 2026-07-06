/**
 * webhookRoutes.js — SUPPORT AI Bot
 * ─────────────────────────────────────────────────────────────────────────────
 * Verarbeitet eingehende Telegram-Updates für den eSIM-Berater Support-Bot.
 *
 * Scope: NUR PrivatChat mit Usern (isPrivate === true).
 * Gruppen/Kanal-Management gehört zu einem separaten Service.
 *
 * Token:   process.env.TELEGRAM_BOT_TOKEN
 * Webhook: POST /api/webhooks/telegram
 * Sellauth Webhook: POST /api/webhooks/sellauth
 */
const express          = require('express');
const router           = express.Router();
const axios            = require('axios');
const supabase         = require('../config/supabase');
const telegramService  = require('../services/telegramService');
const logger           = require('../utils/logger');

// ── Deduplizierung: verhindert Doppelverarbeitung bei Telegram-Retries ────────
const _processedUpdates = new Map();
const _UPDATE_CACHE_MS  = 10 * 60 * 1000; // 10 Minuten

function _rememberUpdate(id) {
  _processedUpdates.set(id, Date.now());
  if (_processedUpdates.size > 1000) {
    const cutoff = Date.now() - _UPDATE_CACHE_MS;
    for (const [k, t] of _processedUpdates)
      if (t < cutoff) _processedUpdates.delete(k);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemeinsame Verarbeitungslogik für Telegram-Updates (Webhook & Polling)
// ─────────────────────────────────────────────────────────────────────────────
async function handleTelegramUpdate(updateBody) {
  try {
    const SUPPORT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!SUPPORT_TOKEN) {
      logger.error('[Telegram/Support] TELEGRAM_BOT_TOKEN nicht konfiguriert!');
      return;
    }

    // ── Deduplizierung ──────────────────────────────────────────────────────
    const update_id = updateBody?.update_id;
    if (update_id && _processedUpdates.has(update_id)) return;
    if (update_id) _rememberUpdate(update_id);

    // ── Nur echte Nachrichten verarbeiten ───────────────────────────────────
    const msg = updateBody.message;
    if (!msg) return; // callback_query, channel_post, my_chat_member etc. ignorieren

    const chatId   = msg.chat?.id?.toString();
    const text     = msg.text?.trim() || msg.caption?.trim() || '';
    const from     = msg.from;
    const isPrivate = msg.chat?.type === 'private';

    // Scope: nur PrivatChat — Gruppen/Kanäle gehören einem separaten Service
    if (!isPrivate) return;

    if (!chatId || !text || !from) return;

    // Bots ignorieren
    if (from.is_bot) return;

    // ── Einstellungen laden (Welcome-Message) ───────────────────────────────
    let settings = null;
    try {
      const { data } = await supabase.from('settings').select('welcome_message').single();
      settings = data;
    } catch (_) {}

    const tgSend = (text, extra = {}) =>
      telegramService.sendMessage(chatId, text, { token: SUPPORT_TOKEN, ...extra });

    // ── /start ──────────────────────────────────────────────────────────────
    if (text === '/start' || text.startsWith('/start@')) {
      const welcome = settings?.welcome_message
        || 'Willkommen beim ValueShop25 Support! 👋\n\nIch helfe dir bei Fragen rund um eSIMs und unsere Tarife. Frag mich einfach!\n\n📋 Bestellung prüfen: /order DEINE_INVOICE_ID';
      await tgSend(welcome);
      return;
    }

    // ── /help ───────────────────────────────────────────────────────────────
    if (text === '/help' || text.startsWith('/help@')) {
      const helpText =
        '📚 <b>So kann ich dir helfen:</b>\n\n' +
        '• Stelle mir Fragen zu unseren eSIM-Tarifen\n' +
        '• Frage nach passenden Ländern oder Datenvolumen\n' +
        '• Frage nach aktuellen Coupons & Aktionen\n\n' +
        '<b>/order</b> &lt;Invoice-ID&gt; — Bestellstatus prüfen\n' +
        '<b>/start</b> — Begrüßung\n\n' +
        'Bei komplexen Anliegen: @autoacts';
      await tgSend(helpText);
      return;
    }

    // ── /order <InvoiceId> ──────────────────────────────────────────────────
    const ID_PATTERN = '([a-f0-9\\-]+|[0-9]+)';
    const orderMatch =
      text.match(new RegExp('^\\/order\\s+' + ID_PATTERN, 'i')) ||
      text.match(new RegExp('(?:bestellung|invoice|order|rechnung)[:\\s#]+' + ID_PATTERN, 'i'));

    if (orderMatch) {
      const invoiceId = orderMatch[1];
      try {
        const storefrontService = require('../services/storefrontService');
        const shopUrl = process.env.STOREFRONT_URL || process.env.SHOP_URL || process.env.SELLAUTH_SHOP_URL || '';
        const order = await storefrontService.getInvoice(invoiceId);
        if (!order) {
          await tgSend('Bestellung nicht gefunden. Bitte prüfe die Bestellnummer oder ICCID.');
          return;
        }
        const response = storefrontService.formatInvoiceForCustomer(order, shopUrl);
        await tgSend(response, { parse_mode: 'HTML' });
      } catch (err) {
        logger.warn(`[Telegram Webhook Order] ${err.message}`);
        await tgSend('Fehler bei der Abfrage. Bitte überprüfe deine Bestellnummer.');
      }
      return;
    }

    // ── Alle anderen Nachrichten → AI ───────────────────────────────────────
    telegramService.sendTypingAction(chatId, { token: SUPPORT_TOKEN }).catch(() => {});

    const messageProcessor = require('../services/messageProcessor');
    await messageProcessor.handle({
      platform: 'telegram',
      chatId,
      text,
      metadata: {
        username:   from.username  || null,
        first_name: from.first_name || 'Nutzer',
        token:      SUPPORT_TOKEN
      }
    });

  } catch (err) {
    logger.error(`[Telegram/Support] Fehler bei Update-Verarbeitung: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Long-Polling Implementierung (Fallback bei fehlendem HTTPS / Webhook-Fehler)
// ─────────────────────────────────────────────────────────────────────────────
let isPolling = false;
let pollingTimer = null;

function startTelegramPolling(token) {
  if (isPolling) return;
  isPolling = true;
  logger.info('[Telegram Polling] 🔄 Starte Telegram Long-Polling...');

  let offset = 0;

  async function poll() {
    if (!isPolling) return;
    try {
      const response = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`, {
        params: {
          offset: offset,
          timeout: 30,
          allowed_updates: JSON.stringify(['message'])
        },
        timeout: 35000 // Etwas länger als das Telegram-Timeout
      });

      const updates = response.data?.result || [];
      for (const update of updates) {
        offset = update.update_id + 1;
        // Asynchrone Ausführung des Handlers
        handleTelegramUpdate(update).catch(err => {
          logger.error(`[Telegram Polling] Handler-Fehler: ${err.message}`);
        });
      }
    } catch (err) {
      // ECONNABORTED und ETIMEDOUT sind normale Timeouts der Long-Poll-Anfrage
      if (err.code !== 'ECONNABORTED' && err.code !== 'ETIMEDOUT') {
        logger.error(`[Telegram Polling] Fehler beim Abrufen der Updates: ${err.message}`);
        // Bei echten Fehlern kurz warten, um Log-Spamming zu vermeiden
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    if (isPolling) {
      setImmediate(poll);
    }
  }

  poll();
}

function stopTelegramPolling() {
  if (isPolling) {
    isPolling = false;
    logger.info('[Telegram Polling] ⏹️ Polling gestoppt.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/webhooks/telegram
// ─────────────────────────────────────────────────────────────────────────────
router.post('/telegram', (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    await handleTelegramUpdate(req.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/webhooks/sellauth — Inaktiviert
// ─────────────────────────────────────────────────────────────────────────────
router.post('/sellauth', (req, res) => {
  res.sendStatus(200);
});

// Zuweisen der Polling-Steuerung an den Router-Export (Abwärtskompatibel)
router.handleTelegramUpdate = handleTelegramUpdate;
router.startTelegramPolling = startTelegramPolling;
router.stopTelegramPolling = stopTelegramPolling;

module.exports = router;
