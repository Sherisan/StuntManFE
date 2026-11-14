// Pure crash-game maths shared by the engine and the UI.
//
// Bike It is a crash game on the GameEngineAPI ("Instant" engine, "Target" RNG
// model). The player's predicted landing distance IS their target multiplier:
// every metre past the ramp maps to one multiplier on a fixed curve. The
// server's provably fair RNG draws the round's crash point, the bike lands at
// that crash point's distance, and the bet pays stake × target when the
// crash point reaches the target (i.e. the bike lands at or past the pick).
// The server decides and pays the result; nothing here affects the payout,
// it only converts between metres and multipliers for display.

// The curve: 1.00× at 20m, ×e every 50m (≈1.82× at 50m, 4.95× at 100m, 36.6× at 200m).
export const BASE_DIST = 20;
export const DIST_PER_E = 50;
// Matches "MaxMultiplier" for bike-it in the API's appsettings.json (also read
// at runtime from api/play/info, see App.jsx).
export const DEFAULT_MAX_MULT = 100;
// House edge of the Target model: chance a crash point reaches x is 96% ÷ x.
export const RTP = 0.96;

export const MIN_TARGET = 1.01;
export const PRED_MIN = Math.ceil(distForMult(MIN_TARGET)); // 21m → 1.02×

export function maxPred(maxMult = DEFAULT_MAX_MULT) {
  return Math.floor(distForMult(maxMult));
}

export function distForMult(m) {
  return BASE_DIST + DIST_PER_E * Math.log(Math.max(1, m));
}

// Multiplier shown live while the bike flies (no rounding floor at 1.01).
export function multAtDist(d) {
  return Math.exp((Math.max(BASE_DIST, d) - BASE_DIST) / DIST_PER_E);
}

// The target the API is asked to play for a predicted distance: 2 decimals,
// clamped to what the API accepts (1.01 – MaxMultiplier).
export function targetForPred(pred, maxMult = DEFAULT_MAX_MULT) {
  const m = Math.floor(multAtDist(pred) * 100) / 100;
  return Math.min(maxMult, Math.max(MIN_TARGET, m));
}

// Clamp a typed/saved prediction into the playable range.
export function clampPred(pred, maxMult = DEFAULT_MAX_MULT) {
  const p = Math.round(Number(pred) || 80);
  return Math.min(maxPred(maxMult), Math.max(PRED_MIN, p));
}

// Where the bike lands for the server's crash point. Kept consistent with the
// server's verdict: a winning round lands at or past the pick, a losing one
// short of it (the curve's rounding can't flip what the player sees).
export function landingDist(crashPoint, pred, won) {
  const d = Math.floor(distForMult(crashPoint));
  return won ? Math.max(d, pred) : Math.max(0, Math.min(d, pred - 1));
}

// Chance this target wins, for the bet slip.
export function winChance(target) {
  return Math.min(1, RTP / target);
}

export const fmtMult = (m) => `${m.toFixed(2)}×`;

// Rounds money down to the cent like the server does (MidpointRounding.ToZero),
// with a nudge so float error (10 × 3.32 = 33.1999…) doesn't lose a cent.
export const floorCents = (v) => Math.floor(v * 100 + 1e-6) / 100;

// Example rungs of the ladder for the rules panels and the menu. `key` reuses
// the existing colour classes (t-close / t-great / t-bullseye).
export const PAYOUT_TIERS = [50, 100, 200].map((d, i) => {
  const mult = targetForPred(d);
  return {
    key: ['close', 'great', 'bullseye'][i],
    icon: ['👍', '🔥', '🎯'][i],
    label: `Land ${d}m+`,
    range: `${Math.round(winChance(mult) * 100)}% chance`,
    dist: d,
    mult,
  };
});
