-- =============================================
-- Golden Boot Lock Feature Migration
-- Run this in your Supabase SQL editor AFTER golden_boot_migration.sql
-- =============================================

-- Single-row settings table for the golden boot submission lock.
-- Separate from golden_boot_winner because "locked" and "winner announced"
-- are different states — you want to be able to close submissions
-- before you know (or want to reveal) who actually won.
CREATE TABLE IF NOT EXISTS golden_boot_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  locked_at TIMESTAMP,
  CONSTRAINT single_row CHECK (id = 1)
);

-- Seed the single row if it doesn't exist yet
INSERT INTO golden_boot_settings (id, is_locked)
VALUES (1, FALSE)
ON CONFLICT (id) DO NOTHING;
