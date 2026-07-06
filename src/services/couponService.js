/**
 * couponService.js
 * Tägliche Coupon-Rotation (Lokal in DB verwaltet, ohne Sellauth API)
 * - Generiert einen täglichen Rabattcode für den Support-Chat und das Dashboard
 * - Deaktiviert alte lokale Coupons
 * - Läuft täglich um die konfigurierte Stunde (Standard: 00:00 Uhr)
 */

const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const couponService = {

  // ── Zufälligen Coupon-Code generieren ──────────────────────────────────────
  _generateCode(prefix) {
    const chars  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O/1/I (Verwechslung)
    const random = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const base   = (prefix || 'SAVE').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 6);
    return `${base}-${random}`;
  },

  // ── Settings laden ─────────────────────────────────────────────────────────
  async _loadSettings() {
    try {
      const { data } = await supabase.from('settings').select(
        'coupon_enabled, coupon_discount, coupon_type, coupon_description, coupon_max_uses, coupon_schedule_hour'
      ).single();
      return data || {};
    } catch {
      return {};
    }
  },

  // ── Aktiven Coupon aus DB holen ────────────────────────────────────────────
  async getActiveCoupon() {
    try {
      const nowIso = new Date().toISOString();
      const { data } = await supabase
        .from('daily_coupons')
        .select('*')
        .eq('is_active', true)
        .gt('active_until', nowIso)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      // Abgelaufene aber noch aktive Coupons deaktivieren
      try {
        await supabase.from('daily_coupons')
          .update({ is_active: false })
          .eq('is_active', true)
          .lte('active_until', nowIso);
      } catch (_) {}

      return data || null;
    } catch (e) {
      logger.warn('[Coupon] getActiveCoupon Fehler:', e.message || String(e));
      return null;
    }
  },

  async getActiveCouponFresh() {
    return this.getActiveCoupon();
  },

  // ── Alten Coupon in DB deaktivieren ────────────────────────────────────────
  async _deactivateOld() {
    try {
      // DB: alle aktiven als inaktiv markieren
      await supabase.from('daily_coupons')
        .update({ is_active: false })
        .eq('is_active', true);
      logger.info('[Coupon] Alte Coupons in der Datenbank deaktiviert.');
    } catch (e) {
      logger.warn(`[Coupon] _deactivateOld Fehler: ${e.message}`);
    }
  },

  // ── Neuen täglichen Coupon erstellen ──────────────────────────────────────
  async createDailyCoupon(force = false) {
    const settings = await this._loadSettings();

    if (!force && !settings.coupon_enabled) {
      logger.info('[Coupon] Deaktiviert in Settings – nutze force:true zum manuellen Erstellen');
      return null;
    }

    // Wochentag-Planung prüfen (0=Mo ... 6=So, JS: 0=So → umrechnen)
    const jsDay     = new Date().getDay();                     // 0=So,1=Mo...6=Sa
    const weekday   = jsDay === 0 ? 6 : jsDay - 1;            // → 0=Mo...6=So
    let discount    = settings.coupon_discount    || 10;
    let type        = settings.coupon_type         || 'percentage';
    let description = settings.coupon_description  || (type === 'percentage' ? `${discount}% Rabatt` : `${discount}€ Rabatt`);
    let maxUses     = settings.coupon_max_uses      || null;

    try {
      const { data: schedule } = await supabase
        .from('coupon_schedule')
        .select('*')
        .eq('weekday', weekday)
        .maybeSingle();

      if (schedule) {
        if (!schedule.enabled) {
          logger.info(`[Coupon] Wochentag ${weekday} deaktiviert – kein Coupon heute`);
          return null;
        }
        discount    = schedule.discount;
        type        = schedule.type;
        description = schedule.description || (type === 'percentage' ? `${discount}% Rabatt` : `${discount}€ Rabatt`);
        maxUses     = schedule.max_uses    || null;
        logger.info(`[Coupon] Wochentag ${weekday}: ${discount}${type==='percentage'?'%':'€'} – ${description}`);
      }
    } catch (e) {
      logger.warn(`[Coupon] Schedule laden fehlgeschlagen: ${e.message} – nutze Standard-Einstellungen`);
    }

    // Prefix aus Beschreibung: "10% Rabatt" → "SAVE10"
    const prefix = type === 'percentage' ? `SAVE${discount}` : `EUR${discount}`;
    const code   = this._generateCode(prefix);

    const today    = new Date();
    const expiresAt = new Date(today);
    expiresAt.setHours(23, 59, 59, 0);

    logger.info(`[Coupon] Erstelle Coupon in DB: ${code} (${discount}${type === 'percentage' ? '%' : '€'} Rabatt)`);

    // 1. Alten Coupon deaktivieren
    await this._deactivateOld();

    // 2. In DB speichern
    const { data: saved, error: saveErr } = await supabase.from('daily_coupons').insert([{
      code,
      discount_value: discount,
      discount_type:  type,
      description,
      sellauth_id:    'local_db', // sellauth_id Spalte behalten für DB-Schema-Kompatibilität
      active_until:   expiresAt.toISOString(),
      max_uses:       maxUses,
      is_active:      true,
      uses:           0
    }]).select().single();

    if (saveErr) {
      logger.error(`[Coupon] DB-Save fehlgeschlagen: ${saveErr.message}`);
      return {
        code, discount_value: discount, discount_type: type, description,
        sellauth_id: 'local_db', active_until: expiresAt.toISOString(),
        is_active: true, uses: 0, _db_save_failed: true
      };
    }

    logger.info(`[Coupon] ✅ Lokaler Tages-Coupon aktiv: ${code}`);
    return saved;
  },

  // ── Scheduler: läuft täglich zur eingestellten Stunde ────────────────────
  startDailyScheduler() {
    // Beim Start: prüfen ob der heutige Coupon fehlt (nach SIGTERM/Neustart)
    this._checkMissedCoupon();

    const scheduleNext = async () => {
      try {
        const settings = await this._loadSettings();
        if (!settings.coupon_enabled) {
          logger.info('[Coupon] System deaktiviert – Scheduler pausiert. Prüfe in 30min erneut.');
          setTimeout(scheduleNext, 30 * 60 * 1000);
          return;
        }

        const targetHour = parseInt(settings.coupon_schedule_hour) || 0;
        const now  = new Date();
        let next   = new Date();
        next.setHours(targetHour, 0, 5, 0);

        if (next <= now) next.setDate(next.getDate() + 1);

        const delay = next.getTime() - now.getTime();
        logger.info(`[Coupon] Nächste Erneuerung: ${next.toISOString()} UTC (in ${Math.round(delay/60000)} min)`);

        setTimeout(async () => {
          logger.info('[Coupon] ⏰ Tägliche Rotation wird ausgeführt...');
          try {
            await this.createDailyCoupon();
          } catch (e) {
            logger.error('[Coupon] Rotation fehlgeschlagen:', e.message);
          }
          scheduleNext();
        }, delay);

      } catch (e) {
        logger.warn(`[Coupon] Scheduler-Fehler: ${e.message}`);
        setTimeout(scheduleNext, 60 * 60 * 1000);
      }
    };

    scheduleNext();
    logger.info('[Coupon] Daily Scheduler gestartet');
  },

  // Prüft beim Serverstart ob der Coupon für heute schon erstellt wurde
  async _checkMissedCoupon() {
    try {
      await new Promise(r => setTimeout(r, 5000)); // 5s warten bis DB-Verbindung steht

      const settings = await this._loadSettings();
      if (!settings.coupon_enabled) return;

      const targetHour = parseInt(settings.coupon_schedule_hour) || 0;
      const now = new Date();
      const todayTarget = new Date();
      todayTarget.setHours(targetHour, 0, 0, 0);

      // Nur prüfen wenn wir NACH der geplanten Zeit starten
      if (now < todayTarget) return;

      // Prüfen ob heute schon ein aktiver Coupon existiert
      const activeCoupon = await this.getActiveCoupon();
      if (activeCoupon) {
        logger.info(`[Coupon] Startup-Check: Coupon ${activeCoupon.code} bereits aktiv.`);
        return;
      }

      // Kein Coupon für heute → nachholen
      logger.info('[Coupon] Startup-Check: Kein Coupon für heute – erstelle jetzt (SIGTERM-Recovery)...');
      await this.createDailyCoupon(true);
    } catch (e) {
      logger.warn('[Coupon] Startup-Check fehlgeschlagen:', e.message);
    }
  }
};

module.exports = couponService;
