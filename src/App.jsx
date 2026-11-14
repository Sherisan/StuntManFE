import { useEffect, useRef, useState, useCallback } from 'react';
import MainMenu from './MainMenu.jsx';
import BetSlip from './components/BetSlip.jsx';
import { SessionCard, RecentRounds, PayoutRules } from './components/InfoPanels.jsx';
import { BikeGame } from './game/BikeGame.js';
import { PAYOUT_TIERS, DEFAULT_MAX_MULT, clampPred, targetForPred, landingDist, multAtDist, fmtMult, floorCents } from './game/logic.js';
import { playWin, playLose, playCountdownBeep, playClick, playBet, gameSfx, unlockAudio, setSoundEnabled, setMusicEnabled } from './game/sound.js';
import * as api from './api/engine.js';

const BET_KEY = 'bikeit_bet';
const PRED_KEY = 'bikeit_pred';
const BET2_KEY = 'bikeit_bet2';
const SOUND_KEY = 'bikeit_sound';
// v2: the live stadium music (on by default) replaced the old optional drone
const MUSIC_KEY = 'bikeit_music_v2';
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

  // ── Game server (GameEngineAPI) ────────────────────────────────────────────
  // The balance is the player's real wallet balance and every round is
  // decided and paid by the server; see api/engine.js.
  const [server, setServer] = useState({ status: 'connecting', error: null, info: null });
  const maxMult = Number(server.info?.maxTarget) || DEFAULT_MAX_MULT;
  const ready = server.status === 'ready';

  // ── Core game state (React-owned) ──────────────────────────────────────────
  const [balance, setBalance] = useState(0);
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

  // ── Mobile single-column layout: which info tab shows under the bet slip ──
  const [tab, setTab] = useState('stats'); // 'stats' | 'rules'

  // ── Settings (sound/music, bet history, account info, privacy, about) ─────
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPage, setSettingsPage] = useState(null); // null = root menu, else section key
  const closeSettings = () => { setShowSettings(false); setSettingsPage(null); };

  const [soundOn, setSoundOn] = useState(() => localStorage.getItem(SOUND_KEY) !== 'off');
  const soundOnRef = useRef(soundOn);
  useEffect(() => {
    soundOnRef.current = soundOn; localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off');
    setSoundEnabled(soundOn);
  }, [soundOn]);
  // Browsers keep audio locked until the player interacts: any tap or key
  // unlocks it (and brings it back if the tab suspended it). Every button
  // gives a soft click.
  useEffect(() => {
    const unlock = () => unlockAudio();
    const click = (e) => { if (soundOnRef.current && e.target.closest?.('button')) playClick(); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('click', click);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('click', click);
    };
  }, []);

  const [musicOn, setMusicOn] = useState(() => localStorage.getItem(MUSIC_KEY) !== 'off');
  useEffect(() => {
    localStorage.setItem(MUSIC_KEY, musicOn ? 'on' : 'off');
    setMusicEnabled(musicOn);
  }, [musicOn]);
  useEffect(() => () => setMusicEnabled(false), []);

  // Portrait phones size the game to the space the header and the bet slip
  // leave (see index.css), so the whole slip sits at the bottom of the
  // screen. Their heights change with the Manual/Auto tab, so measure them.
  const appRef = useRef(null);
  useEffect(() => {
    const app = appRef.current;
    const header = app?.querySelector(':scope > header');
    const slip = app?.querySelector('.side-right .slip');
    if (!app || !header || !slip || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      app.style.setProperty('--hdr-h', `${header.offsetHeight}px`);
      app.style.setProperty('--slip-h', `${slip.offsetHeight}px`);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(header);
    ro.observe(slip);
    measure();
    return () => ro.disconnect();
  }, []);

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
  const [statusMsg, setStatusMsg] = useState('');
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
  // The server's verdict for the round in the air: { crashPoint, target, win, balance, winPending, proof }.
  // It's known before take-off but only shown (and the balance updated) on landing.
  const playRef = useRef(null);
  const statsRef = useRef({ wagered: 0, returned: 0, wins: 0, rounds: 0, bets: 0 });
  const autoRef = useRef({ active: false, roundsLeft: 0, stopLoss: null, stopProfit: null, startWagered: 0, startReturned: 0 });
  useEffect(() => { balanceRef.current = balance; }, [balance]);
  useEffect(() => { roundNumRef.current = roundNum; }, [roundNum]);

  const bumpBalance = () => setBumpKey(k => k + 1);

  // ── Round outcome resolution ───────────────────────────────────────────────
  // Runs when the bike lands. Everything here comes from the server's play
  // result: both bets ride one target and were placed as one stake, so the
  // server's single win is split between the two slips for display.
  const resolveOutcome = useCallback((dist) => {
    const p = playRef.current;
    if (!p) return;
    playRef.current = null;
    const pred1 = predRoundRef.current;
    const bet1 = betRoundRef.current;
    const won1 = p.win > 0;
    const bet2Active = bet2ActiveRoundRef.current;
    const bet2 = bet2Active ? bet2RoundRef.current : 0;
    const totalPayout = p.win;
    const payout1 = won1 ? (bet2Active ? floorCents(bet1 * p.target) : totalPayout) : 0;
    const payout2 = won1 && bet2Active ? +(totalPayout - payout1).toFixed(2) : 0;

    if (p.balance != null) setBalance(p.balance);
    else if (totalPayout > 0) setBalance(b => b + totalPayout);
    if (soundOnRef.current) { if (won1) playWin(p.target); else playLose(); }
    vibrate(won1 ? [20, 40, 20] : 60);
    bumpBalance();

    const now = Date.now();
    setHistory(h => {
      const base = { won: won1, mult: p.target, crash: p.crashPoint, dist, pred: pred1, time: now, roundId: p.roundId };
      const entries = [{ ...base, bet: bet1, payout: payout1 }];
      if (bet2Active) entries.push({ ...base, bet: bet2, payout: payout2 });
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
      crash: p.crashPoint,
      winPending: p.winPending,
      proof: p.proof,
      slips: [
        { won: won1, pm: p.target, payout: payout1, pred: pred1, bet: bet1 },
        ...(bet2Active ? [{ won: won1, pm: p.target, payout: payout2, pred: pred1, bet: bet2 }] : []),
      ],
    });
  }, []);

  // ── Connect to the game server and load the wallet balance ────────────────
  const refreshBalance = useCallback(async () => {
    const b = await api.getBalance();
    setBalance(Number(b.balance));
  }, []);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const info = await api.connect();
        await refreshBalance();
        if (!alive) return;
        setServer({ status: 'ready', error: null, info });
        setPredInput(p => String(clampPred(p, Number(info?.maxTarget) || DEFAULT_MAX_MULT)));
      } catch (e) {
        if (alive) setServer({ status: 'error', error: e.message, info: null });
      }
    })();
    return () => { alive = false; };
  }, [refreshBalance]);

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
        if (soundOnRef.current) playCountdownBeep(v === 0);
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
      onSfx: (name, v) => gameSfx(name, v),
    }, narrow ? { crowdMs: 100, ambientFps: 30, suspended: true, tallSky: true } : { crowdMs: 50, ambientFps: 60, suspended: true, tallSky: true });
    gameRef.current = game;
    return () => { game.destroy(); gameRef.current = null; };
  }, [resolveOutcome]);

  // Tell the engine where the distance panel sits over the canvas, so the
  // dragon, the birds, the moon and the fireworks keep out from behind it.
  // Re-measured whenever the panel or the canvas changes size.
  useEffect(() => {
    const canvas = canvasRef.current, hud = canvas?.parentElement?.querySelector('.hud');
    if (!canvas || !hud || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const c = canvas.getBoundingClientRect(), h = hud.getBoundingClientRect();
      if (!c.width || !h.width) return;
      gameRef.current?.setClearZone({ left: h.left - c.left, right: h.right - c.left, bottom: h.bottom - c.top });
    };
    const ro = new ResizeObserver(update);
    ro.observe(hud); ro.observe(canvas);
    update();
    const settle = setTimeout(update, 600); // after the panel's slide-in
    return () => { ro.disconnect(); clearTimeout(settle); };
  }, []);

  // The menu runs its own live arena, so the (hidden) game canvas behind it
  // stops rendering until the player leaves the menu.
  useEffect(() => { gameRef.current?.setSuspended(showMenu); }, [showMenu]);

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

  // ── Settings actions ───────────────────────────────────────────────────────
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
  const reloadBalance = () => { refreshBalance().then(bumpBalance).catch((e) => setStatusMsg(e.message)); };

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
  // Both bets go to the server as ONE play (one stake, one target), so they
  // share a single crash point the way they share one bike. The server takes
  // the stake, draws the crash point, pays any win and returns the verdict;
  // the bike then flies to that crash point's distance.
  const startRound = async () => {
    if (!ready || balance < 1) return; // no server, or can't cover the R1 minimum bet
    const { bet1, bet2, bet2Active } = fitBets();
    const pred1 = clampPred(predInput, maxMult);
    const target = targetForPred(pred1, maxMult);
    const stakeTotal = +(bet1 + bet2).toFixed(2);

    setBetInput(String(bet1));
    setPredInput(String(pred1));
    if (bet2Active) setBet2Input(String(bet2));

    betRoundRef.current = bet1;
    predRoundRef.current = pred1;
    bet2ActiveRoundRef.current = bet2Active;
    bet2RoundRef.current = bet2;

    setPhase('countdown');            // disables the button immediately
    setStatusMsg('');

    let res;
    try {
      res = await api.play(stakeTotal, target);
    } catch (e) {
      setPhase('idle');
      setStatusMsg(e.message);
      refreshBalance().catch(() => {}); // re-sync in case the wallet moved
      if (autoRef.current.active) {
        autoRef.current.active = false;
        setAutoActive(false);
        setAutoRoundsLeft(0);
        setAutoStopReason(`Stopped: ${e.message}`);
      }
      return;
    }

    const crashPoint = Number(res.crashPoint);
    const won = Number(res.win) > 0;
    playRef.current = {
      roundId: res.roundId, crashPoint, target, win: Number(res.win),
      balance: res.balance != null ? Number(res.balance) : null,
      winPending: !!res.winPending, proof: res.proof,
    };

    // Show the stake leaving the balance now; the server's balance (with any
    // win) replaces it when the bike lands.
    setBalance(b => b - stakeTotal);
    bumpBalance();
    vibrate(15);
    setPredDisplay(pred1 + ' m');
    setDistance('— m');

    if (soundOnRef.current) playBet();

    gameRef.current.startRound({
      pred: pred1, roundNum: roundNumRef.current,
      crashAt: crashPoint, landDist: landingDist(crashPoint, pred1, won),
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
  const autoCanStart = ready && phase === 'idle' && !autoActive && autoBet1 + autoBet2 <= balance;
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

  // Live crash readout while the bike is in the air: the multiplier climbs
  // with the distance, and flips to "made it" once it passes the pick.
  const liveDist = parseFloat(distance);
  const livePred = parseFloat(predDisplay);
  const liveZone = phase === 'flying' && liveDist >= 0 && livePred > 0
    ? { mult: multAtDist(liveDist), made: liveDist >= livePred, target: targetForPred(livePred, maxMult) }
    : null;

  // Both bets ride the same pick, so a round has one result and only the
  // amounts differ — the result card shows that once, then each bet.
  const resultHead = result?.slips[0];
  const resultNet = result ? result.slips.reduce((n, s) => n + s.payout - s.bet, 0) : 0;

  // balance < 1 blocks betting outright — startRound() floors any bet at a
  // minimum of R1, so without this a R0 balance could still place a bet and
  // go negative. No server connection, no betting.
  const betDisabled = !ready || phase !== 'idle' || autoActive || balance < 1;
  const serverNote = server.status === 'connecting' ? 'Connecting to the game server…'
    : server.status === 'error' ? server.error : '';

  return (
    <div className="phone-frame">
      {showMenu && (
        <MainMenu
          balance={balance}
          streak={streak}
          onPlay={() => setShowMenu(false)}
          onAutoBet={() => setShowMenu(false)}
          onPrepare={() => gameRef.current?.setSuspended(false)}
          onRules={() => setShowRules(true)}
          onHistory={() => { setShowSettings(true); setSettingsPage('history'); }}
          onSettings={() => setShowSettings(true)}
        />
      )}
      <div className="app" ref={appRef}>
        <header>
          <div className="logo"><span className="spark">⚡</span><span className="logo-word">BIKE <b>IT</b></span></div>
          <div className="balance-wrap">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#00ff88" strokeWidth="2.5">
              <circle cx="12" cy="12" r="9" />
              <path d="M9 9.5a3 3 0 0 1 3-2h.5a2.5 2.5 0 0 1 0 5H12a2.5 2.5 0 0 0 0 5h.5a3 3 0 0 0 3-2" />
              <path d="M12 6v2M12 16v2" />
            </svg>
            <div className="balance bump" key={bumpKey}>R{balance.toFixed(2)}</div>
          </div>
          <button type="button" className="icon-btn settings-gear" aria-label="Settings" onClick={() => setShowSettings(true)}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2.2" /><circle cx="10" cy="17" r="2.2" />
            </svg>
          </button>
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
                <div className={`live-zone z-${liveZone.made ? 'great' : 'early'}`}>
                  {liveZone.made
                    ? <>✅ Made it · <b>{fmtMult(liveZone.target)}</b></>
                    : <><b>{fmtMult(liveZone.mult)}</b> · {Math.round(livePred - liveDist)}m to your pick</>}
                </div>
              )}
              <div id="statusMsg">{statusMsg || serverNote}</div>
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
              maxMult={maxMult} serverNote={serverNote}
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
          <div id="resultBox" className={!resultHead.won ? 'is-loss' : resultHead.pm >= 10 ? 'is-top' : 'is-win'}>
            <div className="result-kicker">Round {roundNum} result</div>
            <div className="result-title">{resultHead.won ? `🏁 MADE IT · ${fmtMult(resultHead.pm)}` : '💥 CRASHED SHORT'}</div>
            <div className="result-facts">
              <div><span>Crashed at</span><b>{fmtMult(result.crash)}</b></div>
              <div><span>Landed</span><b>{result.dist}m</b></div>
              <div><span>Your pick</span><b>{resultHead.pred}m · {fmtMult(resultHead.pm)}</b></div>
            </div>
            {!resultHead.won && resultHead.pred - result.dist <= Math.max(5, resultHead.pred * 0.1) && (
              <div className="near-miss">😬 So close — only {resultHead.pred - result.dist}m short of your pick.</div>
            )}
            {result.winPending && (
              <div className="near-miss">⏳ Payout delayed — your win is recorded and will be paid shortly.</div>
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
              <div className="modal-step"><span className="num">1</span> Set your bet and pick a landing distance. Every distance has a multiplier: the further the pick, the bigger it is ({PAYOUT_TIERS.map(t => `${t.dist}m = ${fmtMult(t.mult)}`).join(', ')}).</div>
              <div className="modal-step"><span className="num">2</span> Place your bet. The game server takes the stake and its provably fair RNG draws the round's crash point.</div>
              <div className="modal-step"><span className="num">3</span> The bike launches and the multiplier climbs with the distance until it crashes at that crash point.</div>
              <div className="modal-step"><span className="num">4</span> Land at or past your pick and you win your bet × your pick's multiplier. Fall short and the bet is lost.</div>
            </div>

            <div className="modal-subhead">Pick → Payout</div>
            <div className="tier-table">
              {PAYOUT_TIERS.map(t => (
                <div key={t.key} className={`tier-row t-${t.key}`}>
                  <span className="tier-icon">{t.icon}</span>
                  <div className="tier-mid">
                    <span className="tier-label">{t.label}</span>
                    <span className="tier-range">{t.range}</span>
                  </div>
                  <div className="tier-end"><span className="tier-mult">{fmtMult(t.mult)}</span></div>
                </div>
              ))}
              <div className="tier-row t-miss">
                <span className="tier-icon">❌</span>
                <div className="tier-mid">
                  <span className="tier-label">Crash before your pick</span>
                  <span className="tier-range">Bet lost</span>
                </div>
                <div className="tier-end"><span className="tier-mult">—</span></div>
              </div>
            </div>

            <div className="modal-example">
              💡 <b>Example:</b> you pick <b>100m</b> ({fmtMult(targetForPred(100, maxMult))}). The crash point lands the bike at
              <b> 112m</b>, so a R10 bet pays <b>R{(10 * targetForPred(100, maxMult)).toFixed(2)}</b>. Return to player is 96%, and the
              most you can pick is {fmtMult(maxMult)}.
            </div>

            <button className="modal-close" onClick={() => setShowRules(false)}>Got It</button>
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
                      <span>Sound Effects &amp; Crowd</span>
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
                          <span>Pick {h.pred}m · Crashed {h.crash != null ? fmtMult(h.crash) : '—'} · Landed {h.dist}m</span>
                          <span>{h.won ? fmtMult(h.mult) : 'Lost'}</span>
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

                    <div className="settings-actions">
                      <button type="button" className="settings-btn" onClick={resetSession}>Reset Session Stats</button>
                      <button type="button" className="settings-btn" onClick={reloadBalance} disabled={!ready}>Refresh Balance</button>
                    </div>
                    <div className="account-note">Your balance is your wallet on the game server. Deposits and withdrawals happen in the lobby. The stats above are kept in this browser only.</div>
                  </>
                )}

                {settingsPage === 'privacy' && (
                  <div className="legal-text">
                    <p><b>Your wallet.</b> Bets are taken from, and wins paid into, the wallet of the session you launched the game with. Every round is decided and settled by the game server.</p>
                    <p><b>Data.</b> The game sends the server your stake and your pick each round. Your bet size, prediction, sound preference and session stats are also kept in this browser's storage.</p>
                    <p><b>No warranty.</b> Provided with no guarantee of uptime, accuracy, or fitness for any particular purpose.</p>
                    <p><b>Responsible play.</b> Keep it fun, set limits, and never chase losses.</p>
                  </div>
                )}

                {settingsPage === 'about' && (
                  <div className="legal-text">
                    <p><b>Bike It</b> — a motocross crash game.</p>
                    <p>Version 1.1.0 · Built with React + Canvas.</p>
                    <p>Each round's crash point is drawn by the game server's provably fair RNG (96% return to player). The hash of the server seed is published before play, and the seed is revealed when it rotates so past rounds can be checked.</p>
                    {server.info?.fairness && (
                      <p className="mono-sm">Current seed hash: {server.info.fairness.currentServerSeedHash}</p>
                    )}
                    {result?.proof && (
                      <p className="mono-sm">Last round: seed hash {result.proof.serverSeedHash} · client seed {result.proof.clientSeed} · nonce {result.proof.nonce}</p>
                    )}
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
