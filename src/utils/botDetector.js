/**
 * botDetector.js
 *
 * Präzise Erkennung von Crawlern, Suchmaschinen-Bots, Scrapern und Headless-Browsern.
 * Verhindert, dass Bots in widget_visitors gespeichert werden und Web-Push-Benachrichtigungen
 * ("Neuer Besucher") auslösen.
 */

const BOT_UA_REGEX = /(googlebot|bingbot|bingpreview|msnbot|baiduspider|yandexbot|yandeximages|duckduckbot|slurp|applebot|teoma|qwantify|sogou|ahrefsbot|semrushbot|dotbot|mj12bot|petalbot|bytespider|screaming frog|siteaudit|zoominfobot|dataforseobot|blexbot|criteobot|seznam|curl|wget|python|urllib|requests|aiohttp|scrapy|httpclient|java\/|go-http-client|node-fetch|axios|postman|okhttp|libwww|headlesschrome|headless|phantomjs|selenium|webdriver|puppeteer|playwright|electron|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|site24x7|uptimemonitor|facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|telegrambot|whatsapp|discordbot|pinterest|\bbot\b|\bcrawler\b|\bspider\b|\bscraper\b|crawling|archiver|\+http)/i;

/**
 * Prüft ob ein User-Agent von einem Bot, Crawler oder Scraper stammt.
 * @param {string} ua
 * @returns {boolean}
 */
function isBotUserAgent(ua) {
  if (!ua || typeof ua !== 'string' || ua.trim().length < 8) return true;
  if (BOT_UA_REGEX.test(ua)) return true;
  // Gefälschte zukünftige Chrome-Versionen (z. B. Chrome/148, Chrome/149, Chrome/150 von Scraper-Netzwerken)
  if (/Chrome\/(1[3-9]\d|[2-9]\d\d)\./i.test(ua)) return true;
  return false;
}

/**
 * Prüft ob ein eingehender HTTP-Request von einem Bot oder Crawler stammt.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isBot(req) {
  if (!req) return false;

  const ua = (req.headers && req.headers['user-agent']) || '';
  if (isBotUserAgent(ua)) {
    return true;
  }

  // Pre-fetch oder Preview Header
  const purpose = (req.headers['x-purpose'] || req.headers['purpose'] || req.headers['x-moz'] || '').toLowerCase();
  if (purpose === 'preview' || purpose === 'prefetch') {
    return true;
  }

  // Client-seitiges Bot-Flag (aus dem Storefront-Payload)
  if (req.body && req.body.isBot === true) {
    return true;
  }

  // Fingerprint-Prüfung
  const fp = (req.body && (req.body.fingerprint || req.body.fp)) || '';
  if (typeof fp === 'string') {
    if (BOT_UA_REGEX.test(fp) || /Chrome\/(1[3-9]\d|[2-9]\d\d)\./i.test(fp)) {
      return true;
    }
  }

  return false;
}

module.exports = {
  isBot,
  isBotUserAgent,
  BOT_UA_REGEX,
};
