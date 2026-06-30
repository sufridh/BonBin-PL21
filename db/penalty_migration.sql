-- =============================================
-- Penalty support migration
-- Run in Supabase SQL editor after the main schema
-- Applies to Round of 32 onwards (knockout matches)
-- =============================================

-- 1. Add penalty columns to matches
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS went_to_penalties BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS penalty_winner    VARCHAR(5)  DEFAULT NULL;  -- 'home' | 'away' | NULL

-- 2. Add penalty pick column to picks
ALTER TABLE picks
  ADD COLUMN IF NOT EXISTS penalty_pick VARCHAR(5) DEFAULT NULL;  -- 'home' | 'away' | NULL

-- 3. Replace calculate_points with penalty-aware version
--    Old 4-arg callers still work because new params have DEFAULT values.
DROP FUNCTION IF EXISTS calculate_points(INTEGER,INTEGER,INTEGER,INTEGER);

CREATE OR REPLACE FUNCTION calculate_points(
  predicted_home        INTEGER,
  predicted_away        INTEGER,
  actual_home           INTEGER,
  actual_away           INTEGER,
  went_to_penalties     BOOLEAN  DEFAULT FALSE,
  actual_penalty_winner VARCHAR  DEFAULT NULL,   -- 'home' | 'away'
  penalty_pick          VARCHAR  DEFAULT NULL    -- 'home' | 'away', only meaningful when predicted draw
) RETURNS NUMERIC AS $$
DECLARE
  total_goal_error NUMERIC;
  bonus            NUMERIC;
  correct_result   BOOLEAN;
  exact_match      BOOLEAN;
  pick_is_draw     BOOLEAN;
BEGIN
  IF actual_home IS NULL OR actual_away IS NULL
  OR predicted_home IS NULL OR predicted_away IS NULL THEN
    RETURN NULL;
  END IF;

  -- ── Knockout match that went to penalties ──────────────────────────────────
  IF went_to_penalties AND actual_penalty_winner IS NOT NULL THEN
    pick_is_draw := (predicted_home = predicted_away);

    IF pick_is_draw THEN
      -- User predicted a draw → they also submitted a penalty winner pick
      IF penalty_pick IS NOT NULL AND penalty_pick = actual_penalty_winner THEN
        RETURN 3;   -- Correct penalty winner  →  3 pts
      ELSE
        RETURN 1;   -- Predicted draw (right idea) but wrong penalty winner  →  1 pt
      END IF;
    ELSE
      -- User predicted one side to win outright; check if that side ultimately won
      IF (predicted_home > predicted_away AND actual_penalty_winner = 'home')
      OR (predicted_home < predicted_away AND actual_penalty_winner = 'away') THEN
        RETURN 1;   -- Right overall winner, wrong method  →  1 pt
      ELSE
        RETURN 0;   -- Wrong overall winner  →  0 pts
      END IF;
    END IF;
  END IF;

  -- ── Normal match (no penalties / group stage) ──────────────────────────────
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

-- 4. Refresh leaderboard view to pass new columns
DROP VIEW IF EXISTS leaderboard;

CREATE OR REPLACE VIEW leaderboard AS
SELECT
  u.id,
  u.display_name,
  u.username,
  u.avatar_base64,
  COUNT(p.id) as total_picks,
  COALESCE(SUM(
    calculate_points(
      p.home_score_pick, p.away_score_pick,
      m.home_score,      m.away_score,
      COALESCE(m.went_to_penalties, FALSE),
      m.penalty_winner,
      p.penalty_pick
    )
  ), 0) as total_points,
  COALESCE(SUM(
    CASE
      WHEN m.home_score IS NOT NULL
        AND p.home_score_pick = m.home_score
        AND p.away_score_pick = m.away_score
        AND (NOT COALESCE(m.went_to_penalties, FALSE)
             OR p.penalty_pick = m.penalty_winner)
      THEN 1 ELSE 0
    END
  ), 0) as exact_scores,
  COALESCE(SUM(
    CASE
      WHEN m.home_score IS NOT NULL
        AND calculate_points(
              p.home_score_pick, p.away_score_pick,
              m.home_score,      m.away_score,
              COALESCE(m.went_to_penalties, FALSE),
              m.penalty_winner,  p.penalty_pick
            ) > 0
        AND NOT (
          p.home_score_pick = m.home_score AND p.away_score_pick = m.away_score
          AND (NOT COALESCE(m.went_to_penalties, FALSE) OR p.penalty_pick = m.penalty_winner)
        )
      THEN 1 ELSE 0
    END
  ), 0) as correct_results,
  COALESCE(SUM(
    CASE
      WHEN m.home_score IS NOT NULL
        AND calculate_points(
              p.home_score_pick, p.away_score_pick,
              m.home_score,      m.away_score,
              COALESCE(m.went_to_penalties, FALSE),
              m.penalty_winner,  p.penalty_pick
            ) = 0
      THEN 1 ELSE 0
    END
  ), 0) as wrong_picks
FROM users u
LEFT JOIN picks  p ON u.id = p.user_id
LEFT JOIN matches m ON p.match_id = m.id
GROUP BY u.id, u.display_name, u.username, u.avatar_base64
ORDER BY total_points DESC, exact_scores DESC, total_picks DESC;
