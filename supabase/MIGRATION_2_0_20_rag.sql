-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 2.0.20 — RAG / Wissensdatenbank-Abruf reparieren
-- Ausführen in: Supabase → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Threshold in den Einstellungen auf sinnvollen Wert senken (0.45 war zu hoch).
--    Der Code deckelt zusätzlich auf max 0.35, dies hält die DB konsistent.
UPDATE settings SET rag_threshold = 0.3 WHERE rag_threshold IS NULL OR rag_threshold > 0.35;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. DIAGNOSE (optional ausführen): Wie viele Einträge haben ein Embedding?
--    Erwartung: Zahl ≈ Anzahl WISSEN-Einträge (z.B. 71). Ist sie 0 → neu syncen.
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT
--   COUNT(*)                                   AS gesamt,
--   COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS mit_embedding,
--   COUNT(*) FILTER (WHERE is_active = true)       AS aktiv
-- FROM knowledge_base;

-- Falls mit_embedding = 0: im Dashboard unter "Wissen" / Sellauth neu synchronisieren,
-- damit Embeddings erzeugt werden.

-- ═══════════════════════════════════════════════════════════════════════════
-- Fertig ✅
-- ═══════════════════════════════════════════════════════════════════════════
