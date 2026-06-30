const axios = require('axios');
const cron = require('node-cron');
const pool = require('./db/pool');

const API_KEY = process.env.FOOTBALL_API_KEY;
const WC_2026_ID = 2000; // football-data.org competition ID for World Cup 2026

// Maps team names from football-data.org to flag emojis
const FLAG_MAP = {
  'Argentina': '🇦🇷', 'Brazil': '🇧🇷', 'France': '🇫🇷', 'Germany': '🇩🇪',
  'Spain': '🇪🇸', 'England': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'Portugal': '🇵🇹', 'Netherlands': '🇳🇱',
  'Italy': '🇮🇹', 'Belgium': '🇧🇪', 'Croatia': '🇭🇷', 'Morocco': '🇲🇦',
  'Senegal': '🇸🇳', 'USA': '🇺🇸', 'Mexico': '🇲🇽', 'Canada': '🇨🇦',
  'Japan': '🇯🇵', 'South Korea': '🇰🇷', 'Australia': '🇦🇺', 'Iran': '🇮🇷',
  'Saudi Arabia': '🇸🇦', 'Qatar': '🇶🇦', 'Ecuador': '🇪🇨', 'Uruguay': '🇺🇾',
  'Colombia': '🇨🇴', 'Chile': '🇨🇱', 'Peru': '🇵🇪', 'Venezuela': '🇻🇪',
  'Switzerland': '🇨🇭', 'Denmark': '🇩🇰', 'Sweden': '🇸🇪', 'Norway': '🇳🇴',
  'Poland': '🇵🇱', 'Serbia': '🇷🇸', 'Ukraine': '🇺🇦', 'Turkey': '🇹🇷',
  'Ghana': '🇬🇭', 'Cameroon': '🇨🇲', 'Nigeria': '🇳🇬', 'Côte d\'Ivoire': '🇨🇮',
  'Tunisia': '🇹🇳', 'Egypt': '🇪🇬', 'Algeria': '🇩🇿', 'South Africa': '🇿🇦',
  'Indonesia': '🇮🇩', 'Thailand': '🇹🇭', 'Vietnam': '🇻🇳', 'Philippines': '🇵🇭',
  'New Zealand': '🇳🇿', 'Costa Rica': '🇨🇷', 'Panama': '🇵🇦', 'Honduras': '🇭🇳',
  'Jamaica': '🇯🇲', 'Haiti': '🇭🇹', 'Trinidad and Tobago': '🇹🇹',
  'Bolivia': '🇧🇴', 'Paraguay': '🇵🇾', 'Wales': '🏴󠁧󠁢󠁷󠁬󠁳󠁿', 'Scotland': '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
  'Czech Republic': '🇨🇿', 'Hungary': '🇭🇺', 'Romania': '🇷🇴', 'Slovakia': '🇸🇰',
  'Slovenia': '🇸🇮', 'Austria': '🇦🇹', 'Greece': '🇬🇷', 'Ireland': '🇮🇪',
  'Israel': '🇮🇱', 'Albania': '🇦🇱', 'Iceland': '🇮🇸', 'Finland': '🇫🇮',
  'Montenegro': '🇲🇪', 'Bosnia and Herzegovina': '🇧🇦', 'North Macedonia': '🇲🇰',
  'Georgia': '🇬🇪', 'Azerbaijan': '🇦🇿', 'Kazakhstan': '🇰🇿', 'Uzbekistan': '🇺🇿',
  'Iraq': '🇮🇶', 'Jordan': '🇯🇴', 'Syria': '🇸🇾', 'Lebanon': '🇱🇧',
  'Oman': '🇴🇲', 'Bahrain': '🇧🇭', 'Kuwait': '🇰🇼', 'UAE': '🇦🇪',
  'China PR': '🇨🇳', 'China': '🇨🇳', 'India': '🇮🇳', 'Pakistan': '🇵🇰',
};

function getFlag(teamName) {
  return FLAG_MAP[teamName] || '🏳️';
}

// Fetch and sync all WC2026 matches from football-data.org
async function syncMatches() {
  if (!API_KEY || API_KEY === 'your_football_data_org_api_key') {
    console.log('[Sync] No football API key configured, skipping sync');
    return;
  }

  try {
    console.log('[Sync] Fetching matches from football-data.org...');
    const response = await axios.get(`https://api.football-data.org/v4/competitions/${WC_2026_ID}/matches`, {
      headers: { 'X-Auth-Token': API_KEY },
      timeout: 10000
    });

    const matches = response.data.matches;
    console.log(`[Sync] Got ${matches.length} matches`);

    for (const match of matches) {
      const homeTeam = match.homeTeam.name;
      const awayTeam = match.awayTeam.name;
      const homeFlag = getFlag(homeTeam);
      const awayFlag = getFlag(awayTeam);
      const matchDate = new Date(match.utcDate);
      const stage = match.stage.replace(/_/g, ' ');
      const groupName = match.group ? match.group.replace('GROUP_', 'Group ') : null;
      const venue = match.venue || null;
      const externalId = String(match.id);

      let status = 'scheduled';
      if (match.status === 'FINISHED') status = 'finished';
      else if (match.status === 'IN_PLAY' || match.status === 'PAUSED') status = 'live';

      // Detect penalty shootout (knockout matches only — v4 API sets duration
      // to PENALTY_SHOOTOUT and populates score.penalties.{home,away})
      const wentToPenalties = match.score?.duration === 'PENALTY_SHOOTOUT';
      const penHome = match.score?.penalties?.home ?? null;
      const penAway = match.score?.penalties?.away ?? null;
      let penaltyWinner = null;
      if (wentToPenalties && penHome != null && penAway != null) {
        penaltyWinner = penHome > penAway ? 'home' : 'away';
      }

      // IMPORTANT: football-data.org's score/fullTime is a running cumulative
      // total — for matches decided on penalties it already has the shootout
      // goals added in (e.g. fullTime 4-5 = 1-1 after 120' + 3-4 on penalties).
      // We want home_score/away_score to reflect the *match* result (1-1),
      // with the shootout outcome tracked separately via went_to_penalties /
      // penalty_winner — so subtract the penalty goals back out.
      let homeScore = match.score?.fullTime?.home ?? null;
      let awayScore = match.score?.fullTime?.away ?? null;
      if (wentToPenalties && homeScore != null && awayScore != null && penHome != null && penAway != null) {
        homeScore -= penHome;
        awayScore -= penAway;
      }
      const isLocked = status === 'live' || status === 'finished' || new Date() >= matchDate;

      await pool.query(
        `INSERT INTO matches (external_id, home_team, away_team, home_flag, away_flag, match_date, stage, group_name, venue, status, home_score, away_score, is_locked, went_to_penalties, penalty_winner)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (external_id) DO UPDATE SET
           status=$10, home_score=$11, away_score=$12, is_locked=$13,
           home_team=$2, away_team=$3, home_flag=$4, away_flag=$5,
           went_to_penalties=$14, penalty_winner=$15`,
        [externalId, homeTeam, awayTeam, homeFlag, awayFlag, matchDate, stage, groupName, venue, status, homeScore, awayScore, isLocked, wentToPenalties, penaltyWinner]
      );
    }

    console.log('[Sync] Done ✓');
  } catch (err) {
    if (err.response?.status === 429) {
      console.warn('[Sync] Rate limited by football-data.org, will retry later');
    } else {
      console.error('[Sync] Error:', err.message);
    }
  }
}

// Auto-lock matches that have started
async function autoLockStartedMatches() {
  try {
    const result = await pool.query(
      `UPDATE matches SET is_locked=true 
       WHERE match_date <= NOW() AND is_locked=false`
    );
    if (result.rowCount > 0) {
      console.log(`[Lock] Auto-locked ${result.rowCount} matches`);
    }
  } catch (err) {
    console.error('[Lock] Error:', err.message);
  }
}

function startScheduler() {
  // Sync match results every 5 minutes during tournament hours
  cron.schedule('*/5 * * * *', async () => {
    await autoLockStartedMatches();
    await syncMatches();
  });

  // Full sync daily at 3am WIB (UTC+7 = 20:00 UTC)
  cron.schedule('0 20 * * *', syncMatches);

  console.log('[Scheduler] Started — syncing every 5 minutes');

  // Run once on startup
  setTimeout(async () => {
    await autoLockStartedMatches();
    await syncMatches();
  }, 2000);
}

module.exports = { startScheduler, syncMatches };