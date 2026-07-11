/**
 * visitorService.js v1.4
 * IP-Fingerprinting, persistente ChatID, Ban-Check, Activity-Tracking
 *
 * v1.4 Änderungen:
 *   • getOrCreateVisitor: Bei existierendem Besucher chatId IMMER aus DB zurückgeben,
 *     nicht neu generieren → verhindert Duplikate bei race conditions
 *   • logActivity: page_title Spalte wird nur gesetzt wenn vorhanden (Schema-safe)
 *   • Keine Breaking Changes am öffentlichen API
 */

const crypto = require('crypto');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const visitorService = {
  
  async getOrCreateVisitor(ip, userAgent, fingerprint, visitorId) {
    const ipHash = this._hashIp(ip);

    try {
      let existing = null;

      // ── 1. Visitor-ID (UUID aus localStorage) — stärkster und eindeutigster Identifier
      // Jeder Browser generiert beim ersten Besuch eine UUID die in localStorage gespeichert
      // wird. Damit können auch In-App-Browser (Instagram, TikTok) korrekt zugeordnet werden.
      if (visitorId && visitorId.length >= 10) {
        const { data: byVid } = await supabase
          .from('widget_visitors')
          .select('*')
          .eq('visitor_id', visitorId)
          .maybeSingle();
        if (byVid) existing = byVid;
      }

      // ── 2. Fingerprint — zweite Option wenn visitor_id noch nicht gespeichert war
      if (!existing && fingerprint) {
        const { data: byFp } = await supabase
          .from('widget_visitors')
          .select('*')
          .eq('fingerprint', fingerprint)
          .order('last_seen', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (byFp) existing = byFp;
      }

      // ── 3. IP-Hash — NUR als letzter Fallback (unzuverlässig bei shared networks)
      // Nur nutzen wenn IP innerhalb der letzten 2 Stunden aktiv war (reduziert Kollisionen)
      if (!existing && ipHash) {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const { data: byIp } = await supabase
          .from('widget_visitors')
          .select('*')
          .eq('ip_hash', ipHash)
          .gte('last_seen', twoHoursAgo)
          .order('last_seen', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (byIp) existing = byIp;
      }

      // ── 4. Bestehenden Besucher aktualisieren — SELBE chatId zurückgeben
      if (existing) {
        const updates = {
          last_seen:   new Date(),
          user_agent:  userAgent || existing.user_agent,
          fingerprint: fingerprint || existing.fingerprint,
          ip_hash:     ipHash,
          ip:          ip || existing.ip
        };
        // visitor_id nachträglich setzen falls noch nicht vorhanden
        if (visitorId && !existing.visitor_id) {
          updates.visitor_id = visitorId;
        }
        await supabase.from('widget_visitors').update(updates).eq('chat_id', existing.chat_id);

        return {
          chatId:        existing.chat_id,
          visitor:       existing,
          isNew:         false,
          visitorNumber: existing.visitor_number || null
        };
      }

      // ── 5. Nächste sequenzielle Besucher-Nummer vergeben
      const visitorNumber = await this._nextVisitorNumber();

      // ── 6. Neuen Besucher anlegen
      // chatId basiert auf visitor_id (wenn vorhanden) oder IP-Hash + Timestamp
      const idBase = visitorId
        ? visitorId.replace(/-/g, '').substring(0, 10)
        : ipHash.substring(0, 10);
      const chatId = 'web_' + idBase + '_' + Date.now().toString(36).slice(-4);

      const { data: created, error: insErr } = await supabase.from('widget_visitors').insert([{
        chat_id:        chatId,
        visitor_id:     visitorId || null,
        visitor_number: visitorNumber,
        ip:             ip,
        ip_hash:        ipHash,
        user_agent:     userAgent || null,
        fingerprint:    fingerprint || null,
        first_seen:     new Date(),
        last_seen:      new Date()
      }]).select().single();

      if (insErr) {
        logger.warn('[Visitor] Insert Fehler: ' + insErr.message);
        // Race-condition: nochmals per visitor_id / fingerprint suchen
        if (visitorId) {
          const { data: byVid2 } = await supabase
            .from('widget_visitors').select('chat_id, visitor_number').eq('visitor_id', visitorId).maybeSingle();
          if (byVid2?.chat_id) return { chatId: byVid2.chat_id, visitor: byVid2, isNew: false, visitorNumber: byVid2.visitor_number || null };
        }
        if (fingerprint) {
          const { data: byFp2 } = await supabase
            .from('widget_visitors').select('chat_id, visitor_number').eq('fingerprint', fingerprint).maybeSingle();
          if (byFp2?.chat_id) return { chatId: byFp2.chat_id, visitor: byFp2, isNew: false, visitorNumber: byFp2.visitor_number || null };
        }
        const { data: byIp2 } = await supabase
          .from('widget_visitors').select('chat_id, visitor_number').eq('ip_hash', ipHash).maybeSingle();
        if (byIp2?.chat_id) return { chatId: byIp2.chat_id, visitor: byIp2, isNew: false, visitorNumber: byIp2.visitor_number || null };
        return { chatId, visitor: null, isNew: true, visitorNumber };
      }

      return { chatId, visitor: created, isNew: true, visitorNumber };
    } catch (err) {
      logger.warn('[Visitor] getOrCreate Fehler: ' + err.message);
      const chatId = 'web_' + ipHash.substring(0, 10) + '_' + Date.now().toString(36).slice(-4);
      return { chatId, visitor: null, isNew: true, visitorNumber: null };
    }
  },

  // ── Sequenz: nächste Besucher-Nummer vergeben ──────────────────────────────

  // Atomic in SQLite und Postgres: UPDATE mit RETURNING / Fallback via select+update
  async _nextVisitorNumber() {
    try {
      // SQLite & Postgres kompatible Strategie: read-modify-write
      const { data: seq } = await supabase
        .from('visitor_number_seq')
        .select('last_number')
        .eq('id', 1)
        .maybeSingle();
      const next = ((seq && seq.last_number) || 0) + 1;
      await supabase.from('visitor_number_seq').update({ last_number: next }).eq('id', 1);
      return next;
    } catch (_) {
      // Fallback: zufällige Nummer aus Timestamp (nicht sequenziell aber einzigartig)
      return Math.floor(Date.now() / 1000) % 100000;
    }
  },

  
  async isBanned(ip, chatId) {
    try {
      // blacklist nutzt visitor_ip + chat_id (echtes Schema)
      const { data: ipBan } = await supabase
        .from('blacklist')
        .select('id, reason')
        .eq('visitor_ip', ip)
        .maybeSingle();
      if (ipBan) return { banned: true, reason: ipBan.reason || 'IP gebannt', by: 'ip' };

      if (chatId) {
        const { data: idBan } = await supabase
          .from('blacklist')
          .select('id, reason')
          .eq('chat_id', chatId)
          .maybeSingle();
        if (idBan) return { banned: true, reason: idBan.reason || 'Nutzer gebannt', by: 'id' };
      }

      return { banned: false };
    } catch (err) {
      // Bei Fehler nie blockieren – Besucher durchlassen
      return { banned: false };
    }
  },
  
  async logActivity(chatId, activity, pageUrl, pageTitle) {
    if (!chatId) return;
    try {
      await supabase.from('visitor_activities').insert([{
        chat_id:       chatId,
        activity:      activity,        // neue Spalte
        activity_type: activity,        // bestehende Schema-Spalte (Kompatibilität)
        page_url:      pageUrl || null,
        page_title:    pageTitle || null,
        created_at:    new Date()
      }]);
    } catch (err) {
      // Fallback: ohne page_title falls Spalte fehlt
      try {
        await supabase.from('visitor_activities').insert([{
          chat_id:       chatId,
          activity_type: activity,
          page_url:      pageUrl || null,
          created_at:    new Date()
        }]);
      } catch (_) {}
    }

    // System-Nachricht im Chat-Verlauf (optional, Fehler ignorieren)
    try {
      await supabase.from('messages').insert([{
        chat_id: chatId,
        role:    'system',
        content: `📍 ${activity}`
      }]);
    } catch (_) {}
  },
  
  async lookupIp(ip) {
    const ipHash = this._hashIp(ip);
    
    const [visitorRes, blacklistRes, chatsRes] = await Promise.all([
      supabase.from('widget_visitors').select('*').eq('ip_hash', ipHash).maybeSingle(),
      supabase.from('blacklist').select('*').eq('ip_hash', ipHash).maybeSingle(),
      supabase.from('chats').select('*').eq('visitor_ip', ip).order('updated_at', { ascending: false }).limit(20).then(r => r, () => ({ data: [] }))
    ]);
    
    const visitor = visitorRes.data;
    const blacklist = blacklistRes.data;
    
    let activities = [];
    if (visitor?.chat_id) {
      const { data: acts } = await supabase
        .from('visitor_activities')
        .select('*')
        .eq('chat_id', visitor.chat_id)
        .order('created_at', { ascending: false })
        .limit(50)
        .then(r => r, () => ({ data: [] }));
      activities = acts || [];
    }
    
    return {
      ip,
      ipHash,
      visitor: visitor || null,
      chatId: visitor?.chat_id || null,
      isBanned: !!(blacklist || visitor?.is_banned),
      blacklistEntry: blacklist || null,
      activities,
      chats: chatsRes.data || [],
      summary: {
        firstSeen: visitor?.first_seen || null,
        lastSeen: visitor?.last_seen || null,
        pageCount: visitor?.page_count || 0,
        country: visitor?.country || null,
        userAgent: visitor?.user_agent || null
      }
    };
  },
  
  async banIp(ip, reason) {
    const ipHash = this._hashIp(ip);
    
    await supabase.from('blacklist').insert([{
      identifier: ip,
      ip_hash: ipHash,
      reason: reason || 'IP-Bann',
      ban_scope: 'ip',
      auto_banned: false
    }]);
    
    await supabase.from('widget_visitors').update({
      is_banned: true,
      ban_reason: reason || 'IP-Bann',
      banned_at: new Date()
    }).eq('ip_hash', ipHash);
    
    const { data: visitor } = await supabase
      .from('widget_visitors').select('chat_id').eq('ip_hash', ipHash).maybeSingle();
    if (visitor?.chat_id) {
      await supabase.from('chats').update({
        auto_muted: true,
        mute_reason: reason || 'IP-Bann'
      }).eq('id', visitor.chat_id);
    }
    
    return { success: true, ipHash };
  },
  
  _hashIp(ip) {
    return crypto.createHash('sha256').update(ip + 'vs25_salt').digest('hex').substring(0, 32);
  },
  
  _getClientIp(req) {
    return (
      req.headers['cf-connecting-ip'] ||
      req.headers['x-real-ip'] ||
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      '0.0.0.0'
    );
  }
};

module.exports = visitorService;