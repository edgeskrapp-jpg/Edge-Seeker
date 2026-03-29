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

// ─── TIER DEFINITIONS ─────────────────────────────────────────────────────────
const FREE_TIER_LAYERS = ['poisson', 'parkFactors', 'elo', 'oddsMovement'];
const PREMIUM_LAYERS = ['poisson', 'parkFactors', 'elo', 'oddsMovement', 'fip', 'fatigue', 'injuries', 'pinnacle', 'bullpen', 'weather', 'fanGraphs', 'statcast'];

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
  const today = new Date().toISOString().split('T')[0];
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
  const today = new Date().toISOString().split('T')[0];
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
  const today = new Date().toISOString().split('T')[0];

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
    const today = new Date().toISOString().split('T')[0];
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
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://rpc.ankr.com/solana';

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
    const enrichedData = await enrichPicks([{ home_team: home, away_team: away }]);
    const homeAbbr = home.split(" ").pop().substring(0, 3).toUpperCase();
    const awayAbbr = away.split(" ").pop().substring(0, 3).toUpperCase();
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

    const today = new Date().toISOString().split('T')[0];
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

    const today = new Date().toISOString().split('T')[0];
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

    const picks = applyPickFilters(analyzePicks(games));
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

    const today = new Date().toISOString().split('T')[0];
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

  // Cache schedule info
  const { lastRefresh: lastPicksRefresh, nextRefresh: nextPicksRefresh } = getScheduledTimes();
  const cacheValid = isCacheValid(cache.picks);
  const cacheAgeMin = cache.picks.fetchedAt ? Math.floor((Date.now() - cache.picks.fetchedAt) / 60000) : null;
  const lastRefreshStr = lastPicksRefresh
    ? lastPicksRefresh.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true })
    : 'N/A';
  const nextRefreshStr = nextPicksRefresh
    ? nextPicksRefresh.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true })
    : 'N/A';
  const cacheFetchedStr = cache.picks.fetchedAt
    ? new Date(cache.picks.fetchedAt).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true })
    : 'Never';

  // Overall system health — tiered quota thresholds
  const _qr = parseInt(oddsQuota.remaining);
  const quotaEmergency = !isNaN(_qr) && _qr < 50;   // red CRITICAL — auto-refresh paused
  const quotaCritical  = !isNaN(_qr) && _qr < 100;  // red warning
  const quotaWarning   = !isNaN(_qr) && _qr < 200;  // yellow warning
  const quotaOk        = isNaN(_qr) || _qr >= 200;
  const allHealthy     = quotaOk;
  const activeSplitPcts = PRIZE_POOL_ENABLED
    ? { ops: 70, pool: 20, treas: 10 }
    : { ops: Math.round(SPLIT_CONFIG.operations * 100), pool: Math.round(SPLIT_CONFIG.prizePool * 100), treas: Math.round(SPLIT_CONFIG.treasury * 100) };

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Edge Seeker Admin</title>
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
    <div class="logo">EDGE SEEKER ADMIN</div>
    <div class="subtitle">BACKEND DASHBOARD · RESTRICTED ACCESS</div>
    <div class="time">🕐 ${now} ET &nbsp;·&nbsp; Uptime: ${uptime} min</div>
  </div>
  <div class="status-pill">
    <div class="status-dot ${allHealthy ? 'ok' : 'warn'}"></div>
    <span class="${allHealthy ? 'c-green' : 'c-red'}">${allHealthy ? 'ALL SYSTEMS OK' : 'NEEDS ATTENTION'}</span>
  </div>
</div>

${quotaEmergency ? `<!-- QUOTA EMERGENCY -->
<div class="alert-banner" style="background:rgba(220,38,38,0.18);border-color:#dc2626">
  🚨 &nbsp;<strong>QUOTA CRITICAL — AUTO-REFRESH PAUSED</strong> — Only ${oddsQuota.remaining} requests remaining this month. Upgrade immediately.
  &nbsp;<a href="https://the-odds-api.com" target="_blank">Upgrade at the-odds-api.com →</a>
</div>` : quotaCritical ? `<!-- QUOTA CRITICAL -->
<div class="alert-banner" style="background:rgba(220,38,38,0.12);border-color:#dc2626">
  ❌ &nbsp;<strong>QUOTA CRITICAL</strong> — ${oddsQuota.remaining} requests remaining this month. Upgrade soon.
  &nbsp;<a href="https://the-odds-api.com" target="_blank">Upgrade at the-odds-api.com →</a>
</div>` : quotaWarning ? `<!-- QUOTA WARNING -->
<div class="alert-banner" style="background:rgba(245,166,35,0.12);border-color:#F5A623">
  ⚠️ &nbsp;<strong>QUOTA WARNING</strong> — ${oddsQuota.remaining} requests remaining this month.
  &nbsp;<a href="https://the-odds-api.com" target="_blank">Monitor at the-odds-api.com →</a>
</div>` : ''}

<!-- ═══════════════ ROW 1: ODDS · DB · AI ═══════════════ -->
<div class="section-label">System Status</div>
<div class="grid-3">

  <div class="card t-cyan">
    <div class="card-header">
      <span class="card-title">Odds API</span>
      <span class="card-badge ${quotaEmergency ? 'badge-red' : quotaCritical ? 'badge-red' : quotaWarning ? 'badge-yellow' : 'badge-green'}">${quotaEmergency ? 'CRITICAL' : quotaCritical ? 'CRITICAL' : quotaWarning ? 'LOW' : 'HEALTHY'}</span>
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
      <span class="card-badge ${agentAutoRun.status === 'running' ? 'badge-gold' : agentAutoRun.status === 'failed' ? 'badge-red' : 'badge-green'}">${agentAutoRun.status.toUpperCase()}</span>
    </div>
    <div class="row"><span class="row-label">Free model</span><span class="row-value c-white">claude-sonnet</span></div>
    <div class="row"><span class="row-label">Premium model</span><span class="row-value c-white">claude-opus</span></div>
    <div class="row"><span class="row-label">Auto-run times</span><span class="row-value c-gold">11:05 AM + 5:05 PM ET</span></div>
    <div class="row"><span class="row-label">Agent Last Run</span><span class="row-value ${agentAutoRun.lastRunTime ? 'c-green' : 'c-muted'}">${agentAutoRun.lastRunTime || 'Not yet today'}</span></div>
    <div class="row"><span class="row-label">Agent Status</span><span class="row-value ${agentAutoRun.status === 'ready' ? 'c-green' : agentAutoRun.status === 'running' ? 'c-gold' : 'c-red'}">${agentAutoRun.status === 'ready' ? '✅ Ready' : agentAutoRun.status === 'running' ? '⏳ Running...' : '❌ Failed'}</span></div>
    <div class="row"><span class="row-label">Runs per day</span><span class="row-value c-green">2× (morning + afternoon)</span></div>
  </div>

</div>

<!-- ═══════════════ ROW 1B: CACHE SCHEDULE ═══════════════ -->
<div class="section-label">Cache Schedule</div>
<div class="grid-3">

  <div class="card t-cyan">
    <div class="card-header">
      <span class="card-title">Picks Cache</span>
      <span class="card-badge ${cacheValid ? 'badge-green' : 'badge-red'}">${cacheValid ? 'FRESH' : 'STALE'}</span>
    </div>
    <div class="row"><span class="row-label">Status</span><span class="row-value ${cacheValid ? 'c-green' : 'c-red'}">${cacheValid ? '✅ Serving cached' : '⚠️ Will refresh on next call'}</span></div>
    <div class="row"><span class="row-label">Last fetched</span><span class="row-value c-white">${cacheFetchedStr} ET</span></div>
    <div class="row"><span class="row-label">Cache age</span><span class="row-value c-muted">${cacheAgeMin !== null ? cacheAgeMin + ' min' : 'Empty'}</span></div>
    <div class="row"><span class="row-label">Has data</span><span class="row-value ${cache.picks.data ? 'c-green' : 'c-red'}">${cache.picks.data ? `${cache.picks.data.total || 0} picks` : 'Empty'}</span></div>
  </div>

  <div class="card t-red" id="bypassCard">
    <div class="card-header">
      <span class="card-title">Cache Bypass</span>
      <span class="card-badge ${CACHE_BYPASS ? 'badge-red' : 'badge-green'}" id="bypassBadge">${CACHE_BYPASS ? 'LIVE — NO CACHE' : 'CACHED'}</span>
    </div>
    <div class="row"><span class="row-label">Bypass status</span><span class="row-value ${CACHE_BYPASS ? 'c-red' : 'c-green'}" id="bypassStatus">${CACHE_BYPASS ? '🔴 ENABLED — hitting API live' : '🟢 DISABLED — serving cache'}</span></div>
    <div class="row"><span class="row-label">Cache age</span><span class="row-value c-muted">${cacheAgeMin !== null ? cacheAgeMin + ' min' : 'Empty'}</span></div>
    <div class="row" style="margin-top:10px">
      <button onclick="toggleBypass()" id="bypassBtn" style="width:100%;padding:10px;border-radius:8px;border:none;cursor:pointer;font-family:'DM Mono',monospace;font-size:12px;font-weight:700;letter-spacing:1px;background:${CACHE_BYPASS ? '#22c55e' : '#ef4444'};color:#fff;transition:opacity 0.2s">
        ${CACHE_BYPASS ? '✅ DISABLE BYPASS' : '🔄 BYPASS CACHE'}
      </button>
    </div>
    <div class="row" style="margin-top:8px">
      <span style="font-family:'DM Mono',monospace;font-size:10px;color:#F5A623;letter-spacing:0.5px">⚠️ Bypass uses 1 API call per refresh — disable when done</span>
    </div>
  </div>

  <div class="card t-blue">
    <div class="card-header">
      <span class="card-title">Refresh Windows</span>
      <span class="card-badge badge-sol">2× DAILY</span>
    </div>
    <div class="row"><span class="row-label">Morning</span><span class="row-value c-cyan">11:00 AM ET</span></div>
    <div class="row"><span class="row-label">Afternoon</span><span class="row-value c-cyan">5:00 PM ET</span></div>
    <div class="row"><span class="row-label">Last window</span><span class="row-value c-white">${lastRefreshStr} ET</span></div>
    <div class="row"><span class="row-label">Next window</span><span class="row-value c-gold">${nextRefreshStr} ET</span></div>
  </div>

  <div class="card t-sol">
    <div class="card-header">
      <span class="card-title">API Budget</span>
      <span class="card-badge badge-green">2/DAY</span>
    </div>
    <div class="row"><span class="row-label">Calls per day</span><span class="row-value c-green">2 (odds refresh)</span></div>
    <div class="row"><span class="row-label">Calls per month</span><span class="row-value c-white">~62</span></div>
    <div class="row"><span class="row-label">Monthly quota</span><span class="row-value c-muted">500 (free tier)</span></div>
    <div class="row"><span class="row-label">Buffer remaining</span><span class="row-value c-green">~438 calls free</span></div>
  </div>

</div>

<!-- ═══════════════ SHARP MONEY ═══════════════ -->
<div class="section-label">Sharp Money</div>
<div class="grid-3">

  <div class="card t-red">
    <div class="card-header">
      <span class="card-title">Line Movement</span>
      <span class="card-badge ${ODDS_API_UPGRADED ? 'badge-green' : 'badge-gold'}">${ODDS_API_UPGRADED ? 'UPGRADED' : 'STANDARD'}</span>
    </div>
    <div class="row"><span class="row-label">Odds API Plan</span><span class="row-value ${ODDS_API_UPGRADED ? 'c-green' : 'c-gold'}">${ODDS_API_UPGRADED ? 'UPGRADED — All sharp books' : 'STANDARD — Pinnacle only'}</span></div>
    <div class="row"><span class="row-label">Sharp books tracked</span><span class="row-value c-white">${ODDS_API_UPGRADED ? 'Pinnacle, Circa, Bookmaker' : 'Pinnacle'}</span></div>
    <div class="row"><span class="row-label">Steam threshold</span><span class="row-value c-muted">8+ pts movement</span></div>
    <div class="row"><span class="row-label">Significant threshold</span><span class="row-value c-muted">5–7 pts</span></div>
    <div class="row"><span class="row-label">Upgrade flag</span><span class="row-value c-muted">ODDS_API_UPGRADED in server.js</span></div>
  </div>

  <div class="card t-red">
    <div class="card-header">
      <span class="card-title">Today's Signals</span>
      <span class="card-badge badge-red">LIVE</span>
    </div>
    <div class="row"><span class="row-label">Opening lines stored</span><span class="row-value c-white" id="adminOpeningLines">—</span></div>
    <div class="row"><span class="row-label">Significant moves</span><span class="row-value c-gold" id="adminSigMoves">—</span></div>
    <div class="row"><span class="row-label">Steam moves</span><span class="row-value c-red" id="adminSteamMoves">—</span></div>
    <div class="row"><span class="row-label">Last refresh</span><span class="row-value c-muted" id="adminSharpDate">—</span></div>
  </div>

  <div class="card t-red">
    <div class="card-header">
      <span class="card-title">Pick Impact</span>
      <span class="card-badge badge-green">TODAY</span>
    </div>
    <div class="row"><span class="row-label">Sharp confirms</span><span class="row-value c-green" id="adminSharpConfirm">—</span></div>
    <div class="row"><span class="row-label">Sharp fades</span><span class="row-value c-red" id="adminSharpFade">—</span></div>
    <div class="row"><span class="row-label">Steam confirms</span><span class="row-value c-green" id="adminSteamConfirm">—</span></div>
    <div class="row"><span class="row-label">Steam fades</span><span class="row-value c-red" id="adminSteamFade">—</span></div>
  </div>

</div>

<script>
// Load sharp money stats on page load
(async function loadSharpStats() {
  try {
    const r = await fetch('/api/sharp/movement');
    const d = await r.json();
    if (!d) return;
    document.getElementById('adminOpeningLines').textContent = d.openingLinesStored ?? '—';
    document.getElementById('adminSigMoves').textContent = d.significantMovesToday ?? '—';
    document.getElementById('adminSteamMoves').textContent = d.steamMovesToday ?? '—';
    document.getElementById('adminSharpDate').textContent = d.date ?? '—';
    // Count confirms / fades from pick data
    const picks = ${JSON.stringify(isCacheValid(cache.picks) ? (cache.picks.data?.picks || []) : [])};
    let confirms = 0, fades = 0, steamConf = 0, steamFade = 0;
    for (const p of picks) {
      const sig = p.pinnacleMovement?.sharpSignal;
      if (sig === 'strong_confirm') { confirms++; steamConf++; }
      else if (sig === 'confirm') confirms++;
      else if (sig === 'strong_fade') { fades++; steamFade++; }
      else if (sig === 'fade') fades++;
    }
    document.getElementById('adminSharpConfirm').textContent = confirms;
    document.getElementById('adminSharpFade').textContent = fades;
    document.getElementById('adminSteamConfirm').textContent = steamConf;
    document.getElementById('adminSteamFade').textContent = steamFade;
  } catch(e) {}
})();
</script>

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
  <a class="btn primary" href="/api/cron/auto-run-agent?secret=${secret}" target="_blank">🤖 Run Agent Now</a>
  <a class="btn danger" href="/admin/refresh-agent?secret=${secret}" target="_blank">🔄 Refresh Agent Cache</a>
  <a class="btn" href="/api/cron/auto-log-results?secret=${secret}" target="_blank">📊 Auto-Log Results</a>
  <a class="btn" href="/api/digest/send?secret=${secret}" target="_blank">📨 Send Digest</a>
  <a class="btn primary" href="/api/cron/refresh-picks?secret=${secret}" target="_blank">🔄 Refresh Picks Now</a>
  <a class="btn" href="/api/cache/status" target="_blank">📡 Cache Status</a>
  <a class="btn primary" href="/api/sharp/movement" target="_blank">⚡ Sharp Movement</a>
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
async function toggleBypass() {
  const btn = document.getElementById('bypassBtn');
  btn.disabled = true;
  btn.textContent = 'Working...';
  try {
    const res = await fetch('/api/admin/cache-bypass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: '${secret}' })
    });
    const data = await res.json();
    if (!res.ok) { alert('Error: ' + (data.error || res.status)); btn.disabled = false; return; }
    const enabled = data.cacheBypas; // note: matches server key
    document.getElementById('bypassBadge').textContent  = enabled ? 'LIVE — NO CACHE' : 'CACHED';
    document.getElementById('bypassBadge').className    = 'card-badge ' + (enabled ? 'badge-red' : 'badge-green');
    document.getElementById('bypassStatus').textContent = enabled ? '🔴 ENABLED — hitting API live' : '🟢 DISABLED — serving cache';
    document.getElementById('bypassStatus').className   = 'row-value ' + (enabled ? 'c-red' : 'c-green');
    btn.style.background  = enabled ? '#22c55e' : '#ef4444';
    btn.textContent       = enabled ? '✅ DISABLE BYPASS' : '🔄 BYPASS CACHE';
    btn.disabled = false;
  } catch (err) {
    alert('Request failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = '🔄 BYPASS CACHE';
  }
}

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
  console.log(`\n⚡ Odds cache TTL: 4 hours (conserving API quota)`);
  console.log(`\n🤖 Agent auto-run: ${AGENT_AUTO_RUN_TIME}:00 AM ET daily (checks every 30 min)`);
  console.log(`\n⚾ Ready to find edges!\n`);

  // Auto-run agent check: every 30 minutes, fires once per day after AGENT_AUTO_RUN_TIME
  setInterval(checkAndAutoRunAgent, 30 * 60 * 1000);
  // Also check immediately on startup (in case server restarted after 11 AM)
  checkAndAutoRunAgent();
});

module.exports = app;
