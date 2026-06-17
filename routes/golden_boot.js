const express = require('express');
const axios = require('axios');
const pool = require('../db/pool');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

const API_KEY = process.env.FOOTBALL_API_KEY;
const WC_2026_ID = 2000;

// ── Cache ────────────────────────────────────────────────────────────────────
let playersCache = null;          // merged scorers + squad players
let playersCachedAt = 0;
const PLAYERS_TTL_MS = 60 * 60 * 1000; // 1 hour — squads don't change often

let scorersCache = null;          // raw scorer data for goal tallies
let scorersCachedAt = 0;
const SCORERS_TTL_MS = 5 * 60 * 1000;  // 5 minutes

// Maps football-data.org team names → flag emoji
// Covers all WC 2026 qualified nations + common alternate spellings
const FLAG_MAP = {
  'Argentina': '🇦🇷', 'Brazil': '🇧🇷', 'France': '🇫🇷', 'Germany': '🇩🇪',
  'Spain': '🇪🇸', 'England': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'Portugal': '🇵🇹', 'Netherlands': '🇳🇱',
  'Italy': '🇮🇹', 'Belgium': '🇧🇪', 'Croatia': '🇭🇷', 'Morocco': '🇲🇦',
  'Mexico': '🇲🇽', 'Canada': '🇨🇦', 'Japan': '🇯🇵',
  'South Korea': '🇰🇷', 'Korea Republic': '🇰🇷',
  'Australia': '🇦🇺', 'Uruguay': '🇺🇾', 'Colombia': '🇨🇴',
  'Switzerland': '🇨🇭', 'Denmark': '🇩🇰', 'Poland': '🇵🇱', 'Serbia': '🇷🇸',
  'Ecuador': '🇪🇨', 'Saudi Arabia': '🇸🇦', 'Senegal': '🇸🇳',
  'Iran': '🇮🇷', 'Qatar': '🇶🇦', 'Tunisia': '🇹🇳',
  'Indonesia': '🇮🇩', 'Costa Rica': '🇨🇷', 'Panama': '🇵🇦',
  // football-data.org uses "United States" not "USA"
  'United States': '🇺🇸', 'USA': '🇺🇸',
  // China
  'China PR': '🇨🇳', 'China': '🇨🇳',
  // Africa
  'Nigeria': '🇳🇬', 'Cameroon': '🇨🇲', 'Ghana': '🇬🇭', 'Egypt': '🇪🇬',
  "Côte d'Ivoire": '🇨🇮', 'Ivory Coast': '🇨🇮', 'Mali': '🇲🇱',
  'South Africa': '🇿🇦', 'Algeria': '🇩🇿', 'Benin': '🇧🇯',
  'Congo DR': '🇨🇩', 'DR Congo': '🇨🇩', 'Zambia': '🇿🇲',
  'Tanzania': '🇹🇿', 'Uganda': '🇺🇬', 'Kenya': '🇰🇪', 'Comoros': '🇰🇲',
  // Europe extras
  'Turkey': '🇹🇷', 'Ukraine': '🇺🇦', 'Austria': '🇦🇹', 'Hungary': '🇭🇺',
  'Romania': '🇷🇴', 'Slovakia': '🇸🇰', 'Slovenia': '🇸🇮', 'Greece': '🇬🇷',
  'Czech Republic': '🇨🇿', 'Czechia': '🇨🇿',
  'Albania': '🇦🇱', 'Scotland': '🏴󠁧󠁢󠁳󠁣󠁴󠁿', 'Wales': '🏴󠁧󠁢󠁷󠁬󠁳󠁿', 'Ireland': '🇮🇪',
  'Norway': '🇳🇴', 'Sweden': '🇸🇪', 'Finland': '🇫🇮', 'Iceland': '🇮🇸',
  'Bosnia and Herzegovina': '🇧🇦', 'North Macedonia': '🇲🇰',
  'Montenegro': '🇲🇪', 'Georgia': '🇬🇪', 'Armenia': '🇦🇲',
  'Israel': '🇮🇱', 'Kazakhstan': '🇰🇿', 'Uzbekistan': '🇺🇿', 'Azerbaijan': '🇦🇿',
  // Americas extras
  'Venezuela': '🇻🇪', 'Bolivia': '🇧🇴', 'Paraguay': '🇵🇾', 'Chile': '🇨🇱', 'Peru': '🇵🇪',
  'Honduras': '🇭🇳', 'Jamaica': '🇯🇲', 'Haiti': '🇭🇹', 'Trinidad and Tobago': '🇹🇹',
  'Guatemala': '🇬🇹', 'El Salvador': '🇸🇻', 'Cuba': '🇨🇺', 'Curaçao': '🇨🇼',
  // Middle East / Asia extras
  'Iraq': '🇮🇶', 'Jordan': '🇯🇴', 'Oman': '🇴🇲', 'Bahrain': '🇧🇭',
  'Kuwait': '🇰🇼', 'UAE': '🇦🇪', 'United Arab Emirates': '🇦🇪',
  'Syria': '🇸🇾', 'Lebanon': '🇱🇧', 'Palestine': '🇵🇸',
  'New Zealand': '🇳🇿', 'Philippines': '🇵🇭', 'Thailand': '🇹🇭',
  'Vietnam': '🇻🇳', 'India': '🇮🇳', 'Pakistan': '🇵🇰',
};

function getFlag(teamName) {
  return FLAG_MAP[teamName] || '🏳️';
}

// ── Fetch live scorers (goal tallies only) ───────────────────────────────────
async function fetchRawScorers() {
  const now = Date.now();
  if (scorersCache && now - scorersCachedAt < SCORERS_TTL_MS) return scorersCache;
  if (!API_KEY || API_KEY === 'your_football_data_org_api_key') return [];

  try {
    const res = await axios.get(
      `https://api.football-data.org/v4/competitions/${WC_2026_ID}/scorers?limit=200`,
      { headers: { 'X-Auth-Token': API_KEY }, timeout: 10000 }
    );
    scorersCache = res.data.scorers || [];
    scorersCachedAt = now;
    return scorersCache;
  } catch (err) {
    console.error('[GoldenBoot] Scorers fetch error:', err.message);
    return scorersCache || [];
  }
}

// ── Fetch all WC teams + squads in ONE call, merge with scorers ──────────────
async function fetchAllPlayers() {
  const now = Date.now();
  if (playersCache && now - playersCachedAt < PLAYERS_TTL_MS) return playersCache;
  if (!API_KEY || API_KEY === 'your_football_data_org_api_key') return [];

  try {
    // One call gets all 48 teams with their squads
    const [teamsRes, rawScorers] = await Promise.all([
      axios.get(
        `https://api.football-data.org/v4/competitions/${WC_2026_ID}/teams`,
        { headers: { 'X-Auth-Token': API_KEY }, timeout: 15000 }
      ),
      fetchRawScorers(),
    ]);

    // Build scorer lookup: player_id → goals
    const goalsMap = {};
    for (const s of rawScorers) {
      goalsMap[s.player.id] = s.goals || 0;
    }

    const players = [];
    for (const team of (teamsRes.data.teams || [])) {
      const teamName = team.name;
      const teamFlag = getFlag(teamName);
      for (const player of (team.squad || [])) {
        // Only outfield + attackers who might score — include everyone except GKs
        // Actually include all: defenders & midfielders score too at WC
        players.push({
          player_id: player.id,
          player_name: player.name,
          team_name: teamName,
          team_flag: teamFlag,
          position: player.position,
          goals: goalsMap[player.id] || 0,
        });
      }
    }

    // Sort: scorers first (by goals desc), then rest alphabetically by team+name
    players.sort((a, b) => {
      if (b.goals !== a.goals) return b.goals - a.goals;
      if (a.team_name !== b.team_name) return a.team_name.localeCompare(b.team_name);
      return a.player_name.localeCompare(b.player_name);
    });

    playersCache = players;
    playersCachedAt = now;
    return players;
  } catch (err) {
    console.error('[GoldenBoot] Teams/squad fetch error:', err.message);
    // Fallback: return raw scorers only
    const raw = await fetchRawScorers();
    return raw.map(s => ({
      player_id: s.player.id,
      player_name: s.player.name,
      team_name: s.team.name,
      team_flag: getFlag(s.team.name),
      position: null,
      goals: s.goals || 0,
    }));
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/golden-boot/scorers — full player list (squad + live goal tallies)
router.get('/scorers', authMiddleware, async (req, res) => {
  try {
    const players = await fetchAllPlayers();
    res.json(players);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch players' });
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
      [req.user.id, player_id, player_name, team_name, team_flag || getFlag(team_name)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Golden boot pick error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/golden-boot/all — all users' picks (admin always; others only after winner set)
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

// DELETE /api/golden-boot/winner — admin clears the winner
router.delete('/winner', adminMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM golden_boot_winner');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
