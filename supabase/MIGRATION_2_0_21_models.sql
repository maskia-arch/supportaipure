-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 2.0.21 — Neue KI-Modelle (alte DeepSeek-Modelle ersetzen)
-- Ausführen in: Supabase → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- Gespeichertes Support-AI-Modell auf den neuen Standard umstellen
UPDATE settings
   SET ai_model = 'deepseek-v4-flash'
 WHERE ai_model IS NULL OR ai_model IN ('deepseek-chat', 'deepseek-reasoner');

-- ═══════════════════════════════════════════════════════════════════════════
-- Fertig ✅
-- ═══════════════════════════════════════════════════════════════════════════
