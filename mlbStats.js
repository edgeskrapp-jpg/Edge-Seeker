/**
 * mlbStats.js
 * Edge Seeker — 2026 MLB Team Statistics
 *
 * Updated for 2026 Opening Day using:
 * - FanGraphs ZiPS/Steamer projected team run totals
 * - Bleacher Report Opening Day lineup projections (Version 4.0)
 * - CBS Sports Opening Day starter tracker
 * - ESPN lineup rankings
 *
 * Key 2026 offseason moves factored in:
 * - Kyle Tucker → LAD (massive offensive upgrade)
 * - Alex Bregman → CHC
 * - Cody Bellinger → NYY
 * - Bo Bichette → NYM
 * - Nolan Arenado → ARI
 * - Gerrit Cole (TJS recovery, back May/June) — NYY weaker to start
 * - Carlos Rodón (elbow surgery, back April/May) — NYY weaker to start
 * - Juan Soto → NYM (6.1 WAR projected)
 * - Pete Alonso → BAL
 * - Christian Walker → HOU
 *
 * Update weekly during season from:
 * baseball-reference.com/leagues/majors/2026.shtml
 */

const MLB_TEAM_STATS = {
  // ── AMERICAN LEAGUE EAST ──────────────────────────────────────────────────
  NYY: { runsPerGame: 4.7, runsAllowedPerGame: 4.4, homeBonus: 0.15 },
  BOS: { runsPerGame: 4.6, runsAllowedPerGame: 4.2, homeBonus: 0.12 },
  TOR: { runsPerGame: 4.1, runsAllowedPerGame: 4.3, homeBonus: 0.10 },
  TB:  { runsPerGame: 4.2, runsAllowedPerGame: 3.9, homeBonus: 0.08 },
  BAL: { runsPerGame: 4.5, runsAllowedPerGame: 4.0, homeBonus: 0.12 },

  // ── AMERICAN LEAGUE CENTRAL ───────────────────────────────────────────────
  CLE: { runsPerGame: 4.3, runsAllowedPerGame: 3.8, homeBonus: 0.10 },
  MIN: { runsPerGame: 4.2, runsAllowedPerGame: 4.3, homeBonus: 0.10 },
  CWS: { runsPerGame: 3.7, runsAllowedPerGame: 5.1, homeBonus: 0.08 },
  KC:  { runsPerGame: 4.4, runsAllowedPerGame: 4.3, homeBonus: 0.10 },
  DET: { runsPerGame: 4.3, runsAllowedPerGame: 3.9, homeBonus: 0.12 },

  // ── AMERICAN LEAGUE WEST ──────────────────────────────────────────────────
  HOU: { runsPerGame: 4.7, runsAllowedPerGame: 3.8, homeBonus: 0.15 },
  TEX: { runsPerGame: 4.3, runsAllowedPerGame: 4.4, homeBonus: 0.12 },
  SEA: { runsPerGame: 4.1, runsAllowedPerGame: 3.7, homeBonus: 0.12 },
  OAK: { runsPerGame: 4.0, runsAllowedPerGame: 4.5, homeBonus: 0.08 },
  LAA: { runsPerGame: 4.2, runsAllowedPerGame: 4.6, homeBonus: 0.10 },

  // ── NATIONAL LEAGUE EAST ──────────────────────────────────────────────────
  ATL: { runsPerGame: 5.0, runsAllowedPerGame: 3.9, homeBonus: 0.15 },
  NYM: { runsPerGame: 4.8, runsAllowedPerGame: 4.0, homeBonus: 0.12 },
  PHI: { runsPerGame: 4.7, runsAllowedPerGame: 3.8, homeBonus: 0.15 },
  MIA: { runsPerGame: 3.7, runsAllowedPerGame: 4.6, homeBonus: 0.08 },
  WSH: { runsPerGame: 4.0, runsAllowedPerGame: 4.8, homeBonus: 0.08 },

  // ── NATIONAL LEAGUE CENTRAL ───────────────────────────────────────────────
  CHC: { runsPerGame: 4.6, runsAllowedPerGame: 4.1, homeBonus: 0.14 },
  MIL: { runsPerGame: 4.3, runsAllowedPerGame: 4.0, homeBonus: 0.12 },
  STL: { runsPerGame: 4.0, runsAllowedPerGame: 4.4, homeBonus: 0.10 },
  CIN: { runsPerGame: 4.4, runsAllowedPerGame: 4.5, homeBonus: 0.10 },
  PIT: { runsPerGame: 4.1, runsAllowedPerGame: 4.2, homeBonus: 0.10 },

  // ── NATIONAL LEAGUE WEST ──────────────────────────────────────────────────
  LAD: { runsPerGame: 5.5, runsAllowedPerGame: 3.6, homeBonus: 0.15 },
  SF:  { runsPerGame: 4.1, runsAllowedPerGame: 4.3, homeBonus: 0.12 },
  SD:  { runsPerGame: 4.4, runsAllowedPerGame: 4.0, homeBonus: 0.12 },
  ARI: { runsPerGame: 4.5, runsAllowedPerGame: 4.2, homeBonus: 0.12 },
  COL: { runsPerGame: 5.0, runsAllowedPerGame: 6.2, homeBonus: 0.25 },
};

/**
 * 2026 Opening Day starting pitchers
 * Source: CBS Sports Opening Day Starter Tracker
 */
const OPENING_DAY_STARTERS = {
  NYY: { name: "Fried",      hand: "L", note: "Cole/Rodón out — Fried is clear #1 starter" },
  BOS: { name: "Crochet",    hand: "L", note: "3rd consecutive Opening Day start" },
  TOR: { name: "Gausman",    hand: "R", note: "Scherzer joining rotation later" },
  TB:  { name: "Rasmussen",  hand: "R", note: "2.76 ERA, 1.02 WHIP in 2025, All-Star" },
  BAL: { name: "Rogers",     hand: "L", note: "Reigning Most Valuable Pitcher award" },
  CLE: { name: "Cantillo",   hand: "L", note: "Young rotation, high upside" },
  MIN: { name: "Paddack",    hand: "R", note: "" },
  CWS: { name: "Smith",      hand: "R", note: "Rule 5 pick from MIL, All-Star rookie 2025" },
  KC:  { name: "Wacha",      hand: "R", note: "" },
  DET: { name: "Skubal",     hand: "L", note: "AL Cy Young 2025" },
  HOU: { name: "Brown",      hand: "R", note: "3rd place AL Cy Young 2025, first OD start" },
  TEX: { name: "Eovaldi",    hand: "R", note: "" },
  SEA: { name: "Gilbert",    hand: "R", note: "Cal Raleigh MVP candidate" },
  OAK: { name: "Civale",     hand: "R", note: "" },
  LAA: { name: "Detmers",    hand: "L", note: "Healthy Trout in CF" },
  ATL: { name: "Sale",       hand: "L", note: "Acuña back healthy" },
  NYM: { name: "Peralta",    hand: "R", note: "Two-time All-Star, top-5 NL Cy Young 2025, Soto+Bichette+Lindor" },
  PHI: { name: "Sanchez",    hand: "L", note: "NL Cy Young candidate, 2.50 ERA in 2025" },
  MIA: { name: "Alcantara",  hand: "R", note: "Returning from Tommy John surgery" },
  WSH: { name: "Cavalli",    hand: "R", note: "Impressive TJS return, 4.25 ERA in 10 starts" },
  CHC: { name: "Boyd",       hand: "L", note: "3.21 ERA in 2025, career year, Bregman added" },
  MIL: { name: "Chourio",    hand: "R", note: "Peralta traded to NYM" },
  STL: { name: "Gray",       hand: "R", note: "Wetherholt top prospect" },
  CIN: { name: "Abbott",     hand: "L", note: "2.87 ERA in 2025, Greene injured — Abbott steps up" },
  PIT: { name: "Skenes",     hand: "R", note: "NL Cy Young 2025, generational talent" },
  LAD: { name: "Yamamoto",   hand: "R", note: "Ohtani+Tucker+Betts+Freeman — best lineup ever" },
  SF:  { name: "Webb",       hand: "R", note: "" },
  SD:  { name: "King",       hand: "R", note: "Tatis/Machado/Bogaerts core" },
  ARI: { name: "Gallen",     hand: "R", note: "Arenado trade, Carroll health concern" },
  COL: { name: "Freeland",   hand: "L", note: "Coors effect — always factor wind direction" },
};

/**
 * Map from The Odds API team name strings → our abbreviations
 */
const TEAM_NAME_MAP = {
  "New York Yankees": "NYY",
  "Boston Red Sox": "BOS",
  "Toronto Blue Jays": "TOR",
  "Tampa Bay Rays": "TB",
  "Baltimore Orioles": "BAL",
  "Cleveland Guardians": "CLE",
  "Minnesota Twins": "MIN",
  "Chicago White Sox": "CWS",
  "Kansas City Royals": "KC",
  "Detroit Tigers": "DET",
  "Houston Astros": "HOU",
  "Texas Rangers": "TEX",
  "Seattle Mariners": "SEA",
  "Oakland Athletics": "OAK",
  "Los Angeles Angels": "LAA",
  "Atlanta Braves": "ATL",
  "New York Mets": "NYM",
  "Philadelphia Phillies": "PHI",
  "Miami Marlins": "MIA",
  "Washington Nationals": "WSH",
  "Chicago Cubs": "CHC",
  "Milwaukee Brewers": "MIL",
  "St. Louis Cardinals": "STL",
  "Cincinnati Reds": "CIN",
  "Pittsburgh Pirates": "PIT",
  "Los Angeles Dodgers": "LAD",
  "San Francisco Giants": "SF",
  "San Diego Padres": "SD",
  "Arizona Diamondbacks": "ARI",
  "Colorado Rockies": "COL",
};

/**
 * Get team stats by full name (as returned by The Odds API)
 */
function getTeamStats(fullName, liveStats = null) {
  const abbr = TEAM_NAME_MAP[fullName];
  if (!abbr) {
    return { runsPerGame: 4.3, runsAllowedPerGame: 4.3, homeBonus: 0.10, abbr: fullName.split(" ").pop().substring(0, 3).toUpperCase() };
  }

  // Use live stats from MLB API if available (updated daily by cron)
  if (liveStats && liveStats[abbr]) {
    const live = liveStats[abbr];
    const projection = MLB_TEAM_STATS[abbr] || {};
    return {
      runsPerGame: live.runs_per_game || projection.runsPerGame || 4.3,
      runsAllowedPerGame: live.runs_allowed_per_game || projection.runsAllowedPerGame || 4.3,
      homeBonus: projection.homeBonus || 0.10,
      abbr,
      source: 'live',
      gamesPlayed: live.games_played || 0,
    };
  }

  // Fall back to pre-season projections
  if (MLB_TEAM_STATS[abbr]) {
    return { ...MLB_TEAM_STATS[abbr], abbr, source: 'projection' };
  }

  return { runsPerGame: 4.3, runsAllowedPerGame: 4.3, homeBonus: 0.10, abbr, source: 'fallback' };
}

module.exports = { MLB_TEAM_STATS, TEAM_NAME_MAP, OPENING_DAY_STARTERS, getTeamStats };
