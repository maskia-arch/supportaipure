-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 2.0.9 — Visitor-Tracking Schema reparieren
-- Ausführen in: Supabase → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) widget_visitors: ip_hash für IP-basierte Wiedererkennung
ALTER TABLE widget_visitors
  ADD COLUMN IF NOT EXISTS ip_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_widget_visitors_iphash ON widget_visitors(ip_hash);

-- 2) visitor_activities: 'activity' Spalte (Code schrieb activity, Schema hatte activity_type)
ALTER TABLE visitor_activities
  ADD COLUMN IF NOT EXISTS activity TEXT;

-- 3) messages: is_manual Spalte (für System-Aktivitäts-Logs)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT false;

-- 4) Kategorien aufräumen: alte ungewollte automatisch entfernen
DELETE FROM knowledge_categories
WHERE name IN (
  'Produkte & Tarife', 'Europa eSIM', 'Türkei eSIM',
  'Asien & Pazifik eSIM', 'Amerika eSIM', 'Naher Osten & Afrika eSIM',
  'Weltweit / Global eSIM', 'Unlimited Tarife', 'Kurzzeit-eSIMs',
  'Langzeit-eSIMs', 'Produkte', 'Tarife', 'Preise', 'FAQ', 'Support'
);

-- 5) Die 5 richtigen Kategorien sicherstellen
ALTER TABLE knowledge_categories
  ADD COLUMN IF NOT EXISTS icon  TEXT,
  ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#3b82f6';

INSERT INTO knowledge_categories (name, icon, color) VALUES
  ('Travel eSIM',          '✈️',  '#3b82f6'),
  ('Unlimited Eco eSIM',   '🌿',  '#10b981'),
  ('Unlimited Pro eSIM',   '⚡',  '#8b5cf6'),
  ('FAQ & Anleitung',      '❓',  '#64748b'),
  ('Technischer Support',  '🛠️', '#94a3b8')
ON CONFLICT (name) DO UPDATE SET icon = EXCLUDED.icon, color = EXCLUDED.color;

-- 6) Ergebnis
SELECT id, icon, name FROM knowledge_categories ORDER BY id;
-- ═══════════════════════════════════════════════════════════════════════════
