# Edge Seeker Backend

MLB odds analysis engine using The Odds API + Poisson probability model.

---

## How to Run (Step by Step)

### 1. Open Terminal / Command Prompt
- **Mac**: Press `Cmd + Space`, type "Terminal", hit Enter
- **Windows**: Press `Win + R`, type "cmd", hit Enter

### 2. Navigate to this folder
```
cd path/to/edge-seeker-backend
```
(Tip: In VS Code, go to Terminal → New Terminal — it opens right in your project folder)

### 3. Install dependencies (one time only)
```
npm install
```
You'll see packages downloading. Wait for it to finish.

### 4. Start the server
```
npm start
```
You should see:
```
🚀 Edge Seeker backend running on http://localhost:3001
```

### 5. Test it's working
Open your browser and go to:
```
http://localhost:3001/api/health
```
You should see: `{"status":"ok","app":"Edge Seeker Backend",...}`

### 6. Get today's picks
```
http://localhost:3001/api/picks
```
This returns analyzed MLB picks with edge %, Kelly sizing, and confidence scores.

---

## API Endpoints

| Endpoint | What it does |
|----------|-------------|
| `GET /api/health` | Check server is running |
| `GET /api/picks` | Today's picks with edge analysis |
| `GET /api/odds/raw` | Raw odds from The Odds API |
| `GET /api/quota` | Check remaining API calls this month |

---

## How the Edge Calculation Works

1. **Fetch odds** from The Odds API (DraftKings, FanDuel, etc.)
2. **Remove the vig** — sportsbooks bake in ~4-6% margin, we strip it out
3. **Poisson model** — use each team's avg runs/game to estimate true win probability
4. **Calculate edge** — `edge = our_true_prob - book_vig_free_prob`
5. **Kelly sizing** — optimal bet size = `(edge * odds) / (odds - 1)` × 0.25 (quarter Kelly)
6. **Confidence score** — 0-100 based on edge size and Kelly %

Only picks with **3%+ edge** are returned.

---

## Keeping Your API Key Safe

Your API key is in the `.env` file. The `.gitignore` file ensures `.env` is
NEVER uploaded to GitHub. Never paste your API key directly into server.js.

When deploying to Vercel:
1. Go to your project in Vercel dashboard
2. Settings → Environment Variables
3. Add: `ODDS_API_KEY` = your key

---

## Updating Team Stats

The Poisson model uses run averages in `mlbStats.js`. Update these weekly
during the season for better accuracy. Use Baseball Reference team stats:
https://www.baseball-reference.com/leagues/majors/2026.shtml

---

## File Structure

```
edge-seeker-backend/
├── server.js          ← Main Express server (start here)
├── edgeAnalyzer.js    ← Converts raw odds → analyzed picks
├── poisson.js         ← Poisson math + Kelly criterion
├── mlbStats.js        ← MLB team run averages
├── .env               ← Your API key (NEVER commit this)
├── .env.example       ← Template for sharing (safe to commit)
├── .gitignore         ← Keeps .env out of GitHub
└── package.json       ← Dependencies
```
