/**
 * botSecurityService.js
 *
 * Verwaltet Bot-Monitoring, Einstufung (Hilfreich vs. Angriff),
 * Herkunftsermittlung (GeoIP / ASN / Provider), Scan-Frequenzen
 * und die gezielte Sperrung von bösartigem Traffic.
 */

const crypto   = require('crypto');
const supabase = require('../config/supabase');
const logger   = require('../utils/logger');
const { isBotUserAgent, BOT_UA_REGEX } = require('../utils/botDetector');

// In-Memory-Caches für maximale Performance
const _blockedIps       = new Set();
const _blockedBotNames  = new Set();
const _geoCache         = new Map(); // ip -> { country, countryCode, city, org }
const _frequencyTracker = new Map(); // ip -> { count, windowStart }
let _autoBlockScrapers  = false;
let _blockThreshold     = 30; // Ab 30 Scans automatischer Block

// Bekannte Anbieter & Suchmaschinen für sofortige Klassifizierung ohne API-Call
const KNOWN_BOT_PROVIDERS = [
  { match: /googlebot|google-inspectiontool|storebot-google/i, name: 'Googlebot', category: 'helpful', helpful: true, org: 'Google LLC', country: 'Vereinigte Staaten', code: 'US', desc: 'Offizieller Google-Crawler. Wichtig für Sichtbarkeit und Suchindexierung.' },
  { match: /bingbot|bingpreview|msnbot/i, name: 'Bingbot', category: 'helpful', helpful: true, org: 'Microsoft Corporation', country: 'Vereinigte Staaten', code: 'US', desc: 'Offizieller Microsoft Bing Crawler für Websuche & Copilot.' },
  { match: /applebot/i, name: 'Applebot', category: 'helpful', helpful: true, org: 'Apple Inc.', country: 'Vereinigte Staaten', code: 'US', desc: 'Apple Spotlight & Siri Suchmaschinen-Crawler.' },
  { match: /duckduckbot/i, name: 'DuckDuckBot', category: 'helpful', helpful: true, org: 'DuckDuckGo Inc.', country: 'Vereinigte Staaten', code: 'US', desc: 'Datenschutz-orientierte Suchmaschine.' },
  { match: /baiduspider/i, name: 'Baiduspider', category: 'helpful', helpful: true, org: 'Baidu, Inc.', country: 'China', code: 'CN', desc: 'Führende Suchmaschine im asiatischen Raum.' },
  { match: /yandexbot|yandeximages/i, name: 'YandexBot', category: 'helpful', helpful: true, org: 'Yandex LLC', country: 'Russland / NL', code: 'RU', desc: 'Suchmaschinen-Crawler für Osteuropa.' },
  { match: /qwantify/i, name: 'Qwantify', category: 'helpful', helpful: true, org: 'Qwant SAS', country: 'Frankreich', code: 'FR', desc: 'Europäische datenschutzfreundliche Suchmaschine.' },
  { match: /sogou/i, name: 'Sogou Spider', category: 'helpful', helpful: true, org: 'Sogou Inc.', country: 'China', code: 'CN', desc: 'Chinesische Suchmaschine.' },
  { match: /petalbot/i, name: 'PetalBot', category: 'helpful', helpful: true, org: 'Huawei Software', country: 'China', code: 'CN', desc: 'Huawei Suchmaschinen-Indexierung.' },

  // Analyse / SEO / Monitoring
  { match: /ahrefsbot/i, name: 'AhrefsBot', category: 'analysis', helpful: false, org: 'Ahrefs Pte Ltd', country: 'Singapur', code: 'SG', desc: 'Kommerzieller SEO-Backlink- und Ranking-Crawler.' },
  { match: /semrushbot/i, name: 'SemrushBot', category: 'analysis', helpful: false, org: 'Semrush Inc.', country: 'Vereinigte Staaten', code: 'US', desc: 'SEO-Marktforschung und Keyword-Audit.' },
  { match: /dotbot|mj12bot|blexbot/i, name: 'SEO Spider', category: 'analysis', helpful: false, org: 'SEO Audit Network', country: 'International', code: 'XX', desc: 'Allgemeiner SEO-Crawler zur Domain-Analyse.' },
  { match: /screaming frog/i, name: 'Screaming Frog', category: 'analysis', helpful: false, org: 'Screaming Frog Ltd', country: 'Großbritannien', code: 'GB', desc: 'Lokales technisches Website-Audit-Tool.' },
  { match: /uptimerobot|pingdom|site24x7/i, name: 'Uptime Monitor', category: 'analysis', helpful: true, org: 'Monitoring Service', country: 'International', code: 'XX', desc: 'Verfügbarkeits- und Performance-Prüfung.' },

  // Aggressive Scraper / Potenzielle Angriffe
  { match: /chrome\/(1[4-9]\d|[2-9]\d\d)\./i, name: 'Headless Scraper (Fake Chrome)', category: 'malicious', helpful: false, org: 'Scraper / Proxy-Netzwerk', country: 'Unbekannt', code: '??', desc: 'Gefälschter Browser (Chrome-Version existiert nicht). Massenhaftes Scraping von Tarifen & Preisen.' },
  { match: /bytespider/i, name: 'ByteSpider', category: 'malicious', helpful: false, org: 'ByteDance Ltd.', country: 'China', code: 'CN', desc: 'Sehr aggressiver Scraper für KI-Training & Social-Media-Indexierung.' },
  { match: /headlesschrome|phantomjs|selenium|webdriver|puppeteer|playwright/i, name: 'Headless Browser / Automation', category: 'malicious', helpful: false, org: 'Automatisierung / Bot', country: 'Unbekannt', code: '??', desc: 'Headless Browser-Instanz zur Skript-Ausführung und Datenextraktion.' },
  { match: /python-requests|urllib|requests|aiohttp|scrapy/i, name: 'Python Scraper Script', category: 'malicious', helpful: false, org: 'Automatisiertes Skript', country: 'Unbekannt', code: '??', desc: 'Skript-basierter Scraper (Python). Versucht Shop-Struktur abzugreifen.' },
  { match: /curl|wget|httpclient|go-http-client|node-fetch|axios/i, name: 'HTTP Client Script', category: 'malicious', helpful: false, org: 'CLI / Backend Skript', country: 'Unbekannt', code: '??', desc: 'Konsolen-Client oder Server-Skript ohne echten Webbrowser.' }
];

class BotSecurityService {
  constructor() {
    this.initialized = false;
  }

  /**
   * Initialisiert Tabellen, lädt Blocklisten und initialisiert In-Memory-Sets.
   */
  async init() {
    if (this.initialized) return;
    this.initialized = true;

    try {
      await this._ensureTables();
      await this._loadBlockedEntities();
      // Hintergrund-Seed falls bot_logs noch leer ist
      setImmediate(() => {
        this._seedExistingBots().catch(err => {
          logger.warn('[BotSecurity] Seed-Warnung: ' + err.message);
        });
      });
      logger.info('[BotSecurity] ✅ Bot-Sicherheitsservice bereit');
    } catch (err) {
      logger.error('[BotSecurity] Init Fehler: ' + err.message);
    }
  }

  async _ensureTables() {
    try {
      // Prüfe und erstelle Tabelle bot_logs
      await supabase.from('bot_logs').select('id').limit(1).catch(async () => {
        logger.info('[BotSecurity] Erstelle bot_logs Tabelle...');
      });

      // Wir nutzen supabase.pool falls Postgres, sonst supabase Adapter
      if (supabase.pool && typeof supabase.pool.query === 'function') {
        await supabase.pool.query(`
          CREATE TABLE IF NOT EXISTS bot_logs (
            id TEXT PRIMARY KEY,
            ip TEXT NOT NULL,
            user_agent TEXT NOT NULL,
            bot_name TEXT NOT NULL,
            bot_category TEXT NOT NULL DEFAULT 'unknown',
            is_helpful BOOLEAN DEFAULT false,
            description TEXT,
            origin_country TEXT,
            origin_country_code TEXT,
            origin_city TEXT,
            origin_org TEXT,
            first_seen TIMESTAMPTZ DEFAULT NOW(),
            last_seen TIMESTAMPTZ DEFAULT NOW(),
            request_count INTEGER DEFAULT 1,
            scan_frequency TEXT,
            last_path TEXT,
            targeted_paths TEXT DEFAULT '[]',
            is_blocked BOOLEAN DEFAULT false,
            block_reason TEXT,
            blocked_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );

          CREATE INDEX IF NOT EXISTS idx_bot_logs_ip ON bot_logs(ip);
          CREATE INDEX IF NOT EXISTS idx_bot_logs_last_seen ON bot_logs(last_seen DESC);
          CREATE INDEX IF NOT EXISTS idx_bot_logs_is_blocked ON bot_logs(is_blocked);
          CREATE INDEX IF NOT EXISTS idx_bot_logs_category ON bot_logs(bot_category);

          CREATE TABLE IF NOT EXISTS bot_security_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            auto_block_scrapers BOOLEAN DEFAULT false,
            block_threshold INTEGER DEFAULT 30,
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );

          INSERT INTO bot_security_settings (id, auto_block_scrapers, block_threshold)
          VALUES (1, false, 30)
          ON CONFLICT (id) DO NOTHING;
        `);
      }
    } catch (e) {
      logger.warn('[BotSecurity] Tabellen-Setup: ' + e.message);
    }
  }

  async _loadBlockedEntities() {
    try {
      const { data: blocked } = await supabase.from('bot_logs').select('ip, bot_name').eq('is_blocked', true);
      _blockedIps.clear();
      _blockedBotNames.clear();

      for (const row of (blocked || [])) {
        if (row.ip) _blockedIps.add(row.ip.trim());
        if (row.bot_name && row.bot_name !== 'Other') _blockedBotNames.add(row.bot_name.trim());
      }

      // Settings laden
      const { data: set } = await supabase.from('bot_security_settings').select('*').eq('id', 1).maybeSingle();
      if (set) {
        _autoBlockScrapers = !!set.auto_block_scrapers;
        _blockThreshold = set.block_threshold || 30;
      }

      logger.info(`[BotSecurity] ${_blockedIps.size} blockierte IPs geladen (AutoBlock: ${_autoBlockScrapers})`);
    } catch (e) {
      logger.warn('[BotSecurity] Fehler beim Laden der Sperren: ' + e.message);
    }
  }

  /**
   * Prüft ob eine IP oder ein Bot-Name gesperrt ist.
   * Extrem schneller Check aus In-Memory Sets.
   */
  isBlocked(ip, userAgent) {
    if (!ip) return { blocked: false };
    const cleanIp = String(ip).trim();

    if (_blockedIps.has(cleanIp)) {
      return { blocked: true, reason: 'IP-Adresse wurde vom Administrator gesperrt.' };
    }

    if (userAgent) {
      for (const blockedName of _blockedBotNames) {
        if (userAgent.toLowerCase().includes(blockedName.toLowerCase())) {
          return { blocked: true, reason: `Bot "${blockedName}" wurde vom Administrator gesperrt.` };
        }
      }
    }

    return { blocked: false };
  }

  /**
   * Klassifiziert einen Bot anhand von User-Agent und Heuristik.
   */
  classifyBot(userAgent, ip) {
    const ua = String(userAgent || '').trim();

    for (const p of KNOWN_BOT_PROVIDERS) {
      if (p.match.test(ua)) {
        return {
          botName: p.name,
          category: p.category, // helpful, analysis, malicious
          isHelpful: p.helpful,
          description: p.desc,
          defaultOrg: p.org,
          defaultCountry: p.country,
          defaultCode: p.code,
        };
      }
    }

    // Fallback: Allgemeiner Scraper / Crawler
    const isBot = isBotUserAgent(ua);
    return {
      botName: isBot ? 'Unbekannter Scraper / Bot' : 'Verdächtiger Client',
      category: 'malicious',
      isHelpful: false,
      description: 'Nicht standardkonformer Webclient ohne verifizierte Suchmaschinen-Signatur.',
      defaultOrg: 'Unbekannter Host',
      defaultCountry: 'International',
      defaultCode: 'XX',
    };
  }

  /**
   * Ermittelt GeoIP / ASN für eine IP mit In-Memory Caching.
   */
  async resolveGeoIp(ip, defaultOrg, defaultCountry, defaultCode) {
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('10.') || ip.startsWith('192.168.')) {
      return {
        country: defaultCountry || 'Lokal / Intern',
        countryCode: defaultCode || 'DE',
        city: 'Netzwerk',
        org: defaultOrg || 'Interner Server'
      };
    }

    if (_geoCache.has(ip)) {
      return _geoCache.get(ip);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);

      const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city,org,as`, {
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        if (data && data.status === 'success') {
          const result = {
            country: data.country || defaultCountry || 'Unbekannt',
            countryCode: data.countryCode || defaultCode || '??',
            city: data.city || '',
            org: data.org || data.as || defaultOrg || 'Unbekannter Provider'
          };
          _geoCache.set(ip, result);
          return result;
        }
      }
    } catch (_) {}

    // Fallback auf Default-Werte
    const fallback = {
      country: defaultCountry || 'International',
      countryCode: defaultCode || 'XX',
      city: '',
      org: defaultOrg || 'Internet Provider'
    };
    _geoCache.set(ip, fallback);
    return fallback;
  }

  /**
   * Erfasst einen Bot-Aufruf, aktualisiert Statistiken, Pfade und scan frequencies.
   */
  async recordBotHit({ ip, userAgent, path, pageTitle, fingerprint }) {
    if (!ip) return;
    const cleanIp = String(ip).trim();
    const cleanPath = String(path || '').substring(0, 150);
    const ua = String(userAgent || '').substring(0, 300);

    const classification = this.classifyBot(ua, cleanIp);

    // Berechne Scan-Frequenz
    const now = Date.now();
    let tracker = _frequencyTracker.get(cleanIp);
    if (!tracker) {
      tracker = { count: 1, windowStart: now };
      _frequencyTracker.set(cleanIp, tracker);
    } else {
      tracker.count++;
      if (now - tracker.windowStart > 60000) {
        tracker.count = 1;
        tracker.windowStart = now;
      }
    }

    let scanFreq = 'Mittel';
    if (tracker.count > 10) scanFreq = 'Sehr hoch (~ alle 2-5 Sek.)';
    else if (tracker.count > 4) scanFreq = 'Hoch (~ alle 10-15 Sek.)';
    else scanFreq = 'Normal (gelegentlich)';

    // Asynchron in DB speichern ohne den aktuellen Request zu verlangsamen
    setImmediate(async () => {
      try {
        const geo = await this.resolveGeoIp(cleanIp, classification.defaultOrg, classification.defaultCountry, classification.defaultCode);

        // Suche existierenden Eintrag nach IP
        const { data: existing } = await supabase
          .from('bot_logs')
          .select('id, request_count, targeted_paths, first_seen, is_blocked')
          .eq('ip', cleanIp)
          .maybeSingle();

        if (existing) {
          const newCount = (existing.request_count || 1) + 1;
          let paths = [];
          try {
            paths = typeof existing.targeted_paths === 'string' ? JSON.parse(existing.targeted_paths) : (existing.targeted_paths || []);
          } catch (_) {}

          if (cleanPath && !paths.includes(cleanPath)) {
            paths.unshift(cleanPath);
            if (paths.length > 10) paths = paths.slice(0, 10);
          }

          // Auto-Block Prüfung für bösartige Scraper
          let shouldBlock = existing.is_blocked;
          let blockReason = null;
          let blockedAt = null;

          if (!existing.is_blocked && _autoBlockScrapers && classification.category === 'malicious' && newCount >= _blockThreshold) {
            shouldBlock = true;
            blockReason = `Auto-Block: Schwellenwert von ${_blockThreshold} aggressiven Scans erreicht.`;
            blockedAt = new Date().toISOString();
            _blockedIps.add(cleanIp);
            logger.info(`[BotSecurity] ⛔ Auto-Block ausgelöst für IP ${cleanIp} (${classification.botName})`);
          }

          await supabase.from('bot_logs').update({
            user_agent: ua,
            bot_name: classification.botName,
            bot_category: classification.category,
            is_helpful: classification.isHelpful,
            description: classification.description,
            origin_country: geo.country,
            origin_country_code: geo.countryCode,
            origin_city: geo.city,
            origin_org: geo.org,
            request_count: newCount,
            last_seen: new Date().toISOString(),
            scan_frequency: scanFreq,
            last_path: cleanPath || null,
            targeted_paths: JSON.stringify(paths),
            is_blocked: shouldBlock,
            ...(blockReason ? { block_reason: blockReason, blocked_at: blockedAt } : {})
          }).eq('id', existing.id);

        } else {
          const paths = cleanPath ? [cleanPath] : [];
          const newId = crypto.randomUUID();

          let shouldBlock = _blockedIps.has(cleanIp);
          let blockReason = shouldBlock ? 'Bereits auf Sperrliste' : null;

          await supabase.from('bot_logs').insert([{
            id: newId,
            ip: cleanIp,
            user_agent: ua,
            bot_name: classification.botName,
            bot_category: classification.category,
            is_helpful: classification.isHelpful,
            description: classification.description,
            origin_country: geo.country,
            origin_country_code: geo.countryCode,
            origin_city: geo.city,
            origin_org: geo.org,
            first_seen: new Date().toISOString(),
            last_seen: new Date().toISOString(),
            request_count: 1,
            scan_frequency: scanFreq,
            last_path: cleanPath || null,
            targeted_paths: JSON.stringify(paths),
            is_blocked: shouldBlock,
            block_reason: blockReason
          }]);
        }
      } catch (err) {
        logger.warn('[BotSecurity] RecordHit Fehler: ' + err.message);
      }
    });
  }

  /**
   * Sperrt einen Bot oder eine IP manuell.
   */
  async blockBot({ id, ip, botName, reason }) {
    const cleanReason = reason || 'Vom Administrator gesperrt';
    const now = new Date().toISOString();

    if (ip) {
      _blockedIps.add(ip.trim());
      await supabase.from('bot_logs').update({
        is_blocked: true,
        block_reason: cleanReason,
        blocked_at: now
      }).eq('ip', ip.trim());

      // Auch in generische Blacklist eintragen
      await supabase.from('blacklist').insert([{
        id: crypto.randomUUID(),
        visitor_ip: ip.trim(),
        reason: cleanReason,
        banned_by: 'admin'
      }]).catch(() => {});
    }

    if (id) {
      await supabase.from('bot_logs').update({
        is_blocked: true,
        block_reason: cleanReason,
        blocked_at: now
      }).eq('id', id);
    }

    logger.info(`[BotSecurity] ⛔ Bot/IP gesperrt: IP=${ip} Name=${botName}`);
    return { success: true };
  }

  /**
   * Entsperrt einen Bot oder eine IP.
   */
  async unblockBot({ id, ip }) {
    if (ip) {
      _blockedIps.delete(ip.trim());
      await supabase.from('bot_logs').update({
        is_blocked: false,
        block_reason: null,
        blocked_at: null
      }).eq('ip', ip.trim());

      await supabase.from('blacklist').delete().eq('visitor_ip', ip.trim()).catch(() => {});
    }

    if (id) {
      await supabase.from('bot_logs').update({
        is_blocked: false,
        block_reason: null,
        blocked_at: null
      }).eq('id', id);
    }

    logger.info(`[BotSecurity] ✅ Bot/IP freigegeben: IP=${ip}`);
    return { success: true };
  }

  /**
   * Lädt aggregierte Statistiken und gefilterte Bot-Liste für das Dashboard.
   */
  async getDashboardData({ category, status, search, page = 1, limit = 50 }) {
    await this.init();

    try {
      // 1. Alle Logs abrufen für Statistik
      let query = supabase.from('bot_logs').select('*');

      if (category && category !== 'all') {
        if (category === 'helpful') query = query.eq('is_helpful', true);
        else if (category === 'malicious') query = query.eq('bot_category', 'malicious');
        else if (category === 'analysis') query = query.eq('bot_category', 'analysis');
      }

      if (status === 'blocked') {
        query = query.eq('is_blocked', true);
      } else if (status === 'active') {
        query = query.eq('is_blocked', false);
      }

      const { data: allRows } = await query.order('last_seen', { ascending: false });
      const rows = allRows || [];

      // Gefilterte Suche
      let filtered = rows;
      if (search && search.trim()) {
        const s = search.trim().toLowerCase();
        filtered = rows.filter(r =>
          (r.ip && r.ip.toLowerCase().includes(s)) ||
          (r.bot_name && r.bot_name.toLowerCase().includes(s)) ||
          (r.origin_country && r.origin_country.toLowerCase().includes(s)) ||
          (r.origin_org && r.origin_org.toLowerCase().includes(s)) ||
          (r.last_path && r.last_path.toLowerCase().includes(s))
        );
      }

      // KPIs berechnen
      let totalScans = 0;
      let helpfulCount = 0;
      let maliciousCount = 0;
      let analysisCount = 0;
      let blockedCount = 0;

      for (const r of rows) {
        totalScans += (r.request_count || 1);
        if (r.is_blocked) blockedCount++;
        if (r.is_helpful) helpfulCount++;
        else if (r.bot_category === 'malicious') maliciousCount++;
        else if (r.bot_category === 'analysis') analysisCount++;
      }

      // Paginierung
      const offset = (page - 1) * limit;
      const paginated = filtered.slice(offset, offset + limit).map(r => {
        let paths = [];
        try {
          paths = typeof r.targeted_paths === 'string' ? JSON.parse(r.targeted_paths) : (r.targeted_paths || []);
        } catch (_) {}

        return {
          id: r.id,
          ip: r.ip,
          userAgent: r.user_agent,
          botName: r.bot_name,
          category: r.bot_category,
          isHelpful: r.is_helpful,
          description: r.description,
          originCountry: r.origin_country,
          originCountryCode: r.origin_country_code,
          originCity: r.origin_city,
          originOrg: r.origin_org,
          firstSeen: r.first_seen,
          lastSeen: r.last_seen,
          requestCount: r.request_count || 1,
          scanFrequency: r.scan_frequency || 'Normal',
          lastPath: r.last_path,
          targetedPaths: paths,
          isBlocked: !!r.is_blocked,
          blockReason: r.block_reason
        };
      });

      return {
        stats: {
          totalBots: rows.length,
          helpfulCount,
          analysisCount,
          maliciousCount,
          blockedCount,
          totalScans,
          autoBlockEnabled: _autoBlockScrapers,
          blockThreshold: _blockThreshold
        },
        bots: paginated,
        total: filtered.length,
        page,
        limit
      };
    } catch (err) {
      logger.error('[BotSecurity] getDashboardData Fehler: ' + err.message);
      return {
        stats: { totalBots: 0, helpfulCount: 0, analysisCount: 0, maliciousCount: 0, blockedCount: 0, totalScans: 0, autoBlockEnabled: false },
        bots: [],
        total: 0
      };
    }
  }

  /**
   * Aktualisiert Auto-Block Einstellungen.
   */
  async updateSettings({ autoBlockScrapers, blockThreshold }) {
    if (autoBlockScrapers !== undefined) _autoBlockScrapers = !!autoBlockScrapers;
    if (blockThreshold !== undefined && Number(blockThreshold) > 0) _blockThreshold = Number(blockThreshold);

    await supabase.from('bot_security_settings').upsert({
      id: 1,
      auto_block_scrapers: _autoBlockScrapers,
      block_threshold: _blockThreshold,
      updated_at: new Date().toISOString()
    }).catch(() => {});

    logger.info(`[BotSecurity] Settings aktualisiert: AutoBlock=${_autoBlockScrapers}, Schwelle=${_blockThreshold}`);
    return {
      autoBlockScrapers: _autoBlockScrapers,
      blockThreshold: _blockThreshold
    };
  }

  /**
   * Seedet vorhandene Bots aus widget_visitors beim ersten Start.
   */
  async _seedExistingBots() {
    try {
      const { data: countCheck } = await supabase.from('bot_logs').select('id').limit(1);
      if (countCheck && countCheck.length > 0) return; // Bereits Daten vorhanden

      logger.info('[BotSecurity] Starte Initial-Seed aus widget_visitors...');
      const { data: visitors } = await supabase
        .from('widget_visitors')
        .select('ip, user_agent, last_seen, first_seen')
        .order('last_seen', { ascending: false })
        .limit(1000);

      if (!visitors || !visitors.length) return;

      const groupedByIp = new Map();
      for (const v of visitors) {
        if (!v.ip || !isBotUserAgent(v.user_agent)) continue;
        const cleanIp = v.ip.trim();
        if (!groupedByIp.has(cleanIp)) {
          groupedByIp.set(cleanIp, {
            ip: cleanIp,
            ua: v.user_agent,
            firstSeen: v.first_seen || v.last_seen,
            lastSeen: v.last_seen,
            count: 1
          });
        } else {
          const entry = groupedByIp.get(cleanIp);
          entry.count++;
          if (new Date(v.last_seen) > new Date(entry.lastSeen)) entry.lastSeen = v.last_seen;
        }
      }

      logger.info(`[BotSecurity] Seed: ${groupedByIp.size} eindeutige Bot-IPs gefunden. Speichere...`);

      for (const [ip, entry] of groupedByIp.entries()) {
        const classification = this.classifyBot(entry.ua, ip);
        const geo = await this.resolveGeoIp(ip, classification.defaultOrg, classification.defaultCountry, classification.defaultCode);

        let scanFreq = 'Normal';
        if (entry.count > 10) scanFreq = 'Hoch (~ alle 10 Sek.)';
        else if (entry.count > 3) scanFreq = 'Mittel';

        await supabase.from('bot_logs').insert([{
          id: crypto.randomUUID(),
          ip: ip,
          user_agent: entry.ua,
          bot_name: classification.botName,
          bot_category: classification.category,
          is_helpful: classification.isHelpful,
          description: classification.description,
          origin_country: geo.country,
          origin_country_code: geo.countryCode,
          origin_city: geo.city,
          origin_org: geo.org,
          first_seen: entry.firstSeen || new Date().toISOString(),
          last_seen: entry.lastSeen || new Date().toISOString(),
          request_count: entry.count,
          scan_frequency: scanFreq,
          last_path: '/tariffs/sitemap',
          targeted_paths: JSON.stringify(['/tariffs/sitemap']),
          is_blocked: false
        }]).catch(() => {});
      }

      logger.info('[BotSecurity] Initial-Seed erfolgreich abgeschlossen.');
    } catch (e) {
      logger.warn('[BotSecurity] Seed-Fehler: ' + e.message);
    }
  }
}

module.exports = new BotSecurityService();
