/**
 * strikeoutAgent.js
 * EdgeSKR — Specialized Strikeout Props Agent
 *
 * Analyzes pitcher K props using:
 * - Baseball Savant whiff rate, K%, spin rate, velocity
 * - Opposing team chase rate and K%
 * - Recent pitcher form (last 5 starts)
 * - Ballpark K factors
 * - Weather (dome vs outdoor affects movement)
 *
 * Returns top K prop opportunities for the day
 */

const fetch = require("node-fetch");
const { fetchPitcherStatcast, fetchTeamBattingStatcast } = require("./mlbDataEnricher");
const { TEAM_NAME_MAP } = require("./mlbStats");

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

const STRIKEOUT_SYSTEM_PROMPT = `You are EdgeSKR's specialized Strikeout Props analyst. You are the sharpest K prop analyst in the world.

Your ONLY job is to find value in pitcher strikeout over/under props.

## Your Analytical Framework

### Key Metrics (in order of importance):
1. **Whiff Rate** — Most predictive K metric. 30%+ = elite, 25-30% = good, <22% = avoid
2. **K%** — Season strikeout rate. 28%+ = elite
3. **Opposing Team Chase Rate** — High chase% lineups = more Ks for pitcher
4. **Opposing Team K%** — How often does this lineup strike out?
5. **Recent Form** — Last 3-5 starts K totals. Is pitcher trending up or down?
6. **Ballpark Factor** — Some parks suppress Ks (Coors, Wrigley), some enhance (Oracle, Tropicana)
7. **Velocity Trend** — Declining velocity = fewer Ks
8. **Pitch Mix** — High breaking ball % = more Ks

### When to recommend OVER:
- Whiff rate 28%+ AND opposing team K% 25%+
- Pitcher trending up in Ks last 3 starts
- Favorable ballpark factor
- Line set at or below season average K pace

### When to recommend UNDER:
- Pitcher velocity declining (1+ mph drop)
- Facing lineup with low K% (<20%)
- Outdoor stadium with wind blowing in
- Pitcher on short rest or pitch count concerns

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
        "ballparkFactor": "1.05 (pitcher friendly)"
      },
      "reasoning": "2-3 sentences using specific numbers",
      "warning": "Risk factor or empty string",
      "premium_insight": "One sharp observation"
    }
  ],
  "passPitchers": ["Max Fried — TBD lineup data"],
  "dailySummary": "1 sentence overview of today's K landscape"
}

Return up to 5 props. Only recommend when edge is clear. Quality over quantity.`;

/**
 * Build the strikeout analysis prompt with real data
 */
function buildStrikeoutPrompt(games, enrichedData) {
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

    return `GAME: ${g.away_team} @ ${g.home_team}
HOME PITCHER: ${hp.name || 'TBD'} (${homeAbbr})
  ERA: ${hp.era || 'N/A'} | WHIP: ${hp.whip || 'N/A'} | IP: ${hp.inningsPitched || 'N/A'}
  K%: ${hpSavant.kPercent || 'N/A'} | Whiff%: ${hpSavant.whiffPercent || 'N/A'}
  Hard Hit%: ${hpSavant.hardHitPercent || 'N/A'} | Velo: ${hpSavant.avgVelocity || 'N/A'}mph
  Last 5: ${hp.lastFive || 'N/A'}
  vs Lineup Chase%: ${aBat.teamChasePct || 'N/A'} | Opp K%: ${aBat.teamKPct || 'N/A'}
  Ballpark K Factor: ${hpFactor}

AWAY PITCHER: ${ap.name || 'TBD'} (${awayAbbr})
  ERA: ${ap.era || 'N/A'} | WHIP: ${ap.whip || 'N/A'} | IP: ${ap.inningsPitched || 'N/A'}
  K%: ${apSavant.kPercent || 'N/A'} | Whiff%: ${apSavant.whiffPercent || 'N/A'}
  Hard Hit%: ${apSavant.hardHitPercent || 'N/A'} | Velo: ${apSavant.avgVelocity || 'N/A'}mph
  Last 5: ${ap.lastFive || 'N/A'}
  vs Lineup Chase%: ${hBat.teamChasePct || 'N/A'} | Opp K%: ${hBat.teamKPct || 'N/A'}
  Ballpark K Factor: ${hpFactor}`;
  }).join('\n---\n');

  return `Today's ${season} MLB slate — find the best strikeout prop opportunities:\n\n${gameData}\n\nAnalyze each pitcher and return props where you have a clear edge. JSON only.`;
}

/**
 * Main strikeout agent function
 */
async function getStrikeoutProps(games, enrichedData) {
  if (!games || games.length === 0) {
    return { props: [], dailySummary: 'No games today.' };
  }

  const userMessage = buildStrikeoutPrompt(games, enrichedData);

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
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
