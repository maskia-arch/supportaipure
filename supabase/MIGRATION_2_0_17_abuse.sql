-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 2.0.17 — Faire Spam-Erkennung mit Warnungen & temporärer Sperre
-- Ausführen in: Supabase → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- Temporäre Sperre (statt dauerhaftem Mute) + Warn-Zähler
ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS mute_until        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS spam_warn_count   INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_spam_warn_at TIMESTAMPTZ;

-- Alte Auto-Mutes vom fehlerhaften Sprach-Bug aufheben (Neustart-freundlich)
UPDATE chats
   SET auto_muted = false, mute_reason = NULL, flag_count = 0, spam_warn_count = 0, mute_until = NULL
 WHERE auto_muted = true;

-- Fehlerhaft gebannte Chats aus dem Sprach-Bug wieder freigeben
DELETE FROM blacklist WHERE banned_by = 'system' OR reason ILIKE '%troll%' OR reason ILIKE '%flut%';

-- ═══════════════════════════════════════════════════════════════════════════
-- Fertig ✅
-- ═══════════════════════════════════════════════════════════════════════════
