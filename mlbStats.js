/**
 * mlbStats.js
 * MLB team run averages for the current season.
 *
 * These drive the Poisson model. Update these periodically
 * (weekly is fine) as the season progresses.
 *
 * Source: Baseball Reference / FanGraphs team stats
 * Last updated: March 2026 (Opening Day estimates — update after ~2 weeks of play)
 *
 * Format: "TEAM_ABBR": { runsPerGame, runsAllowedPerGame, homeBonus }
 * homeBonus: small boost applied when team is at home (~0.1-0.2 runs)
 */

const MLB_TEAM_STATS = {
  // American League East
  NYY: { runsPerGame: 4.8, runsAllowedPerGame: 4.1, homeBonus: 0.15 },
  BOS: { runsPerGame: 4.5, runsAllowedPerGame: 4.4, homeBonus: 0.12 },
  TOR: { runsPerGame: 4.3, runsAllowedPerGame: 4.3, homeBonus: 0.10 },
  TB:  { runsPerGame: 4.2, runsAllowedPerGame: 3.9, homeBonus: 0.10 },
  BAL: { runsPerGame: 4.6, runsAllowedPerGame: 4.0, homeBonus: 0.12 },

  // American League Central
  CLE: { runsPerGame: 4.2, runsAllowedPerGame: 3.7, homeBonus: 0.10 },
  MIN: { runsPerGame: 4.4, runsAllowedPerGame: 4.2, homeBonus: 0.12 },
  CWS: { runsPerGame: 3.8, runsAllowedPerGame: 5.0, homeBonus: 0.08 },
  KC:  { runsPerGame: 4.3, runsAllowedPerGame: 4.4, homeBonus: 0.10 },
  DET: { runsPerGame: 4.1, runsAllowedPerGame: 4.0, homeBonus: 0.10 },

  // American League West
  HOU: { runsPerGame: 4.6, runsAllowedPerGame: 3.8, homeBonus: 0.15 },
  TEX: { runsPerGame: 4.4, runsAllowedPerGame: 4.3, homeBonus: 0.12 },
  SEA: { runsPerGame: 4.2, runsAllowedPerGame: 3.9, homeBonus: 0.12 },
  OAK: { runsPerGame: 3.9, runsAllowedPerGame: 4.6, homeBonus: 0.08 },
  LAA: { runsPerGame: 4.0, runsAllowedPerGame: 4.5, homeBonus: 0.10 },

  // National League East
  ATL: { runsPerGame: 5.1, runsAllowedPerGame: 3.9, homeBonus: 0.15 },
  NYM: { runsPerGame: 4.4, runsAllowedPerGame: 4.1, homeBonus: 0.12 },
  PHI: { runsPerGame: 4.7, runsAllowedPerGame: 4.0, homeBonus: 0.15 },
  MIA: { runsPerGame: 3.8, runsAllowedPerGame: 4.8, homeBonus: 0.08 },
  WSH: { runsPerGame: 4.0, runsAllowedPerGame: 4.7, homeBonus: 0.08 },

  // National League Central
  CHC: { runsPerGame: 4.3, runsAllowedPerGame: 4.3, homeBonus: 0.12 },
  MIL: { runsPerGame: 4.4, runsAllowedPerGame: 4.1, homeBonus: 0.12 },
  STL: { runsPerGame: 4.2, runsAllowedPerGame: 4.2, homeBonus: 0.10 },
  CIN: { runsPerGame: 4.5, runsAllowedPerGame: 4.6, homeBonus: 0.10 },
  PIT: { runsPerGame: 3.9, runsAllowedPerGame: 4.5, homeBonus: 0.08 },

  // National League West
  LAD: { runsPerGame: 5.2, runsAllowedPerGame: 3.7, homeBonus: 0.15 },
  SF:  { runsPerGame: 4.2, runsAllowedPerGame: 4.2, homeBonus: 0.12 },
  SD:  { runsPerGame: 4.4, runsAllowedPerGame: 4.0, homeBonus: 0.12 },
  ARI: { runsPerGame: 4.5, runsAllowedPerGame: 4.3, homeBonus: 0.12 },
  COL: { runsPerGame: 4.6, runsAllowedPerGame: 5.3, homeBonus: 0.20 }, // Coors Field boost
};

/**
 * Map from The Odds API team name strings → our abbreviations
 * The API returns full city+team names like "New York Yankees"
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
 * Falls back to league average if team not found
 */
function getTeamStats(fullName) {
  const abbr = TEAM_NAME_MAP[fullName];
  if (abbr && MLB_TEAM_STATS[abbr]) {
    return { ...MLB_TEAM_STATS[abbr], abbr };
  }
  // League average fallback
  return { runsPerGame: 4.3, runsAllowedPerGame: 4.3, homeBonus: 0.10, abbr: fullName.split(" ").pop().substring(0, 3).toUpperCase() };
}

module.exports = { MLB_TEAM_STATS, TEAM_NAME_MAP, getTeamStats };
