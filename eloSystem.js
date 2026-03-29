/**
 * eloSystem.js
 * Edge Seeker — MLB Team Elo Rating System
 *
 * How Elo works:
 * - Every team starts with a seed rating based on 2025 performance + offseason moves
 * - After each game, the winner gains Elo and the loser loses Elo
 * - Amount gained/lost depends on the opponent's strength
 * - Beat a strong team = gain more. Lose to a weak team = lose more.
 * - K-factor controls how fast ratings move (we use 20 for baseball)
 *
 * Elo ranges:
 * 1600+ = Elite (World Series contender)
 * 1500-1599 = Strong (playoff team)
 * 1400-1499 = Average (borderline playoff)
 * 1300-1399 = Below average (rebuilding)
 * <1300 = Weak (full rebuild)
 */


// K-factor — how much Elo changes per game
// 20 is standard for MLB (higher = more volatile)
const K_FACTOR = 20;

// Home field advantage in Elo points
const HOME_ADVANTAGE = 25;

/**
 * 2026 Opening Day Elo Seeds
 * Based on:
 * - 2025 final win totals and playoff results
 * - Offseason additions and losses
 * - FanGraphs 2026 win projections
 * - Injury reports heading into Opening Day
 */
const OPENING_DAY_ELO = {
  // ── AMERICAN LEAGUE EAST ──────────────────────────────────────────────────
  NYY: { elo: 1540, trend: 'up',   note: 'Lost Cole/Rodón early, but deep lineup' },
  BOS: { elo: 1520, trend: 'up',   note: 'Crochet ace, strong offense' },
  BAL: { elo: 1510, trend: 'up',   note: 'Henderson bounce-back, Alonso added' },
  TOR: { elo: 1460, trend: 'down', note: 'Lost Bichette, rebuilding around Vladdy' },
  TB:  { elo: 1490, trend: 'up',   note: 'Caminero 45 HR, young core emerging' },

  // ── AMERICAN LEAGUE CENTRAL ───────────────────────────────────────────────
  DET: { elo: 1510, trend: 'up',   note: 'Skubal AL Cy Young, Greene breakout' },
  KC:  { elo: 1500, trend: 'up',   note: 'Witt Jr. elite, competitive core' },
  CLE: { elo: 1495, trend: 'up',   note: 'Ramirez anchor, young rotation' },
  MIN: { elo: 1450, trend: 'down', note: 'Buxton health concern, Lewis back' },
  CWS: { elo: 1280, trend: 'down', note: 'Full rebuild, worst team in baseball' },

  // ── AMERICAN LEAGUE WEST ──────────────────────────────────────────────────
  HOU: { elo: 1550, trend: 'up',   note: 'Alvarez MVP, Walker added, deep rotation' },
  SEA: { elo: 1510, trend: 'up',   note: 'Cal Raleigh MVP candidate, elite defense' },
  TEX: { elo: 1480, trend: 'down', note: 'Seager healthy, rotation question marks' },
  LAA: { elo: 1420, trend: 'up',   note: 'Trout healthy in CF, Soler added' },
  OAK: { elo: 1390, trend: 'up',   note: 'Rooker/Kurtz young core, developing' },

  // ── NATIONAL LEAGUE EAST ──────────────────────────────────────────────────
  PHI: { elo: 1560, trend: 'up',   note: 'Sanchez NL Cy Young candidate, Harper/Turner' },
  NYM: { elo: 1555, trend: 'up',   note: 'Soto + Bichette + Lindor — dangerous lineup' },
  ATL: { elo: 1545, trend: 'up',   note: 'Acuña back healthy, defending NL East' },
  WSH: { elo: 1400, trend: 'up',   note: 'Wood breakout, Abrams young core' },
  MIA: { elo: 1360, trend: 'down', note: 'Full rebuild, Alcantara returning from TJS' },

  // ── NATIONAL LEAGUE CENTRAL ───────────────────────────────────────────────
  CHC: { elo: 1530, trend: 'up',   note: 'Bregman huge addition, contender' },
  MIL: { elo: 1490, trend: 'up',   note: 'Chourio emerging, Contreras core' },
  CIN: { elo: 1460, trend: 'up',   note: 'De La Cruz elite, young core' },
  STL: { elo: 1420, trend: 'down', note: 'Transitional year, Wetherholt prospect' },
  PIT: { elo: 1440, trend: 'up',   note: 'Skenes NL Cy Young 2025, Ozuna/O\'Hearn added' },

  // ── NATIONAL LEAGUE WEST ──────────────────────────────────────────────────
  LAD: { elo: 1620, trend: 'up',   note: 'Ohtani+Tucker+Betts+Freeman — best ever' },
  SD:  { elo: 1510, trend: 'up',   note: 'Tatis/Machado/Bogaerts, King leads rotation' },
  ARI: { elo: 1490, trend: 'up',   note: 'Arenado added, Carroll health question' },
  SF:  { elo: 1440, trend: 'down', note: 'Rebuilding around Merrill/Wade Jr.' },
  COL: { elo: 1290, trend: 'down', note: 'Worst rotation in baseball, Coors factor' },
};

/**
 * Calculate expected win probability using Elo
 * @param {number} eloA - Home team Elo
 * @param {number} eloB - Away team Elo
 * @returns {number} Home team win probability (0-1)
 */
function expectedWinProb(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

/**
 * Update Elo after a game
 * @param {number} winnerElo
 * @param {number} loserElo
 * @param {boolean} homeWon - did the home team win?
 * @returns {{ newWinnerElo, newLoserElo, eloChange }}
 */
function updateElo(winnerElo, loserElo, homeWon) {
  // Add home advantage to expected calculation
  const adjustedWinnerElo = homeWon ? winnerElo + HOME_ADVANTAGE : winnerElo;
  const adjustedLoserElo = homeWon ? loserElo : loserElo + HOME_ADVANTAGE;

  const expectedWinner = expectedWinProb(adjustedWinnerElo, adjustedLoserElo);
  const eloChange = Math.round(K_FACTOR * (1 - expectedWinner));

  return {
    newWinnerElo: winnerElo + eloChange,
    newLoserElo: loserElo - eloChange,
    eloChange,
  };
}

/**
 * Get Elo tier label and color
 */
function getEloTier(elo) {
  if (elo >= 1600) return { label: 'ELITE', color: '#FFD060' };
  if (elo >= 1540) return { label: 'CONTENDER', color: '#00E5FF' };
  if (elo >= 1490) return { label: 'STRONG', color: '#00FF88' };
  if (elo >= 1440) return { label: 'AVERAGE', color: '#8A9AB5' };
  if (elo >= 1380) return { label: 'WEAK', color: '#FF6B35' };
  return { label: 'REBUILD', color: '#FF3A5C' };
}

/**
 * Fetch today's MLB results and update Elo ratings
 * Called by the daily cron job
 */
async function updateEloFromResults(currentElos) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=linescore`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    const games = data.dates?.[0]?.games || [];

    const updatedElos = { ...currentElos };
    const results = [];

    for (const game of games) {
      // Only process final games
      if (game.status?.detailedState !== 'Final') continue;

      const homeTeam = game.teams?.home?.team?.name;
      const awayTeam = game.teams?.away?.team?.name;
      const homeScore = game.teams?.home?.score || 0;
      const awayScore = game.teams?.away?.score || 0;

      if (homeScore === awayScore) continue; // No ties in MLB

      const homeAbbr = getAbbrFromName(homeTeam);
      const awayAbbr = getAbbrFromName(awayTeam);

      if (!homeAbbr || !awayAbbr) continue;
      if (!updatedElos[homeAbbr] || !updatedElos[awayAbbr]) continue;

      const homeWon = homeScore > awayScore;
      const winnerAbbr = homeWon ? homeAbbr : awayAbbr;
      const loserAbbr = homeWon ? awayAbbr : homeAbbr;

      const { newWinnerElo, newLoserElo, eloChange } = updateElo(
        updatedElos[winnerAbbr].elo,
        updatedElos[loserAbbr].elo,
        homeWon
      );

      updatedElos[winnerAbbr] = {
        ...updatedElos[winnerAbbr],
        elo: newWinnerElo,
        trend: 'up',
        lastChange: `+${eloChange}`,
      };

      updatedElos[loserAbbr] = {
        ...updatedElos[loserAbbr],
        elo: newLoserElo,
        trend: 'down',
        lastChange: `-${eloChange}`,
      };

      results.push({
        game: `${awayAbbr} @ ${homeAbbr}`,
        winner: winnerAbbr,
        loser: loserAbbr,
        score: `${awayScore}-${homeScore}`,
        eloChange,
      });
    }

    return { updatedElos, results, gamesProcessed: results.length };

  } catch (err) {
    console.error('Elo update error:', err.message);
    return { updatedElos: currentElos, results: [], gamesProcessed: 0 };
  }
}

// Team name to abbreviation mapping
const NAME_TO_ABBR = {
  "New York Yankees": "NYY", "Boston Red Sox": "BOS", "Toronto Blue Jays": "TOR",
  "Tampa Bay Rays": "TB", "Baltimore Orioles": "BAL", "Cleveland Guardians": "CLE",
  "Minnesota Twins": "MIN", "Chicago White Sox": "CWS", "Kansas City Royals": "KC",
  "Detroit Tigers": "DET", "Houston Astros": "HOU", "Texas Rangers": "TEX",
  "Seattle Mariners": "SEA", "Oakland Athletics": "OAK", "Los Angeles Angels": "LAA",
  "Atlanta Braves": "ATL", "New York Mets": "NYM", "Philadelphia Phillies": "PHI",
  "Miami Marlins": "MIA", "Washington Nationals": "WSH", "Chicago Cubs": "CHC",
  "Milwaukee Brewers": "MIL", "St. Louis Cardinals": "STL", "Cincinnati Reds": "CIN",
  "Pittsburgh Pirates": "PIT", "Los Angeles Dodgers": "LAD", "San Francisco Giants": "SF",
  "San Diego Padres": "SD", "Arizona Diamondbacks": "ARI", "Colorado Rockies": "COL",
};

function getAbbrFromName(name) {
  return NAME_TO_ABBR[name] || null;
}

// Division mappings for filtering
const DIVISIONS = {
  'AL East':    ['NYY', 'BOS', 'BAL', 'TOR', 'TB'],
  'AL Central': ['DET', 'KC', 'CLE', 'MIN', 'CWS'],
  'AL West':    ['HOU', 'SEA', 'TEX', 'LAA', 'OAK'],
  'NL East':    ['PHI', 'NYM', 'ATL', 'WSH', 'MIA'],
  'NL Central': ['CHC', 'MIL', 'CIN', 'STL', 'PIT'],
  'NL West':    ['LAD', 'SD', 'ARI', 'SF', 'COL'],
};

const AL_TEAMS = ['NYY','BOS','BAL','TOR','TB','DET','KC','CLE','MIN','CWS','HOU','SEA','TEX','LAA','OAK'];
const NL_TEAMS = ['PHI','NYM','ATL','WSH','MIA','CHC','MIL','CIN','STL','PIT','LAD','SD','ARI','SF','COL'];

module.exports = {
  OPENING_DAY_ELO,
  updateElo,
  updateEloFromResults,
  expectedWinProb,
  getEloTier,
  getAbbrFromName,
  DIVISIONS,
  AL_TEAMS,
  NL_TEAMS,
  K_FACTOR,
  HOME_ADVANTAGE,
};
