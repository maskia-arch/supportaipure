/**
 * customerService.js
 *
 * Kundenerkennung & Zuordnung:
 * Liest Kundendaten, Bestellungen und eSIM-Cash aus der Storefront-DB
 * zur zuverlässigen Identifikation von Website-Besuchern & Chat-Nutzern.
 */

const storefrontDb = require('../config/storefrontDb');
const logger       = require('../utils/logger');

const customerService = {

  /**
   * Sucht nach einem Kunden in der Storefront-DB basierend auf:
   *   - email
   *   - userId
   *   - checkoutRef (Bestellnummer / UUID)
   *   - iccid
   */
  async lookupCustomerInfo({ email, userId, checkoutRef, iccid }) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanUserId = (userId || '').trim();
    const cleanRef = (checkoutRef || '').trim();
    const cleanIccid = (iccid || '').trim();

    if (!cleanEmail && !cleanUserId && !cleanRef && !cleanIccid) {
      return { found: false };
    }

    try {
      let matchedEmail = cleanEmail;
      let matchedUserId = cleanUserId;
      let matchedName = null;

      // ── 1. Suche in `orders` falls E-Mail/User-ID noch fehlt, aber Ref/ICCID da ist ─────
      if ((!matchedEmail || !matchedUserId) && (cleanRef || cleanIccid)) {
        let orderQuery = storefrontDb.from('orders').select('user_id, email, customer_email');
        if (cleanRef) {
          orderQuery = orderQuery.eq('id', cleanRef);
        } else if (cleanIccid) {
          orderQuery = orderQuery.or(`iccid.eq.${cleanIccid},top_up_iccid.eq.${cleanIccid}`);
        }
        const { data: oRow } = await orderQuery.limit(1).maybeSingle();
        if (oRow) {
          if (!matchedEmail) matchedEmail = (oRow.email || oRow.customer_email || '').toLowerCase().trim();
          if (!matchedUserId) matchedUserId = oRow.user_id || null;
        }
      }

      // ── 2. Benutzer-Profil aus `users` laden ──────────────────────────────────────────
      if (matchedEmail || matchedUserId) {
        let userQuery = storefrontDb.from('users').select('id, email, full_name, name');
        if (matchedUserId) {
          userQuery = userQuery.eq('id', matchedUserId);
        } else if (matchedEmail) {
          userQuery = userQuery.eq('email', matchedEmail);
        }
        const { data: uRow } = await userQuery.limit(1).maybeSingle();
        if (uRow) {
          matchedUserId = uRow.id || matchedUserId;
          matchedEmail = (uRow.email || matchedEmail).toLowerCase().trim();
          matchedName = uRow.full_name || uRow.name || null;
        }
      }

      if (!matchedEmail && !matchedUserId) {
        return { found: false };
      }

      // ── 3. Alle Bestellungen des Kunden abrufen ──────────────────────────────────────
      let ordersQuery = storefrontDb.from('orders').select('id, status, amount_eur, tariff_id, created_at');
      if (matchedUserId && matchedEmail) {
        ordersQuery = ordersQuery.or(`user_id.eq.${matchedUserId},email.eq.${matchedEmail}`);
      } else if (matchedUserId) {
        ordersQuery = ordersQuery.eq('user_id', matchedUserId);
      } else {
        ordersQuery = ordersQuery.eq('email', matchedEmail);
      }

      const { data: ordersData } = await ordersQuery.order('created_at', { ascending: false });
      const orders = ordersData || [];

      // Metriken berechnen
      const completedOrders = orders.filter(o => o.status === 'completed');
      const totalOrdersCount = orders.length;
      const completedCount = completedOrders.length;

      const totalSpendEur = completedOrders.reduce((sum, o) => sum + (Number(o.amount_eur) || 0), 0);
      const formattedSpend = totalSpendEur.toFixed(2).replace('.', ',');

      // Kundenspezifischer Status
      let customerStatus = 'Interessent';
      if (completedCount > 1) {
        customerStatus = 'Stammkunde';
      } else if (completedCount === 1) {
        customerStatus = 'Kunde';
      } else if (totalOrdersCount > 0) {
        customerStatus = 'Offene Bestellung';
      }

      // ── 4. Namen bestimmen ──────────────────────────────────────────────────────────
      if (!matchedName) {
        if (matchedEmail) {
          const prefix = matchedEmail.split('@')[0].replace(/[._-]/g, ' ');
          matchedName = prefix.charAt(0).toUpperCase() + prefix.slice(1);
        } else {
          matchedName = 'Kunde';
        }
      }

      // ── 5. Letzten gebuchten Tarif ermitteln ───────────────────────────────────────
      let lastTariffName = null;
      if (orders.length > 0 && orders[0].tariff_id) {
        try {
          const { data: tRow } = await storefrontDb
            .from('tariffs')
            .select('name')
            .eq('id', orders[0].tariff_id)
            .maybeSingle();
          if (tRow?.name) lastTariffName = tRow.name;
        } catch (_) {}
      }

      const summaryLabel = `${matchedName} (${matchedEmail || 'Keine Mail'}) · ${customerStatus} (${completedCount} ${completedCount === 1 ? 'Bestellung' : 'Bestellungen'}, ${formattedSpend} €)`;

      return {
        found: true,
        email: matchedEmail || null,
        name: matchedName,
        userId: matchedUserId || null,
        totalOrdersCount,
        completedCount,
        totalSpendEur,
        formattedSpend,
        customerStatus,
        lastTariffName,
        summaryLabel
      };
    } catch (err) {
      logger.warn('[CustomerService] Fehler bei Kundenerkennung:', err.message);
      return {
        found: false,
        error: err.message
      };
    }
  }
};

module.exports = customerService;
