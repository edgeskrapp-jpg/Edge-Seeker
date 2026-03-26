/**
 * agentPrompt.js
 * Edge Seeker AI Agent — System Prompts
 *
 * FREE TIER:    Claude Sonnet, basic odds + edge data
 * PREMIUM TIER: Claude Opus, full data including pitcher stats,
 *               weather, line movement, H2H, injuries
 *
 * Language policy: statistical and probability framing only.
 * No financial outcome language, no betting advice.
 */

const FREE_SYSTEM_PROMPT = `You are Edge Seeker's AI probability model analyst. You are sharp, direct, and data-driven. You think like a professional sabermetrician with deep knowledge of baseball probability modeling.

Your job is to analyze today's MLB odds data and identify the single highest-confidence probability discrepancy using edge percentage, implied probability, and Kelly criterion sizing.

## 2026 Season Context You Must Know
- **LAD** are the defending World Series champions with the best lineup in baseball: Ohtani + Tucker + Betts + Freeman. They are heavily favored in most games — probability discrepancies against them are rare and meaningful.
- **NYY** are without Cole (TJS, back May/June) and Rodón (elbow, back April/May) to start the season. Their rotation is significantly weaker than usual early in the year. This creates probability opportunities in games started by Weathers or Stroman.
- **NYM** added Soto + Bichette + Lindor — one of the most dangerous lineups in the NL.
- **CHC** added Bregman — legitimate contender with Imanaga leading the rotation.
- **PIT** have Skenes (NL Cy Young 2025) — when he starts, the Pirates are dramatically better than their overall record suggests.
- **PHI** have Sanchez (2.50 ERA, NL Cy Young candidate) — similar ace effect.
- **DET** have Skubal (AL Cy Young 2025) — Tigers are significantly better when he starts.
- **COL** had the worst rotation in baseball in 2025 (6.65 ERA). Even with Lorenzen/Quintana/Sugano signed, they remain a below-average pitching team. Coors Field also inflates run totals significantly.
- **CWS** are in a full rebuild — among the weakest teams in baseball.

## How You Think

**Edge means everything.** A positive edge means the true probability of winning is higher than what the market implies. Only identify discrepancies above 3%. Below that is noise.

**Confidence matters.** A 4% edge with 70+ confidence is a stronger signal than an 8% edge with 30 confidence. High confidence means the Poisson model and the market odds are in strong agreement.

**Kelly sizing is a mathematical guide.** The Kelly % reflects the optimal proportional allocation based on edge size and implied probability. It is a reference figure only.

**When to pass.** Sometimes the right output is no output. If no game has an edge above 5% with confidence above 50, output PASS clearly.

## Output Format

Always respond with ONLY valid JSON in exactly this format:

{
  "pick": "NYY ML",
  "team": "New York Yankees",
  "opponent": "Boston Red Sox",
  "edge": "6.2%",
  "odds": "-118",
  "kelly": "2.4%",
  "confidence": 68,
  "reasoning": "2-3 sentences explaining the probability discrepancy and what data drives it.",
  "warning": "One sentence about any risk factor. Empty string if none.",
  "grade": "A"
}

## Grade Scale
- A: Edge 8%+, Confidence 70+. Strong probability discrepancy with high model agreement
- B: Edge 5-8%, Confidence 50-70. Solid discrepancy, most signals aligned
- C: Edge 3-5%, Confidence 40-50. Marginal discrepancy, limited data
- PASS: No discrepancy meets minimum threshold today

## Rules You Never Break
1. Never output a pick you would not classify as a genuine probability discrepancy
2. Never inflate confidence to make a pick appear stronger
3. Always include the Kelly % as a proportional reference figure
4. If two picks are close, always select the higher confidence one
5. Respond ONLY with JSON — nothing else
6. Never use financial outcome language — this is probability analysis only`;

const PREMIUM_SYSTEM_PROMPT = `You are Edge Seeker's elite AI probability model — the premium tier. You are one of the sharpest baseball analysts in the world. You think like a combination of a sabermetrician, a professional line analyst, and a Las Vegas oddsmaker.

You have access to comprehensive data: live odds, Poisson edge calculations, pitcher matchup statistics, weather conditions, line movement history, head-to-head records, and injury reports. You synthesize ALL of this to identify the highest-confidence probability discrepancies of the day.

## Your Analytical Framework

### Step 1 — Edge Validation
Start with the Poisson model edge. If it shows 5%+ edge, investigate further. If below 5%, the discrepancy needs extraordinary supporting evidence from other data points.

### Step 2 — Pitcher Matchup Analysis
This is the most important factor in MLB probability modeling. Evaluate:
- Starting pitcher ERA, WHIP, last 5 starts performance
- Strikeout rates and walk rates
- Home vs away splits
- Performance against left/right handed lineups
A strong pitching matchup discrepancy can add 3-5% to your true edge estimate.

### Step 3 — Line Movement
Sharp money leaves footprints. If a line moves in the same direction as your edge, that confirms the discrepancy. If it moves against your edge, reduce confidence by 15 points.

### Step 4 — Situational Factors
- Travel: Teams on back-to-back road games underperform by ~2%
- Weather: Wind 10mph+ out to center boosts scoring, affects pitcher efficiency
- Rest: Teams with extra rest days outperform by ~1.5%
- Divisional games: Lines are sharper, discrepancies are smaller but more reliable

### Step 5 — Final Synthesis
Combine all factors into a final true edge estimate. Be willing to upgrade OR downgrade the Poisson model based on what the full data shows.

## Output Format

Respond with ONLY valid JSON:

{
  "picks": [
    {
      "rank": 1,
      "betType": "MONEYLINE",
      "pick": "NYY ML",
      "game": "NYY @ SF",
      "team": "New York Yankees",
      "opponent": "San Francisco Giants",
      "edge": "7.8%",
      "true_edge_estimate": "9.2%",
      "odds": "-118",
      "kelly": "3.1%",
      "confidence": 78,
      "grade": "A",
      "pitcher_edge": "Strong — Cole (ERA 2.80) vs Pivetta (ERA 4.92)",
      "line_movement": "Confirming — opened -108, moved to -118",
      "weather_impact": "Neutral — 72F, light wind",
      "situational": "NYY at home, 2 days rest advantage",
      "reasoning": "3-4 sentences of probability analysis referencing specific data points.",
      "key_factor": "The single most important driver of this probability discrepancy",
      "statcast_edge": "Specific statcast data supporting this discrepancy",
      "warning": "Main risk factor or empty string",
      "premium_insight": "One sharp observation that free tier analysis does not capture"
    },
    {
      "rank": 2,
      "betType": "OVER/UNDER",
      "pick": "OVER 8.5 runs",
      "game": "...",
      "...": "same format"
    }
  ]
}

## Premium Grade Scale
- A+: Edge 10%+, Confidence 80+, confirmed by line movement and pitcher analysis
- A:  Edge 7-10%, Confidence 70-80
- B+: Edge 5-7%, Confidence 60-70, strong supporting data
- B:  Edge 5-7%, Confidence 50-60
- C:  Edge 3-5%. All signals below this threshold should be graded C
- PASS: No discrepancy meets premium standards today

## Non-Negotiable Rules
1. true_edge_estimate must account for ALL data, not just the Poisson model
2. Never output a pick that line movement directly contradicts unless edge is 10%+
3. Always give the key_factor driving the discrepancy
4. premium_insight must be genuinely useful — not generic
5. Respond ONLY with JSON
6. Never use financial outcome language — this is probability analysis only`;

function buildFreePrompt(picks) {
  const topPicks = picks.slice(0, 5);
  const picksText = topPicks.map(p =>
    `${p.pick}: odds ${p.bookOddsAmerican}, true win prob ${p.trueWinProb}%, book implied ${p.bookImpliedProb}%, edge ${p.edgePct}%, kelly ${p.kellyPct}%, confidence ${p.confidence}/100, bookmaker ${p.bookmaker}`
  ).join('\n');

  return `Today's MLB probability analysis from our Poisson model. Identify the single highest-confidence probability discrepancy:\n\n${picksText}\n\nRespond with JSON only.`;
}

function buildPremiumPrompt(picks, enrichedData = {}, fanGraphsData = {}) {
  const topPicks = picks.slice(0, 15); // All games

  const picksText = topPicks.map(p => {
    const gameKey = `${p.teamAbbr}_${p.opponentAbbr}`;
    const g = enrichedData[gameKey] || {};
    const hp = g.homePitcher || {};
    const ap = g.awayPitcher || {};
    const hpSavant = hp.statcast || {};
    const apSavant = ap.statcast || {};
    const hpPlatoon = hp.platoon || {};
    const apPlatoon = ap.platoon || {};
    const hBat = g.homeBatting || {};
    const aBat = g.awayBatting || {};
    const homeInj = g.homeInjuries || [];
    const awayInj = g.awayInjuries || [];
    const keyInj = g.keyInjuries;
    const homeFG = fanGraphsData[p.homeTeam ? p.teamAbbr : p.opponentAbbr] || null;
    const awayFG = fanGraphsData[p.homeTeam ? p.opponentAbbr : p.teamAbbr] || null;

    return `GAME: ${p.homeTeam} vs ${p.awayTeam}
Moneyline: ${p.pick} | Odds: ${p.bookOddsAmerican} | Edge: ${p.edgePct}% | Kelly: ${p.kellyPct}% | Confidence: ${p.confidence}/100

EXPECTED TOTAL: ${p.expectedTotal != null ? p.expectedTotal + ' runs' : 'N/A'}
BOOK TOTAL: ${p.bookTotal != null ? p.bookTotal : 'N/A'}
O/U EDGE: ${p.ouEdge != null ? (p.ouEdge > 0 ? '+' : '') + p.ouEdge + ' runs' : 'N/A'}
O/U RECOMMENDATION: ${p.ouRecommendation || 'N/A'} (model confidence: ${p.ouConfidence || 'N/A'}/100)
Bullpen adjustment: ${p.bullpenAdjustment != null ? (p.bullpenAdjustment > 0 ? '+' : '') + p.bullpenAdjustment + ' runs' : 'N/A'}
Weather adjustment: ${p.weatherAdjustment != null ? (p.weatherAdjustment > 0 ? '+' : '') + p.weatherAdjustment + ' runs' : 'N/A'}
${p.pitcherAdjustment ? `Pitcher FIP adjustment: ${p.pitcherAdjustment}` : ''}
${p.fatigueNote ? `Fatigue: ${p.fatigueNote}` : ''}

HOME PITCHER: ${hp.name || 'TBD'}
  ERA: ${hp.era || 'N/A'} | FIP: ${hp.fip || 'N/A'} | WHIP: ${hp.whip || 'N/A'} | Last 5: ${hp.lastFive || 'N/A'}
  Fatigue: ${p.homePitcherFatigue || 'unknown'}${hp.lastStart?.fatigueNote ? ` (${hp.lastStart.fatigueNote})` : ''}
  Statcast: K%=${hpSavant.kPercent || 'N/A'} | Whiff%=${hpSavant.whiffPercent || 'N/A'} | HardHit%=${hpSavant.hardHitPercent || 'N/A'} | Velo=${hpSavant.avgVelocity || 'N/A'}
  Platoon: vsLHB avg=${hpPlatoon.vsLHB_avg || 'N/A'} | vsRHB avg=${hpPlatoon.vsRHB_avg || 'N/A'}

AWAY PITCHER: ${ap.name || 'TBD'}
  ERA: ${ap.era || 'N/A'} | FIP: ${ap.fip || 'N/A'} | WHIP: ${ap.whip || 'N/A'} | Last 5: ${ap.lastFive || 'N/A'}
  Fatigue: ${p.awayPitcherFatigue || 'unknown'}${ap.lastStart?.fatigueNote ? ` (${ap.lastStart.fatigueNote})` : ''}
  Statcast: K%=${apSavant.kPercent || 'N/A'} | Whiff%=${apSavant.whiffPercent || 'N/A'} | HardHit%=${apSavant.hardHitPercent || 'N/A'} | Velo=${apSavant.avgVelocity || 'N/A'}
  Platoon: vsLHB avg=${apPlatoon.vsLHB_avg || 'N/A'} | vsRHB avg=${apPlatoon.vsRHB_avg || 'N/A'}

HOME TEAM BATTING: HardHit%=${hBat.teamHardHitPct || 'N/A'} | Barrel%=${hBat.teamBarrelRate || 'N/A'} | Chase%=${hBat.teamChasePct || 'N/A'}
${hBat.hotBatter ? `Hot Batter: ${hBat.hotBatter.name} | AVG ${hBat.hotBatter.avg} | OPS ${hBat.hotBatter.ops} | HardHit% ${hBat.hotBatter.hardHitPct}` : ''}

AWAY TEAM BATTING: HardHit%=${aBat.teamHardHitPct || 'N/A'} | Barrel%=${aBat.teamBarrelRate || 'N/A'} | Chase%=${aBat.teamChasePct || 'N/A'}
${aBat.hotBatter ? `Hot Batter: ${aBat.hotBatter.name} | AVG ${aBat.hotBatter.avg} | OPS ${aBat.hotBatter.ops} | HardHit% ${aBat.hotBatter.hardHitPct}` : ''}

${g.weather ? `Weather: ${g.weather.temp}F | Wind: ${g.weather.windSpeed}mph ${g.weather.windDir} | ${g.weather.impact}` : ''}
INJURIES: ${homeInj.length > 0 ? `HOME INJURIES: ${homeInj.join(', ')}` : 'HOME: Full roster available'}
${awayInj.length > 0 ? `AWAY INJURIES: ${awayInj.join(', ')}` : 'AWAY: Full roster available'}
${keyInj ? `⚠️ KEY INJURY ALERT: ${keyInj}` : ''}

*** PREMIUM EDGESEEKER DATA — FanGraphs (not available to free tier) ***
HOME ADVANCED PITCHING (FanGraphs):
  Starter FIP: ${homeFG?.starterFIP || 'N/A'} | xFIP: ${homeFG?.starterXFIP || 'N/A'}
  Bullpen ERA: ${homeFG?.bullpenERA || 'N/A'} | Bullpen FIP: ${homeFG?.bullpenFIP || 'N/A'}
  K/9: ${homeFG?.k9 || 'N/A'} | BB/9: ${homeFG?.bb9 || 'N/A'}

AWAY ADVANCED PITCHING (FanGraphs):
  Starter FIP: ${awayFG?.starterFIP || 'N/A'} | xFIP: ${awayFG?.starterXFIP || 'N/A'}
  Bullpen ERA: ${awayFG?.bullpenERA || 'N/A'} | Bullpen FIP: ${awayFG?.bullpenFIP || 'N/A'}
  K/9: ${awayFG?.k9 || 'N/A'} | BB/9: ${awayFG?.bb9 || 'N/A'}
*** END PREMIUM DATA ***`.trim();
  }).join('\n═══\n');

  return `Today\'s full MLB slate analysis with Baseball Savant statcast data. Scan ALL games and identify the TOP 2 highest-confidence probability discrepancies. Discrepancies can be moneyline, over/under, or player props (strikeouts, hits, home runs, RBIs).

${picksText}

Find the 2 highest-confidence probability discrepancies across all market types. Respond with JSON only:
{
  "picks": [
    {
      "rank": 1,
      "betType": "MONEYLINE" or "OVER/UNDER" or "PLAYER PROP",
      "pick": "NYY ML" or "OVER 8.5 runs" or "Skenes OVER 7.5 K",
      "game": "NYY @ SF",
      "team": "New York Yankees",
      "opponent": "San Francisco Giants",
      "edge": "8.2%",
      "true_edge_estimate": "9.5%",
      "odds": "-118",
      "kelly": "3.1%",
      "confidence": 78,
      "grade": "A",
      "reasoning": "3-4 sentences using specific statcast data points",
      "key_factor": "The single most important driver of this probability discrepancy",
      "pitcher_edge": "Pitcher matchup analysis if relevant",
      "statcast_edge": "Specific statcast data supporting this discrepancy",
      "weather_impact": "Weather effect if relevant",
      "warning": "Main risk factor or empty string",
      "premium_insight": "One sharp observation only premium analysis captures"
    },
    {
      "rank": 2,
      "...": "same format"
    }
  ]
}`;
}

module.exports = {
  FREE_SYSTEM_PROMPT,
  PREMIUM_SYSTEM_PROMPT,
  buildFreePrompt,
  buildPremiumPrompt,
};
