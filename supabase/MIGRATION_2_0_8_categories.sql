-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 2.0.8 — Korrekte eSIM Kategorien
-- Ausführen in: Supabase → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Spalten sicherstellen
ALTER TABLE knowledge_categories
  ADD COLUMN IF NOT EXISTS icon  TEXT,
  ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#3b82f6';

-- 2) Alte automatisch angelegte Kategorien aus 2.0.6/2.0.7 bereinigen
DELETE FROM knowledge_categories
WHERE name IN (
  'Produkte & Tarife', 'Europa eSIM', 'Türkei eSIM',
  'Asien & Pazifik eSIM', 'Amerika eSIM', 'Naher Osten & Afrika eSIM',
  'Weltweit / Global eSIM', 'Unlimited Tarife', 'Kurzzeit-eSIMs',
  'Langzeit-eSIMs'
);

-- 3) Die 5 richtigen Kategorien anlegen
INSERT INTO knowledge_categories (name, icon, color) VALUES
  ('Travel eSIM',          '✈️',  '#3b82f6'),
  ('Unlimited Eco eSIM',   '🌿',  '#10b981'),
  ('Unlimited Pro eSIM',   '⚡',  '#8b5cf6'),
  ('FAQ & Anleitung',      '❓',  '#64748b'),
  ('Technischer Support',  '🛠️', '#94a3b8')
ON CONFLICT (name) DO UPDATE
  SET icon  = EXCLUDED.icon,
      color = EXCLUDED.color;

-- 4) Ergebnis prüfen
SELECT id, icon, name FROM knowledge_categories ORDER BY id;
-- ═══════════════════════════════════════════════════════════════════════════
