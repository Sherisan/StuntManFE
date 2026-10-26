import { PAYOUT_TIERS } from '../game/logic.js';

// Visualizes the payout ladder as zones along an error-percentage axis, so the
// tier table's numbers ("within 5%", "8×") read as one glanceable shape instead
// of rows to cross-reference. `markerPct` (when given) plots where a round's
// actual error landed, tying a specific result back to the rule that paid it.
export function AccuracyBar({ markerPct, compact }) {
  const zones = [];
  let prev = 0;
  for (const t of PAYOUT_TIERS) {
    zones.push({ key: t.key, icon: t.icon, mult: t.mult, from: prev, to: t.maxErr * 100 });
    prev = t.maxErr * 100;
  }
  const missSpan = prev * 0.6;
  zones.push({ key: 'miss', icon: '❌', mult: 0, from: prev, to: prev + missSpan });
  const total = prev + missSpan;

  return (
    <div className={'accuracy-bar' + (compact ? ' compact' : '')}>
      <div className="accuracy-track">
        {zones.map(z => (
          <div key={z.key} className={`accuracy-zone az-${z.key}`} style={{ flexGrow: z.to - z.from }}>
            <span className="az-icon">{z.icon}</span>
            {!compact && <span className="az-mult">{z.mult > 0 ? `${z.mult}×` : '—'}</span>}
          </div>
        ))}
        {markerPct != null && (
          <div className="accuracy-marker" style={{ left: `${Math.min(markerPct, total) / total * 100}%` }} />
        )}
      </div>
      <div className="accuracy-scale">
        <span>0%</span>
        {PAYOUT_TIERS.map(t => <span key={t.key}>{Math.round(t.maxErr * 100)}%</span>)}
        <span>{Math.round(total)}%+</span>
      </div>
    </div>
  );
}

const money = (v) => `R${v.toFixed(2)}`;

export function SessionCard({ streak, stats }) {
  const net = stats.returned - stats.wagered;
  const winRate = stats.bets ? Math.round((stats.wins / stats.bets) * 100) : 0;
  const streakText = streak.current > 0
    ? `${streak.current} ${streak.type === 'win' ? 'WIN' : 'LOSS'}${streak.current > 1 ? (streak.type === 'win' ? 'S' : 'ES') : ''} IN A ROW`
    : 'No rounds yet';
  return (
    <section className="info-card">
      <div className="info-title">Session</div>
      <div className="session-streak">
        <span className={'session-badge' + (streak.type ? ` is-${streak.type}` : '')}>{streakText}</span>
        {streak.best > 0 && <span className="session-best">Best 🔥 {streak.best}</span>}
      </div>
      <div className="session-stats">
        <div><span>Net</span><b className={net > 0 ? 'pos' : net < 0 ? 'neg' : ''}>{net >= 0 ? '+' : '−'}{money(Math.abs(net))}</b></div>
        <div><span>Rounds</span><b>{stats.rounds}</b></div>
        <div><span>Win rate</span><b>{winRate}%</b></div>
      </div>
    </section>
  );
}

export function RecentRounds({ history }) {
  // Both bet slips of a round share one timestamp — show one chip per round.
  const rounds = history.filter((h, i, arr) => arr.findIndex((o) => o.time === h.time) === i).slice(0, 12);
  return (
    <section className="info-card recent-card">
      <div className="info-title">Recent rounds</div>
      {rounds.length === 0 && <div className="info-empty">Your results will show up here.</div>}
      <div className="recent-grid">
        {rounds.map((r) => (
          <div key={r.time} className={'recent-chip ' + (!r.won ? 'is-miss' : r.mult >= 8 ? 'is-top' : r.mult >= 3 ? 'is-great' : 'is-win')}>
            <b>{r.won ? `${r.mult}×` : 'Miss'}</b>
            <span>{r.dist}m · pick {r.pred}m</span>
          </div>
        ))}
        {/* Empty slots keep the grid's shape until it fills up */}
        {Array.from({ length: Math.max(0, 4 - rounds.length) }, (_, i) => (
          <div key={`slot${i}`} className="recent-chip is-empty" aria-hidden="true"><b>—</b><span>&nbsp;</span></div>
        ))}
      </div>
    </section>
  );
}

export function PayoutRules({ onInfo }) {
  return (
    <section className="info-card">
      <div className="info-title-row">
        <span className="info-title">Payout rules</span>
        <button type="button" className="info-btn" aria-label="How Bike It works" onClick={onInfo}>?</button>
      </div>
      <AccuracyBar />
      <div className="tier-table">
        {PAYOUT_TIERS.map(t => (
          <div key={t.key} className={`tier-row t-${t.key}`}>
            <span className="tier-icon">{t.icon}</span>
            <div className="tier-mid">
              <span className="tier-label">{t.label}</span>
              <span className="tier-range">{t.range}</span>
            </div>
            <div className="tier-end"><span className="tier-mult">{t.mult}×</span></div>
          </div>
        ))}
        <div className="tier-row t-miss">
          <span className="tier-icon">❌</span>
          <div className="tier-mid">
            <span className="tier-label">Missed It</span>
            <span className="tier-range">Beyond 30%</span>
          </div>
          <div className="tier-end"><span className="tier-mult">—</span></div>
        </div>
      </div>
    </section>
  );
}
