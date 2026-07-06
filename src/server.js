/**
 * AI eSIM Berater Server (Standalone)
 * ─────────────────────────────────────────────────────────────────────────────
 * Customer-Support-Bot. Verwaltet:
 *   - Web-Widget (Embed-Script auf Kunden-Website)
 *   - Support-Telegram-Bot
 *   - Visitor-Tracking, Live-Chat
 *   - Knowledge-Base, Lernen
 *   - Sellauth-Integration (Bestellungen, Produkte)
 *   - Coupon-Scheduler
 *
 * Dashboard: GET /admin
 * Widget:    GET /widget.js (Embed-Script fuer Kunden-Website)
 * Webhooks:  POST /api/webhooks/telegram, POST /api/widget/*
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const { port } = require('./config/env');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

const adminRoutes = require('./routes/adminRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const widgetRoutes = require('./routes/widgetRoutes');

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// /widget.js direkt mit no-cache fuer schnelle Updates beim Kunden
app.get('/widget.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Widget-Version', '1.6.78');
  res.sendFile(path.join(__dirname, 'public', 'widget.js'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/admin',    adminRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/widget',   widgetRoutes);

app.get('/admin',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin/*',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health',    (req, res) => res.json({ status: 'ok', service: 'berater', version: '1.6.78', ts: new Date().toISOString() }));
app.get('/',          (req, res) => res.redirect('/admin'));

app.use(errorHandler);

const server = app.listen(port, () => {
  logger.info(`[eSIM-Berater] Server läuft auf Port ${port}`);
  setTimeout(() => {
    autoRegisterWebhook();
    setAutoCommands();
    startKeepAlive();

    // Coupon-Scheduler (taegliche Coupons)
    try {
      const couponService = require('./services/couponService');
      couponService.startDailyScheduler();
      logger.info('[eSIM-Berater] Coupon Scheduler aktiv');
    } catch(e) { logger.warn(e.message); }
  }, 5000);
});

async function autoRegisterWebhook() {
  const supabase = require('./config/supabase');
  const axios = require('axios');

  let appUrl = process.env.APP_URL || '';
  if (!appUrl) {
    try {
      const { data: settings } = await supabase.from('settings').select('webhook_url').single();
      appUrl = settings?.webhook_url || '';
    } catch (e) {}
  }

  const supportToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!supportToken) {
    logger.warn('[Webhook/Support] TELEGRAM_BOT_TOKEN nicht gesetzt.');
    return;
  }

  // Telegram verlangt zwingend HTTPS für Webhooks
  const isHttps = appUrl && appUrl.toLowerCase().startsWith('https://');

  if (isHttps) {
    appUrl = appUrl.replace(/\/$/, '');
    try {
      const r = await axios.post(
        `https://api.telegram.org/bot${supportToken}/setWebhook`,
        {
          url: `${appUrl}/api/webhooks/telegram`,
          allowed_updates: ['message','callback_query','my_chat_member','channel_post','chat_join_request'],
          drop_pending_updates: false
        },
        { timeout: 10000 }
      );
      if (r.data?.ok) {
        logger.info(`[Webhook/Support] ✅ Registriert: ${appUrl}/api/webhooks/telegram`);
        try { await supabase.from('settings').upsert({ id: 1, webhook_url: appUrl, updated_at: new Date() }); } catch(_){}
        return; // Webhook registriert, fertig!
      } else {
        logger.warn(`[Webhook/Support] Fehler: ${r.data?.description}`);
      }
    } catch (e) {
      logger.warn(`[Webhook/Support] Registrierung fehlgeschlagen: ${e.response?.data?.description || e.message}`);
    }
  } else {
    logger.warn('[Webhook/Support] Keine HTTPS-URL konfiguriert (Telegram verlangt HTTPS).');
  }

  // Fallback: Webhook löschen und Long-Polling starten
  try {
    logger.info('[Webhook/Support] Entferne alten Webhook bei Telegram...');
    await axios.post(`https://api.telegram.org/bot${supportToken}/deleteWebhook`);
    
    const webhookRoutesModule = require('./routes/webhookRoutes');
    webhookRoutesModule.startTelegramPolling(supportToken);
  } catch (err) {
    logger.error(`[Webhook/Support] Fehler beim Umschalten auf Polling: ${err.message}`);
  }
}

async function setAutoCommands() {
  const axios = require('axios');
  const supportToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!supportToken) return;
  try {
    await axios.post(`https://api.telegram.org/bot${supportToken}/setMyCommands`, {
      commands: [
        { command: 'start', description: 'Begrüßung & Hilfe' },
        { command: 'help',  description: 'Was kann ich tun?' },
        { command: 'order', description: 'Bestellstatus prüfen (/order INVOICE_ID)' }
      ]
    }, { timeout: 8000 });
    logger.info('[eSIM-Berater] Autocomplete-Befehle registriert');
  } catch (err) { logger.warn(`[eSIM-Berater] setMyCommands: ${err.response?.data?.description || err.message}`); }
}

function startKeepAlive() {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return;
  const http = require('http');
  const https = require('https');
  function ping() {
    try {
      const url = new URL(`${appUrl}/health`);
      const client = url.protocol === 'https:' ? https : http;
      const req = client.get(url.href, { timeout: 8000 }, (res) => logger.info(`[KeepAlive] ${res.statusCode}`));
      req.on('error', (e) => logger.warn(`[KeepAlive] ${e.message}`));
      req.end();
    } catch (e) { logger.warn(`[KeepAlive] ${e.message}`); }
  }
  setTimeout(() => { ping(); setInterval(ping, 14 * 60 * 1000); }, 30000);
  logger.info(`[KeepAlive] Aktiv → ${appUrl}/health`);
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} → Server wird beendet`);
  server.close(() => { logger.info('Server beendet'); process.exit(0); });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (r) => logger.error('Unhandled Rejection:', r));
process.on('uncaughtException',  (e) => { logger.error('Uncaught Exception:', e); shutdown('uncaughtException'); });

module.exports = app;
