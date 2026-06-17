-- =============================================
-- Golden Boot Feature Migration
-- Run this in your Supabase SQL editor AFTER schema.sql
-- =============================================

-- Table to store each user's Golden Boot prediction
CREATE TABLE IF NOT EXISTS golden_boot_picks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  player_id INTEGER NOT NULL,          -- football-data.org player ID
  player_name VARCHAR(150) NOT NULL,
  team_name VARCHAR(100) NOT NULL,
  team_flag VARCHAR(10) DEFAULT '🏳️',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Table to store the admin-confirmed Golden Boot winner (at most 1 row)
CREATE TABLE IF NOT EXISTS golden_boot_winner (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL,
  player_name VARCHAR(150) NOT NULL,
  team_name VARCHAR(100) NOT NULL,
  goals INTEGER NOT NULL DEFAULT 0,
  confirmed_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- Updated leaderboard view with golden boot bonus
-- DROP the old view first to avoid column mismatch
-- =============================================
DROP VIEW IF EXISTS leaderboard;

CREATE OR REPLACE VIEW leaderboard AS
SELECT 
  u.id,
  u.display_name,
  u.username,
  u.avatar_base64,
  COUNT(p.id) as total_picks,
  COALESCE(SUM(calculate_points(p.home_score_pick, p.away_score_pick, m.home_score, m.away_score)), 0) as match_points,
  COALESCE(SUM(
    CASE 
      WHEN m.home_score IS NOT NULL 
        AND p.home_score_pick = m.home_score 
        AND p.away_score_pick = m.away_score THEN 1
      ELSE 0
    END
  ), 0) as exact_scores,
  COALESCE(SUM(
    CASE 
      WHEN m.home_score IS NOT NULL
        AND NOT (p.home_score_pick = m.home_score AND p.away_score_pick = m.away_score)
        AND (
          (p.home_score_pick > p.away_score_pick AND m.home_score > m.away_score) 
          OR (p.home_score_pick < p.away_score_pick AND m.home_score < m.away_score)
          OR (p.home_score_pick = p.away_score_pick AND m.home_score = m.away_score)
        ) THEN 1
      ELSE 0
    END
  ), 0) as correct_results,
  COALESCE(SUM(
    CASE 
      WHEN m.home_score IS NOT NULL
        AND NOT (
          (p.home_score_pick > p.away_score_pick AND m.home_score > m.away_score) 
          OR (p.home_score_pick < p.away_score_pick AND m.home_score < m.away_score)
          OR (p.home_score_pick = p.away_score_pick AND m.home_score = m.away_score)
        ) THEN 1
      ELSE 0
    END
  ), 0) as wrong_picks,
  -- Golden Boot bonus: +5 if user picked the actual winner
  CASE
    WHEN (SELECT COUNT(*) FROM golden_boot_winner) > 0
      AND gbp.player_id IS NOT NULL
      AND gbp.player_id = (SELECT player_id FROM golden_boot_winner LIMIT 1)
    THEN 5
    ELSE 0
  END as golden_boot_bonus,
  -- total_points = match points + golden boot bonus
  COALESCE(SUM(calculate_points(p.home_score_pick, p.away_score_pick, m.home_score, m.away_score)), 0)
  + CASE
      WHEN (SELECT COUNT(*) FROM golden_boot_winner) > 0
        AND gbp.player_id IS NOT NULL
        AND gbp.player_id = (SELECT player_id FROM golden_boot_winner LIMIT 1)
      THEN 5
      ELSE 0
    END as total_points,
  gbp.player_name as golden_boot_pick,
  gbp.team_name as golden_boot_team,
  gbp.team_flag as golden_boot_flag
FROM users u
LEFT JOIN picks p ON u.id = p.user_id
LEFT JOIN matches m ON p.match_id = m.id
LEFT JOIN golden_boot_picks gbp ON u.id = gbp.user_id
GROUP BY u.id, u.display_name, u.username, u.avatar_base64,
         gbp.player_id, gbp.player_name, gbp.team_name, gbp.team_flag
ORDER BY total_points DESC, exact_scores DESC, total_picks DESC;
