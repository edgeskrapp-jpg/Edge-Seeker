/**
 * poisson.js
 * Calculates true win probabilities using a Poisson distribution model.
 *
 * How it works:
 * - MLB teams score runs that roughly follow a Poisson distribution
 * - We use each team's season run average to estimate scoring rates
 * - We then simulate all score combinations (0-20 runs per team)
 *   and sum the probabilities where one team outscores the other
 * - This gives us a "true" win probability independent of the sportsbook
 */

/**
 * Poisson probability mass function
 * P(X = k) = (lambda^k * e^-lambda) / k!
 * @param {number} lambda - expected value (avg runs)
 * @param {number} k - actual outcome (runs scored)
 */
function poissonPMF(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i); // subtract log(k!)
  return Math.exp(logP);
}

/**
 * Calculate win/draw/loss probabilities using Poisson
 * @param {number} homeAvgRuns - home team avg runs per game this season
 * @param {number} awayAvgRuns - away team avg runs per game this season
 * @param {number} maxRuns - max runs to simulate (20 covers 99.9%+ of outcomes)
 * @returns {{ homeWin: number, awayWin: number, draw: number }}
 */
function poissonWinProb(homeAvgRuns, awayAvgRuns, maxRuns = 20) {
  let homeWin = 0;
  let awayWin = 0;
  let draw = 0;

  for (let h = 0; h <= maxRuns; h++) {
    const pHome = poissonPMF(homeAvgRuns, h);
    for (let a = 0; a <= maxRuns; a++) {
      const pAway = poissonPMF(awayAvgRuns, a);
      const joint = pHome * pAway;
      if (h > a) homeWin += joint;
      else if (a > h) awayWin += joint;
      else draw += joint;
    }
  }

  // In MLB there are no ties (extra innings), so redistribute draw probability
  // proportionally between home and away
  const drawShare = draw / 2;
  return {
    homeWin: homeWin + drawShare,
    awayWin: awayWin + drawShare,
    draw,
  };
}

/**
 * Convert American moneyline odds to implied probability
 * e.g. -150 → 0.6, +130 → 0.4348
 */
function americanToImplied(americanOdds) {
  if (americanOdds < 0) {
    return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
  } else {
    return 100 / (americanOdds + 100);
  }
}

/**
 * Convert decimal odds to implied probability
 */
function decimalToImplied(decimalOdds) {
  return 1 / decimalOdds;
}

/**
 * Remove the vig (overround) from a pair of implied probabilities
 * so they sum to 1.0 (true probabilities)
 */
function removeVig(impliedHome, impliedAway) {
  const total = impliedHome + impliedAway;
  return {
    trueHome: impliedHome / total,
    trueAway: impliedAway / total,
  };
}

/**
 * Calculate edge: how much better our true prob is vs the book's implied prob
 * Positive edge = we think the team is MORE likely to win than the book does
 * e.g. edge of 0.08 = 8% edge
 */
function calcEdge(trueProb, impliedProb) {
  return trueProb - impliedProb;
}

/**
 * Kelly Criterion: optimal bet sizing given edge and odds
 * f = (bp - q) / b
 * where b = decimal odds - 1, p = true win prob, q = 1 - p
 * Returns fraction of bankroll to bet (capped at 10% for safety)
 */
function kellyCriterion(trueProb, decimalOdds) {
  const b = decimalOdds - 1;
  const p = trueProb;
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  // Quarter Kelly for conservative sizing, min 0, max 10%
  const quarterKelly = kelly * 0.25;
  return Math.max(0, Math.min(0.10, quarterKelly));
}

/**
 * Convert American odds to decimal
 */
function americanToDecimal(americanOdds) {
  if (americanOdds < 0) {
    return 1 + 100 / Math.abs(americanOdds);
  } else {
    return 1 + americanOdds / 100;
  }
}

/**
 * Base confidence score driven solely by edge percentage, capped at 60.
 * All other adjustments (Elo, FIP cap, fatigue, injuries) layer on top.
 *
 * Scale:
 *   edge < 5%  → 0–45  (sparse data / marginal edge)
 *   edge 5–10% → 45–55
 *   edge 10%+  → 55–60 (hard cap at 60)
 *
 * Kelly is accepted but no longer added to base — edge alone sets the ceiling.
 */
function confidenceScore(edgePct, kellyPct) {
  const e = edgePct; // decimal (0.05 = 5%)
  if (e >= 0.15) return 60;
  if (e >= 0.10) return Math.round(55 + (e - 0.10) * 100); // 55–60 over last 5%
  if (e >= 0.05) return Math.round(45 + (e - 0.05) * 200); // 45–55 over mid 5%
  return Math.max(0, Math.round(30 + e * 300));             // 0–45 below 5%
}

module.exports = {
  poissonWinProb,
  americanToImplied,
  decimalToImplied,
  removeVig,
  calcEdge,
  kellyCriterion,
  americanToDecimal,
  confidenceScore,
};
