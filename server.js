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
const path = require("path");
const { analyzePicks } = require("./edgeAnalyzer");
const { calculateBetPoints, getAccuracyBonus } = require("./pointsConfig");
const { getFreePick, getPremiumPick, invalidateCache } = require("./agentRouter");
const { getStrikeoutProps } = require("./strikeoutAgent");
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
  strikeouts: { data: null, date: null },
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

// ─── PICK QUALITY FILTERS ────────────────────────────────────────────────────

/**
 * applyPickFilters(picks)
 * Post-processes raw analyzePicks output with quality adjustments:
 *  1. Coors Field adjustment  — reduce confidence 20pts for COL home games
 *  2. Model anomaly flag      — warn when edgePct > 15%
 *  3. Minimum confidence gate — drop picks below 40
 */
function applyPickFilters(picks) {
  return picks
    .map(pick => {
      const adjusted = { ...pick };

      // 1. Coors Field adjustment
      if (adjusted.homeTeam === "Colorado Rockies") {
        adjusted.confidence = Math.max(0, adjusted.confidence - 20);
        adjusted.note = "Coors Field effect — inflated run environment, model may overestimate edge";
      }

      // 2. Model anomaly flag for suspiciously high edge
      if (adjusted.edgePct > 15) {
        adjusted.warning = "MODEL ANOMALY - verify before tracking";
      }

      return adjusted;
    })
    // 3. Minimum confidence threshold
    .filter(pick => pick.confidence >= 40);
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

    const picks = applyPickFilters(analyzePicks(games));

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

const OPERATIONS_WALLET = "5r2Pz7A3EYsvSZrusoWwkEiaMWcMXUEn9CAxc8p1qDrB";
const PRIZE_POOL_WALLET = "ATjh5UUu8bof58mGRECHcZdYGVxYLVKvxAR3Nhy6vUWv";
const PRIZE_POOL_ENABLED = false; // Toggle to true when legal clears

// Split config - easy to update
const SPLIT_CONFIG = {
  operations: 0.80,   // 80% to operations
  prizePool: 0.00,    // 0% until enabled
  treasury: 0.20,     // 20% stays in revenue wallet as treasury
};

// When PRIZE_POOL_ENABLED is true use this split instead:
// operations: 0.70
// prizePool: 0.20
// treasury: 0.10

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

// ─── WALLET SPLIT ────────────────────────────────────────────────────────────

/**
 * splitPayment(amountSol, payerWallet)
 * Best-effort: splits an incoming SOL payment from REVENUE_WALLET to configured destinations.
 * Treasury portion stays in REVENUE_WALLET (no transfer needed).
 * Requires REVENUE_WALLET_PRIVATE_KEY env var (base58 encoded).
 */
async function splitPayment(amountSol, payerWallet) {
  try {
    const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction } = require("@solana/web3.js");
    const bs58 = require("bs58");

    const privateKeyEnv = process.env.REVENUE_WALLET_PRIVATE_KEY;
    if (!privateKeyEnv) {
      console.warn("⚠️  REVENUE_WALLET_PRIVATE_KEY not set — skipping split");
      return;
    }

    const connection = new Connection(SOLANA_RPC, "confirmed");
    const revenueKeypair = Keypair.fromSecretKey(bs58.decode(privateKeyEnv));

    const activeSplit = PRIZE_POOL_ENABLED
      ? { operations: 0.70, prizePool: 0.20, treasury: 0.10 }
      : SPLIT_CONFIG;

    const LAMPORTS = 1_000_000_000;
    const operationsLamports = Math.floor(amountSol * activeSplit.operations * LAMPORTS);
    const prizePoolLamports  = Math.floor(amountSol * activeSplit.prizePool  * LAMPORTS);
    const treasuryLamports   = Math.floor(amountSol * activeSplit.treasury   * LAMPORTS);

    console.log(`💸 Split for ${payerWallet} — ${amountSol} SOL:`);
    console.log(`   Operations (${(activeSplit.operations * 100).toFixed(0)}%): ${operationsLamports / LAMPORTS} SOL → ${OPERATIONS_WALLET}`);
    if (PRIZE_POOL_ENABLED) {
      console.log(`   Prize Pool (${(activeSplit.prizePool * 100).toFixed(0)}%): ${prizePoolLamports / LAMPORTS} SOL → ${PRIZE_POOL_WALLET}`);
    } else {
      console.log(`   Prize Pool: DISABLED (0 SOL)`);
    }
    console.log(`   Treasury  (${(activeSplit.treasury * 100).toFixed(0)}%): ${treasuryLamports / LAMPORTS} SOL stays in revenue wallet`);

    const instructions = [];

    // Operations transfer
    if (operationsLamports > 0) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: revenueKeypair.publicKey,
          toPubkey: new PublicKey(OPERATIONS_WALLET),
          lamports: operationsLamports,
        })
      );
    }

    // Prize pool transfer — only when enabled
    if (PRIZE_POOL_ENABLED && prizePoolLamports > 0) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: revenueKeypair.publicKey,
          toPubkey: new PublicKey(PRIZE_POOL_WALLET),
          lamports: prizePoolLamports,
        })
      );
    }

    if (instructions.length === 0) {
      console.log("   No transfers to execute.");
      return;
    }

    const tx = new Transaction().add(...instructions);
    const sig = await sendAndConfirmTransaction(connection, tx, [revenueKeypair]);
    console.log(`   ✅ Split tx confirmed: ${sig}`);

  } catch (err) {
    // Best-effort — log but never block premium access
    console.error("❌ splitPayment error (non-blocking):", err.message);
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
      picks = games?.length ? applyPickFilters(analyzePicks(games)) : [];
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
      // Best-effort split — runs async, never blocks the response
      splitPayment(payment.amount, wallet);
    }

    let picks = [];
    if (isCacheValid(cache.picks)) {
      picks = cache.picks.data?.picks || [];
    } else {
      const { games } = await fetchMLBOdds();
      picks = games?.length ? applyPickFilters(analyzePicks(games)) : [];
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




// ─── STRIKEOUT PROPS ROUTE ───────────────────────────────────────────────────

/**
 * GET /api/props/strikeouts
 * Returns today's best strikeout prop opportunities
 * Uses Claude Opus + Baseball Savant data
 * Cached once per day
 */
app.get("/api/props/strikeouts", async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Return cache if valid
    if (cache.strikeouts.data && cache.strikeouts.date === today) {
      return res.json({ ...cache.strikeouts.data, cached: true });
    }

    // Get raw games
    let games = [];
    try {
      if (isCacheValid(cache.raw)) {
        games = cache.raw.data || [];
      } else {
        const { games: rawGames } = await fetchMLBOdds();
        games = rawGames || [];
        cache.raw = { data: games, fetchedAt: Date.now() };
      }
    } catch (oddsErr) {
      console.error('Odds fetch error:', oddsErr.message);
    }

    if (games.length === 0) {
      const result = {
        props: [],
        dailySummary: 'No MLB games available today. Check back on Opening Day March 25th.',
        cached: false,
      };
      cache.strikeouts = { data: result, date: today };
      return res.json(result);
    }

    // Get enriched data (pitcher stats + Savant) — with fallback
    let enrichedData = {};
    try {
      const { enrichPicks } = require("./mlbDataEnricher");
      enrichedData = await enrichPicks([]);
    } catch (enrichErr) {
      console.error('Enrichment error:', enrichErr.message);
      enrichedData = {};
    }

    // Run strikeout agent
    console.log('⚾ Running Strikeout Agent...');
    const result = await getStrikeoutProps(games, enrichedData);

    cache.strikeouts = { data: result, date: today };
    res.json({ ...result, cached: false, fetchedAt: new Date().toISOString() });

  } catch (err) {
    console.error("❌ /api/props/strikeouts error:", err.message);
    // Return empty instead of 500 so UI shows gracefully
    res.json({
      props: [],
      dailySummary: 'Strikeout analysis unavailable right now. Check back soon.',
      error: err.message,
      cached: false,
    });
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

// ─── SPLIT CONFIG ENDPOINT ───────────────────────────────────────────────────

/**
 * GET /api/admin/split-config
 * Returns current split configuration and prize pool status.
 * Protected by admin secret.
 */
app.get("/api/admin/split-config", (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({
    prizePoolEnabled: PRIZE_POOL_ENABLED,
    activeSplit: PRIZE_POOL_ENABLED
      ? { operations: 0.70, prizePool: 0.20, treasury: 0.10 }
      : SPLIT_CONFIG,
    wallets: {
      operations: OPERATIONS_WALLET,
      prizePool: PRIZE_POOL_WALLET,
      treasury: REVENUE_WALLET,
    },
    note: PRIZE_POOL_ENABLED
      ? "Prize pool is ENABLED"
      : "Prize pool is DISABLED — set PRIZE_POOL_ENABLED=true in server.js and redeploy to enable",
  });
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

  // Season / Opening Day calculations
  const openingDay = new Date('2026-03-25T16:05:00-04:00');
  const nowDate = new Date();
  const msUntilOpening = openingDay - nowDate;
  const daysUntilOpening = Math.ceil(msUntilOpening / (1000 * 60 * 60 * 24));
  const seasonStarted = nowDate >= openingDay;
  const dataSource = seasonStarted ? 'Live (Supabase)' : 'Projections (pre-season)';

  // Next 6AM ET cron run
  const nextCron = new Date();
  nextCron.setTime(nextCron.getTime()); // mutable copy
  const etOffset = -4; // EDT
  const etHour = (nextCron.getUTCHours() + etOffset + 24) % 24;
  if (etHour >= 6) nextCron.setUTCDate(nextCron.getUTCDate() + 1);
  nextCron.setUTCHours(10, 0, 0, 0); // 6AM ET = 10AM UTC (EDT)
  const nextCronStr = nextCron.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // Overall system health
  const quotaOk = isNaN(parseInt(oddsQuota.remaining)) || parseInt(oddsQuota.remaining) > 150;
  const quotaLow = !isNaN(parseInt(oddsQuota.remaining)) && parseInt(oddsQuota.remaining) < 150;
  const allHealthy = quotaOk;
  const activeSplitPcts = PRIZE_POOL_ENABLED
    ? { ops: 70, pool: 20, treas: 10 }
    : { ops: Math.round(SPLIT_CONFIG.operations * 100), pool: Math.round(SPLIT_CONFIG.prizePool * 100), treas: Math.round(SPLIT_CONFIG.treasury * 100) };

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EdgeSKR Admin</title>
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Courier New', monospace;
    background: #080B10;
    color: #E8EDF5;
    padding: 28px 32px;
    min-height: 100vh;
    max-width: 1400px;
    margin: 0 auto;
  }

  /* ── HEADER ── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 2px solid #1E2A40;
    padding-bottom: 24px;
    margin-bottom: 36px;
    flex-wrap: wrap;
    gap: 16px;
  }
  .header-left { display: flex; flex-direction: column; gap: 6px; }
  .logo { font-size: 30px; letter-spacing: 5px; color: #00E5FF; font-weight: bold; }
  .subtitle { font-size: 11px; color: #5A6A85; letter-spacing: 3px; }
  .time { font-size: 13px; color: #8A9AB5; margin-top: 2px; }
  .status-pill {
    display: flex;
    align-items: center;
    gap: 10px;
    background: #0E1420;
    border: 1px solid #1E2A40;
    border-radius: 999px;
    padding: 10px 20px;
    font-size: 13px;
    font-weight: bold;
    letter-spacing: 1px;
  }
  .status-dot {
    width: 10px; height: 10px;
    border-radius: 50%;
    animation: pulse 2s infinite;
  }
  .status-dot.ok  { background: #00FF88; box-shadow: 0 0 8px #00FF88; }
  .status-dot.warn { background: #FF3A5C; box-shadow: 0 0 8px #FF3A5C; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }

  /* ── ALERT BANNER ── */
  .alert-banner {
    background: rgba(255,58,92,0.12);
    border: 1px solid #FF3A5C;
    border-radius: 10px;
    padding: 14px 20px;
    margin-bottom: 28px;
    font-size: 14px;
    color: #FF3A5C;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .alert-banner a { color: #FF7A95; text-decoration: underline; }

  /* ── SECTION LABEL ── */
  .section-label {
    font-size: 11px;
    letter-spacing: 3px;
    color: #5A6A85;
    text-transform: uppercase;
    margin: 36px 0 14px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .section-label::after {
    content: '';
    flex: 1;
    height: 1px;
    background: #1E2A40;
  }

  /* ── GRID ── */
  .grid-3 {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-bottom: 16px;
  }
  @media (max-width: 900px) { .grid-3 { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 600px) { .grid-3 { grid-template-columns: 1fr; } }

  /* ── CARD ── */
  .card {
    background: #0E1420;
    border: 1px solid #1E2A40;
    border-radius: 14px;
    padding: 22px 24px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .card-title {
    font-size: 10px;
    letter-spacing: 2.5px;
    color: #5A6A85;
    text-transform: uppercase;
  }
  .card-badge {
    font-size: 10px;
    padding: 3px 8px;
    border-radius: 999px;
    font-weight: bold;
    letter-spacing: 0.5px;
  }
  .badge-green { background: rgba(0,255,136,0.15); color: #00FF88; }
  .badge-red   { background: rgba(255,58,92,0.15);  color: #FF3A5C; }
  .badge-gold  { background: rgba(255,208,96,0.15); color: #FFD060; }
  .badge-sol   { background: rgba(153,69,255,0.15); color: #9945FF; }
  .badge-cyan  { background: rgba(0,229,255,0.15);  color: #00E5FF; }

  .card.t-cyan  { border-top: 2px solid #00E5FF; }
  .card.t-green { border-top: 2px solid #00FF88; }
  .card.t-gold  { border-top: 2px solid #FFD060; }
  .card.t-sol   { border-top: 2px solid #9945FF; }
  .card.t-red   { border-top: 2px solid #FF3A5C; }
  .card.t-blue  { border-top: 2px solid #4A90E2; }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 9px 0;
    border-bottom: 1px solid #0D1525;
    font-size: 13.5px;
    gap: 8px;
  }
  .row:last-child { border-bottom: none; padding-bottom: 0; }
  .row-label { color: #6A7A95; flex-shrink: 0; }
  .row-value { font-weight: bold; text-align: right; }

  /* ── COLORS ── */
  .c-green { color: #00FF88; }
  .c-cyan  { color: #00E5FF; }
  .c-gold  { color: #FFD060; }
  .c-red   { color: #FF3A5C; }
  .c-sol   { color: #9945FF; }
  .c-white { color: #E8EDF5; }
  .c-muted { color: #8A9AB5; }
  .c-blue  { color: #4A90E2; }

  /* ── ACTIONS ── */
  .actions-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 10px;
  }
  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    background: #0E1420;
    border: 1px solid #1E2A40;
    border-radius: 10px;
    color: #C8D4E8;
    font-family: monospace;
    font-size: 12.5px;
    font-weight: bold;
    letter-spacing: 0.5px;
    padding: 11px 16px;
    cursor: pointer;
    text-decoration: none;
    transition: all 0.18s;
    white-space: nowrap;
  }
  .btn:hover       { border-color: #00E5FF; color: #00E5FF; background: rgba(0,229,255,0.06); }
  .btn.danger:hover{ border-color: #FF3A5C; color: #FF3A5C; background: rgba(255,58,92,0.06); }
  .btn.primary     { border-color: #00E5FF; color: #00E5FF; }

  /* ── PICK RESULT FORM ── */
  .result-panel {
    background: #0E1420;
    border: 1px solid #1E2A40;
    border-radius: 14px;
    padding: 24px;
  }
  .result-panel label {
    display: block;
    font-size: 11px;
    letter-spacing: 1.5px;
    color: #5A6A85;
    text-transform: uppercase;
    margin-bottom: 6px;
  }
  .result-panel input,
  .result-panel select {
    background: #141C2E;
    border: 1px solid #1E2A40;
    border-radius: 8px;
    color: #E8EDF5;
    font-family: monospace;
    font-size: 13px;
    padding: 10px 14px;
    width: 100%;
    outline: none;
    transition: border-color 0.2s;
  }
  .result-panel input:focus,
  .result-panel select:focus { border-color: #00E5FF; }
  .result-fields {
    display: grid;
    grid-template-columns: 1fr 160px auto;
    gap: 12px;
    align-items: end;
  }
  @media (max-width: 600px) { .result-fields { grid-template-columns: 1fr; } }
  .result-panel .field { display: flex; flex-direction: column; gap: 6px; }
  .submit-btn {
    background: linear-gradient(135deg, #00E5FF, #7B61FF);
    border: none;
    border-radius: 8px;
    color: #080B10;
    font-family: monospace;
    font-size: 13px;
    font-weight: bold;
    padding: 10px 20px;
    cursor: pointer;
    transition: opacity 0.2s;
    letter-spacing: 0.5px;
    white-space: nowrap;
  }
  .submit-btn:hover { opacity: 0.85; }
  #updateMsg {
    margin-top: 12px;
    font-size: 13px;
    display: none;
  }

  /* ── CHECKLIST ── */
  .checklist {
    background: #0E1420;
    border: 1px solid #1E2A40;
    border-radius: 14px;
    overflow: hidden;
  }
  .check-item {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 24px;
    border-bottom: 1px solid #0D1525;
    font-size: 13.5px;
  }
  .check-item:last-child { border-bottom: none; }
  .check-icon { font-size: 17px; flex-shrink: 0; }
  .check-text { color: #8A9AB5; flex: 1; }
  .check-link { font-size: 11px; color: #00E5FF; text-decoration: none; flex-shrink: 0; }
  .check-link:hover { text-decoration: underline; }

  code {
    background: #141C2E;
    padding: 2px 7px;
    border-radius: 4px;
    color: #00E5FF;
    font-size: 11px;
  }
</style>
</head>
<body>

<!-- ═══════════════ HEADER ═══════════════ -->
<div class="header">
  <div class="header-left">
    <div class="logo">EDGESKR ADMIN</div>
    <div class="subtitle">BACKEND DASHBOARD · RESTRICTED ACCESS</div>
    <div class="time">🕐 ${now} ET &nbsp;·&nbsp; Uptime: ${uptime} min</div>
  </div>
  <div class="status-pill">
    <div class="status-dot ${allHealthy ? 'ok' : 'warn'}"></div>
    <span class="${allHealthy ? 'c-green' : 'c-red'}">${allHealthy ? 'ALL SYSTEMS OK' : 'NEEDS ATTENTION'}</span>
  </div>
</div>

${quotaLow ? `<!-- QUOTA ALERT -->
<div class="alert-banner">
  ⚠️ &nbsp;<strong>ODDS API QUOTA LOW</strong> — ${oddsQuota.remaining} requests remaining this month.
  &nbsp;<a href="https://the-odds-api.com" target="_blank">Upgrade at the-odds-api.com →</a>
</div>` : ''}

<!-- ═══════════════ ROW 1: ODDS · DB · AI ═══════════════ -->
<div class="section-label">System Status</div>
<div class="grid-3">

  <div class="card t-cyan">
    <div class="card-header">
      <span class="card-title">Odds API</span>
      <span class="card-badge ${parseInt(oddsQuota.remaining) > 150 ? 'badge-green' : 'badge-red'}">${parseInt(oddsQuota.remaining) > 150 ? 'HEALTHY' : 'LOW'}</span>
    </div>
    <div class="row"><span class="row-label">Remaining</span><span class="row-value c-cyan">${oddsQuota.remaining}</span></div>
    <div class="row"><span class="row-label">Used this month</span><span class="row-value c-white">${oddsQuota.used}</span></div>
    <div class="row"><span class="row-label">Monthly limit</span><span class="row-value c-muted">500 (free tier)</span></div>
    <div class="row"><span class="row-label">Resets</span><span class="row-value c-muted">1st of month</span></div>
  </div>

  <div class="card t-green">
    <div class="card-header">
      <span class="card-title">Database</span>
      <span class="card-badge badge-green">CONNECTED</span>
    </div>
    <div class="row"><span class="row-label">Total users</span><span class="row-value c-green">${dbStats.users}</span></div>
    <div class="row"><span class="row-label">Total picks logged</span><span class="row-value c-white">${dbStats.bets}</span></div>
    <div class="row"><span class="row-label">Provider</span><span class="row-value c-muted">Supabase</span></div>
    <div class="row"><span class="row-label">Free tier limit</span><span class="row-value c-muted">500 MB</span></div>
  </div>

  <div class="card t-gold">
    <div class="card-header">
      <span class="card-title">AI Agent</span>
      <span class="card-badge badge-gold">CACHED</span>
    </div>
    <div class="row"><span class="row-label">Free model</span><span class="row-value c-white">claude-sonnet</span></div>
    <div class="row"><span class="row-label">Premium model</span><span class="row-value c-white">claude-opus</span></div>
    <div class="row"><span class="row-label">Free pick cost</span><span class="row-value c-gold">~$0.003</span></div>
    <div class="row"><span class="row-label">Premium pick cost</span><span class="row-value c-gold">~$0.015</span></div>
    <div class="row"><span class="row-label">Cache strategy</span><span class="row-value c-green">Daily (1×/day)</span></div>
  </div>

</div>

<!-- ═══════════════ ROW 2: SERVER · SPLIT · SEASON ═══════════════ -->
<div class="grid-3">

  <div class="card t-sol">
    <div class="card-header">
      <span class="card-title">Server</span>
      <span class="card-badge badge-sol">LIVE</span>
    </div>
    <div class="row"><span class="row-label">Environment</span><span class="row-value c-white">Vercel Production</span></div>
    <div class="row"><span class="row-label">Uptime</span><span class="row-value c-green">${uptime} min</span></div>
    <div class="row"><span class="row-label">Node version</span><span class="row-value c-white">${process.version}</span></div>
    <div class="row"><span class="row-label">Heap used</span><span class="row-value c-white">${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB</span></div>
    <div class="row"><span class="row-label">Platform</span><span class="row-value c-muted">linux/x64</span></div>
  </div>

  <div class="card t-sol">
    <div class="card-header">
      <span class="card-title">Wallet Split</span>
      <span class="card-badge ${PRIZE_POOL_ENABLED ? 'badge-green' : 'badge-red'}">${PRIZE_POOL_ENABLED ? 'POOL ON' : 'POOL OFF'}</span>
    </div>
    <div class="row"><span class="row-label">Prize Pool</span><span class="row-value ${PRIZE_POOL_ENABLED ? 'c-green' : 'c-red'}">${PRIZE_POOL_ENABLED ? '✅ ENABLED' : '⛔ DISABLED'}</span></div>
    <div class="row"><span class="row-label">Operations</span><span class="row-value c-sol">${activeSplitPcts.ops}%</span></div>
    <div class="row"><span class="row-label">Prize Pool</span><span class="row-value c-sol">${activeSplitPcts.pool}%</span></div>
    <div class="row"><span class="row-label">Treasury</span><span class="row-value c-sol">${activeSplitPcts.treas}%</span></div>
    <div class="row"><span class="row-label" style="font-size:11px;color:#3A4A65">Set <code>PRIZE_POOL_ENABLED=true</code> + redeploy to enable</span><span></span></div>
  </div>

  <div class="card t-blue">
    <div class="card-header">
      <span class="card-title">Season Status</span>
      <span class="card-badge ${seasonStarted ? 'badge-green' : 'badge-gold'}">${seasonStarted ? 'IN SEASON' : 'PRE-SEASON'}</span>
    </div>
    <div class="row"><span class="row-label">Season</span><span class="row-value c-white">2026 MLB</span></div>
    <div class="row"><span class="row-label">Opening Day</span><span class="row-value c-cyan">March 25, 2026</span></div>
    <div class="row"><span class="row-label">${seasonStarted ? 'Season started' : 'Days until opening'}</span><span class="row-value ${seasonStarted ? 'c-green' : 'c-gold'}">${seasonStarted ? '✅ Active' : daysUntilOpening + ' days'}</span></div>
    <div class="row"><span class="row-label">Data source</span><span class="row-value ${seasonStarted ? 'c-green' : 'c-gold'}">${dataSource}</span></div>
    <div class="row"><span class="row-label">Next cron run</span><span class="row-value c-muted">${nextCronStr} ET</span></div>
  </div>

</div>

<!-- ═══════════════ QUICK ACTIONS ═══════════════ -->
<div class="section-label">Quick Actions</div>
<div class="actions-grid">
  <a class="btn primary" href="/api/health" target="_blank">🔍 Health Check</a>
  <a class="btn" href="/api/picks" target="_blank">⚡ View Picks</a>
  <a class="btn" href="/api/agent/premium?wallet=8YPA4TV2rKkFdeJwvhQZPm6CNMNAm9sjP98p3DZSEgcL" target="_blank">🤖 Test Premium Agent</a>
  <a class="btn" href="/api/quota" target="_blank">📊 API Quota</a>
  <a class="btn" href="/api/accuracy" target="_blank">🎯 Accuracy Stats</a>
  <a class="btn" href="/api/leaderboard" target="_blank">🏆 Leaderboard</a>
  <a class="btn" href="/api/elo" target="_blank">📈 Elo Ratings</a>
  <a class="btn" href="/api/admin/split-config?secret=${secret}" target="_blank">💸 Split Config</a>
  <a class="btn" href="https://edge-seeker.vercel.app" target="_blank">🌐 View Live App</a>
  <a class="btn" href="/api/cron/update-stats?secret=${secret}" target="_blank">⚾ Run Stats Update</a>
  <a class="btn danger" href="/admin/refresh-agent?secret=${secret}" target="_blank">🔄 Refresh Agent Cache</a>
</div>

<!-- ═══════════════ UPDATE PICK RESULTS ═══════════════ -->
<div class="section-label">Update Pick Results</div>
<div class="result-panel">
  <p style="font-size:13px;color:#6A7A95;margin-bottom:20px">Mark a pick as Win / Loss / Push after the game resolves. Find the pick ID from <a href="/api/accuracy" target="_blank" style="color:#00E5FF">/api/accuracy</a>.</p>
  <div class="result-fields">
    <div class="field">
      <label>Pick ID</label>
      <input id="pickId" placeholder="e.g. 42" />
    </div>
    <div class="field">
      <label>Result</label>
      <select id="pickResult">
        <option value="win">WIN ✓</option>
        <option value="loss">LOSS ✗</option>
        <option value="push">PUSH ~</option>
        <option value="void">VOID</option>
      </select>
    </div>
    <div class="field">
      <label>&nbsp;</label>
      <button class="submit-btn" onclick="updateResult()">UPDATE</button>
    </div>
  </div>
  <div id="updateMsg"></div>
</div>

<script>
async function updateResult() {
  const id = document.getElementById('pickId').value.trim();
  const result = document.getElementById('pickResult').value;
  if (!id) { alert('Enter a pick ID'); return; }
  const res = await fetch('/api/accuracy/result/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: '${secret}', result })
  });
  const data = await res.json();
  const msg = document.getElementById('updateMsg');
  msg.style.display = 'block';
  msg.style.color = res.ok ? '#00FF88' : '#FF3A5C';
  msg.textContent = res.ok ? '✅ Pick #' + id + ' updated to ' + result.toUpperCase() : '❌ Error: ' + data.error;
  setTimeout(() => { msg.style.display = 'none'; }, 4000);
}
</script>

<!-- ═══════════════ MAINTENANCE CHECKLIST ═══════════════ -->
<div class="section-label">Monthly Maintenance</div>
<div class="checklist">
  <div class="check-item">
    <div class="check-icon">📊</div>
    <div class="check-text">Check Odds API quota — upgrade if below 100 remaining</div>
    <a class="check-link" href="https://the-odds-api.com" target="_blank">the-odds-api.com →</a>
  </div>
  <div class="check-item">
    <div class="check-icon">🤖</div>
    <div class="check-text">Check Anthropic credit balance</div>
    <a class="check-link" href="https://console.anthropic.com/settings/billing" target="_blank">console.anthropic.com →</a>
  </div>
  <div class="check-item">
    <div class="check-icon">⚾</div>
    <div class="check-text">Update mlbStats.js with real team run averages once season starts</div>
    <a class="check-link" href="https://baseball-reference.com/leagues/majors/2026.shtml" target="_blank">baseball-reference.com →</a>
  </div>
  <div class="check-item">
    <div class="check-icon">🗄️</div>
    <div class="check-text">Check Supabase database size — free tier limit is 500 MB</div>
    <a class="check-link" href="https://supabase.com/dashboard" target="_blank">supabase.com →</a>
  </div>
  <div class="check-item">
    <div class="check-icon">🚀</div>
    <div class="check-text">Review Vercel deployment logs and function usage</div>
    <a class="check-link" href="https://vercel.com/dashboard" target="_blank">vercel.com →</a>
  </div>
  <div class="check-item">
    <div class="check-icon">🔐</div>
    <div class="check-text">Dashboard protected by <code>ADMIN_SECRET</code> env var. Access: <code>/admin?secret=YOUR_SECRET</code></div>
  </div>
</div>

<div style="height:48px"></div>
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

// ─── HTML ROUTES (permanent — do not remove) ─────────────────────────────────

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
