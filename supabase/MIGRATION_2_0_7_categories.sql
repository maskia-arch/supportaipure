-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 2.0.7 — eSIM Wissensdatenbank Kategorien
-- Ausführen in: Supabase → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Fehlende Spalten zu knowledge_categories hinzufügen
ALTER TABLE knowledge_categories
  ADD COLUMN IF NOT EXISTS icon  TEXT,
  ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#3b82f6';

-- 2) eSIM-Kategorien anlegen (ON CONFLICT: bestehende nur updaten, nicht löschen)
INSERT INTO knowledge_categories (name, icon, color) VALUES
  ('Produkte & Tarife',          '📦', '#3b82f6'),
  ('Europa eSIM',                '🇪🇺', '#10b981'),
  ('Türkei eSIM',                '🇹🇷', '#f59e0b'),
  ('Asien & Pazifik eSIM',       '🌏', '#8b5cf6'),
  ('Amerika eSIM',               '🌎', '#ef4444'),
  ('Naher Osten & Afrika eSIM',  '🌍', '#f97316'),
  ('Weltweit / Global eSIM',     '🌐', '#06b6d4'),
  ('Unlimited Tarife',           '♾️', '#ec4899'),
  ('Kurzzeit-eSIMs',             '⚡', '#eab308'),
  ('Langzeit-eSIMs',             '🗓️', '#14b8a6'),
  ('FAQ & Anleitung',            '❓', '#64748b'),
  ('Technischer Support',        '🛠️', '#94a3b8')
ON CONFLICT (name) DO UPDATE
  SET icon  = EXCLUDED.icon,
      color = EXCLUDED.color;

-- 3) Ergebnis prüfen
SELECT id, icon, name FROM knowledge_categories ORDER BY id;

-- ═══════════════════════════════════════════════════════════════════════════
-- Migration abgeschlossen ✅
-- Danach im Dashboard: 🛒 Sellauth → 🔄 Synchronisieren
-- ═══════════════════════════════════════════════════════════════════════════
