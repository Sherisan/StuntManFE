import { useEffect, useRef, useState } from 'react';
import { BikeGame } from './game/BikeGame.js';
import { PAYOUT_TIERS } from './game/logic.js';

// On phones `short` replaces `desc` (the copy sits in the top left),
// `sub` is the line of pull under the big button and `tab` labels each
// icon in the mode dock
const MODES = [
  { id: 'play', label: 'Play', tab: 'Play', kicker: 'Predict · Bet · Race', cta: 'Play now', sub: 'Win up to 8× your bet',
    desc: 'Pick where the rider will land, place your bet and watch the jump. The closer your call, the bigger the payout — up to 8× for a Bullseye.',
    short: 'Call the landing. Closer pays more — up to 8×.' },
  { id: 'auto', label: 'Auto Bet', tab: 'Auto', kicker: 'Auto bet', cta: 'Set up auto bet', sub: 'Pick once, ride many rounds',
    desc: 'Run several rounds in a row with the same bet and pick. Set a stop loss and stop profit so it ends when you want it to.',
    short: 'Same bet, many rounds. You set when it stops.' },
  { id: 'rules', label: 'Payout Rules', tab: 'Rules', kicker: 'Payout rules', cta: 'See payouts', sub: 'Three ways to win',
    desc: 'Bullseye within 5% pays 8×, Great Call within 15% pays 3×, Close Enough within 30% pays 1.5×. Anything further is a miss.',
    short: 'Within 5% pays 8×, 15% pays 3×, 30% pays 1.5×.' },
  { id: 'recent', label: 'History', tab: 'History', kicker: 'Recent rounds', cta: 'View history', sub: 'Your rounds and streak',
    desc: 'See your last rounds, where the rider landed against your pick, and your current streak.',
    short: 'Your last rounds and current streak.' },
  { id: 'settings', label: 'Settings', tab: 'Settings', kicker: 'Audio & account', cta: 'Open settings', sub: 'Sound, music and account',
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

// Publishes where the Play button block starts (--act-top, from the lobby's
// top edge) so the portrait-phone CSS can size the arena to put its ground
// line just above the button and start the bottom fade there — on any phone
// height. offsetTop ignores the entrance transforms, so it's stable from the
// first frame.
function useActionsTop(lobbyRef, heroRef, actionsRef) {
  useEffect(() => {
    const lobby = lobbyRef.current, hero = heroRef.current, actions = actionsRef.current;
    const fit = () => lobby.style.setProperty('--act-top', `${hero.offsetTop + actions.offsetTop}px`);
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(lobby);
    ro?.observe(actions);
    return () => ro?.disconnect();
  }, [lobbyRef, heroRef, actionsRef]);
}

export default function MainMenu({ balance, streak, onPlay, onAutoBet, onPrepare, onRules, onHistory, onSettings }) {
  const [sel, setSel] = useState('play');
  // `ready` ends the staggered entrance (after that, switching modes just
  // crossfades the text); `leaving` fades the whole lobby out into the game.
  const [ready, setReady] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const arenaRef = useRef(null);
  const lobbyRef = useRef(null), heroRef = useRef(null), actionsRef = useRef(null);
  useArena(arenaRef);
  useActionsTop(lobbyRef, heroRef, actionsRef);
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
  const streakLabel = streak && streak.current > 0
    ? `${streak.current} ${streak.type === 'win' ? 'WIN' : 'LOSS'}${streak.current > 1 ? 'S' : ''}`
    : 'None yet';

  return (
    <div ref={lobbyRef} className={'lobby' + (ready ? ' is-ready' : '') + (leaving ? ' is-leaving' : '')}>
      <canvas ref={arenaRef} className="lobby-arena" aria-hidden="true" />
      <div className="lobby-shade" aria-hidden="true" />

      <header className="lobby-top lobby-anim" style={{ '--d': '0ms' }}>
        <div className="lobby-top-right">
          <div className="lobby-balance">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M9 8h4a2.5 2.5 0 0 1 0 5H9zM9 13l5 4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span>R{balance.toFixed(2)}</span>
          </div>
          {/* Phones: the streak rides up here once there is one */}
          {streak?.current > 0 && (
            <div className={'lobby-streak' + (streak.type === 'loss' ? ' is-loss' : '')}>
              <span aria-hidden="true">{streak.type === 'win' ? '🔥' : '❄️'}</span>{streakLabel}
            </div>
          )}
          <button type="button" aria-label="Settings" className="lobby-icon-btn" onClick={onSettings}>
            <Icon name="settings" />
          </button>
        </div>
      </header>

      {/* On desktop the intro and the actions stack on the left; on phones
          the intro moves to the top left and the actions to the bottom,
          leaving the middle clear for the live arena */}
      <section ref={heroRef} className="lobby-hero">
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
        <div ref={actionsRef} className="lobby-actions">
          <div className="lobby-cta-row lobby-anim" style={{ '--d': '300ms' }}>
            <button key={`c-${cur.id}`} type="button" className="lobby-cta lobby-swap" onClick={() => activate(cur.id)}>
              <span className="lobby-cta-shine" aria-hidden="true" />
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z" /></svg>
              <span className="lobby-cta-text">
                {cur.cta}
                <small>{cur.sub}</small>
              </span>
            </button>
          </div>
          <div className="lobby-stats lobby-anim" style={{ '--d': '380ms' }}>
            <div className="lobby-stat lobby-stat-green"><span>Balance</span><b>R{balance.toFixed(2)}</b></div>
            <div className={'lobby-stat ' + (streak?.type === 'loss' ? 'lobby-stat-red' : 'lobby-stat-blue')}><span>Streak</span><b>{streakLabel}</b></div>
            <div className="lobby-stat lobby-stat-gold"><span>Top payout</span><b>8× Bullseye</b></div>
          </div>
          {/* Phones: the three ways to win, in place of the stat cards */}
          <div className="lobby-tiers lobby-anim" style={{ '--d': '380ms' }} aria-label="Ways to win">
            {PAYOUT_TIERS.map((t) => (
              <div key={t.key} className={`lobby-tier lobby-tier-${t.key}`}>
                <b><span aria-hidden="true">{t.icon}</span>{t.mult}×</b>
                <span>{t.label}</span>
                <small>{t.range}</small>
              </div>
            ))}
          </div>
        </div>
      </section>

      <nav className="lobby-dock lobby-anim" style={{ '--d': '460ms' }} aria-label="Main menu">
        {MODES.map((m) => (
          <button key={m.id} type="button" aria-pressed={m.id === sel}
            className={'lobby-mode' + (m.id === sel ? ' on' : '')}
            onClick={() => setSel(m.id)} onDoubleClick={() => activate(m.id)}>
            <Icon name={m.id} />
            <span className="lobby-mode-lbl">{m.label}</span>
            <span className="lobby-mode-tab">{m.tab}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
