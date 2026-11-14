-- MIGRATION 2.0.27: Bot Security & Traffic Filter
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
