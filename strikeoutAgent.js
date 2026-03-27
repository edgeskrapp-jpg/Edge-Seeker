/**
 * strikeoutAgent.js
 * Edge Seeker — Specialized Strikeout Props Agent
 *
 * Analyzes pitcher K props using:
 * - Baseball Savant whiff rate, K%, spin rate, velocity
 * - FanGraphs K/9 and BB/9 (team starter averages)
 * - Opposing team strikeout rate (MLB Stats API)
 * - Opposing team chase rate and K%
 * - Recent pitcher form (last 5 starts)
 * - Ballpark K factors
 * - Weather (dome vs outdoor affects movement)
 *
 * Returns top K prop opportunities for the day
 */

const fetch = require("node-fetch");
const { fetchPitcherStatcast, fetchTeamBattingStatcast, fetchFanGraphsPitching, fetchTeamStrikeoutRate, fetchPitcherGameLog, fetchPitcherVelocityTrend } = require("./mlbDataEnricher");
const { fetchKPropLines } = require('./propFetcher');
const { TEAM_NAME_MAP } = require("./mlbStats");
const { MLB_TEAM_IDS } = require("./cron");

// Ballpark K factors (above 1.0 = pitcher friendly, below = hitter friendly)
const BALLPARK_K_FACTORS = {
  NYY: 1.05, BOS: 0.95, TOR: 1.02, TB: 1.08, BAL: 0.98,
  CLE: 1.03, MIN: 1.01, CWS: 1.00, KC: 0.97, DET: 1.02,
  HOU: 1.05, TEX: 0.98, SEA: 1.06, OAK: 1.00, LAA: 0.99,
  ATL: 1.04, NYM: 1.03, PHI: 1.01, MIA: 1.07, WSH: 1.02,
  CHC: 0.94, MIL: 1.03, STL: 1.01, CIN: 0.96, PIT: 1.05,
  LAD: 1.03, SF: 1.08, SD: 1.06, ARI: 0.97, COL: 0.88,
};

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

const STRIKEOUT_SYSTEM_PROMPT = `You are Edge Seeker's specialized Strikeout Props analyst. You are the sharpest K prop analyst in the world.

Your ONLY job is to find value in pitcher strikeout over/under props.

## Your Analytical Framework

### Key Metrics (in order of importance):
1. **Whiff Rate** — Most predictive K metric. 30%+ = elite, 25-30% = good, <22% = avoid
2. **FanGraphs K/9** — Team starter average (note: FIP-based, not individual K/9 — use as context only)
3. **K%** — Season strikeout rate. 28%+ = elite
4. **Opposing Team Lineup K Rate** — Official SO/AB%. >25% = high vulnerability, <18% = pitcher friendly
5. **Opposing Team Chase Rate** — High chase% lineups = more Ks for pitcher
6. **Recent Form** — Last 5 starts K totals. Is pitcher trending up or down?
7. **Ballpark Factor** — Some parks suppress Ks (Coors, Wrigley), some enhance (Oracle, Tropicana)
8. **Velocity Trend** — Declining velocity = fewer Ks

K/9 shown is team starter average FIP data — use whiff rate and statcast K% as primary individual pitcher signals.

### Grade Calibration Rules:
- **Grade A**: whiff rate >28% AND statcast K% >26% AND opposing lineup K rate >23% — all three required
- **Grade B**: whiff rate >24% AND statcast K% >22% AND opposing lineup K rate >20%
- **Grade C**: any single strong signal but others missing or insufficient data
- **PASS**: opposing lineup K rate < 18% OR TBD pitcher OR insufficient data
- If pitcher FIP is N/A AND statcast K% is N/A (no confirmed stats): cap grade at C, note "Limited data — grade provisional"

### When to recommend OVER:
- Whiff rate 28%+ AND opposing team K% 25%+
- Pitcher trending up in Ks last 3 starts
- Favorable ballpark factor

### When to recommend UNDER:
- Pitcher velocity declining (1+ mph drop)
- Facing lineup with low K rate (<18%)
- Outdoor stadium with wind blowing in

### When to PASS:
- TBD pitcher
- Insufficient recent data (fewer than 5 starts)
- Conflicting signals with no clear edge

## Output Format — JSON only:
{
  "props": [
    {
      "pitcher": "Paul Skenes",
      "team": "PIT",
      "opponent": "NYM",
      "game": "NYM @ PIT",
      "propLine": "7.5",
      "recommendation": "OVER",
      "edge": "+7.2%",
      "confidence": 74,
      "grade": "A",
      "keyMetrics": {
        "whiffRate": "31.2%",
        "kPercent": "29.8%",
        "oppKPercent": "24.1%",
        "oppChaseRate": "31.4%",
        "recentForm": "8K, 9K, 7K last 3 starts",
        "ballparkFactor": "1.05 (pitcher friendly)",
        "fanGraphsK9": "10.4",
        "fanGraphsBB9": "2.8",
        "opposingLineupKRate": "24.1"
      },
      "reasoning": "2-3 sentences using specific numbers",
      "warning": "Risk factor or empty string",
      "premium_insight": "One sharp observation"
    }
  ],
  "passPitchers": ["Max Fried — TBD lineup data"],
  "dailySummary": "1 sentence overview of today's K landscape"
}

If no props meet threshold, return exactly:
{ "props": [], "passPitchers": ["reason for each"], "dailySummary": "No edges today — brief explanation" }

Return up to 5 props. Only recommend when edge is clear. Quality over quantity.`;

// ─── PROMPT HELPERS ───────────────────────────────────────────────────────────

function formatGameLog(log) {
  if (!log || log.length === 0) return 'N/A';
  return log.map(s => `${s.strikeouts}K`).join(', ') + ' (last 5 starts)';
}

function formatVeloTrend(trend) {
  if (!trend) return 'N/A';
  if (trend.trend === 'up') return `UP ${Math.abs(trend.deltaMph)}mph vs season avg`;
  if (trend.trend === 'down') return `DOWN ${Math.abs(trend.deltaMph)}mph vs season avg`;
  return 'STABLE';
}

function formatPropLine(propLine) {
  if (!propLine) return 'No line available';
  const overStr = propLine.overOdds > 0 ? `+${propLine.overOdds}` : `${propLine.overOdds}`;
  const underStr = propLine.underOdds > 0 ? `+${propLine.underOdds}` : `${propLine.underOdds}`;
  return `${propLine.line} (OVER ${overStr} / UNDER ${underStr}, ${propLine.book})`;
}

// ─── PROMPT BUILDER ───────────────────────────────────────────────────────────

/**
 * Build the strikeout analysis prompt with real data.
 * fgDataMap:    abbr → FanGraphs pitching data ({ k9, bb9, ... })
 * kRateMap:     abbr → team hitting K rate data ({ strikeoutRate, strikeoutsPerGame })
 * gameLogMap:   pitcherId → [{ date, strikeouts, inningsPitched, result }]
 * veloTrendMap: pitcherName.toLowerCase() → { seasonAvgVelo, last5AvgVelo, trend, deltaMph }
 * propLinesMap: pitcherName.toLowerCase() → { line, overOdds, underOdds, book }
 */
function buildStrikeoutPrompt(games, enrichedData, fgDataMap, kRateMap, gameLogMap, veloTrendMap, propLinesMap) {
  const season = new Date().getFullYear();
  const gameData = games.map(g => {
    const homeAbbr = TEAM_NAME_MAP[g.home_team] || g.home_team.split(' ').pop().slice(0,3).toUpperCase();
    const awayAbbr = TEAM_NAME_MAP[g.away_team] || g.away_team.split(' ').pop().slice(0,3).toUpperCase();
    const gameKey = `${awayAbbr}_${homeAbbr}`;
    const enriched = enrichedData[gameKey] || {};
    const hp = enriched.homePitcher || {};
    const ap = enriched.awayPitcher || {};
    const hpSavant = hp.statcast || {};
    const apSavant = ap.statcast || {};
    const hBat = enriched.homeBatting || {};
    const aBat = enriched.awayBatting || {};
    const hpFactor = BALLPARK_K_FACTORS[homeAbbr] || 1.0;

    // FanGraphs data — pitcher's own team starters average
    const hpFG = fgDataMap[homeAbbr] || null;
    const apFG = fgDataMap[awayAbbr] || null;

    // Opposing lineup K rate — home pitcher faces away lineup, away pitcher faces home lineup
    const hpOppKRate = kRateMap[awayAbbr] || null;  // home pitcher's opponent is away team
    const apOppKRate = kRateMap[homeAbbr] || null;  // away pitcher's opponent is home team

    const hpK9 = hpFG?.k9 ? parseFloat(hpFG.k9) : null;
    const apK9 = apFG?.k9 ? parseFloat(apFG.k9) : null;

    // Opposing lineup K rate signal
    const hpOppKSignal = hpOppKRate?.strikeoutRate != null
      ? (hpOppKRate.strikeoutRate > 25 ? '⚡ HIGH K RATE LINEUP — strong OVER lean on K props'
        : hpOppKRate.strikeoutRate < 18 ? '🛡️ LOW K RATE LINEUP — strong UNDER lean on K props' : '')
      : '';
    const apOppKSignal = apOppKRate?.strikeoutRate != null
      ? (apOppKRate.strikeoutRate > 25 ? '⚡ HIGH K RATE LINEUP — strong OVER lean on K props'
        : apOppKRate.strikeoutRate < 18 ? '🛡️ LOW K RATE LINEUP — strong UNDER lean on K props' : '')
      : '';

    // Game log, velo trend, prop lines
    const hpGameLog = formatGameLog(gameLogMap[hp.id]);
    const apGameLog = formatGameLog(gameLogMap[ap.id]);
    const hpVeloTrend = formatVeloTrend(veloTrendMap[hp.name?.toLowerCase()]);
    const apVeloTrend = formatVeloTrend(veloTrendMap[ap.name?.toLowerCase()]);
    const hpPropLine = formatPropLine(propLinesMap[hp.name?.toLowerCase()]);
    const apPropLine = formatPropLine(propLinesMap[ap.name?.toLowerCase()]);

    return `GAME: ${g.away_team} @ ${g.home_team}
HOME PITCHER: ${hp.name || 'TBD'} (${homeAbbr})
  K PROP LINE: ${hpPropLine}
  ERA: ${hp.era || 'N/A'} | WHIP: ${hp.whip || 'N/A'} | IP: ${hp.inningsPitched || 'N/A'}
  K%: ${hpSavant.kPercent || 'N/A'} | Whiff%: ${hpSavant.whiffPercent || 'N/A'}
  Hard Hit%: ${hpSavant.hardHitPercent || 'N/A'} | Velo: ${hpSavant.avgVelocity || 'N/A'}mph
  Velo trend: ${hpVeloTrend}
  Recent K totals: ${hpGameLog}
  FANGRAPHS ADVANCED METRICS:
  K/9: ${hpFG?.k9 || 'N/A'} (league avg: 8.8) | BB/9: ${hpFG?.bb9 || 'N/A'} (league avg: 3.2)
  K/9 vs league avg: ${hpK9 != null ? (hpK9 - 8.8).toFixed(1) + ' above/below avg' : 'N/A'}
  OPPOSING LINEUP STRIKEOUT VULNERABILITY:
  Team K rate: ${hpOppKRate?.strikeoutRate != null ? hpOppKRate.strikeoutRate + '%' : 'N/A'} (league avg: 22.4%)
  K's per game: ${hpOppKRate?.strikeoutsPerGame ?? 'N/A'}
  ${hpOppKSignal}
  vs Lineup Chase%: ${aBat.teamChasePct || 'N/A'} | Opp K%: ${aBat.teamKPct || 'N/A'}
  Ballpark K Factor: ${hpFactor}

AWAY PITCHER: ${ap.name || 'TBD'} (${awayAbbr})
  K PROP LINE: ${apPropLine}
  ERA: ${ap.era || 'N/A'} | WHIP: ${ap.whip || 'N/A'} | IP: ${ap.inningsPitched || 'N/A'}
  K%: ${apSavant.kPercent || 'N/A'} | Whiff%: ${apSavant.whiffPercent || 'N/A'}
  Hard Hit%: ${apSavant.hardHitPercent || 'N/A'} | Velo: ${apSavant.avgVelocity || 'N/A'}mph
  Velo trend: ${apVeloTrend}
  Recent K totals: ${apGameLog}
  FANGRAPHS ADVANCED METRICS:
  K/9: ${apFG?.k9 || 'N/A'} (league avg: 8.8) | BB/9: ${apFG?.bb9 || 'N/A'} (league avg: 3.2)
  K/9 vs league avg: ${apK9 != null ? (apK9 - 8.8).toFixed(1) + ' above/below avg' : 'N/A'}
  OPPOSING LINEUP STRIKEOUT VULNERABILITY:
  Team K rate: ${apOppKRate?.strikeoutRate != null ? apOppKRate.strikeoutRate + '%' : 'N/A'} (league avg: 22.4%)
  K's per game: ${apOppKRate?.strikeoutsPerGame ?? 'N/A'}
  ${apOppKSignal}
  vs Lineup Chase%: ${hBat.teamChasePct || 'N/A'} | Opp K%: ${hBat.teamKPct || 'N/A'}
  Ballpark K Factor: ${hpFactor}`;
  }).join('\n---\n');

  return `Today's ${season} MLB slate — find the best strikeout prop opportunities:\n\n${gameData}\n\nAnalyze each pitcher and return props where you have a clear edge. JSON only.`;
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────

/**
 * Main strikeout agent function
 */
async function getStrikeoutProps(games, enrichedData) {
  if (!games || games.length === 0) {
    return { props: [], dailySummary: 'No games today.' };
  }

  // Pre-fetch FanGraphs K/9 + opposing team strikeout rates for all unique teams
  const fgDataMap = {};  // abbr → FanGraphs pitching data
  const kRateMap  = {};  // abbr → { strikeoutRate, strikeoutsPerGame }
  const fetchPromises = [];

  for (const g of games) {
    const homeAbbr = TEAM_NAME_MAP[g.home_team] || g.home_team.split(' ').pop().slice(0,3).toUpperCase();
    const awayAbbr = TEAM_NAME_MAP[g.away_team] || g.away_team.split(' ').pop().slice(0,3).toUpperCase();

    if (!fgDataMap[homeAbbr]) {
      fgDataMap[homeAbbr] = null; // mark as in-flight to avoid duplicate fetches
      fetchPromises.push(fetchFanGraphsPitching(homeAbbr).then(d => { fgDataMap[homeAbbr] = d; }));
    }
    if (!fgDataMap[awayAbbr]) {
      fgDataMap[awayAbbr] = null;
      fetchPromises.push(fetchFanGraphsPitching(awayAbbr).then(d => { fgDataMap[awayAbbr] = d; }));
    }

    const homeTeamId = MLB_TEAM_IDS[homeAbbr];
    const awayTeamId = MLB_TEAM_IDS[awayAbbr];

    if (!kRateMap[homeAbbr] && homeTeamId) {
      kRateMap[homeAbbr] = null;
      fetchPromises.push(fetchTeamStrikeoutRate(homeTeamId).then(d => { kRateMap[homeAbbr] = d; }));
    }
    if (!kRateMap[awayAbbr] && awayTeamId) {
      kRateMap[awayAbbr] = null;
      fetchPromises.push(fetchTeamStrikeoutRate(awayTeamId).then(d => { kRateMap[awayAbbr] = d; }));
    }
  }

  await Promise.all(fetchPromises);

  // Second parallel fetch: per-pitcher game logs, velocity trends, and prop lines
  const gameLogMap   = {};  // pitcherId → [{ date, strikeouts, inningsPitched, result }]
  const veloTrendMap = {};  // pitcherName.toLowerCase() → { seasonAvgVelo, last5AvgVelo, trend, deltaMph }
  let propLinesMap   = {};  // pitcherName.toLowerCase() → { line, overOdds, underOdds, book }

  const enrichFetchPromises = [];
  const seenPitcherIds   = new Set();
  const seenPitcherNames = new Set();

  for (const g of games) {
    const homeAbbr  = TEAM_NAME_MAP[g.home_team] || g.home_team.split(' ').pop().slice(0,3).toUpperCase();
    const awayAbbr  = TEAM_NAME_MAP[g.away_team] || g.away_team.split(' ').pop().slice(0,3).toUpperCase();
    const gameKey   = `${awayAbbr}_${homeAbbr}`;
    const enriched  = enrichedData[gameKey] || {};

    const hpId   = enriched.homePitcher?.id;
    const apId   = enriched.awayPitcher?.id;
    const hpName = enriched.homePitcher?.name;
    const apName = enriched.awayPitcher?.name;

    if (hpId && !seenPitcherIds.has(hpId)) {
      seenPitcherIds.add(hpId);
      enrichFetchPromises.push(fetchPitcherGameLog(hpId).then(d => { gameLogMap[hpId] = d; }));
    }
    if (apId && !seenPitcherIds.has(apId)) {
      seenPitcherIds.add(apId);
      enrichFetchPromises.push(fetchPitcherGameLog(apId).then(d => { gameLogMap[apId] = d; }));
    }
    if (hpName && !seenPitcherNames.has(hpName.toLowerCase())) {
      seenPitcherNames.add(hpName.toLowerCase());
      enrichFetchPromises.push(fetchPitcherVelocityTrend(hpName).then(d => { veloTrendMap[hpName.toLowerCase()] = d; }));
    }
    if (apName && !seenPitcherNames.has(apName.toLowerCase())) {
      seenPitcherNames.add(apName.toLowerCase());
      enrichFetchPromises.push(fetchPitcherVelocityTrend(apName).then(d => { veloTrendMap[apName.toLowerCase()] = d; }));
    }
  }

  enrichFetchPromises.push(fetchKPropLines(games).then(d => { propLinesMap = d; }));

  await Promise.all(enrichFetchPromises);

  const userMessage = buildStrikeoutPrompt(games, enrichedData, fgDataMap, kRateMap, gameLogMap, veloTrendMap, propLinesMap);

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      system: STRIKEOUT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '{}';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

module.exports = { getStrikeoutProps, BALLPARK_K_FACTORS, STRIKEOUT_SYSTEM_PROMPT };
