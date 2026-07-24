import { useEffect, useRef, useState, useCallback } from 'react';
import { BikeGame } from './game/BikeGame.js';
import { calcPayout, serverMultToCrashAt } from './game/logic.js';
import { playWin, playLose } from './game/sound.js';
import { GameServer } from './api/gameServer.js';

const START_BALANCE = 1000;

export default function App() {
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const serverRef = useRef(null);
  const seededFromServerRef = useRef(false);
  const serverOutcomeRef = useRef(null);

  const [rngStatus, setRngStatus] = useState('offline'); // 'offline' | 'connecting' | 'live'

  // ── Core game state (React-owned) ──────────────────────────────────────────
  const [balance, setBalance] = useState(START_BALANCE);
  const [roundNum, setRoundNum] = useState(1);
  const [betInput, setBetInput] = useState('10');
  const [predInput, setPredInput] = useState('80');
  const [phase, setPhase] = useState('idle');
  const [history, setHistory] = useState([]);

  // ── HUD / display state ────────────────────────────────────────────────────
  const [distance, setDistance] = useState('— m');
  const [predDisplay, setPredDisplay] = useState('— m');
  const [distLabel, setDistLabel] = useState('Predict & Bet to Race');
  const [statusMsg] = useState('');
  const [stats, setStats] = useState({ speed: 0, height: 0 });
  const [statsShow, setStatsShow] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [countdownKey, setCountdownKey] = useState(0);
  const [result, setResult] = useState(null);
  const [shaking, setShaking] = useState(false);
  const [bumpKey, setBumpKey] = useState(0);

  // ── Refs mirroring state needed inside imperative callbacks ────────────────
  const balanceRef = useRef(balance);
  const roundNumRef = useRef(roundNum);
  const betRoundRef = useRef(10);
  const predRoundRef = useRef(80);
  useEffect(() => { balanceRef.current = balance; }, [balance]);
  useEffect(() => { roundNumRef.current = roundNum; }, [roundNum]);

  const bumpBalance = () => setBumpKey(k => k + 1);

  // ── Round outcome resolution ───────────────────────────────────────────────
  const resolveOutcome = useCallback((dist) => {
    const pred = predRoundRef.current;
    const bet = betRoundRef.current;
    const { mult: pm, tier } = calcPayout(dist, pred);
    const won = pm > 0;
    const payout = +(bet * pm).toFixed(2);

    if (won) { setBalance(b => b + payout); playWin(pm); }
    else { playLose(); }
    bumpBalance();

    setHistory(h => [{ won: won ? pm : 0, dist }, ...h].slice(0, 10));

    setResult({
      tier, won, pm, payout,
      pred, dist,
      errPct: Math.round(Math.abs(dist - pred) / dist * 100),
      bet,
      fairness: serverOutcomeRef.current,
    });
  }, []);

  // ── Engine setup ───────────────────────────────────────────────────────────
  useEffect(() => {
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
      onRaceStart: () => { setStatsShow(true); setDistance('0 m'); },
      onDistance: (d) => setDistance(d + ' m'),
      onStats: (s) => setStats(s),
      onShake: () => { setShaking(false); requestAnimationFrame(() => { setShaking(true); setTimeout(() => setShaking(false), 400); }); },
      onLanded: (dist) => resolveOutcome(dist),
    });
    gameRef.current = game;
    return () => { game.destroy(); gameRef.current = null; };
  }, [resolveOutcome]);

  // ── Server connection: source RNG (crash multiplier) + balance ─────────────
  useEffect(() => {
    const server = new GameServer();
    serverRef.current = server;
    server.onStatus = (s) => setRngStatus(s);
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

  // ── Input helpers ──────────────────────────────────────────────────────────
  const numericBet = () => Math.max(1, Math.min(balance, parseFloat(betInput) || 1));
  const setBet = (v) => setBetInput(String(Math.min(balance, Math.max(1, v))));
  const halveBet = () => setBet(Math.max(1, Math.floor(numericBet() / 2)));
  const doubleBet = () => setBet(numericBet() * 2);
  const setPred = (v) => setPredInput(String(v));

  // ── Start round ────────────────────────────────────────────────────────────
  const startRound = () => {
    const bet = Math.max(1, Math.min(balance, parseFloat(betInput) || 10));
    const pred = Math.max(5, parseFloat(predInput) || 80);
    setBetInput(String(bet));
    setPredInput(String(pred));
    if (bet > balance) return;

    betRoundRef.current = bet;
    predRoundRef.current = pred;

    setBalance(b => b - bet);
    bumpBalance();
    setPhase('countdown');            // disables the button immediately
    setPredDisplay(pred + ' m');
    setDistance('— m');

    // Use the server's latest provably-fair crash multiplier as this launch's
    // outcome; falls back to the engine's local RNG when the server is offline.
    const outcome = serverRef.current?.takeOutcome() || null;
    serverOutcomeRef.current = outcome;

    gameRef.current.startRound({
      pred,
      roundNum: roundNumRef.current,
      crashAt: outcome ? serverMultToCrashAt(outcome.multiplier) : null,
    });
  };

  const handleMain = () => { if (phase === 'idle') startRound(); };

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

  const betDisabled = phase !== 'idle';

  return (
    <div className="app">
      <header>
        <div className="logo"><span className="spark">⚡</span> BIKE IT</div>
        <div className={`rng-pill ${rngStatus}`} title="Round outcomes are driven by the server RNG">
          <span className="dot" />
          {rngStatus === 'live' ? 'LIVE RNG' : rngStatus === 'connecting' ? 'CONNECTING…' : 'OFFLINE RNG'}
        </div>
        <div className="round-badge">ROUND <b>{String(roundNum).padStart(4, '0')}</b></div>
        <div className="balance-wrap">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#00ff88" strokeWidth="2.5">
            <circle cx="12" cy="12" r="9" />
            <path d="M9 9.5a3 3 0 0 1 3-2h.5a2.5 2.5 0 0 1 0 5H12a2.5 2.5 0 0 0 0 5h.5a3 3 0 0 0 3-2" />
            <path d="M12 6v2M12 16v2" />
          </svg>
          <div className="balance bump" key={bumpKey}>R{balance.toFixed(2)}</div>
        </div>
      </header>

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
          <div id="statusMsg">{statusMsg}</div>
        </div>

        <div className={`fstats${statsShow ? ' show' : ''}`}>
          <div className="fs">Speed <b>{stats.speed}</b> km/h</div>
          <div className="fs">Height <b>{stats.height}</b>m</div>
        </div>

        {result && (
          <div id="resultOverlay">
            <div id="resultBox">
              <div id="resultTitle" style={{ color: result.won ? '#00ff88' : '#ff3344' }}>{result.tier}</div>
              <div id="resultDetails">
                Your prediction: <b style={{ color: '#fff' }}>{result.pred}m</b><br />
                Actual landing:&nbsp; <b style={{ color: '#fff' }}>{result.dist}m</b><br />
                Error: <b style={{ color: '#fff' }}>{result.errPct}%</b>
              </div>
              <div id="resultPayout" style={{ color: result.won ? '#00ff88' : '#ff3344' }}>
                {result.won ? `+R${result.payout.toFixed(2)} (${result.pm}× bet)` : `-R${result.bet.toFixed(2)}`}
              </div>
              <div id="fairness">
                {result.fairness
                  ? <>⛓ Server RNG · <b>{result.fairness.multiplier.toFixed(2)}×</b> crash
                      {result.fairness.roundId ? <> · #{String(result.fairness.roundId).slice(0, 8)}</> : null}</>
                  : <>⚠ Offline RNG (server unreachable)</>}
              </div>
              <button id="nextBtn" onClick={dismissResult}>Next Round</button>
            </div>
          </div>
        )}

        {countdown !== null && (
          <div id="countdownOverlay">
            <div>
              <div id="countdownLabel">Race Starts In</div>
              <div id="countdownNum" className="beat" key={countdownKey}>{countdown}</div>
            </div>
          </div>
        )}
      </div>

      <div className="controls">
        <div className="col">
          <div className="flbl">Bet Amount (R)</div>
          <input type="number" value={betInput} min="1" step="1"
            onChange={e => setBetInput(e.target.value)} />
          <div className="quick">
            <button onClick={() => setBet(5)}>R5</button>
            <button onClick={() => setBet(10)}>R10</button>
            <button onClick={() => setBet(25)}>R25</button>
            <button onClick={() => setBet(50)}>R50</button>
            <button onClick={() => setBet(100)}>R100</button>
            <button onClick={halveBet}>½</button>
            <button onClick={doubleBet}>2×</button>
          </div>
        </div>

        <div className="col">
          <div className="flbl">Predicted Landing (m)</div>
          <input type="number" value={predInput} min="5" step="5"
            onChange={e => setPredInput(e.target.value)} />
          <div className="quick">
            <button onClick={() => setPred(30)}>30m</button>
            <button onClick={() => setPred(50)}>50m</button>
            <button onClick={() => setPred(80)}>80m</button>
            <button onClick={() => setPred(120)}>120m</button>
            <button onClick={() => setPred(180)}>180m</button>
            <button onClick={() => setPred(250)}>250m</button>
            <button onClick={() => setPred(350)}>350m</button>
          </div>
          <div className="pred-hint">Within <b>5%</b>→8× &nbsp; <b>15%</b>→3× &nbsp; <b>30%</b>→1.5× &nbsp; else→lose</div>
        </div>

        <button id="mainBtn" className="btn-bet" onClick={handleMain} disabled={betDisabled}>
          {phase === 'idle' ? 'Place Bet' : 'Racing…'}
        </button>

        <div className="history-col">
          <div className="flbl">Recent Rounds</div>
          <div className="chips">
            {history.map((h, i) => (
              <span key={i} className={'chip ' + (h.won ? (h.won > 3 ? 'c-big' : 'c-win') : 'c-loss')}>
                {h.dist}m {h.won ? '✓' : '✗'}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
