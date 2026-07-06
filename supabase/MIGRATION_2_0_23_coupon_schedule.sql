-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 2.0.23 — Wochenplan (coupon_schedule) reparieren
-- Ursache: Die Tabelle hatte andere Spaltennamen (day_of_week/is_enabled/
-- discount_value/discount_type) als der Code erwartet (weekday/enabled/
-- discount/type) UND keinen UNIQUE-Index auf den Wochentag → Speichern schlug
-- still fehl. Diese Migration bringt die Tabelle auf das vom Code genutzte Schema.
--
-- Hinweis: Der Wochenplan hat bisher NIE Daten gespeichert (Spalten passten nicht),
-- daher ist das Neuaufsetzen der Tabelle gefahrlos.
--
-- Ausführen in: Supabase → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS coupon_schedule;

CREATE TABLE coupon_schedule (
  id          SERIAL PRIMARY KEY,
  weekday     INTEGER NOT NULL UNIQUE CHECK (weekday BETWEEN 0 AND 6),  -- 0=Mo … 6=So
  enabled     BOOLEAN DEFAULT true,
  discount    INTEGER DEFAULT 10,
  type        TEXT    DEFAULT 'percentage',   -- 'percentage' | 'fixed'
  description TEXT,
  max_uses    INTEGER,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Alle 7 Wochentage mit sinnvollen Standardwerten vorbelegen
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

-- ═══════════════════════════════════════════════════════════════════════════
-- Fertig ✅  — Wochenplan kann jetzt gespeichert und geladen werden.
-- ═══════════════════════════════════════════════════════════════════════════
