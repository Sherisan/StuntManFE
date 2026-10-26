// Pure scoring logic shared between the engine outcome and the UI.

// Maps the server's provably-fair crash multiplier (1.00 … up to 10000) into the
// bike engine's `crashAt` band. The transform is monotonic — a higher server
// multiplier always yields a longer flight — but log-compressed and capped so a
// rare huge multiplier can't launch a 30-second flight that overshoots every
// prediction. Landings then stay within roughly the 100–380m the UI targets.
export function serverMultToCrashAt(m) {
  if (!Number.isFinite(m) || m <= 1) return 1.01;
  const c = 1 + 3.2 * Math.log(m);
  return Math.max(1.01, Math.min(c, 15));
}

// Single source of truth for the payout ladder — drives both the scoring in
// calcPayout() and the rules UI (side panel + "How it works" modal), so the
// numbers shown to the player can never drift from what they're actually paid.
export const PAYOUT_TIERS = [
  { key: 'bullseye', icon: '🎯', label: 'Bullseye', range: 'Within 5%', tier: '🎯 BULLSEYE!', maxErr: 0.05, mult: 8 },
  { key: 'great', icon: '🔥', label: 'Great Call', range: '5–15% off', tier: '🔥 GREAT CALL', maxErr: 0.15, mult: 3 },
  { key: 'close', icon: '👍', label: 'Close Enough', range: '15–30% off', tier: '👍 CLOSE ENOUGH', maxErr: 0.30, mult: 1.5 },
];

// Single source of truth for both the payout tier AND the error% shown in the
// UI — App.jsx used to recompute the same `|actual-pred|/actual` formula
// separately for display, which could silently drift out of sync with the
// tier actually awarded here. Guards the `actual === 0` case (a genuine,
// if rare, possible landing distance) which would otherwise divide by zero
// and surface "Infinity%" in the result panel.
export function calcPayout(actual, pred) {
  const e = actual > 0 ? Math.abs(actual - pred) / actual : (pred > 0 ? Infinity : 0);
  const hit = PAYOUT_TIERS.find(t => e <= t.maxErr);
  const errPct = Number.isFinite(e) ? Math.round(e * 100) : 999;
  return hit ? { mult: hit.mult, tier: hit.tier, errPct } : { mult: 0, tier: '❌ MISSED IT', errPct };
}
