import { useEffect, useRef, useState, useCallback } from 'react';
import MainMenu from './MainMenu.jsx';
import BetSlip from './components/BetSlip.jsx';
import { AccuracyBar, SessionCard, RecentRounds, PayoutRules } from './components/InfoPanels.jsx';
import { BikeGame } from './game/BikeGame.js';
import { calcPayout, serverMultToCrashAt, PAYOUT_TIERS } from './game/logic.js';
import { playWin, playLose, playDeposit, playWithdraw, startAmbient, stopAmbient } from './game/sound.js';
import { GameServer } from './api/gameServer.js';

const START_BALANCE = 1000;
const BET_KEY = 'bikeit_bet';
const PRED_KEY = 'bikeit_pred';
const BET2_KEY = 'bikeit_bet2';
const SOUND_KEY = 'bikeit_sound';
const MUSIC_KEY = 'bikeit_music';
const PLAYER_ID_KEY = 'bikeit_player_id';
const JOINED_KEY = 'bikeit_joined_at';
const LIFETIME_KEY = 'bikeit_lifetime_stats';

// ── Local "account" — this app has no server-side auth, so identity/lifetime
// stats are just anonymous values seeded once and persisted to localStorage.
function getOrCreatePlayerId() {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) { id = 'BX-' + Math.random().toString(36).slice(2, 8).toUpperCase(); localStorage.setItem(PLAYER_ID_KEY, id); }
  return id;
}
function getOrCreateJoinedAt() {
  let t = localStorage.getItem(JOINED_KEY);
  if (!t) { t = String(Date.now()); localStorage.setItem(JOINED_KEY, t); }
  return Number(t);
}
function loadLifetimeStats() {
  const empty = { wagered: 0, returned: 0, wins: 0, rounds: 0, bets: 0 };
  try { return { ...empty, ...JSON.parse(localStorage.getItem(LIFETIME_KEY)) }; }
  catch { return empty; }
}

// Light haptic feedback for key mobile interactions — silently a no-op on
// devices/browsers without the Vibration API (desktop, iOS Safari).
function vibrate(pattern) {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch { /* unsupported */ }
  }
}

export default function App() {
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const serverRef = useRef(null);
  const seededFromServerRef = useRef(false);
  const serverOutcomeRef = useRef(null);

  // ── Core game state (React-owned) ──────────────────────────────────────────
  const [balance, setBalance] = useState(START_BALANCE);
  const [roundNum, setRoundNum] = useState(1);
  const [betInput, setBetInput] = useState(() => localStorage.getItem(BET_KEY) || '10');
  const [predInput, setPredInput] = useState(() => localStorage.getItem(PRED_KEY) || '80');
  // ── Second bet slip — a permanent second, independent stake placed
  // alongside Bet 1 every round, both riding on the same prediction.
  const [bet2Input, setBet2Input] = useState(() => localStorage.getItem(BET2_KEY) || '10');
  const [phase, setPhase] = useState('idle');
  const [history, setHistory] = useState([]);
  const [sessionStats, setSessionStats] = useState({ wagered: 0, returned: 0, wins: 0, rounds: 0, bets: 0 });
  const [streak, setStreak] = useState({ type: null, current: 0, best: 0 });
  const [walletInput, setWalletInput] = useState('100');
  const [walletMode, setWalletMode] = useState(null);       // null | 'deposit' | 'withdraw' — drives the wallet popup
  const [walletFeedback, setWalletFeedback] = useState(null); // { type, amount } shown as the popup's success state
  const walletCloseTimerRef = useRef(null);

  // ── Mobile single-column layout: which info tab shows under the bet slip ──
  const [tab, setTab] = useState('stats'); // 'stats' | 'rules'

  // ── Settings (sound/music, bet history, account info, privacy, about) ─────
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPage, setSettingsPage] = useState(null); // null = root menu, else section key
  const closeSettings = () => { setShowSettings(false); setSettingsPage(null); };

  const [soundOn, setSoundOn] = useState(() => localStorage.getItem(SOUND_KEY) !== 'off');
  const soundOnRef = useRef(soundOn);
  useEffect(() => { soundOnRef.current = soundOn; localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); }, [soundOn]);

  const [musicOn, setMusicOn] = useState(() => localStorage.getItem(MUSIC_KEY) === 'on');
  useEffect(() => {
    localStorage.setItem(MUSIC_KEY, musicOn ? 'on' : 'off');
    if (musicOn) startAmbient(); else stopAmbient();
  }, [musicOn]);
  useEffect(() => () => stopAmbient(), []);

  const [playerId] = useState(getOrCreatePlayerId);
  const [joinedAt] = useState(getOrCreateJoinedAt);
  const [lifetimeStats, setLifetimeStats] = useState(loadLifetimeStats);
  const lifetimeRef = useRef(lifetimeStats);

  // ── Auto-bet state ──────────────────────────────────────────────────────────
  const [autoRoundsInput, setAutoRoundsInput] = useState('10');
  const [autoStopLossInput, setAutoStopLossInput] = useState('');
  const [autoStopProfitInput, setAutoStopProfitInput] = useState('');
  const [autoActive, setAutoActive] = useState(false);
  const [autoRoundsLeft, setAutoRoundsLeft] = useState(0);
  // The current (or last) auto run: its length and the session totals it
  // started from, so the slip can show "Round 3 of 10" and the run's own P/L.
  const [autoRun, setAutoRun] = useState({ total: 0, startWagered: 0, startReturned: 0 });
  const [autoStopReason, setAutoStopReason] = useState(null);

  // ── HUD / display state ────────────────────────────────────────────────────
  const [distance, setDistance] = useState('— m');
  const [predDisplay, setPredDisplay] = useState('— m');
  const [distLabel, setDistLabel] = useState('Predict & Bet to Race');
  const [statusMsg] = useState('');
  // Speed/height are pushed by the game loop's onStats callback on every rAF
  // tick during flight (~60/s). Routing that through React state would force
  // a full App re-render every frame (App renders a large tree — history,
  // sidebars, tabs, modals), which is the kind of steady per-frame cost that
  // reads as jank. These two numbers are display-only, so they're written
  // straight to the DOM via refs instead, bypassing React's render cycle
  // entirely while still updating exactly as often as before.
  const speedElRef = useRef(null);
  const heightElRef = useRef(null);
  const [statsShow, setStatsShow] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [countdownKey, setCountdownKey] = useState(0);
  const [result, setResult] = useState(null);
  const [shaking, setShaking] = useState(false);
  const [bumpKey, setBumpKey] = useState(0);
  const [showRules, setShowRules] = useState(false);
  const [showMenu, setShowMenu] = useState(true);

  // ── Refs mirroring state needed inside imperative callbacks ────────────────
  const balanceRef = useRef(balance);
  const roundNumRef = useRef(roundNum);
  const betRoundRef = useRef(10);
  const predRoundRef = useRef(80);
  const bet2ActiveRoundRef = useRef(false);
  const bet2RoundRef = useRef(0);
  const statsRef = useRef({ wagered: 0, returned: 0, wins: 0, rounds: 0, bets: 0 });
  const autoRef = useRef({ active: false, roundsLeft: 0, stopLoss: null, stopProfit: null, startWagered: 0, startReturned: 0 });
  useEffect(() => { balanceRef.current = balance; }, [balance]);
  useEffect(() => { roundNumRef.current = roundNum; }, [roundNum]);

  const bumpBalance = () => setBumpKey(k => k + 1);

  // ── Round outcome resolution ───────────────────────────────────────────────
  // Bet 2 (when active) rides the same prediction as Bet 1 — just a second,
  // independent stake — so both share the same accuracy/tier and only the
  // payout amount differs.
  const resolveOutcome = useCallback((dist) => {
    const pred1 = predRoundRef.current;
    const bet1 = betRoundRef.current;
    const r1 = calcPayout(dist, pred1);
    const won1 = r1.mult > 0;
    const payout1 = +(bet1 * r1.mult).toFixed(2);
    const errPct = r1.errPct;

    const bet2Active = bet2ActiveRoundRef.current;
    const bet2 = bet2Active ? bet2RoundRef.current : 0;
    const payout2 = bet2Active ? +(bet2 * r1.mult).toFixed(2) : 0;

    const totalPayout = payout1 + payout2;

    if (totalPayout > 0) setBalance(b => b + totalPayout);
    if (soundOnRef.current) { if (won1) playWin(r1.mult); else playLose(); }
    vibrate(won1 ? [20, 40, 20] : 60);
    bumpBalance();

    const now = Date.now();
    setHistory(h => {
      const entries = [{ won: won1, mult: r1.mult, dist, bet: bet1, payout: payout1, pred: pred1, time: now }];
      if (bet2Active) entries.push({ won: won1, mult: r1.mult, dist, bet: bet2, payout: payout2, pred: pred1, time: now });
      return [...entries, ...h].slice(0, 30);
    });

    const betsThisRound = bet2Active ? 2 : 1;
    const winsThisRound = won1 ? betsThisRound : 0;
    const wageredThisRound = bet1 + bet2;

    statsRef.current = {
      wagered: statsRef.current.wagered + wageredThisRound,
      returned: statsRef.current.returned + totalPayout,
      wins: statsRef.current.wins + winsThisRound,
      rounds: statsRef.current.rounds + 1,
      bets: statsRef.current.bets + betsThisRound,
    };
    setSessionStats(statsRef.current);

    lifetimeRef.current = {
      wagered: lifetimeRef.current.wagered + wageredThisRound,
      returned: lifetimeRef.current.returned + totalPayout,
      wins: lifetimeRef.current.wins + winsThisRound,
      rounds: lifetimeRef.current.rounds + 1,
      bets: lifetimeRef.current.bets + betsThisRound,
    };
    setLifetimeStats(lifetimeRef.current);
    localStorage.setItem(LIFETIME_KEY, JSON.stringify(lifetimeRef.current));

    setStreak(s => {
      const type = won1 ? 'win' : 'loss';
      const current = s.type === type ? s.current + 1 : 1;
      return { type, current, best: won1 ? Math.max(s.best, current) : s.best };
    });

    setResult({
      dist,
      slips: [
        { tier: r1.tier, won: won1, pm: r1.mult, payout: payout1, pred: pred1, bet: bet1, errPct },
        ...(bet2Active ? [{ tier: r1.tier, won: won1, pm: r1.mult, payout: payout2, pred: pred1, bet: bet2, errPct }] : []),
      ],
      fairness: serverOutcomeRef.current,
    });
  }, []);

  // ── Engine setup ───────────────────────────────────────────────────────────
  useEffect(() => {
    // Phones repaint the crowd a little less often to save battery; bigger
    // screens get a smoother Mexican wave and idle animation. Idle pacing is
    // an even divisor of the display rate (30/60) so it never judders. It
    // starts suspended: the menu (with its own live arena) shows first, so
    // this engine does no work at all until the player heads for the game.
    const narrow = window.matchMedia?.('(max-width: 700px)').matches;
    const game = new BikeGame(canvasRef.current, {
      onMeta: ({ rider, bike }) => setDistLabel(`${rider} · ${bike}`),
      onPhase: (p) => {
        setPhase(p);
        if (p === 'flying') setDistLabel('Distance');
      },
      onCountdown: (v) => {
        if (v === null) { setCountdown(null); return; }
        setCountdown(v);
        setCountdownKey(k => k + 1);
      },
      onRaceStart: () => {
        setStatsShow(true); setDistance('0 m');
        if (speedElRef.current) speedElRef.current.textContent = '0';
        if (heightElRef.current) heightElRef.current.textContent = '0';
      },
      onDistance: (d) => setDistance(d + ' m'),
      onStats: (s) => {
        if (speedElRef.current) speedElRef.current.textContent = s.speed;
        if (heightElRef.current) heightElRef.current.textContent = s.height;
      },
      onShake: () => { setShaking(false); requestAnimationFrame(() => { setShaking(true); setTimeout(() => setShaking(false), 400); }); },
      onLanded: (dist) => resolveOutcome(dist),
    }, narrow ? { crowdMs: 80, ambientFps: 30, suspended: true } : { crowdMs: 50, ambientFps: 60, suspended: true });
    gameRef.current = game;
    return () => { game.destroy(); gameRef.current = null; };
  }, [resolveOutcome]);

  // The menu runs its own live arena, so the (hidden) game canvas behind it
  // stops rendering until the player leaves the menu.
  useEffect(() => { gameRef.current?.setSuspended(showMenu); }, [showMenu]);

  // ── Server connection: source RNG (crash multiplier) + balance ─────────────
  useEffect(() => {
    const server = new GameServer();
    serverRef.current = server;
    server.onBalance = (b) => {
      // Seed the local balance from the server once; don't wipe local progress
      // on later reconnects (this integration keeps betting client-side).
      if (!seededFromServerRef.current) {
        seededFromServerRef.current = true;
        setBalance(b);
      }
    };
    server.connect();
    return () => { server.disconnect(); serverRef.current = null; };
  }, []);

  // ── Persist bet/prediction across sessions ──────────────────────────────────
  useEffect(() => { localStorage.setItem(BET_KEY, betInput); }, [betInput]);
  useEffect(() => { localStorage.setItem(PRED_KEY, predInput); }, [predInput]);
  useEffect(() => { localStorage.setItem(BET2_KEY, bet2Input); }, [bet2Input]);

  // ── Enter/Space dismisses the result overlay without reaching for the mouse ─
  useEffect(() => {
    if (!result || autoActive) return;
    const onKey = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dismissResult(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, autoActive]);

  // ── Auto-bet: advance to the next round once a result is shown ─────────────
  // Keyed on `result` only (not on balance/betInput/dismissResult/startRound) —
  // it should fire once per resolved round, not every time an input changes
  // while the result overlay happens to be open.
  useEffect(() => {
    if (!result || !autoRef.current.active) return;
    const auto = autoRef.current;
    const timer = setTimeout(() => {
      if (!auto.active) return;
      const netAuto = (statsRef.current.returned - auto.startReturned) - (statsRef.current.wagered - auto.startWagered);
      auto.roundsLeft -= 1;
      const hitStopLoss = auto.stopLoss != null && netAuto <= -auto.stopLoss;
      const hitStopProfit = auto.stopProfit != null && netAuto >= auto.stopProfit;
      const outOfRounds = auto.roundsLeft <= 0;
      const nextBet1 = Math.max(1, Math.min(balance, parseFloat(betInput) || 10));
      const nextBet2 = Math.max(1, parseFloat(bet2Input) || 10);
      const cantAffordNext = (nextBet1 + nextBet2) > balance;

      dismissResult();

      if (hitStopLoss || hitStopProfit || outOfRounds || cantAffordNext) {
        auto.active = false;
        setAutoActive(false);
        setAutoRoundsLeft(0);
        setAutoStopReason(hitStopLoss ? 'Stop loss reached' : hitStopProfit ? 'Take profit reached'
          : outOfRounds ? 'All rounds played' : 'Balance too low for the next round');
        return;
      }
      setAutoRoundsLeft(auto.roundsLeft);
      startRound();
    }, 1600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // ── Input helpers ──────────────────────────────────────────────────────────
  const numericBet = () => Math.max(1, Math.min(balance, parseFloat(betInput) || 1));
  const setBet = (v) => setBetInput(String(Math.min(balance, Math.max(1, v))));
  const halveBet = () => setBet(Math.max(1, Math.floor(numericBet() / 2)));
  const doubleBet = () => setBet(numericBet() * 2);
  const setPred = (v) => setPredInput(String(v));

  // ── Bet 2 input helpers (mirror Bet 1's) ───────────────────────────────────
  const numericBet2 = () => Math.max(1, Math.min(balance, parseFloat(bet2Input) || 1));
  const setBet2 = (v) => setBet2Input(String(Math.min(balance, Math.max(1, v))));
  const halveBet2 = () => setBet2(Math.max(1, Math.floor(numericBet2() / 2)));
  const doubleBet2 = () => setBet2(numericBet2() * 2);

  // ── Wallet (demo balance top-up/cash-out via a themed pit-stop popup — no
  // real payment backend here; deposit/withdraw only ever touch local state) ─
  const walletAmt = Math.max(1, parseFloat(walletInput) || 0);
  const walletOverBalance = walletMode === 'withdraw' && walletAmt > balance;

  const openWallet = (mode) => {
    clearTimeout(walletCloseTimerRef.current);
    setWalletFeedback(null);
    setWalletMode(mode);
    setWalletInput(mode === 'withdraw' ? String(Math.max(1, Math.min(100, Math.floor(balance)) || 1)) : '100');
  };
  const closeWallet = () => {
    clearTimeout(walletCloseTimerRef.current);
    setWalletMode(null);
    setWalletFeedback(null);
  };
  const confirmWallet = () => {
    if (walletMode === 'deposit') {
      setBalance(b => b + walletAmt);
      bumpBalance();
      if (soundOnRef.current) playDeposit();
      vibrate(15);
      setWalletFeedback({ type: 'deposit', amount: walletAmt });
    } else if (walletMode === 'withdraw') {
      if (balance <= 0) return;
      const amt = Math.min(walletAmt, balance);
      setBalance(b => Math.max(0, b - amt));
      bumpBalance();
      if (soundOnRef.current) playWithdraw();
      vibrate(15);
      setWalletFeedback({ type: 'withdraw', amount: amt });
    }
    walletCloseTimerRef.current = setTimeout(closeWallet, 1700);
  };
  useEffect(() => () => clearTimeout(walletCloseTimerRef.current), []);

  // ── Settings actions (local-only resets; no server calls) ─────────────────
  const resetSession = () => {
    const empty = { wagered: 0, returned: 0, wins: 0, rounds: 0, bets: 0 };
    statsRef.current = empty;
    setSessionStats(empty);
    setHistory([]);
    setStreak({ type: null, current: 0, best: 0 });
    // An auto run measures its P/L against the session totals it started
    // from — rebase it onto the fresh zeros so the figure doesn't jump.
    autoRef.current.startWagered = 0;
    autoRef.current.startReturned = 0;
    setAutoRun(r => ({ ...r, startWagered: 0, startReturned: 0 }));
    setAutoStopReason(null);
  };
  const resetBalance = () => { setBalance(START_BALANCE); bumpBalance(); };

  // ── Stakes for the next round ──────────────────────────────────────────────
  // What a round would actually place right now. With too little balance to
  // cover two R1 minimums Bet 2 sits the round out, and when the two bets add
  // up to more than the balance both scale down to fit instead of blocking
  // the round — the "just place it, it'll cap itself" feel. The slip's payout
  // preview reads this too, so it always shows the real stake.
  const fitBets = () => {
    let bet1 = Math.max(1, Math.min(balance, parseFloat(betInput) || 10));
    const bet2Active = balance >= 2;
    let bet2 = bet2Active ? Math.max(1, parseFloat(bet2Input) || 10) : 0;
    let total = bet1 + bet2;
    if (total > balance) {
      const scale = balance / total;
      bet1 = Math.max(1, Math.floor(bet1 * scale));
      if (bet2Active) bet2 = Math.max(1, Math.floor(bet2 * scale));
      total = bet1 + bet2;
      if (total > balance) bet1 = Math.max(1, bet1 - (total - balance));
    }
    return { bet1, bet2, bet2Active };
  };
  const nextBets = fitBets();
  const stake = nextBets.bet1 + nextBets.bet2;
  const overBalance = Math.max(0, parseFloat(betInput) || 0) + Math.max(0, parseFloat(bet2Input) || 0) > balance;

  // ── Start round ────────────────────────────────────────────────────────────
  const startRound = () => {
    if (balance < 1) return; // can't cover even the R1 minimum bet
    const { bet1, bet2, bet2Active } = fitBets();
    const pred1 = Math.max(5, parseFloat(predInput) || 80);

    setBetInput(String(bet1));
    setPredInput(String(pred1));
    if (bet2Active) setBet2Input(String(bet2));

    betRoundRef.current = bet1;
    predRoundRef.current = pred1;
    bet2ActiveRoundRef.current = bet2Active;
    bet2RoundRef.current = bet2;

    setBalance(b => b - (bet1 + bet2));
    bumpBalance();
    vibrate(15);
    setPhase('countdown');            // disables the button immediately
    setPredDisplay(pred1 + ' m');
    setDistance('— m');

    // Use the server's latest provably-fair crash multiplier as this launch's
    // outcome; falls back to the engine's local RNG when the server is offline.
    const outcome = serverRef.current?.takeOutcome() || null;
    serverOutcomeRef.current = outcome;

    gameRef.current.startRound({
      pred: pred1,
      roundNum: roundNumRef.current,
      crashAt: outcome ? serverMultToCrashAt(outcome.multiplier) : null,
    });
  };

  const handleMain = () => { if (phase === 'idle') startRound(); };

  // Desktop QoL: hitting Enter in any bet/predict field places the bet
  // directly instead of requiring a mouse trip down to the button.
  const handleBetKeyDown = (e) => {
    if (e.key !== 'Enter' || phase !== 'idle' || autoActive) return;
    e.preventDefault();
    e.currentTarget.blur();
    startRound();
  };

  const dismissResult = () => {
    setResult(null);
    setRoundNum(n => n + 1);
    setPhase('idle');
    setDistance('— m');
    setPredDisplay('— m');
    setDistLabel('Predict & Bet to Race');
    setStatsShow(false);
    gameRef.current.reset();
  };

  // ── Auto-bet controls ───────────────────────────────────────────────────────
  // Auto places Bet 1 + Bet 2 unchanged every round — it never quietly scales
  // the stakes down the way a manual bet does — so it only starts, and only
  // carries on, while the balance covers both in full.
  const autoBet1 = Math.max(1, Math.min(balance, parseFloat(betInput) || 10));
  const autoBet2 = Math.max(1, parseFloat(bet2Input) || 10);
  const autoCanStart = phase === 'idle' && !autoActive && autoBet1 + autoBet2 <= balance;
  const autoNet = (sessionStats.returned - autoRun.startReturned) - (sessionStats.wagered - autoRun.startWagered);

  const startAuto = () => {
    if (!autoCanStart) return;
    const rounds = Math.min(500, Math.max(1, parseInt(autoRoundsInput, 10) || 1));
    // A blank, zero or junk limit means "off" — a 0 stop loss would otherwise
    // end the run after the first round that doesn't turn a profit.
    const limit = (s) => { const v = parseFloat(s); return v > 0 ? v : null; };
    const start = { startWagered: statsRef.current.wagered, startReturned: statsRef.current.returned };

    autoRef.current = { active: true, roundsLeft: rounds, stopLoss: limit(autoStopLossInput), stopProfit: limit(autoStopProfitInput), ...start };
    setAutoRun({ total: rounds, ...start });
    setAutoRoundsInput(String(rounds));
    setAutoStopReason(null);
    setAutoActive(true);
    setAutoRoundsLeft(rounds);
    startRound();
  };

  const stopAuto = () => {
    if (!autoRef.current.active) return;
    autoRef.current.active = false;
    setAutoActive(false);
    setAutoRoundsLeft(0);
    setAutoStopReason('Stopped by you');
  };

  // Whether the result now on screen ends the run (so the overlay can say
  // "finishing" instead of promising a next round that won't come).
  const autoFinishing = autoActive && (autoRoundsLeft <= 1
    || (autoRef.current.stopLoss != null && autoNet <= -autoRef.current.stopLoss)
    || (autoRef.current.stopProfit != null && autoNet >= autoRef.current.stopProfit)
    || autoBet1 + autoBet2 > balance);

  // Live payout zone while the bike is in the air — distance only climbs, so
  // the readout walks Miss → Close → Great → Bullseye and back out, showing
  // the player exactly when their pick is in play.
  const liveDist = parseFloat(distance);
  const livePred = parseFloat(predDisplay);
  const liveZone = phase === 'flying' && liveDist > 0 && livePred > 0 ? calcPayout(liveDist, livePred) : null;

  // Both bets ride the same pick, so a round has one tier/accuracy and only
  // the amounts differ — the result card shows that once, then each bet.
  const resultHead = result?.slips[0];
  const resultNet = result ? result.slips.reduce((n, s) => n + s.payout - s.bet, 0) : 0;

  // balance < 1 blocks betting outright — startRound() floors any bet at a
  // minimum of R1, so without this a R0 balance could still place a bet and
  // go negative.
  const betDisabled = phase !== 'idle' || autoActive || balance < 1;

  return (
    <div className="phone-frame">
      {showMenu && (
        <MainMenu
          balance={balance}
          streak={streak}
          history={history}
          onPlay={() => setShowMenu(false)}
          onAutoBet={() => setShowMenu(false)}
          onPrepare={() => gameRef.current?.setSuspended(false)}
          onRules={() => setShowRules(true)}
          onHistory={() => { setShowSettings(true); setSettingsPage('history'); }}
          onSettings={() => setShowSettings(true)}
        />
      )}
      <div className="app">
        <header>
          <div className="logo"><span className="spark">⚡</span></div>
          <div className="balance-wrap">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#00ff88" strokeWidth="2.5">
              <circle cx="12" cy="12" r="9" />
              <path d="M9 9.5a3 3 0 0 1 3-2h.5a2.5 2.5 0 0 1 0 5H12a2.5 2.5 0 0 0 0 5h.5a3 3 0 0 0 3-2" />
              <path d="M12 6v2M12 16v2" />
            </svg>
            <div className="balance bump" key={bumpKey}>R{balance.toFixed(2)}</div>
          </div>
          <button type="button" className="icon-btn settings-gear" aria-label="Settings" onClick={() => setShowSettings(true)}>⚙</button>
        </header>

        <div className="layout">
          {/* Desktop-only (≥1024px) left sidebar — on mobile the same panels
              live in the Session / Payout rules tabs under the bet slip. */}
          <aside className="side-panel side-left">
            <SessionCard streak={streak} stats={sessionStats} />
            <RecentRounds history={history} />
            <PayoutRules onInfo={() => setShowRules(true)} />
          </aside>

          <div className={`game-wrap${shaking ? ' shake' : ''}`}>
            <canvas id="gameCanvas" ref={canvasRef} />

            <div className="hud">
              <div className="dist-panel">
                <div className="dist-side">
                  <div className="dv-lbl">Distance</div>
                  <div id="distVal" className="tick" key={distance}>{distance}</div>
                </div>
                <div className="dist-sep" />
                <div className="dist-side">
                  <div className="dv-lbl">Your Pick</div>
                  <div id="predDisplay">{predDisplay}</div>
                </div>
              </div>
              <div id="distLabel">{distLabel}</div>
              {liveZone && (
                <div className={`live-zone z-${liveZone.mult >= 8 ? 'top' : liveZone.mult >= 3 ? 'great' : liveZone.mult > 0 ? 'close' : liveDist < livePred ? 'early' : 'over'}`}>
                  {liveZone.mult > 0
                    ? <>{liveZone.tier} <b>{liveZone.mult}×</b></>
                    : liveDist < livePred ? <>{Math.round(livePred - liveDist)}m to your pick</> : <>Past your pick</>}
                </div>
              )}
              <div id="statusMsg">{statusMsg}</div>
            </div>

            <div className={`fstats${statsShow ? ' show' : ''}`}>
              <div className="fs">Speed <b ref={speedElRef}>0</b> km/h</div>
              <div className="fs">Height <b ref={heightElRef}>0</b>m</div>
            </div>

            {/* Lives inside the game area (not over the whole app) so the bet
                slip — including Stop auto — stays usable through the count. */}
            {countdown !== null && (
              <div id="countdownOverlay">
                <div>
                  <div id="countdownLabel">Race starts in</div>
                  <div id="countdownNum" className="beat" key={countdownKey}>{countdown}</div>
                </div>
              </div>
            )}
          </div>

          {/* The bet slip — the right sidebar on desktop, and straight under
              the game on mobile. */}
          <aside className="side-panel side-right">
            <BetSlip
              balance={balance}
              betInput={betInput} setBetInput={setBetInput}
              bet2Input={bet2Input} setBet2Input={setBet2Input}
              predInput={predInput} setPredInput={setPredInput}
              setBet={setBet} halveBet={halveBet} doubleBet={doubleBet}
              setBet2={setBet2} halveBet2={halveBet2} doubleBet2={doubleBet2}
              setPred={setPred} onKeyDown={handleBetKeyDown}
              stake={stake} overBalance={overBalance}
              phase={phase} betDisabled={betDisabled} onPlaceBet={handleMain}
              auto={{
                active: autoActive, canStart: autoCanStart, onStart: startAuto, onStop: stopAuto,
                rounds: autoRoundsInput, setRounds: setAutoRoundsInput,
                stopLoss: autoStopLossInput, setStopLoss: setAutoStopLossInput,
                takeProfit: autoStopProfitInput, setTakeProfit: setAutoStopProfitInput,
                total: autoRun.total, left: autoRoundsLeft, net: autoNet, stopReason: autoStopReason,
              }}
            />

            {/* Mobile only: the info panels, tabbed, under the slip (inside
                this column so a landscape phone scrolls them together). */}
            <nav className="tab-bar mobile-only" aria-label="Round info">
              <button type="button" className={tab === 'stats' ? 'active' : ''} aria-pressed={tab === 'stats'} onClick={() => setTab('stats')}>Session</button>
              <button type="button" className={tab === 'rules' ? 'active' : ''} aria-pressed={tab === 'rules'} onClick={() => setTab('rules')}>Payout rules</button>
            </nav>
            <div className="tab-panel mobile-only">
              <div className={`tab-section${tab === 'stats' ? ' tab-active' : ''}`}>
                <SessionCard streak={streak} stats={sessionStats} />
                <RecentRounds history={history} />
              </div>
              <div className={`tab-section${tab === 'rules' ? ' tab-active' : ''}`}>
                <PayoutRules onInfo={() => setShowRules(true)} />
              </div>
            </div>
          </aside>
        </div>
      </div>

      {result && (
        <div id="resultOverlay">
          <div id="resultBox" className={!resultHead.won ? 'is-loss' : resultHead.pm >= 8 ? 'is-top' : 'is-win'}>
            <div className="result-kicker">Round {roundNum} result</div>
            <div className="result-title">{resultHead.tier}</div>
            <div className="result-facts">
              <div><span>Landed</span><b>{result.dist}m</b></div>
              <div><span>Your pick</span><b>{resultHead.pred}m</b></div>
              <div><span>Off by</span><b>{resultHead.errPct}%</b></div>
            </div>
            <AccuracyBar markerPct={resultHead.errPct} compact />
            {!resultHead.won && resultHead.errPct <= 40 && (
              <div className="near-miss">😬 So close — only {resultHead.errPct - 30}% outside the Close Enough zone.</div>
            )}
            <div className="result-bets">
              {result.slips.map((s, i) => (
                <div key={i} className="result-bet">
                  <span>Bet {i + 1} · R{s.bet.toFixed(2)}{s.won ? ` × ${s.pm}` : ''}</span>
                  <b className={s.won ? 'pos' : 'neg'}>{s.won ? `R${s.payout.toFixed(2)}` : `−R${s.bet.toFixed(2)}`}</b>
                </div>
              ))}
              <div className="result-bet result-net">
                <span>Round {resultNet >= 0 ? 'profit' : 'loss'}</span>
                <b className={resultNet >= 0 ? 'pos' : 'neg'}>{resultNet >= 0 ? '+' : '−'}R{Math.abs(resultNet).toFixed(2)}</b>
              </div>
            </div>
            <div id="fairness">
              {result.fairness
                ? <>⛓ Server RNG · <b>{result.fairness.multiplier.toFixed(2)}×</b> crash
                    {result.fairness.roundId ? <> · #{String(result.fairness.roundId).slice(0, 8)}</> : null}</>
                : <>⚠ Offline RNG (server unreachable)</>}
            </div>
            {autoActive ? (
              <div className="auto-hint">
                <span>{autoFinishing ? 'Auto bet · finishing the run' : `Auto bet · next round starting · ${autoRoundsLeft - 1} to go`}</span>
                {!autoFinishing && <button type="button" onClick={stopAuto}>Stop auto</button>}
              </div>
            ) : (
              <button id="nextBtn" onClick={dismissResult}>Next Round</button>
            )}
          </div>
        </div>
      )}

      {showRules && (
        <div className="modal-overlay" onClick={() => setShowRules(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h3>🏍 How Bike It Works</h3>
            <div className="steps">
              <div className="modal-step"><span className="num">1</span> Set your bet amount and predict how far (in meters) the bike will fly off the ramp.</div>
              <div className="modal-step"><span className="num">2</span> Place your bet — the bike races down the ramp and launches off the jump.</div>
              <div className="modal-step"><span className="num">3</span> The landing distance is decided by a provably-fair server RNG (or a local RNG if the server is offline).</div>
              <div className="modal-step"><span className="num">4</span> Your payout depends on how close your prediction was to where it actually landed — closer is worth more.</div>
            </div>

            <div className="modal-subhead">Accuracy → Payout</div>
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

            <div className="modal-example">
              💡 <b>Example:</b> you predict <b>100m</b>, the bike lands at <b>104m</b> — that's 4% off, inside the
              Bullseye zone, so a R10 bet pays <b>R80</b> (8×).
            </div>

            <button className="modal-close" onClick={() => setShowRules(false)}>Got It</button>
          </div>
        </div>
      )}

      {walletMode && (
        <div className="modal-overlay wallet-modal-overlay" onClick={closeWallet}>
          <div className={`wallet-modal wm-${walletMode}`} onClick={e => e.stopPropagation()}>
            {!walletFeedback ? (
              <>
                <div className="wm-head">
                  <h3><span className="wm-flag">🏁</span> Pit Stop</h3>
                  <button type="button" className="wm-close" aria-label="Close" onClick={closeWallet}>×</button>
                </div>

                <div className="wm-tabs">
                  <button type="button" className={walletMode === 'deposit' ? 'active' : ''} onClick={() => openWallet('deposit')}>
                    ⛽ Deposit
                  </button>
                  <button type="button" className={walletMode === 'withdraw' ? 'active' : ''} disabled={balance <= 0}
                    onClick={() => openWallet('withdraw')}>
                    🏆 Withdraw
                  </button>
                </div>

                <div className="wm-balance">
                  <span>Current Balance</span>
                  <b>R{balance.toFixed(2)}</b>
                </div>

                <div className="input-currency wm-input">
                  <span className="prefix">R</span>
                  <input type="number" inputMode="decimal" autoFocus value={walletInput} min="1" step="1"
                    onChange={e => setWalletInput(e.target.value)} />
                </div>

                <div className="quick wm-quick">
                  {[50, 100, 250, 500, 1000].map(v => (
                    <button key={v} type="button" className={walletInput === String(v) ? 'active' : ''}
                      onClick={() => setWalletInput(String(v))}>R{v}</button>
                  ))}
                  {walletMode === 'withdraw' && (
                    <button type="button" onClick={() => setWalletInput(String(Math.max(1, Math.floor(balance))))}>MAX</button>
                  )}
                </div>

                {walletOverBalance && (
                  <div className="bet-warning">⚠ Exceeds balance — will cash out R{balance.toFixed(2)}</div>
                )}

                <button type="button" className={`wm-confirm wm-confirm-${walletMode}`}
                  onClick={confirmWallet} disabled={walletMode === 'withdraw' && balance <= 0}>
                  {walletMode === 'deposit'
                    ? `⛽ Deposit R${walletAmt.toFixed(0)}`
                    : `🏁 Withdraw R${Math.min(walletAmt, balance).toFixed(0)}`}
                </button>
              </>
            ) : (
              <div className="wm-success">
                <div className="wm-success-icon">{walletFeedback.type === 'deposit' ? '⛽' : '🏁'}</div>
                <div className="wm-success-title">
                  {walletFeedback.type === 'deposit' ? 'Tank Full!' : 'Cashed Out!'}
                </div>
                <div className={`wm-success-amt wm-success-amt-${walletFeedback.type}`}>
                  {walletFeedback.type === 'deposit' ? '+' : '−'}R{walletFeedback.amount.toFixed(2)}
                </div>
                <div className="wm-success-bal">New Balance <b>R{balance.toFixed(2)}</b></div>
                <button type="button" className="wm-done" onClick={closeWallet}>Done</button>
              </div>
            )}
          </div>
        </div>
      )}

      {showSettings && (
        <div className="modal-overlay" onClick={closeSettings}>
          <div className="modal-box settings-box" onClick={e => e.stopPropagation()}>
            {!settingsPage ? (
              <>
                <h3>⚙ Settings</h3>
                <div className="settings-list">
                  <button type="button" className="settings-item" onClick={() => setSettingsPage('sound')}>
                    <span className="si-icon">🔊</span><span className="si-label">Sound &amp; Music</span><span className="si-chev">›</span>
                  </button>
                  <button type="button" className="settings-item" onClick={() => setSettingsPage('history')}>
                    <span className="si-icon">🧾</span><span className="si-label">Bet History</span><span className="si-chev">›</span>
                  </button>
                  <button type="button" className="settings-item" onClick={() => setSettingsPage('account')}>
                    <span className="si-icon">👤</span><span className="si-label">Account Information</span><span className="si-chev">›</span>
                  </button>
                  <button type="button" className="settings-item" onClick={() => setSettingsPage('privacy')}>
                    <span className="si-icon">📜</span><span className="si-label">Privacy &amp; Terms</span><span className="si-chev">›</span>
                  </button>
                  <button type="button" className="settings-item" onClick={() => setSettingsPage('about')}>
                    <span className="si-icon">ℹ️</span><span className="si-label">About</span><span className="si-chev">›</span>
                  </button>
                </div>
                <button className="modal-close" onClick={closeSettings}>Done</button>
              </>
            ) : (
              <>
                <div className="settings-page-head">
                  <button type="button" className="icon-btn" aria-label="Back" onClick={() => setSettingsPage(null)}>‹</button>
                  <h3>
                    {settingsPage === 'sound' && 'Sound & Music'}
                    {settingsPage === 'history' && 'Bet History'}
                    {settingsPage === 'account' && 'Account Information'}
                    {settingsPage === 'privacy' && 'Privacy & Terms'}
                    {settingsPage === 'about' && 'About'}
                  </h3>
                </div>

                {settingsPage === 'sound' && (
                  <>
                    <div className="settings-row">
                      <span>Sound Effects</span>
                      <button type="button" className={`switch${soundOn ? ' on' : ''}`}
                        role="switch" aria-checked={soundOn} onClick={() => setSoundOn(s => !s)}>
                        <span className="switch-knob" />
                      </button>
                    </div>
                    <div className="settings-row">
                      <span>Background Music</span>
                      <button type="button" className={`switch${musicOn ? ' on' : ''}`}
                        role="switch" aria-checked={musicOn} onClick={() => setMusicOn(m => !m)}>
                        <span className="switch-knob" />
                      </button>
                    </div>
                  </>
                )}

                {settingsPage === 'history' && (
                  <div className="bet-slip-list">
                    {history.length === 0 && <div className="hist-empty">No bets placed yet</div>}
                    {history.map((h, i) => (
                      <div key={i} className={'bet-slip ' + (h.won ? 'c-win' : 'c-loss')}>
                        <div className="bet-slip-row">
                          <span>Bet R{h.bet.toFixed(2)}</span>
                          <span>{h.won ? `+R${h.payout.toFixed(2)}` : `-R${h.bet.toFixed(2)}`}</span>
                        </div>
                        <div className="bet-slip-row bet-slip-sub">
                          <span>Pick {h.pred}m · Landed {h.dist}m</span>
                          <span>{h.won ? `${h.mult}×` : 'Lost'}</span>
                        </div>
                        {h.time && <div className="bet-slip-time">{new Date(h.time).toLocaleString()}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {settingsPage === 'account' && (
                  <>
                    <div className="account-grid">
                      <div className="account-row"><span>Player ID</span><b>{playerId}</b></div>
                      <div className="account-row"><span>Member Since</span><b>{new Date(joinedAt).toLocaleDateString()}</b></div>
                      <div className="account-row"><span>Current Balance</span><b>R{balance.toFixed(2)}</b></div>
                      <div className="account-row"><span>Lifetime Rounds</span><b>{lifetimeStats.rounds}</b></div>
                      <div className="account-row"><span>Lifetime Wagered</span><b>R{lifetimeStats.wagered.toFixed(2)}</b></div>
                      <div className="account-row">
                        <span>Lifetime Net P/L</span>
                        <b className={(lifetimeStats.returned - lifetimeStats.wagered) > 0 ? 'stat-pos' : (lifetimeStats.returned - lifetimeStats.wagered) < 0 ? 'stat-neg' : ''}>
                          {(lifetimeStats.returned - lifetimeStats.wagered) >= 0 ? '+' : ''}R{(lifetimeStats.returned - lifetimeStats.wagered).toFixed(2)}
                        </b>
                      </div>
                    </div>

                    <div className="flbl">Wallet</div>
                    <div className="wallet-actions">
                      <button type="button" className="wallet-btn wallet-deposit" onClick={() => openWallet('deposit')}>
                        <span className="wallet-btn-icon">⛽</span> Deposit
                      </button>
                      <button type="button" className="wallet-btn wallet-withdraw" onClick={() => openWallet('withdraw')} disabled={balance <= 0}>
                        <span className="wallet-btn-icon">🏁</span> Withdraw
                      </button>
                    </div>

                    <div className="settings-actions">
                      <button type="button" className="settings-btn" onClick={resetSession}>Reset Session Stats</button>
                      <button type="button" className="settings-btn settings-btn-danger" onClick={resetBalance}>
                        Reset Balance to R{START_BALANCE}
                      </button>
                    </div>
                    <div className="account-note">This is a local demo account — everything above lives only in this browser. There's no server-side account.</div>
                  </>
                )}

                {settingsPage === 'privacy' && (
                  <div className="legal-text">
                    <p><b>Demo notice.</b> Bike It is a practice/demo prediction game. No real money is wagered, deposited, or withdrawn — every "R" balance, deposit, and withdrawal here is simulated and stored only in this browser.</p>
                    <p><b>Data.</b> No personal data is collected or transmitted. Your bet size, prediction, sound preference and local player ID live only in this browser's storage. The only network call this game makes is fetching a provably-fair round outcome to drive the flight.</p>
                    <p><b>No warranty.</b> Provided for entertainment/demo purposes only, with no guarantee of uptime, accuracy, or fitness for any particular purpose.</p>
                    <p><b>Responsible play.</b> Even in demo form, Bike It is modeled on real-money prediction games — keep it fun, set limits, and never chase losses.</p>
                  </div>
                )}

                {settingsPage === 'about' && (
                  <div className="legal-text">
                    <p><b>Bike It</b> — a provably-fair-flavored motocross distance-prediction game.</p>
                    <p>Version 1.0.0 · Built with React + Canvas.</p>
                    <p>Round outcomes use a server-provided crash multiplier when the RNG service is reachable, and fall back to a local cryptographic RNG otherwise — check the fairness note under each round's result to see which one applied.</p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
