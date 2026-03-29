/**
 * cron.js
 * Edge Seeker — Daily MLB Stats Auto-Updater
 *
 * Runs every day at 6:00 AM ET via Vercel Cron
 * Fetches real team run averages from MLB Stats API
 * and updates Supabase so the Poisson model stays accurate
 *
 * Endpoint: GET /api/cron/update-stats
 * Protected by CRON_SECRET environment variable
 */


const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// MLB Stats API — team season stats
const MLB_API_BASE = "https://statsapi.mlb.com/api/v1";

// Team ID map — MLB API uses numeric IDs
const MLB_TEAM_IDS = {
  NYY: 147, BOS: 111, TOR: 141, TB: 139, BAL: 110,
  CLE: 114, MIN: 142, CWS: 145, KC: 118, DET: 116,
  HOU: 117, TEX: 140, SEA: 136, OAK: 133, LAA: 108,
  ATL: 144, NYM: 121, PHI: 143, MIA: 146, WSH: 120,
  CHC: 112, MIL: 158, STL: 138, CIN: 113, PIT: 134,
  LAD: 119, SF: 137, SD: 135, ARI: 109, COL: 115,
};

/**
 * Fetch team hitting stats from MLB Stats API
 * Returns runs scored per game for all teams
 */
async function fetchTeamHittingStats(season) {
  const url = `${MLB_API_BASE}/teams/stats?stats=season&group=hitting&season=${season}&sportId=1`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const stats = {};
    for (const team of data.stats?.[0]?.splits || []) {
      const abbr = Object.keys(MLB_TEAM_IDS).find(
        k => MLB_TEAM_IDS[k] === team.team?.id
      );
      if (!abbr) continue;
      const gamesPlayed = team.stat?.gamesPlayed || 1;
      const runsScored = team.stat?.runs || 0;
      stats[abbr] = {
        runsPerGame: parseFloat((runsScored / gamesPlayed).toFixed(3)),
        gamesPlayed,
      };
    }
    return stats;
  } catch (err) {
    console.error("Hitting stats fetch error:", err.message);
    return {};
  }
}

/**
 * Fetch team pitching stats from MLB Stats API
 * Returns runs allowed per game for all teams
 */
async function fetchTeamPitchingStats(season) {
  const url = `${MLB_API_BASE}/teams/stats?stats=season&group=pitching&season=${season}&sportId=1`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const stats = {};
    for (const team of data.stats?.[0]?.splits || []) {
      const abbr = Object.keys(MLB_TEAM_IDS).find(
        k => MLB_TEAM_IDS[k] === team.team?.id
      );
      if (!abbr) continue;
      const gamesPlayed = team.stat?.gamesPlayed || 1;
      const runsAllowed = team.stat?.runs || 0;
      stats[abbr] = {
        runsAllowedPerGame: parseFloat((runsAllowed / gamesPlayed).toFixed(3)),
        era: parseFloat(team.stat?.era || 0).toFixed(2),
      };
    }
    return stats;
  } catch (err) {
    console.error("Pitching stats fetch error:", err.message);
    return {};
  }
}

/**
 * Save updated team stats to Supabase
 */
async function saveTeamStats(teamStats) {
  const url = `${SUPABASE_URL}/rest/v1/team_stats`;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates',
  };

  const rows = Object.entries(teamStats).map(([abbr, stats]) => ({
    team_abbr: abbr,
    runs_per_game: stats.runsPerGame,
    runs_allowed_per_game: stats.runsAllowedPerGame,
    era: stats.era,
    games_played: stats.gamesPlayed,
    updated_at: new Date().toISOString(),
  }));

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase save error: ${err}`);
  }

  return rows.length;
}

/**
 * Main update function
 */
async function updateMLBStats() {
  const season = new Date().getFullYear();
  console.log(`🔄 Updating MLB stats for ${season} season...`);

  const [hitting, pitching] = await Promise.all([
    fetchTeamHittingStats(season),
    fetchTeamPitchingStats(season),
  ]);

  // Merge hitting and pitching stats
  const combined = {};
  const allTeams = new Set([...Object.keys(hitting), ...Object.keys(pitching)]);

  for (const abbr of allTeams) {
    combined[abbr] = {
      runsPerGame: hitting[abbr]?.runsPerGame || 4.3,
      runsAllowedPerGame: pitching[abbr]?.runsAllowedPerGame || 4.3,
      era: pitching[abbr]?.era || '4.00',
      gamesPlayed: hitting[abbr]?.gamesPlayed || 0,
    };
  }

  // Only save if we have real data (season has started)
  const totalGames = Object.values(combined).reduce((s, t) => s + t.gamesPlayed, 0);

  if (totalGames === 0) {
    console.log('⏳ Season has not started yet — skipping update, using projections');
    return { updated: false, reason: 'Season not started', teams: 0 };
  }

  const saved = await saveTeamStats(combined);
  console.log(`✅ Updated stats for ${saved} teams`);

  return {
    updated: true,
    teams: saved,
    totalGamesInSeason: totalGames,
    sample: combined['NYY'] || combined['LAD'],
  };
}

module.exports = { updateMLBStats, MLB_TEAM_IDS };
