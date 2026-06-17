-- =============================================
-- Migration: distance-decay scoring
--
-- Replaces the old binary scoring (exact=3, correct result=1, wrong=0)
-- with a function that adds a partial-credit bonus for close (but not
-- exact) correct-result guesses, based on how far the predicted score
-- was from the actual score.
--
-- Formula:
--   exact match            -> 3 points
--   correct result, close  -> 1 + max(0, 2 - 0.5 * total_goal_error)
--   correct result, far    -> 1 point (bonus decays to 0)
--   wrong result           -> 0 points
--
-- where total_goal_error = |predicted_home - actual_home| + |predicted_away - actual_away|
--
-- Example: predict 15-0, actual 17-0 (correct result, "Portugal wins"):
--   total_goal_error = |15-17| + |0-0| = 2
--   bonus = max(0, 2 - 0.5*2) = 1
--   points = 1 + 1 = 2   (previously would have scored flat 1)
--
-- Run this once in your Supabase SQL editor, AFTER your existing schema
-- and the avatar_base64 migration. Safe to run multiple times.
-- =============================================

-- =============================================
-- 0. points_earned needs to support fractional values now (e.g. 2.5)
-- =============================================
ALTER TABLE picks ALTER COLUMN points_earned TYPE NUMERIC;


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
-- Recreate leaderboard view using the new function
-- =============================================
DROP VIEW IF EXISTS leaderboard;

CREATE VIEW leaderboard AS
SELECT
  u.id,
  u.display_name,
  u.username,
  u.avatar_base64,
  COUNT(p.id) as total_picks,
  COALESCE(SUM(calculate_points(p.home_score_pick, p.away_score_pick, m.home_score, m.away_score)), 0) as total_points,
  COALESCE(SUM(
    CASE WHEN m.home_score IS NOT NULL
      AND p.home_score_pick = m.home_score
      AND p.away_score_pick = m.away_score THEN 1 ELSE 0 END
  ), 0) as exact_scores,
  COALESCE(SUM(
    CASE WHEN m.home_score IS NOT NULL
      AND NOT (p.home_score_pick = m.home_score AND p.away_score_pick = m.away_score)
      AND (
        (p.home_score_pick > p.away_score_pick AND m.home_score > m.away_score)
        OR (p.home_score_pick < p.away_score_pick AND m.home_score < m.away_score)
        OR (p.home_score_pick = p.away_score_pick AND m.home_score = m.away_score)
      ) THEN 1 ELSE 0 END
  ), 0) as correct_results,
  COALESCE(SUM(
    CASE WHEN m.home_score IS NOT NULL
      AND NOT (
        (p.home_score_pick > p.away_score_pick AND m.home_score > m.away_score)
        OR (p.home_score_pick < p.away_score_pick AND m.home_score < m.away_score)
        OR (p.home_score_pick = p.away_score_pick AND m.home_score = m.away_score)
      ) THEN 1 ELSE 0 END
  ), 0) as wrong_picks
FROM users u
LEFT JOIN picks p ON u.id = p.user_id
LEFT JOIN matches m ON p.match_id = m.id
GROUP BY u.id, u.display_name, u.username, u.avatar_base64
ORDER BY total_points DESC, exact_scores DESC, total_picks DESC;


-- =============================================
-- Retroactively recalculate points_earned on the picks table
-- for all already-finished matches, using the new formula.
-- (points_earned isn't actually read anywhere in the current app —
-- scoring is computed live in queries — but this keeps the stored
-- column consistent in case anything relies on it later.)
-- =============================================
UPDATE picks p
SET points_earned = calculate_points(p.home_score_pick, p.away_score_pick, m.home_score, m.away_score)
FROM matches m
WHERE p.match_id = m.id AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL;
