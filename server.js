/**
 * server.js
 * Edge Seeker — Main Express backend server
 *
 * Endpoints:
 *   GET /api/health          → Server status check
 *   GET /api/picks           → Today's analyzed MLB picks with edge %
 *   GET /api/odds/raw        → Raw odds from The Odds API (for debugging)
 *   GET /api/quota           → Check remaining API calls this month
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { analyzePicks } = require("./edgeAnalyzer");
const { calculateBetPoints, getAccuracyBonus } = require("./pointsConfig");
const {
  getUser, upsertUser,
  saveBet, getUserBets, updateBetResult,
  getPoints, addPoints,
  getLeaderboard,
} = require("./supabase");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ODDS_API_KEY;
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────

app.use(express.json());
app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || "http://localhost:3000",
      "http://localhost:5173",  // Vite dev server
      "http://localhost:3000",
      /\.vercel\.app$/,         // Any Vercel deployment
    ],
    methods: ["GET", "POST", "PATCH"],
  })
);

// ─── SIMPLE IN-MEMORY CACHE ──────────────────────────────────────────────────
// Caches odds for 10 minutes so we don't burn through API quota
// (Free tier = 500 requests/month)

const cache = {
  picks: { data: null, fetchedAt: null },
  raw: { data: null, fetchedAt: null },
};
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isCacheValid(entry) {
  return entry.data && Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

// ─── ODDS API HELPERS ────────────────────────────────────────────────────────

/**
 * Fetch today's MLB games with moneyline odds from The Odds API
 */
async function fetchMLBOdds() {
  const url = new URL(`${ODDS_API_BASE}/sports/baseball_mlb/odds`);
  url.searchParams.set("apiKey", API_KEY);
  url.searchParams.set("regions", "us");           // US sportsbooks
  url.searchParams.set("markets", "h2h");          // moneyline (head-to-head)
  url.searchParams.set("oddsFormat", "decimal");   // we convert to American for display
  url.searchParams.set("dateFormat", "iso");

  const res = await fetch(url.toString());

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Odds API error ${res.status}: ${errorText}`);
  }

  // Log remaining quota to console so you can monitor it
  const remaining = res.headers.get("x-requests-remaining");
  const used = res.headers.get("x-requests-used");
  console.log(`📊 Odds API quota — Used: ${used} | Remaining: ${remaining}`);

  const data = await res.json();
  return { games: data, remaining, used };
}

/**
 * Check API quota without fetching odds
 */
async function fetchQuota() {
  const url = new URL(`${ODDS_API_BASE}/sports`);
  url.searchParams.set("apiKey", API_KEY);
  const res = await fetch(url.toString());
  return {
    remaining: res.headers.get("x-requests-remaining"),
    used: res.headers.get("x-requests-used"),
  };
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

/**
 * GET /api/health
 * Simple health check — confirms server is running
 */
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    app: "Edge Seeker Backend",
    version: "1.0.0",
    time: new Date().toISOString(),
  });
});

/**
 * GET /api/picks
 * Main endpoint — returns analyzed picks sorted by edge %
 *
 * Response shape:
 * {
 *   picks: [
 *     {
 *       team: "New York Yankees",
 *       teamAbbr: "NYY",
 *       opponent: "Boston Red Sox",
 *       opponentAbbr: "BOS",
 *       betType: "Moneyline",
 *       pick: "NYY ML",
 *       bookOddsAmerican: "-148",
 *       trueWinProb: 61.2,      // our Poisson estimate
 *       bookImpliedProb: 53.1,  // book's vig-free estimate
 *       edgePct: 8.1,           // our edge over the book
 *       kellyPct: 3.4,          // recommended bet size (% of bankroll)
 *       confidence: 74,         // 0-100 score
 *       gameTime: "2026-04-15T23:10:00Z",
 *       bookmaker: "DraftKings",
 *     },
 *     ...
 *   ],
 *   total: 3,
 *   cached: false,
 *   fetchedAt: "2026-04-15T18:00:00.000Z",
 *   quota: { remaining: "487", used: "13" }
 * }
 */
app.get("/api/picks", async (req, res) => {
  try {
    // Return cache if valid
    if (isCacheValid(cache.picks)) {
      return res.json({ ...cache.picks.data, cached: true });
    }

    const { games, remaining, used } = await fetchMLBOdds();

    if (!games || games.length === 0) {
      return res.json({
        picks: [],
        total: 0,
        message: "No MLB games found for today. Check back later.",
        cached: false,
        fetchedAt: new Date().toISOString(),
        quota: { remaining, used },
      });
    }

    const picks = analyzePicks(games);

    const responseData = {
      picks,
      total: picks.length,
      gamesAnalyzed: games.length,
      cached: false,
      fetchedAt: new Date().toISOString(),
      quota: { remaining, used },
    };

    // Store in cache
    cache.picks = { data: responseData, fetchedAt: Date.now() };

    res.json(responseData);
  } catch (err) {
    console.error("❌ /api/picks error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/odds/raw
 * Returns raw odds data from The Odds API — useful for debugging
 */
app.get("/api/odds/raw", async (req, res) => {
  try {
    if (isCacheValid(cache.raw)) {
      return res.json({ data: cache.raw.data, cached: true });
    }

    const { games, remaining, used } = await fetchMLBOdds();
    cache.raw = { data: games, fetchedAt: Date.now() };

    res.json({ data: games, cached: false, quota: { remaining, used } });
  } catch (err) {
    console.error("❌ /api/odds/raw error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/quota
 * Check how many API calls you have left this month
 */
app.get("/api/quota", async (req, res) => {
  try {
    const quota = await fetchQuota();
    res.json({ quota, message: "Free tier = 500 requests/month" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── USER ROUTES ─────────────────────────────────────────────────────────────

app.post("/api/users/upsert", async (req, res) => {
  try {
    const { wallet_address, username } = req.body;
    if (!wallet_address) return res.status(400).json({ error: "wallet_address required" });
    const user = await upsertUser(wallet_address, username);
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/users/:wallet", async (req, res) => {
  try {
    const user = await getUser(req.params.wallet);
    const points = await getPoints(req.params.wallet);
    res.json({ user, points });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── BETS ROUTES ─────────────────────────────────────────────────────────────

app.post("/api/bets", async (req, res) => {
  try {
    const { wallet_address, pick, amount, odds, book, result, source, is_edge_pick } = req.body;
    if (!wallet_address || !pick || !amount || !odds) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Get existing bets to calculate streak
    const existingBets = await getUserBets(wallet_address);
    let streakCount = 0;
    for (const b of existingBets) {
      if (b.result === 'win') streakCount++;
      else break;
    }

    // Calculate points
    const points = calculateBetPoints({
      result: result || 'pending',
      source: source || 'manual',
      isEdgePick: is_edge_pick || false,
      streakCount,
    });

    const bet = await saveBet({
      wallet_address, pick, amount: parseFloat(amount),
      odds, book, result: result || 'pending',
      source: source || 'manual',
      points_earned: points,
    });

    // Award points if result is known
    if (result && result !== 'pending' && points > 0) {
      await addPoints(wallet_address, points);
    }

    res.json({ bet, points_earned: points });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/bets/:wallet", async (req, res) => {
  try {
    const bets = await getUserBets(req.params.wallet);
    res.json({ bets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/bets/:id/result", async (req, res) => {
  try {
    const { result, wallet_address, is_edge_pick, streak_count } = req.body;
    const points = calculateBetPoints({
      result,
      source: req.body.source || 'manual',
      isEdgePick: is_edge_pick || false,
      streakCount: streak_count || 0,
    });
    const bet = await updateBetResult(req.params.id, result, points);
    if (points > 0 && wallet_address) await addPoints(wallet_address, points);
    res.json({ bet, points_earned: points });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LEADERBOARD ROUTES ───────────────────────────────────────────────────────

app.get("/api/leaderboard", async (req, res) => {
  try {
    const type = req.query.type || 'all_time';
    const limit = parseInt(req.query.limit) || 50;
    const board = await getLeaderboard(type, limit);
    res.json({ leaderboard: board, type });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/points/:wallet", async (req, res) => {
  try {
    const points = await getPoints(req.params.wallet);
    const bets = await getUserBets(req.params.wallet);
    const resolved = bets.filter(b => b.result !== 'pending');
    const wins = resolved.filter(b => b.result === 'win').length;
    const winRate = resolved.length > 0 ? wins / resolved.length : 0;
    const accuracy = getAccuracyBonus(winRate);
    res.json({ points, accuracy, totalBets: bets.length, resolvedBets: resolved.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 404 HANDLER ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
    availableRoutes: ["/api/health", "/api/picks", "/api/odds/raw", "/api/quota", "/api/leaderboard", "/api/bets/:wallet", "/api/points/:wallet", "/api/users/:wallet"],
  });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Edge Seeker backend running on http://localhost:${PORT}`);
  console.log(`\n📡 Endpoints:`);
  console.log(`   GET http://localhost:${PORT}/api/health`);
  console.log(`   GET http://localhost:${PORT}/api/picks`);
  console.log(`   GET http://localhost:${PORT}/api/odds/raw`);
  console.log(`   GET http://localhost:${PORT}/api/quota`);
  console.log(`\n⚡ Odds cache TTL: 10 minutes (saves API quota)`);
  console.log(`\n⚾ Ready to find edges!\n`);
});

module.exports = app;
