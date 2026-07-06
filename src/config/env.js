const dotenv = require('dotenv');
dotenv.config();

// Pflicht-Variablen – App startet auch ohne sie, loggt aber eine Warnung
const required = [
  'DEEPSEEK_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'ADMIN_USERNAME', 'ADMIN_PASSWORD',
  'JWT_SECRET',
  'APP_URL'
];

required.forEach(name => {
  if (!process.env[name]) console.warn(`⚠️  Fehlende Umgebungsvariable: ${name}`);
});

if (!process.env['STOREFRONT-DB'] && !process.env.STOREFRONT_DB_URL && !process.env.STOREFRONT_DATABASE_URL) {
  console.warn(`⚠️  Fehlende Umgebungsvariable: STOREFRONT-DB (Produkt-Sync wird nicht funktionieren)`);
}

module.exports = {
  database: {
    url: process.env.DATABASE_URL,
  },
  storefrontDb: {
    url: process.env['STOREFRONT-DB'] || process.env.STOREFRONT_DB_URL || process.env.STOREFRONT_DATABASE_URL || '',
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    // Exakter API-Modellstring für "DeepSeek V4 Flash (thinking disabled)".
    // Per ENV setzbar, falls der String abweicht.
    chatModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com',
    // Exakter API-Modellstring für "GPT 5.4 Nano". Per ENV setzbar.
    chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
  },
  grok: {
    apiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY || '',
    baseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai',
    // Exakter API-Modellstring für "Grok 4.3 Non-Reasoning". Per ENV setzbar.
    chatModel: process.env.GROK_MODEL || 'grok-2-latest',
  },
  admin: {
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
    jwtSecret: process.env.JWT_SECRET || 'ai-assistant-secret-change-me'
  },
  telegram: {
    token:         process.env.TELEGRAM_BOT_TOKEN  || null,
  },
  storefront: {
    url: process.env.STOREFRONT_URL || process.env.SHOP_URL || process.env.SELLAUTH_SHOP_URL || '',
  },
  vapid: {
    publicKey:  process.env.VAPID_PUBLIC_KEY  || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
  },
  appUrl: process.env.APP_URL || '',
  port: process.env.PORT || 3000
};
