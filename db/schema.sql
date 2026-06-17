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
  created_at TIMESTAMP DEFAULT NOW()
);

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
  points_earned INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, match_id)
);

-- =============================================
-- Leaderboard view
-- Scoring: exact score = 3pts, correct result = 1pt
-- =============================================
CREATE OR REPLACE VIEW leaderboard AS
SELECT 
  u.id,
  u.display_name,
  u.username,
  COUNT(p.id) as total_picks,
  COALESCE(SUM(
    CASE 
      WHEN m.home_score IS NOT NULL AND m.away_score IS NOT NULL THEN
        CASE 
          WHEN p.home_score_pick = m.home_score AND p.away_score_pick = m.away_score THEN 3
          WHEN (p.home_score_pick > p.away_score_pick AND m.home_score > m.away_score) 
            OR (p.home_score_pick < p.away_score_pick AND m.home_score < m.away_score)
            OR (p.home_score_pick = p.away_score_pick AND m.home_score = m.away_score) THEN 1
          ELSE 0
        END
      ELSE 0
    END
  ), 0) as total_points,
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
GROUP BY u.id, u.display_name, u.username
ORDER BY total_points DESC, exact_scores DESC, total_picks DESC;
