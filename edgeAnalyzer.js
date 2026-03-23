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

// League average FIP/ERA baseline for pitcher quality multiplier
const LEAGUE_AVG_FIP = 4.20;

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
 * getPitcherQualityMultiplier(pitcherStats, lastStart)
 *
 * Returns a multiplier applied to the OPPONENT's expected run rate.
 *   < 1.0  →  pitcher suppresses scoring (elite FIP)
 *   = 1.0  →  league average
 *   > 1.0  →  pitcher allows more scoring (poor FIP / fatigued)
 *
 * Uses FIP as primary metric, falls back to ERA. Caps at [0.60, 1.40].
 * Fatigue adjustment is layered on top of the quality multiplier.
 */
function getPitcherQualityMultiplier(pitcherStats, lastStart) {
  let qualityMult = 1.0;

  if (pitcherStats && pitcherStats.name !== 'TBD') {
    // Prefer FIP (more predictive than ERA for future performance)
    const metric = (pitcherStats.fip != null && parseFloat(pitcherStats.fip) > 0)
      ? parseFloat(pitcherStats.fip)
      : (pitcherStats.era != null && parseFloat(pitcherStats.era) > 0 ? parseFloat(pitcherStats.era) : null);

    if (metric) {
      // metric / leagueAvg: <1 for good pitcher, >1 for bad pitcher
      qualityMult = Math.max(0.60, Math.min(1.40, metric / LEAGUE_AVG_FIP));
    }
  }

  // Fatigue adjustment — multiplied into the quality multiplier
  if (lastStart) {
    const { daysSinceLastStart, pitchCount, inningsPitched } = lastStart;
    if (inningsPitched >= 9) {
      qualityMult *= 1.08; // complete game → more tired regardless of rest
    } else if (daysSinceLastStart <= 3) {
      qualityMult *= 1.10; // short rest → meaningfully worse
    } else if (daysSinceLastStart === 4 && pitchCount >= 100) {
      qualityMult *= 1.05; // high pitch count on standard rest
    } else if (daysSinceLastStart >= 5) {
      qualityMult *= 0.95; // extra rest → slightly sharper
    }
    // Re-cap after fatigue adjustment
    qualityMult = Math.max(0.55, Math.min(1.50, qualityMult));
  }

  return qualityMult;
}

/**
 * Extract the best available Over/Under line from a game's bookmakers.
 */
function getBookOverUnder(game) {
  for (const bk of game.bookmakers || []) {
    const totalsMarket = bk.markets?.find(m => m.key === 'totals');
    if (totalsMarket) {
      const overOutcome = totalsMarket.outcomes?.find(o => o.name === 'Over');
      if (overOutcome?.point) return overOutcome.point;
    }
  }
  return null;
}

/**
 * calculateExpectedTotal(homeRunRate, awayRunRate, enrichedGame, parkFactor)
 *
 * Computes our model's projected run total for a game.
 * Layers: base Poisson total → bullpen adjustment → weather adjustment → park factor.
 */
function calculateExpectedTotal(homeRunRate, awayRunRate, enrichedGame, parkFactor) {
  const baseTotal = homeRunRate + awayRunRate;
  const LEAGUE_AVG_BULLPEN = 4.20;

  // Step 2 — Bullpen adjustment (FanGraphs data, premium only)
  let bullpenAdj = 0;
  if (enrichedGame?.homeFanGraphs?.bullpenERA) {
    const era = parseFloat(enrichedGame.homeFanGraphs.bullpenERA);
    if (!isNaN(era)) bullpenAdj += (era - LEAGUE_AVG_BULLPEN) * 0.3;
  }
  if (enrichedGame?.awayFanGraphs?.bullpenERA) {
    const era = parseFloat(enrichedGame.awayFanGraphs.bullpenERA);
    if (!isNaN(era)) bullpenAdj += (era - LEAGUE_AVG_BULLPEN) * 0.3;
  }

  // Step 3 — Weather adjustment
  let weatherAdj = 0;
  const weather = enrichedGame?.weather;
  if (weather && weather.windDir !== 'Indoor') {
    const windSpeed = weather.windSpeed || 0;
    const dir = weather.windDir || '';
    const isOut = dir.includes('Out') || dir.startsWith('S ') || dir.startsWith('W ');
    const isIn  = dir.includes('In')  || dir.startsWith('E ') || dir.startsWith('N ');
    if (windSpeed > 10) {
      if (isOut) weatherAdj += (windSpeed - 10) * 0.08;
      if (isIn)  weatherAdj -= (windSpeed - 10) * 0.06;
    }
    if (weather.temp < 50) weatherAdj -= 0.4;
    if (weather.temp > 85) weatherAdj += 0.3;
  }

  // Step 4 — Park factor (capped at ±0.8 runs to prevent extreme inflation)
  const parkRunsFactor = parkFactor?.runs || 1.0;
  const preAdjTotal = baseTotal + bullpenAdj + weatherAdj;
  const rawParkAdj = preAdjTotal * parkRunsFactor - preAdjTotal;
  const cappedParkAdj = Math.max(-0.8, Math.min(0.8, rawParkAdj));
  const expectedTotal = Math.round((preAdjTotal + cappedParkAdj) * 10) / 10;

  // Confidence scales with data availability
  const noFipData = !enrichedGame?.homePitcher?.fip && !enrichedGame?.awayPitcher?.fip;
  let confidence = 45;
  if (!noFipData) confidence += 15;
  if (enrichedGame?.homeFanGraphs) confidence += 10;
  if (weather) confidence += 10;
  if (parkRunsFactor !== 1.0) confidence += 5;

  if (noFipData) confidence = 25;

  return {
    expectedTotal,
    baseTotal: Math.round(baseTotal * 10) / 10,
    bullpenAdjustment: Math.round(bullpenAdj * 10) / 10,
    weatherAdjustment: Math.round(weatherAdj * 10) / 10,
    parkAdjustment: parkRunsFactor,
    confidence: Math.min(85, confidence),
    lowConfidenceNote: noFipData ? 'Low confidence — pitcher data pending' : null,
  };
}

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
 * Analyze a single game and return a structured pick object.
 * enrichedData: optional map of gameKey → enriched pitcher/weather/FanGraphs data.
 */
// In-memory cache for live stats (populated by cron)
let liveTeamStats = null;

function setLiveStats(stats) {
  liveTeamStats = stats;
  console.log(`📊 Poisson model updated with live stats for ${Object.keys(stats).length} teams`);
}

function analyzeGame(game, enrichedData) {
  const { homeOdds, awayOdds, bookmaker } = getBestMoneyline(game);

  // Need both sides to analyze
  if (!homeOdds || !awayOdds) return null;

  // Get team stats — use live stats if available, fall back to projections
  const homeStats = getTeamStats(game.home_team, liveTeamStats);
  const awayStats = getTeamStats(game.away_team, liveTeamStats);
  const homeAbbr = homeStats.abbr;
  const awayAbbr = awayStats.abbr;

  // Look up enriched data for this matchup (keyed as ${away}_${home})
  const gameKey = `${awayAbbr}_${homeAbbr}`;
  const enrichedGame = enrichedData
    ? (enrichedData[gameKey] || enrichedData[`${homeAbbr}_${awayAbbr}`] || null)
    : null;

  // Apply park factors for the home team's ballpark
  const parkFactor = PARK_FACTORS[homeAbbr] || null;
  const parkRunsFactor = parkFactor ? parkFactor.runs : 1.0;

  // Multiply home team runsPerGame and away team runsAllowedPerGame by park runs factor
  const adjustedHomeRPG = homeStats.runsPerGame * parkRunsFactor;
  const adjustedAwayRAPG = awayStats.runsAllowedPerGame * parkRunsFactor;

  // ── FIP / fatigue pitcher quality multipliers ──────────────────────────────
  // Home pitcher quality → multiplier on AWAY team's expected runs
  // Away pitcher quality → multiplier on HOME team's expected runs
  const homePitcherData  = enrichedGame?.homePitcher || null;
  const awayPitcherData  = enrichedGame?.awayPitcher || null;
  const homePitcherMult  = getPitcherQualityMultiplier(homePitcherData, homePitcherData?.lastStart);
  const awayPitcherMult  = getPitcherQualityMultiplier(awayPitcherData, awayPitcherData?.lastStart);

  // Apply: good home pitcher → away scores fewer; bad away pitcher → home scores more
  const homeRunRate = (adjustedHomeRPG + homeStats.homeBonus) * awayPitcherMult;
  const awayRunRate = adjustedAwayRAPG * homePitcherMult;

  // FIP display values
  const homePitcherFIP = (homePitcherData?.fip != null) ? parseFloat(homePitcherData.fip) : null;
  const awayPitcherFIP = (awayPitcherData?.fip != null) ? parseFloat(awayPitcherData.fip) : null;

  // Fatigue labels
  const homePitcherFatigue = homePitcherData?.lastStart?.fatigue || null;
  const awayPitcherFatigue = awayPitcherData?.lastStart?.fatigue || null;
  const fatigueNote = [
    homePitcherData?.lastStart?.fatigueNote ? `${homePitcherData.name || 'Home SP'}: ${homePitcherData.lastStart.fatigueNote}` : null,
    awayPitcherData?.lastStart?.fatigueNote ? `${awayPitcherData.name || 'Away SP'}: ${awayPitcherData.lastStart.fatigueNote}` : null,
  ].filter(Boolean).join(' | ') || null;

  // Pitcher adjustment description
  let pitcherAdjustment = null;
  if (homePitcherMult !== 1.0 || awayPitcherMult !== 1.0) {
    const parts = [];
    if (homePitcherData && homePitcherMult !== 1.0) {
      const metric = homePitcherFIP != null ? `FIP ${homePitcherFIP}` : `ERA ${homePitcherData.era}`;
      const direction = homePitcherMult < 1.0 ? 'suppressing' : 'inflating';
      parts.push(`${homePitcherData.name || 'Home SP'} (${metric}) ${direction} away scoring`);
    }
    if (awayPitcherData && awayPitcherMult !== 1.0) {
      const metric = awayPitcherFIP != null ? `FIP ${awayPitcherFIP}` : `ERA ${awayPitcherData.era}`;
      const direction = awayPitcherMult < 1.0 ? 'suppressing' : 'inflating';
      parts.push(`${awayPitcherData.name || 'Away SP'} (${metric}) ${direction} home scoring`);
    }
    if (parts.length) pitcherAdjustment = parts.join(' | ');
  }

  // ── O/U calculation ────────────────────────────────────────────────────────
  const bookOverUnder = getBookOverUnder(game);
  const ouCalc = calculateExpectedTotal(homeRunRate, awayRunRate, enrichedGame, parkFactor);
  const ouEdge = bookOverUnder != null
    ? Math.round((ouCalc.expectedTotal - bookOverUnder) * 10) / 10
    : null;
  let ouRecommendation = 'NO EDGE';
  if (ouEdge !== null) {
    if (ouEdge >= 1.0)  ouRecommendation = 'OVER';
    if (ouEdge <= -1.0) ouRecommendation = 'UNDER';
  }
  if (ouCalc.lowConfidenceNote) {
    ouRecommendation = ouRecommendation === 'NO EDGE'
      ? `NO EDGE — ${ouCalc.lowConfidenceNote}`
      : `${ouRecommendation} — ${ouCalc.lowConfidenceNote}`;
  }

  // Build park warning if factor is extreme
  let parkWarning = null;
  if (parkFactor && (parkFactor.runs > 1.10 || parkFactor.runs < 0.93)) {
    parkWarning = parkFactor.note;
  }

  // Colorado home games: extreme altitude, add confidence penalty
  const isCoorsHome = homeAbbr === "COL";
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

  // TBD pitcher detection — used for penalty and cap in both home/away picks
  const bothPitchersTBD = homePitcherFIP === null && awayPitcherFIP === null &&
    (!homePitcherData?.name || homePitcherData.name === 'TBD') &&
    (!awayPitcherData?.name || awayPitcherData.name === 'TBD');

  // Home team pick
  if (homeEdge >= MIN_EDGE_THRESHOLD) {
    const baseConfidence = confidenceScore(homeEdge, homeKelly) - coorsConfidencePenalty;
    let { confidence, warning } = applyExtremeEdgeFilters(
      homeEdge,
      homeWin - bookTrueHome,
      baseConfidence,
      coorsWarning || parkWarning || null
    );

    // TBD Pitcher Penalty
    if (bothPitchersTBD) {
      confidence = Math.max(0, confidence - 20);
      warning = warning ? `${warning} | TBD pitchers — edge unconfirmed` : 'TBD pitchers — edge unconfirmed';
    }

    // Sub-50% win prob penalty — model projects a loss, edge is purely value-based
    if (homeWin < 0.50) {
      confidence = Math.max(0, confidence - 10);
      warning = warning ? `${warning} | Model projects loss — value play only` : 'Model projects loss — value play only';
    }

    // Shared O/U + pitcher fields added to every pick for this game
    const sharedFields = {
      // Pitcher quality (FIP/ERA)
      homePitcherFIP,
      awayPitcherFIP,
      homePitcherName: homePitcherData?.name || null,
      awayPitcherName: awayPitcherData?.name || null,
      pitcherAdjustment,
      // Fatigue
      homePitcherFatigue,
      awayPitcherFatigue,
      fatigueNote,
      // O/U model
      expectedTotal: ouCalc.expectedTotal,
      bookTotal: bookOverUnder,
      ouEdge,
      ouRecommendation,
      ouConfidence: ouCalc.confidence,
      bullpenAdjustment: ouCalc.bullpenAdjustment,
      weatherAdjustment: ouCalc.weatherAdjustment,
      parkAdjustment: ouCalc.parkAdjustment,
    };

    picks.push({
      side: "home",
      team: game.home_team,
      opponent: game.away_team,
      teamAbbr: homeAbbr,
      opponentAbbr: awayAbbr,
      betType: "Moneyline",
      pick: `${homeAbbr} ML`,
      bookOddsDecimal: homeOdds,
      bookOddsAmerican: formatAmerican(decimalToAmerican(homeOdds)),
      trueWinProb: Math.round(homeWin * 1000) / 10,
      bookImpliedProb: Math.round(bookTrueHome * 1000) / 10,
      edgePct: Math.round(homeEdge * 1000) / 10,
      kellyPct: Math.round(homeKelly * 1000) / 10,
      confidence,
      warning,
      bookmaker,
      gameTime: game.commence_time,
      homeTeam: game.home_team,
      awayTeam: game.away_team,
      homeRecord: null,
      awayRecord: null,
      ...sharedFields,
    });
  }

  // Away team pick
  if (awayEdge >= MIN_EDGE_THRESHOLD) {
    const baseConfidence = confidenceScore(awayEdge, awayKelly) - coorsConfidencePenalty;
    let { confidence, warning } = applyExtremeEdgeFilters(
      awayEdge,
      awayWin - bookTrueAway,
      baseConfidence,
      coorsWarning || parkWarning || null
    );

    // TBD Pitcher Penalty
    if (bothPitchersTBD) {
      confidence = Math.max(0, confidence - 20);
      warning = warning ? `${warning} | TBD pitchers — edge unconfirmed` : 'TBD pitchers — edge unconfirmed';
    }

    // Sub-50% win prob penalty — model projects a loss, edge is purely value-based
    if (awayWin < 0.50) {
      confidence = Math.max(0, confidence - 10);
      warning = warning ? `${warning} | Model projects loss — value play only` : 'Model projects loss — value play only';
    }

    const sharedFields = {
      homePitcherFIP,
      awayPitcherFIP,
      homePitcherName: homePitcherData?.name || null,
      awayPitcherName: awayPitcherData?.name || null,
      pitcherAdjustment,
      homePitcherFatigue,
      awayPitcherFatigue,
      fatigueNote,
      expectedTotal: ouCalc.expectedTotal,
      bookTotal: bookOverUnder,
      ouEdge,
      ouRecommendation,
      ouConfidence: ouCalc.confidence,
      bullpenAdjustment: ouCalc.bullpenAdjustment,
      weatherAdjustment: ouCalc.weatherAdjustment,
      parkAdjustment: ouCalc.parkAdjustment,
    };

    picks.push({
      side: "away",
      team: game.away_team,
      opponent: game.home_team,
      teamAbbr: awayAbbr,
      opponentAbbr: homeAbbr,
      betType: "Moneyline",
      pick: `${awayAbbr} ML`,
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
      ...sharedFields,
    });
  }

  return picks;
}

/**
 * Main analyzer: takes array of games from The Odds API and optional enriched data.
 * Returns sorted array of picks (highest edge first)
 */
function analyzePicks(games, enrichedData) {
  const allPicks = [];

  for (const game of games) {
    try {
      const gamePicks = analyzeGame(game, enrichedData);
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

/**
 * applyEloAdjustment(picks, eloRatings)
 * Adjusts confidence scores based on Elo rating differences between picked team
 * and their opponent. Also applies momentum adjustments from W-L record.
 * Early season (avg < 14 games played): adjustments halved since seeds are preseason estimates.
 * All adjustments are capped at ±15 confidence points.
 */
function applyEloAdjustment(picks, eloRatings) {
  if (!eloRatings || eloRatings.length === 0) return picks;

  // Build lookup: team_abbr → elo row
  const eloMap = {};
  for (const team of eloRatings) {
    if (team.team_abbr) eloMap[team.team_abbr] = team;
  }

  // Determine if we're in early season (avg games played < 14)
  const totalGames = eloRatings.reduce((s, t) => s + (t.wins || 0) + (t.losses || 0), 0);
  const avgGames = totalGames / (eloRatings.length || 1);
  const isEarlySeason = avgGames < 14;

  return picks.map(pick => {
    const pickedTeam = eloMap[pick.teamAbbr];
    const oppTeam    = eloMap[pick.opponentAbbr];

    // Derive home/away abbr from which side the pick is on
    const homeAbbr = pick.side === 'home' ? pick.teamAbbr   : pick.opponentAbbr;
    const awayAbbr = pick.side === 'away' ? pick.teamAbbr   : pick.opponentAbbr;
    const homeEloRow = eloMap[homeAbbr];
    const awayEloRow = eloMap[awayAbbr];

    if (!pickedTeam || !oppTeam) {
      return {
        ...pick,
        homeElo: homeEloRow?.elo || null,
        awayElo: awayEloRow?.elo || null,
        homeTierColor: homeEloRow?.tier_color || null,
        awayTierColor: awayEloRow?.tier_color || null,
        homeTier: homeEloRow?.tier || null,
        awayTier: awayEloRow?.tier || null,
        eloDiff: null,
        eloAdjustment: 0,
        eloNote: null,
        isEarlySeason,
      };
    }

    const pickedElo = pickedTeam.elo;
    const oppElo    = oppTeam.elo;
    const eloDiff   = pickedElo - oppElo;      // positive = picked team is rated higher
    const absDiff   = Math.abs(eloDiff);
    const favor     = eloDiff >= 0;            // true = advantage for picked team

    // ── Elo confidence adjustment ──────────────────────────────────────────
    let eloAdj  = 0;
    let eloNote = null;

    if (absDiff >= 150) {
      eloAdj  = favor ? 12 : -25;
      eloNote = favor ? 'Strong Elo advantage' : 'Major Elo disadvantage — verify pick';
    } else if (absDiff >= 100) {
      eloAdj  = favor ?  8 : -15;
      eloNote = favor ? null : 'Significant Elo disadvantage';
    } else if (absDiff >= 50) {
      eloAdj  = favor ?  5 :  -8;
      eloNote = favor ? null : 'Elo disadvantage';
    } else {
      eloAdj  = 0;   // evenly matched (0–49 either direction)
    }

    // ── Momentum adjustment (W-L record) ──────────────────────────────────
    const w = pickedTeam.wins   || 0;
    const l = pickedTeam.losses || 0;
    let momAdj  = 0;
    let momNote = null;

    if (w - l >= 5) {
      momAdj  =  3;
      momNote = 'Positive momentum';
    } else if (l - w >= 5) {
      momAdj  = -3;
      momNote = 'Negative momentum';
    }

    // ── Early season dampening ─────────────────────────────────────────────
    let totalAdj = eloAdj + momAdj;
    if (isEarlySeason) totalAdj = Math.round(totalAdj * 0.5);

    // ── Cap ±25 ────────────────────────────────────────────────────────────
    const eloAdjustment = Math.max(-25, Math.min(25, totalAdj));

    // ── Combine notes ──────────────────────────────────────────────────────
    const combinedNote = [eloNote, momNote].filter(Boolean).join(' | ') || null;

    // Append warning only when adjustment is materially negative
    let warning = pick.warning || null;
    if (eloAdjustment <= -5 && combinedNote) {
      warning = warning ? `${warning} | ${combinedNote}` : combinedNote;
    }

    let newConfidence = Math.max(0, Math.min(100, pick.confidence + eloAdjustment));

    // Cap at 70 when no pitcher FIP data — prevents inflated confidence with TBD/unconfirmed pitchers
    const noFIPData = pick.homePitcherFIP === null && pick.awayPitcherFIP === null;
    if (noFIPData) newConfidence = Math.min(65, newConfidence);

    return {
      ...pick,
      confidence: newConfidence,
      warning,
      homeElo:       homeEloRow?.elo        || null,
      awayElo:       awayEloRow?.elo        || null,
      homeTier:      homeEloRow?.tier       || null,
      awayTier:      awayEloRow?.tier       || null,
      homeTierColor: homeEloRow?.tier_color || null,
      awayTierColor: awayEloRow?.tier_color || null,
      eloDiff,
      eloAdjustment,
      eloNote: combinedNote,
      isEarlySeason,
    };
  });
}

/**
 * applySharpMoneySignal(picks, lineMovement)
 * Adjusts confidence and adds sharp money context to picks
 * based on Pinnacle line movement data from analyzeLineMovement().
 * Called in server.js after applyEloAdjustment and applyInjuryPenalty.
 */
function applySharpMoneySignal(picks, lineMovement) {
  if (!lineMovement || lineMovement.length === 0) return picks;

  // Build lookup by gameId
  const movementMap = {};
  for (const m of lineMovement) {
    movementMap[m.gameId] = m;
  }

  return picks.map(pick => {
    const movement = movementMap[pick.gameId || ''];
    if (!movement) {
      return {
        ...pick,
        pinnacleMovement: null,
        sharpMoneyNote: null,
        openingOdds: null,
      };
    }

    const pm = movement.pinnacleMovement;
    const signal = pm?.sharpSignal || 'neutral';

    let confidenceAdj = 0;
    let sharpMoneyNote = null;
    let warning = pick.warning || null;

    switch (signal) {
      case 'strong_confirm':
        confidenceAdj = +12;
        sharpMoneyNote = '⚡ STEAM MOVE CONFIRMED — sharp action on this pick';
        warning = warning ? `${warning} | ⚡ STEAM MOVE CONFIRMED` : '⚡ STEAM MOVE CONFIRMED';
        break;
      case 'confirm':
        confidenceAdj = +8;
        sharpMoneyNote = '📈 Sharp money confirmed on this side';
        break;
      case 'neutral':
        confidenceAdj = 0;
        sharpMoneyNote = null;
        break;
      case 'fade':
        confidenceAdj = -12;
        sharpMoneyNote = '⚠️ Sharp money fading this pick';
        warning = warning ? `${warning} | ⚠️ Sharp money fading this pick` : '⚠️ Sharp money fading this pick';
        break;
      case 'strong_fade':
        confidenceAdj = -20;
        sharpMoneyNote = '🚨 STEAM MOVE AGAINST — high risk';
        warning = warning ? `${warning} | 🚨 STEAM MOVE AGAINST — high risk` : '🚨 STEAM MOVE AGAINST — high risk';
        break;
    }

    const openingOdds = pick.side === 'home'
      ? movement.openingHomeOdds
      : movement.openingAwayOdds;

    return {
      ...pick,
      gameId: movement.gameId,
      confidence: Math.max(0, Math.min(100, pick.confidence + confidenceAdj)),
      warning,
      pinnacleMovement: pm || null,
      sharpMoneyNote,
      openingOdds: openingOdds || null,
    };
  });
}

module.exports = { analyzePicks, setLiveStats, applyInjuryPenalty, applyEloAdjustment, applySharpMoneySignal };
