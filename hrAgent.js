/**
 * hrAgent.js
 * Edge Seeker — Specialized Home Run Props Agent
 *
 * Analyzes batter HR props using:
 * - Baseball Savant barrel rate, exit velocity, HR/FB%
 * - Pitcher HR/9, fly ball rate, HR/FB% allowed
 * - Park HR factors
 * - Wind direction and speed
 * - Batter recent form (HR last 7/14 days)
 * - Platoon splits (L vs R)
 * - Opposing pitcher handedness
 */

const fetch = require("node-fetch");
const { TEAM_NAME_MAP } = require("./mlbStats");
const { MLB_TEAM_IDS } = require("./cron");
const { fetchBatterStatcast, fetchPitcherHRStats } = require("./mlbDataEnricher");

const PARK_HR_FACTORS = {
  COL: { hr: 1.40, note: "Coors Field — extreme altitude, ball carries significantly" },
  CIN: { hr: 1.18, note: "GABP — short right field porch" },
  NYY: { hr: 1.15, note: "Yankee Stadium — short right field porch favors lefties" },
  TEX: { hr: 1.12, note: "Globe Life Field — warm air boosts carry" },
  HOU: { hr: 1.08, note: "Minute Maid — Crawford Boxes favor LHB pull hitters" },
  ARI: { hr: 1.04, note: "Chase Field — warm desert air when roof open" },
  BAL: { hr: 1.02, note: "Camden Yards — hitter friendly dimensions" },
  MIN: { hr: 1.01, note: "Target Field — neutral" },
  STL: { hr: 1.00, note: "Busch Stadium — neutral" },
  CWS: { hr: 1.00, note: "Guaranteed Rate — neutral" },
  KC:  { hr: 0.98, note: "Kauffman — large dimensions" },
  BOS: { hr: 0.98, note: "Fenway — Green Monster suppresses HR" },
  WSH: { hr: 0.97, note: "Nationals Park — neutral to slight pitcher friendly" },
  ATL: { hr: 0.97, note: "Truist Park — slight pitcher friendly" },
  LAA: { hr: 0.96, note: "Angel Stadium — large dimensions" },
  CHC: { hr: 0.95, note: "Wrigley — wind dependent, check direction" },
  DET: { hr: 0.95, note: "Comerica — deepest CF in MLB" },
  NYM: { hr: 0.95, note: "Citi Field — large dimensions" },
  MIL: { hr: 0.94, note: "American Family Field — dome" },
  TOR: { hr: 0.94, note: "Rogers Centre — dome, neutral" },
  CLE: { hr: 0.93, note: "Progressive Field — pitcher friendly" },
  OAK: { hr: 0.93, note: "Oakland Coliseum — large foul territory" },
  MIA: { hr: 0.93, note: "loanDepot — dome" },
  TB:  { hr: 0.92, note: "Tropicana — dome, catwalk system" },
  LAD: { hr: 0.92, note: "Dodger Stadium — marine layer suppresses HR" },
  PIT: { hr: 0.90, note: "PNC Park — large dimensions, river winds" },
  SD:  { hr: 0.89, note: "Petco — marine layer, deepest park in NL" },
  SEA: { hr: 0.91, note: "T-Mobile — Puget Sound air suppresses HR" },
  SF:  { hr: 0.88, note: "Oracle Park — marine layer and bay wind suppress HR significantly" },
  PHI: { hr: 1.00, note: "Citizens Bank Park — neutral" },
};

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

const HR_SYSTEM_PROMPT = `You are Edge Seeker's specialized Home Run Props analyst. You are the sharpest HR prop
analyst in the world.

Your ONLY job is to find value in batter home run over/under props.

## Your Analytical Framework

### Key Metrics (in order of importance):
1. **Barrel Rate** — Most predictive HR metric. 12%+ = elite, 8-12% = good, <6% = avoid
2. **Exit Velocity** — Average EV. 92mph+ = elite, <88mph = fade
3. **HR/FB%** — Home run rate on fly balls. 20%+ = elite, <12% = fade
4. **Pitcher HR/9** — HRs allowed per 9 innings. 1.5+ = HR prone, <0.8 = suppressor
5. **Pitcher Fly Ball Rate** — High FB% pitchers give up more HR opportunities
6. **Park HR Factor** — Coors/Yankee Stadium vs Petco/Oracle is massive
7. **Wind** — 10mph+ blowing out = significant HR boost. Blowing in = suppress
8. **Platoon Advantage** — RHB vs LHP and LHB vs RHP have HR rate advantages
9. **Recent Form** — HR in last 7/14 days. Hot streaks are real in baseball
10. **Batter Handedness vs Park** — LHB at Yankee Stadium right field porch is elite

### Grade Calibration Rules:
- **Grade A**: Barrel rate >12% AND pitcher HR/9 >1.3 AND favorable park factor >1.05 — all three required
- **Grade B**: Barrel rate >8% AND pitcher HR/9 >1.0 AND park factor neutral or better
- **Grade C**: Any single strong signal but others missing or insufficient data
- **PASS**: Barrel rate <6% OR pitcher is elite HR suppressor (HR/9 <0.7) OR TBD pitcher OR insufficient data

### When to recommend OVER 0.5 HR:
- Barrel rate 12%+ facing pitcher with HR/9 1.3+
- Favorable park factor 1.05+ with wind blowing out 10mph+
- Batter with 3+ HR in last 14 days facing fly ball pitcher

### When to recommend UNDER 0.5 HR (or PASS):
- Batter barrel rate below 6%
- Elite groundball pitcher with HR/9 under 0.7
- Extreme pitcher-friendly park (Petco, Oracle) with wind blowing in
- No recent HR production (0 HR last 14 days) with no strong barrel metrics

### When to PASS:
- TBD pitcher
- Insufficient batter data (fewer than 50 PA)
- Conflicting signals with no clear edge
- Early season with no 2026 Statcast data yet — note data source

## Output Format — JSON only:
{
  "props": [
    {
      "batter": "Aaron Judge",
      "team": "NYY",
      "opponent": "BOS",
      "game": "NYY @ BOS",
      "propLine": "0.5",
      "recommendation": "OVER",
      "edge": "+8.2%",
      "confidence": 72,
      "grade": "A",
      "keyMetrics": {
        "barrelRate": "18.2%",
        "exitVelocity": "95.1mph",
        "hrPerFB": "22.4%",
        "pitcherHR9": "1.42",
        "pitcherFBPct": "38.2%",
        "parkFactor": "1.15 (HR friendly — short right field porch)",
        "windImpact": "12mph blowing out to RF — significant HR boost",
        "platoonAdvantage": "RHB vs LHP — favorable",
        "recentForm": "2 HR last 7 days",
        "batterHand": "R"
      },
      "reasoning": "2-3 sentences using specific numbers",
      "warning": "Risk factor or empty string",
      "premium_insight": "One sharp observation"
    }
  ],
  "passBatters": ["Batter name — reason for pass"],
  "dailySummary": "1 sentence overview of today's HR landscape"
}

Return up to 5 props. Only recommend when edge is clear. Quality over quantity.

If no props meet threshold:
{ "props": [], "passBatters": ["reason for each"], "dailySummary": "No HR edges today — brief explanation" }

## Opening Day Grace Period
When barrel rate, exit velocity, and HR/FB% are all N/A (no 2026 Statcast data yet):
- Still output up to 3 props based on 2025 career Statcast data if available, park factors, wind, and pitcher HR/9
- Set grade to "C" for all early season props
- Add warning: "Early season — 2026 Statcast data pending. Using 2025 career metrics."
- Note in reasoning that you are using prior season data`;

// ─── PROMPT BUILDER ───────────────────────────────────────────────────────────

/**
 * Build the HR analysis prompt.
 * games:          array of { home_team, away_team }
 * enrichedData:   keyed by `${awayAbbr}_${homeAbbr}`, contains pitchers, batting, weather
 * hrDataMap:      batterName.toLowerCase() → { barrelRate, exitVelo, hrPerFB, recentHR7, recentHR14, hand }
 * pitcherHRMap:   pitcherName.toLowerCase() → { hr9, fbPct, barrelAllowed, evAllowed }
 */
function buildHRPrompt(games, enrichedData, hrDataMap, pitcherHRMap) {
  const season = new Date().getFullYear();

  const gameData = games.map(g => {
    const homeAbbr = TEAM_NAME_MAP[g.home_team] || g.home_team.split(' ').pop().slice(0, 3).toUpperCase();
    const awayAbbr = TEAM_NAME_MAP[g.away_team] || g.away_team.split(' ').pop().slice(0, 3).toUpperCase();
    const gameKey = `${awayAbbr}_${homeAbbr}`;
    const enriched = enrichedData[gameKey] || {};
    const hp = enriched.homePitcher || {};
    const ap = enriched.awayPitcher || {};
    const hBat = enriched.homeBatting || {};
    const aBat = enriched.awayBatting || {};
    const weather = enriched.weather || {};

    // Park HR factor
    const parkData = PARK_HR_FACTORS[homeAbbr];
    const parkFactor = parkData ? `${parkData.hr} — ${parkData.note}` : '1.00 — No park data';

    // Wind HR impact label
    const windSpeed = weather.windSpeed || 0;
    const windDir = weather.windDirection || '';
    let windImpact = 'Neutral wind conditions';
    if (windSpeed >= 10) {
      const dirLower = windDir.toLowerCase();
      if (dirLower.includes('out') || dirLower.includes('to cf') || dirLower.includes('to rf') || dirLower.includes('to lf')) {
        windImpact = `⚡ WIND BOOST — ${windSpeed}mph blowing out — significant HR carry boost`;
      } else if (dirLower.includes('in') || dirLower.includes('from cf') || dirLower.includes('from rf') || dirLower.includes('from lf')) {
        windImpact = `🛡️ WIND SUPPRESSOR — ${windSpeed}mph blowing in — HR carry reduced`;
      }
    }

    // Home batters — up to 5, annotate with hrDataMap if available
    const homeBatters = (hBat.lineup || []).slice(0, 5).map(b => {
      const key = (b.name || b).toLowerCase();
      const hr = hrDataMap[key];
      if (hr) {
        return `  - ${b.name || b}: Barrel ${hr.barrelRate || 'N/A'} | EV ${hr.exitVelo || 'N/A'} | HR/FB ${hr.hrPerFB || 'N/A'} | HR last 7d: ${hr.recentHR7 ?? 'N/A'} | HR last 14d: ${hr.recentHR14 ?? 'N/A'} | Hand: ${hr.hand || 'N/A'}`;
      }
      return `  - ${b.name || b}`;
    });

    // Away batters — up to 5
    const awayBatters = (aBat.lineup || []).slice(0, 5).map(b => {
      const key = (b.name || b).toLowerCase();
      const hr = hrDataMap[key];
      if (hr) {
        return `  - ${b.name || b}: Barrel ${hr.barrelRate || 'N/A'} | EV ${hr.exitVelo || 'N/A'} | HR/FB ${hr.hrPerFB || 'N/A'} | HR last 7d: ${hr.recentHR7 ?? 'N/A'} | HR last 14d: ${hr.recentHR14 ?? 'N/A'} | Hand: ${hr.hand || 'N/A'}`;
      }
      return `  - ${b.name || b}`;
    });

    const homeBatterLines = homeBatters.length > 0
      ? homeBatters.join('\n')
      : '  (No lineup data available)';

    const awayBatterLines = awayBatters.length > 0
      ? awayBatters.join('\n')
      : '  (No lineup data available)';

    // Hot batter Statcast enrichment
    const hHot = hBat.hotBatter;
    const aHot = aBat.hotBatter;
    const hHotHR = hHot ? (hrDataMap[hHot.name?.toLowerCase()] || {}) : null;
    const aHotHR = aHot ? (hrDataMap[aHot.name?.toLowerCase()] || {}) : null;

    const hHotLine = hHot
      ? `  HOT BATTER: ${hHot.name || 'N/A'}\n  Statcast: Barrel%=${hHotHR?.barrelRate || 'N/A'} | ExitVelo=${hHotHR?.exitVelo || 'N/A'} | HR/FB=${hHotHR?.hrPerFB || 'N/A'} | HR last 7 days=${hHotHR?.recentHR7 ?? 'N/A'} | HR last 14 days=${hHotHR?.recentHR14 ?? 'N/A'}`
      : '';

    const aHotLine = aHot
      ? `  HOT BATTER: ${aHot.name || 'N/A'}\n  Statcast: Barrel%=${aHotHR?.barrelRate || 'N/A'} | ExitVelo=${aHotHR?.exitVelo || 'N/A'} | HR/FB=${aHotHR?.hrPerFB || 'N/A'} | HR last 7 days=${aHotHR?.recentHR7 ?? 'N/A'} | HR last 14 days=${aHotHR?.recentHR14 ?? 'N/A'}`
      : '';

    const hpHR = pitcherHRMap[hp.name?.toLowerCase()] || {};
    const apHR = pitcherHRMap[ap.name?.toLowerCase()] || {};

    return `GAME: ${g.away_team} @ ${g.home_team}

HOME PARK: ${homeAbbr} — HR Factor: ${parkFactor}

WEATHER: Temp: ${weather.temp || 'N/A'}°F | Wind: ${windSpeed}mph ${windDir}
  Wind HR Impact: ${windImpact}

HOME PITCHER: ${hp.name || 'TBD'} (${homeAbbr})
  ERA: ${hp.era || 'N/A'} | WHIP: ${hp.whip || 'N/A'} | Hand: ${hp.throws || 'N/A'}
  HR Stats: HR/9=${hpHR.hr9 || 'N/A'} | FB%=${hpHR.fbPct || 'N/A'} | Barrel% allowed=${hpHR.barrelAllowed || 'N/A'} | Avg EV allowed=${hpHR.evAllowed || 'N/A'}

AWAY PITCHER: ${ap.name || 'TBD'} (${awayAbbr})
  ERA: ${ap.era || 'N/A'} | WHIP: ${ap.whip || 'N/A'} | Hand: ${ap.throws || 'N/A'}
  HR Stats: HR/9=${apHR.hr9 || 'N/A'} | FB%=${apHR.fbPct || 'N/A'} | Barrel% allowed=${apHR.barrelAllowed || 'N/A'} | Avg EV allowed=${apHR.evAllowed || 'N/A'}

HOME BATTERS (${homeAbbr}):
${homeBatterLines}${hHotLine ? '\n' + hHotLine : ''}

AWAY BATTERS (${awayAbbr}):
${awayBatterLines}${aHotLine ? '\n' + aHotLine : ''}`;
  }).join('\n---\n');

  return `Today's ${season} MLB slate — find the best home run prop opportunities:\n\n${gameData}\n\nAnalyze each game and return HR props where you have a clear edge. JSON only.`;
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────

/**
 * Main HR props agent function.
 */
async function getHRProps(games, enrichedData) {
  if (!games || games.length === 0) {
    return { props: [], dailySummary: 'No games today.' };
  }

  // Collect unique pitcher and batter names from enrichedData
  const pitcherNames = new Set();
  const batterNames  = new Set();

  for (const key of Object.keys(enrichedData)) {
    const e = enrichedData[key];
    if (e.homePitcher?.name) pitcherNames.add(e.homePitcher.name);
    if (e.awayPitcher?.name) pitcherNames.add(e.awayPitcher.name);
    if (e.homeBatting?.hotBatter?.name) batterNames.add(e.homeBatting.hotBatter.name);
    if (e.awayBatting?.hotBatter?.name) batterNames.add(e.awayBatting.hotBatter.name);
  }

  const pitcherHRMap = {};
  const hrDataMap    = {};

  await Promise.all([
    ...[...pitcherNames].map(name =>
      fetchPitcherHRStats(name).then(d => { if (d) pitcherHRMap[name.toLowerCase()] = d; })
    ),
    ...[...batterNames].map(name =>
      fetchBatterStatcast(name).then(d => { if (d) hrDataMap[name.toLowerCase()] = d; })
    ),
  ]);

  console.log(`⚾ HR Agent: fetched HR stats for ${Object.keys(pitcherHRMap).length} pitchers, ${Object.keys(hrDataMap).length} batters`);

  const userMessage = buildHRPrompt(games, enrichedData, hrDataMap, pitcherHRMap);

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 3000,
      system: HR_SYSTEM_PROMPT,
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

module.exports = { getHRProps, PARK_HR_FACTORS, HR_SYSTEM_PROMPT };
