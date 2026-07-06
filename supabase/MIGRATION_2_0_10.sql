-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 2.0.10 — Coupon DB-Spalten reparieren
-- Ausführen in: Supabase → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- daily_coupons: fehlende Spalte für Sellauth-Referenz
ALTER TABLE daily_coupons
  ADD COLUMN IF NOT EXISTS sellauth_id TEXT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Fertig ✅  (Code nutzt jetzt die echten Schema-Spalten discount_value,
--             discount_type, active_until, uses)
-- ═══════════════════════════════════════════════════════════════════════════
