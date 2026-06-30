const express = require('express');
const pool = require('../db/pool');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// POST /api/picks — submit or update a pick
router.post('/', authMiddleware, async (req, res) => {
  const { match_id, home_score_pick, away_score_pick, penalty_pick } = req.body;

  if (match_id == null || home_score_pick == null || away_score_pick == null) {
    return res.status(400).json({ error: 'match_id, home_score_pick, away_score_pick required' });
  }

  if (home_score_pick < 0 || away_score_pick < 0 || home_score_pick > 20 || away_score_pick > 20) {
    return res.status(400).json({ error: 'Score picks must be between 0 and 20' });
  }

  // penalty_pick only valid when predicting a draw, and must be 'home' or 'away'
  const isDraw = home_score_pick === away_score_pick;
  const validPenaltyPick = penalty_pick === 'home' || penalty_pick === 'away';
  const resolvedPenaltyPick = (isDraw && validPenaltyPick) ? penalty_pick : null;

  try {
    // Check match exists and isn't locked
    const matchResult = await pool.query(
      'SELECT id, is_locked, status, match_date, stage FROM matches WHERE id = $1',
      [match_id]
    );

    if (matchResult.rows.length === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }

    const match = matchResult.rows[0];

    if (match.is_locked || match.status === 'finished' || match.status === 'live') {
      return res.status(403).json({ error: 'Picks are locked for this match' });
    }

    // Auto-lock if match has already started
    const matchTime = new Date(match.match_date);
    if (new Date() >= matchTime) {
      await pool.query('UPDATE matches SET is_locked=true WHERE id=$1', [match_id]);
      return res.status(403).json({ error: 'Match has already started — picks are locked' });
    }

    // For knockout matches: require penalty_pick when predicting a draw
    const isKnockout = match.stage && !match.stage.toLowerCase().includes('group');
    if (isKnockout && isDraw && !validPenaltyPick) {
      return res.status(400).json({ error: 'Untuk babak gugur, pilih tim pemenang adu penalti saat menebak seri' });
    }

    // Upsert the pick
    const result = await pool.query(
      `INSERT INTO picks (user_id, match_id, home_score_pick, away_score_pick, penalty_pick, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, match_id)
       DO UPDATE SET home_score_pick=$3, away_score_pick=$4, penalty_pick=$5, updated_at=NOW()
       RETURNING *`,
      [req.user.id, match_id, home_score_pick, away_score_pick, resolvedPenaltyPick]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Pick error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/picks/my — all my picks
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.user_id, p.match_id, p.home_score_pick, p.away_score_pick, p.penalty_pick,
              p.created_at, p.updated_at,
              calculate_points(
                p.home_score_pick, p.away_score_pick,
                m.home_score, m.away_score,
                COALESCE(m.went_to_penalties, FALSE),
                m.penalty_winner, p.penalty_pick
              ) as points_earned,
              m.home_team, m.away_team, m.home_flag, m.away_flag,
              m.match_date, m.home_score, m.away_score, m.status, m.stage,
              m.went_to_penalties, m.penalty_winner
       FROM picks p
       JOIN matches m ON p.match_id = m.id
       WHERE p.user_id = $1
       ORDER BY m.match_date ASC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/picks/match/:match_id — all picks for a match (after it starts)
router.get('/match/:match_id', authMiddleware, async (req, res) => {
  try {
    const matchRes = await pool.query(
      'SELECT status, match_date, went_to_penalties, penalty_winner FROM matches WHERE id=$1',
      [req.params.match_id]
    );
    if (matchRes.rows.length === 0) return res.status(404).json({ error: 'Match not found' });

    const match = matchRes.rows[0];
    const started = new Date() >= new Date(match.match_date);

    if (!started && !req.user.is_admin) {
      return res.status(403).json({ error: "Picks hidden until match starts" });
    }

    const result = await pool.query(
      `SELECT p.home_score_pick, p.away_score_pick, p.penalty_pick, u.display_name, u.username,
        calculate_points(
          p.home_score_pick, p.away_score_pick,
          m.home_score, m.away_score,
          COALESCE(m.went_to_penalties, FALSE),
          m.penalty_winner, p.penalty_pick
        ) as points_earned
       FROM picks p
       JOIN users u ON p.user_id = u.id
       JOIN matches m ON p.match_id = m.id
       WHERE p.match_id = $1
       ORDER BY points_earned DESC NULLS LAST, u.display_name ASC`,
      [req.params.match_id]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/picks/leaderboard
router.get('/leaderboard', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM leaderboard');
    res.json(result.rows);
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
