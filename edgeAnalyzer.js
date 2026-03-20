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
 * Park factors: how each ballpark affects run scoring, home runs, and strikeouts.
 * Factors > 1.0 boost the stat, < 1.0 suppress it.
 * homeOnly: true means the factor is extreme and should only apply to home team.
 */
const PARK_FACTORS = {
  COL: { runs: 1.35, hr: 1.40, k: 0.88, note: "Coors Field — extreme altitude, ball carries significantly", homeOnly: true },
  CIN: { runs: 1.12, hr: 1.18, k: 0.96, note: "Great American Ball Park — short right field porch" },
  NYY: { runs: 1.08, hr: 1.15, k: 1.05, note: "Yankee Stadium — short right field porch favors lefties" },
  BOS: { runs: 1.06, hr: 0.98, k: 0.97, note: "Fenway Park — Green Monster creates doubles, unpredictable" },
  TEX: { runs: 1.10, hr: 1.12, k: 0.98, note: "Globe Life Field — heat and sea level boost scoring" },
  HOU: { runs: 1.05, hr: 1.08, k: 1.05, note: "Minute Maid Park — Crawford Boxes favor left-handed pull hitters" },
  SF:  { runs: 0.91, hr: 0.88, k: 1.08, note: "Oracle Park — marine layer and bay wind suppress scoring significantly" },
  TB:  { runs: 0.94, hr: 0.92, k: 1.08, note: "Tropicana Field — dome, artificial turf, unique catwalk system" },
  PIT: { runs: 0.93, hr: 0.90, k: 1.05, note: "PNC Park — large dimensions and river winds suppress scoring" },
  SD:  { runs: 0.92, hr: 0.89, k: 1.06, note: "Petco Park — marine layer from Pacific, deep dimensions" },
  SEA: { runs: 0.93, hr: 0.91, k: 1.06, note: "T-Mobile Park — Puget Sound marine air, pitcher friendly" },
  CHC: { runs: 1.00, hr: 1.00, k: 0.94, note: "Wrigley Field — highly wind dependent, check wind direction before any pick" },
  MIA: { runs: 0.95, hr: 0.93, k: 1.07, note: "loanDepot Park — dome, suppresses scoring" },
  ARI: { runs: 1.02, hr: 1.04, k: 0.97, note: "Chase Field — retractable roof, warm desert air when open" },
};

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

  // Apply park factors for the home team's ballpark
  const parkFactor = PARK_FACTORS[homeStats.abbr] || null;
  const parkRunsFactor = parkFactor ? parkFactor.runs : 1.0;

  // Multiply home team runsPerGame and away team runsAllowedPerGame by park runs factor
  const adjustedHomeRPG = homeStats.runsPerGame * parkRunsFactor;
  const adjustedAwayRAPG = awayStats.runsAllowedPerGame * parkRunsFactor;

  // Home team gets a run bonus for playing at home; away run rate uses park-adjusted pitching quality
  const homeRunRate = adjustedHomeRPG + homeStats.homeBonus;
  const awayRunRate = adjustedAwayRAPG;

  // Build park warning if factor is extreme
  let parkWarning = null;
  if (parkFactor && (parkFactor.runs > 1.10 || parkFactor.runs < 0.93)) {
    parkWarning = parkFactor.note;
  }

  // Colorado home games: extreme altitude, add confidence penalty
  const isCoorsHome = homeStats.abbr === "COL";
  const coorsConfidencePenalty = isCoorsHome ? 20 : 0;

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

  // Coors warning string (used on both home and away picks for COL home games)
  const coorsWarning = isCoorsHome
    ? "⚠️ Coors Field: extreme altitude distorts all Poisson models — confidence heavily penalized"
    : null;

  /**
   * Apply extreme edge filters to a pick's confidence and warning.
   * edgeDecimal: raw edge as decimal (e.g. 0.21)
   * probGap: trueWinProb - bookImpliedProb as decimal (e.g. 0.27)
   * Returns { confidence, warning }
   */
  function applyExtremeEdgeFilters(edgeDecimal, probGap, baseConfidence, existingWarning) {
    let confidence = baseConfidence;
    let warning = existingWarning;

    // Large prob gap usually means bad data or model error, not real edge
    if (probGap > 0.25) {
      confidence -= 40;
    }

    // Edge above 20% is almost certainly a model error — cap and flag it
    if (edgeDecimal > 0.20) {
      confidence = Math.min(confidence, 30);
      warning = "EXTREME EDGE - likely model error, do not track";
    }

    return { confidence: Math.max(0, confidence), warning };
  }

  // Home team pick
  if (homeEdge >= MIN_EDGE_THRESHOLD) {
    const baseConfidence = confidenceScore(homeEdge, homeKelly) - coorsConfidencePenalty;
    const { confidence, warning } = applyExtremeEdgeFilters(
      homeEdge,
      homeWin - bookTrueHome,
      baseConfidence,
      coorsWarning || parkWarning || null
    );
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
      confidence,
      warning,
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
    const baseConfidence = confidenceScore(awayEdge, awayKelly) - coorsConfidencePenalty;
    const { confidence, warning } = applyExtremeEdgeFilters(
      awayEdge,
      awayWin - bookTrueAway,
      baseConfidence,
      coorsWarning || parkWarning || null
    );
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
      confidence,
      warning,
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

/**
 * Apply injury confidence penalties to picks.
 * If the team we have an edge on has a key player on IL,
 * reduce confidence by 15 and add a warning.
 * Called after analyzePicks() when enriched data is available.
 */
function applyInjuryPenalty(picks, enrichedData) {
  if (!enrichedData || Object.keys(enrichedData).length === 0) return picks;

  return picks.map(pick => {
    // Try both key orderings (away_home is the gameKey format used in enrichPicks)
    const gameKey = `${pick.opponentAbbr}_${pick.teamAbbr}`; // away_home when pick is home team
    const reverseKey = `${pick.teamAbbr}_${pick.opponentAbbr}`;
    const gameData = enrichedData[gameKey] || enrichedData[reverseKey];

    if (!gameData) return pick;

    // Get injuries for the team we're picking
    const isHome = pick.side === 'home';
    const teamInjuries = isHome ? (gameData.homeInjuries || []) : (gameData.awayInjuries || []);
    const keyInjuries = gameData.keyInjuries || '';
    const teamAbbr = pick.teamAbbr;

    // Penalize if this team has a key injury flagged, or has 2+ players on IL
    const hasKeyInjury = keyInjuries.includes(teamAbbr);
    const hasMultipleInjuries = teamInjuries.length >= 2;

    if (hasKeyInjury || hasMultipleInjuries) {
      const injuryWarning = 'Key injury — verify lineup before tracking';
      return {
        ...pick,
        confidence: Math.max(0, pick.confidence - 15),
        warning: pick.warning
          ? `${pick.warning} | ${injuryWarning}`
          : injuryWarning,
      };
    }

    return pick;
  });
}

module.exports = { analyzePicks, setLiveStats, applyInjuryPenalty };
