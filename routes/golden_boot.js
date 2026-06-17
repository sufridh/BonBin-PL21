const express = require('express');
const axios = require('axios');
const pool = require('../db/pool');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

const API_KEY = process.env.FOOTBALL_API_KEY;
const WC_2026_ID = 2000;

// Cache for scorers (5-minute TTL to avoid hammering the API)
let scorersCache = null;
let scorersCachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchScorers() {
  const now = Date.now();
  if (scorersCache && now - scorersCachedAt < CACHE_TTL_MS) {
    return scorersCache;
  }

  if (!API_KEY || API_KEY === 'your_football_data_org_api_key') {
    return [];
  }

  try {
    const response = await axios.get(
      `https://api.football-data.org/v4/competitions/${WC_2026_ID}/scorers?limit=100`,
      { headers: { 'X-Auth-Token': API_KEY }, timeout: 10000 }
    );

    scorersCache = (response.data.scorers || []).map(s => ({
      player_id: s.player.id,
      player_name: s.player.name,
      team_name: s.team.name,
      goals: s.goals,
      assists: s.assists ?? 0,
      penalties: s.penalties ?? 0,
    }));
    scorersCachedAt = now;
    return scorersCache;
  } catch (err) {
    console.error('[GoldenBoot] Scorers fetch error:', err.message);
    return scorersCache || [];
  }
}

// GET /api/golden-boot/scorers — live scorer list for the pick UI
router.get('/scorers', authMiddleware, async (req, res) => {
  try {
    const scorers = await fetchScorers();
    res.json(scorers);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch scorers' });
  }
});

// GET /api/golden-boot/my — current user's golden boot pick
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM golden_boot_picks WHERE user_id = $1',
      [req.user.id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/golden-boot/pick — submit or update golden boot pick
router.post('/pick', authMiddleware, async (req, res) => {
  const { player_id, player_name, team_name, team_flag } = req.body;

  if (!player_id || !player_name || !team_name) {
    return res.status(400).json({ error: 'player_id, player_name, team_name required' });
  }

  try {
    // Check if the winner has already been announced — lock picks if so
    const winnerRes = await pool.query('SELECT id FROM golden_boot_winner LIMIT 1');
    if (winnerRes.rows.length > 0) {
      return res.status(403).json({ error: 'Golden Boot winner already announced — picks are locked' });
    }

    const result = await pool.query(
      `INSERT INTO golden_boot_picks (user_id, player_id, player_name, team_name, team_flag, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         player_id=$2, player_name=$3, team_name=$4, team_flag=$5, updated_at=NOW()
       RETURNING *`,
      [req.user.id, player_id, player_name, team_name, team_flag || '🏳️']
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Golden boot pick error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/golden-boot/all — all users' picks (visible to everyone after winner is set, or admin always)
router.get('/all', authMiddleware, async (req, res) => {
  try {
    const winnerRes = await pool.query('SELECT * FROM golden_boot_winner LIMIT 1');
    const winnerAnnounced = winnerRes.rows.length > 0;

    if (!winnerAnnounced && !req.user.is_admin) {
      return res.status(403).json({ error: 'Picks hidden until winner is announced' });
    }

    const result = await pool.query(
      `SELECT gbp.player_name, gbp.team_name, gbp.team_flag,
              u.display_name, u.username,
              CASE WHEN $1::int IS NOT NULL AND gbp.player_id = $1::int THEN true ELSE false END as correct
       FROM golden_boot_picks gbp
       JOIN users u ON gbp.user_id = u.id
       ORDER BY u.display_name ASC`,
      [winnerRes.rows[0]?.player_id ?? null]
    );
    res.json({ picks: result.rows, winner: winnerRes.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/golden-boot/winner — current winner (public)
router.get('/winner', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM golden_boot_winner LIMIT 1');
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/golden-boot/winner — admin sets the winner
router.post('/winner', adminMiddleware, async (req, res) => {
  const { player_id, player_name, team_name, goals } = req.body;

  if (!player_id || !player_name || !team_name) {
    return res.status(400).json({ error: 'player_id, player_name, team_name required' });
  }

  try {
    // Replace any existing winner
    await pool.query('DELETE FROM golden_boot_winner');
    const result = await pool.query(
      `INSERT INTO golden_boot_winner (player_id, player_name, team_name, goals)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [player_id, player_name, team_name, goals || 0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Set winner error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/golden-boot/winner — admin clears the winner (re-opens picks)
router.delete('/winner', adminMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM golden_boot_winner');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
