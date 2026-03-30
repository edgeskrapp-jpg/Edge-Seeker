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

const { TEAM_NAME_MAP } = require("./mlbStats");
const { MLB_TEAM_IDS } = require("./cron");
const { fetchBatterStatcast, fetchPitcherHRStats } = require("./mlbDataEnricher");

const hrCache = { data: null, date: null };

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
1. **ISO (Isolated Power)** — SLG minus AVG. Best power proxy when barrel rate unavailable. 0.250+ = elite power, 0.150-0.250 = solid, below 0.100 = avoid
2. **SLG%** — Slugging percentage as exit velocity proxy. .550+ = elite, below .380 = fade for HR props
3. **HR/Contact Rate** — Home runs per non-strikeout at-bat. 8%+ = elite HR hitter, below 3% = fade
4. **Season HR Total** — Raw HR count in context of games played
5. **Pitcher HR/9** — HRs allowed per 9 innings. 1.5+ = HR prone, below 0.8 = suppressor
6. **Park HR Factor** — Coors/Yankee Stadium vs Petco/Oracle is the biggest edge
7. **Wind** — 10mph+ blowing out = significant HR boost. Blowing in = suppress
8. **Platoon Advantage** — Batter handedness vs pitcher handedness
9. **OPS** — Overall offensive quality indicator

### Grade Calibration Rules:
- **Grade A**: ISO >0.250 AND pitcher HR/9 >1.3 AND park factor >1.05 — all three required
- **Grade B**: ISO >0.180 AND pitcher HR/9 >1.0 AND park factor neutral or better
- **Grade C**: Any single strong signal — high ISO at HR park, or pitcher HR/9 >1.5, or Coors Field with any qualified batter
- **PASS**: ISO below 0.100 OR pitcher HR/9 below 0.7 OR TBD pitcher OR below 50 PA
- **Park Override OVER**: At COL (factor 1.40), lower the ISO threshold to 0.150+ for Grade B. Any batter with OPS > .800 at Coors is a Grade C minimum.
- **Park Override UNDER/PASS**: At SF, SD, PIT — raise the ISO threshold to 0.250+ for Grade B. Do not recommend OVER props at these parks unless metrics are elite AND wind is blowing out 10mph+.

### When to recommend OVER 0.5 HR:
- ISO >0.250 facing pitcher with HR/9 1.3+
- Favorable park factor 1.05+ with wind blowing out 10mph+
- Batter with high HR/contact rate (8%+) facing HR-prone pitcher

### When to recommend UNDER 0.5 HR (or PASS):
- Batter ISO below 0.100
- Elite groundball pitcher with HR/9 under 0.7
- Extreme pitcher-friendly park (Petco, Oracle) with wind blowing in
- Low season HR total with no strong power metrics

### When to PASS:
- TBD pitcher
- Insufficient batter data (fewer than 50 PA)
- Conflicting signals with no clear edge
- ISO unavailable and no other power indicators present

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
        "iso": "0.287 (elite power)",
        "slugging": ".567",
        "hrContactRate": "9.2% HR/contact",
        "seasonHR": "8 HR in 24 games",
        "pitcherHR9": "1.42",
        "pitcherFBProxy": "12.4% HR/H",
        "parkFactor": "1.15 (HR friendly)",
        "windImpact": "12mph blowing out — HR boost",
        "platoonAdvantage": "LHB vs RHP — favorable",
        "batterHand": "L",
        "ops": ".934",
        "dataSource": "MLB Stats API"
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
- Still output up to 3 props using the data available: AVG, OPS, SLG, season HR totals, park factors, wind, and pitcher ERA/WHIP
- Use SLG > .500 as a proxy for power when barrel rate is unavailable
- Use season HR total as a proxy for power trend when recent HR data is unavailable
- Set grade to "C" for all early season props
- Set confidence no higher than 45
- Add warning: "Early season — Statcast data pending. Using AVG/OPS/SLG as power proxy."
- Always pick batters playing at HR-friendly parks (factor > 1.05) first when data is thin

## Ballpark Intelligence — Always Apply
Never ignore park context. Flag these explicitly in reasoning:
- COL (1.40): ANYONE playing at Coors is a HR candidate regardless of metrics — always mention Coors in reasoning for COL home games
- NYY (1.15): Left-handed pull hitters at Yankee Stadium right field porch — note handedness vs short porch
- CIN (1.18): Underrated HR park — mention GABP when picking CIN home batters
- SF (0.88), SD (0.89), PIT (0.90): Actively suppress HR props at these parks unless barrel rate is elite (15%+)
- CHC (0.95 but wind-dependent): Always check wind direction at Wrigley — 10mph+ blowing out overrides the park factor suppression`;

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

    // Home batters — top 5 by OPS from topBatters, falling back to hotBatter
    const homeBatters = (hBat.topBatters || (hBat.hotBatter ? [hBat.hotBatter] : [])).slice(0, 5).map(b => {
      const key = (b.name || '').toLowerCase();
      const hr = hrDataMap[key] || {};
      return `  - ${b.name}: AVG ${b.avg} | SLG ${b.slg || b.slugging || 'N/A'} | ISO ${b.iso || hr.iso || 'N/A'} | HR ${b.homeRuns ?? 'N/A'} | OPS ${b.ops} | Hand: ${hr.hand || b.hand || 'N/A'} | HR/Contact: ${hr.hrPerFB || 'N/A'}`;
    });

    // Away batters — top 5 by OPS from topBatters, falling back to hotBatter
    const awayBatters = (aBat.topBatters || (aBat.hotBatter ? [aBat.hotBatter] : [])).slice(0, 5).map(b => {
      const key = (b.name || '').toLowerCase();
      const hr = hrDataMap[key] || {};
      return `  - ${b.name}: AVG ${b.avg} | SLG ${b.slg || b.slugging || 'N/A'} | ISO ${b.iso || hr.iso || 'N/A'} | HR ${b.homeRuns ?? 'N/A'} | OPS ${b.ops} | Hand: ${hr.hand || b.hand || 'N/A'} | HR/Contact: ${hr.hrPerFB || 'N/A'}`;
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
      ? `  HOT BATTER: ${hHot.name || 'N/A'}\n  Power: ISO=${hHotHR?.iso || 'N/A'} | SLG=${hHotHR?.slg || hHot.slg || hHot.slugging || 'N/A'} | HR/Contact=${hHotHR?.hrPerFB || 'N/A'} | OPS=${hHotHR?.ops || hHot.ops || 'N/A'}`
      : '';

    const aHotLine = aHot
      ? `  HOT BATTER: ${aHot.name || 'N/A'}\n  Power: ISO=${aHotHR?.iso || 'N/A'} | SLG=${aHotHR?.slg || aHot.slg || aHot.slugging || 'N/A'} | HR/Contact=${aHotHR?.hrPerFB || 'N/A'} | OPS=${aHotHR?.ops || aHot.ops || 'N/A'}`
      : '';

    const hpHR = pitcherHRMap[hp.name?.toLowerCase()] || {};
    const apHR = pitcherHRMap[ap.name?.toLowerCase()] || {};

    return `GAME: ${g.away_team} @ ${g.home_team}

HOME PARK: ${homeAbbr} — HR Factor: ${parkFactor}

WEATHER: Temp: ${weather.temp || 'N/A'}°F | Wind: ${windSpeed}mph ${windDir}
  Wind HR Impact: ${windImpact}

HOME PITCHER: ${hp.name || 'TBD'} (${homeAbbr})
  ERA: ${hp.era || 'N/A'} | WHIP: ${hp.whip || 'N/A'} | Hand: ${hp.throws || 'N/A'}
  HR Stats: HR/9=${hpHR.hr9 || 'N/A'} | HR/H proxy=${hpHR.fbPct || 'N/A'} | OAV=${hpHR.barrelAllowed || 'N/A'} | OPS against=${hpHR.evAllowed || 'N/A'}

AWAY PITCHER: ${ap.name || 'TBD'} (${awayAbbr})
  ERA: ${ap.era || 'N/A'} | WHIP: ${ap.whip || 'N/A'} | Hand: ${ap.throws || 'N/A'}
  HR Stats: HR/9=${apHR.hr9 || 'N/A'} | HR/H proxy=${apHR.fbPct || 'N/A'} | OAV=${apHR.barrelAllowed || 'N/A'} | OPS against=${apHR.evAllowed || 'N/A'}

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

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (hrCache.data && hrCache.date === today) {
    console.log('⚾ HR Agent: serving from cache');
    return hrCache.data;
  }

  // Collect unique pitcher and batter names from enrichedData
  const pitcherNames = new Set();
  const batterNames  = new Set();

  for (const key of Object.keys(enrichedData)) {
    const e = enrichedData[key];
    if (e.homePitcher?.name) pitcherNames.add(e.homePitcher.name);
    if (e.awayPitcher?.name) pitcherNames.add(e.awayPitcher.name);
    const homeBatters = e.homeBatting?.topBatters || (e.homeBatting?.hotBatter ? [e.homeBatting.hotBatter] : []);
    const awayBatters = e.awayBatting?.topBatters || (e.awayBatting?.hotBatter ? [e.awayBatting.hotBatter] : []);
    for (const b of [...homeBatters, ...awayBatters]) {
      if (b.name) batterNames.add(b.name);
    }
  }

  const pitcherHRMap = {};
  const hrDataMap    = {};

  const season = new Date().getFullYear();

  await Promise.all([
    ...[...pitcherNames].map(name =>
      fetchPitcherHRStats(name, season).then(d => { if (d) pitcherHRMap[name.toLowerCase()] = d; })
    ),
    ...[...batterNames].map(name =>
      fetchBatterStatcast(name, season).then(d => { if (d) hrDataMap[name.toLowerCase()] = d; })
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
  const result = JSON.parse(clean);

  hrCache.data = result;
  hrCache.date = today;

  return result;
}

module.exports = { getHRProps, PARK_HR_FACTORS, HR_SYSTEM_PROMPT };
