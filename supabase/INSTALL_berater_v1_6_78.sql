-- ════════════════════════════════════════════════════════════════════════════
--   AI eSIM Berater - Komplette Datenbank-Installation (Version 1.6.78)
-- ════════════════════════════════════════════════════════════════════════════
--
-- ZWECK
-- ─────
-- Dieses Script installiert die KOMPLETTE Datenbank fuer den eSIM-Berater
-- in einer FRISCHEN Supabase-Datenbank. Vorgehen:
--
--   1) Neues Supabase-Projekt erstellen
--   2) Im SQL-Editor: dieses Script ausfuehren
--   3) ENV-Variablen in Render setzen (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
--   4) AdminHelper bleibt in der ALTEN Datenbank - getrennt von dieser hier
--
-- TABELLEN
-- ────────
--   • settings              - Bot-Konfiguration
--   • chats / messages      - Customer-Chats + Verlauf
--   • knowledge_*           - Wissensbasis fuer RAG
--   • learning_queue        - Unbeantwortete Fragen
--   • blacklist             - Customer-Bans
--   • visitor_*             - Website-Besucher-Tracking
--   • widget_visitors       - Persistente Visitor-IDs
--   • daily_coupons         - Taegliche Aktionscodes
--   • coupon_schedule       - Wochenplan fuer Coupons
--   • admin_subscriptions   - Push-Notifications fuer Dashboard
--   • integration_logs      - Sellauth-Sync-Logs
--   • user_flags            - Spam/Abuse-Markierungen
--
-- pgvector-Extension wird benoetigt fuer Embeddings.
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Settings ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  id INT PRIMARY KEY DEFAULT 1,

  -- Bot-Persoenlichkeit
  system_prompt TEXT NOT NULL DEFAULT 'Du bist ein hilfreicher Assistent fuer eSIM-Beratung.',
  negative_prompt TEXT DEFAULT '',
  welcome_message TEXT DEFAULT 'Hallo! 👋 Wie kann ich dir helfen?',
  manual_msg_template TEXT DEFAULT 'Ein Mitarbeiter wird gleich uebernehmen.',

  -- LLM-Konfiguration
  ai_model TEXT DEFAULT 'deepseek-chat',
  ai_max_tokens INTEGER DEFAULT 1024,
  ai_temperature NUMERIC DEFAULT 0.5,
  ai_max_input_tokens INTEGER DEFAULT 4096,

  -- RAG
  rag_threshold NUMERIC DEFAULT 0.45,
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
  widget_powered_by TEXT DEFAULT 'Powered by PureSim AI',

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
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id INTEGER REFERENCES knowledge_categories(id) ON DELETE SET NULL,
  title TEXT,
  content TEXT NOT NULL,
  source_url TEXT,
  source_type TEXT DEFAULT 'manual',
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
  banned_at TIMESTAMPTZ DEFAULT NOW()
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
  metadata JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_widget_visitors_ip          ON widget_visitors(ip);
CREATE INDEX IF NOT EXISTS idx_widget_visitors_fingerprint ON widget_visitors(fingerprint);

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
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coupons_active ON daily_coupons(is_active);

CREATE TABLE IF NOT EXISTS coupon_schedule (
  id SERIAL PRIMARY KEY,
  day_of_week INTEGER CHECK (day_of_week BETWEEN 0 AND 6),
  hour INTEGER CHECK (hour BETWEEN 0 AND 23),
  discount_value INTEGER,
  discount_type TEXT DEFAULT 'percentage',
  description TEXT,
  is_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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

-- ════════════════════════════════════════════════════════════════════════════
--   FERTIG. Naechste Schritte:
--   1. Render-Deploy mit ENV-Variablen:
--      - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (NEU - dieses Projekt!)
--      - DEEPSEEK_API_KEY, OPENAI_API_KEY (fuer Embeddings)
--      - TELEGRAM_BOT_TOKEN (Support-Bot)
--      - ADMIN_USERNAME, ADMIN_PASSWORD, JWT_SECRET
--      - VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (Push-Notifications)
--      - APP_URL (https://dein-berater.onrender.com)
--   2. Im Dashboard einloggen, unter Settings:
--      - System-Prompt anpassen
--      - Sellauth-API-Key + Shop-ID eintragen
--      - Sellauth sync starten
--   3. Widget-Embed auf Website einbauen:
--      <script async src="https://dein-berater.onrender.com/widget.js"></script>
-- ════════════════════════════════════════════════════════════════════════════
