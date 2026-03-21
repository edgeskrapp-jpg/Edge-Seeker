/**
 * agentRouter.js
 * Edge Seeker AI Agent — Routes between free and premium tiers
 *
 * FREE:    Claude Sonnet + basic odds data
 * PREMIUM: Claude Opus + full enriched data (pitcher stats, weather, line movement)
 */

const fetch = require("node-fetch");
const {
  FREE_SYSTEM_PROMPT,
  PREMIUM_SYSTEM_PROMPT,
  buildFreePrompt,
  buildPremiumPrompt,
} = require("./agentPrompt");
const { enrichPicks, fetchFanGraphsPitching } = require("./mlbDataEnricher");

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Cache today's picks so we don't call Claude on every request
const agentCache = {
  free: { data: null, date: null },
  premium: { data: null, date: null },
};

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

function isCacheValid(cacheEntry) {
  return cacheEntry.data && cacheEntry.date === getTodayDate();
}

/**
 * Call the Anthropic API
 */
async function callClaude(systemPrompt, userMessage, model = 'claude-sonnet-4-20250514') {
  if (!ANTHROPIC_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '{}';

  // Parse JSON response
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    console.error('Failed to parse Claude response:', text);
    throw new Error('Invalid JSON response from Claude');
  }
}

/**
 * FREE TIER — Claude Sonnet with basic odds data
 * Cached per day — only calls Claude once per day
 */
async function getFreePick(picks) {
  if (isCacheValid(agentCache.free)) {
    console.log('🤖 Returning cached free pick');
    return { ...agentCache.free.data, cached: true };
  }

  if (!picks || picks.length === 0) {
    return {
      pick: 'NO PICK',
      team: 'No games today',
      opponent: '',
      edge: '0%',
      odds: 'N/A',
      kelly: '0%',
      confidence: 0,
      grade: 'PASS',
      reasoning: 'No MLB games with sufficient edge today. Check back tomorrow.',
      warning: '',
      cached: false,
    };
  }

  console.log('🤖 Calling Claude Sonnet for free pick...');
  const userMessage = buildFreePrompt(picks);
  const result = await callClaude(FREE_SYSTEM_PROMPT, userMessage, 'claude-sonnet-4-20250514');

  agentCache.free = { data: result, date: getTodayDate() };
  return { ...result, cached: false };
}

/**
 * PREMIUM TIER — Claude Opus with full enriched data
 * Cached per day — only calls Claude Opus once per day
 */
async function getPremiumPick(picks) {
  if (isCacheValid(agentCache.premium)) {
    console.log('🤖 Returning cached premium pick');
    return { ...agentCache.premium.data, cached: true };
  }

  if (!picks || picks.length === 0) {
    return {
      pick: 'NO PICK',
      grade: 'PASS',
      reasoning: 'No games with sufficient edge today.',
      cached: false,
    };
  }

  console.log('🤖 Fetching enriched data for premium pick...');
  const enrichedData = await enrichPicks(picks);

  // Fetch FanGraphs FIP + bullpen data for all unique teams — premium only
  const uniqueTeams = [...new Set(picks.flatMap(p => [p.teamAbbr, p.opponentAbbr]).filter(Boolean))];
  console.log(`📊 Fetching FanGraphs data for ${uniqueTeams.length} teams...`);
  const fanGraphsResults = await Promise.all(
    uniqueTeams.map(abbr => fetchFanGraphsPitching(abbr).then(data => ({ abbr, data })))
  );
  const fanGraphsData = Object.fromEntries(fanGraphsResults.map(({ abbr, data }) => [abbr, data]));

  console.log('🤖 Calling Claude Opus for premium pick...');
  const userMessage = buildPremiumPrompt(picks, enrichedData, fanGraphsData);
  const result = await callClaude(PREMIUM_SYSTEM_PROMPT, userMessage, 'claude-opus-4-5');

  // Handle both old single pick format and new 2-pick format
  if (result.picks && Array.isArray(result.picks)) {
    // New format — array of picks
    result.enrichedData = enrichedData;
    agentCache.premium = { data: result, date: getTodayDate() };
    return { ...result, cached: false };
  } else {
    // Wrap single pick in array for consistency
    const wrapped = { picks: [result], enrichedData };
    agentCache.premium = { data: wrapped, date: getTodayDate() };
    return { ...wrapped, cached: false };
  }
}

/**
 * Invalidate cache (call this if you want to force a fresh pick)
 */
function invalidateCache() {
  agentCache.free = { data: null, date: null };
  agentCache.premium = { data: null, date: null };
}

module.exports = { getFreePick, getPremiumPick, invalidateCache };
