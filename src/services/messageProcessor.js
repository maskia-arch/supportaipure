const supabase            = require('../config/supabase');
const deepseekService     = require('./deepseekService');
const telegramService     = require('./telegramService');
const embeddingService    = require('./embeddingService');
const notificationService = require('./notificationService');
const abuseDetector       = require('./abuseDetector');
const couponService       = require('./couponService');
const clarityDetector     = require('./ai/clarityDetector');
const logger              = require('../utils/logger');

let _settingsCache     = null;
let _settingsCacheTime = 0;
const CACHE_TTL        = 30_000;

const messageProcessor = {

  async handle({ platform, chatId, text, metadata = {} }) {
    const t0 = Date.now();
    const threadId = metadata?.message_thread_id || null;
    const botToken = metadata?.token || null;

    const [chat, settings] = await Promise.all([
      this._getOrCreateChat(chatId, platform, metadata),
      this._loadSettings()
    ]);
    if (!chat) return null;

    const isFirstMessage = !chat._existed;

    // ── /cancel Command (Bricht laufende Abfragen ab) ─────────────────────────
    if (text && text.trim().toLowerCase() === '/cancel') {
      if (chat.metadata && chat.metadata.waiting_for_order_id) {
        const updatedMetadata = { ...chat.metadata, waiting_for_order_id: false };
        try {
          await supabase.from('chats').update({ metadata: updatedMetadata }).eq('id', chat.id);
        } catch (e) {}
        
        const cancelReply = 'Vorgang abgebrochen. Wie kann ich dir sonst helfen?';
        void (async () => {
          try { await supabase.from('messages').insert([{ chat_id: chat.id, role: 'assistant', content: cancelReply }]); } catch (_) {}
        })();
        this._updateChatPreview(chat.id, cancelReply, 'assistant');
        if (platform === 'telegram') {
          await telegramService.sendMessage(chatId, cancelReply, {
            message_thread_id: threadId,
            token: botToken
          }).catch(() => {});
        }
        return cancelReply;
      }
    }

    // ── Order-Abfrage Wizard (Falls der User auf die Abfrage antwortet) ───────
    if (text && chat.metadata && chat.metadata.waiting_for_order_id) {
      const trimmedText = text.trim();
      const ID_PATTERN = '([a-f0-9\\-]+|[0-9]+)';
      const matchesPattern = new RegExp('^' + ID_PATTERN + '$', 'i').test(trimmedText);

      if (matchesPattern) {
        const invoiceId = trimmedText;
        let orderReply;
        try {
          const storefrontService = require('./storefrontService');
          const shopUrl = process.env.STOREFRONT_URL || process.env.SHOP_URL || process.env.SELLAUTH_SHOP_URL || '';
          const order = await storefrontService.getInvoice(invoiceId);
          if (!order) {
            orderReply = 'Es wurde keine Bestellung mit dieser Bestellnummer oder ICCID gefunden.';
          } else {
            orderReply = storefrontService.formatInvoiceForCustomer(order, shopUrl);
          }
        } catch (err) {
          logger.warn(`[/order Wizard] ${err.message}`);
          orderReply = 'Fehler bei der Abfrage. Bitte überprüfe deine Bestellnummer oder wende dich an den Support.';
        }

        const updatedMetadata = { ...chat.metadata, waiting_for_order_id: false };
        try {
          await supabase.from('chats').update({ metadata: updatedMetadata }).eq('id', chat.id);
        } catch (e) {}

        void (async () => {
          try {
            await supabase.from('messages').insert([{ chat_id: chat.id, role: 'user', content: text }]);
            await supabase.from('messages').insert([{ chat_id: chat.id, role: 'assistant', content: orderReply }]);
          } catch (_) {}
        })();
        this._updateChatPreview(chat.id, orderReply, 'assistant');

        if (platform === 'telegram') {
          await telegramService.sendMessage(chatId, orderReply, {
            message_thread_id: threadId,
            token: botToken,
            parse_mode: 'HTML'
          }).catch(() => {});
        }
        return orderReply;
      } else {
        const errorReply = 'Das eingegebene Format scheint ungültig zu sein. Bitte sende mir eine gültige Bestellungs-ID (z. B. <code>abcde12345-0000000000001</code>) oder schreibe /cancel, um abzubrechen.';
        void (async () => {
          try {
            await supabase.from('messages').insert([{ chat_id: chat.id, role: 'user', content: text }]);
            await supabase.from('messages').insert([{ chat_id: chat.id, role: 'assistant', content: errorReply }]);
          } catch (_) {}
        })();
        this._updateChatPreview(chat.id, errorReply, 'assistant');

        if (platform === 'telegram') {
          await telegramService.sendMessage(chatId, errorReply, {
            message_thread_id: threadId,
            token: botToken,
            parse_mode: 'HTML'
          }).catch(() => {});
        }
        return errorReply;
      }
    }

    // ── /order Command ohne Parameter (Wizard starten) ────────────────────────
    if (text && text.trim().toLowerCase() === '/order') {
      const updatedMetadata = { ...chat.metadata, waiting_for_order_id: true };
      try {
        await supabase.from('chats').update({ metadata: updatedMetadata }).eq('id', chat.id);
      } catch (e) {}

      const promptReply = 'Bitte sende mir deine Bestellungs-ID (z. B. <code>abcde12345-0000000000001</code>), damit ich den Status deiner Bestellung prüfen kann. (Schreibe /cancel, um abzubrechen).';
      void (async () => {
        try { await supabase.from('messages').insert([{ chat_id: chat.id, role: 'assistant', content: promptReply }]); } catch (_) {}
      })();
      this._updateChatPreview(chat.id, promptReply, 'assistant');

      if (platform === 'telegram') {
        await telegramService.sendMessage(chatId, promptReply, {
          message_thread_id: threadId,
          token: botToken,
          parse_mode: 'HTML'
        }).catch(() => {});
      }
      return promptReply;
    }

    // ── Standalone ID Erkennung (Automatische Abfrage bei passendem Muster) ────
    if (text) {
      const STANDALONE_ID_REGEX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|89[0-9]{10,18})$/i;
      if (STANDALONE_ID_REGEX.test(text.trim())) {
        const invoiceId = text.trim();
        let orderReply;
        try {
          const storefrontService = require('./storefrontService');
          const shopUrl = process.env.STOREFRONT_URL || process.env.SHOP_URL || process.env.SELLAUTH_SHOP_URL || '';
          const order = await storefrontService.getInvoice(invoiceId);
          if (!order) {
            orderReply = 'Es wurde keine Bestellung mit dieser Bestellnummer oder ICCID gefunden.';
          } else {
            orderReply = storefrontService.formatInvoiceForCustomer(order, shopUrl);
          }
        } catch (err) {
          logger.warn(`[Standalone ID Lookup] ${err.message}`);
          orderReply = 'Fehler bei der Abfrage. Bitte überprüfe deine Bestellnummer oder wende dich an den Support.';
        }

        void (async () => {
          try {
            await supabase.from('messages').insert([{ chat_id: chat.id, role: 'user', content: text }]);
            await supabase.from('messages').insert([{ chat_id: chat.id, role: 'assistant', content: orderReply }]);
          } catch (_) {}
        })();
        this._updateChatPreview(chat.id, orderReply, 'assistant');

        if (platform === 'telegram') {
          await telegramService.sendMessage(chatId, orderReply, {
            message_thread_id: threadId,
            token: botToken,
            parse_mode: 'HTML'
          }).catch(() => {});
        }
        return orderReply;
      }
    }

    // ── Faire Spam-Prüfung MIT Warnungen (nach Chat-Erstellung) ────────────
    // Liefert action + Nachricht. Es wird NIE still blockiert ohne Meldung.
    // metadata (ip, fingerprint) wird für vollständige Sperre übergeben.
    const abuse = await abuseDetector.check(chatId, text, {
      ip: metadata?.ip || null,
      fingerprint: metadata?.fingerprint || null
    });
    if (abuse.action !== 'allow') {
      // User-Nachricht protokollieren (damit Dashboard den Verlauf sieht)
      void (async () => {
        try { await supabase.from('messages').insert([{ chat_id: chat.id, role: 'user', content: text }]); } catch (_) {}
      })();
      this._updateChatPreview(chat.id, text, 'user');

      // Warnung/Hinweis an den User senden (Widget + Telegram) — CACHED, keine AI-Tokens
      if (abuse.message) {
        if (platform === 'telegram') {
          await telegramService.sendMessage(chatId, abuse.message, {
            message_thread_id: threadId, token: botToken
          }).catch(() => {});
        }
        void (async () => {
          try { await supabase.from('messages').insert([{ chat_id: chat.id, role: 'assistant', content: abuse.message }]); } catch (_) {}
        })();
        this._updateChatPreview(chat.id, abuse.message, 'assistant');
      }
      return platform === 'web_widget' ? (abuse.message || null) : null;
    }

    // ── Wunsch nach menschlichem Mitarbeiter → KI deaktivieren + Push ──────
    if (text && this._wantsHuman(text) && !chat.is_manual_mode) {
      try { await supabase.from('chats').update({ is_manual_mode: true, status: 'manual', manual_mode_started_at: new Date() }).eq('id', chatId); } catch (_) {}

      const handoffMsg = 'Einen Moment — ich verbinde dich mit einem menschlichen Mitarbeiter. '
        + 'Bitte schreibe deine Frage, sie wird schnellstmöglich persönlich beantwortet.\n\n'
        + 'One moment — I am connecting you with a human agent. Please write your question, it will be answered personally as soon as possible.';

      void (async () => {
        try { await supabase.from('messages').insert([{ chat_id: chat.id, role: 'user', content: text }]); } catch (_) {}
        try { await supabase.from('messages').insert([{ chat_id: chat.id, role: 'assistant', content: handoffMsg }]); } catch (_) {}
      })();
      this._updateChatPreview(chat.id, text, 'user');

      // Push an Admin: Mitarbeiter angefordert
      void notificationService.notifyHumanRequest({
        chatId,
        firstName: chat.first_name || metadata?.first_name || null,
        platform,
        text
      }).catch(() => {});

      if (platform === 'telegram') {
        await telegramService.sendMessage(chatId, handoffMsg, { message_thread_id: threadId, token: botToken }).catch(() => {});
      }
      return platform === 'web_widget' ? handoffMsg : null;
    }

    void (async () => {
      try {
        await supabase.from('messages').insert([{ chat_id: chat.id, role: 'user', content: text }]);
      } catch (e) {}
    })();

    this._updateChatPreview(chat.id, text, 'user');

    if (chat.is_manual_mode) return null;

    // ── /order Handler: direkter Invoice-Lookup vor AI-Call ────────────────
    // Wenn User schreibt "/order INVOICE_ID" oder "bestellung INVOICE_ID",
    // wird die Bestellung direkt via sellauth abgefragt — keine AI-Tokens
    // verbraucht und der Berater muss nicht raten.
    if (text) {
      const ID_PATTERN = '([a-f0-9\\-]+|[0-9]+)';
      const orderMatch =
        text.match(new RegExp('^\\/order\\s+' + ID_PATTERN, 'i')) ||
        text.match(new RegExp('(?:bestellung|invoice|order|rechnung)[:\\s#]+' + ID_PATTERN, 'i'));
      if (orderMatch) {
        const invoiceId = orderMatch[1];
        let orderReply;
        try {
          const storefrontService = require('./storefrontService');
          const shopUrl = process.env.STOREFRONT_URL || process.env.SHOP_URL || process.env.SELLAUTH_SHOP_URL || '';
          const order = await storefrontService.getInvoice(invoiceId);
          if (!order) {
            orderReply = 'Es wurde keine Bestellung mit dieser Bestellnummer oder ICCID gefunden.';
          } else {
            orderReply = storefrontService.formatInvoiceForCustomer(order, shopUrl);
          }
        } catch (err) {
          logger.warn(`[/order] ${err.message}`);
          orderReply = 'Fehler bei der Abfrage. Bitte überprüfe deine Bestellnummer.';
        }
        // Antwort in DB loggen + Vorschau updaten
        void (async () => {
          try {
            await supabase.from('messages').insert([{ chat_id: chat.id, role: 'assistant', content: orderReply }]);
          } catch (_) {}
        })();
        this._updateChatPreview(chat.id, orderReply, 'assistant');
        // Telegram: direkt im Chat senden (für Web-Widget: via return)
        if (platform === 'telegram') {
          await telegramService.sendMessage(chatId, orderReply, {
            message_thread_id: threadId,
            token: botToken,
            parse_mode: 'HTML'
          }).catch(() => {});
        }
        return orderReply;
      }
    }

    if (platform === 'telegram') {
      telegramService.sendTypingAction(chatId, { 
        message_thread_id: threadId,
        token: botToken 
      }).catch(() => {});
    }

    const maxHistory     = parseInt(settings.max_history_msgs)  || 4;
    const summaryInterval = parseInt(settings.summary_interval) || 5;

    const [context, allHistory, chatData] = await Promise.all([
      this._searchKnowledge(text, settings),
      supabase.from('messages').select('role, content')
        .eq('chat_id', chat.id)
        .neq('role', 'system')
        .order('created_at', { ascending: false })
        .limit(20)
        .then(r => (r.data || []).reverse()),
      supabase.from('chats').select('chat_summary').eq('id', chat.id).maybeSingle().then(r => r.data || {})
    ]);

    const recentHistory = allHistory.slice(-maxHistory);
    const chatSummary   = chatData.chat_summary || null;

    const COUPON_KEYWORDS = /rabatt|coupon|gutschein|code|angebot|deal/i;
    let couponContext = null;
    let recentHistoryForAI = recentHistory;

    if (COUPON_KEYWORDS.test(text)) {
      try {
        const activeCoupon = await couponService.getActiveCouponFresh();
        if (activeCoupon) {
          couponContext = `AKTUELLER COUPON: Code "${activeCoupon.code}" - ${activeCoupon.description}.`;
        }
      } catch (e) {}
    }

    const dateContext = `HEUTIGES DATUM: ${new Date().toLocaleDateString('de-DE')}`;
    const fullSummary = [chatSummary, dateContext, couponContext].filter(Boolean).join('\n\n') || null;

    let aiResult;
    try {
      aiResult = await deepseekService.generateResponse(text, recentHistoryForAI, context, chat.id, settings, fullSummary);
    } catch (aiErr) {
      // Sollte durch den neuen deepseekService nicht mehr passieren,
      // aber als letzter Fallback für unvorhergesehene Fehler:
      logger.error(`[MP] Unerwarteter Fehler bei generateResponse: ${aiErr.message}`);
      aiResult = { text: null };
    }

    // text === null bedeutet: API war auch nach mehreren Versuchen nicht erreichbar.
    const replyText = aiResult?.text || null;

    // Plattform-spezifische Ausgabe-Sanitisierung
    let sanitizedReply = replyText ? this._sanitizeReply(replyText, platform) : null;
    const aiFailed = !sanitizedReply || !sanitizedReply.trim();

    // KI lieferte keine Antwort → freundliche Fallback-Nachricht statt leerer Blase /
    // gar keiner Antwort. So bleibt der Nutzer NIE ohne Rückmeldung.
    if (aiFailed) {
      sanitizedReply = 'Entschuldige, gerade gab es ein kurzes technisches Problem auf meiner Seite. '
        + 'Bitte sende deine Nachricht gleich noch einmal — dann helfe ich dir sofort weiter. 🙏\n\n'
        + 'Sorry, there was a brief technical issue on my side. Please send your message again in a moment. 🙏';
      logger.warn(`[MP] Fallback-Antwort gesendet (KI lieferte keine Antwort, Grund: ${aiResult?.error || 'unbekannt'}) für ${chatId}`);
    }

    if (platform === 'telegram') {
      await this._sendReliable(chatId, sanitizedReply, 3, threadId, botToken);
    }

    // Push-Benachrichtigung an Admin (auch bei Fallback, damit du eingreifen kannst)
    void notificationService.sendNewMessageNotification({
      chatId,
      text,
      firstName: chat.first_name || metadata?.first_name || null,
      platform,
      isFirstMessage
    }).catch(() => {});

    // Nur echte Inhalte protokollieren — NIE eine leere Nachricht speichern
    void (async () => {
      if (!sanitizedReply || !sanitizedReply.trim()) return;
      try {
        await supabase.from('messages').insert([{
          chat_id: chat.id, role: 'assistant', content: sanitizedReply,
          prompt_tokens: aiResult?.promptTokens || 0,
          completion_tokens: aiResult?.completionTokens || 0
        }]);
      } catch (e) {}
    })();

    this._updateChatPreview(chat.id, sanitizedReply, 'assistant');

    return sanitizedReply;
  },

  // ── Erkennt Wunsch nach menschlichem Mitarbeiter (mehrsprachig) ────────
  _wantsHuman(text) {
    const t = (text || '').toLowerCase();
    return /\b(mitarbeiter|mensch(en|lich)?|echte[rn]?\s*(person|mensch)|kein\s*bot|berater\s*sprechen|mit\s*jemandem\s*sprechen|support\s*team|kundendienst|kundenservice|real\s*(person|human|agent)|human\s*(agent|support|please)|talk\s*to\s*(a|an)?\s*(human|person|agent|someone)|speak\s*to\s*(a|an)?\s*(human|person|agent)|live\s*(agent|support|chat)|customer\s*service)\b/i.test(t);
  },

  async _searchKnowledge(query, settings) {
    try {
      // Query mit englischen Ländernamen anreichern (Produkte heißen englisch:
      // "Germany Travel eSim" → Nutzer schreibt "Deutschland"). Stark verbessert Treffer.
      const augmented = this._augmentQuery(query);

      const embResult = await embeddingService.createEmbedding(augmented);
      if (!embResult?.embedding) {
        logger.warn('[RAG] Query-Embedding fehlgeschlagen — kein Kontext');
        return [];
      }
      const vector   = embResult.embedding;
      const maxCount = parseInt(settings.rag_match_count) || 8;

      // Threshold deckeln: hohe Werte (0.45) filtern relevante/cross-language Treffer weg.
      // text-embedding-3-small liefert für gute Treffer oft nur 0.3–0.5.
      let threshold = parseFloat(settings.rag_threshold);
      if (!threshold || isNaN(threshold)) threshold = 0.3;
      threshold = Math.min(threshold, 0.35);

      let { data, error } = await supabase.rpc('match_knowledge', {
        query_embedding: vector, match_threshold: threshold, match_count: maxCount
      });
      if (error) logger.error(`[RAG] match_knowledge Fehler: ${error.message}`);

      // Fallback: nichts über Threshold → Top-Treffer mit niedrigem Floor holen,
      // damit die KI IMMER den relevantesten Kontext bekommt (nie fälschlich "kein Angebot").
      if (!data || data.length === 0) {
        const r2 = await supabase.rpc('match_knowledge', {
          query_embedding: vector, match_threshold: 0.05, match_count: maxCount
        });
        if (r2.error) logger.error(`[RAG] Fallback-Fehler: ${r2.error.message}`);
        data = r2.data || [];

        if (data.length === 0) {
          // Diagnose: existieren überhaupt Embeddings in der KB?
          try {
            const { count } = await supabase.from('knowledge_base')
              .select('id', { count: 'exact', head: true })
              .not('embedding', 'is', null).eq('is_active', true);
            logger.warn(`[RAG] 0 Treffer für "${query}". Aktive KB-Einträge mit Embedding: ${count ?? '?'}`);
          } catch (_) {}
        } else {
          logger.info(`[RAG] Fallback: ${data.length} Treffer für "${query}", beste Similarity ${(data[0].similarity||0).toFixed(3)}`);
        }
      } else {
        logger.info(`[RAG] ${data.length} Treffer für "${query}", beste Similarity ${(data[0].similarity||0).toFixed(3)}`);
      }

      return data || [];
    } catch (err) {
      logger.error(`[RAG] Suche fehlgeschlagen: ${err.message}`);
      return [];
    }
  },

  // Reichert die Suchanfrage mit englischen Ländernamen an, da Produkte englisch
  // benannt sind ("Germany Travel eSim"), Nutzer aber oft deutsch schreiben.
  _augmentQuery(query) {
    const q = (query || '').toLowerCase();
    const MAP = {
      'deutschland': 'Germany', 'türkei': 'Turkey', 'tuerkei': 'Turkey',
      'frankreich': 'France', 'spanien': 'Spain', 'italien': 'Italy',
      'griechenland': 'Greece', 'großbritannien': 'United Kingdom UK',
      'grossbritannien': 'United Kingdom UK', 'england': 'United Kingdom UK',
      'vereinigtes königreich': 'United Kingdom UK', 'usa': 'United States USA',
      'vereinigte staaten': 'United States USA', 'amerika': 'United States USA',
      'niederlande': 'Netherlands', 'holland': 'Netherlands',
      'österreich': 'Austria', 'oesterreich': 'Austria', 'schweiz': 'Switzerland',
      'polen': 'Poland', 'portugal': 'Portugal', 'ägypten': 'Egypt', 'aegypten': 'Egypt',
      'marokko': 'Morocco', 'thailand': 'Thailand', 'japan': 'Japan', 'china': 'China',
      'dubai': 'United Arab Emirates UAE Dubai',
      'vereinigte arabische emirate': 'United Arab Emirates UAE',
      'emirate': 'United Arab Emirates UAE', 'kroatien': 'Croatia',
      'tunesien': 'Tunisia', 'mexiko': 'Mexico', 'brasilien': 'Brazil',
      'indien': 'India', 'russland': 'Russia', 'kanada': 'Canada',
      'australien': 'Australia', 'belgien': 'Belgium', 'schweden': 'Sweden',
      'norwegen': 'Norway', 'dänemark': 'Denmark', 'daenemark': 'Denmark',
      'finnland': 'Finland', 'ungarn': 'Hungary', 'tschechien': 'Czech Republic',
      'irland': 'Ireland', 'rumänien': 'Romania', 'rumaenien': 'Romania',
      'bulgarien': 'Bulgaria', 'serbien': 'Serbia', 'südkorea': 'South Korea',
      'suedkorea': 'South Korea', 'korea': 'Korea', 'vietnam': 'Vietnam',
      'indonesien': 'Indonesia', 'malaysia': 'Malaysia', 'singapur': 'Singapore',
      'philippinen': 'Philippines', 'südafrika': 'South Africa', 'suedafrika': 'South Africa',
      'saudi-arabien': 'Saudi Arabia', 'israel': 'Israel', 'katar': 'Qatar',
      'europa': 'Europe', 'asien': 'Asia',
    };
    const adds = [];
    for (const de in MAP) { if (q.includes(de)) adds.push(MAP[de]); }
    return adds.length ? `${query} ${adds.join(' ')}` : query;
  },

  async _loadSettings() {
    const now = Date.now();
    if (_settingsCache && (now - _settingsCacheTime) < CACHE_TTL) return _settingsCache;
    try {
      const { data } = await supabase.from('settings').select('*').single();
      _settingsCache = {
        system_prompt: data?.system_prompt || 'Du bist ein Assistent.',
        ai_model: data?.ai_model || 'deepseek-chat',
        ai_max_tokens: data?.ai_max_tokens || 1024,
        ai_temperature: data?.ai_temperature || 0.5,
        rag_threshold: data?.rag_threshold || 0.3,
        rag_match_count: data?.rag_match_count || 8,
        max_history_msgs: data?.max_history_msgs || 4,
        summary_interval: data?.summary_interval || 5,
      };
      _settingsCacheTime = now;
      return _settingsCache;
    } catch {
      return { system_prompt: 'Assistent', ai_model: 'deepseek-chat', max_history_msgs: 4 };
    }
  },

  _pendingDeliveries: new Map(),

  /**
   * Bereinigt LLM-Ausgabe je nach Ziel-Plattform.
   * - telegram:    Markdown bleibt drin (markdownToHtml im telegramService wandelt es um).
   *                Aber unvollständige Markdown-Reste werden bereinigt.
   * - web_widget:  Markdown bleibt drin (Widget rendert HTML).
   * - andere:      Plain-Text — alle Markdown-Zeichen werden entfernt.
   */
  _sanitizeReply(text, platform) {
    if (!text) return text;
    let t = String(text);

    // Plattform-übergreifend: häufige LLM-Artefakte entfernen
    // [UNKLAR]-Marker am Anfang entfernen (intern, nicht für User)
    t = t.replace(/^\s*\[UNKLAR\]\s*/i, '');

    // Unvollständige Markdown-Sterne (** ohne Schluss-Paar) reparieren
    // Zähle ** Vorkommen: ungerade Anzahl → letztes ** entfernen
    const doubleStarCount = (t.match(/\*\*/g) || []).length;
    if (doubleStarCount % 2 !== 0) {
      // Ungerade Anzahl: das letzte ** entfernen
      const lastIdx = t.lastIndexOf('**');
      if (lastIdx >= 0) t = t.substring(0, lastIdx) + t.substring(lastIdx + 2);
    }

    // Markdown-Tabellen (die im Plain-Text kacken aussehen) bereinigen
    t = t.replace(/^\|[-:|\s]+\|\s*$/gm, ''); // Tabellen-Trenner-Zeile entfernen

    if (platform === 'telegram' || platform === 'web_widget') {
      // Markdown bleibt — wird von markdownToHtml/Widget gerendert
      return t.trim();
    }

    // Andere Plattformen: alles Markdown entfernen
    t = t
      .replace(/\*\*\*(.+?)\*\*\*/gs, '$1')   // ***bold-italic***
      .replace(/\*\*(.+?)\*\*/gs, '$1')        // **bold**
      .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '$1')  // *italic*
      .replace(/(?<=\s|^)_([^_\n]+?)_(?=\s|$|[.,!?;:])/gm, '$1') // _italic_
      .replace(/~~(.+?)~~/g, '$1')             // ~~strike~~
      .replace(/`([^`\n]+)`/g, '$1')           // `code`
      .replace(/^#{1,6}\s+/gm, '')             // # Header
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)'); // [text](url) → text (url)

    return t.trim();
  },

  async _sendReliable(chatId, text, maxAttempts = 3, threadId = null, token = null) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await telegramService.sendMessage(chatId, text, { 
          message_thread_id: threadId,
          token: token 
        });
        return;
      } catch (e) {
        if (attempt === maxAttempts) logger.error(`[MP] Zustellung fehlgeschlagen: ${chatId}`);
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }
  },

  _updateChatPreview(chatId, message, role) {
    void (async () => {
      try {
        await supabase.from('chats').update({
          last_message: (message || '').substring(0, 120),
          last_message_role: role,
          updated_at: new Date()
        }).eq('id', chatId);
      } catch (_) {}
    })();
  },

  async _getOrCreateChat(chatId, platform, metadata) {
    try {
      const { data: existing } = await supabase.from('chats').select('*').eq('id', chatId).maybeSingle();
      if (existing) return { ...existing, _existed: true };

      const ins = { id: chatId, platform, first_name: metadata?.first_name || 'Nutzer', username: metadata?.username || null };
      const { data: created } = await supabase.from('chats').insert([ins]).select().single();
      return { ...(created || { id: chatId }), _existed: false };
    } catch (err) {
      return { id: chatId, _existed: false };
    }
  }
};

module.exports = messageProcessor;
