-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 2.0.1 – Fehlende Spalten hinzufügen
-- Ausführen in: Supabase → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) blacklist: created_at Spalte hinzufügen (Code nutzte created_at, DB hatte nur banned_at)
ALTER TABLE blacklist
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

UPDATE blacklist
  SET created_at = COALESCE(banned_at, NOW())
  WHERE created_at IS NULL;

ALTER TABLE blacklist
  ALTER COLUMN created_at SET DEFAULT NOW();

-- 2) knowledge_base: source Spalte als Alias für source_type hinzufügen
--    (Optional – Code wurde auf source_type umgestellt; diese Spalte dient
--     als Rückwärtskompatibilität falls noch andere Abfragen source nutzen)
ALTER TABLE knowledge_base
  ADD COLUMN IF NOT EXISTS source TEXT;

UPDATE knowledge_base
  SET source = source_type
  WHERE source IS NULL AND source_type IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- Migration abgeschlossen ✅
-- ═══════════════════════════════════════════════════════════════════════════
