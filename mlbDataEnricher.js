/**
 * mlbDataEnricher.js
 * Fetches real MLB pitcher stats, weather, and game data
 * to enrich the AI agent's analysis.
 *
 * Data sources:
 * - MLB Stats API (free, official): statsapi.mlb.com
 * - Open-Meteo (free weather API): api.open-meteo.com
 */

const fetch = require("node-fetch");
const { MLB_TEAM_IDS } = require("./cron");

// ─── MLB STADIUM COORDINATES ──────────────────────────────────────────────────
// Used for weather lookups
const STADIUM_COORDS = {
  NYY: { lat: 40.8296, lon: -73.9262, name: "Yankee Stadium" },
  BOS: { lat: 42.3467, lon: -71.0972, name: "Fenway Park" },
  TOR: { lat: 43.6414, lon: -79.3894, name: "Rogers Centre" },
  TB:  { lat: 27.7683, lon: -82.6534, name: "Tropicana Field" },
  BAL: { lat: 39.2838, lon: -76.6218, name: "Camden Yards" },
  CLE: { lat: 41.4959, lon: -81.6852, name: "Progressive Field" },
  MIN: { lat: 44.9817, lon: -93.2778, name: "Target Field" },
  CWS: { lat: 41.8300, lon: -87.6339, name: "Guaranteed Rate Field" },
  KC:  { lat: 39.0517, lon: -94.4803, name: "Kauffman Stadium" },
  DET: { lat: 42.3390, lon: -83.0485, name: "Comerica Park" },
  HOU: { lat: 29.7573, lon: -95.3555, name: "Minute Maid Park" },
  TEX: { lat: 32.7512, lon: -97.0832, name: "Globe Life Field" },
  SEA: { lat: 47.5914, lon: -122.3325, name: "T-Mobile Park" },
  OAK: { lat: 37.7516, lon: -122.2005, name: "Oakland Coliseum" },
  LAA: { lat: 33.8003, lon: -117.8827, name: "Angel Stadium" },
  ATL: { lat: 33.8908, lon: -84.4679, name: "Truist Park" },
  NYM: { lat: 40.7571, lon: -73.8458, name: "Citi Field" },
  PHI: { lat: 39.9061, lon: -75.1665, name: "Citizens Bank Park" },
  MIA: { lat: 25.7781, lon: -80.2197, name: "loanDepot Park" },
  WSH: { lat: 38.8730, lon: -77.0074, name: "Nationals Park" },
  CHC: { lat: 41.9484, lon: -87.6553, name: "Wrigley Field" },
  MIL: { lat: 43.0280, lon: -87.9712, name: "American Family Field" },
  STL: { lat: 38.6226, lon: -90.1928, name: "Busch Stadium" },
  CIN: { lat: 39.0979, lon: -84.5082, name: "Great American Ball Park" },
  PIT: { lat: 40.4469, lon: -80.0057, name: "PNC Park" },
  LAD: { lat: 34.0739, lon: -118.2400, name: "Dodger Stadium" },
  SF:  { lat: 37.7786, lon: -122.3893, name: "Oracle Park" },
  SD:  { lat: 32.7073, lon: -117.1573, name: "Petco Park" },
  ARI: { lat: 33.4453, lon: -112.0667, name: "Chase Field" },
  COL: { lat: 39.7559, lon: -104.9942, name: "Coors Field" },
};

// ─── CACHE ────────────────────────────────────────────────────────────────────
const enrichCache = {
  data: null,
  fetchedAt: null,
  ttl: 30 * 60 * 1000, // 30 minutes
};

function isCacheValid() {
  return enrichCache.data && Date.now() - enrichCache.fetchedAt < enrichCache.ttl;
}

// ─── MLB API HELPERS ──────────────────────────────────────────────────────────

/**
 * Fetch today's MLB schedule with probable pitchers
 */
async function fetchTodaySchedule() {
  const today = new Date().toISOString().split('T')[0];
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher(stats)`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    return data.dates?.[0]?.games || [];
  } catch (err) {
    console.error('MLB schedule fetch error:', err.message);
    return [];
  }
}

/**
 * Fetch pitcher season stats
 */
async function fetchPitcherStats(playerId) {
  if (!playerId) return null;
  const season = new Date().getFullYear();
  const url = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=season&season=${season}&group=pitching`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    const stats = data.stats?.[0]?.splits?.[0]?.stat;
    if (!stats) return null;

    return {
      era: parseFloat(stats.era || 0).toFixed(2),
      whip: parseFloat(stats.whip || 0).toFixed(2),
      strikeoutsPer9: parseFloat(stats.strikeoutsPer9Inn || 0).toFixed(1),
      walksPer9: parseFloat(stats.walksPer9Inn || 0).toFixed(1),
      wins: stats.wins || 0,
      losses: stats.losses || 0,
      inningsPitched: stats.inningsPitched || '0.0',
      gamesStarted: stats.gamesStarted || 0,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Fetch pitcher's last 5 game log
 */
async function fetchRecentPitcherLog(playerId) {
  if (!playerId) return null;
  const season = new Date().getFullYear();
  const url = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${season}&group=pitching&limit=5`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    const games = data.stats?.[0]?.splits?.slice(0, 5) || [];

    if (games.length === 0) return 'No recent starts';

    const summary = games.map(g => {
      const s = g.stat;
      const result = parseFloat(s.era) < 3.5 ? 'Q' : 'NS'; // Quality start indicator
      return `${s.inningsPitched}IP ${s.earnedRuns}ER`;
    }).join(', ');

    return `Last ${games.length}: ${summary}`;
  } catch {
    return null;
  }
}

/**
 * Fetch weather for a stadium
 */
async function fetchWeather(teamAbbr) {
  const coords = STADIUM_COORDS[teamAbbr];
  if (!coords) return null;

  // Skip weather for indoor stadiums
  const indoorStadiums = ['TB', 'TOR', 'HOU', 'MIA', 'ARI', 'TEX'];
  if (indoorStadiums.includes(teamAbbr)) {
    return { temp: 72, windSpeed: 0, windDir: 'Indoor', condition: 'Dome', impact: 'Neutral — Indoor stadium' };
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,wind_speed_10m,wind_direction_10m,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=1`;
    const res = await fetch(url);
    const data = await res.json();
    const current = data.current;

    const temp = Math.round(current.temperature_2m);
    const windSpeed = Math.round(current.wind_speed_10m);
    const windDir = getWindDirection(current.wind_direction_10m);

    // Assess weather impact on betting
    let impact = 'Neutral';
    if (windSpeed >= 15) {
      impact = windDir.includes('Out') ? 'Hitter-friendly — strong wind out, consider OVER' : 'Pitcher-friendly — strong wind in, consider UNDER';
    } else if (temp < 45) {
      impact = 'Cold weather — slight edge to pitchers, lower scoring expected';
    } else if (temp > 90) {
      impact = 'Hot weather — ball carries further, slight edge to hitters';
    }

    return { temp, windSpeed, windDir, impact, stadium: coords.name };
  } catch (err) {
    return null;
  }
}

function getWindDirection(degrees) {
  if (degrees >= 315 || degrees < 45)  return 'N (varies by stadium)';
  if (degrees >= 45  && degrees < 135) return 'E (In from RF)';
  if (degrees >= 135 && degrees < 225) return 'S (Out to CF)';
  if (degrees >= 225 && degrees < 315) return 'W (Out to LF)';
  return 'Variable';
}

// ─── TEAM ABBR MAP ────────────────────────────────────────────────────────────
// Maps MLB API team names to our abbreviations
const MLB_API_TEAM_MAP = {
  "New York Yankees": "NYY", "Boston Red Sox": "BOS", "Toronto Blue Jays": "TOR",
  "Tampa Bay Rays": "TB", "Baltimore Orioles": "BAL", "Cleveland Guardians": "CLE",
  "Minnesota Twins": "MIN", "Chicago White Sox": "CWS", "Kansas City Royals": "KC",
  "Detroit Tigers": "DET", "Houston Astros": "HOU", "Texas Rangers": "TEX",
  "Seattle Mariners": "SEA", "Oakland Athletics": "OAK", "Athletics": "OAK", "Sacramento Athletics": "OAK", "Los Angeles Angels": "LAA",
  "Atlanta Braves": "ATL", "New York Mets": "NYM", "Philadelphia Phillies": "PHI",
  "Miami Marlins": "MIA", "Washington Nationals": "WSH", "Chicago Cubs": "CHC",
  "Milwaukee Brewers": "MIL", "St. Louis Cardinals": "STL", "Cincinnati Reds": "CIN",
  "Pittsburgh Pirates": "PIT", "Los Angeles Dodgers": "LAD", "San Francisco Giants": "SF",
  "San Diego Padres": "SD", "Arizona Diamondbacks": "ARI", "Colorado Rockies": "COL",
};


// ─── BASEBALL SAVANT INTEGRATION ─────────────────────────────────────────────

/**
 * Fetch pitcher statcast data from Baseball Savant
 * Returns whiff rate, strikeout rate, hard hit rate, spin rate, velocity
 */
async function fetchPitcherStatcast(pitcherName, season) {
  try {
    // Baseball Savant search API
    const url = `https://baseballsavant.mlb.com/leader/custom?year=${season}&type=pitcher&filter=&sort=4&sortDir=desc&min=10&selections=k_percent,whiff_percent,hard_hit_percent,avg_best_speed,spin_rate_formatted&limit=500`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'EdgeSKR/1.0' }
    });
    const data = await res.json();

    // Find pitcher by name
    const pitcher = data?.find(p =>
      p.player_name?.toLowerCase().includes(pitcherName.toLowerCase().split(' ').pop()) ||
      pitcherName.toLowerCase().includes(p.player_name?.toLowerCase().split(', ')[0] || '')
    );

    if (!pitcher) return null;

    return {
      kPercent: parseFloat(pitcher.k_percent || 0).toFixed(1),
      whiffPercent: parseFloat(pitcher.whiff_percent || 0).toFixed(1),
      hardHitPercent: parseFloat(pitcher.hard_hit_percent || 0).toFixed(1),
      avgVelocity: parseFloat(pitcher.avg_best_speed || 0).toFixed(1),
      spinRate: pitcher.spin_rate_formatted || 'N/A',
    };
  } catch (err) {
    console.error('Savant pitcher fetch error:', err.message);
    return null;
  }
}

/**
 * Fetch team batting statcast data
 * Returns hard hit rate, barrel rate, chase rate, platoon splits
 */
async function fetchTeamBattingStatcast(teamAbbr, season) {
  try {
    const url = `https://baseballsavant.mlb.com/leader/custom?year=${season}&type=batter&filter=&sort=4&sortDir=desc&min=50&selections=batting_avg,on_base_plus_slg,k_percent,bb_percent,hard_hit_percent,barrel_batted_rate,chase_percent&limit=1000`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'EdgeSKR/1.0' }
    });
    const data = await res.json();

    // Filter by team
    const teamPlayers = data?.filter(p => p.team_abbrev === teamAbbr) || [];
    if (teamPlayers.length === 0) return null;

    // Calculate team averages
    const avg = (key) => {
      const vals = teamPlayers.map(p => parseFloat(p[key] || 0)).filter(v => v > 0);
      return vals.length > 0 ? (vals.reduce((a,b) => a+b, 0) / vals.length).toFixed(1) : 'N/A';
    };

    // Find hottest batter (highest OPS)
    const hotBatter = teamPlayers.sort((a,b) =>
      parseFloat(b.on_base_plus_slg || 0) - parseFloat(a.on_base_plus_slg || 0)
    )[0];

    return {
      teamHardHitPct: avg('hard_hit_percent'),
      teamBarrelRate: avg('barrel_batted_rate'),
      teamChasePct: avg('chase_percent'),
      teamKPct: avg('k_percent'),
      hotBatter: hotBatter ? {
        name: hotBatter.player_name?.split(', ').reverse().join(' ') || 'Unknown',
        avg: hotBatter.batting_avg || '.000',
        ops: hotBatter.on_base_plus_slg || '.000',
        hardHitPct: hotBatter.hard_hit_percent || '0',
        barrelRate: hotBatter.barrel_batted_rate || '0',
        kPct: hotBatter.k_percent || '0',
      } : null,
    };
  } catch (err) {
    console.error('Savant batting fetch error:', err.message);
    return null;
  }
}

/**
 * Fetch platoon splits for a pitcher
 * vs LHB and vs RHB stats
 */
async function fetchPlatoonSplits(pitcherName, season) {
  try {
    const url = `https://baseballsavant.mlb.com/platoon-usage?year=${season}&type=pitcher&min=10`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'EdgeSKR/1.0' }
    });
    const data = await res.json();

    const pitcher = data?.find(p =>
      p.player_name?.toLowerCase().includes(pitcherName.toLowerCase().split(' ').pop())
    );

    if (!pitcher) return null;

    return {
      vsLHB_avg: pitcher.batting_avg_L || '.000',
      vsRHB_avg: pitcher.batting_avg_R || '.000',
      vsLHB_slg: pitcher.slg_L || '.000',
      vsRHB_slg: pitcher.slg_R || '.000',
      vsLHB_kPct: pitcher.k_percent_L || '0',
      vsRHB_kPct: pitcher.k_percent_R || '0',
    };
  } catch (err) {
    return null;
  }
}

// ─── ROSTER & INJURY TRACKER ──────────────────────────────────────────────────

/**
 * Fetch IL players, active roster, and recent transactions for a team.
 * teamId: numeric MLB API team ID (from MLB_TEAM_IDS or schedule API)
 * teamAbbr: e.g. "NYY"
 */
async function fetchRosterAndInjuries(teamId, teamAbbr) {
  if (!teamId) return { injuries: [], rosterMoves: [], keyInjury: null, ilCount: 0 };

  const season = new Date().getFullYear();
  const today = new Date().toISOString().split('T')[0];
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    const [ilRes, transRes] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=injured&season=${season}`),
      fetch(`https://statsapi.mlb.com/api/v1/transactions?teamId=${teamId}&startDate=${threeDaysAgo}&endDate=${today}`),
    ]);

    const [ilData, transData] = await Promise.all([ilRes.json(), transRes.json()]);

    // Parse IL players
    const ilPlayers = (ilData.roster || []).map(p => ({
      name: p.person?.fullName || 'Unknown',
      status: p.status?.description || 'IL',
      position: p.position?.type || 'Unknown',
      posAbbr: p.position?.abbreviation || '',
    }));

    const injuryList = ilPlayers.map(p => `${p.name} (${p.status})`);

    // Flag key injuries: pitchers on IL, or 3+ IL players (depth concern)
    const pitchersOnIL = ilPlayers.filter(p =>
      p.position === 'Pitcher' || p.posAbbr === 'SP' || p.posAbbr === 'P'
    );
    let keyInjury = null;
    if (pitchersOnIL.length > 0) {
      keyInjury = `${teamAbbr} pitcher(s) on IL: ${pitchersOnIL.map(p => p.name).join(', ')}`;
    } else if (ilPlayers.length >= 3) {
      keyInjury = `${teamAbbr}: ${ilPlayers.length} players on IL — verify lineup depth`;
    }

    // Parse recent transactions (last 3 days)
    const rosterMoves = (transData.transactions || [])
      .filter(t => t.typeDesc)
      .slice(0, 5)
      .map(t => `${t.player?.fullName || 'Player'}: ${t.typeDesc}`);

    return { injuries: injuryList, rosterMoves, keyInjury, ilCount: ilPlayers.length };

  } catch (err) {
    console.error(`Injury fetch error for ${teamAbbr}:`, err.message);
    return { injuries: [], rosterMoves: [], keyInjury: null, ilCount: 0 };
  }
}

// ─── MAIN ENRICHER ────────────────────────────────────────────────────────────

/**
 * Main function — enriches all picks with pitcher stats + weather
 * Returns a map of gameKey → enriched data
 */
async function enrichPicks(picks) {
  if (isCacheValid()) {
    console.log('📊 Using cached enriched data');
    return enrichCache.data;
  }

  console.log('🔍 Fetching MLB enriched data...');
  const enriched = {};

  try {
    // Fetch today's schedule with probable pitchers
    const games = await fetchTodaySchedule();
    console.log(`⚾ Found ${games.length} MLB games today`);

    // Process each game
    for (const game of games) {
      const homeTeam = game.teams?.home?.team?.name;
      const awayTeam = game.teams?.away?.team?.name;
      const homeAbbr = MLB_API_TEAM_MAP[homeTeam];
      const awayAbbr = MLB_API_TEAM_MAP[awayTeam];

      if (!homeAbbr || !awayAbbr) continue;

      const gameKey = `${awayAbbr}_${homeAbbr}`;

      // Get probable pitchers
      const homePitcherId = game.teams?.home?.probablePitcher?.id;
      const awayPitcherId = game.teams?.away?.probablePitcher?.id;
      const homePitcherName = game.teams?.home?.probablePitcher?.fullName || 'TBD';
      const awayPitcherName = game.teams?.away?.probablePitcher?.fullName || 'TBD';

      const season = new Date().getFullYear();

      // Team IDs from the schedule API (same values as MLB_TEAM_IDS in cron.js)
      const homeTeamId = game.teams?.home?.team?.id || MLB_TEAM_IDS[homeAbbr];
      const awayTeamId = game.teams?.away?.team?.id || MLB_TEAM_IDS[awayAbbr];

      // Fetch all data in parallel including Baseball Savant and injuries
      const [
        homePitcherStats, awayPitcherStats,
        homeLog, awayLog,
        weather,
        homeSavant, awaySavant,
        homeBatting, awayBatting,
        homePlatoon, awayPlatoon,
        homeInjuryData, awayInjuryData,
      ] = await Promise.all([
        fetchPitcherStats(homePitcherId),
        fetchPitcherStats(awayPitcherId),
        fetchRecentPitcherLog(homePitcherId),
        fetchRecentPitcherLog(awayPitcherId),
        fetchWeather(homeAbbr),
        fetchPitcherStatcast(homePitcherName, season),
        fetchPitcherStatcast(awayPitcherName, season),
        fetchTeamBattingStatcast(homeAbbr, season),
        fetchTeamBattingStatcast(awayAbbr, season),
        fetchPlatoonSplits(homePitcherName, season),
        fetchPlatoonSplits(awayPitcherName, season),
        fetchRosterAndInjuries(homeTeamId, homeAbbr),
        fetchRosterAndInjuries(awayTeamId, awayAbbr),
      ]);

      const combinedKeyInjuries = [homeInjuryData.keyInjury, awayInjuryData.keyInjury]
        .filter(Boolean).join(' | ') || null;

      enriched[gameKey] = {
        homePitcher: {
          name: homePitcherName,
          ...(homePitcherStats || { era: 'N/A', whip: 'N/A' }),
          lastFive: homeLog || 'N/A',
          statcast: homeSavant,
          platoon: homePlatoon,
        },
        awayPitcher: {
          name: awayPitcherName,
          ...(awayPitcherStats || { era: 'N/A', whip: 'N/A' }),
          lastFive: awayLog || 'N/A',
          statcast: awaySavant,
          platoon: awayPlatoon,
        },
        homeBatting,
        awayBatting,
        weather,
        homeTeam,
        awayTeam,
        homeInjuries: homeInjuryData.injuries,
        awayInjuries: awayInjuryData.injuries,
        homeRosterMoves: homeInjuryData.rosterMoves,
        awayRosterMoves: awayInjuryData.rosterMoves,
        keyInjuries: combinedKeyInjuries,
      };

      console.log(`✅ Enriched: ${awayAbbr} @ ${homeAbbr}`);
    }

    // Cache the result
    enrichCache.data = enriched;
    enrichCache.fetchedAt = Date.now();

    return enriched;

  } catch (err) {
    console.error('Enrichment error:', err.message);
    return enriched;
  }
}

/**
 * Return the current enriched cache without re-fetching.
 * Returns null if cache is cold or expired.
 */
function getEnrichedCache() {
  return isCacheValid() ? enrichCache.data : null;
}

module.exports = { enrichPicks, getEnrichedCache, fetchWeather, fetchPitcherStatcast, fetchTeamBattingStatcast, STADIUM_COORDS };
