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
const { analyzePicks, applyInjuryPenalty, applyEloAdjustment, applySharpMoneySignal } = require("./edgeAnalyzer");
const { getEnrichedCache } = require("./mlbDataEnricher");
const { calculateBetPoints, getAccuracyBonus } = require("./pointsConfig");
const { getFreePick, getPremiumPick, invalidateCache } = require("./agentRouter");
const { getStrikeoutProps } = require("./strikeoutAgent");
const { updateMLBStats } = require("./cron");
const {
  getUser, upsertUser,
  saveBet, getUserBets, updateBetResult,
  getPoints, addPoints,
  getLeaderboard,
  getDailyPicks,
} = require("./supabase");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ODDS_API_KEY;
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// ─── FEATURE FLAGS ────────────────────────────────────────────────────────────
const ODDS_API_UPGRADED = false; // Set to true when on paid plan for historical odds + all sharp books

// ─── INPUT VALIDATORS ─────────────────────────────────────────────────────────

// Solana wallet addresses are base58, 32-44 characters
const WALLET_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Date format YYYY-MM-DD
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Valid bet results
const VALID_RESULTS = ['win', 'loss', 'push', 'void', 'pending'];

// Valid leaderboard types
const VALID_LEADERBOARD_TYPES = ['all_time', 'monthly', 'weekly'];

function isValidWallet(wallet) {
  return typeof wallet === 'string' && WALLET_REGEX.test(wallet);
}

function isValidDate(date) {
  return typeof date === 'string' && DATE_REGEX.test(date);
}

function isValidId(id) {
  return !isNaN(parseInt(id)) && parseInt(id) > 0;
}

function isValidAmount(amount) {
  const n = parseFloat(amount);
  return !isNaN(n) && n > 0 && n < 1000000;
}

function sanitizeString(str, maxLength = 100) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'`;]/g, '').trim().slice(0, maxLength);
}

// ─────────────────────────────────────────────────────────────────────────────

// ─── TIER DEFINITIONS ─────────────────────────────────────────────────────────
const FREE_TIER_LAYERS = ['poisson', 'parkFactors', 'elo', 'oddsMovement'];
const PREMIUM_LAYERS = ['poisson', 'parkFactors', 'elo', 'oddsMovement', 'fip', 'fatigue', 'injuries', 'pinnacle', 'bullpen', 'weather', 'fanGraphs', 'statcast'];

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(__dirname));
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

// ─── AGENT AUTO-RUN CONFIG ────────────────────────────────────────────────────
const AGENT_AUTO_RUN_TIME = 11; // 11 AM ET daily — agent fires automatically

// Tracks agent auto-run state across requests (module-level, lives for server uptime)
const agentAutoRun = {
  lastRun: null,      // YYYY-MM-DD of last successful run
  lastRunTime: null,  // Human-readable time string
  status: 'ready',   // 'ready' | 'running' | 'failed'
};

// ─── SIMPLE IN-MEMORY CACHE ──────────────────────────────────────────────────
const cache = {
  picks: { data: null, fetchedAt: null },
  raw: { data: null, fetchedAt: null },
  strikeouts: { data: null, date: null },
};

// ─── CACHE BYPASS FLAG ────────────────────────────────────────────────────────
// When true, /api/picks skips all cache logic and always hits the Odds API fresh.
// Toggle via POST /api/admin/cache-bypass — disable when done to conserve quota.
let CACHE_BYPASS = false;
// ─── SCHEDULE-AWARE CACHE ─────────────────────────────────────────────────────
// Picks cache refreshes exactly twice daily at 11AM ET and 5PM ET.
// All other requests serve cached data — zero extra API calls between windows.
const REFRESH_HOURS_ET = [11, 17]; // 11:00 AM ET and 5:00 PM ET

function getETOffset() {
  // MLB season March–November → EDT (UTC-4); otherwise EST (UTC-5)
  const month = new Date().getUTCMonth() + 1;
  return (month >= 3 && month <= 11) ? -4 : -5;
}

/**
 * Returns the most recent and the next scheduled refresh time as UTC Date objects.
 */
function getScheduledTimes() {
  const now = new Date();
  const etOff = getETOffset() * 60 * 60 * 1000;
  // Find midnight ET in UTC terms for "today" in ET
  const nowET = new Date(now.getTime() + etOff);
  const etMidnightUTC = Date.UTC(nowET.getUTCFullYear(), nowET.getUTCMonth(), nowET.getUTCDate()) - etOff;

  // Build refresh timestamps for yesterday, today, and tomorrow
  const refreshes = [];
  for (let day = -1; day <= 1; day++) {
    for (const h of REFRESH_HOURS_ET) {
      refreshes.push(new Date(etMidnightUTC + day * 86400000 + h * 3600000));
    }
  }
  refreshes.sort((a, b) => a - b);

  const lastRefresh = refreshes.filter(t => t <= now).pop() || null;
  const nextRefresh = refreshes.find(t => t > now) || null;
  return { lastRefresh, nextRefresh };
}

// ─── OPENING ODDS TRACKER (Feature 4 — Odds Movement) ────────────────────────
// Tracks first-seen odds per pick per day to detect line movement
const openingOddsMap = {}; // key: `${teamAbbr}_${date}` → American odds string

function computeMovement(currentOdds, openingOdds) {
  const cur = parseInt(currentOdds);
  const open = parseInt(openingOdds);
  if (isNaN(cur) || isNaN(open)) return 'stable';
  if (Math.abs(cur - open) < 5) return 'stable';
  if (cur < 0 && open < 0) return Math.abs(cur) > Math.abs(open) ? 'moved_toward' : 'moved_against';
  if (cur > 0 && open > 0) return cur < open ? 'moved_toward' : 'moved_against';
  return 'stable';
}

function addOddsMovement(picks) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return picks.map(pick => {
    const key = `${pick.teamAbbr}_${today}`;
    const opening = openingOddsMap[key];
    if (!opening) {
      openingOddsMap[key] = pick.bookOddsAmerican;
      return { ...pick, movement: 'stable' };
    }
    const movement = computeMovement(pick.bookOddsAmerican, opening);
    const out = { ...pick, movement };
    if (movement === 'moved_against') out.confidence = Math.max(0, (out.confidence || 0) - 10);
    return out;
  });
}

// Strip premium-only fields from picks — free tier response only
function stripToFreeTier(picks) {
  return picks.map(pick => {
    const {
      homePitcherFIP, awayPitcherFIP, pitcherAdjustment,
      homePitcherFatigue, awayPitcherFatigue, fatigueNote,
      bullpenAdjustment, weatherAdjustment,
      pinnacleMovement, sharpMoneyNote,
      ...freePick
    } = pick;
    return {
      ...freePick,
      upgradeAvailable: true,
      upgradeNote: "Premium analysis includes FIP, bullpen, sharp money, fatigue and weather signals",
    };
  });
}

// ─── GAME WINDOW + GRADE SYSTEM ───────────────────────────────────────────────

function getGameAnalysisStatus(commenceTime) {
  const now = new Date();
  const gameTime = new Date(commenceTime);
  const minutesUntilGame = (gameTime - now) / (1000 * 60);
  const hoursUntilGame = minutesUntilGame / 60;

  if (minutesUntilGame < -15) {
    return { status: 'completed', hoursUntilGame, label: 'COMPLETED', maxGrade: 'PASS', message: 'Game has started or concluded' };
  }
  if (minutesUntilGame < 15) {
    return { status: 'in_progress', hoursUntilGame, label: 'IN PROGRESS', maxGrade: 'PASS', message: 'Game is currently in progress' };
  }
  if (minutesUntilGame <= 60) {
    return { status: 'final_window', hoursUntilGame, label: 'FINAL CALL', maxGrade: 'A', message: 'Final analysis — verify no late scratches' };
  }
  if (hoursUntilGame <= 3) {
    return { status: 'prime_window', hoursUntilGame, label: 'PRIME TIME', maxGrade: 'A', message: 'Optimal analysis window — lineups typically confirmed' };
  }
  if (hoursUntilGame <= 6) {
    return { status: 'analysis_window', hoursUntilGame, label: 'EARLY LOOK', maxGrade: 'B', message: 'Early analysis — lineups may not be confirmed yet' };
  }
  return { status: 'too_early', hoursUntilGame, label: 'TOO EARLY', maxGrade: 'C', message: 'Check back closer to first pitch for confirmed lineups' };
}

function getPitcherConfirmationStatus(homePitcherName, awayPitcherName) {
  const isTBD = n => !n || n.trim() === '' || n.trim().toUpperCase() === 'TBD';
  const homeTBD = isTBD(homePitcherName);
  const awayTBD = isTBD(awayPitcherName);
  if (!homeTBD && !awayTBD) {
    return { status: 'both_confirmed', gradeImpact: 0, confidenceImpact: 0, label: '✓ PITCHERS CONFIRMED', message: 'Both starting pitchers confirmed' };
  }
  if (homeTBD && awayTBD) {
    return { status: 'both_tbd', gradeImpact: -2, confidenceImpact: -20, label: '⚠ PITCHERS TBD', message: 'Starting pitchers not yet announced' };
  }
  return { status: 'one_confirmed', gradeImpact: -1, confidenceImpact: -10, label: '⚠ ONE PITCHER TBD', message: 'One starting pitcher not yet confirmed' };
}

function calculatePickGrade(confidence, windowMaxGrade, pitcherGradeImpact) {
  const gradeOrder = { A: 3, B: 2, C: 1, PASS: 0 };
  const grades = ['PASS', 'C', 'B', 'A'];
  let idx = confidence >= 70 ? 3 : confidence >= 55 ? 2 : confidence >= 40 ? 1 : 0;
  if (idx === 0) return 'PASS';
  idx = Math.min(idx, gradeOrder[windowMaxGrade] ?? 3);
  idx = Math.max(0, idx + (pitcherGradeImpact || 0));
  return grades[idx] || 'PASS';
}

// Applies window status + deterministic grade. Filters out in_progress/completed.
// withPitcher=true applies pitcher confirmation penalty (premium only).
function applyWindowAndGrade(picks, withPitcher = false) {
  return picks
    .map(pick => {
      const ws = getGameAnalysisStatus(pick.gameTime);
      const ps = withPitcher
        ? getPitcherConfirmationStatus(pick.homePitcherName, pick.awayPitcherName)
        : { status: 'unknown', gradeImpact: 0, confidenceImpact: 0, label: '', message: '' };

      const adjustedConf = withPitcher
        ? Math.max(0, pick.confidence + ps.confidenceImpact)
        : pick.confidence;

      const grade = calculatePickGrade(adjustedConf, ws.maxGrade, withPitcher ? ps.gradeImpact : 0);

      return {
        ...pick,
        confidence: adjustedConf,
        grade,
        windowStatus: ws.status,
        windowLabel: ws.label,
        hoursUntilGame: Math.round(ws.hoursUntilGame * 10) / 10,
        windowMessage: ws.message,
        ...(withPitcher ? {
          pitcherStatus: ps.status,
          pitcherStatusLabel: ps.label,
          pitcherMessage: ps.message,
        } : {}),
      };
    })
    .filter(p => p.windowStatus !== 'in_progress' && p.windowStatus !== 'completed');
}

// ─── TEAM ABBREVIATION HELPER (server-side) ──────────────────────────────────
function getTeamAbbrServer(fullName) {
  const map = {
    "New York Yankees":"NYY","Boston Red Sox":"BOS","Toronto Blue Jays":"TOR",
    "Tampa Bay Rays":"TB","Baltimore Orioles":"BAL","Cleveland Guardians":"CLE",
    "Minnesota Twins":"MIN","Chicago White Sox":"CWS","Kansas City Royals":"KC",
    "Detroit Tigers":"DET","Houston Astros":"HOU","Texas Rangers":"TEX",
    "Seattle Mariners":"SEA","Oakland Athletics":"OAK","Los Angeles Angels":"LAA",
    "Atlanta Braves":"ATL","New York Mets":"NYM","Philadelphia Phillies":"PHI",
    "Miami Marlins":"MIA","Washington Nationals":"WSH","Chicago Cubs":"CHC",
    "Milwaukee Brewers":"MIL","St. Louis Cardinals":"STL","Cincinnati Reds":"CIN",
    "Pittsburgh Pirates":"PIT","Los Angeles Dodgers":"LAD","San Francisco Giants":"SF",
    "San Diego Padres":"SD","Arizona Diamondbacks":"ARI","Colorado Rockies":"COL",
  };
  return map[fullName] || (fullName || '').split(' ').pop().slice(0, 3).toUpperCase();
}

/**
 * Cache is valid if it was populated after the most recent scheduled refresh window.
 * Forces fresh data only at 11AM ET and 5PM ET; serves cache at all other times.
 */
function isCacheValid(entry) {
  if (!entry.data || !entry.fetchedAt) return false;
  const { lastRefresh } = getScheduledTimes();
  if (!lastRefresh) return true; // No scheduled window has passed yet today
  return entry.fetchedAt > lastRefresh.getTime();
}

// ─── TIME-BASED PICKS CACHE ──────────────────────────────────────────────────
// Separate TTL-based cache validity for /api/picks — more conservative than the
// schedule-based isCacheValid, designed to reduce Odds API quota consumption.
function getPicksCacheDuration() {
  const etOff = getETOffset() * 60 * 60 * 1000;
  const hourET = new Date(Date.now() + etOff).getUTCHours();
  if (hourET >= 6  && hourET < 10) return 2  * 60 * 60 * 1000; // 2h  — pre-game research
  if (hourET >= 10 && hourET < 19) return 30 * 60 * 1000;      // 30m — active game day
  return 4 * 60 * 60 * 1000;                                    // 4h  — overnight
}

function isPicksCacheValid() {
  const { data, fetchedAt } = cache.picks;
  if (!data || !fetchedAt) return false;
  return Date.now() - fetchedAt < getPicksCacheDuration();
}

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────
// If the same IP hits /api/picks more than 3× in 10 min, serve cache regardless of age.
const ipRequestLog = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_HITS  = 3;

function checkRateLimit(ip) {
  const now  = Date.now();
  const prev = (ipRequestLog.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  ipRequestLog.set(ip, [...prev, now]);
  return prev.length >= RATE_MAX_HITS; // true = over limit, serve cache
}

// ─── ODDS API HELPERS ────────────────────────────────────────────────────────

/**
 * Fetch today's MLB games with moneyline odds from The Odds API
 */
async function fetchMLBOdds() {
  const url = new URL(`${ODDS_API_BASE}/sports/baseball_mlb/odds`);
  url.searchParams.set("apiKey", API_KEY);
  url.searchParams.set("regions", "us");           // US sportsbooks
  url.searchParams.set("markets", "h2h,totals");   // moneyline + over/under
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

// ─── PINNACLE LINE MOVEMENT TRACKER ──────────────────────────────────────────

/**
 * storeOpeningLines(games)
 * Called after every fresh Odds API fetch (not from cache).
 * For each game, extracts Pinnacle odds (+ DraftKings/FanDuel as reference books)
 * and upserts into Supabase with ON CONFLICT DO NOTHING — preserves true opening line.
 */
async function storeOpeningLines(games) {
  if (!games || games.length === 0) return;
  const { supabaseQuery } = require('./supabase');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const rows = [];

  for (const game of games) {
    let pinnacleHome = null, pinnacleAway = null, pinnacleTotal = null;
    let dkHome = null, dkAway = null;
    let fdHome = null, fdAway = null;

    for (const bk of game.bookmakers || []) {
      const key = bk.key?.toLowerCase() || '';
      const ml = bk.markets?.find(m => m.key === 'h2h');
      const tot = bk.markets?.find(m => m.key === 'totals');

      const getHomeAway = (market) => {
        let h = null, a = null;
        for (const o of market?.outcomes || []) {
          if (o.name === game.home_team) h = o.price;
          if (o.name === game.away_team) a = o.price;
        }
        return { h, a };
      };

      if (key === 'pinnacle') {
        const { h, a } = getHomeAway(ml);
        pinnacleHome = h;
        pinnacleAway = a;
        const over = tot?.outcomes?.find(o => o.name === 'Over');
        if (over) pinnacleTotal = over.point;
      } else if (key === 'draftkings') {
        const { h, a } = getHomeAway(ml);
        dkHome = h; dkAway = a;
      } else if (key === 'fanduel') {
        const { h, a } = getHomeAway(ml);
        fdHome = h; fdAway = a;
      }
    }

    // Only store if we have at least Pinnacle or DK odds
    if (!pinnacleHome && !dkHome) continue;

    rows.push({
      game_id: game.id,
      home_team: game.home_team,
      away_team: game.away_team,
      game_date: today,
      pinnacle_home_odds: pinnacleHome,
      pinnacle_away_odds: pinnacleAway,
      pinnacle_total: pinnacleTotal,
      draftkings_home_odds: dkHome,
      draftkings_away_odds: dkAway,
      fanduel_home_odds: fdHome,
      fanduel_away_odds: fdAway,
      recorded_at: new Date().toISOString(),
    });
  }

  if (rows.length === 0) return;

  try {
    // POST with resolution=ignore-duplicates — stores opening line, ignores subsequent calls
    const url = `${process.env.SUPABASE_URL}/rest/v1/opening_lines`;
    const res = await require('node-fetch')(url, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    });
    if (res.ok) {
      console.log(`📌 Opening lines stored: ${rows.length} games (existing ignored)`);
    } else {
      const err = await res.text();
      console.warn(`⚠️ storeOpeningLines error: ${err}`);
    }
  } catch (err) {
    console.warn('⚠️ storeOpeningLines failed (non-blocking):', err.message);
  }
}

/**
 * analyzeLineMovement(currentGames)
 * Compares current Pinnacle odds to stored opening lines.
 * Returns movement objects for all games — used to generate sharpSignal per pick.
 *
 * When ODDS_API_UPGRADED = true, also tracks Circa/Bookmaker for triangulation.
 */
async function analyzeLineMovement(currentGames) {
  if (!currentGames || currentGames.length === 0) return [];
  const { supabaseQuery } = require('./supabase');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // Fetch all opening lines for today
  let openingLines = [];
  try {
    openingLines = await supabaseQuery('opening_lines', 'GET', null, `?game_date=eq.${today}`);
  } catch (err) {
    console.warn('⚠️ analyzeLineMovement: could not fetch opening lines:', err.message);
    return [];
  }

  if (!openingLines || openingLines.length === 0) return [];

  // Build lookup: game_id → opening line row
  const openingMap = {};
  for (const row of openingLines) {
    openingMap[row.game_id] = row;
  }

  const results = [];

  for (const game of currentGames) {
    const opening = openingMap[game.id];
    if (!opening) {
      results.push({ gameId: game.id, homeTeam: game.home_team, awayTeam: game.away_team, pinnacleMovement: null, totalMovement: null, openingHomeOdds: null, openingAwayOdds: null });
      continue;
    }

    // Find current Pinnacle odds
    let currPinnHome = null, currPinnAway = null, currPinnTotal = null;
    const sharpBooks = ODDS_API_UPGRADED
      ? ['pinnacle', 'circa', 'bookmaker']
      : ['pinnacle'];

    for (const bk of game.bookmakers || []) {
      const key = bk.key?.toLowerCase() || '';
      if (!sharpBooks.includes(key)) continue;
      const ml = bk.markets?.find(m => m.key === 'h2h');
      const tot = bk.markets?.find(m => m.key === 'totals');
      for (const o of ml?.outcomes || []) {
        if (o.name === game.home_team && !currPinnHome) currPinnHome = o.price;
        if (o.name === game.away_team && !currPinnAway) currPinnAway = o.price;
      }
      const over = tot?.outcomes?.find(o => o.name === 'Over');
      if (over && !currPinnTotal) currPinnTotal = over.point;
    }

    // No current Pinnacle → neutral
    if (!currPinnHome || !opening.pinnacle_home_odds) {
      results.push({
        gameId: game.id,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        pinnacleMovement: { homeOddsChange: 0, awayOddsChange: 0, direction: 'stable', magnitude: 'minimal', sharpSignal: 'neutral' },
        totalMovement: { change: 0, direction: 'stable' },
        openingHomeOdds: opening.pinnacle_home_odds,
        openingAwayOdds: opening.pinnacle_away_odds,
      });
      continue;
    }

    // Calculate American odds movement (decimal → American conversion)
    const decToAmer = (d) => d >= 2.0 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));

    const openHomeAmer = decToAmer(opening.pinnacle_home_odds);
    const openAwayAmer = decToAmer(opening.pinnacle_away_odds);
    const currHomeAmer = decToAmer(currPinnHome);
    const currAwayAmer = decToAmer(currPinnAway);

    // Change: positive = line improved (odds shortened = more likely to win = sharp action)
    // For favorites (negative): -130 → -140 means it got MORE expensive → moved toward that team
    // For underdogs (positive): +130 → +120 means line shortened → moved toward that team
    const homeOddsChange = openHomeAmer - currHomeAmer; // positive = home shortened (more favorite/less dog)
    const awayOddsChange = openAwayAmer - currAwayAmer;

    const absChange = Math.max(Math.abs(homeOddsChange), Math.abs(awayOddsChange));

    // Magnitude thresholds
    let magnitude;
    // Note: "steam" ideally requires time check, but on free plan we estimate by size alone
    if (absChange >= 8)      magnitude = 'steam';
    else if (absChange >= 5) magnitude = 'significant';
    else if (absChange >= 2.5) magnitude = 'moderate';
    else                     magnitude = 'minimal';

    // Direction: toward_home if home line shortened more, toward_away if away shortened more
    let direction = 'stable';
    if (magnitude !== 'minimal') {
      if (homeOddsChange > awayOddsChange) direction = 'toward_home';
      else if (awayOddsChange > homeOddsChange) direction = 'toward_away';
    }

    // Sharp signal (neutral by default — caller applies per-pick direction context)
    let sharpSignal = 'neutral';
    if (magnitude === 'steam')        sharpSignal = direction === 'stable' ? 'neutral' : 'steam_detected';
    else if (magnitude === 'significant') sharpSignal = direction === 'stable' ? 'neutral' : 'significant_move';
    else if (magnitude === 'minimal') sharpSignal = 'neutral';

    // Total movement
    let totalMovement = { change: 0, direction: 'stable' };
    if (opening.pinnacle_total != null && currPinnTotal != null) {
      const totalChange = currPinnTotal - opening.pinnacle_total;
      totalMovement = {
        change: Math.round(totalChange * 10) / 10,
        direction: totalChange > 0.2 ? 'over' : totalChange < -0.2 ? 'under' : 'stable',
      };
    }

    results.push({
      gameId: game.id,
      homeTeam: game.home_team,
      awayTeam: game.away_team,
      pinnacleMovement: {
        homeOddsChange,
        awayOddsChange,
        openHomeAmer,
        openAwayAmer,
        currHomeAmer,
        currAwayAmer,
        direction,
        magnitude,
        sharpSignal,
      },
      totalMovement,
      openingHomeOdds: openHomeAmer,
      openingAwayOdds: openAwayAmer,
    });
  }

  // Now resolve per-pick sharp signal (toward/against the picked team)
  // This is used in applySharpMoneySignal in edgeAnalyzer
  for (const r of results) {
    if (!r.pinnacleMovement) continue;
    const pm = r.pinnacleMovement;
    // Resolve to directional signal based on magnitude + direction
    if (pm.magnitude === 'minimal') {
      pm.sharpSignal = 'neutral';
    } else if (pm.magnitude === 'steam') {
      pm.sharpSignal = pm.direction === 'toward_home' ? 'strong_confirm_home'
        : pm.direction === 'toward_away' ? 'strong_confirm_away'
        : 'neutral';
    } else if (pm.magnitude === 'significant') {
      pm.sharpSignal = pm.direction === 'toward_home' ? 'confirm_home'
        : pm.direction === 'toward_away' ? 'confirm_away'
        : 'neutral';
    } else {
      pm.sharpSignal = 'neutral';
    }
  }

  return results;
}

/**
 * resolveSharpSignalForPick(pick, movementEntry)
 * Given a pick's side ('home'|'away') and the movement entry,
 * resolves the directional sharpSignal used in applySharpMoneySignal.
 */
function resolveSharpSignalForPick(side, pm) {
  if (!pm || pm.magnitude === 'minimal') return 'neutral';
  if (side === 'home') {
    if (pm.sharpSignal === 'strong_confirm_home') return 'strong_confirm';
    if (pm.sharpSignal === 'confirm_home') return 'confirm';
    if (pm.sharpSignal === 'strong_confirm_away') return 'strong_fade';
    if (pm.sharpSignal === 'confirm_away') return 'fade';
  } else {
    if (pm.sharpSignal === 'strong_confirm_away') return 'strong_confirm';
    if (pm.sharpSignal === 'confirm_away') return 'confirm';
    if (pm.sharpSignal === 'strong_confirm_home') return 'strong_fade';
    if (pm.sharpSignal === 'confirm_home') return 'fade';
  }
  return 'neutral';
}

/**
 * attachPickSharpSignals(picks, lineMovement)
 * Attaches the properly-directional sharpSignal to each pick,
 * then calls applySharpMoneySignal for confidence adjustments.
 */
function attachPickSharpSignals(picks, lineMovement) {
  if (!lineMovement || lineMovement.length === 0) return picks;

  const movementMap = {};
  for (const m of lineMovement) {
    movementMap[m.gameId] = m;
  }

  // Resolve directional signal per pick before passing to applySharpMoneySignal
  const picksWithGameId = picks.map(pick => {
    // Find matching movement by homeTeam+awayTeam since picks don't have game.id directly
    const movement = lineMovement.find(m =>
      m.homeTeam === pick.homeTeam && m.awayTeam === pick.awayTeam
    );
    if (!movement?.pinnacleMovement) return { ...pick, gameId: movement?.gameId };
    const resolved = resolveSharpSignalForPick(pick.side, movement.pinnacleMovement);
    const pm = { ...movement.pinnacleMovement, sharpSignal: resolved };
    return { ...pick, gameId: movement.gameId, _resolvedMovement: { ...movement, pinnacleMovement: pm } };
  });

  // Build lineMovement array with resolved per-pick signals
  const resolvedMovement = picksWithGameId
    .filter(p => p._resolvedMovement)
    .map(p => p._resolvedMovement);

  const result = applySharpMoneySignal(
    picksWithGameId.map(p => { const { _resolvedMovement, ...rest } = p; return rest; }),
    resolvedMovement
  );

  return result;
}

// ─── PICK QUALITY FILTERS ────────────────────────────────────────────────────

/**
 * applyPickFilters(picks)
 * Post-processes raw analyzePicks output with quality adjustments:
 *  1. Coors Field adjustment  — reduce confidence 20pts for COL home games
 *  2. Model anomaly flag      — warn when edgePct > 20%
 *  3. Minimum confidence gate — drop picks below 35
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
      if (adjusted.edgePct > 20) {
        adjusted.warning = "MODEL ANOMALY - verify before tracking";
      }

      return adjusted;
    })
    // 3. Minimum confidence threshold
    .filter(pick => pick.confidence >= 35);
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
 * GET /api/config/rpc
 * Returns the Solana RPC URL for the frontend to use.
 * Keeps the actual URL server-side so it can be updated via env var without code changes.
 */
app.get("/api/config/rpc", (req, res) => {
  res.json({ rpcUrl: SOLANA_RPC });
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
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

    if (!CACHE_BYPASS) {
      // Rate-limited: same IP hit > 3× in 10 min — serve cache regardless of age
      if (checkRateLimit(ip) && cache.picks.data) {
        const cached = cache.picks.data;
        const picksWithMovement = addOddsMovement(cached.picks || []);
        return res.json({ ...cached, picks: stripToFreeTier(picksWithMovement), cached: true, rateLimited: true });
      }

      // Return cache if within time-based TTL — add movement data on every call
      if (isPicksCacheValid()) {
        const cached = cache.picks.data;
        const picksWithMovement = addOddsMovement(cached.picks || []);
        return res.json({ ...cached, picks: stripToFreeTier(picksWithMovement), cached: true });
      }
    }

    const { games, remaining, used } = await fetchMLBOdds();

    // Filter to only today's games in ET timezone
    const nowET = new Date().toLocaleString("en-US", {timeZone: "America/New_York"});
    const todayET = new Date(nowET);
    const todayDateStr = todayET.toISOString().split('T')[0]; // "2026-03-26"

    const todayGames = (games || []).filter(game => {
      const gameInET = new Date(game.commence_time).toLocaleString("en-US", {timeZone: "America/New_York"});
      const gameDateStr = new Date(gameInET).toISOString().split('T')[0];
      return gameDateStr === todayDateStr;
    });

    if (!games || games.length === 0 || todayGames.length === 0) {
      return res.json({
        picks: [],
        total: 0,
        gamesAnalyzed: 0,
        noGamesToday: true,
        message: "No games scheduled today",
        cached: false,
        fetchedAt: new Date().toISOString(),
        quota: { remaining, used },
      });
    }

    // Store opening lines on every fresh fetch (UPSERT ignores duplicates)
    storeOpeningLines(todayGames).catch(err => console.warn('storeOpeningLines non-blocking error:', err.message));

    // Free tier — Poisson + park factors only (no FIP/fatigue/bullpen/weather enrichment)
    let picks = applyPickFilters(analyzePicks(todayGames, null));

    // Apply Elo-based confidence adjustments (free tier)
    try {
      const { supabaseQuery } = require("./supabase");
      let eloRatings = [];
      try {
        eloRatings = await supabaseQuery("elo_ratings", "GET", null, "?order=elo.desc");
      } catch (_) {
        // Fallback to opening day seeds
        console.warn('⚠️ Elo fallback to Opening Day seeds — Supabase elo_ratings table may be empty. Update via /api/cron/update-elo once season data is available.');
        const { OPENING_DAY_ELO } = require("./eloSystem");
        eloRatings = Object.entries(OPENING_DAY_ELO).map(([abbr, data]) => ({
          team_abbr: abbr,
          elo: data.elo,
          wins: data.wins || 0,
          losses: data.losses || 0,
        }));
      }
      if (eloRatings && eloRatings.length > 0) {
        picks = applyEloAdjustment(picks, eloRatings);
      }
    } catch (eloErr) {
      console.warn("⚠️ Elo adjustment skipped:", eloErr.message);
    }

    // Apply game window status + deterministic grade (free tier: no pitcher penalty)
    picks = applyWindowAndGrade(picks, false);

    // Track opening odds and add movement field
    picks = addOddsMovement(picks);
    // Strip premium-only fields before caching and responding
    picks = stripToFreeTier(picks);

    const responseData = {
      picks,
      total: picks.length,
      gamesAnalyzed: todayGames.length,
      noGamesToday: false,
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
 * GET /api/picks/daily
 * Returns today's persisted daily picks from Supabase — no payment gate
 */
app.get("/api/picks/daily", async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const picks = await getDailyPicks(today);
    if (picks.length > 0) {
      return res.json({ picks, date: today, source: 'supabase', count: picks.length });
    }
    return res.json({ picks: [], date: today, source: 'pending', message: 'Picks not yet generated for today' });
  } catch (err) {
    console.error("❌ /api/picks/daily error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/picks/premium
 * Premium tier — full model with FIP, fatigue, bullpen, weather, sharp signals
 * Requires wallet payment verification
 */
app.get("/api/picks/premium", async (req, res) => {
  try {
    const { wallet } = req.query;
    if (!wallet) {
      return res.status(401).json({ error: "Wallet required", message: "Connect your Phantom wallet to access premium picks" });
    }
    if (!isValidWallet(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }

    const payment = await verifyPayment(wallet);
    if (!payment.paid) {
      return res.status(402).json({
        error: "Payment required",
        message: `Send ${PREMIUM_PRICE_SOL} SOL to unlock premium picks`,
        price: PREMIUM_PRICE_SOL,
        revenueWallet: REVENUE_WALLET,
        reason: payment.reason,
      });
    }

    const { games, remaining, used } = await fetchMLBOdds();

    // ET date filter
    const nowET = new Date().toLocaleString("en-US", {timeZone: "America/New_York"});
    const todayET = new Date(nowET);
    const todayDateStr = todayET.toISOString().split('T')[0];
    const todayGames = (games || []).filter(game => {
      const gameInET = new Date(game.commence_time).toLocaleString("en-US", {timeZone: "America/New_York"});
      return new Date(gameInET).toISOString().split('T')[0] === todayDateStr;
    });

    if (!todayGames.length) {
      return res.json({ picks: [], gamesAnalyzed: 0, noGamesToday: true, tier: 'premium', layers: PREMIUM_LAYERS, fetchedAt: new Date().toISOString() });
    }

    // Full premium analysis — all layers active
    const cachedEnriched = getEnrichedCache();
    let picks = applyPickFilters(analyzePicks(todayGames, cachedEnriched));

    if (cachedEnriched) picks = applyInjuryPenalty(picks, cachedEnriched);

    // Elo adjustment
    try {
      const { supabaseQuery } = require("./supabase");
      let eloRatings = [];
      try {
        eloRatings = await supabaseQuery("elo_ratings", "GET", null, "?order=elo.desc");
      } catch (_) {
        console.warn('⚠️ Elo fallback to Opening Day seeds — Supabase elo_ratings table may be empty. Update via /api/cron/update-elo once season data is available.');
        const { OPENING_DAY_ELO } = require("./eloSystem");
        eloRatings = Object.entries(OPENING_DAY_ELO).map(([abbr, data]) => ({
          team_abbr: abbr, elo: data.elo, wins: data.wins || 0, losses: data.losses || 0,
        }));
      }
      if (eloRatings?.length) picks = applyEloAdjustment(picks, eloRatings);
    } catch (eloErr) {
      console.warn("⚠️ Premium Elo adjustment skipped:", eloErr.message);
    }

    // Pinnacle sharp money signal
    try {
      const lineMovement = await analyzeLineMovement(todayGames);
      if (lineMovement?.length) picks = attachPickSharpSignals(picks, lineMovement);
    } catch (sharpErr) {
      console.warn("⚠️ Premium sharp signals skipped:", sharpErr.message);
    }

    // Apply game window status + deterministic grade (premium: with pitcher confirmation penalty)
    picks = applyWindowAndGrade(picks, true);

    picks = addOddsMovement(picks);

    res.json({
      picks,
      total: picks.length,
      gamesAnalyzed: todayGames.length,
      noGamesToday: false,
      tier: 'premium',
      layers: PREMIUM_LAYERS,
      cached: false,
      fetchedAt: new Date().toISOString(),
      quota: { remaining, used },
    });
  } catch (err) {
    console.error("❌ /api/picks/premium error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/odds/raw
 * Returns raw odds data from The Odds API — useful for debugging
 */
app.get("/api/odds/raw", async (req, res) => {
  const secret = req.query.secret || req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden. Provide ?secret=<ADMIN_SECRET> or X-Admin-Secret header.' });
  }
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


/**
 * GET /api/cache/status
 * Shows current cache state and scheduled refresh windows.
 */
app.get("/api/cache/status", (req, res) => {
  const { lastRefresh, nextRefresh } = getScheduledTimes();
  const fetchedAt = cache.picks.fetchedAt;
  const cacheAgeMs = fetchedAt ? Date.now() - fetchedAt : null;
  res.json({
    cache: {
      isValid: isCacheValid(cache.picks),
      hasData: !!cache.picks.data,
      fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
      ageMinutes: cacheAgeMs !== null ? Math.floor(cacheAgeMs / 60000) : null,
    },
    schedule: {
      lastRefresh: lastRefresh ? lastRefresh.toISOString() : null,
      nextRefresh: nextRefresh ? nextRefresh.toISOString() : null,
      refreshTimesET: REFRESH_HOURS_ET.map(h => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'} ET`),
    },
  });
});

/**
 * GET /api/cron/refresh-picks
 * Scheduled cache pre-warm — runs at 11AM ET and 5PM ET via Vercel cron.
 * Clears stale cache and fetches fresh odds + picks proactively.
 */
app.get("/api/cron/refresh-picks", async (req, res) => {
  const cronSecret = req.headers["x-vercel-cron-secret"] === process.env.CRON_SECRET;
  const adminSecret = req.query.secret === process.env.ADMIN_SECRET;
  if (!cronSecret && !adminSecret) return res.status(401).json({ error: "Unauthorized" });

  // Clear cache so the fetch below stores fresh data
  cache.picks = { data: null, fetchedAt: null };
  cache.raw   = { data: null, fetchedAt: null };

  try {
    const { games, remaining, used } = await fetchMLBOdds();
    if (!games || games.length === 0) {
      console.log("⏰ Scheduled refresh: no games found");
      return res.json({ success: true, message: "No games today", quota: { remaining, used } });
    }

    // Store opening lines on scheduled refresh
    storeOpeningLines(games).catch(err => console.warn('storeOpeningLines non-blocking error:', err.message));

    const cachedEnriched = getEnrichedCache();
    let picks = applyPickFilters(analyzePicks(games, cachedEnriched));

    if (cachedEnriched) picks = applyInjuryPenalty(picks, cachedEnriched);

    try {
      const { supabaseQuery } = require("./supabase");
      let eloRatings = [];
      try {
        eloRatings = await supabaseQuery("elo_ratings", "GET", null, "?order=elo.desc");
      } catch (_) {
        console.warn('⚠️ Elo fallback to Opening Day seeds — Supabase elo_ratings table may be empty. Update via /api/cron/update-elo once season data is available.');
        const { OPENING_DAY_ELO } = require("./eloSystem");
        eloRatings = Object.entries(OPENING_DAY_ELO).map(([abbr, data]) => ({
          team_abbr: abbr, elo: data.elo, wins: data.wins || 0, losses: data.losses || 0,
        }));
      }
      if (eloRatings && eloRatings.length > 0) picks = applyEloAdjustment(picks, eloRatings);
    } catch (_) {}

    // Apply Pinnacle sharp money signal
    try {
      const lineMovement = await analyzeLineMovement(games);
      if (lineMovement && lineMovement.length > 0) {
        picks = attachPickSharpSignals(picks, lineMovement);
      }
    } catch (_) {}

    picks = addOddsMovement(picks);

    const responseData = {
      picks, total: picks.length, gamesAnalyzed: games.length,
      cached: false, fetchedAt: new Date().toISOString(),
      quota: { remaining, used },
    };
    cache.picks = { data: responseData, fetchedAt: Date.now() };
    cache.raw   = { data: games, fetchedAt: Date.now() };

    console.log(`✅ Scheduled picks refresh — ${picks.length} picks cached | Quota: ${remaining} remaining`);
    return res.json({ success: true, picksCount: picks.length, quota: { remaining, used } });
  } catch (err) {
    console.error("❌ /api/cron/refresh-picks error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── SHARP MONEY ROUTES ──────────────────────────────────────────────────────

/**
 * GET /api/sharp/movement
 * Returns today's Pinnacle line movement data for all games.
 * Useful for debugging and verification.
 */
app.get("/api/sharp/movement", async (req, res) => {
  try {
    let games = [];
    if (isCacheValid(cache.raw)) {
      games = cache.raw.data || [];
    } else {
      const { games: rawGames } = await fetchMLBOdds();
      games = rawGames || [];
      cache.raw = { data: games, fetchedAt: Date.now() };
    }

    const lineMovement = await analyzeLineMovement(games);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const { supabaseQuery } = require('./supabase');

    let openingLines = [];
    try {
      openingLines = await supabaseQuery('opening_lines', 'GET', null, `?game_date=eq.${today}`);
    } catch (_) {}

    // Summary stats
    const significantMoves = lineMovement.filter(m =>
      m.pinnacleMovement && ['steam', 'significant'].includes(m.pinnacleMovement.magnitude)
    ).length;
    const steamMoves = lineMovement.filter(m =>
      m.pinnacleMovement?.magnitude === 'steam'
    ).length;

    res.json({
      date: today,
      gamesTracked: lineMovement.length,
      openingLinesStored: openingLines.length,
      significantMovesToday: significantMoves,
      steamMovesToday: steamMoves,
      oddsApiUpgraded: ODDS_API_UPGRADED,
      movement: lineMovement,
    });
  } catch (err) {
    console.error("❌ /api/sharp/movement error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── USER ROUTES ─────────────────────────────────────────────────────────────

app.post("/api/users/upsert", async (req, res) => {
  try {
    const { wallet_address, username } = req.body;
    if (!wallet_address) return res.status(400).json({ error: "wallet_address required" });
    if (!isValidWallet(wallet_address)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }
    if (username && typeof username !== 'string') {
      return res.status(400).json({ error: 'Invalid username' });
    }
    const safeUsername = username ? sanitizeString(username, 30) : undefined;
    const user = await upsertUser(wallet_address, safeUsername);
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/users/:wallet", async (req, res) => {
  try {
    if (!isValidWallet(req.params.wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }
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
    if (!isValidWallet(wallet_address)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }
    if (!isValidAmount(amount)) {
      return res.status(400).json({ error: 'Invalid amount — must be a positive number under 1,000,000' });
    }
    if (result && !VALID_RESULTS.includes(result)) {
      return res.status(400).json({ error: `Invalid result — must be one of: ${VALID_RESULTS.join(', ')}` });
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
    if (!isValidWallet(req.params.wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }
    const bets = await getUserBets(req.params.wallet);
    res.json({ bets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/bets/:id/result", async (req, res) => {
  try {
    const { result, wallet_address, is_edge_pick, streak_count } = req.body;
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid pick ID' });
    }
    if (!VALID_RESULTS.includes(result)) {
      return res.status(400).json({ error: `Invalid result — must be one of: ${VALID_RESULTS.join(', ')}` });
    }
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
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const type = VALID_LEADERBOARD_TYPES.includes(req.query.type)
      ? req.query.type
      : 'all_time';
    const board = await getLeaderboard(type, limit);
    res.json({ leaderboard: board, type });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/points/:wallet", async (req, res) => {
  try {
    if (!isValidWallet(req.params.wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }
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
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

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
    return { paid: true, free: true, reason: 'Whitelisted wallet' };
  }

  try {
    const { createSolanaRpc } = require('@solana/kit');

    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const rpc = createSolanaRpc(rpcUrl);

    // Fetch recent transaction signatures for the REVENUE wallet
    // We look at incoming transactions to the revenue wallet, not outgoing
    const signaturesResponse = await rpc.getSignaturesForAddress(
      REVENUE_WALLET,
      { limit: 50 }
    ).send();

    const signatures = signaturesResponse ?? [];

    if (signatures.length === 0) {
      return { paid: false, reason: 'No transactions found' };
    }

    // Only check transactions from the last 24 hours
    const oneDayAgo = BigInt(Math.floor(Date.now() / 1000) - 86400);

    for (const sig of signatures) {
      // Skip old transactions — blockTime is BigInt in v2
      if (sig.blockTime == null || sig.blockTime < oneDayAgo) continue;

      // Fetch full transaction details
      const tx = await rpc.getTransaction(
        sig.signature,
        {
          encoding: 'json',
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        }
      ).send();

      if (!tx) continue;

      // Check if this transaction was sent FROM the paying wallet
      const accountKeys = tx.transaction?.message?.accountKeys ?? [];
      const fromWallet = accountKeys[0];

      if (fromWallet !== walletAddress) continue;

      // Calculate SOL transferred — preBalances minus postBalances for sender
      const preBalances = tx.meta?.preBalances ?? [];
      const postBalances = tx.meta?.postBalances ?? [];

      // balances are BigInt in v2 (lamports)
      const lamportsSent = (preBalances[0] ?? 0n) - (postBalances[0] ?? 0n);
      const solSent = Number(lamportsSent) / 1_000_000_000;

      if (solSent >= PREMIUM_PRICE_SOL) {
        return {
          paid: true,
          free: false,
          amount: solSent,
          signature: sig.signature,
          reason: `Payment verified: ${solSent} SOL`,
        };
      }
    }

    return {
      paid: false,
      reason: `No payment of ${PREMIUM_PRICE_SOL} SOL found in last 24h`,
    };

  } catch (err) {
    console.error('Payment verification error:', err.message);
    return { paid: false, reason: err.message };
  }
}

// ─── WALLET SPLIT (v2 — @solana/kit) ─────────────────────────────────────────
//
// Key differences from v1:
//   - createSolanaRpc()        instead of new Connection()
//   - address()                instead of new PublicKey()
//   - createKeyPairFromBytes() instead of Keypair.fromSecretKey()
//   - pipe()                   for building transactions
//   - simulateTransaction()    before sending — safety net for mainnet
//   - sendAndConfirmTransactionFactory() instead of sendAndConfirmTransaction()

/**
 * splitPayment(amountSol, payerWallet)
 *
 * Best-effort: splits an incoming SOL payment from REVENUE_WALLET
 * to configured destinations using @solana/kit v2.
 *
 * Treasury portion stays in REVENUE_WALLET — no transfer needed.
 * Requires REVENUE_WALLET_PRIVATE_KEY env var (base58, set in Vercel only).
 *
 * This function is always called async and non-blocking — a failure
 * here never prevents premium access from being granted.
 *
 * ⚠️  IRREVERSIBLE ON-CHAIN: transfers real SOL on mainnet.
 *     REVENUE_WALLET_PRIVATE_KEY must only be set in Vercel env vars.
 *     Never hardcode or commit private keys.
 */
async function splitPayment(amountSol, payerWallet) {
  try {
    const {
      createSolanaRpc,
      createSolanaRpcSubscriptions,
      address,
      createKeyPairFromBytes,
      createTransactionMessage,
      setTransactionMessageFeePayer,
      setTransactionMessageLifetimeUsingBlockhash,
      appendTransactionMessageInstructions,
      signTransactionMessageWithSigners,
      sendAndConfirmTransactionFactory,
      getSignatureFromTransaction,
      lamports,
      pipe,
    } = require('@solana/kit');

    const { getTransferSolInstruction } = require('@solana-program/system');
    const bs58 = require('bs58');

    // ── Guard: skip if private key not configured ─────────────────────────
    const privateKeyEnv = process.env.REVENUE_WALLET_PRIVATE_KEY;
    if (!privateKeyEnv) {
      console.warn('⚠️  REVENUE_WALLET_PRIVATE_KEY not set — skipping split');
      return;
    }

    // ── Guard: skip if amount too small to be worth splitting ─────────────
    const MIN_SPLIT_SOL = 0.005;
    if (amountSol < MIN_SPLIT_SOL) {
      console.warn(`⚠️  Amount ${amountSol} SOL too small to split — skipping`);
      return;
    }

    // ── RPC connection ────────────────────────────────────────────────────
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const rpc = createSolanaRpc(rpcUrl);
    const rpcSubscriptions = createSolanaRpcSubscriptions(
      rpcUrl.replace('https://', 'wss://')
    );

    // ── Load keypair from base58 private key ──────────────────────────────
    const privateKeyBytes = bs58.decode(privateKeyEnv);
    const revenueKeypair = await createKeyPairFromBytes(privateKeyBytes);

    // ── Calculate split amounts ───────────────────────────────────────────
    const activeSplit = PRIZE_POOL_ENABLED
      ? { operations: 0.70, prizePool: 0.20, treasury: 0.10 }
      : SPLIT_CONFIG;

    const LAMPORTS_PER_SOL = 1_000_000_000n;
    const amountLamports = BigInt(Math.floor(amountSol * Number(LAMPORTS_PER_SOL)));
    const operationsLamports = (amountLamports * BigInt(Math.floor(activeSplit.operations * 100))) / 100n;
    const prizePoolLamports  = (amountLamports * BigInt(Math.floor(activeSplit.prizePool  * 100))) / 100n;

    console.log(`💸 Split for ${payerWallet} — ${amountSol} SOL:`);
    console.log(`   Operations (${(activeSplit.operations * 100).toFixed(0)}%): ${Number(operationsLamports) / Number(LAMPORTS_PER_SOL)} SOL → ${OPERATIONS_WALLET}`);
    if (PRIZE_POOL_ENABLED) {
      console.log(`   Prize Pool (${(activeSplit.prizePool * 100).toFixed(0)}%): ${Number(prizePoolLamports) / Number(LAMPORTS_PER_SOL)} SOL → ${PRIZE_POOL_WALLET}`);
    } else {
      console.log(`   Prize Pool: DISABLED (0 SOL)`);
    }
    console.log(`   Treasury  (${(activeSplit.treasury * 100).toFixed(0)}%): stays in revenue wallet`);

    // ── Build transfer instructions ───────────────────────────────────────
    const instructions = [];

    if (operationsLamports > 0n) {
      instructions.push(
        getTransferSolInstruction({
          source: revenueKeypair,
          destination: address(OPERATIONS_WALLET),
          amount: lamports(operationsLamports),
        })
      );
    }

    if (PRIZE_POOL_ENABLED && prizePoolLamports > 0n) {
      instructions.push(
        getTransferSolInstruction({
          source: revenueKeypair,
          destination: address(PRIZE_POOL_WALLET),
          amount: lamports(prizePoolLamports),
        })
      );
    }

    if (instructions.length === 0) {
      console.log('   No transfers to execute.');
      return;
    }

    // ── Fetch latest blockhash ────────────────────────────────────────────
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    // ── Build transaction using pipe() ────────────────────────────────────
    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      tx => setTransactionMessageFeePayer(revenueKeypair.address, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      tx => appendTransactionMessageInstructions(instructions, tx),
    );

    // ── Simulate before sending ───────────────────────────────────────────
    console.log('   🔍 Simulating split transaction...');
    const signedTx = await signTransactionMessageWithSigners(transactionMessage);

    const simulation = await rpc.simulateTransaction(signedTx, {
      commitment: 'confirmed',
      sigVerify: true,
    }).send();

    if (simulation.value.err) {
      console.error('❌ Split simulation failed — transaction NOT sent:', simulation.value.err);
      console.error('   Logs:', simulation.value.logs?.join('\n   '));
      return;
    }

    console.log('   ✅ Simulation passed — sending split transaction...');

    // ── Send and confirm ──────────────────────────────────────────────────
    const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

    await sendAndConfirm(signedTx, {
      commitment: 'confirmed',
      maxRetries: 3n,
    });

    const signature = getSignatureFromTransaction(signedTx);
    console.log(`   ✅ Split tx confirmed: ${signature}`);
    console.log(`   🔗 https://solscan.io/tx/${signature}`);

  } catch (err) {
    // Best-effort — never block premium access
    console.error('❌ splitPayment error (non-blocking):', err.message);
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

    console.log(`[premium] Request — wallet: ${wallet || '(none)'}`);
    console.log(`[premium] Whitelist: ${JSON.stringify(FREE_ACCESS_WALLETS)}`);
    if (wallet) {
      console.log(`[premium] Is whitelisted: ${FREE_ACCESS_WALLETS.includes(wallet)}`);
    }

    // Verify wallet is provided
    if (!wallet) {
      return res.status(401).json({
        error: "Wallet required",
        message: "Connect your Phantom wallet to access premium picks"
      });
    }
    if (!isValidWallet(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
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
 * GET /api/debug/wallet
 * Admin-only: shows whitelist status and premium eligibility for a wallet
 */
app.get("/api/debug/wallet", async (req, res) => {
  const secret = req.query.secret || req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden. Provide ?secret=<ADMIN_SECRET>.' });
  }

  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet param required' });

  const isWhitelisted = FREE_ACCESS_WALLETS.includes(wallet);
  const payment = await verifyPayment(wallet).catch(err => ({ paid: false, reason: err.message }));

  // Fetch recent transactions from the revenue wallet for this sender
  let recentTxs = [];
  try {
    const sigRes = await fetch(SOLANA_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getSignaturesForAddress",
        params: [wallet, { limit: 10 }]
      })
    });
    const sigData = await sigRes.json();
    recentTxs = (sigData.result || []).map(s => ({
      signature: s.signature,
      blockTime: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
      err: s.err,
    }));
  } catch (e) {
    recentTxs = [{ error: e.message }];
  }

  res.json({
    wallet,
    isWhitelisted,
    freeAccessWallets: FREE_ACCESS_WALLETS,
    premiumWouldBeGranted: payment.paid,
    paymentDetails: payment,
    recentTransactions: recentTxs,
  });
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
    if (!isValidWallet(wallet)) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }
    const safeHome = sanitizeString(home, 50);
    const safeAway = sanitizeString(away, 50);
    if (!safeHome || !safeAway) {
      return res.status(400).json({ error: 'Invalid team name' });
    }

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
        p.homeTeam === safeHome && p.awayTeam === safeAway
      );
    }

    // Fetch enriched data
    const enrichedData = await enrichPicks([{ home_team: safeHome, away_team: safeAway }]);
    const homeAbbr = safeHome.split(" ").pop().substring(0, 3).toUpperCase();
    const awayAbbr = safeAway.split(" ").pop().substring(0, 3).toUpperCase();
    const gameKey = `${awayAbbr}_${homeAbbr}`;
    const gameEnriched = enrichedData[gameKey] || {};

    // Build game-specific prompt
    const gamePrompt = `You are Edge Seeker's premium MLB game analyst. Analyze this specific matchup and provide:
1. Over/Under best bet with projected total runs
2. Home pitcher analysis with strikeout prop recommendation
3. Away pitcher analysis with strikeout prop recommendation  
4. One hot batter from each team with a prop bet (hits, home runs, RBIs, or strikeouts)
5. Weather impact
6. Sharp money observation

Game: ${safeAway} @ ${safeHome}
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
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

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
      enrichedData = await enrichPicks(games);
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

// ─── AUTO RESULT LOGGER ──────────────────────────────────────────────────────

/**
 * autoLogPickResults()
 * Fetches yesterday's final MLB scores, finds pending picks, and auto-resolves them.
 * Run nightly at 11PM ET via Vercel Cron (4AM UTC).
 */
async function autoLogPickResults() {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // Fetch yesterday's scores from MLB Stats API
    const mlbUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${yesterdayStr}&hydrate=linescore`;
    const mlbRes = await fetch(mlbUrl);
    const mlbData = await mlbRes.json();
    const games = mlbData.dates?.[0]?.games || [];

    // Build a map of finished games: homeAbbr+awayAbbr -> scores
    const scoreMap = {};
    for (const game of games) {
      if (game.status?.detailedState !== 'Final') continue;
      const home = game.teams?.home;
      const away = game.teams?.away;
      if (!home || !away) continue;
      const homeAbbr = getTeamAbbrServer(home.team.name);
      const awayAbbr = getTeamAbbrServer(away.team.name);
      scoreMap[`${homeAbbr}_${awayAbbr}`] = {
        homeScore: home.score || 0,
        awayScore: away.score || 0,
        homeAbbr, awayAbbr,
      };
    }

    console.log(`📊 Auto-log: ${Object.keys(scoreMap).length} finished games on ${yesterdayStr}`);

    // Query pending picks from yesterday
    const { supabaseQuery } = require('./supabase');
    const pendingPicks = await supabaseQuery(
      'pick_results', 'GET', null,
      `?pick_date=eq.${yesterdayStr}&result=eq.pending`
    );

    if (!pendingPicks || pendingPicks.length === 0) {
      console.log(`📊 Auto-log: No pending picks for ${yesterdayStr}`);
      return { logged: 0, date: yesterdayStr };
    }

    let wins = 0, losses = 0, skipped = 0;

    for (const pick of pendingPicks) {
      // pick.pick looks like "NYY ML" or "BOS -1.5"
      const pickTeam = pick.pick.split(' ')[0];
      let matched = false;

      for (const [, score] of Object.entries(scoreMap)) {
        if (pickTeam !== score.homeAbbr && pickTeam !== score.awayAbbr) continue;
        const pickedHome = pickTeam === score.homeAbbr;
        const homeWon = score.homeScore > score.awayScore;
        const result = (pickedHome && homeWon) || (!pickedHome && !homeWon) ? 'win' : 'loss';

        await supabaseQuery(
          'pick_results', 'PATCH',
          { result, resolved_at: new Date().toISOString() },
          `?id=eq.${pick.id}`
        );

        console.log(`✅ Auto-log: ${pick.pick} → ${result.toUpperCase()} (${score.awayScore}@${score.homeScore})`);
        result === 'win' ? wins++ : losses++;
        matched = true;
        break;
      }

      if (!matched) {
        console.log(`⏸️  Auto-log: No score match for pick "${pick.pick}"`);
        skipped++;
      }
    }

    console.log(`📊 Auto-log complete: ${wins}W ${losses}L ${skipped} unmatched`);
    return { wins, losses, skipped, date: yesterdayStr };

  } catch (err) {
    console.error('❌ autoLogPickResults error:', err.message);
    throw err;
  }
}

// ─── DAILY DIGEST WEBHOOK ────────────────────────────────────────────────────

/**
 * buildDailyDigest()
 * Builds a text summary of today's picks and season record, sends to Discord webhook.
 * Called after the 11AM ET agent auto-run.
 */
async function buildDailyDigest() {
  try {
    if (!process.env.DISCORD_WEBHOOK_URL) return;

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const dateStr = new Date().toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', month: 'short', day: 'numeric',
    });

    // Get today's logged picks from Supabase
    const { supabaseQuery } = require('./supabase');
    const todayPickRows = await supabaseQuery('pick_results', 'GET', null, `?pick_date=eq.${today}`);
    const allResolved = await supabaseQuery('pick_results', 'GET', null, '?result=neq.pending&order=pick_date.desc');

    const resolved = (allResolved || []).filter(p => p.result !== 'void');
    const wins = resolved.filter(p => p.result === 'win').length;
    const losses = resolved.filter(p => p.result === 'loss').length;
    const winRate = wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0';

    // Compute streak
    let streak = 0, streakType = '';
    for (const p of resolved) {
      if (streak === 0) streakType = p.result;
      if (p.result === streakType) streak++;
      else break;
    }
    const streakStr = streak > 0 ? `${streak} ${streakType === 'win' ? 'W' : 'L'} streak` : 'None';

    // Build picks section
    const rows = todayPickRows || [];
    let picksSection = '';
    if (rows.length > 0) {
      picksSection = rows.map((p, i) => `Pick ${i + 1}: ${p.pick} | ${p.edge} edge | Grade ${p.grade}`).join('\n');
    } else {
      const cachedPicks = isCacheValid(cache.picks) ? (cache.picks.data?.picks || []) : [];
      if (cachedPicks.length > 0) {
        picksSection = cachedPicks.slice(0, 2).map((p, i) =>
          `Pick ${i + 1}: ${p.pick} | +${p.edgePct}% edge`
        ).join('\n');
      } else {
        picksSection = 'No picks available — check back after 11AM ET';
      }
    }

    const gameCount = isCacheValid(cache.picks) ? (cache.picks.data?.gamesAnalyzed || 0) : 0;
    const cachedPicks = isCacheValid(cache.picks) ? (cache.picks.data?.picks || []) : [];
    const agentMsg = cachedPicks.length > 0
      ? `Top edge: ${cachedPicks[0]?.pick} +${cachedPicks[0]?.edgePct}%`
      : 'Analysis running — check the app for today\'s picks';

    const digest = `⚾ EDGESEEKER DAILY DIGEST — ${dateStr}

🎯 TODAY'S PICKS:
${picksSection}

📊 SEASON RECORD: ${wins}-${losses} (${winRate}%)
🔥 Current streak: ${streakStr}

⚾ ${gameCount} games analyzed today
💡 ${agentMsg}

edge-seeker.vercel.app`;

    const webhookRes = await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: digest }),
    });

    if (!webhookRes.ok) throw new Error(`Discord webhook ${webhookRes.status}`);
    console.log('📨 Daily digest sent to Discord');
    return { sent: true, date: today };

  } catch (err) {
    console.error('❌ buildDailyDigest error:', err.message);
    throw err;
  }
}

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
    if (date && !isValidDate(date)) {
      return res.status(400).json({ error: 'Invalid date format — use YYYY-MM-DD' });
    }

    const { supabaseQuery } = require("./supabase");
    const pickDate = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

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
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid pick ID' });
    }
    if (!VALID_RESULTS.includes(result)) {
      return res.status(400).json({ error: `Invalid result — must be one of: ${VALID_RESULTS.join(', ')}` });
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

// ─── AUTO RESULT LOGGER ENDPOINT ─────────────────────────────────────────────

/**
 * GET /api/cron/auto-log-results
 * Runs nightly at 4AM UTC (11PM ET) via Vercel Cron.
 * Also callable manually from admin dashboard.
 * SQL: ALTER TABLE pick_results ADD COLUMN IF NOT EXISTS opening_odds TEXT;
 */
app.get("/api/cron/auto-log-results", async (req, res) => {
  const cronSecret = req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
  const adminSecret = req.query.secret === process.env.ADMIN_SECRET;
  if (!cronSecret && !adminSecret) return res.status(401).json({ error: "Unauthorized" });

  try {
    console.log("📊 Auto-log results triggered...");
    const result = await autoLogPickResults();
    res.json({ success: true, ...result, triggeredAt: new Date().toISOString() });
  } catch (err) {
    console.error("❌ Auto-log cron error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DAILY DIGEST ENDPOINT ───────────────────────────────────────────────────

/**
 * GET /api/digest/send
 * Manually trigger the daily digest webhook.
 * Protected by admin secret.
 */
app.get("/api/digest/send", async (req, res) => {
  const adminSecret = req.query.secret === process.env.ADMIN_SECRET;
  const cronSecret = req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
  if (!adminSecret && !cronSecret) return res.status(401).json({ error: "Unauthorized" });

  try {
    if (!process.env.DISCORD_WEBHOOK_URL) {
      return res.json({ skipped: true, reason: "DISCORD_WEBHOOK_URL not set" });
    }
    const result = await buildDailyDigest();
    res.json({ success: true, ...result });
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

// ─── AGENT AUTO-RUN SYSTEM ───────────────────────────────────────────────────

/**
 * Check current ET hour and auto-run the premium agent once per day
 * after AGENT_AUTO_RUN_TIME. Called every 30 minutes via setInterval.
 */
async function checkAndAutoRunAgent() {
  try {
    const etHourStr = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    });
    const etHour = parseInt(etHourStr, 10);

    if (etHour < AGENT_AUTO_RUN_TIME) return; // Too early

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (agentAutoRun.lastRun === today) return; // Already ran today

    // Skip odds API call if picks cache is still fresh (under 4 hours)
    if (isCacheValid(cache.picks)) {
      console.log('⏸️  Auto-run skipped — picks cache still fresh (under 4 hours)');
      return;
    }

    console.log(`🤖 Auto-running premium agent at ${etHour}:xx ET...`);
    agentAutoRun.status = 'running';

    const { games } = await fetchMLBOdds();
    if (!games || games.length === 0) {
      agentAutoRun.status = 'ready';
      console.log('⏸️  No games today — skipping agent auto-run');
      return;
    }

    const cachedEnriched = getEnrichedCache();
    const picks = applyPickFilters(analyzePicks(games, cachedEnriched));
    await getPremiumPick(picks);

    const { getDailyPicks: verifyDailyPicks } = require('./supabase');
    const existing = await verifyDailyPicks(today);
    if (existing.length === 0) {
      console.log('⚠️ Supabase save may have failed — picks not found after agent run');
    } else {
      console.log(`✅ ${existing.length} daily picks confirmed in Supabase for ${today}`);
    }

    agentAutoRun.lastRun = today;
    agentAutoRun.lastRunTime = new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
    }) + ' ET';
    agentAutoRun.status = 'ready';
    console.log(`✅ Agent auto-run complete — picks cached for today`);
  } catch (err) {
    console.error('❌ Agent auto-run failed:', err.message);
    agentAutoRun.status = 'failed';
  }
}

/**
 * GET /api/cron/auto-run-agent
 * Vercel Cron endpoint — fires at 15:00 UTC (11:00 AM ET) daily.
 * Also callable manually from the admin dashboard.
 */
app.get("/api/cron/auto-run-agent", async (req, res) => {
  const cronSecret = req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
  const adminSecret = req.query.secret === process.env.ADMIN_SECRET;
  if (!cronSecret && !adminSecret) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Skip odds API call if picks cache is still fresh (under 4 hours)
    if (isCacheValid(cache.picks)) {
      console.log('⏸️  Cron auto-run skipped — picks cache still fresh (under 4 hours)');
      return res.json({ success: true, message: 'Skipped — picks cache still fresh (under 4 hours)', cached: true });
    }

    agentAutoRun.status = 'running';

    const { games } = await fetchMLBOdds();
    if (!games || games.length === 0) {
      agentAutoRun.status = 'ready';
      return res.json({ success: true, message: 'No games today — agent skipped', picks: 0 });
    }

    const picks = applyPickFilters(analyzePicks(games));
    const result = await getPremiumPick(picks);

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    agentAutoRun.lastRun = today;
    agentAutoRun.lastRunTime = new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
    }) + ' ET';
    agentAutoRun.status = 'ready';

    console.log('✅ Cron: Agent auto-run complete');

    // Fire daily digest after agent runs (best-effort, non-blocking)
    buildDailyDigest().catch(err => console.error('Digest error (non-blocking):', err.message));

    return res.json({
      success: true,
      message: 'Premium agent ran successfully',
      picks: result.picks?.length || 0,
      cached: result.cached || false,
      ranAt: agentAutoRun.lastRunTime,
    });
  } catch (err) {
    agentAutoRun.status = 'failed';
    console.error('❌ Cron agent auto-run failed:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/cache-bypass
 * Toggles CACHE_BYPASS on/off. When enabled, /api/picks always fetches fresh data.
 * Protected by admin secret.  Body: { secret, enable? } — omit `enable` to toggle.
 */
app.post("/api/admin/cache-bypass", (req, res) => {
  const secret = req.body?.secret || req.query.secret || req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden. Admin secret required.' });
  }
  // Explicit enable/disable if provided, otherwise toggle
  if (typeof req.body?.enable === 'boolean') {
    CACHE_BYPASS = req.body.enable;
  } else {
    CACHE_BYPASS = !CACHE_BYPASS;
  }
  console.log(`🔧 CACHE_BYPASS set to ${CACHE_BYPASS}`);
  res.json({ cacheBypas: CACHE_BYPASS, message: CACHE_BYPASS ? 'Cache bypass ENABLED — every /api/picks call hits the Odds API.' : 'Cache bypass DISABLED — normal TTL caching resumed.' });
});

// ─── ADMIN DASHBOARD ─────────────────────────────────────────────────────────

/**
 * GET /api/admin/status
 * Returns all admin dashboard data as JSON.
 * Called by admin.html on load — no more server-side template rendering.
 */
app.get("/api/admin/status", async (req, res) => {
  const secret = req.query.secret || req.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Fetch all stats in parallel
  const [oddsQuota, dbStats] = await Promise.allSettled([
    fetchQuota(),
    (async () => {
      const usersRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/users?select=count`, {
        headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}`, Prefer: 'count=exact' }
      });
      const betsRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/bets?select=count`, {
        headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}`, Prefer: 'count=exact' }
      });
      return {
        users: usersRes.headers.get('content-range')?.split('/')[1] || '0',
        bets: betsRes.headers.get('content-range')?.split('/')[1] || '0',
      };
    })(),
  ]);

  const quota = oddsQuota.status === 'fulfilled' ? oddsQuota.value : { remaining: 'N/A', used: 'N/A' };
  const db = dbStats.status === 'fulfilled' ? dbStats.value : { users: 0, bets: 0 };

  const { lastRefresh, nextRefresh } = getScheduledTimes();
  const cacheAgeMs = cache.picks.fetchedAt ? Date.now() - cache.picks.fetchedAt : null;

  const openingDay = new Date('2026-03-25T16:05:00-04:00');
  const now = new Date();
  const seasonStarted = now >= openingDay;
  const daysUntilOpening = Math.ceil((openingDay - now) / (1000 * 60 * 60 * 24));

  res.json({
    timestamp: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    uptime: Math.floor(process.uptime() / 60),
    nodeVersion: process.version,
    heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),

    quota: {
      remaining: quota.remaining,
      used: quota.used,
      limit: 500,
    },

    db: {
      users: db.users,
      bets: db.bets,
      provider: 'Supabase',
    },

    agent: {
      status: agentAutoRun.status,
      lastRun: agentAutoRun.lastRunTime || null,
      lastRunDate: agentAutoRun.lastRun || null,
      freeModel: 'claude-sonnet',
      premiumModel: 'claude-opus',
    },

    cache: {
      isValid: isCacheValid(cache.picks),
      hasData: !!cache.picks.data,
      fetchedAt: cache.picks.fetchedAt ? new Date(cache.picks.fetchedAt).toISOString() : null,
      ageMinutes: cacheAgeMs !== null ? Math.floor(cacheAgeMs / 60000) : null,
      picksCount: cache.picks.data?.total || 0,
      gamesAnalyzed: cache.picks.data?.gamesAnalyzed || 0,
      bypass: CACHE_BYPASS,
      lastRefresh: lastRefresh ? lastRefresh.toISOString() : null,
      nextRefresh: nextRefresh ? nextRefresh.toISOString() : null,
    },

    season: {
      started: seasonStarted,
      openingDay: '2026-03-25',
      daysUntilOpening: seasonStarted ? 0 : daysUntilOpening,
      dataSource: seasonStarted ? 'Live (Supabase)' : 'Projections (pre-season)',
    },

    sharpMoney: {
      oddsApiUpgraded: ODDS_API_UPGRADED,
      booksTracked: ODDS_API_UPGRADED ? ['Pinnacle', 'Circa', 'Bookmaker'] : ['Pinnacle'],
      steamThreshold: 8,
      significantThreshold: 5,
    },

    split: {
      prizePoolEnabled: PRIZE_POOL_ENABLED,
      active: PRIZE_POOL_ENABLED
        ? { operations: 70, prizePool: 20, treasury: 10 }
        : {
            operations: Math.round(SPLIT_CONFIG.operations * 100),
            prizePool: Math.round(SPLIT_CONFIG.prizePool * 100),
            treasury: Math.round(SPLIT_CONFIG.treasury * 100),
          },
      wallets: {
        operations: OPERATIONS_WALLET,
        prizePool: PRIZE_POOL_WALLET,
        revenue: REVENUE_WALLET,
      },
    },
  });
});

/**
 * GET /admin
 * Serves the standalone admin.html file.
 * The HTML page fetches /api/admin/status on load for all dynamic data.
 */
app.get("/admin", (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).send(`
      <html><body style="background:#080B10;color:#FF3A5C;font-family:monospace;padding:40px;text-align:center">
        <h1>⛔ UNAUTHORIZED</h1><p>Invalid admin secret.</p>
      </body></html>
    `);
  }
  // Pass secret to the page via a safe meta tag — admin.html reads it from there
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="admin-secret" content="${secret}">
  <script>
    // Redirect to admin.html with secret in sessionStorage (not URL)
    sessionStorage.setItem('adminSecret', '${secret}');
    window.location.href = '/admin.html';
  </script>
</head>
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

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
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
  console.log(`\n⚡ Odds cache TTL: 4 hours (conserving API quota)`);
  console.log(`\n🤖 Agent auto-run: ${AGENT_AUTO_RUN_TIME}:00 AM ET daily (checks every 30 min)`);
  console.log(`\n⚾ Ready to find edges!\n`);

  // Auto-run agent check: every 30 minutes, fires once per day after AGENT_AUTO_RUN_TIME
  setInterval(checkAndAutoRunAgent, 30 * 60 * 1000);
  // Also check immediately on startup (in case server restarted after 11 AM)
  checkAndAutoRunAgent();
});

module.exports = app;
