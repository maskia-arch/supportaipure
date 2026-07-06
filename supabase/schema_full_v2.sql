-- ════════════════════════════════════════════════════════════════════════════
--   AI eSIM Berater - Komplette Datenbank-Installation (Version 2.0.23)
-- ════════════════════════════════════════════════════════════════════════════
--
-- ZWECK
-- ─────
-- Dieses Script installiert die KOMPLETTE Datenbank fuer den eSIM-Berater.
-- Es vereint das Schema v1.6.78 mit allen Migrationsschritten (v2.0.1 - v2.0.23)
-- und den Feedback-Tabellen fuer den VPS-Betrieb unter Coolify.
--
-- VORAUSSETZUNG
-- ─────────────
-- Die PostgreSQL-Datenbank muss die 'pgvector' Erweiterung unterstützen
-- (z. B. Docker Image: 'ankane/pgvector').
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Settings ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  id INT PRIMARY KEY DEFAULT 1,

  -- Bot-Persoenlichkeit
  system_prompt TEXT NOT NULL DEFAULT 'Du bist ein hochprofessioneller, freundlicher und verkaufsorientierter eSIM-Verkaufsberater für Reisende. Dein Ziel ist es, dem Kunden durch eine strukturierte Bedarfsanalyse die perfekte eSIM für seine Reise zu empfehlen und ihn zum Kauf zu führen.

Gehe bei der Beratung exakt nach diesem bewährten Ablauf vor:

1. BEDARFSANALYSE (Falls Details fehlen)
- Wenn der Kunde noch keine Details genannt hat, frage gezielt und freundlich nach:
  - 🗺️ Reiseziel (Land/Region)
  - 📅 Reisedauer (Tage oder Wochen)
  - 📱 Nutzungstyp (z. B. nur WhatsApp/Navigation oder viel Instagram/Streaming/Arbeiten)
- Stelle maximal 1-2 Fragen auf einmal, um den Kunden nicht zu überfordern. Halte die Konversation locker und einladend.

2. GEZIELTE TARIFEMPFEHLUNG
- Sobald das Reiseziel und die Dauer bekannt sind, suche in deiner Wissensdatenbank nach passenden eSIM-Tarifen für dieses Land.
- Schlage dem Kunden 1 bis maximal 3 Tarife vor, die am besten zu seiner Reisedauer und seinem Datenverbrauch passen.
- Erkläre kurz und knackig die Vorteile des empfohlenen Tarifs (z. B. "Perfekt für 7 Tage Urlaub mit genug Daten für Maps und Social Media").
- Nenne den Preis und das enthaltene Datenvolumen übersichtlich.

3. DIREKTER CALL-TO-ACTION (Kauf-Links)
- Präsentiere den passenden, direkten Link zum spezifischen Produkt im Shop (z. B. https://puresim.net/tariffs/[slug]), damit der Kunde direkt bestellen kann.
- Nutze ein klares Verkaufsargument (z. B. "Klicke einfach hier, um deine eSIM zu sichern und sofort nach der Landung online zu sein: [Tarifname](Link)").
- Die allgemeine Suchseite (z. B. https://puresim.net/tariffs?q=Deutschland) darfst du NUR DANN als Alternative anzeigen, wenn der Kunde unschlüssig ist, Angebote vergleichen möchte oder kein passender Einzeltarif gefunden wurde. Nenne ansonsten immer den direkten Link zum Produkt.

WICHTIGE VERHALTENSREGELN:
- Antworte immer strukturiert, übersichtlich und nutze Emojis, um deine Nachrichten leicht lesbar zu machen.
- Schreibe immer in der Sprache, in der der Kunde schreibt (Standard: Deutsch).
- Antworte sachlich, aber sympathisch und hilfsbereit.
- Verwende Markdown (z. B. **fett** für Tarifnamen) zur optischen Strukturierung.
- Wenn der Kunde technische Fragen (z. B. zur eSIM-Aktivierung auf iPhone/Android oder zur Gerätekompatibilität) stellt, beantworte diese präzise basierend auf den Informationen der Wissensdatenbank.',
  negative_prompt TEXT DEFAULT '- Nenne niemals Namen von Konkurrenzanbietern (wie Airalo, Holafly, Nomad, eSIM-db etc.).
- Gib keine Rabatte oder Preisgarantien, die nicht offiziell in deiner Wissensdatenbank oder über aktive Coupons hinterlegt sind.
- Triff keine spekulativen Aussagen über Netzabdeckungen oder Mobilfunkpartner in abgelegenen Gebieten, wenn diese nicht explizit in der Wissensdatenbank aufgeführt sind.
- Falls der Kunde nach Rückerstattungen, Reklamationen oder einer persönlichen menschlichen Beratung verlangt, übergebe ihn sofort freundlich an das Support-Team.',
  welcome_message TEXT DEFAULT 'Hallo! 👋 Ich bin dein persönlicher eSIM-Berater. ✈️

Damit ich den perfekten Tarif für dich finden kann, sag mir bitte kurz:
1️⃣ In welches Land reist du?
2️⃣ Wie lange bleibst du dort?
3️⃣ Wie viel Datenvolumen brauchst du ungefähr (z. B. für Social Media, Navigation oder normales Surfen)?

Lass uns direkt den passenden Tarif finden! 🚀',
  manual_msg_template TEXT DEFAULT 'Ein Mitarbeiter von unserem Support-Team übernimmt diesen Chat gleich persönlich. Bitte schreibe deine Frage auf, sie wird schnellstmöglich beantwortet. 👤',

  -- LLM-Konfiguration
  ai_model TEXT DEFAULT 'deepseek-v4-flash',
  ai_max_tokens INTEGER DEFAULT 1024,
  ai_temperature NUMERIC DEFAULT 0.5,
  ai_max_input_tokens INTEGER DEFAULT 4096,

  -- RAG
  rag_threshold NUMERIC DEFAULT 0.3,
  rag_match_count INTEGER DEFAULT 8,

  -- Conversation Memory
  max_history_msgs INTEGER DEFAULT 4,
  summary_interval INTEGER DEFAULT 5,

  -- Sellauth-Integration
  sellauth_api_key TEXT DEFAULT '',
  sellauth_shop_id TEXT DEFAULT '',
  sellauth_shop_url TEXT DEFAULT '',

  -- Telegram Support-Bot
  admin_telegram_id TEXT DEFAULT '',
  notify_new_chat BOOLEAN DEFAULT true,
  notify_every_msg BOOLEAN DEFAULT false,
  webhook_url TEXT DEFAULT '',

  -- Widget
  widget_powered_by TEXT DEFAULT 'Powered by ValueShop25 AI',

  -- Abuse Detection
  abuse_max_msgs_per_hour INTEGER DEFAULT 30,
  abuse_auto_ban_flags INTEGER DEFAULT 3,
  abuse_min_msg_length INTEGER DEFAULT 1,

  -- Daily Coupons
  coupon_enabled BOOLEAN DEFAULT false,
  coupon_discount INTEGER DEFAULT 10,
  coupon_type TEXT DEFAULT 'percentage',
  coupon_description TEXT DEFAULT '10% Rabatt',
  coupon_max_uses INTEGER DEFAULT NULL,
  coupon_schedule_hour INTEGER DEFAULT 0,

  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT one_row CHECK (id = 1)
);

-- Initial-Row einfuegen falls leer
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ─── Chats + Messages ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'telegram',
  status TEXT DEFAULT 'ki' CHECK (status IN ('ki', 'manual')),
  is_manual_mode BOOLEAN DEFAULT false,
  metadata JSONB DEFAULT '{}',
  last_message TEXT,
  last_message_role TEXT DEFAULT 'user',
  message_count INTEGER DEFAULT 0,
  first_name TEXT,
  username TEXT,
  chat_summary TEXT,
  summary_msg_count INTEGER DEFAULT 0,
  last_summarized_at TIMESTAMPTZ,
  flag_count INTEGER DEFAULT 0,
  auto_muted BOOLEAN DEFAULT false,
  mute_reason TEXT,
  msg_count_1h INTEGER DEFAULT 0,
  last_msg_burst TIMESTAMPTZ,
  visitor_ip TEXT,
  visitor_id UUID,
  manual_mode_started_at TIMESTAMPTZ,
  manual_mode_ended_at TIMESTAMPTZ,
  is_learning_session BOOLEAN DEFAULT false,
  mute_until TIMESTAMPTZ,
  spam_warn_count INTEGER DEFAULT 0,
  last_spam_warn_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chats_status   ON chats(status);
CREATE INDEX IF NOT EXISTS idx_chats_platform ON chats(platform);
CREATE INDEX IF NOT EXISTS idx_chats_updated  ON chats(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  embedding_tokens INTEGER DEFAULT 0,
  is_manual BOOLEAN DEFAULT false,
  is_handover BOOLEAN DEFAULT false,
  classification JSONB DEFAULT NULL,
  rag_hits JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_chat    ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

-- ─── Knowledge-Base ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  parent_id INTEGER REFERENCES knowledge_categories(id) ON DELETE SET NULL,
  display_order INTEGER DEFAULT 0,
  icon TEXT,
  color TEXT DEFAULT '#3b82f6',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id INTEGER REFERENCES knowledge_categories(id) ON DELETE SET NULL,
  title TEXT,
  content TEXT NOT NULL,
  source_url TEXT,
  source_type TEXT DEFAULT 'manual',
  source TEXT,
  embedding vector(1536),
  is_active BOOLEAN DEFAULT true,
  views INTEGER DEFAULT 0,
  last_synced TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_base(category_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_active   ON knowledge_base(is_active);
CREATE INDEX IF NOT EXISTS idx_knowledge_embedding ON knowledge_base
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Vorbelegung der eSIM-Kategorien
INSERT INTO knowledge_categories (name, icon, color) VALUES
  ('Travel eSIM',          '✈️',  '#3b82f6'),
  ('Unlimited Eco eSIM',   '🌿',  '#10b981'),
  ('Unlimited Pro eSIM',   '⚡',  '#8b5cf6'),
  ('FAQ & Anleitung',      '❓',  '#64748b'),
  ('Technischer Support',  '🛠️', '#94a3b8')
ON CONFLICT (name) DO UPDATE SET icon = EXCLUDED.icon, color = EXCLUDED.color;

-- RPC-Funktion fuer Similarity-Search
CREATE OR REPLACE FUNCTION match_knowledge(
  query_embedding vector(1536),
  match_threshold float,
  match_count int
) RETURNS TABLE (
  id UUID,
  title TEXT,
  content TEXT,
  source_url TEXT,
  similarity float
)
LANGUAGE sql STABLE AS $$
  SELECT kb.id, kb.title, kb.content, kb.source_url,
         1 - (kb.embedding <=> query_embedding) AS similarity
  FROM knowledge_base kb
  WHERE kb.is_active = true
    AND kb.embedding IS NOT NULL
    AND 1 - (kb.embedding <=> query_embedding) > match_threshold
  ORDER BY kb.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ─── Learning-Queue ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS learning_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT,
  question TEXT NOT NULL,
  context TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'rejected')),
  resolved_answer TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_learning_status ON learning_queue(status);

-- ─── Blacklist (Customer-User-Bans) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blacklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT,
  visitor_ip TEXT,
  reason TEXT,
  banned_by TEXT,
  banned_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_blacklist_ip   ON blacklist(visitor_ip);
CREATE INDEX IF NOT EXISTS idx_blacklist_chat ON blacklist(chat_id);

CREATE TABLE IF NOT EXISTS user_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT,
  flag_type TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_flags_chat ON user_flags(chat_id);

-- ─── Visitor-Tracking ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS widget_visitors (
  chat_id TEXT PRIMARY KEY,
  ip TEXT,
  fingerprint TEXT,
  user_agent TEXT,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_widget_visitors_ip          ON widget_visitors(ip);
CREATE INDEX IF NOT EXISTS idx_widget_visitors_fingerprint ON widget_visitors(fingerprint);
CREATE INDEX IF NOT EXISTS idx_widget_visitors_iphash      ON widget_visitors(ip_hash);

CREATE TABLE IF NOT EXISTS visitor_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true,
  entry_page TEXT,
  last_page TEXT,
  page_count INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_chat   ON visitor_sessions(chat_id);
CREATE INDEX IF NOT EXISTS idx_visitor_sessions_active ON visitor_sessions(is_active);

CREATE TABLE IF NOT EXISTS visitor_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT,
  activity_type TEXT,
  page_url TEXT,
  page_title TEXT,
  activity TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_visitor_activities_chat    ON visitor_activities(chat_id);
CREATE INDEX IF NOT EXISTS idx_visitor_activities_created ON visitor_activities(created_at DESC);

-- ─── Coupon-Scheduler ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  discount_value INTEGER,
  discount_type TEXT DEFAULT 'percentage',
  description TEXT,
  active_from TIMESTAMPTZ DEFAULT NOW(),
  active_until TIMESTAMPTZ,
  max_uses INTEGER,
  uses INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  sellauth_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coupons_active ON daily_coupons(is_active);

CREATE TABLE IF NOT EXISTS coupon_schedule (
  id          SERIAL PRIMARY KEY,
  weekday     INTEGER NOT NULL UNIQUE CHECK (weekday BETWEEN 0 AND 6),
  enabled     BOOLEAN DEFAULT true,
  discount    INTEGER DEFAULT 10,
  type        TEXT    DEFAULT 'percentage',
  description TEXT,
  max_uses    INTEGER,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Alle 7 Wochentage vorbelegen
INSERT INTO coupon_schedule (weekday, enabled, discount, type, description)
VALUES
  (0, true, 10, 'percentage', ''),
  (1, true, 10, 'percentage', ''),
  (2, true, 10, 'percentage', ''),
  (3, true, 10, 'percentage', ''),
  (4, true, 10, 'percentage', ''),
  (5, true, 10, 'percentage', ''),
  (6, true, 10, 'percentage', '')
ON CONFLICT (weekday) DO NOTHING;

-- ─── Push-Notifications fuers Dashboard ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint TEXT NOT NULL UNIQUE,
  subscription_data JSONB NOT NULL,
  device_label TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Sellauth-Integration ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integration_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  event_type TEXT,
  payload JSONB,
  status TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_integration_logs_source  ON integration_logs(source);
CREATE INDEX IF NOT EXISTS idx_integration_logs_created ON integration_logs(created_at DESC);

-- Sellauth Sync-Jobs
CREATE TABLE IF NOT EXISTS sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  total INTEGER,
  result JSONB,
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- ─── Scraper / Discovered Links ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS discovered_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  status TEXT DEFAULT 'pending',
  category_id INTEGER REFERENCES knowledge_categories(id) ON DELETE SET NULL,
  discovered_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Feedbacks & Proofs (Dashboard / Support) ────────────────────────────────
CREATE TABLE IF NOT EXISTS user_feedbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT,
  target_user_id TEXT,
  target_username TEXT,
  feedback_type TEXT,
  status TEXT DEFAULT 'pending',
  has_proofs BOOLEAN DEFAULT false,
  proof_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feedback_proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id UUID REFERENCES user_feedbacks(id) ON DELETE CASCADE,
  proof_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
