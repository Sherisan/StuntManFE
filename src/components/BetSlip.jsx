import { useEffect, useState } from 'react';
import { PAYOUT_TIERS } from '../game/logic.js';

const BET_CHIPS = [10, 50, 100];
const PRED_CHIPS = [30, 50, 80, 120, 180, 250, 350];
const ROUND_CHIPS = [10, 25, 50, 100];
const PRED_MIN = 5, PRED_MAX = 400;
const money = (v) => `R${v.toFixed(2)}`;
const signed = (v) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`;

function BetRow({ label, tone, value, onChange, onSet, onHalf, onDouble, balance, locked, onKeyDown }) {
  const num = parseFloat(value) || 0;
  return (
    <div className={`slip-bet tone-${tone}`}>
      <span className="slip-label">{label}</span>
      <div className="slip-stepper">
        <button type="button" aria-label={`Decrease ${label}`} disabled={locked} onClick={() => onSet(Math.max(1, num - 10))}>−</button>
        <label className="slip-amount">
          <span>R</span>
          <input type="number" inputMode="decimal" min="1" step="1" value={value} disabled={locked}
            aria-label={label} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />
        </label>
        <button type="button" aria-label={`Increase ${label}`} disabled={locked} onClick={() => onSet(num + 10)}>+</button>
      </div>
      <div className="slip-chips">
        {BET_CHIPS.map((v) => (
          <button key={v} type="button" disabled={locked} aria-pressed={num === v} className={num === v ? 'on' : ''} onClick={() => onSet(v)}>R{v}</button>
        ))}
        <button type="button" disabled={locked} onClick={onHalf}>½</button>
        <button type="button" disabled={locked} onClick={onDouble}>2×</button>
        <button type="button" disabled={locked} aria-pressed={num === balance} className={num === balance ? 'on' : ''} onClick={() => onSet(balance)}>Max</button>
      </div>
    </div>
  );
}

// The bet slip: two stakes, a prediction slider, live payouts for the real
// stake and the main action — under Manual and Auto tabs. While auto-bet runs
// every input locks (what's on screen is exactly what's being bet) and the
// Auto tab shows the run's progress and its own profit/loss.
export default function BetSlip({
  balance, betInput, setBetInput, bet2Input, setBet2Input, predInput, setPredInput,
  setBet, halveBet, doubleBet, setBet2, halveBet2, doubleBet2, setPred, onKeyDown,
  stake, overBalance, phase, betDisabled, onPlaceBet, auto,
}) {
  const [tab, setTab] = useState('manual');
  useEffect(() => { if (auto.active) setTab('auto'); }, [auto.active]);
  const locked = auto.active;
  // Enter-to-bet is a manual shortcut; in the Auto tab it would fire a stray
  // one-off bet instead of starting the run.
  const keyDown = tab === 'manual' ? onKeyDown : undefined;
  const pred = parseFloat(predInput) || 0;
  const predClamped = Math.min(PRED_MAX, Math.max(PRED_MIN, pred));
  const predPct = ((predClamped - PRED_MIN) / (PRED_MAX - PRED_MIN)) * 100;
  const rounds = Math.min(500, Math.max(1, parseInt(auto.rounds, 10) || 1));
  const done = auto.total - auto.left;

  let hint = '';
  if (tab === 'auto' && !auto.active && !auto.canStart) {
    hint = phase !== 'idle' ? 'Auto can start once this round finishes.'
      : 'Auto bets both stakes in full every round. Lower them or top up to start.';
  } else if (tab === 'manual' && balance < 1) {
    hint = 'Top up your balance to play.';
  }

  return (
    <section className="slip" aria-label="Bet slip">
      <div className="slip-head">
        <div className="slip-tabs" role="tablist" aria-label="Bet mode">
          <button type="button" role="tab" aria-selected={tab === 'manual'} className={tab === 'manual' ? 'on' : ''}
            disabled={auto.active} onClick={() => setTab('manual')}>Manual</button>
          <button type="button" role="tab" aria-selected={tab === 'auto'} className={tab === 'auto' ? 'on' : ''}
            onClick={() => setTab('auto')}>Auto{auto.active && <i className="slip-live" aria-label="running" />}</button>
        </div>
        <span className="slip-balance"><small>Balance</small><b>{money(balance)}</b></span>
      </div>

      <BetRow label="Bet 1" tone="a" value={betInput} onChange={setBetInput} onSet={setBet} onHalf={halveBet} onDouble={doubleBet}
        balance={balance} locked={locked} onKeyDown={keyDown} />
      <BetRow label="Bet 2" tone="b" value={bet2Input} onChange={setBet2Input} onSet={setBet2} onHalf={halveBet2} onDouble={doubleBet2}
        balance={balance} locked={locked} onKeyDown={keyDown} />
      {overBalance && !locked && <div className="slip-warn">Both bets add up to more than your balance, so they'll be scaled down to fit {money(balance)}.</div>}

      <div className="slip-pred">
        <div className="slip-pred-head">
          <span className="slip-label">Predicted landing</span>
          <label className="slip-pred-value">
            <input type="number" inputMode="decimal" min={PRED_MIN} step="5" value={predInput} disabled={locked}
              aria-label="Predicted landing in meters" onChange={(e) => setPredInput(e.target.value)} onKeyDown={keyDown} />
            <span>m</span>
          </label>
        </div>
        <input type="range" className="slip-range" min={PRED_MIN} max={PRED_MAX} step="5" disabled={locked}
          aria-label="Predicted landing slider" value={predClamped}
          style={{ '--fill': `${predPct}%` }} onChange={(e) => setPredInput(e.target.value)} />
        <div className="slip-chips">
          {PRED_CHIPS.map((v) => (
            <button key={v} type="button" disabled={locked} aria-pressed={pred === v} className={pred === v ? 'on' : ''} onClick={() => setPred(v)}>{v}m</button>
          ))}
        </div>
      </div>

      {tab === 'auto' && (
        <div className="slip-auto">
          <div className="slip-auto-grid">
            <label><span>Rounds</span>
              <input type="number" inputMode="numeric" min="1" max="500" step="1" value={auto.rounds} disabled={locked} onChange={(e) => auto.setRounds(e.target.value)} />
            </label>
            <label><span>Stop loss</span>
              <input type="number" inputMode="decimal" min="0" step="1" placeholder="Off" value={auto.stopLoss} disabled={locked} onChange={(e) => auto.setStopLoss(e.target.value)} />
            </label>
            <label><span>Take profit</span>
              <input type="number" inputMode="decimal" min="0" step="1" placeholder="Off" value={auto.takeProfit} disabled={locked} onChange={(e) => auto.setTakeProfit(e.target.value)} />
            </label>
          </div>
          {!auto.active && (
            <div className="slip-chips">
              {ROUND_CHIPS.map((v) => (
                <button key={v} type="button" aria-pressed={rounds === v} className={rounds === v ? 'on' : ''} onClick={() => auto.setRounds(String(v))}>{v} rounds</button>
              ))}
            </div>
          )}
          {auto.active ? (
            <div className="slip-auto-status">
              <div className="slip-auto-line">
                <span>Round <b>{Math.min(auto.total, done + 1)}</b> of {auto.total}</span>
                <b className={auto.net >= 0 ? 'pos' : 'neg'}>{signed(auto.net)}</b>
              </div>
              <div className="slip-auto-bar"><i style={{ width: `${auto.total ? (done / auto.total) * 100 : 0}%` }} /></div>
            </div>
          ) : auto.stopReason ? (
            <div className="slip-auto-status is-done">
              <div className="slip-auto-line">
                <span>Last run · {auto.stopReason}</span>
                <b className={auto.net >= 0 ? 'pos' : 'neg'}>{signed(auto.net)}</b>
              </div>
            </div>
          ) : null}
        </div>
      )}

      <div className="slip-payouts">
        <span className="slip-label">Win on {money(stake)}</span>
        <div className="slip-payout-row">
          {PAYOUT_TIERS.map((t) => (
            <div key={t.key} className={`slip-payout t-${t.key}`} title={`${t.label} · ${t.range}`}>
              <span className="slip-payout-top"><i aria-hidden="true">{t.icon}</i>{t.mult}×</span>
              <b>{money(stake * t.mult)}</b>
              <small>{t.range}</small>
            </div>
          ))}
        </div>
      </div>

      {tab === 'auto' ? (
        auto.active
          ? <button type="button" className="slip-cta is-stop" onClick={auto.onStop}>Stop auto<small>{auto.left} round{auto.left === 1 ? '' : 's'} left</small></button>
          : <button type="button" className="slip-cta is-auto" disabled={!auto.canStart} onClick={auto.onStart}>Start auto<small>{rounds} round{rounds === 1 ? '' : 's'} · {money(stake)} a round</small></button>
      ) : (
        <button type="button" className="slip-cta" disabled={betDisabled} onClick={onPlaceBet}>
          {phase === 'idle' ? 'Place bet' : 'Bike in play'}<small>{phase === 'idle' ? `${money(stake)} total stake` : 'Next bet opens after landing'}</small>
        </button>
      )}
      {hint && <div className="slip-hint">{hint}</div>}
    </section>
  );
}
