const express = require('express');
const pool = require('../db/pool');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /api/matches — all matches with user's picks if logged in
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        m.*,
        p.home_score_pick,
        p.away_score_pick,
        p.penalty_pick,
        CASE WHEN p.id IS NOT NULL THEN
          calculate_points(
            p.home_score_pick, p.away_score_pick,
            m.home_score, m.away_score,
            COALESCE(m.went_to_penalties, FALSE),
            m.penalty_winner, p.penalty_pick
          )
        ELSE NULL END as points_earned
      FROM matches m
      LEFT JOIN picks p ON m.id = p.match_id AND p.user_id = $1
      ORDER BY m.match_date ASC
    `, [req.user.id]);

    res.json(result.rows);
  } catch (err) {
    console.error('Get matches error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/matches/public — for leaderboard (no auth needed, no picks)
router.get('/public', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, home_team, away_team, home_flag, away_flag, match_date, stage, group_name,
              venue, city, status, home_score, away_score, went_to_penalties, penalty_winner
       FROM matches ORDER BY match_date ASC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/matches — admin adds a match manually
router.post('/', adminMiddleware, async (req, res) => {
  const { home_team, away_team, home_flag, away_flag, match_date, stage, group_name, venue, city } = req.body;

  if (!home_team || !away_team || !match_date) {
    return res.status(400).json({ error: 'home_team, away_team, match_date required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO matches (home_team, away_team, home_flag, away_flag, match_date, stage, group_name, venue, city)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [home_team, away_team, home_flag || '', away_flag || '', match_date, stage || 'Group Stage', group_name, venue, city]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Add match error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/matches/:id/score — admin updates score (+ optional penalty info)
router.patch('/:id/score', adminMiddleware, async (req, res) => {
  const { home_score, away_score, status, went_to_penalties, penalty_winner } = req.body;

  // Validate penalty fields when provided
  if (went_to_penalties && !['home', 'away'].includes(penalty_winner)) {
    return res.status(400).json({ error: 'penalty_winner must be "home" or "away" when went_to_penalties is true' });
  }

  try {
    const result = await pool.query(
      `UPDATE matches
       SET home_score=$1, away_score=$2, status=$3,
           went_to_penalties=$4, penalty_winner=$5
       WHERE id=$6 RETURNING *`,
      [
        home_score, away_score, status || 'finished',
        went_to_penalties ?? false,
        went_to_penalties ? penalty_winner : null,
        req.params.id
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Match not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/matches/:id/lock — admin locks/unlocks picks for a match
router.patch('/:id/lock', adminMiddleware, async (req, res) => {
  const { is_locked } = req.body;
  try {
    const result = await pool.query(
      'UPDATE matches SET is_locked=$1 WHERE id=$2 RETURNING *',
      [is_locked, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/matches/:id — admin deletes a match
router.delete('/:id', adminMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM matches WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;