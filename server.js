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
const { getFreePick, getPremiumPick, invalidateCache } = require("./agentRouter");
const { updateMLBStats } = require("./cron");
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



// ─── PAYMENT VERIFICATION ────────────────────────────────────────────────────

const REVENUE_WALLET = "HzqJgHrrzRXbLnBvAueFKvTx4Fn6PKcZL36tJ4Npx7Cb";
const FREE_ACCESS_WALLETS = [
  "8YPA4TV2rKkFdeJwvhQZPm6CNMNAm9sjP98p3DZSEgcL", // Owner testing wallet
];
const PREMIUM_PRICE_SOL = 0.01; // 0.01 SOL per day
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

/**
 * Check if a wallet has paid today
 * Looks for a SOL transfer to the revenue wallet in the last 24 hours
 */
async function verifyPayment(walletAddress) {
  // Always free for whitelisted wallets
  if (FREE_ACCESS_WALLETS.includes(walletAddress)) {
    return { paid: true, free: true, reason: "Whitelisted wallet" };
  }

  try {
    // Fetch recent transactions for the revenue wallet
    const res = await fetch(SOLANA_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [
          REVENUE_WALLET,
          { limit: 50 }
        ]
      })
    });

    const data = await res.json();
    const signatures = data.result || [];

    if (signatures.length === 0) return { paid: false, reason: "No transactions found" };

    // Check each recent transaction
    const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;

    for (const sig of signatures) {
      // Skip old transactions
      if (sig.blockTime < oneDayAgo) continue;

      // Fetch full transaction details
      const txRes = await fetch(SOLANA_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [sig.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]
        })
      });

      const txData = await txRes.json();
      const tx = txData.result;
      if (!tx) continue;

      // Check if this transaction is from the paying wallet
      const accountKeys = tx.transaction?.message?.accountKeys || [];
      const fromWallet = accountKeys[0];

      if (fromWallet !== walletAddress) continue;

      // Check SOL transfer amount
      const preBalances = tx.meta?.preBalances || [];
      const postBalances = tx.meta?.postBalances || [];
      const lamportsSent = (preBalances[0] || 0) - (postBalances[0] || 0);
      const solSent = lamportsSent / 1_000_000_000;

      if (solSent >= PREMIUM_PRICE_SOL) {
        return {
          paid: true,
          free: false,
          amount: solSent,
          signature: sig.signature,
          reason: `Payment verified: ${solSent} SOL`
        };
      }
    }

    return { paid: false, reason: `No payment of ${PREMIUM_PRICE_SOL} SOL found in last 24h` };

  } catch (err) {
    console.error("Payment verification error:", err.message);
    // Fail open during testing — change to fail closed before launch
    return { paid: false, reason: err.message };
  }
}

// ─── AI AGENT ROUTES ─────────────────────────────────────────────────────────

/**
 * GET /api/agent/free
 * Free tier — Claude Sonnet pick of the day
 * Cached daily so we only call Claude once per day
 */
app.get("/api/agent/free", async (req, res) => {
  try {
    // Get today's picks first
    let picks = [];
    if (isCacheValid(cache.picks)) {
      picks = cache.picks.data?.picks || [];
    } else {
      const { games } = await fetchMLBOdds();
      picks = games?.length ? analyzePicks(games) : [];
    }

    const pick = await getFreePick(picks);
    res.json({ pick, tier: 'free', model: 'claude-sonnet' });
  } catch (err) {
    console.error("❌ /api/agent/free error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agent/premium
 * Premium tier — Claude Opus pick with full enriched data
 * Requires valid payment verification (wallet + tx signature)
 */
app.get("/api/agent/premium", async (req, res) => {
  try {
    const { wallet } = req.query;

    // Verify wallet is provided
    if (!wallet) {
      return res.status(401).json({
        error: "Wallet required",
        message: "Connect your Phantom wallet to access premium picks"
      });
    }

    // Verify payment on-chain
    const payment = await verifyPayment(wallet);
    if (!payment.paid) {
      return res.status(402).json({
        error: "Payment required",
        message: `Send ${PREMIUM_PRICE_SOL} SOL to unlock today's premium pick`,
        price: PREMIUM_PRICE_SOL,
        revenueWallet: REVENUE_WALLET,
        reason: payment.reason,
      });
    }

    // Log if it was free access or paid
    if (payment.free) {
      console.log(`🔓 Free access granted to whitelisted wallet: ${wallet}`);
    } else {
      console.log(`✅ Payment verified for wallet: ${wallet} — ${payment.amount} SOL`);
    }

    let picks = [];
    if (isCacheValid(cache.picks)) {
      picks = cache.picks.data?.picks || [];
    } else {
      const { games } = await fetchMLBOdds();
      picks = games?.length ? analyzePicks(games) : [];
    }

    const pick = await getPremiumPick(picks);
    res.json({ pick, tier: 'premium', model: 'claude-opus' });
  } catch (err) {
    console.error("❌ /api/agent/premium error:", err.message);
    res.status(500).json({ error: err.message });
  }
});


/**
 * GET /api/agent/game-analysis
 * Premium per-game analysis — O/U best bet, pitcher props, hot batters
 */
app.get("/api/agent/game-analysis", async (req, res) => {
  try {
    const { home, away, wallet } = req.query;
    if (!home || !away) return res.status(400).json({ error: "home and away required" });
    if (!wallet) return res.status(401).json({ error: "Wallet required" });

    // Verify payment
    const payment = await verifyPayment(wallet);
    if (!payment.paid) {
      return res.status(402).json({
        error: "Payment required",
        price: PREMIUM_PRICE_SOL,
        revenueWallet: REVENUE_WALLET,
      });
    }

    // Get enriched data for this game
    const { enrichPicks } = require("./mlbDataEnricher");
    const { PREMIUM_SYSTEM_PROMPT } = require("./agentPrompt");

    // Build picks for this specific game
    let gamePicks = [];
    if (isCacheValid(cache.picks)) {
      gamePicks = (cache.picks.data?.picks || []).filter(p =>
        p.homeTeam === home && p.awayTeam === away
      );
    }

    // Fetch enriched data
    const enrichedData = await enrichPicks([]);
    const homeAbbr = home.split(" ").pop().substring(0, 3).toUpperCase();
    const awayAbbr = away.split(" ").pop().substring(0, 3).toUpperCase();
    const gameKey = `${awayAbbr}_${homeAbbr}`;
    const gameEnriched = enrichedData[gameKey] || {};

    // Build game-specific prompt
    const gamePrompt = `You are EdgeSKR's premium MLB game analyst. Analyze this specific matchup and provide:
1. Over/Under best bet with projected total runs
2. Home pitcher analysis with strikeout prop recommendation
3. Away pitcher analysis with strikeout prop recommendation  
4. One hot batter from each team with a prop bet (hits, home runs, RBIs, or strikeouts)
5. Weather impact
6. Sharp money observation

Game: ${away} @ ${home}
${gamePicks.length > 0 ? `Moneyline Edge: ${gamePicks[0].pick} +${gamePicks[0].edgePct}% edge` : 'No moneyline edge detected'}
${gameEnriched.homePitcher ? `Home Pitcher: ${gameEnriched.homePitcher.name} ERA:${gameEnriched.homePitcher.era} WHIP:${gameEnriched.homePitcher.whip} Last5:${gameEnriched.homePitcher.lastFive}` : ''}
${gameEnriched.awayPitcher ? `Away Pitcher: ${gameEnriched.awayPitcher.name} ERA:${gameEnriched.awayPitcher.era} WHIP:${gameEnriched.awayPitcher.whip} Last5:${gameEnriched.awayPitcher.lastFive}` : ''}
${gameEnriched.weather ? `Weather: ${gameEnriched.weather.temp}F, wind ${gameEnriched.weather.windSpeed}mph ${gameEnriched.weather.windDir} — ${gameEnriched.weather.impact}` : ''}

Respond ONLY with valid JSON:
{
  "ouLine": "8.5",
  "ouPick": "OVER 8.5",
  "ouEdge": "+6.2%",
  "ouReasoning": "2 sentence explanation",
  "homePitcher": {
    "name": "Max Fried",
    "era": "2.80",
    "whip": "1.05",
    "kProp": "OVER 6.5 K",
    "kEdge": "+8%",
    "note": "1 sentence insight"
  },
  "awayPitcher": {
    "name": "Logan Webb",
    "era": "3.10",
    "whip": "1.12",
    "kProp": "OVER 5.5 K",
    "kEdge": "+5%",
    "note": "1 sentence insight"
  },
  "hotBatters": [
    {
      "name": "Giancarlo Stanton",
      "team": "NYY",
      "stats": ".285 AVG, 3 HR last 7 games",
      "propType": "HOME RUNS",
      "propPick": "OVER 0.5 HR",
      "edge": "+7%",
      "note": "1 sentence insight"
    }
  ],
  "weather": "1 sentence weather impact",
  "sharpMoney": "1 sentence sharp money observation"
}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 1000,
        system: PREMIUM_SYSTEM_PROMPT,
        messages: [{ role: "user", content: gamePrompt }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "{}";
    const analysis = JSON.parse(text.replace(/```json|```/g, "").trim());

    res.json({ analysis, game: { home, away }, cached: false });

  } catch (err) {
    console.error("❌ /api/agent/game-analysis error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agent/refresh
 * Force refresh the agent cache (admin only)
 */
app.post("/api/agent/refresh", (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  invalidateCache();
  res.json({ message: "Agent cache cleared" });
});



// ─── CRON ROUTES ─────────────────────────────────────────────────────────────

/**
 * GET /api/cron/update-stats
 * Runs daily at 6AM ET via Vercel Cron
 * Also callable manually from admin dashboard
 */
app.get("/api/cron/update-stats", async (req, res) => {
  // Vercel cron sends authorization header, manual calls need secret
  const cronSecret = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminSecret = req.query.secret === process.env.ADMIN_SECRET;

  if (!cronSecret && !adminSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    console.log("🕐 Daily stats update triggered...");
    const result = await updateMLBStats();
    console.log("✅ Daily stats update complete:", result);
    res.json({
      success: true,
      ...result,
      triggeredAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Cron error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/stats/teams
 * Returns live team stats from Supabase
 * Falls back to mlbStats.js projections if season hasn't started
 */
app.get("/api/stats/teams", async (req, res) => {
  try {
    const { supabaseQuery } = require("./supabase");
    const rows = await supabaseQuery("team_stats", "GET", null,
      "?order=updated_at.desc"
    );
    if (rows && rows.length > 0) {
      res.json({ stats: rows, source: "live", updatedAt: rows[0]?.updated_at });
    } else {
      const { MLB_TEAM_STATS } = require("./mlbStats");
      res.json({ stats: MLB_TEAM_STATS, source: "projections" });
    }
  } catch (err) {
    const { MLB_TEAM_STATS } = require("./mlbStats");
    res.json({ stats: MLB_TEAM_STATS, source: "projections_fallback" });
  }
});



// ─── ELO ROUTES ──────────────────────────────────────────────────────────────

const { OPENING_DAY_ELO, updateEloFromResults, getEloTier, AL_TEAMS, NL_TEAMS, DIVISIONS } = require("./eloSystem");

/**
 * GET /api/elo
 * Returns current Elo ratings for all 30 MLB teams
 * Falls back to Opening Day seeds if no live data yet
 */
app.get("/api/elo", async (req, res) => {
  try {
    const { supabaseQuery } = require("./supabase");

    // Try to get live Elo from Supabase
    let eloData = [];
    try {
      eloData = await supabaseQuery("elo_ratings", "GET", null, "?order=elo.desc");
    } catch {}

    if (!eloData || eloData.length < 30) {
      // Return Opening Day seeds formatted for frontend
      const seeds = Object.entries(OPENING_DAY_ELO).map(([abbr, data]) => {
        const tier = getEloTier(data.elo);
        return {
          team_abbr: abbr,
          elo: data.elo,
          previous_elo: data.elo,
          last_change: 0,
          trend: data.trend,
          wins: 0,
          losses: 0,
          note: data.note,
          tier: tier.label,
          tier_color: tier.color,
          isAL: AL_TEAMS.includes(abbr),
          isNL: NL_TEAMS.includes(abbr),
        };
      }).sort((a, b) => b.elo - a.elo);

      return res.json({
        ratings: seeds,
        source: 'opening_day_seeds',
        message: 'Season has not started — showing Opening Day projections',
        lastUpdated: '2026-03-25',
      });
    }

    // Enrich live data with tier info
    const enriched = eloData.map(row => {
      const tier = getEloTier(row.elo);
      return {
        ...row,
        tier: tier.label,
        tier_color: tier.color,
        isAL: AL_TEAMS.includes(row.team_abbr),
        isNL: NL_TEAMS.includes(row.team_abbr),
      };
    });

    res.json({
      ratings: enriched,
      source: 'live',
      lastUpdated: eloData[0]?.updated_at,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/elo/seed
 * Seeds Supabase with Opening Day Elo ratings
 * Run this once before Opening Day
 */
app.post("/api/elo/seed", async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { supabaseQuery } = require("./supabase");
    const rows = Object.entries(OPENING_DAY_ELO).map(([abbr, data]) => ({
      team_abbr: abbr,
      elo: data.elo,
      previous_elo: data.elo,
      last_change: 0,
      trend: data.trend,
      wins: 0,
      losses: 0,
      note: data.note,
      updated_at: new Date().toISOString(),
    }));

    await supabaseQuery("elo_ratings", "POST", rows);
    res.json({ seeded: rows.length, message: "Opening Day Elo ratings seeded!" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/cron/update-elo
 * Updates Elo ratings based on today's game results
 * Runs daily via Vercel Cron after games finish (~midnight ET)
 */
app.get("/api/cron/update-elo", async (req, res) => {
  const cronSecret = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminSecret = req.query.secret === process.env.ADMIN_SECRET;
  if (!cronSecret && !adminSecret) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { supabaseQuery } = require("./supabase");

    // Get current Elo ratings
    const current = await supabaseQuery("elo_ratings", "GET", null, "?order=elo.desc");
    const eloMap = {};
    for (const row of (current || [])) {
      eloMap[row.team_abbr] = row;
    }

    // If no data seeded yet use Opening Day seeds
    if (Object.keys(eloMap).length === 0) {
      return res.json({ message: "No Elo data seeded yet. Run /api/elo/seed first." });
    }

    // Update from today's results
    const { updatedElos, results, gamesProcessed } = await updateEloFromResults(eloMap);

    // Save updates to Supabase
    for (const [abbr, data] of Object.entries(updatedElos)) {
      if (data.elo !== eloMap[abbr]?.elo) {
        await supabaseQuery("elo_ratings", "PATCH", {
          elo: data.elo,
          previous_elo: eloMap[abbr]?.elo || data.elo,
          last_change: data.lastChange || 0,
          trend: data.trend,
          updated_at: new Date().toISOString(),
        }, `?team_abbr=eq.${abbr}`);
      }
    }

    res.json({ gamesProcessed, results, updated: Object.keys(updatedElos).length });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ACCURACY TRACKER ────────────────────────────────────────────────────────

/**
 * GET /api/accuracy
 * Returns accuracy stats for all 3 trackers
 * Total, Pick 1 only, Pick 2 only
 */
app.get("/api/accuracy", async (req, res) => {
  try {
    const { supabaseQuery } = require("./supabase");

    // Fetch all resolved picks
    const picks = await supabaseQuery(
      "pick_results",
      "GET",
      null,
      "?result=neq.pending&order=pick_date.desc"
    );

    const calcStats = (arr) => {
      const resolved = arr.filter(p => p.result !== 'pending' && p.result !== 'void');
      const wins = resolved.filter(p => p.result === 'win').length;
      const losses = resolved.filter(p => p.result === 'loss').length;
      const pushes = resolved.filter(p => p.result === 'push').length;
      const total = resolved.length;
      const winRate = total > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0';

      // Calculate ROI on 1 unit bets
      let profit = 0;
      resolved.forEach(p => {
        const odds = parseInt(p.odds) || -110;
        if (p.result === 'win') {
          profit += odds > 0 ? odds / 100 : 100 / Math.abs(odds);
        } else if (p.result === 'loss') {
          profit -= 1;
        }
      });
      const roi = total > 0 ? ((profit / (wins + losses)) * 100).toFixed(1) : '0.0';

      return { wins, losses, pushes, total, winRate, roi: profit.toFixed(2), pending: arr.filter(p => p.result === 'pending').length };
    };

    const allPicks = picks || [];
    const pick1 = allPicks.filter(p => p.rank === 1);
    const pick2 = allPicks.filter(p => p.rank === 2);

    // Recent picks (last 20 for display)
    const recent = allPicks.slice(0, 20);

    res.json({
      total: calcStats(allPicks),
      pick1: calcStats(pick1),
      pick2: calcStats(pick2),
      recent,
      totalPicks: allPicks.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/accuracy/log
 * Auto-logs a premium pick to the tracker
 * Called internally when premium picks are generated
 */
app.post("/api/accuracy/log", async (req, res) => {
  try {
    const { secret } = req.body;
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { picks, date } = req.body;
    if (!picks || !Array.isArray(picks)) {
      return res.status(400).json({ error: "picks array required" });
    }

    const { supabaseQuery } = require("./supabase");
    const pickDate = date || new Date().toISOString().split('T')[0];

    // Check if already logged today
    const existing = await supabaseQuery(
      "pick_results",
      "GET",
      null,
      `?pick_date=eq.${pickDate}`
    );

    if (existing && existing.length > 0) {
      return res.json({ message: "Already logged for today", skipped: true });
    }

    const rows = picks
      .filter(p => p.pick !== 'NO BET' && p.grade !== 'PASS')
      .map(p => ({
        pick_date: pickDate,
        rank: p.rank,
        bet_type: p.betType || 'MONEYLINE',
        pick: p.pick,
        game: p.game || '',
        odds: p.odds || '',
        edge: p.edge || '',
        confidence: p.confidence || 0,
        grade: p.grade || 'B',
        result: 'pending',
      }));

    if (rows.length === 0) {
      return res.json({ message: "No picks to log (all PASS)" });
    }

    await supabaseQuery("pick_results", "POST", rows);
    res.json({ logged: rows.length, picks: rows });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/accuracy/result/:id
 * Update the result of a pick (win/loss/push/void)
 * Called from admin dashboard
 */
app.patch("/api/accuracy/result/:id", async (req, res) => {
  try {
    const { secret, result, notes } = req.body;
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { supabaseQuery } = require("./supabase");
    const updated = await supabaseQuery(
      "pick_results",
      "PATCH",
      { result, notes, resolved_at: new Date().toISOString() },
      `?id=eq.${req.params.id}`
    );

    res.json({ updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN DASHBOARD ─────────────────────────────────────────────────────────

/**
 * GET /admin
 * Admin dashboard — protected by ADMIN_SECRET query param
 * Access: edge-seeker.vercel.app/admin?secret=YOUR_ADMIN_SECRET
 */
app.get("/admin", async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).send(`
      <html><body style="background:#080B10;color:#FF3A5C;font-family:monospace;padding:40px;text-align:center">
        <h1>⛔ UNAUTHORIZED</h1>
        <p>Invalid admin secret.</p>
      </body></html>
    `);
  }

  // Fetch all stats in parallel
  let oddsQuota = { remaining: 'N/A', used: 'N/A' };
  let dbStats = { users: 0, bets: 0 };
  let agentCacheStatus = { free: 'cold', premium: 'cold' };

  try { oddsQuota = await fetchQuota(); } catch {}

  try {
    const usersRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/users?select=count`, {
      headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}`, Prefer: 'count=exact' }
    });
    const betsRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bets?select=count`, {
      headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}`, Prefer: 'count=exact' }
    });
    const userCount = usersRes.headers.get('content-range')?.split('/')[1] || '0';
    const betCount = betsRes.headers.get('content-range')?.split('/')[1] || '0';
    dbStats = { users: userCount, bets: betCount };
  } catch {}

  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const uptime = Math.floor(process.uptime() / 60);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EdgeSKR Admin</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Courier New', monospace; background: #080B10; color: #E8EDF5; padding: 20px; min-height: 100vh; }
  .header { border-bottom: 2px solid #00E5FF; padding-bottom: 20px; margin-bottom: 30px; }
  .logo { font-size: 28px; letter-spacing: 4px; color: #00E5FF; font-weight: bold; }
  .subtitle { font-size: 11px; color: #5A6A85; letter-spacing: 3px; margin-top: 4px; }
  .time { font-size: 12px; color: #5A6A85; margin-top: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #0E1420; border: 1px solid #1E2A40; border-radius: 12px; padding: 20px; }
  .card-title { font-size: 10px; letter-spacing: 2px; color: #5A6A85; text-transform: uppercase; margin-bottom: 12px; }
  .card.green { border-top: 2px solid #00FF88; }
  .card.cyan  { border-top: 2px solid #00E5FF; }
  .card.gold  { border-top: 2px solid #FFD060; }
  .card.red   { border-top: 2px solid #FF3A5C; }
  .card.sol   { border-top: 2px solid #9945FF; }
  .stat { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #141C2E; font-size: 13px; }
  .stat:last-child { border-bottom: none; }
  .stat-label { color: #5A6A85; }
  .stat-value { font-weight: bold; }
  .green  { color: #00FF88; }
  .cyan   { color: #00E5FF; }
  .gold   { color: #FFD060; }
  .red    { color: #FF3A5C; }
  .sol    { color: #9945FF; }
  .white  { color: #E8EDF5; }
  .btn { display: inline-block; background: #141C2E; border: 1px solid #1E2A40; border-radius: 8px; color: #E8EDF5; font-family: monospace; font-size: 11px; letter-spacing: 1px; padding: 8px 16px; cursor: pointer; text-decoration: none; margin-right: 8px; margin-top: 8px; transition: all 0.2s; }
  .btn:hover { border-color: #00E5FF; color: #00E5FF; }
  .btn.danger:hover { border-color: #FF3A5C; color: #FF3A5C; }
  .section-title { font-size: 12px; letter-spacing: 3px; color: #5A6A85; text-transform: uppercase; margin: 24px 0 12px; }
  .checklist { background: #0E1420; border: 1px solid #1E2A40; border-radius: 12px; padding: 20px; }
  .check-item { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid #141C2E; font-size: 13px; }
  .check-item:last-child { border-bottom: none; }
  .check-icon { font-size: 16px; }
  .check-text { color: #8A9AB5; }
  .check-action { margin-left: auto; font-size: 10px; color: #5A6A85; }
  code { background: #141C2E; padding: 2px 6px; border-radius: 4px; color: #00E5FF; font-size: 11px; }
</style>
</head>
<body>

<div class="header">
  <div class="logo">EDGESKR ADMIN</div>
  <div class="subtitle">BACKEND DASHBOARD · RESTRICTED ACCESS</div>
  <div class="time">🕐 ${now} ET · Server uptime: ${uptime} min</div>
</div>

<!-- STATS GRID -->
<div class="grid">

  <div class="card cyan">
    <div class="card-title">Odds API</div>
    <div class="stat"><span class="stat-label">Remaining</span><span class="stat-value cyan">${oddsQuota.remaining}</span></div>
    <div class="stat"><span class="stat-label">Used</span><span class="stat-value white">${oddsQuota.used}</span></div>
    <div class="stat"><span class="stat-label">Monthly limit</span><span class="stat-value white">500 (free)</span></div>
    <div class="stat"><span class="stat-label">Status</span><span class="stat-value ${parseInt(oddsQuota.remaining) > 100 ? 'green' : 'red'}">${parseInt(oddsQuota.remaining) > 100 ? '✅ HEALTHY' : '⚠️ LOW'}</span></div>
  </div>

  <div class="card green">
    <div class="card-title">Database (Supabase)</div>
    <div class="stat"><span class="stat-label">Total users</span><span class="stat-value green">${dbStats.users}</span></div>
    <div class="stat"><span class="stat-label">Total bets logged</span><span class="stat-value white">${dbStats.bets}</span></div>
    <div class="stat"><span class="stat-label">Status</span><span class="stat-value green">✅ CONNECTED</span></div>
  </div>

  <div class="card gold">
    <div class="card-title">AI Agent</div>
    <div class="stat"><span class="stat-label">Free tier model</span><span class="stat-value white">claude-sonnet</span></div>
    <div class="stat"><span class="stat-label">Premium tier model</span><span class="stat-value white">claude-opus</span></div>
    <div class="stat"><span class="stat-label">Cost per free pick</span><span class="stat-value gold">~$0.003</span></div>
    <div class="stat"><span class="stat-label">Cost per premium</span><span class="stat-value gold">~$0.015</span></div>
    <div class="stat"><span class="stat-label">Cache</span><span class="stat-value green">Daily (1 call/day)</span></div>
  </div>

  <div class="card sol">
    <div class="card-title">Server</div>
    <div class="stat"><span class="stat-label">Environment</span><span class="stat-value white">Vercel (Production)</span></div>
    <div class="stat"><span class="stat-label">Uptime</span><span class="stat-value green">${uptime} min</span></div>
    <div class="stat"><span class="stat-label">Node version</span><span class="stat-value white">${process.version}</span></div>
    <div class="stat"><span class="stat-label">Memory</span><span class="stat-value white">${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB</span></div>
  </div>

</div>

<!-- ACTIONS -->
<div class="section-title">Quick Actions</div>
<div>
  <a class="btn" href="/api/health" target="_blank">🔍 Health Check</a>
  <a class="btn" href="/api/picks" target="_blank">⚡ View Picks</a>
  <a class="btn" href="/api/agent/premium?wallet=8YPA4TV2rKkFdeJwvhQZPm6CNMNAm9sjP98p3DZSEgcL" target="_blank">🤖 Test Premium Agent</a>
  <a class="btn" href="/api/quota" target="_blank">📊 API Quota</a>
  <a class="btn" href="/api/accuracy" target="_blank">🎯 Accuracy Stats</a>
  <a class="btn" href="/api/leaderboard" target="_blank">🏆 Leaderboard</a>
  <a class="btn" href="/api/cron/update-stats?secret=${secret}" target="_blank">⚾ Run Stats Update</a>
  <a class="btn danger" href="/admin/refresh-agent?secret=${secret}" target="_blank">🔄 Refresh Agent Cache</a>
</div>

<!-- ACCURACY TRACKER ADMIN -->
<div class="section-title">Update Pick Results</div>
<div class="checklist" style="margin-bottom:24px">
  <div class="check-item" style="flex-direction:column;align-items:flex-start;gap:8px">
    <div class="check-text" style="color:var(--text)">Mark a pick as Win/Loss/Push after the game</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;width:100%">
      <input id="pickId" placeholder="Pick ID (from /api/accuracy)" style="background:#141C2E;border:1px solid #1E2A40;border-radius:8px;color:#E8EDF5;font-family:monospace;font-size:12px;padding:8px 12px;flex:1;min-width:200px" />
      <select id="pickResult" style="background:#141C2E;border:1px solid #1E2A40;border-radius:8px;color:#E8EDF5;font-family:monospace;font-size:12px;padding:8px 12px">
        <option value="win">WIN ✓</option>
        <option value="loss">LOSS ✗</option>
        <option value="push">PUSH ~</option>
        <option value="void">VOID</option>
      </select>
      <button onclick="updateResult()" style="background:linear-gradient(135deg,#00E5FF,#7B61FF);border:none;border-radius:8px;color:#080B10;font-family:monospace;font-size:12px;font-weight:bold;padding:8px 16px;cursor:pointer">UPDATE</button>
    </div>
    <div id="updateMsg" style="font-family:monospace;font-size:11px;color:#00FF88;display:none">✅ Updated!</div>
  </div>
</div>

<script>
async function updateResult() {
  const id = document.getElementById('pickId').value.trim();
  const result = document.getElementById('pickResult').value;
  if (!id) { alert('Enter a pick ID'); return; }
  const res = await fetch('/api/accuracy/result/' + id, {
    method: 'PATCH',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ secret: '${secret}', result })
  });
  const data = await res.json();
  const msg = document.getElementById('updateMsg');
  msg.style.display = 'block';
  msg.textContent = res.ok ? '✅ Updated to ' + result.toUpperCase() : '❌ Error: ' + data.error;
  setTimeout(() => msg.style.display = 'none', 3000);
}
</script>

<!-- MAINTENANCE CHECKLIST -->
<div class="section-title">Monthly Maintenance Checklist</div>
<div class="checklist">
  <div class="check-item">
    <div class="check-icon">📊</div>
    <div class="check-text">Check Odds API quota — upgrade if below 100 remaining</div>
    <div class="check-action"><a href="https://the-odds-api.com" target="_blank" style="color:#00E5FF">the-odds-api.com</a></div>
  </div>
  <div class="check-item">
    <div class="check-icon">🤖</div>
    <div class="check-text">Check Anthropic credit balance</div>
    <div class="check-action"><a href="https://console.anthropic.com/settings/billing" target="_blank" style="color:#00E5FF">console.anthropic.com</a></div>
  </div>
  <div class="check-item">
    <div class="check-icon">⚾</div>
    <div class="check-text">Update mlbStats.js with real team run averages</div>
    <div class="check-action"><a href="https://baseball-reference.com/leagues/majors/2026.shtml" target="_blank" style="color:#00E5FF">baseball-reference.com</a></div>
  </div>
  <div class="check-item">
    <div class="check-icon">🗄️</div>
    <div class="check-text">Check Supabase database size (free tier = 500MB)</div>
    <div class="check-action"><a href="https://supabase.com/dashboard" target="_blank" style="color:#00E5FF">supabase.com</a></div>
  </div>
  <div class="check-item">
    <div class="check-icon">🚀</div>
    <div class="check-text">Check Vercel deployment health</div>
    <div class="check-action"><a href="https://vercel.com/dashboard" target="_blank" style="color:#00E5FF">vercel.com</a></div>
  </div>
</div>

<!-- HOW TO ACCESS -->
<div class="section-title">Admin Access</div>
<div class="checklist">
  <div class="check-item">
    <div class="check-icon">🔐</div>
    <div class="check-text">This dashboard is protected by your <code>ADMIN_SECRET</code> environment variable. Never share the URL with the secret included. To access: <code>/admin?secret=YOUR_SECRET</code></div>
  </div>
</div>

</body>
</html>`);
});

/**
 * GET /admin/refresh-agent
 * Force refresh the AI agent cache
 */
app.get("/admin/refresh-agent", (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  invalidateCache();
  res.send(`<html><body style="background:#080B10;color:#00FF88;font-family:monospace;padding:40px;text-align:center">
    <h1>✅ Agent Cache Cleared</h1>
    <p>Next request will generate a fresh pick.</p>
    <a href="/admin?secret=${secret}" style="color:#00E5FF">← Back to Admin</a>
  </body></html>`);
});
const path = require('path');

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'edge-seeker.html'));
});

app.get('/edge-seeker.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'edge-seeker.html'));
});
// ─── 404 HANDLER ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
    availableRoutes: ["/api/health", "/api/picks", "/api/odds/raw", "/api/quota", "/api/leaderboard", "/api/bets/:wallet", "/api/points/:wallet", "/api/users/:wallet", "/api/agent/free", "/api/agent/premium"],
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
