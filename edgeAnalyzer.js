/**
 * edgeAnalyzer.js
 * Core engine: takes raw odds data from The Odds API and
 * produces analyzed picks with edge %, Kelly sizing, and confidence.
 */

const {
  poissonWinProb,
  americanToImplied,
  removeVig,
  calcEdge,
  kellyCriterion,
  americanToDecimal,
  confidenceScore,
} = require("./poisson");

const { getTeamStats } = require("./mlbStats");

// Minimum edge % to include a pick (filter out noise)
const MIN_EDGE_THRESHOLD = 0.03; // 3%

/**
 * Find the best (sharpest) moneyline odds across all bookmakers
 * for each team — this is the "best available line" approach.
 * Returns { homeOdds: number, awayOdds: number, bookmaker: string }
 */
function getBestMoneyline(game) {
  let bestHomeOdds = null;
  let bestAwayOdds = null;
  let bestBook = "unknown";

  for (const bookmaker of game.bookmakers || []) {
    const mlMarket = bookmaker.markets?.find((m) => m.key === "h2h");
    if (!mlMarket) continue;

    for (const outcome of mlMarket.outcomes || []) {
      const price = outcome.price; // decimal odds from API
      // Convert to American for display, but use decimal internally
      if (outcome.name === game.home_team) {
        if (bestHomeOdds === null || price > bestHomeOdds) {
          bestHomeOdds = price;
          bestBook = bookmaker.title;
        }
      } else if (outcome.name === game.away_team) {
        if (bestAwayOdds === null || price > bestAwayOdds) {
          bestAwayOdds = price;
        }
      }
    }
  }

  return { homeOdds: bestHomeOdds, awayOdds: bestAwayOdds, bookmaker: bestBook };
}

/**
 * Convert decimal odds to American for display
 */
function decimalToAmerican(decimal) {
  if (decimal >= 2.0) {
    return Math.round((decimal - 1) * 100);
  } else {
    return Math.round(-100 / (decimal - 1));
  }
}

/**
 * Format American odds string with + or - prefix
 */
function formatAmerican(odds) {
  return odds >= 0 ? `+${odds}` : `${odds}`;
}

/**
 * Analyze a single game and return a structured pick object
 */
// In-memory cache for live stats (populated by cron)
let liveTeamStats = null;

function setLiveStats(stats) {
  liveTeamStats = stats;
  console.log(`📊 Poisson model updated with live stats for ${Object.keys(stats).length} teams`);
}

function analyzeGame(game) {
  const { homeOdds, awayOdds, bookmaker } = getBestMoneyline(game);

  // Need both sides to analyze
  if (!homeOdds || !awayOdds) return null;

  // Get team stats — use live stats if available, fall back to projections
  const homeStats = getTeamStats(game.home_team, liveTeamStats);
  const awayStats = getTeamStats(game.away_team, liveTeamStats);

  // Home team gets a run bonus for playing at home
  const homeRunRate = homeStats.runsPerGame + homeStats.homeBonus;
  const awayRunRate = awayStats.runsPerGame; // no bonus for visiting team

  // Poisson-based true win probabilities
  const { homeWin, awayWin } = poissonWinProb(homeRunRate, awayRunRate);

  // Book implied probabilities (with vig baked in)
  const bookHomeImplied = 1 / homeOdds;
  const bookAwayImplied = 1 / awayOdds;

  // Remove the vig to get book's "true" estimate
  const { trueHome: bookTrueHome, trueAway: bookTrueAway } = removeVig(
    bookHomeImplied,
    bookAwayImplied
  );

  // Edge: our Poisson prob vs book's vig-free prob
  const homeEdge = calcEdge(homeWin, bookTrueHome);
  const awayEdge = calcEdge(awayWin, bookTrueAway);

  // Kelly criterion bet sizing
  const homeKelly = kellyCriterion(homeWin, homeOdds);
  const awayKelly = kellyCriterion(awayWin, awayOdds);

  const picks = [];

  // Home team pick
  if (homeEdge >= MIN_EDGE_THRESHOLD) {
    picks.push({
      side: "home",
      team: game.home_team,
      opponent: game.away_team,
      teamAbbr: homeStats.abbr,
      opponentAbbr: awayStats.abbr,
      betType: "Moneyline",
      pick: `${homeStats.abbr} ML`,
      bookOddsDecimal: homeOdds,
      bookOddsAmerican: formatAmerican(decimalToAmerican(homeOdds)),
      trueWinProb: Math.round(homeWin * 1000) / 10,       // e.g. 58.3
      bookImpliedProb: Math.round(bookTrueHome * 1000) / 10,
      edgePct: Math.round(homeEdge * 1000) / 10,          // e.g. 8.4
      kellyPct: Math.round(homeKelly * 1000) / 10,        // e.g. 3.2
      confidence: confidenceScore(homeEdge, homeKelly),
      bookmaker,
      gameTime: game.commence_time,
      homeTeam: game.home_team,
      awayTeam: game.away_team,
      homeRecord: null, // populated separately if you add a stats API
      awayRecord: null,
    });
  }

  // Away team pick
  if (awayEdge >= MIN_EDGE_THRESHOLD) {
    picks.push({
      side: "away",
      team: game.away_team,
      opponent: game.home_team,
      teamAbbr: awayStats.abbr,
      opponentAbbr: homeStats.abbr,
      betType: "Moneyline",
      pick: `${awayStats.abbr} ML`,
      bookOddsDecimal: awayOdds,
      bookOddsAmerican: formatAmerican(decimalToAmerican(awayOdds)),
      trueWinProb: Math.round(awayWin * 1000) / 10,
      bookImpliedProb: Math.round(bookTrueAway * 1000) / 10,
      edgePct: Math.round(awayEdge * 1000) / 10,
      kellyPct: Math.round(awayKelly * 1000) / 10,
      confidence: confidenceScore(awayEdge, awayKelly),
      bookmaker,
      gameTime: game.commence_time,
      homeTeam: game.home_team,
      awayTeam: game.away_team,
      homeRecord: null,
      awayRecord: null,
    });
  }

  return picks;
}

/**
 * Main analyzer: takes array of games from The Odds API
 * Returns sorted array of picks (highest edge first)
 */
function analyzePicks(games) {
  const allPicks = [];

  for (const game of games) {
    try {
      const gamePicks = analyzeGame(game);
      if (gamePicks) allPicks.push(...gamePicks);
    } catch (err) {
      console.error(`Error analyzing game ${game.id}:`, err.message);
    }
  }

  // Sort by edge % descending — highest edge picks first
  allPicks.sort((a, b) => b.edgePct - a.edgePct);

  return allPicks;
}

module.exports = { analyzePicks, setLiveStats };
