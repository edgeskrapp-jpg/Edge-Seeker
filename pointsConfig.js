/**
 * pointsConfig.js
 * Edge Seeker — Tunable Points Engine
 *
 * Change any value here to adjust how points are earned.
 * No other files need to be touched.
 */

const POINTS_CONFIG = {

  // ─── BASE POINTS ────────────────────────────────────────────────────────────
  WIN:  100,
  LOSS: 0,
  PUSH: 10,

  // ─── STREAK MULTIPLIERS ──────────────────────────────────────────────────────
  STREAK_MULTIPLIERS: {
    2: 1.25,
    3: 1.50,
    5: 2.00,
    10: 3.00,
  },

  // ─── EDGE SEEKER PICK BONUS ──────────────────────────────────────────────────
  EDGE_PICK_MULTIPLIER: 1.5,

  // ─── CONSISTENCY BONUS ───────────────────────────────────────────────────────
  DAILY_LOGIN_BONUS: 5,
  STREAK_3_DAYS: 25,
  STREAK_7_DAYS: 75,
  STREAK_30_DAYS: 300,

  // ─── ACCURACY TIERS ──────────────────────────────────────────────────────────
  ACCURACY_TIERS: [
    { minWinRate: 0.70, bonus: 200, label: "Elite"    },
    { minWinRate: 0.60, bonus: 100, label: "Sharp"    },
    { minWinRate: 0.55, bonus: 50,  label: "Solid"    },
    { minWinRate: 0.50, bonus: 20,  label: "Even"     },
  ],

  // ─── SOURCE MULTIPLIERS ───────────────────────────────────────────────────────
  SOURCE_MULTIPLIERS: {
    manual:      1.0,
    kalshi:      1.2,
    polymarket:  1.2,
    draftkings:  1.0,
    fanduel:     1.0,
    betmgm:      1.0,
  },

  WEEKLY_RESET_DAY: 1,
};

function calculateBetPoints(bet) {
  const { result, source = 'manual', isEdgePick = false, streakCount = 0 } = bet;

  let base = 0;
  if (result === 'win')       base = POINTS_CONFIG.WIN;
  else if (result === 'loss') base = POINTS_CONFIG.LOSS;
  else if (result === 'push') base = POINTS_CONFIG.PUSH;
  else return 0;

  const sourceMult = POINTS_CONFIG.SOURCE_MULTIPLIERS[source] || 1.0;
  base = Math.round(base * sourceMult);

  if (isEdgePick && result === 'win') {
    base = Math.round(base * POINTS_CONFIG.EDGE_PICK_MULTIPLIER);
  }

  if (result === 'win' && streakCount >= 2) {
    const streakKeys = Object.keys(POINTS_CONFIG.STREAK_MULTIPLIERS)
      .map(Number).sort((a, b) => b - a);
    for (const threshold of streakKeys) {
      if (streakCount >= threshold) {
        base = Math.round(base * POINTS_CONFIG.STREAK_MULTIPLIERS[threshold]);
        break;
      }
    }
  }

  return base;
}

function getAccuracyBonus(winRate) {
  for (const tier of POINTS_CONFIG.ACCURACY_TIERS) {
    if (winRate >= tier.minWinRate) return { bonus: tier.bonus, label: tier.label };
  }
  return { bonus: 0, label: 'Developing' };
}

module.exports = { POINTS_CONFIG, calculateBetPoints, getAccuracyBonus };
