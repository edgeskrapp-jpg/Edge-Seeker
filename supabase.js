/**
 * supabase.js
 * Supabase client for Edge Seeker backend
 */

const fetch = require("node-fetch");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Simple Supabase REST client using node-fetch
async function supabaseQuery(table, method = 'GET', body = null, filters = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${filters}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? 'return=representation' : 'return=representation',
  };

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error ${res.status}: ${err}`);
  }
  return res.json();
}

// ─── USER HELPERS ────────────────────────────────────────────────────────────

async function getUser(walletAddress) {
  const rows = await supabaseQuery('users', 'GET', null, `?wallet_address=eq.${walletAddress}`);
  return rows[0] || null;
}

async function upsertUser(walletAddress, username = null) {
  const existing = await getUser(walletAddress);
  if (existing) {
    if (username && username !== existing.username) {
      const rows = await supabaseQuery('users', 'PATCH', { username }, `?wallet_address=eq.${walletAddress}`);
      return rows[0];
    }
    return existing;
  }
  const rows = await supabaseQuery('users', 'POST', { wallet_address: walletAddress, username });
  return rows[0];
}

// ─── BETS HELPERS ─────────────────────────────────────────────────────────────

async function saveBet(bet) {
  const rows = await supabaseQuery('bets', 'POST', bet);
  return rows[0];
}

async function getUserBets(walletAddress) {
  return supabaseQuery('bets', 'GET', null, `?wallet_address=eq.${walletAddress}&order=created_at.desc`);
}

async function updateBetResult(betId, result, pointsEarned) {
  const rows = await supabaseQuery('bets', 'PATCH', { result, points_earned: pointsEarned }, `?id=eq.${betId}`);
  return rows[0];
}

// ─── POINTS HELPERS ───────────────────────────────────────────────────────────

async function getPoints(walletAddress) {
  const rows = await supabaseQuery('points', 'GET', null, `?wallet_address=eq.${walletAddress}`);
  return rows[0] || { total_points: 0, weekly_points: 0 };
}

async function addPoints(walletAddress, points) {
  const existing = await getPoints(walletAddress);
  const now = new Date();
  const weekStart = new Date(now.setDate(now.getDate() - now.getDay() + 1)).toISOString().split('T')[0];

  if (!existing.wallet_address) {
    return supabaseQuery('points', 'POST', {
      wallet_address: walletAddress,
      total_points: points,
      weekly_points: points,
      week_start: weekStart,
    });
  } else {
    const sameWeek = existing.week_start === weekStart;
    return supabaseQuery('points', 'PATCH', {
      total_points: (existing.total_points || 0) + points,
      weekly_points: sameWeek ? (existing.weekly_points || 0) + points : points,
      week_start: weekStart,
      updated_at: new Date().toISOString(),
    }, `?wallet_address=eq.${walletAddress}`);
  }
}

// ─── LEADERBOARD ─────────────────────────────────────────────────────────────

async function getLeaderboard(type = 'all_time', limit = 50) {
  const orderField = type === 'weekly' ? 'weekly_points' : 'total_points';
  const pointsRows = await supabaseQuery('points', 'GET', null,
    `?order=${orderField}.desc&limit=${limit}`
  );

  // Enrich with usernames
  const enriched = await Promise.all(pointsRows.map(async (row) => {
    try {
      const user = await getUser(row.wallet_address);
      return {
        ...row,
        username: user?.username || null,
        display: user?.username || `${row.wallet_address.slice(0,4)}...${row.wallet_address.slice(-4)}`,
      };
    } catch {
      return {
        ...row,
        username: null,
        display: `${row.wallet_address.slice(0,4)}...${row.wallet_address.slice(-4)}`,
      };
    }
  }));

  return enriched;
}

// ─── DAILY PICKS ─────────────────────────────────────────────────────────────

async function saveDailyPicks(picks, date) {
  const pickDate = date || new Date().toISOString().split('T')[0];
  let saved = 0;
  for (let i = 0; i < picks.length; i++) {
    const rank = i + 1;
    await supabaseQuery(
      'daily_picks',
      'POST',
      { pick_date: pickDate, rank, tier: 'premium', pick: picks[i] },
      '?on_conflict=pick_date,rank'
    );
    saved++;
  }
  return { saved };
}

async function getDailyPicks(date) {
  const pickDate = date || new Date().toISOString().split('T')[0];
  const rows = await supabaseQuery(
    'daily_picks',
    'GET',
    null,
    `?pick_date=eq.${pickDate}&order=rank.asc`
  );
  return rows.map(r => r.pick);
}

module.exports = {
  supabaseQuery,
  getUser, upsertUser,
  saveBet, getUserBets, updateBetResult,
  getPoints, addPoints,
  getLeaderboard,
  saveDailyPicks, getDailyPicks,
};
