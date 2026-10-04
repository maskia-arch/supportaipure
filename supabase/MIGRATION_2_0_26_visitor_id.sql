-- MIGRATION_2_0_26_visitor_id.sql
-- Sicherstellen, dass widget_visitors über visitor_id und visitor_number verfügt
-- Verhindert Duplikate und Nummernsprünge bei wiederkehrenden Besuchern

ALTER TABLE widget_visitors ADD COLUMN IF NOT EXISTS visitor_id TEXT;
CREATE INDEX IF NOT EXISTS idx_widget_visitors_visitor_id ON widget_visitors(visitor_id);

ALTER TABLE widget_visitors ADD COLUMN IF NOT EXISTS visitor_number INTEGER;
ALTER TABLE widget_visitors ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE widget_visitors ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE widget_visitors ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_widget_visitors_email ON widget_visitors(customer_email);

ALTER TABLE chats ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS customer_name TEXT;
CREATE INDEX IF NOT EXISTS idx_chats_email ON chats(customer_email);

-- Mehrsprachige Begrüßung in settings
ALTER TABLE settings ADD COLUMN IF NOT EXISTS welcome_message_en TEXT;

UPDATE settings
SET welcome_message_en = 'Hello! 👋 I am your personal eSIM assistant. ✈️

To help me find the perfect plan for you, please let me know:
1️⃣ Which country are you traveling to?
2️⃣ How long will you be staying?
3️⃣ About how much data do you need (e.g. for social media, navigation, or general browsing)?

Let''s find the right plan for you right away! 🚀'
WHERE id = 1 AND (welcome_message_en IS NULL OR welcome_message_en = '');
