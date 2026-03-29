/**
 * mlbDataEnricher.js
 * Fetches real MLB pitcher stats, weather, and game data
 * to enrich the AI agent's analysis.
 *
 * Data sources:
 * - MLB Stats API (free, official): statsapi.mlb.com
 * - Open-Meteo (free weather API): api.open-meteo.com
 */

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

    const fipRaw = stats.fieldingIndependentPitching;
    return {
      era: parseFloat(stats.era || 0).toFixed(2),
      fip: (fipRaw != null && parseFloat(fipRaw) > 0) ? parseFloat(fipRaw).toFixed(2) : null,
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
 * Fetch pitcher's most recent start to assess fatigue.
 * Returns pitch count, days since last start, innings pitched, and fatigue label.
 */
async function fetchPitcherLastStart(pitcherId) {
  if (!pitcherId) return null;
  const season = new Date().getFullYear();
  const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=${season}&group=pitching&limit=1`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    const lastGame = data.stats?.[0]?.splits?.[0];
    if (!lastGame) return null;

    const stat = lastGame.stat;
    const gameDate = lastGame.date; // YYYY-MM-DD
    const daysSinceLastStart = Math.floor((Date.now() - new Date(gameDate).getTime()) / (1000 * 60 * 60 * 24));
    const pitchCount = stat.numberOfPitches || 0;
    const inningsPitched = parseFloat(stat.inningsPitched || 0);

    let fatigue = 'normal';
    let fatigueNote = null;

    if (inningsPitched >= 9) {
      fatigue = 'fatigued';
      fatigueNote = 'Complete game last start — higher fatigue risk';
    } else if (daysSinceLastStart <= 3) {
      fatigue = 'fatigued';
      fatigueNote = `Only ${daysSinceLastStart} days rest`;
    } else if (daysSinceLastStart === 4 && pitchCount >= 100) {
      fatigue = 'fatigued';
      fatigueNote = `High pitch count (${pitchCount}) on 4 days rest`;
    } else if (daysSinceLastStart >= 5) {
      fatigue = 'well_rested';
      fatigueNote = `${daysSinceLastStart} days rest — well rested`;
    }

    return { pitchCount, daysSinceLastStart, inningsPitched, fatigue, fatigueNote };
  } catch (err) {
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

const SAVANT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://baseballsavant.mlb.com/',
};

/**
 * Parse a simple CSV string into an array of objects.
 * Handles quoted fields (including commas inside quotes).
 */
function parseSavantCsv(text) {
  if (!text || text.trimStart().startsWith('<')) return null;
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return null;
  const parseRow = (line) => {
    const fields = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { fields.push(cur); cur = ''; }
      else { cur += ch; }
    }
    fields.push(cur);
    return fields;
  };
  const headers = parseRow(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseRow(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  });
}

/**
 * Fetch pitcher statcast data from Baseball Savant
 * Returns whiff rate, strikeout rate, hard hit rate, spin rate, velocity
 */
async function fetchPitcherStatcast(pitcherName, season) {
  try {
    const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${season}&type=pitcher&filter=&sort=4&sortDir=desc&min=10&selections=k_percent,whiff_percent,hard_hit_percent,avg_best_speed,spin_rate_formatted&limit=500&csv=true`;
    const res = await fetch(url, { headers: SAVANT_HEADERS });
    const data = parseSavantCsv(await res.text());
    if (!data) return null;

    // CSV has "last_name, first_name" in player_name field; match by last name or first name
    const last = pitcherName.toLowerCase().split(' ').pop();
    const first = pitcherName.toLowerCase().split(' ')[0];
    const pitcher = data.find(p => {
      const name = p['last_name, first_name']?.toLowerCase() || '';
      return name.startsWith(last + ',') || name.endsWith(', ' + first) || name.includes(last);
    });

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
 * Fetch team batting data from the MLB Stats API.
 * Returns K%, BB%, AVG, OPS at the team level, plus the top individual hitter.
 * (Chase% and hard-hit% require Savant team filtering which is unavailable server-side.)
 */
async function fetchTeamBattingStatcast(teamAbbr, season) {
  try {
    const teamId = MLB_TEAM_IDS[teamAbbr];
    if (!teamId) return null;

    // Fetch team-level aggregate hitting stats
    const teamUrl = `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=hitting&season=${season}&gameType=R`;
    const rosterUrl = `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=hitting&season=${season}&gameType=R&playerPool=All`;

    const [teamRes, rosterRes] = await Promise.all([
      fetch(teamUrl).then(r => r.json()),
      fetch(rosterUrl).then(r => r.json()),
    ]);

    const teamStat = teamRes.stats?.[0]?.splits?.[0]?.stat;
    if (!teamStat) return null;

    const pa = parseInt(teamStat.plateAppearances || 1);
    const teamKPct = pa > 0 ? ((parseInt(teamStat.strikeOuts || 0) / pa) * 100).toFixed(1) : 'N/A';
    const teamBBPct = pa > 0 ? ((parseInt(teamStat.baseOnBalls || 0) / pa) * 100).toFixed(1) : 'N/A';

    // Find hot batter (highest OPS among qualifiers)
    const splits = rosterRes.stats?.[0]?.splits || [];
    const qualifiers = splits.filter(s => parseInt(s.stat?.plateAppearances || 0) >= 20);
    const hotSplit = qualifiers.sort((a, b) =>
      parseFloat(b.stat?.ops || 0) - parseFloat(a.stat?.ops || 0)
    )[0];

    const hotBatter = hotSplit ? {
      name: hotSplit.player?.fullName || 'Unknown',
      avg: hotSplit.stat?.avg || '.000',
      ops: hotSplit.stat?.ops || '.000',
      hardHitPct: 'N/A',
      barrelRate: 'N/A',
      kPct: hotSplit.stat?.plateAppearances > 0
        ? ((parseInt(hotSplit.stat.strikeOuts || 0) / parseInt(hotSplit.stat.plateAppearances)) * 100).toFixed(1)
        : 'N/A',
    } : null;

    return {
      teamHardHitPct: 'N/A',
      teamBarrelRate: 'N/A',
      teamChasePct: 'N/A',
      teamKPct,
      teamBBPct,
      teamAvg: teamStat.avg || 'N/A',
      teamOps: teamStat.ops || 'N/A',
      hotBatter,
    };
  } catch (err) {
    console.error('Team batting fetch error:', err.message);
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
    const res = await fetch(url, { headers: SAVANT_HEADERS });
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

// ─── FANGRAPHS INTEGRATION ────────────────────────────────────────────────────
// Exclusive to EDGESEEKER premium agent — NOT called from enrichPicks()

const FANGRAPHS_TEAM_IDS = {
  LAA: 1, HOU: 21, OAK: 10, TOR: 14, ATL: 16,
  MIL: 23, STL: 28, CHC: 17, ARI: 15, LAD: 22,
  SF: 30, CLE: 5, SEA: 11, MIA: 20, NYM: 25,
  WSH: 24, BAL: 2, SD: 29, PHI: 26, PIT: 27,
  TEX: 13, TB: 12, BOS: 3, CIN: 18, COL: 19,
  KC: 7, DET: 6, MIN: 8, CWS: 4, NYY: 9,
};

/**
 * Fetch FanGraphs FIP and bullpen data for a team.
 * Used ONLY by the premium EDGESEEKER agent — not the free tier or general picks model.
 */
async function fetchFanGraphsPitching(teamAbbr) {
  try {
    const teamId = FANGRAPHS_TEAM_IDS[teamAbbr];
    if (!teamId) return null;
    const url = `https://www.fangraphs.com/api/leaders/major-league/data?pos=all&stats=pit&lg=all&qual=0&season=2026&season1=2026&team=${teamId}&pageitems=30&type=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'EdgeSeeker/1.0' } });
    const data = await res.json();
    const starters = data?.data?.filter(p => p.GS > 0) || [];
    const relievers = data?.data?.filter(p => p.GS === 0) || [];
    const avg = (arr, key) => {
      const vals = arr.map(p => parseFloat(p[key] || 0)).filter(v => v > 0);
      return vals.length > 0 ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : 'N/A';
    };
    return {
      starterFIP: avg(starters, 'FIP'),
      starterXFIP: avg(starters, 'xFIP'),
      bullpenERA: avg(relievers, 'ERA'),
      bullpenFIP: avg(relievers, 'FIP'),
      k9: avg(starters, 'K/9'),
      bb9: avg(starters, 'BB/9'),
    };
  } catch (err) {
    console.error(`FanGraphs fetch error for ${teamAbbr}:`, err.message);
    return null;
  }
}

/**
 * Fetch team season hitting stats to derive strikeout rate.
 * teamId: numeric MLB API team ID
 * Returns { strikeoutRate (SO/AB as %), strikeoutsPerGame }
 */
async function fetchTeamStrikeoutRate(teamId) {
  if (!teamId) return null;
  const season = new Date().getFullYear();
  const url = `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=hitting&season=${season}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    const stats = data.stats?.[0]?.splits?.[0]?.stat;
    if (!stats) return null;

    const so = parseInt(stats.strikeOuts || 0);
    const ab = parseInt(stats.atBats || 1);
    const gamesPlayed = parseInt(stats.gamesPlayed || 1);

    return {
      strikeoutRate: parseFloat(((so / ab) * 100).toFixed(1)),
      strikeoutsPerGame: parseFloat((so / gamesPlayed).toFixed(1)),
    };
  } catch (err) {
    console.error(`Team strikeout rate fetch error for teamId ${teamId}:`, err.message);
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

    // Parse IL players — filter to only genuine injury statuses
    const IL_KEYWORDS = ['il', 'injured', '10-day', '15-day', '60-day', '7-day', 'bereavement', 'paternity', 'restricted', 'suspended'];
    const ilPlayers = (ilData.roster || [])
      .map(p => ({
        name: p.person?.fullName || 'Unknown',
        status: p.status?.description || 'IL',
        position: p.position?.type || 'Unknown',
        posAbbr: p.position?.abbreviation || '',
      }))
      .filter(p => {
        const s = p.status.toLowerCase();
        return IL_KEYWORDS.some(kw => s.includes(kw)) && !s.includes('active');
      });

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

      // Fetch all data in parallel including Baseball Savant, injuries, and last starts
      const [
        homePitcherStats, awayPitcherStats,
        homeLog, awayLog,
        homeLastStart, awayLastStart,
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
        fetchPitcherLastStart(homePitcherId),
        fetchPitcherLastStart(awayPitcherId),
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
          ...(homePitcherStats || { era: 'N/A', whip: 'N/A', fip: null }),
          lastFive: homeLog || 'N/A',
          lastStart: homeLastStart || null,
          statcast: homeSavant,
          platoon: homePlatoon,
        },
        awayPitcher: {
          name: awayPitcherName,
          ...(awayPitcherStats || { era: 'N/A', whip: 'N/A', fip: null }),
          lastFive: awayLog || 'N/A',
          lastStart: awayLastStart || null,
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
 * Fetch the last 5 pitching starts from the MLB Stats API game log.
 * pitcherId: numeric MLB player ID
 * Returns [{ date, strikeouts, inningsPitched, result }] or []
 */
async function fetchPitcherGameLog(pitcherId) {
  if (!pitcherId) return [];
  const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=2026&sportId=1`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const splits = data.stats?.[0]?.splits;
    if (!splits || splits.length === 0) return [];

    return splits.slice(-5).map(s => {
      const d = new Date(s.date);
      const date = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
      return {
        date,
        strikeouts: parseInt(s.stat?.strikeOuts ?? 0),
        inningsPitched: s.stat?.inningsPitched ?? '0.0',
        result: s.stat?.wins > 0 ? 'W' : s.stat?.losses > 0 ? 'L' : 'ND',
      };
    });
  } catch (err) {
    console.error(`fetchPitcherGameLog error for pitcherId ${pitcherId}:`, err.message);
    return [];
  }
}

/**
 * Fetch Statcast pitch-level data for a pitcher and compute velocity trend.
 * pitcherName: full name string, e.g. "Gerrit Cole"
 * Returns { seasonAvgVelo, last5AvgVelo, trend: 'up'|'down'|'stable', deltaMph } or null
 */
async function fetchPitcherVelocityTrend(pitcherName) {
  if (!pitcherName) return null;
  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const encodedName = encodeURIComponent(pitcherName);
  const url = `https://baseballsavant.mlb.com/statcast_search/csv?player_type=pitcher&player_lookup_type=name&player_search_full=${encodedName}&type=details&game_date_gt=${thirtyDaysAgo}&game_date_lt=${today}`;

  try {
    const res = await fetch(url, { headers: SAVANT_HEADERS });
    const text = await res.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;

    const headers = lines[0].split(',');
    const veloIdx = headers.indexOf('release_speed');
    const dateIdx = headers.indexOf('game_date');
    if (veloIdx === -1 || dateIdx === -1) return null;

    const rows = lines.slice(1).map(line => {
      const cols = line.split(',');
      return { date: cols[dateIdx], velo: parseFloat(cols[veloIdx]) };
    }).filter(r => !isNaN(r.velo) && r.velo > 0);

    if (rows.length < 10) return null;

    const seasonAvgVelo = parseFloat((rows.reduce((sum, r) => sum + r.velo, 0) / rows.length).toFixed(1));

    // Get unique game dates sorted descending, take last 5
    const uniqueDates = [...new Set(rows.map(r => r.date))].sort().slice(-5);
    const last5Rows = rows.filter(r => uniqueDates.includes(r.date));
    if (last5Rows.length === 0) return null;

    const last5AvgVelo = parseFloat((last5Rows.reduce((sum, r) => sum + r.velo, 0) / last5Rows.length).toFixed(1));
    const deltaMph = parseFloat((last5AvgVelo - seasonAvgVelo).toFixed(1));
    const trend = deltaMph > 0.3 ? 'up' : deltaMph < -0.3 ? 'down' : 'stable';

    return { seasonAvgVelo, last5AvgVelo, trend, deltaMph };
  } catch (err) {
    console.error(`fetchPitcherVelocityTrend error for ${pitcherName}:`, err.message);
    return null;
  }
}

/**
 * Fetch batter Statcast data from Baseball Savant.
 * Returns barrel rate, exit velocity, HR/FB%, fly ball rate, and recent HR counts.
 */
async function fetchBatterStatcast(batterName) {
  if (!batterName) return null;
  try {
    const encodedName = encodeURIComponent(batterName);
    const summaryUrl = `https://baseballsavant.mlb.com/statcast_search/csv?player_type=batter&player_lookup_type=name&player_search_full=${encodedName}&type=summary&season=2026`;
    const summaryRes = await fetch(summaryUrl, { headers: SAVANT_HEADERS });
    const summaryText = await summaryRes.text();
    const summaryData = parseSavantCsv(summaryText);
    if (!summaryData || summaryData.length === 0) return null;

    const row = summaryData[0];

    const barrelRaw = parseFloat(row['barrel_batted_rate']);
    const evoRaw    = parseFloat(row['launch_speed_avg']);
    const hrFbRaw   = parseFloat(row['hr_fb_rate']);
    const fbPctRaw  = parseFloat(row['fb_pct']);

    const barrelRate = !isNaN(barrelRaw) ? `${barrelRaw.toFixed(1)}%` : null;
    const exitVelo   = !isNaN(evoRaw)    ? `${evoRaw.toFixed(1)}mph`  : null;
    const hrPerFB    = !isNaN(hrFbRaw)   ? `${hrFbRaw.toFixed(1)}%`   : null;
    const fbPct      = !isNaN(fbPctRaw)  ? `${fbPctRaw.toFixed(1)}%`  : null;

    // Fetch last 14 days of pitch-level details to count recent HR game-dates
    const today        = new Date().toISOString().split('T')[0];
    const fourteenAgo  = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const sevenAgo     = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const detailsUrl   = `https://baseballsavant.mlb.com/statcast_search/csv?player_type=batter&player_lookup_type=name&player_search_full=${encodedName}&type=details&game_date_gt=${fourteenAgo}&game_date_lt=${today}&season=2026`;

    let recentHR7  = null;
    let recentHR14 = null;

    try {
      const detailsRes  = await fetch(detailsUrl, { headers: SAVANT_HEADERS });
      const detailsText = await detailsRes.text();
      const detailsData = parseSavantCsv(detailsText);

      if (detailsData && detailsData.length > 0) {
        // Count rows where events === 'home_run', split by 7 / 14 day windows
        const hrRows14 = detailsData.filter(r => r['events'] === 'home_run');
        const hrRows7  = hrRows14.filter(r => r['game_date'] >= sevenAgo);
        recentHR14 = hrRows14.length;
        recentHR7  = hrRows7.length;
      }
    } catch (_) {
      // recentHR fields stay null — non-fatal
    }

    return { barrelRate, exitVelo, hrPerFB, fbPct, recentHR7, recentHR14, hand: null };
  } catch (err) {
    console.error(`fetchBatterStatcast error for ${batterName}:`, err.message);
    return null;
  }
}

/**
 * Fetch pitcher HR-allowed Statcast data from Baseball Savant.
 * Returns HR/9, fly ball rate allowed, barrel% allowed, avg EV allowed.
 */
async function fetchPitcherHRStats(pitcherName) {
  if (!pitcherName) return null;
  try {
    const encodedName = encodeURIComponent(pitcherName);
    const url = `https://baseballsavant.mlb.com/statcast_search/csv?player_type=pitcher&player_lookup_type=name&player_search_full=${encodedName}&type=summary&season=2026`;
    const res  = await fetch(url, { headers: SAVANT_HEADERS });
    const text = await res.text();
    const data = parseSavantCsv(text);
    if (!data || data.length === 0) return null;

    const row = data[0];

    const hrRaw     = parseFloat(row['hr']);
    const ipStr     = row['p_formatted_ip'] || '';
    const barrelRaw = parseFloat(row['barrel_batted_rate']);
    const evRaw     = parseFloat(row['launch_speed_avg']);
    const fbRaw     = parseFloat(row['fb_pct']);

    // Parse formatted IP (e.g. "23.1" means 23 full innings + 1 out = 23.333)
    const ipParts = ipStr.split('.');
    const fullInnings = parseInt(ipParts[0]) || 0;
    const outs        = parseInt(ipParts[1]) || 0;
    const ip          = fullInnings + (outs / 3);

    if (isNaN(hrRaw) || ip < 5) return null;

    const hr9          = ((hrRaw / ip) * 9).toFixed(2);
    const fbPct        = !isNaN(fbRaw)     ? `${fbRaw.toFixed(1)}%`    : null;
    const barrelAllowed = !isNaN(barrelRaw) ? `${barrelRaw.toFixed(1)}%` : null;
    const evAllowed    = !isNaN(evRaw)      ? `${evRaw.toFixed(1)}mph`   : null;

    return { hr9, fbPct, barrelAllowed, evAllowed };
  } catch (err) {
    console.error(`fetchPitcherHRStats error for ${pitcherName}:`, err.message);
    return null;
  }
}

/**
 * Return the current enriched cache without re-fetching.
 * Returns null if cache is cold or expired.
 */
function getEnrichedCache() {
  return isCacheValid() ? enrichCache.data : null;
}

module.exports = { enrichPicks, getEnrichedCache, fetchWeather, fetchPitcherStatcast, fetchTeamBattingStatcast, fetchFanGraphsPitching, fetchTeamStrikeoutRate, fetchPitcherLastStart, fetchPitcherGameLog, fetchPitcherVelocityTrend, fetchBatterStatcast, fetchPitcherHRStats, STADIUM_COORDS };
