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

export function calcPayout(actual, pred) {
  const e = Math.abs(actual - pred) / actual;
  if (e <= 0.05) return { mult: 8, tier: '🎯 BULLSEYE!' };
  if (e <= 0.15) return { mult: 3, tier: '🔥 GREAT CALL' };
  if (e <= 0.30) return { mult: 1.5, tier: '👍 CLOSE ENOUGH' };
  return { mult: 0, tier: '❌ MISSED IT' };
}
