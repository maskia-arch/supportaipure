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
   * Holt eine Bestellung aus der DB anhand von ID, INV-Nummer, UUID, Checkout-Ref,
   * Crypto-Session, ICCID oder Setup-Token.
   */
  async getInvoice(invoiceId) {
    if (!invoiceId) return null;
    let cleanId = String(invoiceId).trim();
    // Bereinige führende '#', 'INV-', 'INV:', 'INV_', Leerzeichen
    cleanId = cleanId.replace(/^#+/, '').replace(/^INV[-_:\s]*/i, '').trim();
    if (!cleanId) return null;

    // 1. Direkte Postgres-Abfrage mit Joins (schnell, unterstützt alle Varianten)
    if (storefrontDb.query) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId);
      const isShortHex = /^[0-9a-f]{6,12}$/i.test(cleanId);
      const isIccid = /^89\d{10,22}$/.test(cleanId);

      let sql = '';
      let params = [];

      if (isUuid) {
        sql = `
          SELECT o.*, t.name as tariff_name, t.country_name, t.country_code, t.flag_emoji, t.data_gb, t.validity_days
          FROM orders o
          LEFT JOIN tariffs t ON t.id = o.tariff_id
          WHERE o.id::text = $1
             OR o.checkout_ref = $1
             OR o.id::text IN (SELECT unnest(order_ids) FROM crypto_sessions WHERE id::text = $1)
          ORDER BY o.created_at DESC
          LIMIT 10
        `;
        params = [cleanId];
      } else if (isShortHex) {
        // Z. B. erste 8 Stellen aus INV-A1B2C3D4 oder #A1B2C3D4
        const prefix = cleanId.toLowerCase() + '%';
        sql = `
          SELECT o.*, t.name as tariff_name, t.country_name, t.country_code, t.flag_emoji, t.data_gb, t.validity_days
          FROM orders o
          LEFT JOIN tariffs t ON t.id = o.tariff_id
          WHERE o.id::text ILIKE $1
             OR o.checkout_ref ILIKE $1
             OR o.setup_token ILIKE $1
             OR o.id::text IN (
               SELECT unnest(order_ids) FROM crypto_sessions WHERE id::text ILIKE $1
             )
          ORDER BY o.created_at DESC
          LIMIT 10
        `;
        params = [prefix];
      } else if (isIccid) {
        sql = `
          SELECT o.*, t.name as tariff_name, t.country_name, t.country_code, t.flag_emoji, t.data_gb, t.validity_days
          FROM orders o
          LEFT JOIN tariffs t ON t.id = o.tariff_id
          WHERE o.iccid = $1 OR o.top_up_iccid = $1
          ORDER BY o.created_at DESC
          LIMIT 10
        `;
        params = [cleanId];
      } else {
        sql = `
          SELECT o.*, t.name as tariff_name, t.country_name, t.country_code, t.flag_emoji, t.data_gb, t.validity_days
          FROM orders o
          LEFT JOIN tariffs t ON t.id = o.tariff_id
          WHERE o.setup_token = $1
             OR o.id::text ILIKE $2
             OR o.checkout_ref ILIKE $2
          ORDER BY o.created_at DESC
          LIMIT 10
        `;
        params = [cleanId, cleanId + '%'];
      }

      try {
        const res = await storefrontDb.query(sql, params);
        if (res.rows && res.rows.length > 0) {
          const primary = res.rows[0];
          primary.items = res.rows;
          return primary;
        }
      } catch (err) {
        logger.error(`[Storefront Invoice] Postgres Fehler: ${err.message}`);
      }
    }

    // 2. Fallback über QueryBuilder
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId);
    let query = storefrontDb.from('orders').select('*');
    if (isUuid) {
      query = query.eq('id', cleanId);
    } else {
      query = query.or(`iccid.eq.${cleanId},top_up_iccid.eq.${cleanId},setup_token.eq.${cleanId}`);
    }

    const { data: order, error } = await query.maybeSingle();
    if (error) {
      logger.error(`[Storefront Invoice] DB Fehler: ${error.message}`);
      throw error;
    }
    if (!order) return null;

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
   * Formatiert Bestelldaten als kompakten Echtzeit-Kontext für den AI-Systemprompt.
   */
  formatInvoiceForAI(order, shopUrl) {
    if (!order) return null;
    const cleanShopUrl = (shopUrl || 'https://puresim.net').trim().replace(/\/$/, '');
    const shortId = order.id ? order.id.slice(0, 8).toUpperCase() : 'UNKNOWN';
    const orderRef = order.checkout_ref || order.id;
    const overviewUrl = `${cleanShopUrl}/order?ref=${orderRef}`;
    const setupUrl = order.setup_token ? `${cleanShopUrl}/setup-view/${order.setup_token}` : overviewUrl;

    const itemsSummary = (order.items && order.items.length > 1)
      ? order.items.map((it, idx) => `  ${idx + 1}. ${it.tariff_name || 'eSIM'} (Status: ${it.status}, ICCID: ${it.iccid || 'in Zuteilung'})`).join('\n')
      : null;

    return `ECHTZEIT-BESTELLDATEN AUS DEM PURESIM SHOP-SYSTEM:
- Bestell-ID: INV-${shortId} (Vollständige UUID: ${order.id})
- Status: ${order.status} (${order.status === 'completed' ? 'Erfolgreich abgeschlossen & eSIM aktiv' : order.status === 'paid' ? 'Bezahlt, eSIM wird beim Provider eingerichtet' : order.status === 'provisioning' ? 'Wird beim Netzbetreiber eingerichtet (1-3 Min.)' : order.status === 'pending' ? 'Zahlung noch ausstehend / offen' : order.status})
- Produkt: ${order.tariff_name || 'eSIM Paket'}
- Betrag: ${order.amount_eur ? Number(order.amount_eur).toFixed(2) + ' EUR' : 'Unbekannt'}
- Datum: ${order.created_at ? new Date(order.created_at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) : 'Unbekannt'}
${order.iccid ? `- ICCID: ${order.iccid}` : ''}
${order.smdp_address ? `- SM-DP+ Adresse: ${order.smdp_address}` : ''}
${order.activation_code ? `- Aktivierungscode: ${order.activation_code}` : ''}
- APN: ${order.apn || 'internet'}
- Link zur eSIM-Einrichtung (QR-Code): ${setupUrl}
- Link zur Bestellübersicht: ${overviewUrl}
${itemsSummary ? `- Bestellte eSIMs im Paket:\n${itemsSummary}` : ''}`;
  },

  /**
   * Formatiert Bestellungsinformationen manipulationssicher für den Kunden.
   */
  formatInvoiceForCustomer(order, shopUrl, platform = 'web_widget') {
    if (!order) return 'Es konnte keine Bestellung mit dieser Kennung gefunden werden. Bitte prüfe deine Bestell-ID oder wende dich an unseren Support.';

    const isTelegram = (platform === 'telegram');
    const cleanShopUrl = (shopUrl || 'https://puresim.net').trim().replace(/\/$/, '');
    const shortId = order.id ? order.id.slice(0, 8).toUpperCase() : 'BESTELLUNG';
    const orderRef = order.checkout_ref || order.id;
    const overviewUrl = `${cleanShopUrl}/order?ref=${orderRef}`;

    const statusMap = {
      completed:    { text: 'Aktiv / Bereit zur Installation', emoji: '✅' },
      paid:         { text: 'Bezahlt (wird eingerichtet)', emoji: '💳' },
      provisioning: { text: 'Wird eingerichtet (dauert 1–3 Min.)', emoji: '🔄' },
      pending:      { text: 'Ausstehend / Noch nicht bezahlt', emoji: '⏳' },
      failed:       { text: 'Fehlgeschlagen', emoji: '❌' },
      refunded:     { text: 'Erstattet', emoji: '↩️' },
      expired:      { text: 'Abgelaufen', emoji: '⌛' },
      cancelled:    { text: 'Storniert', emoji: '🚫' }
    };

    const status = statusMap[order.status] || { text: order.status || 'Unbekannt', emoji: 'ℹ️' };
    const dateStr = order.created_at
      ? new Date(order.created_at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })
      : 'Unbekannt';

    const b = (str) => isTelegram ? `<b>${str}</b>` : str;
    const code = (str) => isTelegram ? `<code>${str}</code>` : str;

    const countItems = (order.items && order.items.length > 1) ? order.items.length : 1;
    const title = countItems > 1 ? `📋 PureSim Bestellübersicht (${countItems} eSIMs)` : `📋 PureSim Bestellübersicht`;

    const lines = [
      b(title),
      `📄 Bestellnummer: ${code('INV-' + shortId)}`,
      `📅 Datum: ${dateStr}`,
      `📦 Produkt: ${b(order.tariff_name || 'eSIM Paket')}`,
      order.amount_eur ? `💰 Betrag: ${Number(order.amount_eur).toFixed(2)} EUR` : null,
      `🚦 Status: ${status.emoji} ${b(status.text)}`,
    ].filter(Boolean);

    if (order.iccid) {
      lines.push(`🔑 ICCID: ${code(order.iccid)}`);
    }

    // Wenn mehrere eSIMs im Paket
    if (order.items && order.items.length > 1) {
      lines.push('');
      lines.push(b('📦 Enthaltene eSIMs:'));
      order.items.forEach((it, i) => {
        const itStatus = statusMap[it.status]?.text || it.status;
        lines.push(`${i + 1}. ${b(it.tariff_name || 'eSIM')} — ${itStatus}`);
        if (it.iccid) lines.push(`   ICCID: ${code(it.iccid)}`);
        if (it.setup_token) {
          lines.push(`   Einrichtung: ${cleanShopUrl}/setup-view/${it.setup_token}`);
        }
      });
    }

    // Wenn bereit, zeige Installationsdetails
    if (order.status === 'completed') {
      lines.push('');
      lines.push(b('⚙️ Installationsdaten:'));
      if (order.smdp_address) {
        lines.push(`• SM-DP+ Adresse: ${code(order.smdp_address)}`);
      }
      if (order.activation_code) {
        lines.push(`• Aktivierungscode: ${code(order.activation_code)}`);
      }
      lines.push(`• APN: ${code(order.apn || 'internet')}`);

      if (order.setup_token) {
        const setupUrl = `${cleanShopUrl}/setup-view/${order.setup_token}`;
        lines.push('');
        lines.push(b('📲 eSIM Installation & QR-Code:'));
        lines.push(setupUrl);
      } else if (order.qr_code_url) {
        lines.push('');
        lines.push(b('📲 QR-Code zur Installation:'));
        lines.push(order.qr_code_url);
      }
    } else if (order.status === 'paid' || order.status === 'provisioning') {
      lines.push('');
      lines.push('ℹ️ Deine eSIM wird gerade beim Provider bereitgestellt (1–3 Minuten). Den aktuellen Status kannst du hier verfolgen:');
      lines.push(overviewUrl);
    } else if (order.status === 'pending') {
      lines.push('');
      lines.push('⚠️ Die Zahlung für diese Bestellung ist noch ausstehend. Hier kannst du die Bestellung abschließen:');
      lines.push(overviewUrl);
    } else if (order.status === 'failed' && order.error_message) {
      lines.push('');
      lines.push(`❌ Hinweis: ${order.error_message}`);
    }

    // Ergänzender Link zur Web-Bestellübersicht
    if (order.status === 'completed') {
      lines.push('');
      lines.push(`🌐 Alle Details online: ${overviewUrl}`);
    }

    return lines.join('\n');
  }
};

module.exports = storefrontService;
