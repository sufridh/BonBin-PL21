-- =============================================
-- Bonbin PL Pick'em — World Cup 2026
-- Run this once in your Supabase SQL editor
-- =============================================

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  is_admin BOOLEAN DEFAULT FALSE,
  avatar_base64 TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Run this if you already have an existing users table:
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_base64 TEXT;

CREATE TABLE IF NOT EXISTS matches (
  id SERIAL PRIMARY KEY,
  external_id VARCHAR(50) UNIQUE,
  home_team VARCHAR(100) NOT NULL,
  away_team VARCHAR(100) NOT NULL,
  home_flag VARCHAR(10),
  away_flag VARCHAR(10),
  match_date TIMESTAMP NOT NULL,
  stage VARCHAR(50) NOT NULL DEFAULT 'Group Stage',
  group_name VARCHAR(10),
  venue VARCHAR(150),
  city VARCHAR(100),
  status VARCHAR(20) DEFAULT 'scheduled',  -- scheduled, live, finished
  home_score INTEGER,
  away_score INTEGER,
  is_locked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS picks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
  home_score_pick INTEGER NOT NULL CHECK (home_score_pick >= 0),
  away_score_pick INTEGER NOT NULL CHECK (away_score_pick >= 0),
  points_earned NUMERIC DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, match_id)
);

-- =============================================
-- Scoring function: distance-decay
-- exact score = 3pts
-- correct result, close to actual score = 1 + up to 2 bonus points
--   (bonus = max(0, 2 - 0.5 * total_goal_error), where
--    total_goal_error = |predicted_home - actual_home| + |predicted_away - actual_away|)
-- correct result, far from actual score = 1pt (bonus decays to 0)
-- wrong result = 0pts
-- =============================================
CREATE OR REPLACE FUNCTION calculate_points(
  predicted_home INTEGER,
  predicted_away INTEGER,
  actual_home INTEGER,
  actual_away INTEGER
) RETURNS NUMERIC AS $$
DECLARE
  total_goal_error NUMERIC;
  bonus NUMERIC;
  correct_result BOOLEAN;
  exact_match BOOLEAN;
BEGIN
  IF actual_home IS NULL OR actual_away IS NULL OR predicted_home IS NULL OR predicted_away IS NULL THEN
    RETURN NULL;
  END IF;

  exact_match := (predicted_home = actual_home AND predicted_away = actual_away);

  correct_result := (
    (predicted_home > predicted_away AND actual_home > actual_away)
    OR (predicted_home < predicted_away AND actual_home < actual_away)
    OR (predicted_home = predicted_away AND actual_home = actual_away)
  );

  IF exact_match THEN
    RETURN 3;
  ELSIF correct_result THEN
    total_goal_error := ABS(predicted_home - actual_home) + ABS(predicted_away - actual_away);
    bonus := GREATEST(0, 2 - 0.5 * total_goal_error);
    RETURN 1 + bonus;
  ELSE
    RETURN 0;
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- =============================================
-- Leaderboard view
-- NOTE: if this view already exists in your database with a different
-- column list, Postgres will reject CREATE OR REPLACE — run
-- `DROP VIEW IF EXISTS leaderboard;` first, then re-run this file.
-- =============================================
CREATE OR REPLACE VIEW leaderboard AS
SELECT 
  u.id,
  u.display_name,
  u.username,
  u.avatar_base64,
  COUNT(p.id) as total_picks,
  COALESCE(SUM(calculate_points(p.home_score_pick, p.away_score_pick, m.home_score, m.away_score)), 0) as total_points,
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
  ), 0) as wrong_picks
FROM users u
LEFT JOIN picks p ON u.id = p.user_id
LEFT JOIN matches m ON p.match_id = m.id
GROUP BY u.id, u.display_name, u.username, u.avatar_base64
ORDER BY total_points DESC, exact_scores DESC, total_picks DESC;
