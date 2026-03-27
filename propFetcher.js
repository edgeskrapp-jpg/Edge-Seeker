/**
 * propFetcher.js
 * Fetches pitcher strikeout prop lines from The Odds API.
 *
 * Exports:
 *   fetchKPropLines(games) -> { "pitcher name": { line, overOdds, underOdds, book } }
 */

const fetch = require("node-fetch");

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// ─── CACHE ────────────────────────────────────────────────────────────────────

const kPropCache = {
  data: null,
  fetchedAt: null,
  ttl: 30 * 60 * 1000, // 30 minutes
};

function isCacheValid() {
  return kPropCache.data && Date.now() - kPropCache.fetchedAt < kPropCache.ttl;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Loose team name matcher — returns true if either name contains the other
 * (case-insensitive). Handles "Boston Red Sox" matching "Red Sox", etc.
 */
function teamsMatch(a, b) {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la.includes(lb) || lb.includes(la);
}

/**
 * Given an array of outcome objects from a single market, pick the best line
 * (lowest total juice = |overOdds| + |underOdds|) across all books.
 * Returns { line, overOdds, underOdds, book } or null.
 */
function bestLine(bookmakers) {
  let best = null;
  let bestJuice = Infinity;

  for (const book of bookmakers) {
    const market = book.markets?.find(m => m.key === "pitcher_strikeouts");
    if (!market) continue;

    // Group outcomes by description (pitcher name) then by point value
    const byPitcher = {};
    for (const outcome of market.outcomes) {
      const name = outcome.description?.toLowerCase();
      if (!name) continue;
      if (!byPitcher[name]) byPitcher[name] = {};
      const pt = outcome.point;
      if (!byPitcher[name][pt]) byPitcher[name][pt] = {};
      if (outcome.name === "Over") byPitcher[name][pt].over = outcome.price;
      if (outcome.name === "Under") byPitcher[name][pt].under = outcome.price;
      byPitcher[name][pt].pitcher = outcome.description;
    }

    for (const [pitcherKey, points] of Object.entries(byPitcher)) {
      for (const [pt, sides] of Object.entries(points)) {
        if (sides.over == null || sides.under == null) continue;
        const juice = Math.abs(sides.over) + Math.abs(sides.under);
        if (!best || !best[pitcherKey] || juice < (best[pitcherKey]?.juice ?? Infinity)) {
          if (!best) best = {};
          best[pitcherKey] = {
            line: parseFloat(pt),
            overOdds: sides.over,
            underOdds: sides.under,
            book: book.title,
            juice,
          };
        }
      }
    }
  }

  return best;
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────

/**
 * Fetch K prop lines for a set of games.
 * games: [{ home_team, away_team, id? }]
 * Returns: { "paul skenes": { line, overOdds, underOdds, book }, ... }
 */
async function fetchKPropLines(games) {
  if (!games || games.length === 0) return {};
  if (isCacheValid()) return kPropCache.data;

  if (!ODDS_API_KEY) {
    console.error("propFetcher: ODDS_API_KEY is not set");
    return {};
  }

  try {
    // Step 1: Fetch event list and match to provided games
    const eventsRes = await fetch(`${ODDS_API_BASE}/sports/baseball_mlb/events/?apiKey=${ODDS_API_KEY}`);
    if (eventsRes.status === 401 || eventsRes.status === 402) {
      const body = await eventsRes.json().catch(() => ({}));
      console.error(`propFetcher: Odds API quota/auth error (${eventsRes.status}):`, body.message || "");
      return {};
    }
    if (!eventsRes.ok) {
      console.error(`propFetcher: events fetch failed with status ${eventsRes.status}`);
      return {};
    }

    const events = await eventsRes.json();

    const matchedEventIds = [];
    for (const game of games) {
      const match = events.find(e =>
        teamsMatch(e.home_team, game.home_team) &&
        teamsMatch(e.away_team, game.away_team)
      );
      if (match) matchedEventIds.push(match.id);
    }

    if (matchedEventIds.length === 0) {
      console.warn("propFetcher: no Odds API events matched the provided games");
      return {};
    }

    // Step 2: Fetch props for each matched event
    const result = {};

    for (const eventId of matchedEventIds) {
      let propsRes;
      try {
        propsRes = await fetch(
          `${ODDS_API_BASE}/sports/baseball_mlb/events/${eventId}/odds/` +
          `?apiKey=${ODDS_API_KEY}&markets=pitcher_strikeouts&regions=us&oddsFormat=american`
        );
      } catch (fetchErr) {
        console.error(`propFetcher: network error fetching props for event ${eventId}:`, fetchErr.message);
        continue;
      }

      if (propsRes.status === 401 || propsRes.status === 402) {
        const body = await propsRes.json().catch(() => ({}));
        console.error(`propFetcher: Odds API quota/auth error on props (${propsRes.status}):`, body.message || "");
        return {};
      }
      if (!propsRes.ok) {
        console.error(`propFetcher: props fetch failed for event ${eventId}, status ${propsRes.status}`);
        continue;
      }

      const propsData = await propsRes.json();
      const lines = bestLine(propsData.bookmakers || []);
      if (!lines) continue;

      for (const [pitcherKey, lineData] of Object.entries(lines)) {
        const { juice, ...clean } = lineData;
        // Keep the best line across events if pitcher appears in multiple
        if (!result[pitcherKey] || lineData.juice < (result[pitcherKey]?._juice ?? Infinity)) {
          result[pitcherKey] = { ...clean, _juice: lineData.juice };
        }
      }
    }

    // Strip internal _juice field before caching/returning
    for (const key of Object.keys(result)) {
      delete result[key]._juice;
    }

    kPropCache.data = result;
    kPropCache.fetchedAt = Date.now();

    return result;

  } catch (err) {
    console.error("propFetcher: unexpected error in fetchKPropLines:", err.message);
    return {};
  }
}

module.exports = { fetchKPropLines };
