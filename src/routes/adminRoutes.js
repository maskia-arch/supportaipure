/**
 * AI eSIM Berater - API-Routes
 * Endpoints fuer das Berater-Dashboard.
 */
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/adminController');
const auth    = require('../middleware/auth');

router.post('/login', ctrl.login);

// ── ÖFFENTLICHE Push-Endpoints (vom Service Worker genutzt, kein JWT möglich) ──
// VAPID-Key ist öffentlich; Renewal ist über den alten Endpoint abgesichert.
router.get('/push/public-vapid',    ctrl.getPublicVapidKey);
router.post('/push/renew',          ctrl.renewPushSubscription);

router.use(auth);

// ─── Allgemeine Dashboard-Daten ────────────────────────────────────────────
router.get('/stats',         ctrl.getStats);
router.get('/settings',      ctrl.getSettings);
router.post('/settings',     ctrl.updateSettings);

// ─── Push-Notifications fuer das Dashboard ────────────────────────────────
router.post('/push-subscription', ctrl.savePushSubscription);
router.get('/push/vapid-key',     ctrl.getVapidPublicKey);
router.post('/push/test',         ctrl.sendTestPush);

// ─── Chats (Live-Konversationen mit Kunden) ───────────────────────────────
router.get('/chats',                    ctrl.getChats);
router.get('/chats/:chatId/messages',   ctrl.getChatMessages);
router.patch('/chats/:chatId/status',   ctrl.updateChatStatus);
router.post('/manual-message',          ctrl.sendManualMessage);

// ─── Learning-Queue (unbeantwortete Fragen) ───────────────────────────────
router.get('/learning',          ctrl.getLearningQueue);
router.post('/learning/resolve', ctrl.resolveLearning);
router.delete('/learning/:id',   ctrl.deleteLearning);

// ─── Knowledge-Base ────────────────────────────────────────────────────────
router.get('/knowledge/categories',        ctrl.getKnowledgeCategories);
router.post('/knowledge/categories',       ctrl.createKnowledgeCategory);
router.delete('/knowledge/categories/:id', ctrl.deleteKnowledgeCategory);

router.get('/knowledge/entries',              ctrl.getKnowledgeEntries);
router.delete('/knowledge/entries/:id',       ctrl.deleteKnowledgeEntry);
router.put('/knowledge/entries/:id',          ctrl.updateKnowledgeEntry);
router.post('/knowledge/entries/:id/sync',    ctrl.syncKnowledgeEntry);
router.get('/knowledge/entries/:id/related',  ctrl.getRelatedEntries);

router.post('/knowledge/manual',   ctrl.addManualKnowledge);
router.post('/knowledge/discover', ctrl.discoverLinks);
router.post('/scrape',             ctrl.startScraping);

// ─── Sellauth Integration ──────────────────────────────────────────────────
router.get('/sellauth/check',              ctrl.checkSellauthConfig);
router.post('/sellauth/test',              ctrl.testSellauthConnection);
router.post('/sellauth/sync',              ctrl.syncSellauth);
router.get('/sellauth/invoice/:invoiceId', ctrl.lookupInvoice);
router.get('/sellauth/sync-status/:jobId', ctrl.getSyncStatus);
router.get('/sellauth/preview',            ctrl.previewSellauthProducts);
router.post('/sync-sellauth',              ctrl.syncSellauth);

// ─── Telegram-Webhook (Support-Bot) ────────────────────────────────────────
router.post('/telegram/webhook', ctrl.setupWebhook);
router.get('/telegram/webhook',  ctrl.getWebhookInfo);

// ─── Blacklist (User-Bans im Berater) ──────────────────────────────────────
router.get('/blacklist',        ctrl.getBlacklist);
router.post('/blacklist',       ctrl.banUser);
router.delete('/blacklist/:id', ctrl.removeBan);

// ─── Feedback-Workflow ─────────────────────────────────────────────────────
router.get('/feedbacks/pending',       ctrl.getPendingFeedbacks);
router.post('/feedbacks/:id/approve',  ctrl.approveFeedback);
router.post('/feedbacks/:id/reject',   ctrl.rejectFeedback);

// ─── Traffic / Visitors ────────────────────────────────────────────────────
router.get('/traffic',         ctrl.getTrafficStats);
router.get('/traffic/live',    ctrl.getLiveVisitors);
router.get('/traffic/sessions', ctrl.getSessions);
router.get('/vapid/generate',  ctrl.generateVapidKeys);
router.get('/vapid/public-key', ctrl.getVapidPublicKey);
router.post('/push/test', ctrl.sendTestPush);
router.get('/push/status', ctrl.getPushStatus);
router.post('/knowledge/setup-categories', ctrl.setupKbCategories);

router.get('/visitors',             ctrl.getVisitorList);
router.get('/visitors/ip/:ip',      ctrl.lookupVisitorIp);
router.post('/visitors/ip/:ip/ban', ctrl.banVisitorIp);

// ─── Coupons (taegliche Aktionen) ──────────────────────────────────────────
router.get('/coupons/schedule',    ctrl.getCouponSchedule);
router.put('/coupons/schedule',    ctrl.saveCouponSchedule);
router.get('/coupons/active',      ctrl.getActiveCoupon);
router.post('/coupons/create-now', ctrl.createCouponNow);
router.get('/coupons/history',     ctrl.getCouponHistory);

module.exports = router;
