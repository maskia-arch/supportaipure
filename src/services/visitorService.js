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
  
  async getOrCreateVisitor(ip, userAgent, fingerprint) {
    const ipHash = this._hashIp(ip);

    try {
      let existing = null;

      // 1. Per Fingerprint suchen (stärkster Identifier)
      if (fingerprint) {
        const { data: byFp } = await supabase
          .from('widget_visitors')
          .select('*')
          .eq('fingerprint', fingerprint)
          .order('last_seen', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (byFp) existing = byFp;
      }

      // 2. Per IP-Hash suchen (Fallback, z.B. wenn Fingerprint fehlt oder sich ändert)
      if (!existing && ipHash) {
        const { data: byIp } = await supabase
          .from('widget_visitors')
          .select('*')
          .eq('ip_hash', ipHash)
          .order('last_seen', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (byIp) existing = byIp;
      }

      // 3. Bestehenden Besucher aktualisieren — SELBE chatId zurückgeben
      if (existing) {
        // Update last_seen + eventuell neuen Fingerprint nachtragen
        await supabase.from('widget_visitors').update({
          last_seen:   new Date(),
          user_agent:  userAgent || existing.user_agent,
          // Fingerprint nur überschreiben wenn vorher fehlte (nicht zurücksetzen)
          fingerprint: fingerprint || existing.fingerprint,
          ip_hash:     ipHash,
          ip:          ip || existing.ip
        }).eq('chat_id', existing.chat_id);

        return { chatId: existing.chat_id, visitor: existing, isNew: false };
      }

      // 4. Neuen Besucher anlegen — chatId aus IP-Hash + Timestamp
      const idBase = ipHash.substring(0, 10);
      const chatId = 'web_' + idBase + '_' + Date.now().toString(36).slice(-4);

      const { data: created, error: insErr } = await supabase.from('widget_visitors').insert([{
        chat_id:     chatId,
        ip:          ip,
        ip_hash:     ipHash,
        user_agent:  userAgent || null,
        fingerprint: fingerprint || null,
        first_seen:  new Date(),
        last_seen:   new Date()
      }]).select().single();

      if (insErr) {
        logger.warn('[Visitor] Insert Fehler: ' + insErr.message);
        // Beim Insert-Fehler nochmals per fingerprint/IP suchen (Parallel-Request race)
        if (fingerprint) {
          const { data: byFp2 } = await supabase
            .from('widget_visitors').select('chat_id').eq('fingerprint', fingerprint).maybeSingle();
          if (byFp2?.chat_id) return { chatId: byFp2.chat_id, visitor: byFp2, isNew: false };
        }
        const { data: byIp2 } = await supabase
          .from('widget_visitors').select('chat_id').eq('ip_hash', ipHash).maybeSingle();
        if (byIp2?.chat_id) return { chatId: byIp2.chat_id, visitor: byIp2, isNew: false };
        // Letzter Fallback: chatId ohne DB-Eintrag verwenden
        return { chatId, visitor: null, isNew: true };
      }

      return { chatId, visitor: created, isNew: true };
    } catch (err) {
      logger.warn('[Visitor] getOrCreate Fehler: ' + err.message);
      const chatId = 'web_' + ipHash.substring(0, 10) + '_' + Date.now().toString(36).slice(-4);
      return { chatId, visitor: null, isNew: true };
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