/**
 * storefrontService.js
 *
 * Synchronisiert eSIM-Tarife direkt aus der gehosteten PostgreSQL-Datenbank
 * in die RAG-Wissensdatenbank und ermöglicht lokale Bestellungsabfragen.
 */

const supabase = require('../config/supabase');
const storefrontDb = require('../config/storefrontDb');
const knowledgeEnricher = require('./knowledgeEnricher');
const deepseekService = require('./deepseekService');
const syncJobManager = require('./syncJobManager');
const logger = require('../utils/logger');

const storefrontService = {

  /**
   * Prüft die DB-Verbindung und zählt aktive Tarife.
   */
  async testConnection() {
    try {
      const { count, error } = await storefrontDb
        .from('tariffs')
        .select('*', { count: 'exact', head: true });

      if (error) {
        return { ok: false, error: error.message };
      }
      return { ok: true, count: count || 0 };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  /**
   * Holt alle aktiven Tarife aus der Storefront-DB.
   */
  async getAllTariffs() {
    // Hole alle aktiven Tarife, geordnet nach Land
    const { data, error } = await storefrontDb
      .from('tariffs')
      .select('*')
      .eq('is_active', true)
      .order('country_name', { ascending: true });

    if (error) {
      throw error;
    }
    return data || [];
  },

  /**
   * Baut den Informationstext für einen Tarif.
   */
  _buildTariffText(tariff, shopUrl) {
    const isUnlimited = tariff.tariff_type?.startsWith('unlimited');
    const dataVolume = isUnlimited
      ? 'Unbegrenztes Datenvolumen (Highspeed-Volumen inklusive)'
      : `${tariff.data_gb} GB Datenvolumen`;

    const speedNote = tariff.speed_kbps
      ? `\nGeschwindigkeit Drosselung: Nach Highspeed-Verbrauch gedrosselt auf ${tariff.speed_kbps} kbps`
      : '';

    const tariffTypeLabel = tariff.tariff_type === 'unlimited_pro'
      ? 'Unlimited Pro'
      : tariff.tariff_type === 'unlimited_eco'
      ? 'Unlimited Eco'
      : 'Travel eSIM';

    const cleanShopUrl = (shopUrl || '').trim().replace(/\/$/, '');
    const productUrl = cleanShopUrl
      ? `${cleanShopUrl}/tariffs?q=${encodeURIComponent(tariff.slug)}`
      : '';

    let text = `Tarifname: ${tariff.name}
Kategorie: ${tariffTypeLabel}
Reiseziel: ${tariff.country_name} (${tariff.country_code})
Region: ${tariff.region || 'Einzelnes Land'}
Laufzeit: ${tariff.validity_days} Tage
Datenvolumen: ${dataVolume}${speedNote}
Preis: ${tariff.sale_price_eur} EUR
`;

    if (productUrl) {
      text += `Kauflink: ${productUrl}\n`;
    }
    if (tariff.description) {
      const cleanDesc = tariff.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleanDesc.length > 5) {
        text += `Zusatzinfo: ${cleanDesc}\n`;
      }
    }

    // Suchanfragen-Hinweise für RAG
    text += `\nSuchbegriffe: "${tariff.country_name} eSIM", "${tariff.country_name} ${tariff.validity_days} Tage", "${tariff.package_code}"`;
    if (productUrl) {
      text += `\nEmpfehlung: Klicke hier um diesen Tarif zu buchen: ${productUrl}`;
    }

    return text.trim();
  },

  /**
   * Führt die RAG-Synchronisation aus.
   */
  async syncToKnowledgeBase(shopUrl, jobId) {
    const progress = (pct, step) => {
      if (jobId) syncJobManager.updateProgress(jobId, pct, step);
      logger.info(`[Storefront Sync] ${pct}% – ${step}`);
    };

    const results = { saved: 0, skipped: 0, errors: 0 };

    progress(5, 'Kategorien vorbereiten...');
    await knowledgeEnricher.ensureEsimCategories();

    progress(15, 'Lade Tarife aus der Datenbank...');
    let tariffs = [];
    try {
      tariffs = await this.getAllTariffs();
    } catch (err) {
      logger.error(`[Storefront Sync] Fehler beim Laden der Tarife: ${err.message}`);
      throw new Error(`Konnte Tarife nicht aus DB lesen: ${err.message}`);
    }

    progress(25, `${tariffs.length} aktive Tarife geladen. Lösche alte Einträge...`);
    try {
      await supabase.from('knowledge_base').delete().eq('source_type', 'db_sync');
    } catch (err) {
      logger.warn(`[Storefront Sync] Fehler beim Bereinigen alter Einträge: ${err.message}`);
    }

    if (tariffs.length === 0) {
      progress(100, 'Fertig: Keine Tarife zum Synchronisieren gefunden.');
      return results;
    }

    const cats = await knowledgeEnricher._getCategories();
    let index = 0;

    for (const tariff of tariffs) {
      index++;
      const pct = Math.round(25 + ((index / tariffs.length) * 70));
      progress(pct, `Synchronisiere: ${tariff.name} (${tariff.country_name})`);

      // Bestimme eSIM-Kategorie
      const tType = tariff.tariff_type || 'travel';
      let simplifiedType = 'travel';
      if (tType === 'unlimited_eco') simplifiedType = 'eco';
      else if (tType === 'unlimited_pro') simplifiedType = 'pro';

      const catId = await knowledgeEnricher._getCategoryIdForTariff(simplifiedType, cats);
      const content = this._buildTariffText(tariff, shopUrl);

      try {
        const saved = await knowledgeEnricher.enrichAndStore(content, 'db_sync', catId, {
          product_id: tariff.id,
          package_code: tariff.package_code,
          slug: tariff.slug,
          tariff_type: tariff.tariff_type,
          price: tariff.sale_price_eur
        });
        results.saved += saved.length;
        if (!saved.length) results.skipped++;
      } catch (err) {
        results.errors++;
        logger.warn(`[Storefront Sync] Fehler bei ${tariff.name}: ${err.message}`);
      }

      // Rate limit protection
      await new Promise(resolve => setTimeout(resolve, 150));
    }

    progress(100, `Fertig: ${results.saved} Einträge gespeichert, ${results.errors} Fehler`);
    return results;
  },

  /**
   * Holt eine Bestellung aus der DB anhand von ID, ICCID oder Top-Up ICCID.
   */
  async getInvoice(invoiceId) {
    if (!invoiceId) return null;
    const cleanId = String(invoiceId).trim();

    let query = storefrontDb.from('orders').select('*');

    // Prüfe, ob es eine UUID ist (z. B. "550e8400-e29b-41d4-a716-446655440000")
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId);
    if (isUuid) {
      query = query.eq('id', cleanId);
    } else {
      // Suche nach ICCID, Topup-ICCID
      query = query.or(`iccid.eq.${cleanId},top_up_iccid.eq.${cleanId}`);
    }

    const { data: order, error } = await query.maybeSingle();
    if (error) {
      logger.error(`[Storefront Invoice] DB Fehler: ${error.message}`);
      throw error;
    }
    if (!order) return null;

    // Lade den Tarifnamen dazu
    let tariffName = 'eSIM Tarif';
    if (order.tariff_id) {
      try {
        const { data: tariff } = await storefrontDb
          .from('tariffs')
          .select('name')
          .eq('id', order.tariff_id)
          .maybeSingle();
        if (tariff?.name) {
          tariffName = tariff.name;
        }
      } catch (_) {}
    }

    return {
      ...order,
      tariff_name: tariffName
    };
  },

  /**
   * Formatiert Bestellungsinformationen manipulationssicher für den Kunden.
   */
  formatInvoiceForCustomer(order, shopUrl) {
    if (!order) return 'Es konnte keine Bestellung mit dieser Kennung gefunden werden.';

    const statusMap = {
      completed:    { text: 'Abgeschlossen', emoji: '✅' },
      pending:      { text: 'Ausstehend / Offen', emoji: '⏳' },
      paid:         { text: 'Bezahlt (wird verarbeitet)', emoji: '💳' },
      provisioning: { text: 'Wird eingerichtet', emoji: '🔄' },
      failed:       { text: 'Fehlgeschlagen', emoji: '❌' },
      refunded:     { text: 'Erstattet', emoji: '↩️' }
    };

    const status = statusMap[order.status] || { text: order.status, emoji: '❓' };
    const dateStr = order.created_at
      ? new Date(order.created_at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })
      : 'Unbekannt';

    const lines = [
      `<b>Bestellübersicht</b>`,
      `📄 Bestellnummer: <code>${order.id}</code>`,
      `📅 Datum: ${dateStr}`,
      `📦 Produkt: <b>${order.tariff_name}</b>`,
      `💰 Betrag: ${order.amount_eur} EUR`,
      `🚦 Status: ${status.emoji} <b>${status.text}</b>`,
    ];

    if (order.iccid) {
      lines.push(`🔑 ICCID: <code>${order.iccid}</code>`);
    }

    // Wenn bereit, zeige Installationsdetails
    if (order.status === 'completed') {
      lines.push('');
      lines.push(`⚙️ <b>eSIM Installationsdaten:</b>`);
      if (order.smdp_address) {
        lines.push(`• SM-DP+ Adresse: <code>${order.smdp_address}</code>`);
      }
      if (order.activation_code) {
        lines.push(`• Aktivierungscode: <code>${order.activation_code}</code>`);
      }
      if (order.apn) {
        lines.push(`• APN: <code>${order.apn}</code>`);
      }
      if (order.qr_code_url) {
        lines.push('');
        lines.push(`📲 <b>QR-Code zur Installation:</b>`);
        lines.push(order.qr_code_url);
      }
    } else if (order.status === 'pending') {
      const cleanShopUrl = (shopUrl || '').trim().replace(/\/$/, '');
      if (cleanShopUrl) {
        const payUrl = `${cleanShopUrl}/checkout/${order.id}`;
        lines.push('');
        lines.push(`⚠️ Zahlungslink: <a href="${payUrl}">Bezahle deine eSIM hier</a>`);
      }
    } else if (order.status === 'failed' && order.error_message) {
      lines.push('');
      lines.push(`❌ Fehler: ${order.error_message}`);
    }

    // Parse HTML tags like <b>, <code> etc. cleanly
    return lines.join('\n');
  }
};

module.exports = storefrontService;
