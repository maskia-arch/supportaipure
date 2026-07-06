const supabase        = require('../config/supabase');
const deepseekService = require('../services/deepseekService');
const scraperService  = require('../services/scraperService');
const storefrontService = require('../services/storefrontService');
const syncJobManager   = require('../services/syncJobManager');
const telegramService = require('../services/telegramService');
const { getVersion }      = require('../utils/versionLoader');
const visitorService      = require('../services/visitorService');
const notificationService = require('../services/notificationService');
function getAbuseDetector() {
  try { return require('../services/abuseDetector'); }
  catch(e) { return null; }
}
const jwt = require('jsonwebtoken');

// ─────────────────────────────────────────────────────────────────────────────
// Env-Helfer: Env-Vars haben immer Vorrang vor DB-Werten
// ─────────────────────────────────────────────────────────────────────────────

/** Sellauth-Credentials: ENV > DB */
function getEffectiveSellauth(dbSettings) {
  return {
    apiKey:  (process.env.SELLAUTH_API_KEY  || dbSettings?.sellauth_api_key  || '').trim(),
    shopId:  (process.env.SELLAUTH_SHOP_ID  || dbSettings?.sellauth_shop_id  || '').trim(),
    shopUrl: (process.env.SELLAUTH_SHOP_URL || dbSettings?.sellauth_shop_url || '').trim(),
  };
}

/**
 * Legt für getSettings() die Env-Werte über die DB-Daten.
 * Maskiert sensible Werte und setzt *_via_env Flags für das Dashboard.
 */
function mergeEnvIntoSettings(data) {
  const result = { ...(data || {}) };

  const shopUrl = process.env.STOREFRONT_URL || process.env.SHOP_URL || process.env.SELLAUTH_SHOP_URL || '';
  if (shopUrl) {
    result.sellauth_shop_url = shopUrl;
    result.sellauth_shop_url_via_env = true;
  }
  if (process.env.APP_URL) {
    result.webhook_url          = process.env.APP_URL;
    result.webhook_url_via_env  = true;
  }
  return result;
}

/**
 * Hilfsfunktion zum Abrufen aller Daten unter Umgehung des PostgREST-Limits von 1000 Zeilen.
 */
async function fetchAll(tableName, selectStr, filterFn = null) {
  let allData = [];
  let page = 0;
  const pageSize = 1000;
  while (true) {
    let query = supabase.from(tableName).select(selectStr);
    if (filterFn) {
      query = filterFn(query);
    }
    const { data, error } = await query.range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    allData = allData.concat(data);
    if (data.length < pageSize) break;
    page++;
  }
  return allData;
}

const adminController = {

  async login(req, res, next) {
    try {
      const { username, password } = req.body;
      if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET || 'ai-assistant-secret-change-me', { expiresIn: '24h' });
        return res.json({ success: true, token });
      }
      res.status(401).json({ error: 'Falsche Zugangsdaten' });
    } catch (e) { next(e); }
  },

  async getStats(req, res, next) {
    try {
      const [
        { count: totalChats },
        { count: activeManual },
        { count: totalKnowledge },
        { count: pendingLearning },
        tokenUsage
      ] = await Promise.all([
        supabase.from('chats').select('*', { count: 'exact', head: true }),
        supabase.from('chats').select('*', { count: 'exact', head: true }).eq('is_manual_mode', true),
        supabase.from('knowledge_base').select('*', { count: 'exact', head: true }),
        supabase.from('learning_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        fetchAll('messages', 'prompt_tokens, completion_tokens, embedding_tokens')
      ]);
      const tin   = (tokenUsage||[]).reduce((s,m) => s+(m.prompt_tokens||0), 0);
      const tout  = (tokenUsage||[]).reduce((s,m) => s+(m.completion_tokens||0), 0);
      const temb  = (tokenUsage||[]).reduce((s,m) => s+(m.embedding_tokens||0), 0);

      const costDeepseek  = (tin  / 1_000_000) * 0.28 + (tout / 1_000_000) * 0.42;
      const costEmbedding = (temb / 1_000_000) * 0.020;
      const cost = (costDeepseek + costEmbedding).toFixed(4);
      res.json({
        version: getVersion(),
        stats: {
          totalChats: totalChats||0, activeManual: activeManual||0,
          knowledgeEntries: totalKnowledge||0, pendingLearning: pendingLearning||0,
          totalCost: `${cost} $`, totalTokens: tin+tout, embeddingTokens: temb
        }
      });
    } catch (e) { next(e); }
  },

  async cleanupOldMessages(req, res, next) {
    try {
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

      const { data: chatsToClean } = await supabase
        .from('chats')
        .select('id')
        .eq('is_manual_mode', false)
        .lt('updated_at', cutoff)
        .is('manual_mode_started_at', null);

      if (!chatsToClean?.length) return res.json({ deleted: 0 });

      const chatIds = chatsToClean.map(c => c.id);

      const { count } = await supabase
        .from('messages')
        .delete({ count: 'exact' })
        .in('chat_id', chatIds)
        .eq('is_manual', false)
        .lt('created_at', cutoff);

      res.json({ deleted: count || 0, chats: chatIds.length });
    } catch (e) { next(e); }
  },

  async getChats(req, res, next) {
    try {
      const { data, error } = await supabase.from('chats').select('*').order('updated_at', { ascending: false }).limit(100);
      if (error) throw error;
      res.json((data||[]).map(c => ({
        ...c,
        is_manual_mode:    c.is_manual_mode    ?? false,
        last_message:      c.last_message      ?? null,
        last_message_role: c.last_message_role ?? 'user',
        first_name:        c.first_name        ?? c.metadata?.first_name ?? null,
        username:          c.username          ?? c.metadata?.username   ?? null,
      })));
    } catch (e) { next(e); }
  },

  async getChatMessages(req, res, next) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    try {
      const { chatId } = req.params;
      const [chatResult, msgsResult] = await Promise.all([
        supabase.from('chats').select('*').eq('id', chatId).maybeSingle(),
        supabase.from('messages').select('*').eq('chat_id', chatId).order('created_at', { ascending: false }).limit(200)
      ]);
      const chat = chatResult.data;
      let msgs = (msgsResult.data || []).reverse(); 
      if (msgsResult.error) throw msgsResult.error;
      const allMsgs = msgs || [];
      // Chronik: alle Seitenbesuche zeigen, aber identische aufeinanderfolgende
      // Besuche (z.B. mehrfaches Neuladen derselben Seite) zusammenfassen.
      const filtered = [];
      let lastVisitContent = null;
      for (let i = 0; i < allMsgs.length; i++) {
        const m = allMsgs[i];
        const isVisit = m.role === 'system' && (m.content || '').startsWith('📍');
        if (isVisit) {
          if (m.content === lastVisitContent) continue; // identische Folge-Seite überspringen
          lastVisitContent = m.content;
          filtered.push(m);
        } else {
          lastVisitContent = null;
          filtered.push(m);
        }
      }
      res.json({ is_manual: chat?.is_manual_mode ?? false, chat_info: chat || {}, messages: filtered.filter(Boolean) });
    } catch (e) { next(e); }
  },

  async updateChatStatus(req, res, next) {
    try {
      const { is_manual_mode } = req.body;
      const { data, error } = await supabase.from('chats').update({ is_manual_mode, updated_at: new Date() }).eq('id', req.params.chatId).select();
      if (error) throw error;
      res.json(data[0]);
    } catch (e) { next(e); }
  },

  async sendManualMessage(req, res, next) {
    try {
      const { chatId, content } = req.body;
      if (!chatId || !content) return res.status(400).json({ error: 'Fehlende Felder' });
      const { data: chat } = await supabase.from('chats').select('platform').eq('id', chatId).single();
      void (async () => { try { await supabase.from('messages').insert([{ chat_id: chatId, role: 'assistant', content, is_manual: true }]); } catch (_) {} })();
      void (async () => { try { await supabase.from('chats').update({ last_message: content.substring(0,120), last_message_role: 'assistant', updated_at: new Date() }).eq('id', chatId); } catch (_) {} })();
      if (chat?.platform === 'telegram') await telegramService.sendMessage(chatId, content);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async getSettings(req, res, next) {
    try {
      const { data, error } = await supabase.from('settings').select('*').single();
      if (error && error.code !== 'PGRST116') throw error;
      res.json(mergeEnvIntoSettings(data));
    } catch (e) { next(e); }
  },

  async updateSettings(req, res, next) {
    try {
      const body = req.body;
      const coreFields = {
        id:                   1,
        updated_at:           new Date(),
        system_prompt:        body.system_prompt        ?? undefined,
        negative_prompt:      body.negative_prompt      ?? undefined,
        welcome_message:      body.welcome_message      ?? undefined,
        manual_msg_template:  body.manual_msg_template  ?? undefined,
        sellauth_api_key:     body.sellauth_api_key     ?? undefined,
        sellauth_shop_id:     body.sellauth_shop_id     ?? undefined,
        sellauth_shop_url:    body.sellauth_shop_url    ?? undefined,
        webhook_url:          body.webhook_url          ?? undefined,
        ai_model:             body.ai_model             ?? undefined,
        ai_max_tokens:        body.ai_max_tokens        !== undefined ? parseInt(body.ai_max_tokens)    : undefined,
        ai_temperature:       body.ai_temperature       !== undefined ? parseFloat(body.ai_temperature) : undefined,
        rag_threshold:        body.rag_threshold        !== undefined ? parseFloat(body.rag_threshold)  : undefined,
        rag_match_count:      body.rag_match_count      !== undefined ? parseInt(body.rag_match_count)  : undefined,
        coupon_enabled:       body.coupon_enabled       !== undefined ? Boolean(body.coupon_enabled)       : undefined,
        coupon_discount:      body.coupon_discount      !== undefined ? parseInt(body.coupon_discount)     : undefined,
        coupon_type:          body.coupon_type          ?? undefined,
        coupon_description:   body.coupon_description   ?? undefined,
        coupon_max_uses:      body.coupon_max_uses      !== undefined ? parseInt(body.coupon_max_uses)||null: undefined,
        coupon_schedule_hour: body.coupon_schedule_hour !== undefined ? parseInt(body.coupon_schedule_hour): undefined,
        widget_powered_by:    body.widget_powered_by    ?? undefined,
        max_history_msgs:     body.max_history_msgs     !== undefined ? parseInt(body.max_history_msgs)    : undefined,
        summary_interval:     body.summary_interval     !== undefined ? parseInt(body.summary_interval)    : undefined,
        ai_max_input_tokens:  body.ai_max_input_tokens  !== undefined ? parseInt(body.ai_max_input_tokens) : undefined,
      };

      Object.keys(coreFields).forEach(k => coreFields[k] === undefined && delete coreFields[k]);

      const { data, error } = await supabase.from('settings').upsert(coreFields).select();

      if (error) {
        return res.status(500).json({ error: 'Einstellungen konnten nicht gespeichert werden: ' + error.message });
      }

      const { data: fresh } = await supabase.from('settings').select('*').eq('id', 1).single();
      res.json(fresh || data?.[0] || {});
    } catch (e) { next(e); }
  },
  async lookupInvoice(req, res, next) {
    try {
      const { invoiceId } = req.params;
      if (!invoiceId) return res.status(400).json({ error: 'Bestellnummer fehlt' });
      
      const order = await storefrontService.getInvoice(invoiceId);
      if (!order) {
        return res.status(404).json({ error: 'Bestellung nicht gefunden' });
      }
      
      const shopUrl = process.env.STOREFRONT_URL || process.env.SHOP_URL || process.env.SELLAUTH_SHOP_URL || '';
      const checkoutUrl = `${shopUrl.replace(/\/$/, '')}/checkout/${order.id}`;
      
      res.json({
        id: order.id,
        status: order.status,
        price: order.amount_eur,
        currency: 'EUR',
        gateway: order.referred_by_code ? 'Affiliate' : 'Direct',
        products: [{ product: order.tariff_name, variant: order.iccid || null }],
        completed_at: order.payment_confirmed_at || null,
        created_at: order.created_at,
        checkoutUrl
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },

  /** Legt alle eSIM-Kategorien an (idempotent) */
  async setupKbCategories(req, res, next) {
    try {
      const knowledgeEnricher = require('../services/knowledgeEnricher');
      await knowledgeEnricher.ensureEsimCategories();
      const { data: cats } = await supabase.from('knowledge_categories').select('id, name').order('id');
      res.json({ success: true, categories: cats || [], count: (cats || []).length });
    } catch (e) { next(e); }
  },

  /** Push-Diagnose: Web-Push bereit? VAPID gesetzt? Wie viele Subscriptions? */
  async getPushStatus(req, res, next) {
    try {
      const notif = require('../services/notificationService');
      let subCount = 0;
      try {
        const { data } = await supabase.from('admin_subscriptions').select('id');
        subCount = (data || []).length;
      } catch (_) {}
      res.json({
        webPushReady:    notif.isReady ? notif.isReady() : false,
        vapidConfigured: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
        subscriptions:   subCount
      });
    } catch (e) { res.status(500).json({ error: e.message, subscriptions: 0 }); }
  },

  /** Sendet eine Test-Push-Benachrichtigung an alle Admin-Subscriptions */
  async sendTestPush(req, res, next) {
    try {
      const notif = require('../services/notificationService');
      let subCount = 0;
      try {
        const { data: subs } = await supabase.from('admin_subscriptions').select('id');
        subCount = (subs || []).length;
      } catch (_) {}

      if (subCount === 0) {
        return res.json({ success: false, subscriptions: 0, sent: 0,
          error: 'Keine aktive Push-Subscription. Bitte zuerst "Push aktivieren" klicken.' });
      }

      const result = await notif.sendTestNotification();
      res.json({
        success:       true,
        subscriptions: subCount,
        sent:          (result && typeof result.sent === 'number') ? result.sent : 0,
        ready:         !!(result && result.ready)
      });
    } catch (e) {
      res.status(500).json({ success: false, subscriptions: 0, sent: 0, error: e.message });
    }
  },

  /** Liefert den öffentlichen VAPID-Key für Push-Subscription im Browser */
  async getVapidPublicKey(req, res, next) {
    try {
      let key = process.env.VAPID_PUBLIC_KEY || '';
      // URL-safe Base64 ohne Padding (Browser-Anforderung)
      key = key.trim().replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      res.json({ publicKey: key, configured: !!key });
    } catch (e) { res.json({ publicKey: '', configured: false }); }
  },

  /** Generiert neue VAPID-Keys für Web-Push Notifications */
  async generateVapidKeys(req, res, next) {
    try {
      const webpush = require('web-push');
      const keys = webpush.generateVAPIDKeys();
      const isConfigured = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
      res.json({
        publicKey:     keys.publicKey,
        privateKey:    keys.privateKey,
        isConfigured,
        currentStatus: isConfigured
          ? '✅ VAPID bereits konfiguriert – Push aktiv'
          : '❌ VAPID nicht gesetzt – Push deaktiviert',
        instructions: [
          'Diese Keys EINMALIG generieren und in Coolify eintragen:',
          `VAPID_PUBLIC_KEY = ${keys.publicKey}`,
          `VAPID_PRIVATE_KEY = ${keys.privateKey}`,
          'Danach App in Coolify neu starten (Redeploy) → Push-Notifications aktiv'
        ]
      });
    } catch (e) {
      res.status(500).json({ error: `web-push nicht verfügbar: ${e.message}` });
    }
  },

  async getLiveVisitors(req, res, next) {
    try {
      const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      let visitors = [];
      try {
        const { data: _v } = await supabase
          .from('visitor_sessions')
          .select('id, chat_id, last_seen, page_count, entry_page, last_page, is_active')
          .gte('last_seen', since)
          .order('last_seen', { ascending: false })
          .limit(50);
        visitors = _v || [];
      } catch (_) {}

      const chatIds = visitors.map(v => v.chat_id);
      let activities = [];
      if (chatIds.length) {
        try {
          const { data: acts } = await supabase
            .from('visitor_activities')
            .select('chat_id, activity, page_url, created_at')
            .in('chat_id', chatIds)
            .order('created_at', { ascending: false })
            .limit(100);
          activities = acts || [];
        } catch (_) {}
      }

      const result = visitors.map(v => {
        const lastAct = activities.find(a => a.chat_id === v.chat_id);
        return {
          sessionId:   v.id,
          chatId:      v.chat_id,
          lastSeen:    v.last_seen,
          pageCount:   v.page_count,
          currentPage: v.last_page || v.entry_page || lastAct?.activity?.replace('Besucht: ', '') || '?',
          entryPage:   v.entry_page,
          isActive:    v.is_active
        };
      });

      res.json({ live: result.length, visitors: result });
    } catch (e) { next(e); }
  },

  async getTrafficStats(req, res, next) {
    try {
      const { range = 'week' } = req.query;
      const is24h = range === '24h';
      const days  = range === 'month' ? 30 : 7;
      const since = new Date(Date.now() - (is24h ? 86400000 : days * 86400000)).toISOString();

      // Fetch chat_id so we can deduplicate visitors per day/total
      const [sessions, chats, activities] = await Promise.all([
        fetchAll('visitor_sessions', 'chat_id, started_at', q => q.gte('started_at', since)),
        fetchAll('chats', 'created_at, platform', q => q.gte('created_at', since)),
        fetchAll('visitor_activities', 'created_at', q => q.gte('created_at', since))
      ]);

      const buckets = {};
      if (is24h) {
        for (let h = 0; h < 24; h++) {
          const dt = new Date(Date.now() - (23-h)*3600000);
          const key = dt.toISOString().slice(0, 13);
          buckets[key] = { label: dt.getHours()+':00', sessions:0, uniqueVisitors: new Set(), chats:0, pageviews:0 };
        }
        const hk = dt => new Date(dt).toISOString().slice(0, 13);
        sessions.forEach(s   => { const k=hk(s.started_at);  if(buckets[k]){ buckets[k].sessions++; if(s.chat_id) buckets[k].uniqueVisitors.add(s.chat_id); } });
        chats.forEach(ch     => { const k=hk(ch.created_at); if(buckets[k]) buckets[k].chats++;     });
        activities.forEach(a => { const k=hk(a.created_at);  if(buckets[k]) buckets[k].pageviews++; });
      } else {
        for (let d = 0; d < days; d++) {
          const dt = new Date(Date.now() - (days-1-d)*86400000);
          const key = dt.toISOString().slice(0, 10);
          buckets[key] = { label: dt.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'}), sessions:0, uniqueVisitors: new Set(), chats:0, pageviews:0 };
        }
        const dk = dt => new Date(dt).toISOString().slice(0, 10);
        sessions.forEach(s   => { const k=dk(s.started_at);  if(buckets[k]){ buckets[k].sessions++; if(s.chat_id) buckets[k].uniqueVisitors.add(s.chat_id); } });
        chats.forEach(ch     => { const k=dk(ch.created_at); if(buckets[k]) buckets[k].chats++;     });
        activities.forEach(a => { const k=dk(a.created_at);  if(buckets[k]) buckets[k].pageviews++; });
      }

      // Deduplicated total: one chatId = one unique visitor, regardless of session count
      const allUniqueVisitors = new Set(sessions.map(s => s.chat_id).filter(Boolean));

      res.json({
        range,
        days: Object.values(buckets).map(b => ({
          label:    b.label,
          sessions: b.sessions,
          visitors: b.uniqueVisitors.size,
          chats:    b.chats,
          pageviews:b.pageviews
        })),
        totals: {
          visitors:     allUniqueVisitors.size,  // unique (deduplicated)
          sessions:     sessions.length,         // raw session count
          chats:        chats.length,
          pageviews:    activities.length,
          widgetChats:  chats.filter(ch=>ch.platform==='web_widget').length,
          telegramChats:chats.filter(ch=>ch.platform==='telegram').length
        }
      });
    } catch (e) { next(e); }
  },

  async lookupVisitorIp(req, res, next) {
    try {
      const { ip } = req.params;
      if (!ip) return res.status(400).json({ error: 'IP fehlt' });
      const data = await visitorService.lookupIp(decodeURIComponent(ip));
      res.json(data);
    } catch (e) { next(e); }
  },

  async banVisitorIp(req, res, next) {
    try {
      const { ip } = req.params;
      const { reason } = req.body;
      if (!ip) return res.status(400).json({ error: 'IP fehlt' });
      const result = await visitorService.banIp(decodeURIComponent(ip), reason);
      res.json(result);
    } catch (e) { next(e); }
  },

  async getVisitorList(req, res, next) {
    try {
      const { data } = await supabase.from('widget_visitors')
        .select('chat_id, ip, fingerprint, first_seen, last_seen, user_agent')
        .order('last_seen', { ascending: false }).limit(100);
      res.json(data || []);
    } catch (e) {
      // Bei Fehler leere Liste statt 500
      res.json([]);
    }
  },

  async savePushSubscription(req, res, next) {
    try {
      const { subscription } = req.body;
      if (!subscription?.endpoint) return res.status(400).json({ error: 'Ungültige Subscription' });

      // Vorhandene Subscription mit gleichem Endpoint entfernen
      try {
        await supabase.from('admin_subscriptions').delete().eq('endpoint', subscription.endpoint);
      } catch (_) {}

      // Neu speichern — endpoint-Spalte MUSS gesetzt sein (NOT NULL)
      const { error } = await supabase.from('admin_subscriptions').insert([{
        endpoint:          subscription.endpoint,
        subscription_data: subscription,   // JSONB → Objekt direkt
        device_label:      req.headers['user-agent']?.substring(0, 80) || null
      }]);

      if (error) {
        return res.status(500).json({ error: 'Speichern fehlgeschlagen: ' + error.message });
      }
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },

  // ── ÖFFENTLICH: VAPID Public-Key (ist per Definition öffentlich) ──────────
  // Damit der Service Worker den Key OHNE JWT laden kann (SW hat kein localStorage).
  async getPublicVapidKey(req, res) {
    let key = process.env.VAPID_PUBLIC_KEY || '';
    key = key.trim().replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    res.json({ publicKey: key, configured: !!key });
  },

  // ── ÖFFENTLICH: Subscription-Erneuerung durch den Service Worker ──────────
  // Der SW kann kein JWT senden (kein localStorage-Zugriff). Identitätsnachweis
  // ist der ALTE Endpoint: nur wer die bisherige (gültige) Subscription besitzt,
  // darf sie ersetzen. So bleibt Push auch nach Endpoint-Rotation aktiv.
  async renewPushSubscription(req, res) {
    try {
      const { oldEndpoint, subscription } = req.body || {};
      if (!subscription?.endpoint) return res.status(400).json({ error: 'Ungültige Subscription' });

      // Wenn ein alter Endpoint mitgegeben wurde: nur erneuern, wenn er existiert.
      if (oldEndpoint) {
        try {
          const { data: existing } = await supabase.from('admin_subscriptions')
            .select('id').eq('endpoint', oldEndpoint).maybeSingle();
          if (existing) {
            await supabase.from('admin_subscriptions').delete().eq('endpoint', oldEndpoint);
          }
        } catch (_) {}
      }

      // Neuen Endpoint sauber (de-dupliziert) speichern
      try { await supabase.from('admin_subscriptions').delete().eq('endpoint', subscription.endpoint); } catch (_) {}
      const { error } = await supabase.from('admin_subscriptions').insert([{
        endpoint:          subscription.endpoint,
        subscription_data: subscription,
        device_label:      (req.headers['user-agent'] || 'sw-renew').substring(0, 80)
      }]);
      if (error) return res.status(500).json({ error: error.message });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },

  async getSessions(req, res, next) {
    try {
      const { limit = 50 } = req.query;
      const { data } = await supabase
        .from('visitor_sessions')
        .select('id, chat_id, started_at, last_seen, page_count, entry_page, last_page, is_active')
        .order('started_at', { ascending: false })
        .limit(parseInt(limit));
      res.json(data || []);
    } catch (e) { res.json([]); }
  },

  async getCouponSchedule(req, res, next) {
    try {
      const { data, error } = await supabase.from('coupon_schedule').select('*').order('weekday');
      if (error) {
        // Tabelle fehlt/falsch → leere Liste statt 500, Frontend füllt Defaults
        return res.json([]);
      }
      res.json(data || []);
    } catch (e) { res.json([]); }
  },

  async saveCouponSchedule(req, res, next) {
    try {
      const { schedule } = req.body;
      if (!Array.isArray(schedule)) return res.status(400).json({ error: 'schedule muss Array sein' });

      const errors = [];
      let saved = 0;
      for (const s of schedule) {
        if (s.weekday < 0 || s.weekday > 6) continue;
        const { error } = await supabase.from('coupon_schedule').upsert({
          weekday:     s.weekday,
          enabled:     s.enabled !== false,
          discount:    Math.min(Math.max(parseInt(s.discount)||10, 1), 99),
          type:        ['percentage','fixed'].includes(s.type) ? s.type : 'percentage',
          description: (s.description||'').substring(0,200),
          max_uses:    s.max_uses ? parseInt(s.max_uses) : null,
          updated_at:  new Date()
        }, { onConflict: 'weekday' });
        if (error) errors.push(`Tag ${s.weekday}: ${error.message}`);
        else saved++;
      }

      if (errors.length) {
        // Echten Fehler zurückgeben statt stillem "success"
        return res.status(500).json({ error: errors[0], details: errors, saved });
      }
      res.json({ success: true, saved });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },

  async getActiveCoupon(req, res, next) {
    try {
      const couponService = require('../services/couponService');
      const coupon = await couponService.getActiveCoupon();
      res.json(coupon || { active: false });
    } catch (e) { next(e); }
  },

  async createCouponNow(req, res, next) {
    try {
      const couponService = require('../services/couponService');
      // force=true: Coupon manuell erstellen, auch wenn coupon_enabled=false in Settings
      const coupon = await couponService.createDailyCoupon(true);
      if (!coupon) {
        return res.status(400).json({ error: 'Coupon konnte nicht erstellt werden. Sellauth Konfiguration prüfen.' });
      }
      res.json({ success: true, coupon });
    } catch (e) {
      res.status(400).json({ error: `Coupon konnte nicht erstellt werden: ${e.message}` });
    }
  },

  async getCouponHistory(req, res, next) {
    try {
      const { data } = await supabase
        .from('daily_coupons')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(30);
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async setupWebhook(req, res, next) {
    try {
      const { appUrl } = req.body;
      if (!appUrl) return res.status(400).json({ error: 'appUrl fehlt' });

      const result = await telegramService.setWebhook(appUrl);

      if (result.ok) {
        await supabase.from('settings')
          .upsert({ id: 1, webhook_url: appUrl, updated_at: new Date() })
          .catch(e => console.warn('[Webhook] DB-Speicherung fehlgeschlagen:', e.message));
      }

      res.json({ success: result.ok, description: result.description || '' });
    } catch (e) { next(e); }
  },

  async getWebhookInfo(req, res, next) {
    try {
      const info = await telegramService.getWebhookInfo();
      res.json(info.result || info);
    } catch (e) { next(e); }
  },

  // ── Blacklist / Feedbacks / Moderation ──────────────────────────────────────
  async getBlacklist(req, res, next) {
    try {
      const { data, error } = await supabase.from('blacklist').select('*').order('banned_at', { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async getPendingFeedbacks(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('user_feedbacks')
        .select('*')
        .in('status', ['pending', 'collecting_proofs'])
        .order('created_at', { ascending: false });
      if (error) throw error;
      
      // Für Feedbacks mit Proofs die entsprechenden Proofs anhängen
      const result = [];
      for (const fb of (data || [])) {
        if (fb.has_proofs || fb.proof_count > 0) {
          const { data: proofs } = await supabase.from('feedback_proofs').select('*').eq('feedback_id', fb.id);
          fb.proofs = proofs || [];
        } else {
          fb.proofs = [];
        }
        result.push(fb);
      }
      res.json(result);
    } catch (e) { next(e); }
  },

  async approveFeedback(req, res, next) {
    try {
      const { id } = req.params;
      const { data: fbRow } = await supabase.from('user_feedbacks').select('*').eq('id', id).maybeSingle();
      if (!fbRow) return res.status(404).json({ error: 'Feedback nicht gefunden' });

      // Status in DB direkt setzen (Kanal-Verwaltungs-Service nicht verfügbar in diesem Service)
      await supabase.from('user_feedbacks').update({ status: 'approved' }).eq('id', id);

      if (fbRow.target_user_id) {
        const delta = fbRow.feedback_type === 'positive' ? 1 : -10;
        await supabase.rpc('update_user_reputation', {
          p_channel_id: fbRow.channel_id, p_user_id: fbRow.target_user_id,
          p_username: fbRow.target_username, p_delta: delta
        }).catch(() => {});
      }
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async rejectFeedback(req, res, next) {
    try {
      const { id } = req.params;
      await supabase.from('user_feedbacks').update({ status: 'rejected' }).eq('id', id);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async banUser(req, res, next) {
    try {
      const { identifier, chatId, reason, visitorIp } = req.body;
      const targetId = chatId || identifier;
      if (!targetId && !visitorIp) return res.status(400).json({ error: 'Identifikator fehlt' });

      // Echtes blacklist-Schema: chat_id + visitor_ip (kein 'identifier')
      const row = { reason: reason || 'Manueller Bann', banned_by: 'admin' };
      if (targetId)  row.chat_id    = targetId;
      if (visitorIp) row.visitor_ip = visitorIp;

      // IP des Chats mitsperren falls vorhanden (vollständige Sperre)
      if (targetId && !visitorIp) {
        try {
          const { data: c } = await supabase.from('chats').select('visitor_ip').eq('id', targetId).maybeSingle();
          if (c?.visitor_ip) row.visitor_ip = c.visitor_ip;
        } catch (_) {}
      }

      const { data, error } = await supabase.from('blacklist').insert([row]).select();
      if (error) return res.status(500).json({ error: error.message });

      // Chat als gesperrt markieren
      if (targetId) {
        try { await supabase.from('chats').update({ auto_muted: true, is_manual_mode: false, mute_reason: row.reason }).eq('id', targetId); } catch (_) {}
      }
      res.json({ success: true, data: data?.[0] || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },
  async removeBan(req, res, next) {
    try {
      const { error } = await supabase.from('blacklist').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ success: true });
    } catch (e) { next(e); }
  },
  // ── Learning ───────────────────────────────────────────────────────────────
  async getLearningQueue(req, res, next) {
    try {
      const { data, error } = await supabase.from('learning_queue').select('*').eq('status', 'pending').order('created_at', { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch (e) { next(e); }
  },
  async resolveLearning(req, res, next) {
    try {
      const { questionId, adminAnswer } = req.body;
      if (!questionId || !adminAnswer) return res.status(400).json({ error: 'Fehlende Felder' });
      await deepseekService.processLearningResponse(adminAnswer, questionId);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async deleteLearning(req, res, next) {
    try {
      const { error } = await supabase.from('learning_queue').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // ── Abuse / Flagging ───────────────────────────────────────────────────

  async getFlags(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('user_flags').select('*, chats(id, platform, first_name, username, flag_count, auto_muted)')
        .order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async flagChat(req, res, next) {
    try {
      const { chatId, reason } = req.body;
      if (!chatId) return res.status(400).json({ error: 'chatId fehlt' });
      const ad = getAbuseDetector(); if (!ad) return res.status(503).json({ error: 'Abuse-System nicht verfügbar' });
      const result = await ad.banByAdmin(chatId, reason || 'Admin-Bann');
      res.json({ success: true, ...result });
    } catch (e) { next(e); }
  },

  async unflagChat(req, res, next) {
    try {
      const { chatId } = req.params;
      await supabase.from('user_flags').delete().eq('chat_id', chatId);
      await supabase.from('chats').update({ flag_count: 0, auto_muted: false, mute_reason: null, mute_until: null, spam_warn_count: 0 }).eq('id', chatId);
      await supabase.from('blacklist').delete().eq('chat_id', chatId);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async unmuteChat(req, res, next) {
    try {
      const { chatId } = req.params;
      const ad2 = getAbuseDetector(); if (ad2) await ad2.unmute(chatId);
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  async getFlaggedChats(req, res, next) {
    try {
      const { data, error } = await supabase
        .from('chats')
        .select('id, platform, first_name, username, flag_count, auto_muted, mute_reason, updated_at')
        .gt('flag_count', 0)
        .order('flag_count', { ascending: false })
        .limit(50);
      if (error) throw error;
      res.json(data || []);
    } catch (e) { next(e); }
  },

  // ── Knowledge Categories ──────────────────────────────────────────────────
  async getKnowledgeCategories(req, res, next) {
    try {
      const { data, error } = await supabase.from('knowledge_categories').select('*').order('name');
      if (error) { return res.json([]); }
      res.json(data || []);
    } catch (e) { res.json([]); }
  },
  async createKnowledgeCategory(req, res, next) {
    try {
      const { name, color, icon } = req.body;
      if (!name) return res.status(400).json({ error: 'Name fehlt' });
      const { data, error } = await supabase.from('knowledge_categories').insert([{ name, color: color||'#4a9eff', icon: icon||'📌' }]).select();
      if (error) throw error;
      res.json(data[0]);
    } catch (e) { next(e); }
  },
  async deleteKnowledgeCategory(req, res, next) {
    try {
      const { error } = await supabase.from('knowledge_categories').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ success: true });
    } catch (e) { next(e); }
  },

  // ── Knowledge Entries ─────────────────────────────────────────────────────
  async getKnowledgeEntries(req, res, next) {
    try {
      const { category_id } = req.query;
      let q = supabase.from('knowledge_base').select('id, title, content, source_type, source_url, category_id, created_at')
        .order('created_at', { ascending: false }).limit(200);
      if (category_id) q = q.eq('category_id', category_id);
      const { data, error } = await q;
      if (error) throw error;
      let cats = [];
      try { const { data: c } = await supabase.from('knowledge_categories').select('id, name, color, icon'); cats = c||[]; } catch {}
      const catMap = {};
      cats.forEach(c => { catMap[c.id] = c; });
      res.json((data||[]).map(e => ({ ...e, content_preview: (e.content||'').substring(0,200), knowledge_categories: e.category_id ? catMap[e.category_id]||null : null })));
    } catch (e) { next(e); }
  },
  async deleteKnowledgeEntry(req, res, next) {
    try {
      const { error } = await supabase.from('knowledge_base').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ success: true });
    } catch (e) { next(e); }
  },
  async updateKnowledgeEntry(req, res, next) {
    try {
      const { id } = req.params;
      const { title, content, category_id } = req.body;
      if (!content) return res.status(400).json({ error: 'Inhalt fehlt' });
      const embResult = await deepseekService.generateEmbedding(content);
      const embedding = embResult.embedding || embResult;
      const { data, error } = await supabase.from('knowledge_base')
        .update({ title: title || null, content, embedding, category_id: category_id || null, updated_at: new Date() })
        .eq('id', id).select().single();
      if (error) throw error;
      res.json({ success: true, data });
    } catch (e) { next(e); }
  },

  async syncKnowledgeEntry(req, res, next) {
    try {
      const { id } = req.params;
      const { data: entry } = await supabase.from('knowledge_base')
        .select('*').eq('id', id).single();
      if (!entry) return res.status(404).json({ error: 'Eintrag nicht gefunden' });

      const knowledgeEnricher = require('../services/knowledgeEnricher');

      await supabase.from('knowledge_base').delete().eq('id', id);

      let relatedIds = [];
      if (entry.metadata?.product_id) {
        const { data: related } = await supabase.from('knowledge_base')
          .select('id').eq('source', entry.source)
          .filter('metadata->>product_id', 'eq', String(entry.metadata.product_id))
          .neq('id', id);
        relatedIds = (related || []).map(r => r.id);
      }

      const saved = await knowledgeEnricher.enrichAndStore(
        entry.content, entry.source, entry.category_id,
        { ...entry.metadata, synced_at: new Date().toISOString() }
      );

      res.json({ success: true, savedEntries: saved.length, deletedRelated: relatedIds.length });
    } catch (e) { next(e); }
  },

  async getRelatedEntries(req, res, next) {
    try {
      const { id } = req.params;
      const { data: entry } = await supabase.from('knowledge_base')
        .select('source, metadata').eq('id', id).single();
      if (!entry) return res.json([]);

      let query = supabase.from('knowledge_base')
        .select('id, title, content, category_id, source, created_at')
        .eq('source', entry.source).neq('id', id).limit(20);

      if (entry.metadata?.product_id) {
        query = query.filter('metadata->>product_id', 'eq', String(entry.metadata.product_id));
      }
      const { data } = await query;
      res.json(data || []);
    } catch (e) { next(e); }
  },

  async addManualKnowledge(req, res, next) {
    try {
      const { title, content, category_id } = req.body;
      if (!content) return res.status(400).json({ error: 'Inhalt fehlt' });
      const fullContent = title ? `${title}\n${content}` : content;

      const knowledgeEnricher = require('../services/knowledgeEnricher');
      const saved = await knowledgeEnricher.enrichAndStore(
        fullContent, 'manual_entry',
        category_id ? parseInt(category_id) : null,
        { original_title: title || null }
      );

      res.json({ success: true, saved: saved.length, data: saved[0] || null });
    } catch (e) { next(e); }
  },

  // ── Scraper ───────────────────────────────────────────────────────────────
  async discoverLinks(req, res, next) {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: 'URL fehlt' });
      res.json({ links: await scraperService.discoverLinks(url) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },
  async startScraping(req, res, next) {
    try {
      const { urls, category_id } = req.body;
      if (!urls?.length) return res.status(400).json({ error: 'Keine URLs' });
      const scraped = await scraperService.processMultipleUrls(urls);
      let saved = 0;
      const knowledgeEnricher = require('../services/knowledgeEnricher');
      for (const page of scraped) {
        for (const chunk of page.chunks) {
          try {
            const rawContent = `Quelle: ${page.url}\nTitel: ${page.title || ''}\n${chunk}`;
            const entries = await knowledgeEnricher.enrichAndStore(
              rawContent, 'web_scrape',
              category_id ? parseInt(category_id) : null,
              { url: page.url, page_title: page.title }
            );
            saved += entries.length;
          } catch (e) { logger.warn('[Scrape] Chunk fehlgeschlagen:', e.message); }
        }
      }
      res.json({ success: true, savedChunks: saved, processedUrls: scraped.length });
    } catch (e) { next(e); }
  },

  // ── Sellauth ──────────────────────────────────────────────────────────────
  async testSellauthConnection(req, res, next) {
    try {
      const conn = await storefrontService.testConnection();
      if (conn.ok) {
        res.json({ ok: true, shopName: `Lokale DB (${conn.count} Tarife)` });
      } else {
        res.json({ ok: false, error: conn.error });
      }
    } catch (e) { next(e); }
  },
  /** Zeigt whether die DB-Verbindung steht */
  async checkSellauthConfig(req, res, next) {
    try {
      const conn = await storefrontService.testConnection();
      const shopUrl = process.env.STOREFRONT_URL || process.env.SHOP_URL || process.env.SELLAUTH_SHOP_URL || '';
      res.json({
        apiKey:  conn.ok ? `✅ Aktiv (${conn.count} Tarife gefunden)` : `❌ Verbindung fehlgeschlagen: ${conn.error}`,
        shopId:  process.env.DATABASE_URL ? '✅ DATABASE_URL konfiguriert' : '❌ DATABASE_URL fehlt in Coolify',
        shopUrl: shopUrl ? `✅ ${shopUrl}` : '⚠️ STOREFRONT_URL nicht gesetzt (optional)',
        ready:   conn.ok,
        source: {
          apiKey:  process.env.DATABASE_URL ? 'ENV' : 'missing',
          shopId:  process.env.DATABASE_URL ? 'ENV' : 'missing',
          shopUrl: (process.env.STOREFRONT_URL || process.env.SHOP_URL || process.env.SELLAUTH_SHOP_URL) ? 'ENV' : 'missing',
        }
      });
    } catch (e) { next(e); }
  },

  async syncSellauth(req, res, next) {
    try {
      const shopUrl = process.env.STOREFRONT_URL || process.env.SHOP_URL || process.env.SELLAUTH_SHOP_URL || '';

      const jobId = syncJobManager.createJob();
      res.json({ success: true, jobId, message: 'Sync gestartet' });

      setImmediate(async () => {
        try {
          const results = await storefrontService.syncToKnowledgeBase(shopUrl, jobId);
          syncJobManager.finishJob(jobId, results);
        } catch (err) {
          syncJobManager.failJob(jobId, err.message);
        }
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },

  async getSyncStatus(req, res, next) {
    try {
      const job = syncJobManager.getJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job nicht gefunden oder abgelaufen' });
      res.json(job);
    } catch (e) { next(e); }
  },
  async previewSellauthProducts(req, res, next) {
    try {
      const tariffs = await storefrontService.getAllTariffs();
      const shopUrl = process.env.STOREFRONT_URL || process.env.SHOP_URL || process.env.SELLAUTH_SHOP_URL || '';
      res.json({
        products: tariffs.map(t => ({
          id: t.id,
          name: t.name,
          type: t.tariff_type || 'travel',
          price: t.sale_price_eur,
          currency: 'EUR',
          stock: -1,
          url: shopUrl ? `${shopUrl.replace(/\/$/, '')}/tariffs?q=${encodeURIComponent(t.slug)}` : (t.slug || ''),
          variants: 0,
          visibility: t.is_active ? 'visible' : 'hidden'
        })),
        total: tariffs.length
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },

  async updateNotificationSettings(req, res, next) {
    try {
      const { notify_new_chat, notify_every_msg } = req.body;
      await supabase.from('settings').upsert({
        id: 1,
        notify_new_chat:  notify_new_chat  !== undefined ? Boolean(notify_new_chat)  : true,
        notify_every_msg: notify_every_msg !== undefined ? Boolean(notify_every_msg) : false,
        updated_at: new Date()
      });
      res.json({ success: true });
    } catch (e) { next(e); }
  }
};

module.exports = adminController;
