/**
 * abuseDetector.js v2.0
 *
 * Faire, mehrsprachen-sichere Spam-Erkennung:
 * - Erkennt NUR echten Spam (Flut, Wiederholungen, reine Zeichenketten)
 * - NIE fremdsprachige Wörter (Unicode-aware: \p{L} = Buchstabe jeder Schrift)
 * - Immer ABGESTUFTE WARNUNGEN im Chat bevor etwas blockiert wird
 * - Temporäre Sperre (Minuten), KEINE stille Dauer-Blockade
 * - Normale Beratung nach Warnung setzt den Zähler zurück
 *
 * Rückgabe von check():
 *   { action, message, isLegit }
 *   action: 'allow' | 'warn' | 'mute' | 'muted' | 'muted_silent' | 'banned'
 *   message: Text der dem User gesendet werden soll (oder null)
 *   isLegit: true wenn normale Nachricht (für Zähler-Reset)
 */

const supabase = require('../config/supabase');
const logger   = require('../utils/logger');

// In-Memory Tracking (reset bei Neustart = ok, reiner Schutz)
const _msgTimestamps = new Map();  // chatId → [ts, ...]   Flut-Erkennung
const _lastMsgs      = new Map();  // chatId → { text, count }  Wiederholungs-Erkennung
const _muteNotice    = new Map();  // chatId → ts   Throttle für "noch gesperrt"-Hinweis

const MUTE_MINUTES        = 10;          // Dauer der Spam-Pause
const BLOCK_HOURS         = 24;          // 24h-Sperre nach 3 Warnungen
const MAX_FLAGS           = 3;           // ab 3 Flags: vollständige IP-Sperre
const MUTE_NOTICE_THROTTLE = 5 * 60_000; // Hinweis "noch gesperrt" max alle 5 min

// ── Gefährliche/illegale Inhalte (vor dem AI-Call abfangen → keine Tokens) ──
// CSAM (Kindesmissbrauch) → SOFORTIGE Dauer-Sperre, keine Warnung.
const CSAM_PATTERNS = [
  /\b(child|minor|kid|kinder?|underage|preteen|loli|shota)\b[\s\S]{0,30}\b(porn|sex|nude|naked|nackt|explicit|cp|abuse)/i,
  /\b(porn|sex|nude|naked|nackt|explicit|csam|cp)\b[\s\S]{0,30}\b(child|minor|kid|kinder?|underage|preteen)/i,
  /\bcsam\b|\bchild\s*porn/i,
  /kinderporn|kinderpornografie|kinderpornographie/i,
  /बाल[\s\S]{0,20}(पोर्न|अश्लील|यौन)/i,            // Hindi: Kind + Porno/obszön/sexuell
  /बच्च[\s\S]{0,25}(अश्लील|पोर्न|नग्न|यौन)/i,       // Hindi: Kinder + obszön/Porno/nackt
  /\bпедофил|детск\w*\s*порн/i,                       // Russisch
];

// Waffen / Sprengstoff → cached Refusal + Flag (schwer)
const WEAPON_PATTERNS = [
  /\b(bombe?|bomb|explosi|sprengsatz|sprengstoff|detonat|grenade|granate)\b/i,
  /\b(waffe|weapon|firearm|schusswaffe|pistole|gun)\b[\s\S]{0,30}\b(bau|build|herstell|make|3d)/i,
  /\b(napalm|thermit|tnt|c4|semtex|nitroglyzerin|nitroglycerin)\b/i,
  /rohrbombe|nagelbombe|pipe\s*bomb/i,
];

// Drogen-Synthese → cached Refusal + Flag (schwer)
const DRUG_PATTERNS = [
  /\b(meth|methamphetamin|crystal\s*meth|kokain|cocaine|heroin|fentanyl|mdma|lsd)\b[\s\S]{0,40}\b(synthese|synthesi|herstell|koch|cook|rezept|recipe|make|produzier)/i,
  /\b(synthesi|herstell|koch|cook|rezept|recipe)\b[\s\S]{0,40}\b(meth|methamphetamin|kokain|cocaine|heroin|fentanyl|mdma|lsd)\b/i,
];

const abuseDetector = {

  async check(chatId, text, meta = {}) {
    const allow = { action: 'allow', message: null, isLegit: true };
    try {
      const settings = await this._loadSettings();
      const trimmed  = (text || '').trim();
      const now      = Date.now();
      const ip       = meta.ip || null;
      const fingerprint = meta.fingerprint || null;

      // Chat-Status laden
      let chat = null;
      try {
        const { data } = await supabase.from('chats')
          .select('spam_warn_count, mute_until, auto_muted, flag_count, visitor_ip')
          .eq('id', chatId).maybeSingle();
        chat = data;
      } catch (_) {}

      const muteUntil = chat?.mute_until ? new Date(chat.mute_until).getTime() : 0;

      // ── 0. Bereits dauerhaft gebannt (IP oder chat_id)? → still blockieren ─
      if (await this._isHardBanned(chatId, ip)) {
        const lastNotice = _muteNotice.get('ban_' + chatId) || 0;
        if (now - lastNotice > MUTE_NOTICE_THROTTLE) {
          _muteNotice.set('ban_' + chatId, now);
          return { action: 'banned', message: this._banMsg(), isLegit: false };
        }
        return { action: 'muted_silent', message: null, isLegit: false };
      }

      // ── 1. GEFÄHRLICHE INHALTE (vor AI-Call, keine Tokens) ──────────────
      const severe = this._detectSevere(trimmed);
      if (severe === 'csam') {
        // Kinderschutz: SOFORTIGE dauerhafte Vollsperre, keine Warnung
        logger.warn(`[Abuse] ⛔ CSAM-Inhalt erkannt → Permanent-Sperre: ${chatId}`);
        await this._hardBan(chatId, ip, fingerprint, 'Illegaler Inhalt (CSAM) — automatische Permanent-Sperre');
        this._logFlag(chatId, 'csam', trimmed);
        return { action: 'banned', message: this._csamMsg(), isLegit: false };
      }
      if (severe === 'weapons' || severe === 'drugs') {
        // Cached Refusal + sofortiger Flag (schwer) + 24h-Sperre
        logger.warn(`[Abuse] Gefährlicher Inhalt (${severe}) → Flag + 24h-Sperre: ${chatId}`);
        const flagResult = await this._addFlag(chatId, ip, fingerprint, severe);
        if (flagResult.permanentBan) {
          return { action: 'banned', message: this._banMsg(), isLegit: false };
        }
        await this._block24h(chatId);
        return { action: 'mute', message: this._severeMsg(severe), isLegit: false };
      }

      // ── 2. Aktuell temporär gesperrt (Spam-Pause oder 24h)? ─────────────
      if (muteUntil > now) {
        const lastNotice = _muteNotice.get(chatId) || 0;
        if (now - lastNotice > MUTE_NOTICE_THROTTLE) {
          _muteNotice.set(chatId, now);
          const mins  = Math.ceil((muteUntil - now) / 60_000);
          const hours = Math.ceil(mins / 60);
          return { action: 'muted', message: mins > 90 ? this._block24hMsg(hours) : this._muteMsg(mins), isLegit: false };
        }
        return { action: 'muted_silent', message: null, isLegit: false };
      }

      // ── 3. Abgelaufene Sperre aufheben + Warn-Zähler zurücksetzen ───────
      if (chat?.mute_until && muteUntil <= now) {
        try {
          await supabase.from('chats').update({
            mute_until: null, auto_muted: false, mute_reason: null, spam_warn_count: 0
          }).eq('id', chatId);
        } catch (_) {}
        chat = { ...chat, spam_warn_count: 0, auto_muted: false, mute_until: null };
      }

      // ── 4. Spam-Prüfung (Unicode-sicher) ────────────────────────────────
      const maxPerHour = settings.abuse_max_msgs_per_hour || 30;
      const isFlood    = this._checkBurst(chatId, maxPerHour);
      const isPattern  = this._isSpamPattern(trimmed, chatId);
      const isSpam     = isFlood || isPattern;

      // ── 5. Legitime Nachricht → Warn-Zähler zurücksetzen ────────────────
      if (!isSpam) {
        if ((chat?.spam_warn_count || 0) > 0) {
          try { await supabase.from('chats').update({ spam_warn_count: 0 }).eq('id', chatId); } catch (_) {}
        }
        return allow;
      }

      // ── 6. Spam → 3 Warnungen, dann 24h-Sperre + Flag ───────────────────
      const warnCount = (chat?.spam_warn_count || 0) + 1;
      try {
        await supabase.from('chats').update({
          spam_warn_count: warnCount, last_spam_warn_at: new Date()
        }).eq('id', chatId);
      } catch (_) {}

      if (warnCount > 3) {
        // Nach 3 Warnungen: 24h-Sperre + Flag vergeben
        this._logFlag(chatId, isFlood ? 'flood' : 'spam', trimmed);
        const flagResult = await this._addFlag(chatId, ip, fingerprint, 'spam');
        if (flagResult.permanentBan) {
          return { action: 'banned', message: this._banMsg(), isLegit: false };
        }
        await this._block24h(chatId);
        logger.info(`[Abuse] 24h-Sperre + Flag (${flagResult.flags}/${MAX_FLAGS}): ${chatId}`);
        return { action: 'mute', message: this._block24hMsg(BLOCK_HOURS), isLegit: false };
      }

      // Warnungen 1, 2, 3
      logger.info(`[Abuse] Warnung ${warnCount}/3: ${chatId}`);
      return { action: 'warn', message: this._warnMsg(warnCount), isLegit: false };

    } catch (err) {
      logger.warn(`[Abuse] Check-Fehler (nicht fatal): ${err.message}`);
      return allow; // Im Zweifel IMMER durchlassen — nie still blockieren
    }
  },

  // ── Gefährliche Inhalte erkennen ───────────────────────────────────────
  _detectSevere(text) {
    if (!text) return null;
    if (CSAM_PATTERNS.some(p => p.test(text)))   return 'csam';
    if (WEAPON_PATTERNS.some(p => p.test(text))) return 'weapons';
    if (DRUG_PATTERNS.some(p => p.test(text)))   return 'drugs';
    return null;
  },

  // ── Prüfen ob dauerhaft gebannt (chat_id ODER IP) ──────────────────────
  async _isHardBanned(chatId, ip) {
    try {
      const { data: byChat } = await supabase.from('blacklist').select('id').eq('chat_id', chatId).maybeSingle();
      if (byChat) return true;
      if (ip) {
        const { data: byIp } = await supabase.from('blacklist').select('id').eq('visitor_ip', ip).maybeSingle();
        if (byIp) return true;
      }
    } catch (_) {}
    return false;
  },

  // ── Flag hinzufügen → bei MAX_FLAGS dauerhafte Vollsperre ──────────────
  async _addFlag(chatId, ip, fingerprint, reason) {
    let flags = 0;
    try {
      const { data: c } = await supabase.from('chats').select('flag_count').eq('id', chatId).maybeSingle();
      flags = (c?.flag_count || 0) + 1;
      await supabase.from('chats').update({ flag_count: flags }).eq('id', chatId);
    } catch (_) {}

    if (flags >= MAX_FLAGS) {
      // 3 Flags → vollständige Sperre (IP + Fingerprint + chat_id)
      await this._hardBan(chatId, ip, fingerprint, `Automatische Permanent-Sperre nach ${flags} Flags (${reason})`);
      logger.warn(`[Abuse] ⛔ Permanent-Sperre nach ${flags} Flags: ${chatId} (IP: ${ip || '?'})`);
      return { flags, permanentBan: true };
    }
    return { flags, permanentBan: false };
  },

  // ── 24h-Sperre setzen ──────────────────────────────────────────────────
  async _block24h(chatId) {
    const until = new Date(Date.now() + BLOCK_HOURS * 60 * 60_000);
    try {
      await supabase.from('chats').update({
        mute_until: until, auto_muted: true, mute_reason: '24h-Sperre nach Verwarnungen', spam_warn_count: 0
      }).eq('id', chatId);
    } catch (_) {}
    _muteNotice.set(chatId, Date.now());
  },

  // ── Vollständige Permanent-Sperre (IP + chat_id) ───────────────────────
  async _hardBan(chatId, ip, fingerprint, reason) {
    // IP ermitteln (mitgegeben oder aus chats)
    let banIp = ip;
    if (!banIp) {
      try {
        const { data: c } = await supabase.from('chats').select('visitor_ip').eq('id', chatId).maybeSingle();
        banIp = c?.visitor_ip || null;
      } catch (_) {}
    }
    // chat_id + IP in einem Eintrag sperren
    try {
      await supabase.from('blacklist').insert([{
        chat_id: chatId, visitor_ip: banIp, reason, banned_by: 'system'
      }]);
    } catch (_) {}
    // Chat hart muten
    try {
      await supabase.from('chats').update({
        auto_muted: true, is_manual_mode: false, mute_reason: reason
      }).eq('id', chatId);
    } catch (_) {}
  },

  // ── Spam-Muster (Unicode-sicher, NUR echter Spam) ────────────────────
  _isSpamPattern(text, chatId) {
    if (!text || text.length < 4) {
      // Sehr kurze Nachrichten ("hi", "ok", "👍") sind nie Spam
      // Wiederholungs-Tracking trotzdem aktualisieren
      this._trackRepeat(text, chatId);
      return false;
    }

    // a) Gleiches Zeichen 7+ mal hintereinander: "aaaaaaa", "!!!!!!!"
    if (/^(.)\1{6,}$/u.test(text)) return true;

    // b) Nur Satz-/Sonderzeichen (KEIN Buchstabe/Ziffer JEDER Schrift), 6+ Zeichen
    //    \p{L} fängt Latein, Kyrillisch, Arabisch, CJK usw. → Fremdsprache NIE Spam
    if (text.length >= 6 && !/[\p{L}\p{N}]/u.test(text) && /^[\p{P}\p{S}\s]+$/u.test(text)) return true;

    // c) Klassisches Tastatur-Geklimper, wiederholt: "asdfasdf", "qwerqwer"
    if (/^(asdf|qwer|zxcv|wasd|hjkl|jkl|fdsa){2,}$/i.test(text)) return true;

    // d) Exakt gleiche Nachricht 4+ mal hintereinander
    const rep = this._trackRepeat(text, chatId);
    if (rep >= 4) return true;

    return false;
  },

  _trackRepeat(text, chatId) {
    const last = _lastMsgs.get(chatId);
    if (last && last.text === text) {
      last.count++;
      _lastMsgs.set(chatId, last);
      return last.count;
    }
    _lastMsgs.set(chatId, { text, count: 1 });
    return 1;
  },

  // ── Flut-Erkennung (in-memory, letzte 60 min) ────────────────────────
  _checkBurst(chatId, maxPerHour) {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60_000;
    let ts = (_msgTimestamps.get(chatId) || []).filter(t => t > oneHourAgo);
    ts.push(now);
    _msgTimestamps.set(chatId, ts);
    return ts.length > maxPerHour;
  },

  // ── Nachrichten-Texte (zweisprachig DE/EN) ───────────────────────────
  _warnMsg(count) {
    if (count >= 3) {
      return '⚠️ Verwarnung 3/3 — letzte Warnung: Bitte nutze den Chat nur für echte eSIM-Fragen. '
           + 'Bei weiterem Spam wird der Zugang für 24 Stunden gesperrt.\n\n'
           + '⚠️ Warning 3/3 — final: Please use this chat only for genuine eSIM questions. '
           + 'Further spam will block access for 24 hours.';
    }
    if (count === 2) {
      return '⚠️ Verwarnung 2/3: Bitte nutze den Chat für echte Fragen zu eSIMs und Bestellungen.\n\n'
           + '⚠️ Warning 2/3: Please use this chat for genuine eSIM and order questions.';
    }
    return 'ℹ️ Verwarnung 1/3: Bitte nutze diesen Chat für echte Fragen zu eSIMs. Wie kann ich dir helfen?\n\n'
         + 'ℹ️ Warning 1/3: Please use this chat for genuine eSIM questions. How can I help you?';
  },

  _muteMsg(minutes) {
    return `🔇 Der Chat wurde wegen Spam für ${minutes} Minuten pausiert.\n\n`
         + `🔇 This chat has been paused for ${minutes} minutes due to spam.`;
  },

  _block24hMsg(hours) {
    return `⛔ Zugang wegen wiederholtem Spam für ${hours} Stunden gesperrt. `
         + `Danach kannst du wieder schreiben.\n\n`
         + `⛔ Access blocked for ${hours} hours due to repeated spam. You can write again afterwards.`;
  },

  _severeMsg(kind) {
    return '🚫 Diese Anfrage verstößt gegen unsere Richtlinien und kann nicht bearbeitet werden. '
         + 'Der Zugang wurde vorübergehend gesperrt. Ich helfe gerne bei echten Fragen zu eSIMs.\n\n'
         + '🚫 This request violates our policies and cannot be processed. Access has been temporarily blocked. '
         + 'I am happy to help with genuine eSIM questions.';
  },

  _csamMsg() {
    return '🚫 Diese Anfrage ist illegal und wurde gemeldet. Der Zugang wurde dauerhaft gesperrt.\n\n'
         + '🚫 This request is illegal and has been reported. Access has been permanently blocked.';
  },

  _banMsg() {
    return '🚫 Dieser Zugang wurde gesperrt. Bei Fragen wende dich an @autoacts.\n\n'
         + '🚫 This access has been blocked. For questions contact @autoacts.';
  },

  // ── Flag protokollieren (echtes user_flags-Schema: flag_type, details) ─
  async _logFlag(chatId, flagType, details) {
    try {
      await supabase.from('user_flags').insert([{
        chat_id:   chatId,
        flag_type: flagType,
        details:   (details || '').substring(0, 200)
      }]);
      const { data: c } = await supabase.from('chats').select('flag_count').eq('id', chatId).maybeSingle();
      await supabase.from('chats').update({ flag_count: (c?.flag_count || 0) + 1 }).eq('id', chatId);
    } catch (_) {}
  },

  // ── Admin: manuell sperren (dauerhaft) ───────────────────────────────
  async banByAdmin(chatId, reason) {
    try {
      await supabase.from('blacklist').insert([{
        chat_id: chatId, reason: reason || 'Admin-Bann', banned_by: 'admin'
      }]);
      await supabase.from('chats').update({
        auto_muted: true, is_manual_mode: false, mute_reason: reason || 'Admin-Bann'
      }).eq('id', chatId);
      return { banned: true };
    } catch (e) { return { banned: false, error: e.message }; }
  },

  // ── Admin: Sperre/Mute aufheben ──────────────────────────────────────
  async unmute(chatId) {
    try {
      await supabase.from('chats').update({
        auto_muted: false, mute_reason: null, mute_until: null, spam_warn_count: 0
      }).eq('id', chatId);
      await supabase.from('blacklist').delete().eq('chat_id', chatId);
    } catch (_) {}
    _msgTimestamps.delete(chatId);
    _lastMsgs.delete(chatId);
    _muteNotice.delete(chatId);
    _muteNotice.delete('ban_' + chatId);
    logger.info(`[Abuse] Sperre/Mute aufgehoben: ${chatId}`);
  },

  // ── Settings laden ───────────────────────────────────────────────────
  async _loadSettings() {
    try {
      const { data } = await supabase.from('settings')
        .select('abuse_max_msgs_per_hour, abuse_auto_ban_flags').single();
      return data || {};
    } catch { return {}; }
  }
};

module.exports = abuseDetector;
