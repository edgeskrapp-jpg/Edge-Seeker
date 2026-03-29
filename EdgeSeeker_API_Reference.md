# Edge Seeker — Frontend API Reference
**For frontend development use. Last updated: 2026 Season.**

---

## Stack Overview

| Layer | Technology |
|---|---|
| Backend | Node.js / Express on Vercel |
| Database | Supabase (PostgreSQL) |
| Auth | Solana wallet address (base58, 32–44 chars) |
| Payments | On-chain SOL verification |
| AI Agents | Claude Sonnet (free), Claude Opus (premium) |
| Base URL | `https://edge-seeker.vercel.app` |

---

## Authentication

Most endpoints are public. Premium endpoints require a Solana wallet address passed as a query parameter:

```
?wallet=SOLANA_WALLET_ADDRESS
```

If unpaid, the server returns `402` with payment instructions:
```json
{
  "error": "Payment required",
  "message": "Send 0.05 SOL to unlock premium picks",
  "price": 0.05,
  "revenueWallet": "WALLET_ADDRESS"
}
```

---

## Core Endpoints

### GET `/api/health`
Server status check. No auth.

**Response:**
```json
{ "status": "ok", "timestamp": "..." }
```

---

### GET `/api/picks`
Today's Poisson model picks for all games. Free tier — no auth required.

**Response:**
```json
{
  "picks": [...],
  "total": 4,
  "gamesAnalyzed": 12,
  "cached": true,
  "fetchedAt": "2026-03-29T15:00:00Z",
  "quota": { "remaining": 480, "used": 20 }
}
```

**Pick object (free tier):**
```json
{
  "pick": "LAD ML",
  "side": "home",
  "team": "Los Angeles Dodgers",
  "opponent": "Arizona Diamondbacks",
  "teamAbbr": "LAD",
  "opponentAbbr": "ARI",
  "betType": "Moneyline",
  "bookOddsAmerican": "-165",
  "trueWinProb": 64.2,
  "bookImpliedProb": 62.3,
  "edgePct": 3.8,
  "kellyPct": 1.2,
  "confidence": 48,
  "grade": "C",
  "warning": "",
  "movement": "stable",
  "gameTime": "2026-03-29T19:10:00Z",
  "homeTeam": "Los Angeles Dodgers",
  "awayTeam": "Arizona Diamondbacks",
  "upgradeAvailable": true,
  "upgradeNote": "Premium analysis includes FIP, bullpen, sharp money, fatigue and weather signals"
}
```

---

### GET `/api/picks/daily`
Today's persisted premium picks from Supabase. **No auth required.** This is the primary endpoint for the Premium Model page.

**Response — picks available:**
```json
{
  "picks": [...],
  "date": "2026-03-29",
  "source": "supabase",
  "count": 2
}
```

**Response — not yet generated:**
```json
{
  "picks": [],
  "date": "2026-03-29",
  "source": "pending",
  "message": "Picks not yet generated for today"
}
```

Picks are generated daily at **11AM ET** via auto-run. Once saved, all subsequent calls return from Supabase — no Claude API call needed.

---

### GET `/api/agent/free`
Free tier AI pick. Single best pick via Claude Sonnet. No auth required.

**Response:**
```json
{
  "pick": "NYY ML",
  "team": "New York Yankees",
  "opponent": "Boston Red Sox",
  "edge": "6.2%",
  "odds": "-118",
  "kelly": "2.4%",
  "confidence": 68,
  "reasoning": "2-3 sentence explanation of the probability discrepancy.",
  "warning": "Risk factor or empty string",
  "grade": "B",
  "tier": "free",
  "model": "claude-sonnet",
  "cached": true
}
```

**Grade scale:** A (edge 8%+, conf 70+) → B → C → PASS

---

### GET `/api/agent/premium?wallet=ADDRESS`
Premium AI pick via Claude Opus. Full model — all layers active. Requires wallet + payment.

**Response:**
```json
{
  "picks": [
    {
      "rank": 1,
      "betType": "MONEYLINE",
      "pick": "PHI ML",
      "game": "PHI @ NYM",
      "team": "Philadelphia Phillies",
      "opponent": "New York Mets",
      "edge": "7.8%",
      "true_edge_estimate": "9.1%",
      "odds": "-118",
      "kelly": "3.1%",
      "confidence": 74,
      "grade": "A",
      "reasoning": "3-4 sentence analysis with specific data points.",
      "key_factor": "Sanchez ERA 2.50 vs NYM lineup K rate 24%",
      "pitcher_edge": "Strong — Sanchez (ERA 2.50) vs Peralta (ERA 3.80)",
      "statcast_edge": "Sanchez whiff rate 31.2%, NYM chase rate 29.4%",
      "weather_impact": "72F, light wind — neutral",
      "warning": "",
      "premium_insight": "Sharp observation only premium analysis captures",
      "line_movement": "Confirming — opened -108, moved to -118",
      "situational": "PHI at home, 2 days rest advantage"
    },
    {
      "rank": 2,
      "betType": "OVER/UNDER",
      "pick": "OVER 8.5 runs",
      "...": "same shape"
    }
  ],
  "tier": "premium",
  "model": "claude-opus",
  "cached": false
}
```

**Premium grade scale:** A+ → A → B+ → B → C → PASS

---

### GET `/api/props/strikeouts`
Strikeout prop picks via specialized K agent. No auth required.

**Response:**
```json
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
      "reasoning": "2-3 sentences with specific numbers",
      "warning": "",
      "premium_insight": "Sharp observation"
    }
  ],
  "passPitchers": ["Max Fried — TBD lineup data"],
  "dailySummary": "1 sentence overview of today's K landscape"
}
```

---

### GET `/api/agent/hr-props`
Home run prop picks via HR agent. No auth required.

**Response:**
```json
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
        "parkFactor": "1.15 (HR friendly)",
        "windImpact": "12mph blowing out — HR boost",
        "platoonAdvantage": "RHB vs LHP — favorable",
        "recentForm": "2 HR last 7 days",
        "batterHand": "R"
      },
      "reasoning": "2-3 sentences with specific numbers",
      "warning": "",
      "premium_insight": "Sharp observation"
    }
  ],
  "passBatters": ["Batter name — reason"],
  "dailySummary": "1 sentence overview of today's HR landscape"
}
```

---

### GET `/api/accuracy/summary`
Season accuracy stats for the Premium Model page display.

**Response:**
```json
{
  "total": { "wins": 12, "losses": 8, "pushes": 1, "total": 21, "winRate": "57.1", "roi": "4.20", "pending": 2 },
  "pick1": { "wins": 7, "losses": 4, "...": "same shape" },
  "pick2": { "wins": 5, "losses": 4, "...": "same shape" },
  "recent": [...],
  "totalPicks": 21
}
```

---

### GET `/api/agent/game-analysis?home=TEAM&away=TEAM`
Deep dive single game analysis. Premium — requires wallet.

**Response:**
```json
{
  "analysis": {
    "ouLine": "8.5",
    "ouPick": "OVER 8.5",
    "ouEdge": "+6.2%",
    "ouReasoning": "2 sentence explanation",
    "homePitcher": { "name": "...", "era": "...", "kProp": "OVER 6.5 K", "kEdge": "+8%", "note": "..." },
    "awayPitcher": { "name": "...", "era": "...", "kProp": "...", "kEdge": "...", "note": "..." },
    "hotBatters": [{ "name": "...", "team": "...", "stats": "...", "propType": "HOME RUNS", "propPick": "OVER 0.5 HR", "edge": "...", "note": "..." }],
    "weather": "1 sentence weather impact",
    "sharpMoney": "1 sentence sharp money observation"
  },
  "game": { "home": "LAD", "away": "ARI" }
}
```

---

## User / Points Endpoints

### GET `/api/users/:wallet`
Get or create user profile.

### GET `/api/points/:wallet`
Get user points balance and streak.

### GET `/api/leaderboard?type=weekly`
Leaderboard. `type` = `all_time` | `monthly` | `weekly`

### GET `/api/bets/:wallet`
User bet history.

### POST `/api/bets`
Log a bet. Body: `{ wallet, pick, odds, amount, source, gameId, isEdgePick }`

### PATCH `/api/bets/:id/result`
Update bet result. Body: `{ result }` — `win` | `loss` | `push` | `void`

---

## Important UI Notes

### Early Season Grade C Picks
During the first 2 weeks of the season, Statcast data is thin. Picks will come back with:
- `grade: "C"`
- `warning: "Early season — pitcher data pending. Pick based on Poisson model and Elo only."`

**Do not hide these.** Render them with a visual indicator (e.g. amber badge) rather than suppressing them. The model is being honest, not broken.

### PASS Response
When no edge meets the threshold, endpoints return:
```json
{ "picks": [], "passReason": "No discrepancy meets premium standards today." }
```
Render a "No edges found" state rather than an empty component crash.

### Pending Picks
`/api/picks/daily` returns `source: "pending"` before 11AM ET each day. Show a loading/waiting state, not an error.

### Confidence Display
Confidence is 0–100. Suggested display thresholds:
- 70+ → green / high confidence
- 50–69 → amber / moderate
- Below 50 → gray / low confidence (early season)

### Kelly % Note
Kelly % is a mathematical reference figure only. It is **not** a bet size recommendation. Display it as a reference, not a call to action.

---

## Active Layers (Premium Model)

The Premium Model badge "ALL LAYERS ACTIVE" corresponds to these data sources:

| Layer | Source |
|---|---|
| Poisson Model | Team run averages (live from MLB API) |
| Park Factors | Hardcoded ballpark run/HR/K factors |
| Elo Ratings | Updated daily from game results |
| Odds Movement | Opening line vs current line tracking |
| FIP / ERA | MLB Stats API probable pitchers |
| Fatigue | Pitch count + days rest from game logs |
| Injuries | MLB API IL transactions |
| Sharp Money | Pinnacle line movement (Odds API) |
| Bullpen ERA | FanGraphs team bullpen data |
| Weather | Open-Meteo API by stadium coordinates |
| Statcast | Baseball Savant K%, whiff%, barrel%, EV |

---

## Error States

| Code | Meaning |
|---|---|
| 400 | Invalid wallet format or bad params |
| 401 | Wallet required but not provided |
| 402 | Payment required — show SOL payment UI |
| 403 | Admin secret required |
| 404 | Route not found |
| 500 | Server error — show retry state |
