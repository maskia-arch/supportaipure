const axios = require('axios');
const { telegram } = require('../config/env');
const { markdownToHtml, splitHtmlMessage } = require('../utils/telegramFormatter');

const TG_MAX = 4000;

const telegramService = {

  async sendMessage(chatId, text, options = {}) {
    if (!text || !chatId) return null;
    const html  = markdownToHtml(String(text));
    const parts = splitHtmlMessage(html, TG_MAX);
    const token = options.token || telegram.token;

    for (const part of parts) {
      const ok = await this._send(chatId, part, token, options.message_thread_id);
      if (!ok) break;
      // Kleines Delay zwischen Chunks um Rate-Limit zu vermeiden
      if (parts.length > 1) await new Promise(r => setTimeout(r, 300));
    }
    return true;
  },

  async _send(chatId, text, token, threadId = null) {
    try {
      const payload = {
        chat_id:    chatId,
        text:       text,
        parse_mode: 'HTML',                    // ← immer HTML
        disable_web_page_preview: true         // ← keine Link-Previews
      };
      if (threadId) payload.message_thread_id = threadId;
      await axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        payload,
        { timeout: 15000 }
      );
      return true;
    } catch (err) {
      const st   = err.response?.status;
      const desc = err.response?.data?.description || err.message;
      if (st === 403) return false;  // Bot aus Gruppe entfernt

      // Bei HTML-Parse-Fehler: als Fallback ohne parse_mode nochmal senden
      if (st === 400 && desc?.includes('can\'t parse entities')) {
        try {
          const plainPayload = { chat_id: chatId, text: _stripHtmlTags(text) };
          if (threadId) plainPayload.message_thread_id = threadId;
          await axios.post(
            `https://api.telegram.org/bot${token}/sendMessage`,
            plainPayload,
            { timeout: 15000 }
          );
          return true;
        } catch (_) { return false; }
      }

      console.error(`[Telegram] sendMessage Fehler: ${desc}`);
      return false;
    }
  },

  // _stripHtmlTags: Fallback wenn Telegram parse_mode HTML ablehnt
  _stripHtmlTags(html) {
    return (html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
  },

  async sendTypingAction(chatId, options = {}) {
    const token = options.token || telegram.token;
    try {
      const payload = { chat_id: chatId, action: 'typing' };
      if (options.message_thread_id) payload.message_thread_id = options.message_thread_id;
      await axios.post(
        `https://api.telegram.org/bot${token}/sendChatAction`,
        payload,
        { timeout: 5000 }
      );
    } catch (_) {}
  },

  async setWebhook(appUrl, token = null) {
    const botToken = token || telegram.token;
    if (!botToken) return { ok: false, description: 'Kein Bot-Token konfiguriert.' };
    try {
      const webhookUrl = `${appUrl.replace(/\/$/, '')}/api/webhooks/telegram`;
      const response = await axios.post(
        `https://api.telegram.org/bot${botToken}/setWebhook`,
        {
          url: webhookUrl,
          allowed_updates: ['message','callback_query','my_chat_member','channel_post','chat_join_request'],
          drop_pending_updates: false
        },
        { timeout: 10000 }
      );
      return response.data || { ok: false };
    } catch (err) {
      const desc = err.response?.data?.description || err.message;
      console.error(`[Telegram] setWebhook Error: ${desc}`);
      return { ok: false, description: desc };
    }
  },

  async getWebhookInfo(token = null) {
    const botToken = token || telegram.token;
    if (!botToken) return { result: { url: '', last_error_message: 'Kein Token.' } };
    try {
      const response = await axios.get(
        `https://api.telegram.org/bot${botToken}/getWebhookInfo`,
        { timeout: 8000 }
      );
      return response.data || {};
    } catch (err) {
      const desc = err.response?.data?.description || err.message;
      console.error(`[Telegram] getWebhookInfo Error: ${desc}`);
      return { result: { url: '', last_error_message: desc } };
    }
  },

  async deleteWebhook(token = null) {
    const botToken = token || telegram.token;
    if (!botToken) return { ok: false, description: 'Kein Token.' };
    try {
      const response = await axios.post(
        `https://api.telegram.org/bot${botToken}/deleteWebhook`,
        {},
        { timeout: 8000 }
      );
      return response.data || { ok: false };
    } catch (err) {
      return { ok: false, description: err.message };
    }
  }
};

module.exports = telegramService;