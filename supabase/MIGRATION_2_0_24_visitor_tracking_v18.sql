-- MIGRATION_2_0_24_visitor_tracking_v18.sql
-- v1.8: Sequentielle Besucher-IDs und vollstandiges URL-Tracking

-- Sequenz-Tabelle fuer Besucher-Nummern
CREATE TABLE IF NOT EXISTS visitor_number_seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_number INTEGER DEFAULT 0
);
INSERT INTO visitor_number_seq (id, last_number) VALUES (1, 0)
  ON CONFLICT (id) DO NOTHING;

-- Sequentielle Besucher-Nummer in widget_visitors
ALTER TABLE widget_visitors ADD COLUMN IF NOT EXISTS visitor_number INTEGER;

-- Bestehende Besucher rueckwirkend nummerieren (chronologisch nach first_seen)
DO $$
DECLARE
  r RECORD;
  counter INTEGER := 0;
BEGIN
  FOR r IN
    SELECT chat_id FROM widget_visitors ORDER BY first_seen ASC
  LOOP
    counter := counter + 1;
    UPDATE widget_visitors SET visitor_number = counter WHERE chat_id = r.chat_id;
  END LOOP;
  UPDATE visitor_number_seq SET last_number = counter WHERE id = 1;
END
$$;

-- Vollstandige URLs in visitor_sessions
ALTER TABLE visitor_sessions ADD COLUMN IF NOT EXISTS entry_page_url TEXT;
ALTER TABLE visitor_sessions ADD COLUMN IF NOT EXISTS last_page_url TEXT;

-- Vollstandige URL auch in visitor_activities fuer Klickpfad-Rekonstruktion
ALTER TABLE visitor_activities ADD COLUMN IF NOT EXISTS page_url_full TEXT;
