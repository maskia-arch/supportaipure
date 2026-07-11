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
      ? `${cleanShopUrl}/tariffs/${tariff.slug}`
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
   * Schnelle Preis-Synchronisation: Aktualisiert nur Preis-/URL-Felder in der
   * Wissensdatenbank – kein KI-Aufruf, kein Embedding-Rebuild.
   *
   * Wird aufgerufen wenn ai_sync_flag = 'update' (reine Preisänderung).
   * Sucht den KB-Eintrag per product_id und ersetzt den Preiswert direkt im Text.
   */
  async syncPriceChanges(flaggedTariffs, shopUrl, jobId) {
    const progress = (pct, step) => {
      if (jobId) syncJobManager.updateProgress(jobId, pct, step);
      logger.info(`[Price Sync] ${pct}% – ${step}`);
    };

    const results = { saved: 0, skipped: 0, errors: 0 };
    const cleanShopUrl = (shopUrl || '').trim().replace(/\/$/, '');

    progress(10, `${flaggedTariffs.length} Preis-Updates werden verarbeitet...`);

    // Lade alle relevanten KB-Einträge auf einmal (effizienter als N einzelne Abfragen)
    const productIds = flaggedTariffs.map(t => t.id).filter(Boolean);
    let existingKbRows = [];
    try {
      const { data } = await supabase
        .from('knowledge_base')
        .select('id, content, metadata')
        .eq('source_type', 'db_sync');
      existingKbRows = (data || []).filter(row => {
        const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
        return productIds.includes(meta?.product_id);
      });
    } catch (err) {
      logger.warn(`[Price Sync] Konnte KB nicht laden: ${err.message}`);
    }

    // Index: product_id → KB-Zeile
    const kbByProductId = new Map();
    for (const row of existingKbRows) {
      const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      if (meta?.product_id) kbByProductId.set(meta.product_id, { row, meta });
    }

    let idx = 0;
    for (const tariff of flaggedTariffs) {
      idx++;
      const pct = Math.round(10 + (idx / flaggedTariffs.length) * 85);
      progress(pct, `Preis-Update: ${tariff.name}`);

      const entry = kbByProductId.get(tariff.id);

      if (!entry) {
        // Kein vorhandener KB-Eintrag → als fehlend markieren für vollen Sync
        logger.info(`[Price Sync] Kein KB-Eintrag für ${tariff.name} (ID=${tariff.id}) – wird übersprungen (braucht Full-Sync)`);
        results.skipped++;
        // Flag NICHT löschen – bleibt für nächsten Full-Sync
        continue;
      }

      try {
        // Neuen Content mit aktuellem Preis und Slug generieren
        const newContent = this._buildTariffText(tariff, cleanShopUrl);
        const newMeta = {
          ...entry.meta,
          price: tariff.sale_price_eur,
          slug:  tariff.slug
        };

        await supabase
          .from('knowledge_base')
          .update({ content: newContent, metadata: newMeta })
          .eq('id', entry.row.id);

        // Sync-Flag in Storefront DB löschen
        await storefrontDb.from('tariffs').update({ ai_sync_flag: null }).eq('id', tariff.id);

        results.saved++;
        logger.info(`[Price Sync] ✓ ${tariff.name}: Preis=${tariff.sale_price_eur} EUR aktualisiert`);
      } catch (err) {
        results.errors++;
        logger.warn(`[Price Sync] Fehler bei ${tariff.name}: ${err.message}`);
      }
    }

    progress(100, `Fertig: ${results.saved} Preise aktualisiert, ${results.skipped} übersprungen, ${results.errors} Fehler`);
    return results;
  },

  /**
   * Führt die vollständige RAG-Synchronisation aus.
   * Erkennt Preisunterschiede automatisch durch Direktvergleich mit der Wissensdatenbank
   * und aktualisiert diese schnell ohne KI.
   */
  async syncToKnowledgeBase(shopUrl, jobId) {
    const progress = (pct, step) => {
      if (jobId) syncJobManager.updateProgress(jobId, pct, step);
      logger.info(`[Storefront Sync] ${pct}% – ${step}`);
    };

    const results = { saved: 0, deleted: 0, skipped: 0, errors: 0 };

    progress(5, 'Kategorien vorbereiten...');
    await knowledgeEnricher.ensureEsimCategories();

    // ── Schritt 1: Bestehende KB-Einträge laden ───────────────────────────────
    progress(10, 'Lade bestehende AI Wissensdatenbank...');
    let existingKb = [];
    try {
      const { data } = await supabase
        .from('knowledge_base')
        .select('id, content, metadata')
        .eq('source_type', 'db_sync');
      existingKb = data || [];
    } catch (err) {
      logger.warn(`[Storefront Sync] Konnte KB nicht laden: ${err.message}`);
    }

    // Map: product_id → KB row + parsed meta
    const kbByProductId = new Map();
    for (const row of existingKb) {
      try {
        const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
        if (meta?.product_id) {
          kbByProductId.set(meta.product_id, { row, meta });
        }
      } catch (e) {
        logger.warn(`[Storefront Sync] Fehler beim Parsen der Metadaten von KB-Eintrag ${row.id}: ${e.message}`);
      }
    }

    // ── Schritt 2: Tarife aus der Storefront-DB laden ─────────────────────────
    progress(15, 'Lade Tarife aus Storefront-DB...');
    let allTariffs = [];
    let flaggedTariffs = [];

    try {
      // 1. Alle aktiven Tarife
      const { data: activeData, error: activeErr } = await storefrontDb
        .from('tariffs')
        .select('*')
        .eq('is_active', true);
      if (activeErr) throw activeErr;
      allTariffs = activeData || [];

      // 2. Alle inaktiven, aber geflaggten Tarife (z. B. flag = 'delete' oder 'update')
      const { data: flaggedData, error: flagErr } = await storefrontDb
        .from('tariffs')
        .select('*')
        .not('ai_sync_flag', 'is', null);
      if (flagErr) throw flagErr;
      flaggedTariffs = flaggedData || [];
    } catch (err) {
      logger.error(`[Storefront Sync] Fehler beim Laden der Tarife: ${err.message}`);
      throw new Error(`Konnte Tarife nicht aus DB lesen: ${err.message}`);
    }

    // Merge zu einer eindeutigen Liste aller zu prüfenden Tarife (ID -> Tarif)
    const tariffMap = new Map();
    allTariffs.forEach(t => tariffMap.set(t.id, t));
    flaggedTariffs.forEach(t => tariffMap.set(t.id, t));
    const tariffs = Array.from(tariffMap.values());

    // ── Schritt 3: Kategorisieren nach Update-Typ ─────────────────────────────
    let updatePriceTariffs = [];
    let fullSyncTariffs = [];
    let deleteTariffs = [];

    for (const tariff of tariffs) {
      const kbEntry = kbByProductId.get(tariff.id);
      const hasFlag = !!tariff.ai_sync_flag;
      const isMissing = !kbEntry;

      // Falls der Tarif gelöscht werden soll (Flag 'delete' oder inaktiv und im KB vorhanden)
      if (tariff.ai_sync_flag === 'delete' || (!tariff.is_active && kbEntry)) {
        deleteTariffs.push(tariff);
        continue;
      }

      // Wenn inaktiv und nicht im KB, einfach Flagge löschen falls vorhanden
      if (!tariff.is_active) {
        if (hasFlag) {
          try { await storefrontDb.from('tariffs').update({ ai_sync_flag: null }).eq('id', tariff.id); } catch (_) {}
        }
        continue;
      }

      // Falls noch gar kein KB-Eintrag existiert → Full Sync
      if (isMissing) {
        fullSyncTariffs.push(tariff);
        continue;
      }

      // Preisvergleich: Hat sich der Preis im Storefront-Tarif im Vergleich zur KB geändert?
      const storedPrice = kbEntry.meta?.price;
      const currentPrice = tariff.sale_price_eur;
      
      const isPriceDifferent = storedPrice !== undefined && Number(storedPrice) !== Number(currentPrice);
      const isUrlDifferent = kbEntry.meta?.slug !== undefined && kbEntry.meta?.slug !== tariff.slug;

      // Wenn Flag 'update' ist ODER sich Preis/URL unterscheidet
      if (tariff.ai_sync_flag === 'update' || isPriceDifferent || isUrlDifferent) {
        updatePriceTariffs.push(tariff);
        if (isPriceDifferent) {
          logger.info(`[Storefront Sync] Preisunterschied erkannt bei ${tariff.name}: KB=${storedPrice} EUR vs. DB=${currentPrice} EUR. Stoße numerischen Preissync an.`);
        } else if (isUrlDifferent) {
          logger.info(`[Storefront Sync] URL-Unterschied erkannt bei ${tariff.name}: KB=${kbEntry.meta?.slug} vs. DB=${tariff.slug}.`);
        }
        continue;
      }

      // Wenn Flag 'new' ist oder sonstige Flags
      if (tariff.ai_sync_flag === 'new') {
        fullSyncTariffs.push(tariff);
        continue;
      }

      // Ansonsten: Keine Änderungen
      results.skipped++;
      if (hasFlag) {
        // Bereinige ungenutztes Flag
        try { await storefrontDb.from('tariffs').update({ ai_sync_flag: null }).eq('id', tariff.id); } catch (_) {}
      }
    }

    logger.info(`[Storefront Sync] Aufteilung: ${updatePriceTariffs.length} Preis-Updates, ${fullSyncTariffs.length} Full-Syncs, ${deleteTariffs.length} Deletionen`);

    // ── Schritt 4: Deletionen verarbeiten ─────────────────────────────────────
    if (deleteTariffs.length > 0) {
      progress(20, `Lösche ${deleteTariffs.length} inaktive/entfernte Tarife aus Wissensdatenbank...`);
      for (const tariff of deleteTariffs) {
        const kbEntry = kbByProductId.get(tariff.id);
        if (kbEntry) {
          try {
            await supabase.from('knowledge_base').delete().eq('id', kbEntry.row.id);
            results.deleted++;
            logger.info(`[Storefront Sync] Gelöscht aus KB: ${tariff.name}`);
          } catch (err) {
            logger.warn(`[Storefront Sync] Fehler beim Löschen von ${tariff.name}: ${err.message}`);
          }
        }
        // Flagge zurücksetzen
        try { await storefrontDb.from('tariffs').update({ ai_sync_flag: null }).eq('id', tariff.id); } catch (_) {}
      }
    }

    // ── Schritt 5: Schnelle Preis-Updates (numerisch, ohne KI) ────────────────
    if (updatePriceTariffs.length > 0) {
      progress(30, `Aktualisiere ${updatePriceTariffs.length} Preise direkt in Wissensdatenbank...`);
      const priceResults = await this.syncPriceChanges(updatePriceTariffs, shopUrl, null);
      results.saved += priceResults.saved;
      results.errors += priceResults.errors;
    }

    // ── Schritt 6: Vollständige RAG-Synchronisationen (mit KI & Embeddings) ─────
    if (fullSyncTariffs.length > 0) {
      progress(50, `Synchronisiere ${fullSyncTariffs.length} neue/fehlende Tarife mit KI...`);
      const cats = await knowledgeEnricher._getCategories();
      let index = 0;

      for (const tariff of fullSyncTariffs) {
        index++;
        const pct = Math.round(50 + ((index / fullSyncTariffs.length) * 45));
        progress(pct, `Vollständiger Sync: ${tariff.name} (${tariff.country_name})`);

        // Sicherstellen, dass kein alter KB-Eintrag existiert
        const kbEntry = kbByProductId.get(tariff.id);
        if (kbEntry) {
          try {
            await supabase.from('knowledge_base').delete().eq('id', kbEntry.row.id);
          } catch (err) {
            logger.warn(`[Storefront Sync] Fehler beim Löschen alter KB-Eintrag vor Full-Sync: ${err.message}`);
          }
        }

        const tType = tariff.tariff_type || 'travel';
        let simplifiedType = 'travel';
        if (tType === 'unlimited_eco') simplifiedType = 'eco';
        else if (tType === 'unlimited_pro') simplifiedType = 'pro';

        const catId = await knowledgeEnricher._getCategoryIdForTariff(simplifiedType, cats);
        const content = this._buildTariffText(tariff, shopUrl);

        try {
          const saved = await knowledgeEnricher.enrichAndStore(content, 'db_sync', catId, {
            product_id:   tariff.id,
            package_code: tariff.package_code,
            slug:         tariff.slug,
            tariff_type:  tariff.tariff_type,
            price:        tariff.sale_price_eur
          });
          results.saved += saved.length;

          // Flagge löschen
          try { await storefrontDb.from('tariffs').update({ ai_sync_flag: null }).eq('id', tariff.id); } catch (_) {}
        } catch (err) {
          results.errors++;
          logger.warn(`[Storefront Sync] RAG-Fehler bei ${tariff.name}: ${err.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }

    progress(100, `Fertig: ${results.saved} gespeichert, ${results.deleted} gelöscht, ${results.skipped} übersprungen, ${results.errors} Fehler`);
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
