import { useEffect, useRef, useState } from 'react';
import { BikeGame } from './game/BikeGame.js';

// `short` replaces `desc` on phones, where the copy sits in the top left
const MODES = [
  { id: 'play', label: 'Play', kicker: 'Predict · Bet · Race', cta: 'Play now',
    desc: 'Pick where the rider will land, place your bet and watch the jump. The closer your call, the bigger the payout — up to 8× for a Bullseye.',
    short: 'Call the landing. Closer pays more — up to 8×.' },
  { id: 'auto', label: 'Auto Bet', kicker: 'Auto bet', cta: 'Set up auto bet',
    desc: 'Run several rounds in a row with the same bet and pick. Set a stop loss and stop profit so it ends when you want it to.',
    short: 'Same bet, many rounds. You set when it stops.' },
  { id: 'rules', label: 'Payout Rules', kicker: 'Payout rules', cta: 'See payouts',
    desc: 'Bullseye within 5% pays 8×, Great Call within 15% pays 3×, Close Enough within 30% pays 1.5×. Anything further is a miss.',
    short: 'Within 5% pays 8×, 15% pays 3×, 30% pays 1.5×.' },
  { id: 'recent', label: 'History', kicker: 'Recent rounds', cta: 'View history',
    desc: 'See your last rounds, where the rider landed against your pick, and your current streak.',
    short: 'Your last rounds and current streak.' },
  { id: 'settings', label: 'Settings', kicker: 'Audio & account', cta: 'Open settings',
    desc: 'Sound and music, bet history, account details and the fine print.',
    short: 'Sound, history, account and fine print.' },
];

const ICONS = {
  play: <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />,
  auto: <><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5" /><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5" /></>,
  rules: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /></>,
  recent: <><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5" /><path d="M3.5 4v4.5H8M12 7.5V12l3 2" /></>,
  settings: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2.2" /><circle cx="10" cy="17" r="2.2" /></>,
};

function Icon({ name, size = 20 }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{ICONS[name]}</svg>
  );
}

// The live arena behind the menu: the real game engine on its own canvas,
// looping demo jumps ("attract mode") back to back with no countdown. It
// never stops moving: after each crash the smoke keeps rolling while the
// arena fades out, the scene resets to the start line out of sight, and it
// fades back in for the next run-up. It renders at a modest resolution (it's
// a backdrop under the menu) and a steady 60fps. On wide screens the action
// is pushed to the right so it plays beside the menu instead of under it.
function useArena(canvasRef) {
  useEffect(() => {
    const canvas = canvasRef.current;
    const shift = () => (window.innerWidth >= 900 ? 0.26 : 0);
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let alive = true, timer = null, round = 1;
    const play = () => {
      if (!alive) return;
      game.pred = 60 + Math.round(Math.random() * 160);
      game.roundNum = round++;
      game.crashAt = 1.7 + Math.random() * 3.4;
      game.beginRace();
    };
    const game = new BikeGame(canvas, {
      onPhase: (p) => {
        if (p !== 'done' || !alive) return;
        timer = setTimeout(() => {
          if (!alive) return;
          canvas.classList.add('is-fading');
          timer = setTimeout(() => {
            if (!alive) return;
            game.reset();
            canvas.classList.remove('is-fading');
            timer = setTimeout(play, 1300);
          }, 480);
        }, 1700);
      },
    }, {
      viewShift: shift(), animateDone: true, ambientFps: 60, dragonChance: 0.5,
      crowdMs: window.innerWidth < 700 ? 100 : 60,
      maxDpr: window.innerWidth >= 1400 ? 1.25 : 1.5,
    });
    if (!calm) timer = setTimeout(play, 900);
    const onResize = () => { game.viewShift = shift(); };
    window.addEventListener('resize', onResize);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      game.destroy();
    };
  }, [canvasRef]);
}

export default function MainMenu({ balance, streak, history = [], onPlay, onAutoBet, onPrepare, onRules, onHistory, onSettings }) {
  const [sel, setSel] = useState('play');
  // `ready` ends the staggered entrance (after that, switching modes just
  // crossfades the text); `leaving` fades the whole lobby out into the game.
  const [ready, setReady] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const arenaRef = useRef(null);
  useArena(arenaRef);
  useEffect(() => { const t = setTimeout(() => setReady(true), 1300); return () => clearTimeout(t); }, []);

  const activate = (id) => {
    if (id === 'play' || id === 'auto') {
      if (leaving) return;
      // Start the game drawing behind the lobby while it fades out, so the
      // game is already on screen when the fade ends.
      setLeaving(true);
      onPrepare?.();
      setTimeout(id === 'auto' ? (onAutoBet || onPlay) : onPlay, 300);
    } else if (id === 'rules') onRules();
    else if (id === 'recent') (onHistory || onSettings)();
    else if (id === 'settings') onSettings();
  };

  useEffect(() => {
    const onKey = (e) => {
      const idx = MODES.findIndex((m) => m.id === sel);
      if (e.key === 'ArrowRight') { e.preventDefault(); setSel(MODES[Math.min(MODES.length - 1, idx + 1)].id); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setSel(MODES[Math.max(0, idx - 1)].id); }
      else if (e.key === 'Enter') { e.preventDefault(); activate(sel); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const cur = MODES.find((m) => m.id === sel);
  // Both bet slips of a round share one timestamp, so dedupe by time to get
  // one chip per round for the crash-style results strip.
  const recentRounds = history.filter((h, i, arr) => arr.findIndex((o) => o.time === h.time) === i).slice(0, 8);
  const streakLabel = streak && streak.current > 0
    ? `${streak.current} ${streak.type === 'win' ? 'WIN' : 'LOSS'}${streak.current > 1 ? 'S' : ''}`
    : 'None yet';

  return (
    <div className={'lobby' + (ready ? ' is-ready' : '') + (leaving ? ' is-leaving' : '')}>
      <canvas ref={arenaRef} className="lobby-arena" aria-hidden="true" />
      <div className="lobby-shade" aria-hidden="true" />

      <header className="lobby-top lobby-anim" style={{ '--d': '0ms' }}>
        <div className="lobby-results" aria-label="Recent results">
          <span className="lobby-results-lbl">Recent</span>
          <div className="lobby-results-strip">
            {recentRounds.length === 0
              ? Array.from({ length: 6 }, (_, i) => <span key={i} className="lobby-chip lobby-chip-empty">—</span>)
              : recentRounds.map((r) => (
                <span key={r.time} className={'lobby-chip ' + (!r.won ? 'lobby-chip-miss' : r.mult >= 8 ? 'lobby-chip-top' : r.mult >= 3 ? 'lobby-chip-great' : 'lobby-chip-win')}>
                  {r.won ? `${r.mult}×` : `${r.dist}m`}
                </span>
              ))}
          </div>
        </div>
        <div className="lobby-top-right">
          <div className="lobby-fair">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" strokeLinecap="round" /></svg>
            <span>Provably fair</span>
          </div>
          <div className="lobby-balance">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M9 8h4a2.5 2.5 0 0 1 0 5H9zM9 13l5 4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span>R{balance.toFixed(2)}</span>
          </div>
          <button type="button" aria-label="Settings" className="lobby-icon-btn" onClick={onSettings}>
            <Icon name="settings" />
          </button>
        </div>
      </header>

      {/* On desktop the intro and the actions stack on the left; on phones
          the intro moves to the top left and the actions to the bottom,
          leaving the middle clear for the live arena */}
      <section className="lobby-hero">
        <div className="lobby-intro">
          <div key={`k-${cur.id}`} className="lobby-kicker lobby-anim lobby-swap" style={{ '--d': '80ms' }}>{cur.kicker}</div>
          <div className="lobby-title-row lobby-anim" style={{ '--d': '140ms' }}>
            <svg className="lobby-bolt" aria-hidden="true" viewBox="0 0 24 28"><path d="M14 1 L3 16 h7 l-2 11 L21 11 h-7 z" fill="#FF8A1F" /></svg>
            <h1 className="lobby-title" data-text="BIKE IT">BIKE <span>IT</span></h1>
          </div>
          <p key={`d-${cur.id}`} className="lobby-desc lobby-anim lobby-swap" style={{ '--d': '220ms' }}>
            <span className="lobby-desc-full">{cur.desc}</span>
            <span className="lobby-desc-short">{cur.short}</span>
          </p>
        </div>
        <div className="lobby-actions">
          <div className="lobby-cta-row lobby-anim" style={{ '--d': '300ms' }}>
            <button key={`c-${cur.id}`} type="button" className="lobby-cta lobby-swap" onClick={() => activate(cur.id)}>
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z" /></svg>
              {cur.cta}
            </button>
          </div>
          <div className="lobby-stats lobby-anim" style={{ '--d': '380ms' }}>
            <div className="lobby-stat lobby-stat-green"><span>Balance</span><b>R{balance.toFixed(2)}</b></div>
            <div className={'lobby-stat ' + (streak?.type === 'loss' ? 'lobby-stat-red' : 'lobby-stat-blue')}><span>Streak</span><b>{streakLabel}</b></div>
            <div className="lobby-stat lobby-stat-gold"><span>Top payout</span><b>8× Bullseye</b></div>
          </div>
        </div>
      </section>

      <nav className="lobby-dock lobby-anim" style={{ '--d': '460ms' }} aria-label="Main menu">
        {MODES.map((m) => (
          <button key={m.id} type="button" aria-pressed={m.id === sel}
            className={'lobby-mode' + (m.id === sel ? ' on' : '')}
            onClick={() => setSel(m.id)} onDoubleClick={() => activate(m.id)}>
            <Icon name={m.id} />
            <span>{m.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
