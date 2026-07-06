-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 2.0.18 — Spam/Abuse Verbesserungen
-- Nur nötig falls 2.0.17-Migration noch nicht ausgeführt wurde.
-- Ausführen in: Supabase → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

-- Spalten sicherstellen (idempotent)
ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS mute_until        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS spam_warn_count   INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_spam_warn_at TIMESTAMPTZ;

-- Index für schnelle IP-Bann-Prüfung
CREATE INDEX IF NOT EXISTS idx_blacklist_visitor_ip ON blacklist(visitor_ip);
CREATE INDEX IF NOT EXISTS idx_blacklist_chat_id    ON blacklist(chat_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- Fertig ✅
-- ═══════════════════════════════════════════════════════════════════════════
