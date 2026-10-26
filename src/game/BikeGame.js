// Canvas game engine for "Bike It".
//
// This preserves the original imperative rendering/physics but wraps it in a
// class. It owns the canvas, the animation loop, the RNG-driven flight, and the
// countdown; it reports everything the UI needs through the `cb` callbacks and
// never touches the DOM outside the canvas. React owns balance/bet/history/etc.

const RIDERS = ['Rookie', 'Stunt', 'Daredevil', 'Champion', 'Legendary'];
const BIKES = ['Dirt Bike', 'Motocross', 'Racing', 'Rocket', 'Nitro'];
const WEATHERS = [
  { label: 'Tailwind ↑', mult: 1.15 }, { label: 'Headwind ↓', mult: 0.88 },
  { label: 'Rain ☁', mult: 0.93 }, { label: 'Storm ⚡', mult: 0.80 },
  { label: 'Perfect ✦', mult: 1.08 }, { label: 'Calm', mult: 1.00 },
];

// ── Ramp geometry (pure helpers) ───────────────────────────────────────────
function computeRamp(W, H) {
  const gY = H * 0.72;
  const rx = W * 0.40;
  const rw = W * 0.14;
  const rh = H * 0.20;
  const P0 = { x: rx, y: gY };
  const P1 = { x: rx + rw * 0.55, y: gY - rh * 0.40 };
  const P2 = { x: rx + rw, y: gY - rh };
  return { gY, P0, P1, P2, rx, rw, rh };
}
function bp(P0, P1, P2, t) { const m = 1 - t; return { x: m * m * P0.x + 2 * m * t * P1.x + t * t * P2.x, y: m * m * P0.y + 2 * m * t * P1.y + t * t * P2.y }; }
function bt(P0, P1, P2, t) { const m = 1 - t; return { x: 2 * m * (P1.x - P0.x) + 2 * t * (P2.x - P1.x), y: 2 * m * (P1.y - P0.y) + 2 * t * (P2.y - P1.y) }; }

// ── RNG ─────────────────────────────────────────────────────────────────────
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
}
function rh16(n) { return Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b => b.toString(16).padStart(2, '0')).join(''); }
function hashToCrash(hex) {
  const n = parseInt(hex.slice(0, 8), 16) / 0xFFFFFFFF;
  if (n < 0.01) return 1.0;
  return Math.max(1.01, Math.min(0.99 / (1 - n), 200));
}

const CROWD_COLORS = ['#e74c3c', '#3498db', '#f1c40f', '#2ecc71', '#e67e22', '#9b59b6',
  '#ff69b4', '#00bcd4', '#ff5722', '#4caf50', '#fff', '#ffeb3b', '#ff0066', '#00e5ff'];

const FONT_NUM = '"Saira Condensed", "Segoe UI", sans-serif';
// The stuntman's livery — classic stunt red with white and navy. The rider,
// the bike, the crash wreck and the helmets/bikes lying in the graveyard all
// share it, so he reads as the same rider everywhere he appears.
const LIVERY = { main: '#E8323C', light: '#FF7C72', dark: '#A81E2A', far: '#8E1A24', farDark: '#721420' };
// Height of the groomed racing surface as a fraction of canvas height; the
// graveyard props sit in the pit below it.
const TRACK_FRAC = 0.07;
// The rider + bike are drawn this much larger than their base art. The ramp is
// dropped by about the same distance as the scaled tyre contact patch (21px at
// scale 1), so the wheels actually ride its deck.
const BIKE_SCALE = 1.3;
const RAMP_DROP = 24;

// Air tricks, dealt from a shuffled deck so consecutive jumps differ. `flip`
// is full rotations (negative = backflip); `min` is the shortest flight (ms)
// the trick fits into. Body tricks blend the rider into a pose (see
// TRICK_POSES); flips rotate the whole bike + rider with the rider tucked.
// The big body tricks ease in and out more slowly (`ease`, a fraction of the
// trick window) and stand taller, so their name badge sits higher (`top`,
// px above the bike). `weight` deals a trick into the deck more than once:
// the handstand and the jump-off-and-back-on come up every few jumps.
const TRICKS = [
  { kind: 'backflip', flip: -1, min: 1100 },
  { kind: 'frontflip', flip: 1, min: 1250 },
  { kind: 'doubleBackflip', flip: -2, min: 2300 },
  { kind: 'superman', min: 800 },
  { kind: 'nacnac', min: 750 },
  { kind: 'heelclicker', min: 750 },
  { kind: 'nohander', min: 700 },
  { kind: 'cancan', min: 700 },
  { kind: 'whip', min: 650 },
  { kind: 'handstand', min: 950, ease: 0.3, top: 122, weight: 3 },
  { kind: 'rockSolid', min: 850, ease: 0.28, top: 112, weight: 3 },
  { kind: 'cliffhanger', min: 1000, ease: 0.28, top: 116 },
  { kind: 'lazyBoy', min: 850, ease: 0.24 },
];
// Torso angle of the plain riding pose — the helmet turns by however far a
// trick pose rotates the torso away from it.
const RIDE_TORSO = Math.atan2(-13.5, 8);
// Rider targets (bike-local, before BIKE_SCALE) each trick blends toward.
const TUCK = { hip: [-9.5, -14], shoulder: [-0.5, -26] };
const TRICK_POSES = {
  superman: { hip: [-8, -19], shoulder: [0.5, -27.2], foot: [-27, -17.5] },
  nacnac: { hip: [-7.5, -18], shoulder: [0, -28.2], foot: [-21, -19], farFoot: [-1.5, 2.5] },
  heelclicker: { hip: [-6.5, -18.5], shoulder: [-3.5, -29.5], foot: [15, -25] },
  cancan: { hip: [-9, -17.5], shoulder: [-2.5, -29], foot: [6, -20], farFoot: [-1.5, 2.5] },
  nohander: { hip: [-9, -18], shoulder: [-2, -30], hand: [-7, -41], farHand: [-1, -42.5] },
  whip: { hip: [-10, -16], shoulder: [-2.5, -28.5] },
  // Kicks up into a handstand on the bars: hands stay on the grips, body
  // straight up above them, legs split at the top.
  handstand: { hip: [4, -48], shoulder: [5.5, -33], foot: [1, -70.5], farFoot: [6.5, -68] },
  // Lets go of the bike completely and flies stretched out above it (`float`
  // drifts the body up and down while it's held), then drops back on.
  rockSolid: { hip: [-11, -46], shoulder: [3, -50.5], hand: [15.5, -53], farHand: [16, -49.5], foot: [-33.5, -43], farFoot: [-33, -47], float: 5 },
  // Feet hooked under the bars, standing up tall with both arms raised.
  cliffhanger: { hip: [2, -38], shoulder: [-1, -53], foot: [7.5, -17.6], farFoot: [8.2, -18.2], hand: [-13, -60], farHand: [9, -61] },
  // Lies back along the seat, feet hooked on the bars, hands behind the head.
  lazyBoy: { hip: [-13, -17.5], shoulder: [-27, -23], foot: [6.5, -17.2], farFoot: [7.2, -17.8], hand: [-31.5, -29], farHand: [-30, -30.5] },
  backflip: TUCK, frontflip: TUCK, doubleBackflip: TUCK,
};
const TRICK_LABELS = {
  superman: 'SUPERMAN', nacnac: 'NAC-NAC', heelclicker: 'HEEL CLICKER', nohander: 'NO-HANDER',
  cancan: 'CAN-CAN', whip: 'WHIP', backflip: 'BACKFLIP', frontflip: 'FRONTFLIP', doubleBackflip: 'DOUBLE BACKFLIP',
  handstand: 'HANDSTAND', rockSolid: 'ROCK SOLID', cliffhanger: 'CLIFFHANGER', lazyBoy: 'LAZY BOY',
};

// ── Wreckage ────────────────────────────────────────────────────────────────
// A "biker graveyard" scattered along the track: the remains of past riders
// who didn't stick the landing. Each item (a tire, a skull, a bone, a helmet,
// a smoking frame, a memorial cross, a bull skull, boulders) lands on its own,
// independently placed — not bundled into one pile — so the sand reads as
// scattered debris rather than a cluster.
const WRECK_KINDS = ['tireLean', 'tireFlat', 'skull', 'bone', 'helmet', 'brokenBiker', 'dinoBones', 'humanSkeleton',
  'cowSkull', 'graveCross', 'rocks'];
// The stand's background repaint is split into this many short stages
// (bowl, five slices of seat rows, then haze/aisles/roof) — see
// paintCrowdStage / ensureCrowdLayer.
const CROWD_STAGES = 7;

export class BikeGame {
  // `options.viewShift` (fraction of canvas width) pushes the track, ramp and
  // rider to the right, e.g. so a menu can sit over the left side of the scene.
  // `options.ambientFps` / `options.crowdMs` set how smoothly the scene
  // animates between rounds and how often the crowd repaints. `maxDpr` caps
  // the render resolution (a backdrop doesn't need full retina), `animateDone`
  // keeps the crash scene (smoke, flames) alive after a round instead of
  // freezing on its last frame, and `suspended` starts the engine idle — no
  // drawing at all until setSuspended(false), e.g. while hidden by a menu.
  constructor(canvas, callbacks = {}, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks;
    this.viewShift = options.viewShift || 0;
    this.ambientFps = options.ambientFps || 30;
    this.crowdMs = options.crowdMs || 70;
    this.maxDpr = options.maxDpr || 2;
    this.animateDone = !!options.animateDone;
    this._suspended = !!options.suspended;
    // Chance per (long enough) jump that the dragon attacks the rider — show
    // only; it never changes the flight or the landing.
    this.dragonChance = options.dragonChance ?? 0.28;
    this.burnT = null; this._attack = false;

    this.phase = 'idle';        // idle|countdown|approach|ramp|flying|crashing|done
    this.crashAt = 2; this.mult = 1;
    this.pred = 80; this.roundNum = 1;
    this.pendingCrash = false;
    this.serverSeed = ''; this.clientSeed = ''; this.roundHash = '';
    this.bx = 0; this.by = 0; this.bvx = 0; this.bvy = 0; this.rampT = 0;
    this.trail = []; this.particles = [];
    this.approachTs = null; this.rampTs = null; this.flyTs = null; this.crashFrames = 0;
    this.actualDist = 0;
    this.camX = 0; this.camTargetX = 0; this.camY = 0; this.camTargetY = 0;
    this.R = null;
    this._lastDist = null;
    this.cheer = 0; // 0..1 crowd excitement, spikes on an accurate landing and decays
    this.landCheer = 0; // the landing's cheer before it decays (drives pyro + fireworks)
    // Adaptive quality (see trackFrame): flips on for the session if this
    // device can't keep up, dropping the costliest live extras.
    this.lowPower = false; this._frameEma = 16.7; this._slowFrames = 0; this._lastRafTs = null;
    this._camTs = null; // drives frame-rate-independent camera smoothing (see camLerp)

    // Offscreen cache for the (expensive) star/cloud/moon sky layer — see
    // renderSkyLayer/drawSky. Repainted on its own setTimeout cadence
    // (~140ms) rather than inline inside the rAF loop: none of it moves fast
    // enough to need every-frame updates, and doing the heavy gradient/stroke
    // work synchronously inside the render loop — even just "every 3rd
    // frame" — makes that one frame run long enough to visibly stall the
    // biker's own motion (the "stopping and playing" stutter). Scheduling it
    // as a separate timer keeps it fully off the biker/camera's critical path.
    this._skyCanvas = null; this._skyCtx = null; this._skyTimer = null;

    // Offscreen caches for the other consistently-expensive-but-slow-changing
    // scene layers found by profiling a full round: the crowd (~700 individual
    // fans redrawn every frame), the ground texture speckle (pebbles/patches/
    // weeds, ~500 primitives/frame) and the wreckage field. Same reasoning as
    // the sky cache above — none of this needs full per-primitive redraw work
    // on every single rAF tick, so it's baked to offscreen canvases and only
    // the *position* (a cheap drawImage offset) is recomputed every frame.
    this._groundBands = null; this._groundW = 0; this._groundH = 0;
    this._wreckCanvas = null; this._wreckMeta = null;
    this._crowdCanvas = null; this._crowdCtx = null; this._crowdTimer = null;
    this._ribbon = null; this._ledPattern = null; this._idleRaf = null;
    this.landedGood = false;

    // Canvas text can't trigger a webfont download by itself, so request the
    // condensed face explicitly and drop the ribbon strip baked with the fallback.
    document.fonts?.load(`800 16px ${FONT_NUM}`).then(() => { this._ribbon = null; }).catch(() => {});

    this.raf = null;
    this.cdTimer = null;
    this._loop = (ts) => this.safeLoop(ts);
    this._onResize = () => { this.resize(); if (this.phase === 'idle' && !this._suspended) this.drawIdle(); };

    this.resize();
    this.buildCrowd();
    this.buildWrecks();
    window.addEventListener('resize', this._onResize);
    // A ResizeObserver on the canvas itself catches size changes a window
    // resize wouldn't — CSS layout shifts (aspect-ratio recalculation, the
    // phone-frame's own breakpoint, mobile browser chrome show/hide) — so the
    // canvas stays correctly scaled on any phone/viewport without relying
    // solely on the window firing its own resize event.
    this._ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this._onResize()) : null;
    this._ro?.observe(this.canvas);
    if (!this._suspended) this.drawIdle();
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    this._ro?.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this._idleRaf) cancelAnimationFrame(this._idleRaf);
    this._idleRaf = null;
    if (this.cdTimer) clearInterval(this.cdTimer);
    if (this._crowdTimer) clearTimeout(this._crowdTimer);
    if (this._skyTimer) clearTimeout(this._skyTimer);
    // Without this, a countdown that finishes right as the component unmounts
    // (StrictMode remount, HMR, navigating away) still fires beginRace() on a
    // torn-down instance afterward, kicking off a zombie animation loop.
    if (this.raceStartTimer) clearTimeout(this.raceStartTimer);
  }

  // The backing store is sized in real device pixels (CSS size × devicePixelRatio)
  // so the scene renders crisp on Retina/high-DPI screens instead of being
  // upscaled and soft; a ctx transform then maps all drawing math back to
  // plain CSS-pixel coordinates so nothing else in the file has to know about
  // dpr. `cw`/`ch` are the logical (CSS-pixel) dimensions everything else uses.
  resize() {
    // Capped (2× by default): on a 3× phone the canvas and its cached layers
    // would each be ~2.25× the pixels to fill every frame for no visible gain
    // at this art style's line weights.
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    this.dpr = dpr;
    this.cw = this.canvas.offsetWidth;
    this.ch = this.canvas.offsetHeight;
    this.canvas.width = Math.round(this.cw * dpr);
    this.canvas.height = Math.round(this.ch * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.R = null;
    // The sky cache is sized off the old canvas dimensions — drop it so
    // renderSkyLayer rebuilds it at the new size on the next frame instead of
    // drawing a stretched/cropped stale image.
    this._skyCanvas = null;
    // Same reasoning: these are all sized/positioned off the old canvas
    // dimensions or ramp geometry, so drop them and let the ensure* helpers
    // rebuild lazily at the new size instead of blitting a stale/stretched image.
    this._groundBands = null;
    this._wreckCanvas = null;
    this._crowdCanvas = null;
    this._ribbon = null;
  }

  // Frame-rate-independent version of the classic `v += (target - v) * k`
  // exponential smoothing. `k` is the per-frame factor the code was tuned at
  // 60fps (e.g. 0.07); at any other actual frame rate/dt this converges to
  // the same visual speed instead of panning faster on a high-refresh screen
  // or looking laggy/stepped on a slow one.
  camLerp(v, target, k, dt) {
    return v + (target - v) * (1 - Math.pow(1 - k, dt));
  }

  getRamp() { if (!this.R) this.R = computeRamp(this.cw, this.ch); return this.R; }

  calcMult(ms) { return Math.pow(1 + ms / 9000, 2.7); }
  toMeters(worldX, r) { return Math.max(0, Math.round((worldX - r.P2.x) * 0.22)); }

  async initRNG() {
    this.serverSeed = rh16(16); this.clientSeed = rh16(8);
    this.roundHash = await sha256(this.serverSeed + ':' + this.clientSeed + ':' + this.roundNum);
    this.crashAt = hashToCrash(this.roundHash);
  }

  // ── Round lifecycle ──────────────────────────────────────────────────────
  // `crashAt` (when supplied) is the server's provably-fair crash multiplier and
  // drives the outcome directly. When absent (server offline) we fall back to the
  // local crypto RNG plus a random weather modifier.
  async startRound({ pred, roundNum, crashAt = null }) {
    this.pred = pred;
    this.roundNum = roundNum;

    const rider = RIDERS[Math.floor(Math.random() * RIDERS.length)];
    const bike = BIKES[Math.floor(Math.random() * BIKES.length)];

    if (crashAt != null && Number.isFinite(crashAt)) {
      this.crashAt = Math.max(1.01, Math.min(crashAt, 200));
      this.cb.onMeta?.({ rider, bike, weather: 'Live RNG' });
    } else {
      await this.initRNG();
      const wx = WEATHERS[Math.floor(Math.random() * WEATHERS.length)];
      this.crashAt = Math.max(1.01, this.crashAt * wx.mult);
      this.cb.onMeta?.({ rider, bike, weather: wx.label });
    }

    this.startCountdown();
  }

  startCountdown() {
    this.phase = 'countdown';
    this.cb.onPhase?.('countdown');
    let val = 3;
    this.cb.onCountdown?.(val);
    clearInterval(this.cdTimer);
    clearTimeout(this.raceStartTimer);
    this.cdTimer = setInterval(() => {
      val--;
      this.cb.onCountdown?.(Math.max(val, 0));
      if (val <= 0) {
        clearInterval(this.cdTimer);
        this.raceStartTimer = setTimeout(() => {
          this.cb.onCountdown?.(null);
          this.beginRace();
        }, 500);
      }
    }, 1000);
  }

  beginRace() {
    this.mult = 1; this.flyTs = null; this.trail = []; this.particles = [];
    this.rampT = 0; this.crashFrames = 0; this.camX = this.camBias(); this.camTargetX = this.camX;
    this.approachTs = null; this.rampTs = null; this.pendingCrash = false;
    this._lastDist = null; this.cheer = 0; this.landCheer = 0; this.physTs = null; this._camTs = null;
    this.burnT = null; this._attack = false;

    const r = this.getRamp();
    this.bx = this.startX(r); this.by = r.gY; this.bvx = 3.8; this.bvy = 0;

    this.cb.onRaceStart?.();
    this.phase = 'approach';
    this.cb.onPhase?.('approach');
    this.raf = requestAnimationFrame(this._loop);
  }

  reset() {
    if (this.raf) cancelAnimationFrame(this.raf); // ends an animateDone crash loop
    this.phase = 'idle';
    this.camX = this.camBias(); this.camTargetX = this.camX; this.camY = 0; this.camTargetY = 0;
    this.drawIdle();
  }

  // Resting camera offset that realises `viewShift` (screen x = world x - camX).
  camBias() { return -this.viewShift * this.cw; }

  // Where the bike waits (and the run-up starts): left of the ramp, but never
  // so far left on a narrow phone that its tail hangs off the screen.
  startX(r) { return Math.max(r.P0.x - this.cw * 0.31, 52 + this.camBias()); }

  // Flight time from takeoff to touchdown. The vertical motion is purely
  // ballistic (see physStep: gravity 0.14 per 60fps frame), so it's known the
  // moment the bike leaves the ramp — which lets every trick finish in time.
  flightMs(r) {
    const g = 0.14, v = this.bvy, drop = r.gY - this.by;
    return ((-v + Math.sqrt(v * v + 2 * g * drop)) / g) * 16.6667;
  }

  pickTrick(flightMs) {
    if (!this._trickDeck?.length) {
      const deck = TRICKS.flatMap((t) => Array(t.weight || 1).fill(t.kind));
      for (let i = deck.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [deck[i], deck[j]] = [deck[j], deck[i]]; }
      this._trickDeck = deck;
    }
    // The first card that fits this flight — skipping the trick just done,
    // so a weighted favourite never plays twice in a row.
    const fits = (k) => TRICKS.find((t) => t.kind === k).min <= flightMs;
    let i = this._trickDeck.findIndex((k) => fits(k) && k !== this._lastTrick);
    if (i < 0) i = this._trickDeck.findIndex(fits);
    if (i < 0) return { kind: 'none' };
    const kind = this._trickDeck.splice(i, 1)[0];
    this._lastTrick = kind;
    return { ...TRICKS.find((t) => t.kind === kind) };
  }

  // The trick's name pops in above the rider on a dark glass badge with a
  // gold rim, then drifts up and fades as the trick finishes. (The dragon's
  // "fire" badge uses the same shape in red and orange.)
  drawTrickLabel(tr, x, y, text) {
    if (tr.kind === 'none' || tr.p <= 0 || tr.p >= 1) return;
    const ctx = this.ctx, fire = tr.kind === 'fire';
    const alpha = Math.min(1, tr.p / 0.08, (1 - tr.p) / 0.15);
    const pop = 1 + 0.3 * Math.max(0, 1 - tr.p / 0.1);
    const label = text || TRICK_LABELS[tr.kind];
    ctx.save();
    ctx.translate(x, y - tr.p * 12); ctx.scale(pop, pop);
    ctx.globalAlpha = alpha;
    ctx.font = `italic 800 18px ${FONT_NUM}`;
    const w = ctx.measureText(label).width + 30;
    ctx.fillStyle = fire ? 'rgba(34,8,6,0.86)' : 'rgba(8,12,22,0.82)';
    ctx.beginPath(); ctx.roundRect(-w / 2, -14, w, 28, 14); ctx.fill();
    ctx.strokeStyle = fire ? 'rgba(255,96,40,0.9)' : 'rgba(255,210,63,0.75)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = fire ? '#FF8A3D' : '#2EE59D';
    [-1, 1].forEach((s) => {
      const sx = s * (w / 2 - 9);
      ctx.beginPath(); ctx.moveTo(sx, -4); ctx.lineTo(sx + 1.4, 0); ctx.lineTo(sx, 4); ctx.lineTo(sx - 1.4, 0); ctx.closePath(); ctx.fill();
    });
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const g = ctx.createLinearGradient(0, -9, 0, 9);
    g.addColorStop(0, fire ? '#FFE6A8' : '#FFF3B0'); g.addColorStop(1, fire ? '#FF5A28' : '#FFB23F');
    ctx.fillStyle = g; ctx.fillText(label, 0, 1);
    ctx.restore();
  }

  // A glowing swoosh trailing the rider's head around a flip (bike-local,
  // scaled space; `angle` is the bike's current rotation).
  drawFlipSwoosh(angle, dir, strength) {
    const ctx = this.ctx;
    const head = angle - Math.PI / 2, span = 2.1;
    ctx.save();
    ctx.lineCap = 'round';
    [[36, '220,255,240'], [27, '46,229,157']].forEach(([r, rgb], band) => {
      for (let i = 0; i < 14; i++) {
        const t0 = i / 14, t1 = (i + 1) / 14;
        const b0 = head - dir * span * (1 - t0), b1 = head - dir * span * (1 - t1);
        ctx.strokeStyle = `rgba(${rgb},${(band ? 0.4 : 0.6) * t1 * strength})`;
        ctx.lineWidth = (band ? 0.8 : 1.2) + (band ? 2.2 : 3.4) * t1;
        ctx.beginPath(); ctx.moveTo(Math.cos(b0) * r, Math.sin(b0) * r - 12); ctx.lineTo(Math.cos(b1) * r, Math.sin(b1) * r - 12); ctx.stroke();
      }
    });
    ctx.restore();
  }

  // Horizontal speed streaks behind the bike (for the whip).
  drawSpeedStreaks(strength) {
    const ctx = this.ctx;
    ctx.save(); ctx.lineCap = 'round';
    [[-10, 26], [-2, 34], [6, 22], [-18, 18]].forEach(([y, len], i) => {
      const g = ctx.createLinearGradient(-30 - len, 0, -26, 0);
      g.addColorStop(0, 'rgba(220,255,240,0)'); g.addColorStop(1, `rgba(220,255,240,${0.55 * strength})`);
      ctx.strokeStyle = g; ctx.lineWidth = 1.4 + (i % 2);
      ctx.beginPath(); ctx.moveTo(-30 - len, y); ctx.lineTo(-26, y); ctx.stroke();
    });
    ctx.restore();
  }

  // Twinkling gold sparkles ringing the rider at the peak of a body trick,
  // centred on the body (`cy`, bike-local) so they follow a rider who has
  // climbed up off the bike.
  drawTrickSparkles(env, ts, cy = -18) {
    const ctx = this.ctx;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 7; i++) {
      const a = i * 0.9 + ts * 0.0018, rr = 30 + (i % 2) * 9;
      const x = Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.72;
      const s = (1.6 + (i % 3) * 0.8) * env * (0.6 + 0.4 * Math.sin(ts * 0.02 + i));
      ctx.fillStyle = `rgba(255,232,150,${0.85 * env})`;
      ctx.beginPath();
      ctx.moveTo(x, y - s * 2); ctx.lineTo(x + s * 0.45, y); ctx.lineTo(x, y + s * 2); ctx.lineTo(x - s * 0.45, y); ctx.closePath();
      ctx.moveTo(x - s * 2, y); ctx.lineTo(x, y + s * 0.45); ctx.lineTo(x + s * 2, y); ctx.lineTo(x, y - s * 0.45); ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // Progress of the current air trick: `p` runs 0→1 across its window of the
  // flight (12%–80%, so it always lands clean) and `env` eases the pose in
  // and out at either end of that window.
  trickState(ts) {
    const t = this.trick;
    if (this.phase !== 'flying' || !t || t.kind === 'none' || this.flyTs == null || !this.flyMs) return { kind: 'none', flip: 0, p: 0, env: 0 };
    const u = (ts - this.flyTs) / this.flyMs;
    const p = Math.max(0, Math.min(1, (u - 0.12) / 0.68));
    const ease = t.ease || 0.18;
    const e = Math.max(0, Math.min(1, p / ease, (1 - p) / ease));
    return { kind: t.kind, flip: t.flip || 0, p, env: e * e * (3 - 2 * e) };
  }

  // Pauses all ambient redraws (the idle loop and background layer timers)
  // while the canvas is hidden — e.g. behind the main menu.
  setSuspended(on) {
    this._suspended = on;
    if (on) {
      if (this._idleRaf) cancelAnimationFrame(this._idleRaf);
      this._idleRaf = null;
    } else if (this.phase === 'idle') {
      this.drawIdle();
    }
  }

  // A drawing bug must never take the whole page down with it: the first
  // error is reported and the game carries on (the round's physics and
  // outcome don't depend on any frame being drawn).
  report(e) {
    if (!this._reported) { this._reported = true; console.error('[BikeGame]', e); }
  }
  // Watches the real frame rate. A device that stays under ~38fps for a
  // couple of seconds switches to low-power mode for the session: the front
  // rows' live wave folds back into the cached stand and the stand flashes
  // thin out — everything else looks the same. (Long gaps from a hidden tab
  // are ignored.)
  trackFrame(ts) {
    const dt = this._lastRafTs == null ? 0 : ts - this._lastRafTs;
    this._lastRafTs = ts;
    if (this.lowPower || !(dt > 0) || dt > 250) return;
    this._frameEma += (dt - this._frameEma) * 0.05;
    this._slowFrames = this._frameEma > 26 ? this._slowFrames + 1 : 0;
    if (this._slowFrames > 120) this.lowPower = true;
  }

  safeLoop(ts) {
    this.trackFrame(ts);
    try { this.loop(ts); } catch (e) {
      this.report(e);
      if (['approach', 'ramp', 'flying', 'crashing'].includes(this.phase)) this.raf = requestAnimationFrame(this._loop);
    }
  }

  // ── Game loop ────────────────────────────────────────────────────────────
  loop(ts) {
    const W = this.cw, H = this.ch, r = this.getRamp();
    // A single frame-rate-independent dt (60fps units) shared by every
    // camera-smoothing lerp this frame, so panning speed stays consistent
    // regardless of actual refresh rate/frame timing instead of the old
    // per-frame-constant factor drifting slower/faster with FPS.
    const camDt = this._camTs != null ? Math.min(3, Math.max(0.05, (ts - this._camTs) / 16.6667)) : 1;
    this._camTs = ts;

    if (this.phase === 'approach') {
      if (!this.approachTs) this.approachTs = ts;
      this.bvx = 3.8 + (ts - this.approachTs) / 160; this.bx += this.bvx; this.by = r.gY; this.camX = this.camBias();
      this.camY = this.camLerp(this.camY, 0, 0.08, camDt);
      this.drawScene(ts, false);
      if (this.bx >= r.P0.x) { this.bx = r.P0.x; this.by = r.P0.y; this.rampT = 0; this.rampTs = ts; this.phase = 'ramp'; }
      this.raf = requestAnimationFrame(this._loop); return;
    }

    if (this.phase === 'ramp') {
      this.rampT = Math.min((ts - this.rampTs) / 550, 1);
      const pt = bp(r.P0, r.P1, r.P2, this.rampT); this.bx = pt.x; this.by = pt.y; this.camX = this.camBias();
      this.camY = this.camLerp(this.camY, 0, 0.08, camDt);
      this.drawScene(ts, false);
      if (this.rampT >= 1) {
        const tn = bt(r.P0, r.P1, r.P2, 1);
        const spd = 8 + Math.log(Math.max(1.01, this.crashAt)) / Math.log(200) * 32;
        const len = Math.hypot(tn.x, tn.y);
        this.bvx = (tn.x / len) * spd; this.bvy = (tn.y / len) * spd;
        this.phase = 'flying'; this.flyTs = ts; this.physTs = ts;
        this.flyMs = this.flightMs(r);
        this.trick = this.pickTrick(this.flyMs);
        this._attack = this.flyMs > 1300 && Math.random() < this.dragonChance;
        this.cb.onPhase?.('flying');
      }
      this.raf = requestAnimationFrame(this._loop); return;
    }

    if (this.phase === 'flying') {
      const el = ts - this.flyTs; this.mult = this.calcMult(el);
      this.camTargetX = Math.max(this.camBias(), this.bx - W * 0.38 + this.camBias());
      this.camX = this.camLerp(this.camX, this.camTargetX, 0.07, camDt);
      // Camera ceiling: never let the bike's screen position rise above 50%
      // of canvas height, leaving clearance below the Distance/Your Pick HUD
      // panel pinned near the top so the rider sprite (which extends well
      // above its anchor point) never overlaps it.
      this.camTargetY = this.by < r.gY - H * 0.05 ? Math.max(0, H * 0.5 - this.by) : 0;
      this.camY = this.camLerp(this.camY, this.camTargetY, 0.06, camDt);

      if (this.mult >= this.crashAt) { this.mult = this.crashAt; this.pendingCrash = true; }

      const d = this.toMeters(this.bx, r);
      if (this._lastDist !== d) {
        this._lastDist = d;
        this.cb.onDistance?.(d);
      }
      this.cb.onStats?.({
        speed: Math.round(85 + this.mult * 24),
        height: Math.round(Math.abs(Math.sin(el / 850)) * this.mult * 12),
      });
      this.physStep(r, ts); this.drawScene(ts, false);
      this.raf = requestAnimationFrame(this._loop); return;
    }

    if (this.phase === 'crashing') {
      const dt = this.physStep(r, ts);
      this.crashFrames += dt;
      this.cheer *= Math.pow(0.965, dt);
      this.camTargetY = this.by < r.gY - H * 0.05 ? Math.max(0, H * 0.5 - this.by) : 0;
      this.camY = this.camLerp(this.camY, this.camTargetY, 0.08, camDt);
      this.drawScene(ts, true);
      if (this.crashFrames < 90) { this.raf = requestAnimationFrame(this._loop); return; }
      this.phase = 'done';
      this.cb.onPhase?.('done');
      this.cb.onLanded?.(this.actualDist);
      if (this.animateDone && this.phase === 'done') this.raf = requestAnimationFrame(this._loop);
      return;
    }

    // After the round (animateDone only): the smoke keeps rolling up and the
    // wreck keeps burning until reset(), rather than freezing on one frame.
    if (this.phase === 'done' && this.animateDone) {
      const dt = this.physStep(r, ts);
      this.crashFrames = Math.min(this.crashFrames + dt, 600);
      this.cheer *= Math.pow(0.965, dt);
      this.drawScene(ts, true);
      this.raf = requestAnimationFrame(this._loop);
    }
  }

  // `dt` is frame time normalized to 60fps units (1 == one frame at 60Hz) so
  // the flight's actual physics — and therefore the landing distance a
  // player is paid out on — stay consistent across 30Hz/60Hz/120Hz+ devices
  // instead of a higher refresh rate silently integrating gravity faster and
  // cutting flights short. Clamped so a backgrounded-tab resume (a huge ts
  // gap) can't make the bike teleport in one step. Returns `dt` so callers
  // that track their own frame-based counters (e.g. the crash tumble timer)
  // can stay in step with the same clock.
  physStep(r, ts) {
    const dt = this.physTs != null ? Math.min(3, Math.max(0.1, (ts - this.physTs) / 16.6667)) : 1;
    this.physTs = ts;
    this.bvy += 0.14 * dt; this.bx += this.bvx * dt; this.by += this.bvy * dt;
    if (this.phase !== 'crashing') this.bvx = 3.2 + this.mult * 0.85;
    if (this.by >= r.gY) {
      this.by = r.gY;
      if (this.phase === 'flying') {
        this.bvx = 0; this.bvy = 0;
        this.actualDist = this.toMeters(this.bx, r);
        this.pendingCrash = false;
        this.phase = 'crashing';
        // The crowd's reaction is scaled off how close the landing was to the
        // player's own prediction — an approximation of "was that a good
        // round" that stays purely cosmetic (App.jsx/logic.js remain the only
        // source of truth for the actual payout).
        const errPct = Math.abs(this.actualDist - this.pred) / Math.max(this.actualDist, 1);
        this.cheer = Math.max(0, 1 - errPct / 0.3);
        this.landCheer = this.cheer; // undecayed, for the pyro/fireworks show
        this.landedGood = this.cheer > 0;
        this.spawnParticles(this.cheer);
        this.cb.onShake?.();
      } else if (this.phase === 'crashing') {
        this.bvx = 0; this.bvy = 0;
      }
    }
    return dt;
  }

  // ── Particles ────────────────────────────────────────────────────────────
  // The blast throws out streaking embers, tumbling chunks of bike and clods
  // of dirt; `cheer` (0..1, how close the landing was to the player's
  // prediction) adds a celebratory burst of confetti on top.
  spawnParticles(cheer = 0) {
    const ox = this.bx, oy = this.by + 16;
    const burst = (n, type, make) => { for (let i = 0; i < n; i++) this.particles.push({ type, x: ox, y: oy, life: 1, rot: 0, spin: 0, ...make(i) }); };
    const up = (spread, lo, hi) => {
      const a = -Math.PI * (0.5 + (Math.random() - 0.5) * spread), s = lo + Math.random() * (hi - lo);
      return { vx: Math.cos(a) * s, vy: Math.sin(a) * s };
    };
    burst(44, 'ember', () => ({ ...up(1.8, 4, 12), decay: 0.02 + Math.random() * 0.015, r: 1.4 + Math.random() * 2.2, col: Math.random() < 0.5 ? '255,214,120' : '255,140,50' }));
    burst(16, 'debris', (i) => ({ ...up(1.5, 3, 9), decay: 0.011, r: 2 + Math.random() * 3, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 0.5, col: ['#2A2F3A', '#5B6475', LIVERY.main, '#F4F7FB'][i % 4] }));
    burst(26, 'dirt', (i) => ({ ...up(1.3, 2, 7), decay: 0.015, r: 1.5 + Math.random() * 2.5, col: ['#7A5530', '#5A3D22', '#A37547'][i % 3] }));
    burst(Math.round(cheer * 70), 'confetti', () => ({ ...up(1.6, 4, 11), decay: 0.012, r: 1.6 + Math.random() * 2, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 0.6, col: CROWD_COLORS[(Math.random() * CROWD_COLORS.length) | 0] }));
  }

  tickParticles() {
    const ctx = this.ctx;
    const floor = this.getRamp().gY + 21 * BIKE_SCALE;
    this.particles.forEach((p) => {
      p.x += p.vx; p.y += p.vy;
      p.vy += p.type === 'smoke' ? -0.01 : p.type === 'ember' ? 0.12 : p.type === 'confetti' ? 0.1 : 0.22;
      p.vx *= p.type === 'confetti' ? 0.97 : 0.99;
      p.rot += p.spin;
      p.life -= p.decay;
      if (p.type !== 'ember' && p.type !== 'smoke' && p.y > floor) { p.y = floor; p.vy *= -0.3; p.vx *= 0.6; p.spin *= 0.5; }
      if (p.life <= 0) return;
      const sx = p.x - this.camX;
      if (p.type === 'smoke') {
        // Smoke from the burning bike: puffs that swell and thin out
        const r = p.r * (1 + (1 - p.life) * 2.2);
        ctx.fillStyle = `rgba(62,56,58,${0.38 * p.life})`;
        ctx.beginPath(); ctx.arc(sx, p.y, r, 0, Math.PI * 2); ctx.fill();
        return;
      }
      if (p.type === 'debris') {
        // Chunks of bike trail a thin smoke wisp (kept in world space so it
        // scrolls with the camera)
        (p.tr || (p.tr = [])).push(p.x, p.y);
        if (p.tr.length > 16) p.tr.splice(0, 2);
        ctx.lineCap = 'round';
        for (let i = 2; i < p.tr.length; i += 2) {
          ctx.strokeStyle = `rgba(70,62,58,${0.35 * p.life * (i / p.tr.length)})`; ctx.lineWidth = 1 + (p.tr.length - i) * 0.25;
          ctx.beginPath(); ctx.moveTo(p.tr[i - 2] - this.camX, p.tr[i - 1]); ctx.lineTo(p.tr[i] - this.camX, p.tr[i + 1]); ctx.stroke();
        }
        ctx.lineCap = 'butt';
      }
      if (p.type === 'ember') {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(${p.col},${p.life})`; ctx.lineWidth = p.r; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(sx, p.y); ctx.lineTo(sx - p.vx * 1.6, p.y - p.vy * 1.6); ctx.stroke();
        ctx.restore();
      } else if (p.type === 'dirt') {
        ctx.globalAlpha = Math.min(1, p.life * 1.5); ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(sx, p.y, p.r, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.save();
        ctx.translate(sx, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = Math.min(1, p.life * 1.5); ctx.fillStyle = p.col;
        ctx.fillRect(-p.r, -p.r * 0.6, p.r * 2, p.r * 1.2);
        ctx.restore();
      }
    });
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  // ── Scene ────────────────────────────────────────────────────────────────
  drawScene(ts, crash) {
    if (!this.cw || !this.ch) return; // hidden / not laid out yet
    const W = this.cw, H = this.ch, r = this.getRamp(), ctx = this.ctx;
    this.drawSky(W, H, ts);
    ctx.save();
    ctx.translate(0, this.camY);
    this.drawBg(W, H, ts, r);
    this.drawStadium(W, H, r.gY, ts);
    this.drawRamp(r);
    this.drawPredMarker(r, H);
    this.trail.push({ x: this.bx, y: this.by });
    if (this.trail.length > 65) this.trail.shift();
    this.drawTrail(crash);
    this.tickParticles();
    this.drawBiker(this.bx - this.camX, this.by, crash, ts);
    if (!crash && this.burnT != null) this.drawBurning(this.bx - this.camX, this.by, ts);
    if (!crash) this.drawTrickLabel(this.trickState(ts), this.bx - this.camX, this.by - (this.trick?.top || 72));
    if (!crash && this.burnT != null && ts - this.burnT < 1600) {
      this.drawTrickLabel({ kind: 'fire', p: (ts - this.burnT) / 1600 }, this.bx - this.camX, this.by - (this.trick?.top || 72) - 34, 'DRAGON FIRE!');
    }
    ctx.restore();
    this.drawDragonAttack(ts);

    // The blast briefly whites out the whole screen
    if (crash && this.crashFrames < 7) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,232,190,${0.4 * (1 - this.crashFrames / 7)})`;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  drawIdle() {
    try { this.drawIdleFrame(0); } catch (e) { this.report(e); }
    this.startIdleLoop();
  }

  drawIdleFrame(ts) {
    if (!this.cw || !this.ch) return; // hidden / not laid out yet
    const W = this.cw, H = this.ch, r = this.getRamp(); this.camX = this.camBias();
    this.ctx.clearRect(0, 0, W, H);
    this.drawSky(W, H, ts);
    this.drawBg(W, H, ts, r); this.drawStadium(W, H, r.gY, ts); this.drawRamp(r);
    this.drawBiker(this.startX(r) - this.camX, r.gY, false, ts);
  }

  // Keeps the arena alive between rounds (LED boards, ribbon, crowd, flyers)
  // at ~30fps, and stops itself as soon as a race takes over the canvas.
  startIdleLoop() {
    if (this._idleRaf) return;
    let last = 0;
    const tick = (ts) => {
      if (this._suspended || (this.phase !== 'idle' && this.phase !== 'countdown')) { this._idleRaf = null; this._lastRafTs = null; return; }
      this.trackFrame(ts);
      if (ts - last >= 1000 / this.ambientFps - 2) {
        last = ts;
        try { this.drawIdleFrame(ts); } catch (e) { this.report(e); }
      }
      this._idleRaf = requestAnimationFrame(tick);
    };
    this._idleRaf = requestAnimationFrame(tick);
  }

  // ── Prediction marker ────────────────────────────────────────────────────
  drawPredMarker(r, H) {
    if (this.phase !== 'flying' && this.phase !== 'crashing') return;
    const ctx = this.ctx;
    const wx = r.P2.x + this.pred / 0.22;
    const sx = wx - this.camX;
    if (sx < -60 || sx > this.cw + 60) return;
    ctx.strokeStyle = 'rgba(255,210,63,0.8)'; ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]); ctx.shadowColor = '#FFD23F'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(sx, r.gY - 92); ctx.lineTo(sx, r.gY + 21 * BIKE_SCALE + 4); ctx.stroke();
    ctx.setLineDash([]); ctx.shadowBlur = 0;

    const label = `${this.pred}m`;
    ctx.font = `italic 800 14px ${FONT_NUM}`;
    const pw = ctx.measureText(label).width + 26, ph = 20;
    const px = sx - pw / 2, py = r.gY - 114;
    ctx.fillStyle = '#FFD23F';
    ctx.beginPath(); ctx.roundRect(px, py, pw, ph, 10); ctx.fill();
    ctx.fillStyle = '#1A1404';
    ctx.beginPath(); ctx.arc(px + 9, py + ph / 2, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, sx + 4, py + ph / 2 + 1);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  // ── Sky ──────────────────────────────────────────────────────────────────
  // Drawn in screen space (never translated by camY) so the stars and moon
  // are always there behind the biker and the moon never ends up below it,
  // no matter how high a flight sends the camera panning.
  //
  // The star fields, clouds and moon are by far the most expensive per-frame
  // canvas work in the whole scene (hundreds of shadow-blurred strokes and
  // dozens of gradients), yet almost none of it needs to be recomputed every
  // single frame — twinkle/drift are slow relative to 60fps. So that content
  // is rendered to an offscreen canvas and only refreshed every few frames
  // (renderSkyLayer); every frame just cheaply composites that cached image
  // and then draws the flyers (which do need to move every frame) on top.
  drawSky(W, H, ts) {
    const ctx = this.ctx;
    this.ensureSkyLayer(W, H, ts);
    ctx.drawImage(this._skyCanvas, 0, 0, W, H);
    this.drawShootingStar(W, H, ts);
    this.drawFlyers(W, H, ts, 'far');
    this.drawFlyers(W, H, ts, 'near');
  }

  // Makes sure a cached sky frame exists (painting one synchronously — but
  // only once — if the canvas was just (re)created) and keeps a self-
  // rescheduling setTimeout repainting it in the background. Deliberately
  // NOT driven by the rAF frame counter: that ran the expensive redraw
  // inline inside the render loop, which stalled the biker's own frame
  // whenever it landed. A ~140ms timer is imperceptibly slow for
  // twinkling stars/drifting clouds but keeps every rAF tick cheap.
  ensureSkyLayer(W, H, ts) {
    const needsNewCanvas = !this._skyCanvas
      || this._skyCanvas.width !== this.canvas.width
      || this._skyCanvas.height !== this.canvas.height;
    if (!needsNewCanvas) return;

    this._skyCanvas = document.createElement('canvas');
    this._skyCanvas.width = this.canvas.width;
    this._skyCanvas.height = this.canvas.height;
    this._skyCtx = this._skyCanvas.getContext('2d');
    this._skyCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawSkyContent(this._skyCtx, W, H, ts);

    if (this._skyTimer) clearTimeout(this._skyTimer);
    const tick = () => {
      // Guard against a resize swapping in a new canvas/context between
      // schedule and fire.
      if (this._skyCtx && !this._suspended) {
        try { this.drawSkyContent(this._skyCtx, this.cw, this.ch, performance.now()); } catch (e) { this.report(e); }
      }
      this._skyTimer = setTimeout(tick, 140);
    };
    this._skyTimer = setTimeout(tick, 140);
  }

  drawSkyContent(ctx, W, H, ts) {
    const hash = (n) => { const v = Math.sin(n * 12.9898) * 43758.5453; return v - Math.floor(v); };

    // Night gradient: deep space overhead, lifting toward the arena's glow
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#040814'); sky.addColorStop(0.35, '#08122A');
    sky.addColorStop(0.62, '#0E1C3E'); sky.addColorStop(1, '#142650');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

    this.paintMilkyWay(ctx, W, H, ts, hash);

    // Star field, extending nearly the full height: the camera pans the
    // ground down during a high flight and that newly exposed sky needs stars.
    // Batched by tint and (quantised) twinkle brightness into a few paths.
    const TINTS = ['244,247,255', '207,224,255', '255,236,210'];
    const stars = new Map();
    for (let i = 0; i < 300; i++) {
      const sx = hash(i + 0.31) * W, sy = hash(i + 7.77) * H * 0.95;
      const tw = 0.6 + 0.4 * Math.sin(ts * (0.0008 + hash(i + 3.1) * 0.0012) + i);
      const size = 0.35 + hash(i + 5.5) * 0.95;
      const a = Math.round((0.35 + hash(i + 9.2) * 0.5) * tw * 12) / 12;
      BikeGame.batchInto(stars, `rgba(${TINTS[i % 3]},${a.toFixed(3)})`).push(sx - size / 2, sy - size / 2, size);
    }
    stars.forEach((r, color) => {
      ctx.fillStyle = color; ctx.beginPath();
      for (let i = 0; i < r.length; i += 3) ctx.rect(r[i], r[i + 1], r[i + 2], r[i + 2]);
      ctx.fill();
    });

    // A handful of bright stars with a soft glow and a fine four-point glint
    for (let i = 0; i < 14; i++) {
      const sx = hash(i + 40.4) * W, sy = hash(i + 60.6) * H * 0.62;
      const tw = 0.7 + 0.3 * Math.sin(ts * 0.0011 + i * 2.3);
      const s = (4 + hash(i + 80.8) * 4) * tw;
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, s * 1.4);
      glow.addColorStop(0, `rgba(225,236,255,${0.55 * tw})`); glow.addColorStop(1, 'rgba(225,236,255,0)');
      ctx.fillStyle = glow; ctx.fillRect(sx - s * 1.4, sy - s * 1.4, s * 2.8, s * 2.8);
      ctx.strokeStyle = `rgba(235,242,255,${0.45 * tw})`; ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(sx - s, sy); ctx.lineTo(sx + s, sy); ctx.moveTo(sx, sy - s); ctx.lineTo(sx, sy + s); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath(); ctx.arc(sx, sy, 0.9 + tw * 0.4, 0, Math.PI * 2); ctx.fill();
    }

    this.paintMoon(ctx, W, H);
  }

  // A faint diagonal band of haze with dark dust lanes and densely packed
  // stars — kept subtle so it adds depth without competing with the arena.
  paintMilkyWay(ctx, W, H, ts, hash) {
    const bandW = H * 0.16;
    ctx.save();
    ctx.translate(W * 0.42, H * 0.22); ctx.rotate(-0.38);
    const haze = ctx.createLinearGradient(0, -bandW, 0, bandW);
    haze.addColorStop(0, 'rgba(150,170,235,0)'); haze.addColorStop(0.35, 'rgba(150,170,235,0.05)');
    haze.addColorStop(0.5, 'rgba(196,206,255,0.09)'); haze.addColorStop(0.65, 'rgba(150,170,235,0.05)'); haze.addColorStop(1, 'rgba(150,170,235,0)');
    ctx.fillStyle = haze; ctx.fillRect(-W, -bandW, W * 2.2, bandW * 2);
    for (let i = 0; i < 7; i++) {
      const lx = -W * 0.8 + hash(i + 200) * W * 1.9, lw = 60 + hash(i + 210) * 140;
      const lane = ctx.createRadialGradient(lx, (hash(i + 220) - 0.5) * bandW * 0.5, 0, lx, 0, lw);
      lane.addColorStop(0, 'rgba(3,6,16,0.22)'); lane.addColorStop(1, 'rgba(3,6,16,0)');
      ctx.fillStyle = lane;
      ctx.save(); ctx.scale(1, 0.32);
      ctx.beginPath(); ctx.arc(lx, 0, lw, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    const dust = new Map();
    for (let i = 0; i < 220; i++) {
      const bx = -W * 0.9 + hash(i + 300.3) * W * 2.1;
      const by = (hash(i + 400.4) + hash(i + 500.5) + hash(i + 600.6) - 1.5) * bandW * 0.7;
      const tw = 0.65 + 0.35 * Math.sin(ts * 0.0015 + i * 1.7);
      const size = 0.3 + hash(i + 700.7) * 0.7;
      const a = Math.round((0.25 + hash(i + 800.8) * 0.45) * tw * 12) / 12;
      BikeGame.batchInto(dust, `rgba(226,232,255,${a.toFixed(3)})`).push(bx, by, size);
    }
    dust.forEach((r, color) => {
      ctx.fillStyle = color; ctx.beginPath();
      for (let i = 0; i < r.length; i += 3) ctx.rect(r[i], r[i + 1], r[i + 2], r[i + 2]);
      ctx.fill();
    });
    ctx.restore();
  }

  // Where the moon sits: on the right, always fully clear of the roof truss
  // (its height comes from the stand geometry, so it never slides behind the
  // roofline on a short canvas) and never off the top.
  moonPlacement(W, H) {
    const g = this.standGeom(W, H, this.getRamp().gY);
    const trussTop = g.standTop - g.roofH - g.trussH;
    const R = Math.max(34, Math.min(80, H * 0.088));
    const y = Math.max(R + 12, Math.min(H * 0.15, trussTop - 30 - R));
    return { x: W * 0.8, y, R };
  }

  // The moon's disc, rendered once per size into its own canvas: bright
  // highlands with large-scale mottling, ragged-edged maria where the real
  // ones sit on the near side, regolith grain, craters modelled by the light
  // (shadowed wall toward it, lit wall away, bright rim), the ray systems of
  // Tycho, Copernicus and Kepler, Aristarchus's bright spot, and limb darkening.
  ensureMoonTexture(R) {
    const key = `${Math.round(R * 10)}@${this.dpr}`;
    if (this._moonTex && this._moonTex.key === key) return this._moonTex;
    const size = Math.ceil(R * 2 + 4), cx = size / 2, cy = size / 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(size * this.dpr); canvas.height = Math.round(size * this.dpr);
    const m = canvas.getContext('2d');
    m.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const hash = (n) => { const v = Math.sin(n * 78.233) * 43758.5453; return v - Math.floor(v); };
    const soft = (x, y, r, rgb, a, hard = 0.6) => {
      const g = m.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(hard, `rgba(${rgb},${a * 0.6})`); g.addColorStop(1, `rgba(${rgb},0)`);
      m.fillStyle = g; m.beginPath(); m.arc(x, y, r, 0, Math.PI * 2); m.fill();
    };
    // Disc-unit point (x right, y down) → texture pixels
    const P = (u, v) => [cx + u * R, cy + v * R];

    m.beginPath(); m.arc(cx, cy, R, 0, Math.PI * 2); m.clip();
    const base = m.createRadialGradient(cx - R * 0.3, cy - R * 0.34, R * 0.05, cx, cy, R * 1.02);
    base.addColorStop(0, '#FFFEF8'); base.addColorStop(0.5, '#EEEDE6'); base.addColorStop(0.86, '#D4D6D3'); base.addColorStop(1, '#B6BCC2');
    m.fillStyle = base; m.fillRect(cx - R, cy - R, R * 2, R * 2);

    for (let i = 0; i < 70; i++) {
      const a = hash(i + 1.1) * Math.PI * 2, d = Math.sqrt(hash(i + 2.2)) * R;
      soft(cx + Math.cos(a) * d, cy + Math.sin(a) * d, R * (0.07 + hash(i + 3.3) * 0.15), hash(i + 4.4) > 0.45 ? '255,252,242' : '148,154,160', 0.13);
    }

    // Maria [u, v, rx, ry, rotation]: Procellarum, Imbrium, Serenitatis,
    // Tranquillitatis, Crisium, Fecunditatis, Nectaris, Nubium, Humorum,
    // Frigoris and Vaporum — each a cloud of overlapping blobs with a firm
    // falloff, so the shorelines come out ragged rather than blurry.
    const MARIA = [
      [-0.5, -0.06, 0.28, 0.42, 0.25], [-0.23, -0.38, 0.26, 0.2, -0.3], [0.12, -0.35, 0.15, 0.14, 0],
      [0.33, -0.06, 0.2, 0.16, 0.2], [0.65, -0.26, 0.1, 0.13, 0.2], [0.52, 0.18, 0.1, 0.14, 0.4],
      [0.3, 0.27, 0.09, 0.08, 0], [-0.15, 0.34, 0.16, 0.11, -0.2], [-0.45, 0.4, 0.09, 0.08, 0],
      [0.02, -0.66, 0.38, 0.065, -0.08], [-0.03, -0.02, 0.09, 0.07, 0],
    ];
    MARIA.forEach(([mu, mv, rx, ry, rot], i) => {
      const cr = Math.cos(rot), sr = Math.sin(rot);
      for (let k = 0; k < 36; k++) {
        const a = hash(i * 13 + k) * Math.PI * 2, d = Math.sqrt(hash(i * 29 + k + 0.5));
        const lx = Math.cos(a) * rx * d, ly = Math.sin(a) * ry * d;
        const [x, y] = P(mu + lx * cr - ly * sr, mv + lx * sr + ly * cr);
        soft(x, y, R * Math.min(rx, ry) * (0.36 + hash(i * 7 + k) * 0.42), '96,106,120', 0.2, 0.86);
      }
    });
    // Darker basalt pooled in the hearts of the biggest seas
    [[-0.52, 0.02, 0.16], [-0.24, -0.38, 0.12], [0.34, -0.06, 0.1], [0.12, -0.35, 0.08]].forEach(([u, v, r], i) => {
      const [x, y] = P(u, v);
      soft(x, y, R * r, '78,88,102', 0.22 + hash(i + 70) * 0.06, 0.7);
    });

    for (let i = 0; i < 1600; i++) {
      const a = hash(i + 0.5) * Math.PI * 2, d = Math.sqrt(hash(i + 3.3)) * R;
      m.fillStyle = hash(i + 9.9) > 0.5 ? 'rgba(255,255,255,0.15)' : 'rgba(60,70,84,0.13)';
      const s = 0.5 + hash(i + 7.7) * 0.6;
      m.fillRect(cx + Math.cos(a) * d, cy + Math.sin(a) * d, s, s);
    }

    // Ray systems, splashed across everything around their crater
    const rays = (u, v, n, reach, alpha, seed) => {
      const [x, y] = P(u, v);
      m.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + hash(seed + i) * 0.35, len = R * reach * (0.35 + hash(seed + i + 40) * 0.65);
        const g = m.createLinearGradient(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len);
        g.addColorStop(0, `rgba(255,255,252,${alpha})`); g.addColorStop(1, 'rgba(255,255,252,0)');
        m.strokeStyle = g; m.lineWidth = R * (0.012 + hash(seed + i + 80) * 0.02);
        m.beginPath(); m.moveTo(x, y); m.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); m.stroke();
      }
    };
    rays(-0.12, 0.64, 18, 0.95, 0.24, 900);   // Tycho
    rays(-0.32, -0.15, 12, 0.42, 0.16, 960);  // Copernicus
    rays(-0.6, -0.08, 9, 0.3, 0.14, 990);     // Kepler

    const crater = (u, v, cr, bright = 0) => {
      const [x, y] = P(u, v);
      // Foreshortened toward the limb, where we see the floor at a slant
      const d = Math.hypot(u, v), squash = Math.sqrt(Math.max(0.12, 1 - d * d)), ang = Math.atan2(v, u);
      m.save(); m.translate(x, y); m.rotate(ang); m.scale(squash, 1); m.rotate(-ang);
      m.fillStyle = 'rgba(70,80,94,0.18)';
      m.beginPath(); m.arc(0, 0, cr, 0, Math.PI * 2); m.fill();
      // Light comes from the upper left: the wall nearest it falls in shadow,
      // the far wall catches the light, and the outer rim gleams.
      m.fillStyle = 'rgba(40,48,62,0.26)';
      m.beginPath(); m.arc(0, 0, cr * 0.92, Math.PI * 0.9, Math.PI * 1.75); m.arc(cr * 0.18, cr * 0.18, cr * 0.78, Math.PI * 1.75, Math.PI * 0.9, true); m.fill();
      m.fillStyle = 'rgba(255,255,250,0.28)';
      m.beginPath(); m.arc(0, 0, cr * 0.9, Math.PI * 1.9, Math.PI * 0.75); m.arc(-cr * 0.16, -cr * 0.16, cr * 0.78, Math.PI * 0.75, Math.PI * 1.9, true); m.fill();
      m.strokeStyle = 'rgba(255,255,255,0.32)'; m.lineWidth = Math.max(0.45, cr * 0.16);
      m.beginPath(); m.arc(0, 0, cr * 1.04, Math.PI * 0.95, Math.PI * 1.7); m.stroke();
      if (cr > R * 0.05) { m.fillStyle = 'rgba(235,236,232,0.5)'; m.beginPath(); m.arc(cr * 0.05, cr * 0.05, cr * 0.16, 0, Math.PI * 2); m.fill(); }
      m.restore();
      if (bright) soft(x, y, cr * 1.6, '255,255,255', bright);
    };
    for (let i = 0; i < 90; i++) {
      const a = hash(i + 100) * Math.PI * 2, d = Math.sqrt(hash(i + 200)) * 0.95;
      crater(Math.cos(a) * d, Math.sin(a) * d, R * (0.012 + Math.pow(hash(i + 300), 3.6) * 0.058));
    }
    crater(-0.12, 0.64, R * 0.06, 0.5);   // Tycho
    crater(-0.32, -0.15, R * 0.055, 0.32); // Copernicus
    crater(-0.6, -0.08, R * 0.032, 0.3);   // Kepler
    crater(0.0, 0.78, R * 0.08);           // Clavius
    crater(0.36, 0.46, R * 0.05);          // Theophilus
    const [ax, ay] = P(-0.66, -0.3);       // Aristarchus — the brightest spot on the disc
    soft(ax, ay, R * 0.05, '255,255,255', 0.85);

    // Limb darkening, a faint cool edge, and a gentle falloff on the side
    // away from the light so the disc reads as a sphere
    const limb = m.createRadialGradient(cx, cy, R * 0.5, cx, cy, R);
    limb.addColorStop(0, 'rgba(24,32,50,0)'); limb.addColorStop(0.8, 'rgba(24,32,50,0.12)'); limb.addColorStop(1, 'rgba(24,32,50,0.42)');
    m.fillStyle = limb; m.fillRect(cx - R, cy - R, R * 2, R * 2);
    const term = m.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    term.addColorStop(0.5, 'rgba(14,22,40,0)'); term.addColorStop(1, 'rgba(14,22,40,0.32)');
    m.fillStyle = term; m.fillRect(cx - R, cy - R, R * 2, R * 2);

    this._moonTex = { key, canvas, size };
    return this._moonTex;
  }

  // Full moon: the cached high-detail disc with only a thin soft edge (no
  // big glow or halo), finished with a bright rim on the lit side.
  paintMoon(ctx, W, H) {
    const { x: mx, y: my, R } = this.moonPlacement(W, H);
    this._moon = { x: mx, y: my, R };

    const edge = ctx.createRadialGradient(mx, my, R * 0.96, mx, my, R * 1.14);
    edge.addColorStop(0, 'rgba(214,228,255,0.16)'); edge.addColorStop(1, 'rgba(214,228,255,0)');
    ctx.fillStyle = edge; ctx.beginPath(); ctx.arc(mx, my, R * 1.14, 0, Math.PI * 2); ctx.fill();

    const tex = this.ensureMoonTexture(R);
    ctx.drawImage(tex.canvas, mx - tex.size / 2, my - tex.size / 2, tex.size, tex.size);

    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(mx, my, R - 0.6, Math.PI * 0.95, Math.PI * 1.75); ctx.stroke();
  }

  // A shooting star streaks across the upper sky for under a second every
  // eight seconds, on a different path each time.
  drawShootingStar(W, H, ts) {
    const period = 8000, t = (ts % period) / 900;
    if (ts < 1 || t >= 1) return;
    const k = Math.floor(ts / period);
    const r = (n) => { const v = Math.sin((k * 7.13 + n) * 91.7) * 43758.5453; return v - Math.floor(v); };
    const ang = 0.32 + r(3) * 0.28, len = 120 + r(4) * 90;
    const x0 = W * (0.12 + r(1) * 0.6), y0 = H * (0.03 + r(2) * 0.12);
    const hx = x0 + Math.cos(ang) * len * t * 1.7, hy = y0 + Math.sin(ang) * len * t * 1.7;
    const a = Math.sin(t * Math.PI);
    const ctx = this.ctx;
    const trail = ctx.createLinearGradient(hx - Math.cos(ang) * len, hy - Math.sin(ang) * len, hx, hy);
    trail.addColorStop(0, 'rgba(200,225,255,0)'); trail.addColorStop(1, `rgba(238,246,255,${0.85 * a})`);
    ctx.strokeStyle = trail; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(hx - Math.cos(ang) * len, hy - Math.sin(ang) * len); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.lineCap = 'butt';
    const head = ctx.createRadialGradient(hx, hy, 0, hx, hy, 5);
    head.addColorStop(0, `rgba(255,255,255,${a})`); head.addColorStop(1, 'rgba(200,225,255,0)');
    ctx.fillStyle = head; ctx.fillRect(hx - 5, hy - 5, 10, 10);
  }

  // Night birds. 'far' is a loose skein of gulls crossing high and slow, each
  // bobbing on its own; 'near' is a barn owl gliding across the face of the
  // moon now and then, two gulls closer in, and the odd pterosaur.
  drawFlyers(W, H, ts, layer) {
    if (layer === 'far') {
      const t = ((ts + 6000) % 30000) / 30000;
      const lx = -170 + t * (W + 440), ly = H * 0.1 + Math.sin(t * 9) * 5;
      [[0, 0, 7], [-16, -7, 6.4], [-15, 8, 6.6], [-31, -13, 6], [-30, 15, 6.2], [-47, -19, 5.6], [-45, 22, 5.8], [-62, -24, 5.1], [-60, 28, 5.3]]
        .forEach(([dx, dy, s], i) => {
          const bob = Math.sin(ts * 0.0016 + i * 1.3) * 1.6;
          this.drawBird(lx + dx, ly + dy * 0.6 + bob, s, ts * 0.011 + i * 0.9, 'rgba(14,22,42,0.78)', null);
        });
      return;
    }
    const moon = this._moon || { x: W * 0.8, y: H * 0.15, R: 50 };
    const ot = ((ts + 3000) % 30000) / 30000;
    if (ot < 0.5) {
      const ox = -130 + (ot / 0.5) * (W + 270);
      this.drawOwl(ox, moon.y + moon.R * 0.12 + Math.sin(ot * Math.PI * 6) * 5, Math.max(16, moon.R * 0.42), ts * 0.0042);
    }
    [
      { y: H * 0.25, period: 23000, off: 11000, size: 17, wf: 0.011 },
      { y: H * 0.18, period: 29000, off: 21000, size: 13, wf: 0.012 },
    ].forEach((b, i) => {
      const t = ((ts + b.off) % b.period) / b.period;
      this.drawGull(-90 + t * (W + 200), b.y + Math.sin(t * Math.PI * 4 + i) * 7, b.size, ts * b.wf + i * 1.7);
    });
    const d = this.flyDragon(W, H, ts);
    if (d.mode === 'patrol') this.drawDragon(d.x, d.y, d.scale, ts * 0.0032, ts, 1, true);
  }

  // The dragon's flight. On patrol it crosses the sky on a slow loop. On
  // some jumps (decided at takeoff — purely for show: the flight and the
  // landing are never touched) it breaks off, swoops in ahead of the rider,
  // turns to face him and blasts him with fire, setting rider and bike
  // alight, then peels away and stays away until its patrol comes round
  // again. While attacking it's drawn on top of the world (drawScene).
  flyDragon(W, H, ts) {
    const d = this._dragon || (this._dragon = { mode: 'patrol', x: -999, y: 0, facing: 1, t0: 0, ts: null });
    const step = d.ts == null ? 1 : Math.min(3, Math.max(0.1, (ts - d.ts) / 16.6667));
    d.ts = ts;
    d.scale = Math.max(1, Math.min(1.6, W / 800));
    const pt = ((ts + 19000) % 36000) / 36000;
    const px = -160 + pt * (W + 340), py = H * 0.09 + Math.sin(pt * 8) * 6;
    const flying = this.phase === 'flying';
    const rider = { x: this.bx - this.camX, y: this.by + this.camY - 30 * BIKE_SCALE };

    if ((d.mode === 'patrol' || d.mode === 'away') && flying && this._attack && ts - this.flyTs > this.flyMs * 0.15) {
      // Break off from wherever it is if it's on screen, else dive in from above
      const onScreen = d.mode === 'patrol' && px > -40 && px < W + 40;
      this._attack = false;
      d.mode = 'swoop';
      if (!onScreen) { d.x = W + 90; d.y = -50; }
    }
    if (d.mode === 'patrol') { d.x = px; d.y = py; d.facing = 1; return d; }
    if (d.mode === 'away') { if (px < -60 || px > W + 60) d.mode = 'patrol'; return d; }
    if (d.mode === 'swoop' || d.mode === 'blast') {
      if (!flying) { d.mode = 'leave'; return d; }
      const tx = rider.x + 125 * d.scale, ty = rider.y - 62 * d.scale;
      const k = 1 - Math.pow(1 - 0.09, step);
      d.x += (tx - d.x) * k; d.y += (ty - d.y) * k;
      d.facing = rider.x < d.x ? -1 : 1;
      if (d.mode === 'swoop' && Math.hypot(tx - d.x, ty - d.y) < 34) { d.mode = 'blast'; d.t0 = ts; }
      if (d.mode === 'blast' && ts - d.t0 > 950) d.mode = 'leave';
      return d;
    }
    // leave: climb away off the top/right, then wait for the next patrol pass
    d.x += 5.5 * step; d.y -= 3.4 * step; d.facing = 1;
    if (d.y < -90 || d.x > W + 140) d.mode = 'away';
    return d;
  }

  // The attacking dragon and its fire jet, in screen space on top of the
  // world. The jet is aimed straight at the rider; once it connects, rider
  // and bike burn for the rest of the flight (see drawBurning).
  drawDragonAttack(ts) {
    const d = this._dragon;
    if (!d || (d.mode !== 'swoop' && d.mode !== 'blast' && d.mode !== 'leave')) return;
    const phase = ts * 0.0032;
    this.drawDragon(d.x, d.y, d.scale, phase, ts, d.facing, false);
    if (d.mode !== 'blast') return;
    const k = Math.min(1, (ts - d.t0) / 950), jet = Math.sin(k * Math.PI);
    const mx = d.x + 29 * d.scale * d.facing, my = d.y + Math.sin(phase) * 2.4 - 5 * d.scale;
    const rx = this.bx - this.camX, ry = this.by + this.camY - 26 * BIKE_SCALE;
    this.drawFireJet(mx, my, rx, ry, jet, ts);
    if (k > 0.32 && this.burnT == null && this.phase === 'flying') this.burnT = ts;
  }

  // A jet of dragon fire from (x0, y0) toward (x1, y1): layered cones — red
  // edges, orange body, white-hot core — that flicker, throw embers, and
  // light the air around them. `k` (0…1) grows it out and back.
  drawFireJet(x0, y0, x1, y1, k, ts) {
    if (k <= 0.01) return;
    const ctx = this.ctx, L = Math.hypot(x1 - x0, y1 - y0) * Math.min(1.08, k * 1.6);
    ctx.save(); ctx.translate(x0, y0); ctx.rotate(Math.atan2(y1 - y0, x1 - x0));
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(L * 0.5, 0, 0, L * 0.5, 0, L * 0.6 + 20);
    glow.addColorStop(0, `rgba(255,140,50,${0.35 * k})`); glow.addColorStop(1, 'rgba(255,90,30,0)');
    ctx.fillStyle = glow; ctx.fillRect(-20, -L * 0.6 - 20, L + 40, L * 1.2 + 40);
    const cone = (w, c0, c1, reach) => {
      const len = L * reach, wob = Math.sin(ts * 0.045) * w * 0.3;
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, c0); g.addColorStop(1, c1);
      ctx.fillStyle = g; ctx.beginPath();
      ctx.moveTo(0, -w * 0.15);
      ctx.quadraticCurveTo(len * 0.5, -w - wob, len, wob * 0.5);
      ctx.quadraticCurveTo(len * 0.5, w - wob, 0, w * 0.15);
      ctx.closePath(); ctx.fill();
    };
    const spread = 6 + L * 0.11;
    cone(spread, `rgba(255,80,26,${0.9 * k})`, 'rgba(255,50,20,0)', 1);
    cone(spread * 0.62, `rgba(255,176,60,${0.92 * k})`, 'rgba(255,130,40,0.15)', 0.9);
    cone(spread * 0.28, `rgba(255,250,222,${k})`, 'rgba(255,224,150,0)', 0.62);
    for (let i = 0; i < 9; i++) {
      const t = ((ts * 0.0025 + i * 0.137) % 1), ex = L * t, ey = Math.sin(ts * 0.02 + i * 2.1) * spread * t * 0.7;
      ctx.fillStyle = `rgba(255,${150 + (i % 4) * 22},60,${(1 - t) * 0.85 * k})`;
      ctx.beginPath(); ctx.arc(ex, ey, 1.1 + (i % 3) * 0.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // Rider and bike on fire: flame tongues streaming back opposite to the
  // direction of travel from the bike, the rider and his helmet, a hot glow,
  // and a trail of smoke puffs left in the air (world space).
  drawBurning(x, y, ts) {
    const ctx = this.ctx, k = Math.min(1, (ts - this.burnT) / 300);
    const sp = Math.hypot(this.bvx, this.bvy) || 1;
    const bx = -this.bvx / sp, by = -this.bvy / sp;            // streaming back
    const dx = bx * 0.75, dy = by * 0.75 - 0.65, dl = Math.hypot(dx, dy) || 1;
    const ux = dx / dl, uy = dy / dl, nx = -uy, ny = ux;          // flame direction + its normal
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(x, y - 26, 0, x, y - 26, 70);
    glow.addColorStop(0, `rgba(255,140,50,${0.45 * k})`); glow.addColorStop(1, 'rgba(255,90,30,0)');
    ctx.fillStyle = glow; ctx.fillRect(x - 70, y - 96, 140, 140);
    [[-22, -14, 1.1], [-8, -24, 1.25], [-2, -40, 1.05], [6, -52, 0.85], [16, -8, 0.8], [-30, -4, 0.7]].forEach(([ox, oy, s], i) => {
      const flick = 0.75 + Math.sin(ts * 0.03 + i * 1.9) * 0.25, len = (18 + i % 3 * 5) * s * flick * k, w = 6.5 * s * k;
      const sx = x + ox, sy = y + oy;
      [[1, '255,70,24', 0.8], [0.64, '255,160,52', 0.9], [0.32, '255,244,200', 0.95]].forEach(([f, rgb, a]) => {
        const L = len * (0.6 + f * 0.4), W2 = w * f;
        const tipX = sx + ux * L + nx * Math.sin(ts * 0.025 + i) * 3, tipY = sy + uy * L + ny * Math.sin(ts * 0.025 + i) * 3;
        ctx.fillStyle = `rgba(${rgb},${a * k})`;
        ctx.beginPath();
        ctx.moveTo(sx + nx * W2, sy + ny * W2);
        ctx.quadraticCurveTo(sx + ux * L * 0.5 + nx * W2 * 1.1, sy + uy * L * 0.5 + ny * W2 * 1.1, tipX, tipY);
        ctx.quadraticCurveTo(sx + ux * L * 0.5 - nx * W2 * 1.1, sy + uy * L * 0.5 - ny * W2 * 1.1, sx - nx * W2, sy - ny * W2);
        ctx.closePath(); ctx.fill();
      });
    });
    ctx.restore();
    // Smoke left hanging in the air behind the burning bike
    if (Math.random() < 0.6) {
      this.particles.push({ type: 'smoke', x: this.bx - 10 + Math.random() * 16, y: y - 30 + Math.random() * 20, vx: bx * 1.2, vy: -0.6 - Math.random() * 0.5, life: 1, decay: 0.012, r: 5 + Math.random() * 4, rot: 0, spin: 0 });
    }
  }

  // A distant gull seen from below: a slim body and two long wings bent at
  // the wrist into the classic "M" — the hand lagging the arm through each
  // beat — flapping in bursts with a glide in between.
  drawBird(x, y, size, phase, color, rim) {
    const ctx = this.ctx;
    const cyc = phase % (Math.PI * 6);
    const glide = cyc >= Math.PI * 4;
    const fa = glide ? 0.22 : Math.sin(cyc), fh = glide ? 0.1 : Math.sin(cyc - 0.7);
    const wristY = -size * (0.05 + 0.32 * fa), tipY = wristY - size * (0.08 + 0.42 * fh);
    const lead = (s) => {
      ctx.moveTo(0, -size * 0.04);
      ctx.quadraticCurveTo(s * size * 0.22, wristY - size * 0.12, s * size * 0.46, wristY);
      ctx.quadraticCurveTo(s * size * 0.74, tipY - size * 0.02, s * size, tipY);
    };
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.beginPath();
    [-1, 1].forEach((s) => {
      lead(s);
      ctx.quadraticCurveTo(s * size * 0.7, tipY + size * 0.12, s * size * 0.46, wristY + size * 0.13);
      ctx.quadraticCurveTo(s * size * 0.22, wristY + size * 0.14, 0, size * 0.12);
      ctx.closePath();
    });
    ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, size * 0.05, size * 0.085, size * 0.21, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(0, -size * 0.15, size * 0.075, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-size * 0.07, size * 0.2); ctx.lineTo(0, size * 0.36); ctx.lineTo(size * 0.07, size * 0.2); ctx.closePath(); ctx.fill();
    if (rim) {
      ctx.strokeStyle = rim; ctx.lineWidth = Math.max(0.6, size * 0.05);
      ctx.beginPath(); lead(-1); lead(1); ctx.stroke();
    }
    ctx.restore();
  }

  // A side-on gull flying right: a streamlined body cool-lit by the moon on
  // top and warm-lit by the stadium underneath, white tail, yellow bill with
  // its red spot, and long wings that bend at the wrist — the hand trailing
  // the arm through every beat — ending in black, white-spotted tips.
  drawGull(x, y, size, phase) {
    const ctx = this.ctx;
    const cyc = phase % (Math.PI * 6);
    const glide = cyc >= Math.PI * 4;
    const fa = glide ? 0.16 : Math.sin(cyc), fh = glide ? 0.08 : Math.sin(cyc - 0.65);
    ctx.save(); ctx.translate(x, y); ctx.scale(size, size);
    const wing = (k, ox, oy, fill) => {
      const wr = { x: -0.02 + ox, y: -0.1 + oy - 0.56 * fa * k };
      const tip = { x: -0.5 + ox + 0.1 * Math.abs(fh), y: wr.y - 0.62 * fh * k - 0.03 };
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(0.18 + ox, -0.1 + oy);
        ctx.quadraticCurveTo(0.12 + ox, (wr.y - 0.1 + oy) / 2 - 0.05, wr.x, wr.y);
        ctx.quadraticCurveTo((wr.x + tip.x) / 2, (wr.y + tip.y) / 2 - 0.03, tip.x, tip.y);
        ctx.quadraticCurveTo(wr.x - 0.17, wr.y + 0.03, wr.x - 0.27, wr.y + 0.07);
        ctx.quadraticCurveTo(-0.25 + ox, (wr.y + oy) / 2, -0.3 + ox, -0.01 + oy);
        ctx.closePath();
      };
      path(); ctx.fillStyle = fill; ctx.fill();
      ctx.save(); path(); ctx.clip();
      ctx.fillStyle = '#12151C';
      ctx.beginPath(); ctx.arc(tip.x, tip.y, 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(240,244,250,0.92)';
      ctx.beginPath(); ctx.arc(tip.x + 0.09, tip.y + (wr.y - tip.y) * 0.16, 0.035, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };
    wing(0.8, 0.05, -0.03, '#47546A');
    const body = ctx.createLinearGradient(0, -0.2, 0, 0.17);
    body.addColorStop(0, '#9DACC5'); body.addColorStop(0.45, '#DCDCD8'); body.addColorStop(1, '#F2D9B0');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(-0.62, 0.02);
    ctx.quadraticCurveTo(-0.3, -0.17, 0.3, -0.14);
    ctx.quadraticCurveTo(0.6, -0.25, 0.74, -0.08);
    ctx.quadraticCurveTo(0.72, 0.02, 0.5, 0.04);
    ctx.quadraticCurveTo(0, 0.17, -0.62, 0.02);
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-0.55, -0.03); ctx.lineTo(-0.86, -0.08); ctx.lineTo(-0.84, 0.06); ctx.lineTo(-0.55, 0.06); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#E8C24A';
    ctx.beginPath(); ctx.moveTo(0.72, -0.1); ctx.lineTo(0.95, -0.065); ctx.lineTo(0.72, -0.03); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#D9483A'; ctx.beginPath(); ctx.arc(0.87, -0.06, 0.018, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0B0E14'; ctx.beginPath(); ctx.arc(0.62, -0.11, 0.03, 0, Math.PI * 2); ctx.fill();
    wing(1, 0, 0, '#7A889F');
    ctx.restore();
  }

  // A barn owl gliding past: a big round head with a pale heart-shaped face
  // and dark eye, golden-buff back, a pale underside warmed by the stadium,
  // a short tail, and broad rounded wings with fingered, barred tips — a
  // couple of slow, deep beats, then a long glide. Crossing the moon it
  // turns to a backlit silhouette with a bright moonlit rim.
  drawOwl(x, y, size, phase) {
    const ctx = this.ctx;
    const cyc = phase % (Math.PI * 5);
    const glide = cyc >= Math.PI * 2;
    const fa = glide ? 0.22 + Math.sin(cyc) * 0.04 : Math.sin(cyc), fh = glide ? 0.14 : Math.sin(cyc - 0.55);
    const moon = this._moon;
    const md = moon ? Math.hypot(x - moon.x, y - moon.y) / (moon.R + size * 0.5) : 9;
    const back = md < 1 ? Math.min(1, (1 - md) * 3) : 0;

    const wingPts = (k, ox, oy) => {
      const wr = { x: -0.04 + ox, y: -0.12 + oy - 0.5 * fa * k };
      return { wr, tip: { x: -0.4 + ox + 0.08 * Math.abs(fh), y: wr.y - 0.56 * fh * k }, te: { x: wr.x - 0.38, y: wr.y + 0.05 }, ox, oy };
    };
    const wingPath = ({ wr, tip, te, ox, oy }) => {
      ctx.beginPath();
      ctx.moveTo(0.2 + ox, -0.15 + oy);
      ctx.quadraticCurveTo(0.15 + ox, (wr.y - 0.15 + oy) / 2 - 0.05, wr.x, wr.y);
      ctx.quadraticCurveTo((wr.x + tip.x) / 2 + 0.02, (wr.y + tip.y) / 2 - 0.05, tip.x, tip.y);
      // Fingered primaries: little scallops from the tip back along the trailing edge
      for (let i = 1; i <= 4; i++) {
        const t0 = (i - 1) / 4, t1 = i / 4;
        const ax = tip.x + (te.x - tip.x) * t0, ay = tip.y + (te.y - tip.y) * t0;
        const bx = tip.x + (te.x - tip.x) * t1, by = tip.y + (te.y - tip.y) * t1;
        ctx.quadraticCurveTo((ax + bx) / 2 - 0.06, (ay + by) / 2 + 0.04, bx, by);
      }
      ctx.quadraticCurveTo(-0.32 + ox, (te.y + oy) / 2, -0.36 + ox, 0.02 + oy);
      ctx.closePath();
    };
    const head = () => { ctx.beginPath(); ctx.arc(0.36, -0.16, 0.21, 0, Math.PI * 2); };
    const body = () => {
      ctx.beginPath();
      ctx.moveTo(-0.46, 0.0);
      ctx.quadraticCurveTo(-0.2, -0.24, 0.22, -0.2);
      ctx.quadraticCurveTo(0.42, 0.02, 0.18, 0.16);
      ctx.quadraticCurveTo(-0.16, 0.22, -0.46, 0.0);
      ctx.closePath();
      ctx.moveTo(-0.4, -0.04); ctx.quadraticCurveTo(-0.62, -0.08, -0.64, 0.02); ctx.quadraticCurveTo(-0.6, 0.08, -0.4, 0.06); ctx.closePath();
    };
    const far = wingPts(0.82, 0.06, -0.04), near = wingPts(1, 0, 0);

    ctx.save(); ctx.translate(x, y); ctx.scale(size, size);
    // Full colour
    wingPath(far); ctx.fillStyle = '#8C6A40'; ctx.fill();
    const belly = ctx.createLinearGradient(0, -0.22, 0, 0.2);
    belly.addColorStop(0, '#C59A5E'); belly.addColorStop(0.5, '#E4D2B2'); belly.addColorStop(1, '#F6E6C8');
    body(); ctx.fillStyle = belly; ctx.fill();
    const hg = ctx.createRadialGradient(0.3, -0.26, 0.02, 0.36, -0.16, 0.24);
    hg.addColorStop(0, '#DDB47A'); hg.addColorStop(1, '#A9804A');
    head(); ctx.fillStyle = hg; ctx.fill();
    ctx.fillStyle = '#F6F0E4';
    ctx.beginPath(); ctx.ellipse(0.45, -0.13, 0.11, 0.17, 0.12, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#B07E44'; ctx.lineWidth = 0.025; ctx.stroke();
    ctx.fillStyle = '#120C08'; ctx.beginPath(); ctx.arc(0.5, -0.16, 0.034, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.arc(0.508, -0.17, 0.01, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#D8CBB0';
    ctx.beginPath(); ctx.moveTo(0.55, -0.12); ctx.quadraticCurveTo(0.6, -0.1, 0.56, -0.06); ctx.closePath(); ctx.fill();
    const wg = ctx.createLinearGradient(near.wr.x + 0.1, 0, near.te.x, 0);
    wg.addColorStop(0, '#D8B276'); wg.addColorStop(1, '#F1E6D0');
    wingPath(near); ctx.fillStyle = wg; ctx.fill();
    ctx.save(); wingPath(near); ctx.clip();
    ctx.strokeStyle = 'rgba(120,86,44,0.55)'; ctx.lineWidth = 0.03;
    for (let i = 1; i <= 3; i++) {
      const t = 0.2 + i * 0.16;
      const px = near.tip.x + (near.wr.x - near.tip.x) * t, py = near.tip.y + (near.wr.y - near.tip.y) * t;
      ctx.beginPath(); ctx.moveTo(px + 0.06, py - 0.02); ctx.lineTo(px - 0.3, py + 0.05); ctx.stroke();
    }
    ctx.restore();
    // Backlit by the moon: a dark silhouette with a thin bright rim
    if (back > 0) {
      ctx.globalAlpha = back * 0.88;
      ctx.fillStyle = '#0B1120';
      wingPath(far); ctx.fill(); body(); ctx.fill(); head(); ctx.fill(); wingPath(near); ctx.fill();
      ctx.globalAlpha = back;
      ctx.strokeStyle = 'rgba(232,240,255,0.75)'; ctx.lineWidth = 0.03;
      head(); ctx.stroke(); wingPath(near); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // A red dragon, drawn facing right (`facing` -1 mirrors it): a horned head
  // with a glowing eye, a long neck, a whip of a tail ending in a spade, a
  // golden belly, and bat wings — finger bones fanning out under a
  // scalloped, veined membrane running from blood red to ember orange —
  // beating slow and deep, the outer wing lagging the arm. Its body lifts on
  // each downstroke while the neck and tail ripple; moonlight rims its back.
  // On patrol (`idleBreath`) it breathes a short burst of fire every few
  // seconds; when it attacks the rider the aimed jet is drawn separately.
  drawDragon(x, y, scale, phase, ts, facing = 1, idleBreath = true) {
    const ctx = this.ctx;
    const f = Math.sin(phase), fl = Math.sin(phase - 0.6);
    const BODY = '#8A161B', BONE = '#3A0709', RIM = 'rgba(255,224,206,0.55)';
    const ft = (ts % 7000) / 7000, breath = idleBreath && ft < 0.18 ? Math.sin((ft / 0.18) * Math.PI) : 0;
    ctx.save(); ctx.translate(x, y + f * 2.4); ctx.scale(scale * facing, scale);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    const wing = (sx, sy, k, membrane, rim) => {
      const elbow = { x: sx - 5, y: sy - 9 * f * k - 1.5 };
      const wrist = { x: sx + 3, y: sy - 19 * f * k - 2.5 };
      const tips = [
        { x: wrist.x + 9, y: wrist.y - 9 * fl * k - 3 },
        { x: wrist.x - 7, y: wrist.y - 12 * fl * k - 5 },
        { x: wrist.x - 19, y: wrist.y - 8 * fl * k - 1.5 },
        { x: wrist.x - 27, y: wrist.y - 2 * fl * k + 4 },
      ];
      const root = { x: sx - 17, y: sy + 2.5 };
      ctx.beginPath();
      ctx.moveTo(sx, sy); ctx.lineTo(elbow.x, elbow.y); ctx.lineTo(wrist.x, wrist.y); ctx.lineTo(tips[0].x, tips[0].y);
      for (let i = 1; i < tips.length; i++) {
        const a = tips[i - 1], b = tips[i], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.quadraticCurveTo(mx + (wrist.x - mx) * 0.32, my + (wrist.y - my) * 0.32, b.x, b.y);
      }
      ctx.quadraticCurveTo((tips[3].x + root.x) / 2 + 2, (tips[3].y + root.y) / 2 - 1.5, root.x, root.y);
      ctx.closePath();
      // Membrane: dense near the body, thinning (and lighter) toward the edge
      const mg = ctx.createRadialGradient(sx, sy, 2, sx, sy, 34);
      mg.addColorStop(0, membrane[0]); mg.addColorStop(1, membrane[1]);
      ctx.fillStyle = mg; ctx.fill();
      // Veins branching through the membrane between the fingers
      ctx.strokeStyle = 'rgba(30,8,16,0.38)'; ctx.lineWidth = 0.4; ctx.beginPath();
      for (let i = 1; i < tips.length; i++) {
        const a = tips[i - 1], b = tips[i], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.moveTo(wrist.x + (mx - wrist.x) * 0.25, wrist.y + (my - wrist.y) * 0.25);
        ctx.quadraticCurveTo(wrist.x + (mx - wrist.x) * 0.6 + 1, wrist.y + (my - wrist.y) * 0.6, mx + (wrist.x - mx) * 0.34, my + (wrist.y - my) * 0.34);
      }
      ctx.stroke();
      ctx.strokeStyle = BONE; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(elbow.x, elbow.y); ctx.lineTo(wrist.x, wrist.y); ctx.stroke();
      ctx.lineWidth = 0.8; ctx.beginPath();
      tips.forEach((t) => { ctx.moveTo(wrist.x, wrist.y); ctx.lineTo(t.x, t.y); });
      ctx.stroke();
      ctx.fillStyle = '#D9CBB8';
      ctx.beginPath(); ctx.moveTo(wrist.x, wrist.y); ctx.lineTo(wrist.x + 2.6, wrist.y - 1.2); ctx.lineTo(wrist.x + 0.6, wrist.y + 0.8); ctx.closePath();
      tips.forEach((t) => { ctx.moveTo(t.x, t.y); ctx.lineTo(t.x - 1.4, t.y - 0.9); ctx.lineTo(t.x - 0.6, t.y + 0.6); ctx.closePath(); });
      ctx.fill();
      if (rim) {
        ctx.strokeStyle = RIM; ctx.lineWidth = 0.6;
        ctx.beginPath(); ctx.moveTo(sx, sy - 0.6); ctx.lineTo(elbow.x, elbow.y - 0.6); ctx.lineTo(wrist.x, wrist.y - 0.6); ctx.lineTo(tips[0].x, tips[0].y); ctx.stroke();
      }
    };

    wing(4, -3, 0.85, ['rgba(92,10,16,0.96)', 'rgba(150,34,26,0.88)'], false);

    // Tail: tapering from the hips to a spade, swaying through each beat
    const tail = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      tail.push({ x: -9 - t * 27, y: 1.5 + t * 3 + Math.sin(t * 3.2 + phase * 0.5) * 3.2 * t, w: 3.3 * (1 - t) + 0.45 });
    }
    ctx.fillStyle = BODY; ctx.beginPath();
    tail.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y - p.w) : ctx.moveTo(p.x, p.y - p.w)));
    for (let i = tail.length - 1; i >= 0; i--) ctx.lineTo(tail[i].x, tail[i].y + tail[i].w);
    ctx.closePath(); ctx.fill();
    const tip = tail[12];
    ctx.beginPath(); ctx.moveTo(tip.x + 1, tip.y); ctx.lineTo(tip.x - 3.2, tip.y - 3.4); ctx.lineTo(tip.x - 7, tip.y); ctx.lineTo(tip.x - 3.2, tip.y + 3.4); ctx.closePath(); ctx.fill();

    // Body, with a paler scaled belly and a tucked hind leg
    const bg = ctx.createLinearGradient(0, -6, 0, 6);
    bg.addColorStop(0, '#5C0C10'); bg.addColorStop(0.55, '#A11D21'); bg.addColorStop(1, '#E88A3C');
    ctx.fillStyle = bg; ctx.beginPath(); ctx.ellipse(-1, 0.6, 11.5, 5.4, -0.04, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,200,130,0.6)'; ctx.lineWidth = 0.5; ctx.beginPath();
    for (let k = 0; k < 6; k++) { const bx = -7 + k * 3; ctx.moveTo(bx, 4.4); ctx.quadraticCurveTo(bx + 1.5, 6, bx + 3, 4.4); }
    ctx.stroke();
    ctx.fillStyle = BODY;
    ctx.beginPath(); ctx.moveTo(-7, 3); ctx.quadraticCurveTo(-9, 8, -5, 9.5); ctx.lineTo(-3, 9); ctx.quadraticCurveTo(-5, 6, -3.5, 3.5); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#D9CBB8'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(-5, 9.5); ctx.lineTo(-3.8, 11); ctx.moveTo(-3.8, 9.3); ctx.lineTo(-2.4, 10.6); ctx.stroke();
    // The stadium's glow warming the underside
    ctx.strokeStyle = 'rgba(255,170,96,0.35)'; ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.ellipse(-1, 0.6, 11.5, 5.4, -0.04, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();

    // Neck and head ripple gently through the flight
    ctx.save();
    ctx.translate(6, -4); ctx.rotate(Math.sin(phase * 0.5 + 1) * 0.07); ctx.translate(-6, 4);
    // Neck curving up to the head, with spines down its crest
    ctx.fillStyle = BONE;
    for (let k = 0; k < 4; k++) { const nx = 8 + k * 2.4, ny = -6.6 - k * 0.8; ctx.beginPath(); ctx.moveTo(nx - 0.9, ny + 0.6); ctx.lineTo(nx - 0.6, ny - 1.6); ctx.lineTo(nx + 0.8, ny + 0.4); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = BODY; ctx.beginPath();
    ctx.moveTo(6, -4); ctx.quadraticCurveTo(12, -9, 17, -8.6); ctx.lineTo(18.5, -4.6); ctx.quadraticCurveTo(13, -4, 9, 3); ctx.closePath(); ctx.fill();
    // Head: brow ridge, long snout, jaw, swept-back horns and a glowing eye
    ctx.beginPath();
    ctx.moveTo(16, -9.4); ctx.quadraticCurveTo(20, -11.2, 23.5, -8.6); ctx.lineTo(29, -6.4); ctx.lineTo(28.6, -4.6);
    ctx.lineTo(22, -3.6); ctx.quadraticCurveTo(18, -3.2, 16.4, -5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#5A0A0F';
    ctx.beginPath(); ctx.moveTo(22, -3.8); ctx.lineTo(28, -4.4); ctx.lineTo(23, -2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#D9CBB8';
    [[17.4, -9.6, 11, -14.5], [19.4, -10.2, 14.6, -15.6]].forEach(([hx, hy, ex, ey]) => {
      ctx.beginPath(); ctx.moveTo(hx - 0.8, hy + 0.5); ctx.quadraticCurveTo((hx + ex) / 2, (hy + ey) / 2 - 0.4, ex, ey); ctx.lineTo(hx + 1, hy + 0.2); ctx.closePath(); ctx.fill();
    });
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const eg = ctx.createRadialGradient(22.2, -7.6, 0, 22.2, -7.6, 2.6);
    eg.addColorStop(0, 'rgba(255,214,110,1)'); eg.addColorStop(0.45, 'rgba(255,140,40,0.75)'); eg.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.fillStyle = eg; ctx.fillRect(19.6, -10.2, 5.2, 5.2);
    ctx.restore();
    ctx.fillStyle = '#FFE9A8'; ctx.beginPath(); ctx.arc(22.2, -7.6, 0.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#EDE3D2';
    ctx.beginPath(); ctx.moveTo(25, -4.3); ctx.lineTo(25.5, -3.2); ctx.lineTo(26, -4.4); ctx.moveTo(27, -4.6); ctx.lineTo(27.4, -3.7); ctx.lineTo(27.8, -4.7); ctx.fill();

    // Fire breath: a jet every seven seconds that lights up the head, then
    // a wisp of smoke from the nostrils
    if (breath > 0) {
      const len = 34 * breath, wob = Math.sin(ts * 0.05) * 2;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const glow = ctx.createRadialGradient(28, -6, 0, 28, -6, 17);
      glow.addColorStop(0, `rgba(255,170,70,${0.55 * breath})`); glow.addColorStop(1, 'rgba(255,100,30,0)');
      ctx.fillStyle = glow; ctx.fillRect(11, -23, 34, 34);
      const cone = (w, c0, c1, reach) => {
        const L = len * reach, cg = ctx.createLinearGradient(29, -5, 29 + L, -3);
        cg.addColorStop(0, c0); cg.addColorStop(1, c1);
        ctx.fillStyle = cg; ctx.beginPath();
        ctx.moveTo(29, -5 - w * 0.2);
        ctx.quadraticCurveTo(29 + L * 0.55, -5 - w - L * 0.1, 29 + L, -4 + wob * reach);
        ctx.quadraticCurveTo(29 + L * 0.55, -5 + w + L * 0.1, 29, -5 + w * 0.2);
        ctx.closePath(); ctx.fill();
      };
      cone(4.6, `rgba(255,96,32,${0.85 * breath})`, 'rgba(255,60,20,0)', 1);
      cone(2.8, `rgba(255,192,72,${0.9 * breath})`, 'rgba(255,140,40,0)', 0.8);
      cone(1.3, `rgba(255,252,224,${breath})`, 'rgba(255,232,160,0)', 0.5);
      for (let i = 0; i < 6; i++) {
        const ex = 29 + len * (0.35 + i * 0.12), ey = -4 + Math.sin(ts * 0.03 + i * 2) * (2 + i * 0.6);
        ctx.fillStyle = `rgba(255,${150 + i * 15},60,${0.75 * breath})`;
        ctx.beginPath(); ctx.arc(ex, ey, 0.8 + (i % 2) * 0.6, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    } else if (idleBreath && ft >= 0.18 && ft < 0.32) {
      const k = (ft - 0.18) / 0.14;
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = `rgba(150,140,150,${0.3 * (1 - k)})`;
        ctx.beginPath(); ctx.arc(28 + k * 8 + i * 2.5, -7.5 - k * 6 - i * 1.5, 1.4 + k * 3 + i, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();

    // Spines down the back, then moonlight along the top edge
    ctx.fillStyle = BONE;
    for (let k = 0; k < 5; k++) { const sx = 6 - k * 3.6, sy = -4.6 - Math.sin(k * 0.9) * 0.4; ctx.beginPath(); ctx.moveTo(sx - 1, sy + 0.6); ctx.lineTo(sx - 0.2, sy - 1.8); ctx.lineTo(sx + 0.8, sy + 0.6); ctx.closePath(); ctx.fill(); }
    ctx.strokeStyle = RIM; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(-10, -3.6); ctx.quadraticCurveTo(0, -6.4, 6, -4.6); ctx.quadraticCurveTo(12, -9.2, 17, -9.2); ctx.quadraticCurveTo(20, -11, 23.5, -8.8); ctx.stroke();

    wing(3, -3.6, 1, ['rgba(150,18,24,0.97)', 'rgba(236,96,48,0.86)'], true);
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    ctx.restore();
  }

  // ── Ground (world-space — scrolls with camX/camY like the ramp and biker) ──
  drawBg(W, H, ts, r) {
    const ctx = this.ctx;

    // Sandy pit floor, darkening toward the bottom of the screen
    const top = H * 0.72, trackH = H * TRACK_FRAC;
    const soil = ctx.createLinearGradient(0, H * 0.70, 0, H);
    soil.addColorStop(0, '#76522F'); soil.addColorStop(0.3, '#5E4125'); soil.addColorStop(0.7, '#3A2715'); soil.addColorStop(1, '#1C120A');
    ctx.fillStyle = soil; ctx.fillRect(0, H * 0.70, W, H * 0.30);

    // Groomed track surface with a bumpy leading edge
    const track = ctx.createLinearGradient(0, top, 0, top + trackH);
    track.addColorStop(0, '#A37547'); track.addColorStop(0.5, '#8C623A'); track.addColorStop(1, '#6E4B2A');
    ctx.fillStyle = track;
    ctx.beginPath(); ctx.moveTo(-5, top + trackH);
    for (let px = -5; px <= W + 10; px += 4) {
      const wx = px + this.camX;
      const bump = Math.sin(wx * 0.11) * 2 + Math.sin(wx * 0.068) * 3 + Math.sin(wx * 0.23);
      ctx.lineTo(px, top + bump);
    }
    ctx.lineTo(W + 10, top + trackH); ctx.closePath(); ctx.fill();

    // Sheen along the groomed crest, and tyre grooves worn into the racing line
    ctx.fillStyle = 'rgba(255,222,176,0.09)'; ctx.fillRect(0, top + 3, W, 3);
    ctx.strokeStyle = 'rgba(40,24,10,0.32)'; ctx.lineWidth = 2;
    ctx.setLineDash([30, 14]);
    [0.32, 0.46, 0.66].forEach((f, i) => {
      ctx.lineDashOffset = this.camX * (0.94 + i * 0.03);
      ctx.beginPath(); ctx.moveTo(0, top + trackH * f); ctx.lineTo(W, top + trackH * f); ctx.stroke();
    });
    ctx.setLineDash([]); ctx.lineDashOffset = 0;

    // Loose clumps kicked up along the racing line, scrolling with the track
    const clumpSpan = W + 80;
    for (let i = 0; i < 14; i++) {
      const cx = ((((i * 137.5 - this.camX) % clumpSpan) + clumpSpan) % clumpSpan) - 15;
      const cy = top + trackH * (0.2 + (i % 5) * 0.14);
      ctx.fillStyle = `rgba(${70 + i * 3},${46 + i * 2},${22 + i},0.55)`;
      ctx.beginPath(); ctx.ellipse(cx, cy, 2.5 + (i % 3) * 1.5, 1.4 + (i % 2), 0, 0, Math.PI * 2); ctx.fill();
    }

    // Track lip dropping into the pit
    ctx.fillStyle = 'rgba(255,214,160,0.14)'; ctx.fillRect(0, top + trackH - 1, W, 1);
    const lip = ctx.createLinearGradient(0, top + trackH, 0, top + trackH + 16);
    lip.addColorStop(0, 'rgba(0,0,0,0.4)'); lip.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = lip; ctx.fillRect(0, top + trackH, W, 16);

    // Ground texture spread across the whole track — pebbles, damp/dusty
    // patches and weed tufts, denser and bigger toward the bottom (closer).
    // This is a purely deterministic function of camX (no ts/time term at
    // all), so instead of redrawing ~500 individual arcs/gradients/strokes
    // every rAF frame, each row's tileable pattern is baked once (see
    // ensureGroundTexture) into its own small offscreen strip and every
    // frame just gets blitted back with a cheap drawImage at the right
    // scroll offset — same scrolling look, a fraction of the draw calls.
    this.drawGroundTexture(W, H);

    // Biker graveyard — wrecked bikes/skulls/bones from past runs, sitting
    // right on the bumpy ground so they scroll and settle with the track.
    this.drawWrecks(W, H, ts, r);

    // Distance markers (world-space, scrolling) — neon green to match the HUD.
    // Only the 100m marks get a (centered, glowing) label; the 25/50/75m
    // in-between ticks stay as plain dim lines so the labels don't crowd and
    // blur into each other.
    ctx.font = `italic 800 15px ${FONT_NUM}`; ctx.textAlign = 'center';
    for (let d = 0; d <= 800; d += 25) {
      const wx = r.P2.x + d / 0.22, sx = wx - this.camX;
      if (sx < -40 || sx > W + 40) continue;
      const major = d % 100 === 0;
      ctx.strokeStyle = major ? '#2EE59D' : 'rgba(46,229,157,0.4)';
      ctx.lineWidth = major ? 1.6 : 1;
      ctx.shadowColor = '#2EE59D'; ctx.shadowBlur = major ? 6 : 0;
      ctx.beginPath(); ctx.moveTo(sx, H * 0.72); ctx.lineTo(sx, major ? H * 0.756 : H * 0.736); ctx.stroke();
      if (major && d > 0) {
        ctx.fillStyle = '#2EE59D';
        ctx.fillText(d + 'm', sx, H * 0.79);
      }
      ctx.shadowBlur = 0;
    }
    ctx.textAlign = 'left';

    // Bottom vignette for depth
    const vig = ctx.createLinearGradient(0, H * 0.86, 0, H);
    vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vig; ctx.fillRect(0, H * 0.86, W, H * 0.14);
  }

  // Bakes each ground-texture row (the fine-grain speckle loop plus the
  // bigger pebble/patch/weed loop) into its own small offscreen canvas, one
  // tileable pattern per row exactly `span` pixels wide (the same period the
  // live formula used to wrap with `% span`). Rebuilt only when the CSS size
  // changes — the pattern itself never needs to change, only where it's
  // sampled from, which drawGroundTexture handles every frame with a cheap
  // drawImage offset instead of regenerating any pixels.
  ensureGroundTexture(W, H) {
    if (this._groundBands && this._groundW === W && this._groundH === H) return;
    this._groundW = W; this._groundH = H;
    this._groundBands = [];
    const groundTop = H * 0.72, groundH = H - groundTop;
    const dpr = this.dpr;

    const makeBand = (span, bandTop, bandH, speed, paint) => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(span * dpr));
      c.height = Math.max(1, Math.round(bandH * dpr));
      const bctx = c.getContext('2d');
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(bctx, bandTop);
      this._groundBands.push({ canvas: c, span, bandTop, bandH, speed });
    };

    // Fine grain — lots of tiny, faint specks.
    for (let row = 0; row < 14; row++) {
      const rt = row / 13;
      const rowY = groundTop + groundH * rt;
      const speed = 0.4 + rt * 0.6;
      const span = W + 120;
      const bandTop = rowY - 3, bandH = groundH / 14 + 6;
      makeBand(span, bandTop, bandH, speed, (bctx) => {
        for (let i = 0; i < 26; i++) {
          const seed = row * 53 + i;
          const cx = (seed * 63.1) % span;
          const cy = (rowY - bandTop) + (Math.sin(seed * 8.3) * 0.5 + 0.5) * (groundH / 14);
          bctx.fillStyle = seed % 3 === 0 ? 'rgba(30,17,7,0.3)' : 'rgba(150,112,60,0.22)';
          bctx.beginPath(); bctx.arc(cx, cy, 0.6 + (0.5 + rt) * 0.8, 0, Math.PI * 2); bctx.fill();
        }
      });
    }

    // Bigger features — pebbles, damp/dusty patches, weed tufts, wind
    // ripples in the sand and rocks. Anything near the band's edge is drawn
    // again one span over, so wide pieces tile without a seam.
    for (let row = 0; row < 8; row++) {
      const rt = row / 7;
      const rowY = groundTop + groundH * Math.pow(rt, 0.85);
      const speed = 0.45 + rt * 0.55;
      const span = W + 160;
      const maxSize = 1.6 + rt * 4.4;
      const bandTop = rowY - maxSize * 3.5, bandH = groundH * 0.1 * (0.5 + rt) + maxSize * 7;
      makeBand(span, bandTop, bandH, speed, (bctx) => {
        for (let i = 0; i < 26; i++) {
          const seed = row * 37 + i;
          const x0 = (seed * 91.7) % span;
          const cy = (rowY - bandTop) + (Math.sin(seed * 12.9) * 0.5 + 0.5) * groundH * 0.1 * (0.5 + rt);
          const size = 1.6 + rt * 4.4;
          const kind = seed % 8;
          const reach = size * 8;
          const paint = (cx) => {
            if (kind === 5 || kind === 7) {
              // Wind ripples: a few parallel crests, lit on top, shadowed below
              const len = size * (5 + (seed % 4) * 1.8), n = kind === 7 ? 4 : 3;
              bctx.lineWidth = Math.max(0.7, size * 0.22); bctx.lineCap = 'round';
              for (let k = 0; k < n; k++) {
                const oy = k * size * 0.95, dx = (k % 2) * size * 0.6;
                bctx.strokeStyle = 'rgba(222,178,118,0.2)';
                bctx.beginPath(); bctx.moveTo(cx - len / 2 + dx, cy + oy); bctx.quadraticCurveTo(cx + dx, cy + oy - size * 0.8, cx + len / 2 + dx, cy + oy); bctx.stroke();
                bctx.strokeStyle = 'rgba(30,18,8,0.22)';
                bctx.beginPath(); bctx.moveTo(cx - len / 2 + dx, cy + oy + size * 0.3); bctx.quadraticCurveTo(cx + dx, cy + oy - size * 0.5, cx + len / 2 + dx, cy + oy + size * 0.3); bctx.stroke();
              }
            } else if (kind === 6) {
              // A weathered rock with a contact shadow and a lit top
              const rw = size * (1.3 + (seed % 3) * 0.45), rh = rw * 0.68;
              bctx.fillStyle = 'rgba(0,0,0,0.3)';
              bctx.beginPath(); bctx.ellipse(cx + rw * 0.2, cy + rh * 0.45, rw * 1.15, rh * 0.32, 0, 0, Math.PI * 2); bctx.fill();
              const rg = bctx.createLinearGradient(cx - rw, cy - rh, cx + rw * 0.6, cy + rh * 0.6);
              rg.addColorStop(0, '#A08E74'); rg.addColorStop(0.5, '#6F5F4A'); rg.addColorStop(1, '#382E22');
              bctx.fillStyle = rg;
              bctx.beginPath();
              bctx.moveTo(cx - rw, cy + rh * 0.4);
              bctx.quadraticCurveTo(cx - rw * 0.95, cy - rh * 0.55, cx - rw * 0.25, cy - rh);
              bctx.quadraticCurveTo(cx + rw * 0.55, cy - rh * 0.95, cx + rw, cy - rh * 0.05);
              bctx.quadraticCurveTo(cx + rw * 0.85, cy + rh * 0.5, cx, cy + rh * 0.5);
              bctx.closePath(); bctx.fill();
              bctx.fillStyle = 'rgba(255,236,200,0.18)';
              bctx.beginPath(); bctx.ellipse(cx - rw * 0.3, cy - rh * 0.55, rw * 0.38, rh * 0.22, -0.3, 0, Math.PI * 2); bctx.fill();
            } else if (kind === 0) {
              bctx.fillStyle = `rgba(${58 + (seed * 7) % 40},${38 + (seed * 5) % 28},${18 + (seed * 3) % 18},0.55)`;
              bctx.beginPath(); bctx.ellipse(cx, cy, size * 1.1, size * 0.6, seed % 2 ? 0.3 : -0.3, 0, Math.PI * 2); bctx.fill();
            } else if (kind === 1) {
              const g = bctx.createRadialGradient(cx, cy, 0, cx, cy, size * 3);
              g.addColorStop(0, 'rgba(28,16,7,0.32)'); g.addColorStop(1, 'rgba(28,16,7,0)');
              bctx.fillStyle = g; bctx.beginPath(); bctx.arc(cx, cy, size * 3, 0, Math.PI * 2); bctx.fill();
            } else if (kind === 2) {
              const g = bctx.createRadialGradient(cx, cy, 0, cx, cy, size * 3.2);
              g.addColorStop(0, 'rgba(175,132,72,0.2)'); g.addColorStop(1, 'rgba(175,132,72,0)');
              bctx.fillStyle = g; bctx.beginPath(); bctx.arc(cx, cy, size * 3.2, 0, Math.PI * 2); bctx.fill();
            } else if (kind === 3) {
              bctx.strokeStyle = 'rgba(95,115,42,0.5)'; bctx.lineWidth = 1;
              [-1, 0, 1].forEach(o => {
                bctx.beginPath(); bctx.moveTo(cx + o * 1.5, cy); bctx.lineTo(cx + o * 2.4, cy - size * 1.4); bctx.stroke();
              });
            } else {
              bctx.fillStyle = `rgba(${95 + (seed * 3) % 45},${62 + (seed * 2) % 28},${30 + seed % 18},0.6)`;
              bctx.beginPath(); bctx.arc(cx, cy, Math.max(1, size * 0.35), 0, Math.PI * 2); bctx.fill();
            }
          };
          paint(x0);
          if (x0 < reach) paint(x0 + span);
          else if (x0 > span - reach) paint(x0 - span);
        }
      });
    }
  }

  // Draws all the ground-texture bands baked by ensureGroundTexture, each
  // shifted horizontally by its own parallax speed — a handful of drawImage
  // calls (each band drawn up to twice, to tile seamlessly across the
  // viewport) standing in for what used to be ~500 individual primitive
  // draws every single frame.
  drawGroundTexture(W, H) {
    this.ensureGroundTexture(W, H);
    const ctx = this.ctx;
    this._groundBands.forEach(({ canvas, span, bandTop, bandH, speed }) => {
      let shift = (this.camX * speed) % span;
      if (shift < 0) shift += span;
      let dx = -shift;
      while (dx < W) {
        // Whole band scaled into CSS px (its backing store is DPR-sized)
        ctx.drawImage(canvas, dx, bandTop, span, bandH);
        dx += span;
      }
    });
  }

  // ── Crowd (precomputed once; seats use fractional x positions so the layout
  // stays valid across resizes without regenerating — regenerating each frame
  // or each resize would make the crowd flicker/reshuffle) ─────────────────
  // Two decks: a hazy upper tier above the LED balcony ribbon and a closer
  // lower bowl below it. `depth` (0 = farthest, 1 = front row) drives fan
  // size and detail; `t` is the row's position within its own deck.
  buildCrowd() {
    const rand = Math.random;
    const pick = (list) => {
      let roll = rand() * list.reduce((s, item) => s + item[1], 0);
      for (const [v, w] of list) { roll -= w; if (roll <= 0) return v; }
      return list[list.length - 1][0];
    };
    // Weighted toward the home colors so the stands read as one crowd.
    const SHIRTS = [['#2EE59D', 14], ['#14B97A', 8], ['#E8EEF6', 12], ['#1E3A66', 10], ['#3D7BFF', 7],
      ['#FFD23F', 7], ['#FF8A1F', 5], ['#FF5C7A', 6], ['#8B5CF6', 4], ['#5A6478', 8], ['#1A1F2B', 9], ['#5CD6FF', 5]];
    const SKINS = ['#F2D0AE', '#E9B98C', '#D7A57A', '#C68E62', '#A8714A', '#7A4E30', '#5A3A24'];
    const HAIRS = ['#1B1410', '#2B1D14', '#3B2617', '#6B4423', '#C99B5B', '#8A8F98', '#A0442A'];
    const CAPS = ['#2EE59D', '#1E3A66', '#FFD23F', '#FF5C7A', '#E8EEF6', '#1A1F2B'];
    const FLAGS = [['#2EE59D', 3], ['#FFD23F', 2], ['#E8EEF6', 2], ['#FF5C7A', 1]];
    const SCARVES = [[['#2EE59D', '#F4F7FB'], 3], [['#14223F', '#2EE59D'], 2], [['#FFD23F', '#14223F'], 2], [['#FF5C7A', '#F4F7FB'], 1]];

    this.aisleFracs = [0.33, 0.67];
    const inAisle = (f) => this.aisleFracs.some((a) => Math.abs(f - a) < 0.016);

    const DECKS = [
      { deck: 'upper', rows: 7, depthFrom: 0.08, depthTo: 0.34 },
      { deck: 'lower', rows: 9, depthFrom: 0.44, depthTo: 1 },
    ];
    this.crowdRows = [];
    DECKS.forEach(({ deck, rows, depthFrom, depthTo }) => {
      for (let r = 0; r < rows; r++) {
        const t = r / (rows - 1);
        const depth = depthFrom + (depthTo - depthFrom) * t;
        const size = 2.2 + depth * 6.3;
        // Seats packed ~1.4 fan-widths apart (at a 1300px-wide canvas) so the
        // stands read as a full house rather than scattered pins.
        const count = Math.round(1430 / (size * 1.16 * 1.4));
        const seats = [];
        for (let i = 0; i < count; i++) {
          const xFrac = (i + (r % 2 ? 0.75 : 0.25) + (rand() - 0.5) * 0.3) / count;
          if (inAisle(xFrac) || rand() < 0.04) continue; // a few empty seats let the seat colors show through
          seats.push({
            xFrac,
            shirt: pick(SHIRTS),
            skin: SKINS[(rand() * SKINS.length) | 0],
            hair: HAIRS[(rand() * HAIRS.length) | 0],
            cap: rand() < 0.16 ? CAPS[(rand() * CAPS.length) | 0] : null,
            lean: (rand() - 0.5) * 0.7,
            phase: rand() * Math.PI * 2,
            armsRoll: rand(), // compared against a live threshold so the whole stand can "cheer" together
            phone: depth > 0.2 && rand() < 0.05,
            flag: depth > 0.62 && rand() < 0.022 ? pick(FLAGS) : null,
            sign: depth > 0.6 && rand() < 0.02 ? pick([['#F4F7FB', 3], ['#2EE59D', 2], ['#FFD23F', 2]]) : null,
            finger: depth > 0.55 && rand() < 0.025,
            scarf: depth > 0.62 && rand() < 0.06 ? pick(SCARVES) : null,
          });
        }
        this.crowdRows.push({ deck, t, depth, size, seats });
      }
    });
  }

  // ── Wreckage field (precomputed once, same reasoning as buildCrowd — a
  // stable layout so pieces don't reshuffle every frame/resize). Every entry
  // is exactly one debris item at its own independent spot; `d` is meters
  // past the landing reference (negative `d` = behind the ramp, in the
  // paddock, for bikes that never made the jump), so position is re-derived
  // from the ramp each frame rather than stored in world coordinates.
  buildWrecks() {
    this.wreckItems = [];
    // The HUD draws its own distance-marker ticks/labels every 25m (bigger,
    // labeled ones every 100m) — keep debris clear of both so a skull or
    // skeleton never sits on top of a tick line or its "Xm" text.
    const clearOfMarkers = (d) => {
      const to25 = Math.abs(d - Math.round(d / 25) * 25);
      const to100 = Math.abs(d - Math.round(d / 100) * 100);
      return to25 > 9 && to100 > 20;
    };
    const addSpread = (from, to, stepMin, stepMax, avoidMarkers) => {
      let d = from;
      while (true) {
        d += stepMin + Math.random() * (stepMax - stepMin);
        if (d >= to) break;
        if (avoidMarkers) {
          let tries = 0;
          while (!clearOfMarkers(d) && tries < 6) { d += 4 + Math.random() * 5; tries++; }
        }
        this.wreckItems.push({
          d,
          kind: WRECK_KINDS[(Math.random() * WRECK_KINDS.length) | 0],
          depthT: 0.12 + Math.random() * 0.72,
          lat: (Math.random() - 0.5) * 30,
          rot: (Math.random() - 0.5) * 1.1,
          flip: Math.random() > 0.5 ? -1 : 1,
          scale: 0.8 + Math.random() * 0.55,
          phase: Math.random() * 1000,
        });
      }
    };
    addSpread(30, 760, 35, 70, true);      // landing zone — one lone item every 35-70m, clear of markers
    addSpread(-620, -100, 90, 170, false); // paddock behind the ramp — no markers back there, sparser
  }

  // ── Stand layout ─────────────────────────────────────────────────────────
  // The stand spans exactly the canvas width and repeats seamlessly, so the
  // parallax drift (a tenth of the camera's travel) can wrap forever on long
  // flights without the stand ever running out. `par` is the raw drift;
  // `shift` is that drift wrapped into [0, W).
  standGeom(W, H, gY) {
    const standTop = H * 0.33;
    const hoardH = Math.max(14, H * 0.034);
    const lowerBottom = gY - hoardH;
    const bandH = Math.max(10, H * 0.026);
    const bandTop = standTop + (lowerBottom - standTop) * 0.3;
    const par = this.camX * 0.1;
    return {
      W, H, gY, par, shift: ((par % W) + W) % W,
      standTop, roofH: H * 0.026, trussH: H * 0.02, hoardH,
      bandTop, bandH, lowerTop: bandTop + bandH, lowerBottom,
      sizeScale: Math.min(1.2, Math.max(0.6, W / 1300)),
    };
  }

  // Screen x of a repeating stand element at fraction `f`, plus its wrapped
  // copies when they're within `pad` of either edge.
  wrapXs(g, f, pad) {
    const x = (((f * g.W - g.shift) % g.W) + g.W) % g.W;
    return [x - g.W, x, x + g.W].filter((v) => v > -pad && v < g.W + pad);
  }

  crowdRowY(g, row) {
    const size = row.size * g.sizeScale;
    const deckTop = row.deck === 'upper' ? g.standTop : g.lowerTop;
    const deckBottom = row.deck === 'upper' ? g.bandTop : g.lowerBottom;
    const top = deckTop + size * 1.05, bottom = deckBottom - size * 0.95;
    return top + (bottom - top) * row.t;
  }

  // Paints the whole seating bowl — structure, seats, fans, aisles, roof —
  // onto an offscreen stand canvas, unshifted and seamlessly tileable at
  // width W. Everything here is static or slow ambient motion (bobbing, the
  // far rows' Mexican wave, phone lights), so it's repainted in the
  // background (see ensureCrowdLayer) instead of every frame — in stages, so
  // that repaint can be spread over several short tasks.
  paintCrowdLayer(g, ts, ctx = this._crowdCtx) {
    for (let s = 0; s < CROWD_STAGES; s++) this.paintCrowdStage(ctx, g, ts, s);
  }

  // Stage 0: clear + the bowl itself. Stages 1…5: a slice of the seat rows,
  // back to front. Last stage: haze, aisles, balustrades and the roof.
  paintCrowdStage(ctx, g, ts, stage) {
    const { W, standTop, roofH, trussH, bandTop, bandH, lowerTop, lowerBottom, sizeScale } = g;
    const xAt = (f) => f * W;
    if (stage === 0) {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.restore();
      const bowl = ctx.createLinearGradient(0, standTop, 0, lowerBottom);
      bowl.addColorStop(0, '#060C18'); bowl.addColorStop(1, '#0A1426');
      ctx.fillStyle = bowl;
      ctx.fillRect(0, standTop, W, lowerBottom - standTop);
      ctx.fillStyle = '#050A14';
      ctx.fillRect(0, bandTop, W, bandH);
      return;
    }
    if (stage < CROWD_STAGES - 1) {
      const n = this.crowdRows.length, slices = [0, 0.32, 0.56, 0.75, 0.875, 1].map((f) => Math.round(f * n));
      const sections = [0, ...this.aisleFracs, 1];
      const SEAT = ['#0C3D35', '#16244A', '#0C3D35'];
      const armsUpChance = 0.08 + this.cheer * 0.55;
      // The far (tiny) rows ride the Mexican wave here; the big front rows are
      // painted seated and drawn standing live every frame (drawWaveFans).
      const waveX = (ts * 0.00008) % 1;
      this.crowdRows.slice(slices[stage - 1], slices[stage]).forEach((row) => {
        const size = row.size * sizeScale;
        const y = this.crowdRowY(g, row);
        const deckBottom = row.deck === 'upper' ? bandTop : lowerBottom;
        const stepY = y + size * 0.62;

        for (let s = 0; s < 3; s++) {
          ctx.fillStyle = SEAT[s];
          ctx.fillRect(xAt(sections[s]), y - size * 0.05, xAt(sections[s + 1]) - xAt(sections[s]), size * 0.7);
        }

        if (row.deck === 'upper') this.paintFarFans(ctx, g, row, y, size, ts, waveX, armsUpChance);
        else this.paintNearFans(ctx, g, row, y, size, ts, row.size >= 6.2 && !this.lowPower ? null : waveX, armsUpChance);

        ctx.fillStyle = row.deck === 'upper' ? '#08111F' : '#0B1628';
        ctx.fillRect(0, stepY, W, deckBottom - stepY);
        ctx.fillStyle = 'rgba(160,200,245,0.05)';
        ctx.fillRect(0, stepY, W, Math.max(1, size * 0.1));
      });
      return;
    }

    // Atmospheric depth: the upper tier sits deeper in shadow under the roof.
    const upHaze = ctx.createLinearGradient(0, standTop, 0, bandTop);
    upHaze.addColorStop(0, 'rgba(4,7,15,0.66)'); upHaze.addColorStop(1, 'rgba(4,7,15,0.3)');
    ctx.fillStyle = upHaze; ctx.fillRect(0, standTop, W, bandTop - standTop);
    const loHaze = ctx.createLinearGradient(0, lowerTop, 0, lowerBottom);
    loHaze.addColorStop(0, 'rgba(4,7,15,0.36)'); loHaze.addColorStop(1, 'rgba(4,7,15,0.04)');
    ctx.fillStyle = loHaze; ctx.fillRect(0, lowerTop, W, lowerBottom - lowerTop);

    this.aisleFracs.forEach((f) => this.paintAisle(ctx, g, xAt(f)));

    // Glass balustrades along the front of each deck, the top rail catching
    // the light (post spacing divides W exactly so the stand still tiles).
    const glass = (yb, h) => {
      const gg = ctx.createLinearGradient(0, yb - h, 0, yb);
      gg.addColorStop(0, 'rgba(170,215,250,0.16)'); gg.addColorStop(1, 'rgba(170,215,250,0.05)');
      ctx.fillStyle = gg; ctx.fillRect(0, yb - h, W, h);
      ctx.fillStyle = 'rgba(214,240,255,0.45)'; ctx.fillRect(0, yb - h, W, 1);
      ctx.fillStyle = 'rgba(214,240,255,0.14)';
      const posts = Math.max(1, Math.round(W / 46));
      for (let i = 0; i < posts; i++) ctx.fillRect((i + 0.5) * (W / posts), yb - h, 1, h);
    };
    glass(bandTop, Math.max(5, g.H * 0.011));
    glass(lowerBottom, Math.max(6, g.H * 0.013));

    // Roof: truss, fascia, LED trim and the downlights washing the upper tier.
    const roofTop = standTop - roofH, trussTop = roofTop - trussH;
    const bays = Math.max(1, Math.round(W / Math.max(14, trussH * 1.7))), step = W / bays;
    ctx.strokeStyle = 'rgba(40,58,90,0.95)'; ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(0, trussTop); ctx.lineTo(W, trussTop);
    for (let b = 0; b < bays; b++) {
      const xx = b * step;
      ctx.moveTo(xx, roofTop); ctx.lineTo(xx + step / 2, trussTop); ctx.lineTo(xx + step, roofTop);
    }
    ctx.stroke();

    const fascia = ctx.createLinearGradient(0, roofTop, 0, standTop);
    fascia.addColorStop(0, '#18253D'); fascia.addColorStop(1, '#0A111F');
    ctx.fillStyle = fascia; ctx.fillRect(0, roofTop, W, roofH);
    ctx.fillStyle = 'rgba(255,255,255,0.09)'; ctx.fillRect(0, roofTop, W, 1);

    ctx.fillStyle = '#2EE59D'; ctx.fillRect(0, standTop - 1.5, W, 1.5);
    const trim = ctx.createLinearGradient(0, standTop, 0, standTop + 16);
    trim.addColorStop(0, 'rgba(46,229,157,0.22)'); trim.addColorStop(1, 'rgba(46,229,157,0)');
    ctx.fillStyle = trim; ctx.fillRect(0, standTop, W, 16);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const lamps = 10, gap = W / lamps;
    for (let i = 0; i < lamps; i++) {
      const lx = gap * (i + 0.5);
      const pool = ctx.createRadialGradient(lx, standTop, 0, lx, standTop, gap * 0.75);
      pool.addColorStop(0, 'rgba(255,236,200,0.11)'); pool.addColorStop(1, 'rgba(255,236,200,0)');
      ctx.fillStyle = pool;
      ctx.fillRect(lx - gap * 0.75, standTop, gap * 1.5, gap * 0.75);
      ctx.fillStyle = 'rgba(255,246,222,0.9)';
      ctx.fillRect(lx - 3, standTop - 3, 6, 2);
    }
    ctx.restore();
  }

  // A fan right at the tile edge is also drawn at x ± W so it isn't sliced
  // in half where the stand wraps.
  fanXs(x, W, margin) {
    if (x < margin) return [x, x + W];
    if (x > W - margin) return [x, x - W];
    return [x];
  }

  // How far the Mexican wave has lifted a fan at `xFrac` (0…1): a smooth
  // bell around the wave front as it sweeps the stand, so fans rise and sit
  // in a rolling swell instead of popping up in a hard band. `lag` holds a
  // tier back slightly so the front leans like a real wave.
  waveRise(xFrac, waveX, lag) {
    if (waveX == null) return 0;
    let d = xFrac - (waveX - lag);
    d -= Math.round(d);
    return Math.exp(-(d * d) / 0.0008);
  }
  // Rows further back run slightly behind, so the wave's front leans.
  waveLag(row) { return (1 - row.depth) * 0.016; }

  // The Mexican wave through the big front rows, drawn live every frame on
  // top of the cached stand (where those rows are painted seated) so it
  // rolls at full frame rate: only the fans inside the swell are redrawn —
  // standing, arms going up — in the same batched style as the stand. A
  // standing fan fully covers its seated copy, which just reads as legs.
  drawWaveFans(g, ts) {
    if (this.lowPower) return; // the cached stand carries the whole wave then
    const ctx = this.ctx, waveX = (ts * 0.00008) % 1;
    const rows = [];
    this.crowdRows.forEach((row) => {
      if (row.deck !== 'lower' || row.size < 6.2) return;
      const lag = this.waveLag(row);
      const seats = row.seats.filter((s) => this.waveRise(s.xFrac, waveX, lag) > 0.1);
      if (seats.length) rows.push({ row: { ...row, seats }, y: this.crowdRowY(g, row), size: row.size * g.sizeScale });
    });
    if (!rows.length) return;
    (g.shift > 0.5 ? [-g.shift, g.W - g.shift] : [-g.shift]).forEach((dx) => {
      ctx.save(); ctx.translate(dx, 0);
      rows.forEach(({ row, y, size }) => this.paintNearFans(ctx, g, row, y, size, ts, waveX, 0, true));
      ctx.restore();
    });
  }

  // Fans are painted in batches: every shape of one colour in a row goes into
  // a single path (bodies, then heads, then hair…) instead of a fill per fan.
  // Same picture, but a stand repaint drops from tens of thousands of canvas
  // calls to a few hundred — the difference between a smooth crowd and a
  // stalling one on a phone's GPU.
  static batchInto(map, color) {
    let list = map.get(color);
    if (!list) map.set(color, (list = []));
    return list;
  }

  // Upper-tier fans are only a few pixels tall — plain rects read the same at
  // that size and cost a fraction of a full figure.
  paintFarFans(ctx, g, row, y, size, ts, waveX, armsUpChance) {
    const w = size * 1.1, head = size * 0.82, into = BikeGame.batchInto;
    const lag = this.waveLag(row);
    const bodies = new Map(), heads = new Map(), hair = new Map(), lights = [];
    row.seats.forEach((s) => {
      const rise = this.waveRise(s.xFrac, waveX, lag);
      const yy = y - size * 0.62 * rise;
      const armsUp = rise > 0.35 || s.armsRoll < armsUpChance;
      const phoneOn = s.phone && Math.sin(ts * 0.002 + s.phase * 3) > 0.5;
      this.fanXs(s.xFrac * g.W, g.W, size * 2).forEach((x) => {
        const b = into(bodies, s.shirt);
        b.push(x - w / 2, yy - size * 0.1, w, size * 1.3);
        if (armsUp) b.push(x - w * 0.75, yy - size * 0.95, size * 0.28, size * 0.9, x + w * 0.75 - size * 0.28, yy - size * 0.95, size * 0.28, size * 0.9);
        into(heads, s.skin).push(x - head / 2, yy - size * 0.92, head, head);
        into(hair, s.cap || s.hair).push(x - head / 2, yy - size * 0.98, head, head * 0.38);
        if (phoneOn) lights.push(x + size * 0.5, yy - size * 1.2);
      });
    });
    ctx.globalAlpha = row.deck === 'upper' ? 0.88 : 1;
    [bodies, heads, hair].forEach((layer) => layer.forEach((r, color) => {
      ctx.fillStyle = color; ctx.beginPath();
      for (let i = 0; i < r.length; i += 4) ctx.rect(r[i], r[i + 1], r[i + 2], r[i + 3]);
      ctx.fill();
    }));
    for (let i = 0; i < lights.length; i += 2) this.paintPhoneLight(ctx, lights[i], lights[i + 1], size);
    ctx.globalAlpha = 1;
  }

  // Lower-bowl fans. Only the front rows (where it's visible) get the full
  // rounded figure; the rows behind use the same cheap rects as the upper tier
  // to keep each stand repaint short.
  // `live` marks the per-frame wave overlay: it skips the props held up and
  // the fine shading/rim passes to stay cheap at full frame rate.
  paintNearFans(ctx, g, row, y, size, ts, waveX, armsUpChance, live = false) {
    if (row.size < 6.2) { this.paintFarFans(ctx, g, row, y, size, ts, waveX, armsUpChance); return; }
    const into = BikeGame.batchInto;
    const arms = new Map(), hands = new Map(), bodies = new Map(), heads = new Map(), hair = new Map(), brims = new Map();
    const fans = [], extras = [];
    const lag = this.waveLag(row);
    row.seats.forEach((s) => {
      const rise = this.waveRise(s.xFrac, waveX, lag);
      const yy = y + Math.sin(ts * 0.0016 + s.phase) * size * 0.08 - size * 0.95 * rise;
      // Arms go all the way up for signs, scarves and cheering; wave
      // riders raise them as the swell lifts them.
      const raise = s.sign || s.scarf || s.armsRoll < armsUpChance ? 1 : Math.min(1, rise * 1.6);
      const phoneOn = s.phone && Math.sin(ts * 0.002 + s.phase * 3) > 0.5;
      this.fanXs(s.xFrac * g.W + s.lean * size * 0.25, g.W, size * 4).forEach((x) => {
        if (raise > 0.15) {
          const ax = size * (0.6 + 0.22 * raise), ay = size * (0.3 + 0.68 * raise);
          into(arms, s.shirt).push(x - size * 0.42, yy, x - ax, yy - ay, x + size * 0.42, yy, x + ax, yy - ay);
          into(hands, s.skin).push(x - ax, yy - ay - size * 0.05, x + ax, yy - ay - size * 0.05);
        }
        into(bodies, s.shirt).push(x, yy);
        into(heads, s.skin).push(x, yy);
        into(hair, s.cap || s.hair).push(x, yy);
        if (s.cap) into(brims, s.cap).push(x, yy);
        fans.push(x, yy);
        if (!live && (s.flag || s.scarf || s.sign || s.finger || phoneOn)) extras.push({ s, x, yy, phoneOn });
      });
    });

    const handR = size * 0.16, headR = size * 0.4, hairR = size * 0.41, rimR = size * 0.37;
    const corner = [size * 0.45, size * 0.45, size * 0.1, size * 0.1];
    ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1, size * 0.26);
    arms.forEach((p, color) => {
      ctx.strokeStyle = color; ctx.beginPath();
      for (let i = 0; i < p.length; i += 4) { ctx.moveTo(p[i], p[i + 1]); ctx.lineTo(p[i + 2], p[i + 3]); }
      ctx.stroke();
    });
    hands.forEach((p, color) => {
      ctx.fillStyle = color; ctx.beginPath();
      for (let i = 0; i < p.length; i += 2) { ctx.moveTo(p[i] + handR, p[i + 1]); ctx.arc(p[i], p[i + 1], handR, 0, Math.PI * 2); }
      ctx.fill();
    });
    bodies.forEach((p, color) => {
      ctx.fillStyle = color; ctx.beginPath();
      for (let i = 0; i < p.length; i += 2) ctx.roundRect(p[i] - size * 0.58, p[i + 1] - size * 0.12, size * 1.16, size * 1.3, corner);
      ctx.fill();
    });
    if (!live) {
      ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.beginPath();
      for (let i = 0; i < fans.length; i += 2) ctx.rect(fans[i] + size * 0.14, fans[i + 1] + size * 0.02, size * 0.44, size * 1.1);
      ctx.fill();
    }
    heads.forEach((p, color) => {
      ctx.fillStyle = color; ctx.beginPath();
      for (let i = 0; i < p.length; i += 2) { ctx.moveTo(p[i] + headR, p[i + 1] - size * 0.5); ctx.arc(p[i], p[i + 1] - size * 0.5, headR, 0, Math.PI * 2); }
      ctx.fill();
    });
    hair.forEach((p, color) => {
      ctx.fillStyle = color; ctx.beginPath();
      for (let i = 0; i < p.length; i += 2) { ctx.moveTo(p[i] - hairR, p[i + 1] - size * 0.56); ctx.arc(p[i], p[i + 1] - size * 0.56, hairR, Math.PI, 0); ctx.closePath(); }
      ctx.fill();
    });
    brims.forEach((p, color) => {
      ctx.fillStyle = color; ctx.beginPath();
      for (let i = 0; i < p.length; i += 2) ctx.rect(p[i], p[i + 1] - size * 0.62, size * 0.62, size * 0.12);
      ctx.fill();
    });
    // Floodlight catching the top of every head
    if (!live) {
      ctx.strokeStyle = 'rgba(255,236,206,0.3)'; ctx.lineWidth = Math.max(0.6, size * 0.1); ctx.beginPath();
      for (let i = 0; i < fans.length; i += 2) {
        const cx = fans[i], cy = fans[i + 1] - size * 0.52;
        ctx.moveTo(cx + Math.cos(Math.PI * 1.1) * rimR, cy + Math.sin(Math.PI * 1.1) * rimR);
        ctx.arc(cx, cy, rimR, Math.PI * 1.1, Math.PI * 1.7);
      }
      ctx.stroke();
    }

    // The few fans holding something up, drawn on top of the row
    extras.forEach(({ s, x, yy, phoneOn }) => {
      if (s.flag) this.paintFlag(ctx, x, yy, size, s, ts);
      if (s.scarf) {
        // A team scarf stretched overhead between both hands
        const sw = size * 1.9, sh = size * 0.36, sx = x - sw / 2, sy = yy - size * 1.14, n = 5;
        for (let k = 0; k < n; k++) {
          ctx.fillStyle = s.scarf[k % 2];
          ctx.fillRect(sx + (sw / n) * k, sy, sw / n + 0.3, sh);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(sx, sy + sh * 0.62, sw, sh * 0.38);
      }
      if (s.sign) {
        // A hand-made sign held overhead
        const sw = size * 3.4, sh = size * 1.9, sx = x - sw / 2, sy = yy - size * 3.1;
        ctx.fillStyle = s.sign; ctx.fillRect(sx, sy, sw, sh);
        ctx.fillStyle = s.sign === '#F4F7FB' ? '#14223F' : '#0A1222';
        ctx.fillRect(sx + sw * 0.14, sy + sh * 0.28, sw * 0.72, sh * 0.16);
        ctx.fillRect(sx + sw * 0.24, sy + sh * 0.58, sw * 0.52, sh * 0.14);
      } else if (s.finger) {
        // Foam finger on one raised hand
        const fx = x + size * 0.82, fy = yy - size * 1.2;
        ctx.fillStyle = '#2EE59D';
        ctx.beginPath(); ctx.roundRect(fx - size * 0.45, fy - size * 0.9, size * 0.9, size * 1.1, size * 0.3); ctx.fill();
        ctx.beginPath(); ctx.roundRect(fx - size * 0.16, fy - size * 2.1, size * 0.36, size * 1.3, size * 0.18); ctx.fill();
      }
      if (phoneOn) this.paintPhoneLight(ctx, x + size * 0.7, yy - size * 1.35, size);
    });
    ctx.lineCap = 'butt';
  }

  paintFlag(ctx, x, y, size, s, ts) {
    const px = x + size * 0.85, top = y - size * 3.3;
    ctx.strokeStyle = '#C9D3E0'; ctx.lineWidth = Math.max(1, size * 0.1);
    ctx.beginPath(); ctx.moveTo(px, y - size * 0.2); ctx.lineTo(px, top); ctx.stroke();
    const fw = size * 2.5, fh = size * 1.5, wv = Math.sin(ts * 0.006 + s.phase) * size * 0.4;
    ctx.fillStyle = s.flag;
    ctx.beginPath();
    ctx.moveTo(px, top);
    ctx.quadraticCurveTo(px + fw * 0.5, top + wv, px + fw, top + wv * 0.4);
    ctx.lineTo(px + fw, top + fh + wv * 0.4);
    ctx.quadraticCurveTo(px + fw * 0.5, top + fh + wv, px, top + fh);
    ctx.closePath(); ctx.fill();
  }

  paintPhoneLight(ctx, x, y, size) {
    const r = Math.max(3, size * 1.5);
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, 'rgba(255,255,255,0.85)'); glow.addColorStop(0.25, 'rgba(220,240,255,0.35)'); glow.addColorStop(1, 'rgba(220,240,255,0)');
    ctx.fillStyle = glow; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // A stairway cut through both tiers, with a centre handrail and a lit
  // tunnel portal at the foot of the lower bowl.
  paintAisle(ctx, g, ax) {
    const { W, standTop, lowerTop, lowerBottom, sizeScale } = g;
    const hw = W * 0.011;
    ctx.fillStyle = '#050B16';
    ctx.fillRect(ax - hw, standTop, hw * 2, lowerBottom - standTop);
    ctx.fillStyle = 'rgba(160,200,245,0.10)';
    this.crowdRows.forEach((row) => {
      ctx.fillRect(ax - hw, this.crowdRowY(g, row) + row.size * sizeScale * 0.62, hw * 2, 1);
    });
    ctx.fillStyle = 'rgba(140,210,230,0.3)';
    ctx.fillRect(ax - 0.5, standTop, 1, lowerBottom - standTop);

    const pw = hw * 2.8, ph = (lowerBottom - lowerTop) * 0.32;
    const px = ax - pw / 2, py = lowerBottom - ph;
    const portal = () => { ctx.beginPath(); ctx.roundRect(px, py, pw, ph, [pw * 0.4, pw * 0.4, 0, 0]); };
    ctx.fillStyle = '#02050B'; portal(); ctx.fill();
    const glow = ctx.createRadialGradient(ax, lowerBottom, 0, ax, lowerBottom, ph * 1.1);
    glow.addColorStop(0, 'rgba(255,196,120,0.4)'); glow.addColorStop(1, 'rgba(255,196,120,0)');
    ctx.fillStyle = glow; portal(); ctx.fill();
    ctx.strokeStyle = 'rgba(160,200,245,0.28)'; ctx.lineWidth = 1; portal(); ctx.stroke();
  }

  // Makes sure a cached stand exists (painted synchronously, once, when it's
  // (re)created) and keeps it alive in the background. The layer only covers
  // the stand's own height, not the whole canvas, so tiling it each frame
  // fills far fewer pixels. Repaints go into a back buffer one stage at a
  // time — separate short tasks, with frames rendering in between — and the
  // finished buffer is swapped in whole, so the crowd keeps moving without
  // ever making a frame late. The layer doesn't depend on the camera at all;
  // drawStadium just tiles it at the current parallax shift every frame.
  ensureCrowdLayer(g) {
    const key = `${this.cw}x${this.ch}@${this.dpr}`;
    if (this._crowdCanvas && this._crowdKey === key) return;
    const top = g.standTop - g.roofH - g.trussH - 6, h = g.lowerBottom + 4 - top;
    this._crowdKey = key; this._crowdTop = top; this._crowdH = h;
    const make = () => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(this.cw * this.dpr)); c.height = Math.max(1, Math.round(h * this.dpr));
      const cx = c.getContext('2d');
      cx.setTransform(this.dpr, 0, 0, this.dpr, 0, -top * this.dpr);
      return [c, cx];
    };
    [this._crowdCanvas, this._crowdCtx] = make();
    [this._crowdBack, this._crowdBackCtx] = make();
    this.paintCrowdLayer(g, performance.now(), this._crowdCtx);

    if (this._crowdTimer) clearTimeout(this._crowdTimer);
    let stage = 0, jobTs = 0, jobG = null;
    const step = () => {
      if (this._crowdKey !== key) return; // superseded by a resize
      // Suspended, hidden or mid-resize (the canvas no longer matches this
      // layer, e.g. 0×0 under display:none): skip this round. A resize
      // rebuilds the layer on the next draw anyway.
      if (this._suspended || `${this.cw}x${this.ch}@${this.dpr}` !== key) {
        stage = 0; this._crowdTimer = setTimeout(step, this.crowdMs); return;
      }
      if (stage === 0) { jobTs = performance.now(); jobG = this.standGeom(this.cw, this.ch, this.getRamp().gY); }
      try { this.paintCrowdStage(this._crowdBackCtx, jobG, jobTs, stage); } catch (e) { this.report(e); }
      if (++stage < CROWD_STAGES) { this._crowdTimer = setTimeout(step, 0); return; }
      stage = 0;
      [this._crowdCanvas, this._crowdBack] = [this._crowdBack, this._crowdCanvas];
      [this._crowdCtx, this._crowdBackCtx] = [this._crowdBackCtx, this._crowdCtx];
      this._crowdTimer = setTimeout(step, this.crowdMs);
    };
    this._crowdTimer = setTimeout(step, this.crowdMs);
  }

  // Fine dark grid laid over the LED surfaces so they read as pixel panels.
  ledPattern() {
    if (!this._ledPattern) {
      const c = document.createElement('canvas');
      c.width = 3; c.height = 3;
      const p = c.getContext('2d');
      p.fillStyle = 'rgba(0,0,0,0.38)';
      p.fillRect(2, 0, 1, 3); p.fillRect(0, 2, 3, 1);
      this._ledPattern = this.ctx.createPattern(c, 'repeat');
    }
    return this._ledPattern;
  }

  // The balcony ribbon's text is baked once into a tileable strip; each
  // frame just scrolls it with drawImage.
  ensureRibbonStrip(h) {
    if (this._ribbon && this._ribbon.h === h) return this._ribbon;
    const font = `italic 800 ${Math.round(h * 0.66)}px ${FONT_NUM}`;
    const SEGS = [['BIKE IT', '#F4F7FB'], ['PREDICT', '#2EE59D'], ['BET', '#F4F7FB'], ['RACE', '#2EE59D'],
      ['8× BULLSEYE', '#FFD23F'], ['PROVABLY FAIR', '#5CD6FF']];
    const sep = '   •   ';
    const m = document.createElement('canvas').getContext('2d');
    m.font = font;
    const sepW = m.measureText(sep).width;
    const total = SEGS.reduce((w, [t]) => w + m.measureText(t).width + sepW, 0);
    const c = document.createElement('canvas');
    c.width = Math.ceil(total * this.dpr); c.height = Math.ceil(h * this.dpr);
    const sctx = c.getContext('2d');
    sctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    sctx.font = font; sctx.textBaseline = 'middle';
    let x = 0;
    SEGS.forEach(([t, col]) => {
      sctx.fillStyle = col; sctx.fillText(t, x, h * 0.54); x += sctx.measureText(t).width;
      sctx.fillStyle = 'rgba(244,247,251,0.35)'; sctx.fillText(sep, x, h * 0.54); x += sepW;
    });
    this._ribbon = { canvas: c, w: total, h };
    return this._ribbon;
  }

  drawLedRibbon(g, ts) {
    const ctx = this.ctx;
    const { W, par, bandTop, bandH } = g;
    const housing = ctx.createLinearGradient(0, bandTop, 0, bandTop + bandH);
    housing.addColorStop(0, '#070E1C'); housing.addColorStop(1, '#03070F');
    ctx.fillStyle = housing; ctx.fillRect(0, bandTop, W, bandH);

    const strip = this.ensureRibbonStrip(bandH);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, bandTop, W, bandH); ctx.clip();
    const start = -((((ts * 0.045 + par) % strip.w) + strip.w) % strip.w);
    for (let x = start; x < W; x += strip.w) ctx.drawImage(strip.canvas, x, bandTop, strip.w, bandH);
    ctx.fillStyle = this.ledPattern(); ctx.fillRect(0, bandTop, W, bandH);
    const gloss = ctx.createLinearGradient(0, bandTop, 0, bandTop + bandH);
    gloss.addColorStop(0, 'rgba(255,255,255,0.08)'); gloss.addColorStop(0.5, 'rgba(255,255,255,0)');
    ctx.fillStyle = gloss; ctx.fillRect(0, bandTop, W, bandH);
    ctx.restore();

    ctx.fillStyle = 'rgba(46,229,157,0.85)';
    ctx.fillRect(0, bandTop, W, 1.2);
    ctx.fillRect(0, bandTop + bandH - 1.2, W, 1.2);
    const spill = ctx.createLinearGradient(0, bandTop + bandH, 0, bandTop + bandH + 18);
    spill.addColorStop(0, 'rgba(46,229,157,0.14)'); spill.addColorStop(1, 'rgba(46,229,157,0)');
    ctx.fillStyle = spill; ctx.fillRect(0, bandTop + bandH, W, 18);
  }

  // Pitch-side LED ad boards that rotate their content every few seconds.
  // Board contents follow the unwrapped drift so they never jump when the
  // stand's tile shift wraps around.
  drawHoarding(g, ts) {
    const ctx = this.ctx;
    const { W, par, lowerBottom: y, hoardH } = g;
    const BOARDS = [
      { text: 'BIKE IT', fg: '#2EE59D', bg0: '#0C3A2C', bg1: '#051A14' },
      { text: '8× BULLSEYE', fg: '#FFD23F', bg0: '#33290A', bg1: '#161104' },
      { text: 'PROVABLY FAIR', fg: '#5CD6FF', bg0: '#0F2244', bg1: '#070F22' },
      { text: 'SEND IT', fg: '#FF6B7F', bg0: '#3A1220', bg1: '#18070D' },
    ];
    const cycle = Math.floor(ts / 4200);
    const fade = cycle === 0 ? 1 : Math.min(1, (ts % 4200) / 260);
    const bw = W / 10;
    const first = Math.floor(par / bw), offset = par - first * bw;
    ctx.font = `italic 800 ${Math.round(hoardH * 0.56)}px ${FONT_NUM}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let k = 0; k <= 10; k++) {
      const x = k * bw - offset;
      const n = BOARDS.length, b = BOARDS[(((first + k + cycle) % n) + n) % n];
      const bg = ctx.createLinearGradient(0, y, 0, y + hoardH);
      bg.addColorStop(0, b.bg0); bg.addColorStop(1, b.bg1);
      ctx.fillStyle = bg; ctx.fillRect(x + 1, y, bw - 2, hoardH);
      ctx.fillStyle = b.fg;
      ctx.globalAlpha = 0.85; ctx.fillRect(x + 1, y, bw - 2, 1.5);
      ctx.globalAlpha = fade;
      const tw = ctx.measureText(b.text).width, maxW = bw * 0.84;
      if (tw > maxW) {
        ctx.save(); ctx.translate(x + bw / 2, y + hoardH / 2 + 1); ctx.scale(maxW / tw, 1);
        ctx.fillText(b.text, 0, 0); ctx.restore();
      } else {
        ctx.fillText(b.text, x + bw / 2, y + hoardH / 2 + 1);
      }
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = this.ledPattern(); ctx.fillRect(0, y, W, hoardH);
    const gloss = ctx.createLinearGradient(0, y, 0, y + hoardH);
    gloss.addColorStop(0, 'rgba(255,255,255,0.10)'); gloss.addColorStop(0.45, 'rgba(255,255,255,0)');
    ctx.fillStyle = gloss; ctx.fillRect(0, y, W, hoardH);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  floodlightSpots(g) {
    const py = g.standTop - g.roofH - g.trussH - g.H * 0.06;
    const pw = Math.max(28, g.W * 0.03), ph = Math.max(12, g.H * 0.02);
    const spots = [];
    [0.1, 0.32, 0.68, 0.9].forEach((f, i) => {
      this.wrapXs(g, f, g.W * 0.25).forEach((px) => spots.push({ px, py, pw, ph, i }));
    });
    return spots;
  }

  // Additive light cones angled in toward the track. After an accurate
  // landing (`cheer`) they sway and tint teal/gold for a quick light show.
  drawFloodlightBeams(g, ts) {
    const ctx = this.ctx;
    const { W, gY } = g;
    const show = this.cheer;
    const mix = Math.min(1, show * 1.4);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.floodlightSpots(g).forEach(({ px, py, pw, i }) => {
      const sway = show > 0.02 ? Math.sin(ts * 0.004 + i * 1.7) * show * W * 0.12 : 0;
      const tx = px + (W / 2 - px) * 0.3 + sway;
      const spread = W * 0.1;
      const party = i % 2 ? [255, 210, 63] : [46, 229, 157];
      const c = [255, 244, 214].map((v, k) => Math.round(v + (party[k] - v) * mix)).join(',');
      const beam = ctx.createLinearGradient(px, py, tx, gY);
      beam.addColorStop(0, `rgba(${c},0.2)`); beam.addColorStop(0.55, `rgba(${c},0.06)`); beam.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(px - pw * 0.4, py); ctx.lineTo(px + pw * 0.4, py);
      ctx.lineTo(tx + spread, gY); ctx.lineTo(tx - spread, gY);
      ctx.closePath(); ctx.fill();

      ctx.save();
      ctx.translate(tx, gY); ctx.scale(1, 0.22);
      const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, spread * 1.2);
      pool.addColorStop(0, `rgba(${c},0.14)`); pool.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = pool; ctx.beginPath(); ctx.arc(0, 0, spread * 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    });
    ctx.restore();
  }

  // Lattice masts on the roof topped with LED floodlight banks.
  drawFloodlightFixtures(g) {
    const ctx = this.ctx;
    const mastBase = g.standTop - g.roofH - g.trussH;
    this.floodlightSpots(g).forEach(({ px, py, pw, ph }) => {
      const mastTop = py + ph / 2;
      ctx.strokeStyle = '#22314C'; ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(px - 3, mastBase); ctx.lineTo(px - 3, mastTop);
      ctx.moveTo(px + 3, mastBase); ctx.lineTo(px + 3, mastTop);
      for (let yy = mastBase, k = 0; yy - 6 > mastTop; yy -= 6, k++) {
        ctx.moveTo(px + (k % 2 ? 3 : -3), yy); ctx.lineTo(px + (k % 2 ? -3 : 3), yy - 6);
      }
      ctx.stroke();

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const bloom = ctx.createRadialGradient(px, py, 0, px, py, pw * 1.8);
      bloom.addColorStop(0, 'rgba(255,244,214,0.45)'); bloom.addColorStop(0.4, 'rgba(255,236,190,0.12)'); bloom.addColorStop(1, 'rgba(255,236,190,0)');
      ctx.fillStyle = bloom; ctx.fillRect(px - pw * 1.8, py - pw * 1.8, pw * 3.6, pw * 3.6);
      const streak = ctx.createLinearGradient(px - pw * 2.4, 0, px + pw * 2.4, 0);
      streak.addColorStop(0, 'rgba(180,220,255,0)'); streak.addColorStop(0.5, 'rgba(220,240,255,0.55)'); streak.addColorStop(1, 'rgba(180,220,255,0)');
      ctx.fillStyle = streak; ctx.fillRect(px - pw * 2.4, py - 0.75, pw * 4.8, 1.5);
      ctx.restore();

      ctx.fillStyle = '#0B111D';
      ctx.beginPath(); ctx.roundRect(px - pw / 2 - 2, py - ph / 2 - 2, pw + 4, ph + 4, 3); ctx.fill();
      const cols = 4, rows = 2, cw = pw / cols, chh = ph / rows;
      ctx.fillStyle = '#FFF7E2';
      ctx.beginPath();
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        ctx.roundRect(px - pw / 2 + c * cw + 1, py - ph / 2 + r * chh + 1, cw - 2, chh - 2, 1.5);
      }
      ctx.fill();
    });
  }

  // The Mexican wave's light: a soft band and popping camera flashes that
  // sweep the stands in step with the fans standing up in the crowd layer —
  // drawn every frame, so it glides smoothly even between crowd repaints.
  drawWaveGlow(g, ts) {
    const ctx = this.ctx;
    const { W, standTop, lowerBottom, shift } = g;
    const wx = ((ts * 0.00008) % 1) * W - shift, bw = W * 0.045;
    const flashSeed = Math.floor(ts / 90);
    const rnd = (n) => { const v = Math.sin(n * 12.9898) * 43758.5453; return v - Math.floor(v); };
    const sprite = this.glowSprite();
    const flash = (fx, fy, r) => ctx.drawImage(sprite, fx - r, fy - r, r * 2, r * 2);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    [wx - W, wx, wx + W].forEach((x) => {
      if (x < -bw * 2 || x > W + bw * 2) return;
      const band = ctx.createLinearGradient(x - bw, 0, x + bw, 0);
      band.addColorStop(0, 'rgba(120,255,200,0)'); band.addColorStop(0.5, 'rgba(170,255,225,0.13)'); band.addColorStop(1, 'rgba(120,255,200,0)');
      ctx.fillStyle = band; ctx.fillRect(x - bw, standTop, bw * 2, lowerBottom - standTop);
      for (let i = 0; i < (this.lowPower ? 4 : 10); i++) {
        flash(x + (rnd(flashSeed * 13 + i) - 0.5) * bw * 1.4, standTop + rnd(flashSeed * 29 + i * 3) * (lowerBottom - standTop), 5);
      }
    });
    // Phone flashes popping anywhere in the stands — a flurry of them right
    // after a landing
    const shots = (this.lowPower ? 1 : 3) + Math.round(this.cheer * (this.lowPower ? 10 : 26)), seed = Math.floor(ts / 70);
    for (let i = 0; i < shots; i++) {
      if (rnd(seed * 7 + i * 13) > 0.55) continue;
      flash(rnd(seed * 11 + i * 3) * W, standTop + rnd(seed * 17 + i * 5) * (lowerBottom - standTop), 3 + rnd(seed + i) * 2);
    }
    ctx.restore();
  }

  // A soft white glow baked once and stamped with drawImage — far cheaper
  // than building a radial gradient for every camera flash, every frame.
  glowSprite() {
    if (!this._glow) {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const g = c.getContext('2d');
      const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.35, 'rgba(230,244,255,0.4)'); gr.addColorStop(1, 'rgba(220,240,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
      this._glow = c;
    }
    return this._glow;
  }

  // Flame cannons on top of the pitch wall. After any winning landing they
  // fire in two bursts — taller the better the call.
  drawPyro(g, ts) {
    const ctx = this.ctx;
    const base = g.lowerBottom, FRACS = [0.07, 0.21, 0.36, 0.64, 0.79, 0.93];
    const q = this.landCheer || 0, t = this.crashFrames;
    const firing = q > 0 && (this.phase === 'crashing' || this.phase === 'done');
    const burst = (from, to) => (t > from && t < to ? Math.sin(((t - from) / (to - from)) * Math.PI) : 0);
    const k = firing ? Math.max(burst(2, 36), burst(40, 76) * 0.9) : 0;
    FRACS.forEach((f, i) => {
      this.wrapXs(g, f, 80).forEach((x) => {
        if (k > 0.01) {
          const flick = 0.85 + Math.sin(ts * 0.05 + i * 2.1) * 0.15;
          const h = (44 + q * 80) * k * flick, w = 9 + q * 6;
          ctx.save(); ctx.globalCompositeOperation = 'lighter';
          const gl = ctx.createRadialGradient(x, base - h * 0.4, 0, x, base - h * 0.4, h);
          gl.addColorStop(0, `rgba(255,150,60,${0.35 * k})`); gl.addColorStop(1, 'rgba(255,90,30,0)');
          ctx.fillStyle = gl; ctx.fillRect(x - h, base - h * 1.4, h * 2, h * 1.4 + 12);
          [[1, '255,96,32', 0.78], [0.62, '255,182,64', 0.88], [0.3, '255,250,222', 0.96]].forEach(([s, rgb, a]) => {
            const fh = h * (0.68 + s * 0.32);
            const fg = ctx.createLinearGradient(0, base, 0, base - fh);
            fg.addColorStop(0, `rgba(${rgb},${a * k})`); fg.addColorStop(1, `rgba(${rgb},0)`);
            ctx.fillStyle = fg;
            ctx.beginPath();
            ctx.moveTo(x - w * s * 0.5, base);
            ctx.quadraticCurveTo(x - w * s * 1.15, base - fh * 0.5, x + Math.sin(ts * 0.03 + i) * w * 0.3, base - fh);
            ctx.quadraticCurveTo(x + w * s * 1.15, base - fh * 0.5, x + w * s * 0.5, base);
            ctx.closePath(); ctx.fill();
          });
          ctx.restore();
        }
        ctx.fillStyle = '#0B111D';
        ctx.beginPath(); ctx.roundRect(x - 6, base - 5, 12, 6, 1.5); ctx.fill();
        ctx.fillStyle = k > 0.01 ? '#FFB347' : '#3A4458';
        ctx.fillRect(x - 3.5, base - 5.5, 7, 1.5);
      });
    });
  }

  // Fireworks over the roof after a Great Call or a Bullseye: shells climb
  // and burst in turn into rings of stars that droop and glitter out.
  drawFireworks(g) {
    const q = this.landCheer || 0;
    if (q <= 0.4 || (this.phase !== 'crashing' && this.phase !== 'done')) return;
    const ctx = this.ctx, { W, H, standTop } = g, t = this.crashFrames;
    const COLORS = ['46,229,157', '255,210,63', '255,107,127', '92,214,255', '244,247,251'];
    const shells = q > 0.7 ? 5 : 3;
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
    for (let s = 0; s < shells; s++) {
      const rnd = (k) => { const v = Math.sin((this.roundNum * 3.1 + s * 17 + k) * 12.9898) * 43758.5453; return v - Math.floor(v); };
      const age = t - (3 + s * 12);
      if (age < 0) continue;
      const cx = W * (0.14 + rnd(1) * 0.72), cy = H * (0.07 + rnd(2) * 0.13);
      if (age < 9) {
        const p = age / 9, y = standTop - (standTop - cy) * (1 - (1 - p) * (1 - p));
        ctx.strokeStyle = 'rgba(255,224,170,0.85)'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(cx, y + 18); ctx.lineTo(cx, y); ctx.stroke();
        continue;
      }
      const a = age - 9, life = 1 - a / 60;
      if (life <= 0) continue;
      const col = COLORS[Math.floor(rnd(3) * COLORS.length)], col2 = COLORS[Math.floor(rnd(4) * COLORS.length)];
      const R = H * (0.09 + rnd(5) * 0.04) * (1 - Math.exp(-a / 8));
      if (a < 5) {
        const fl = ctx.createRadialGradient(cx, cy, 0, cx, cy, 34);
        fl.addColorStop(0, `rgba(255,255,240,${0.8 * (1 - a / 5)})`); fl.addColorStop(1, 'rgba(255,255,240,0)');
        ctx.fillStyle = fl; ctx.fillRect(cx - 34, cy - 34, 68, 68);
      }
      const droop = a * a * 0.014;
      for (let i = 0; i < 34; i++) {
        const ang = (i / 34) * Math.PI * 2 + rnd(10 + i) * 0.1, sp = 0.82 + rnd(60 + i) * 0.3;
        const x1 = cx + Math.cos(ang) * R * sp, y1 = cy + Math.sin(ang) * R * sp + droop;
        const x0 = cx + Math.cos(ang) * R * sp * 0.8, y0 = cy + Math.sin(ang) * R * sp * 0.8 + droop * 0.75;
        const tw = life < 0.5 ? (Math.sin(a * 1.7 + i * 2.3) > 0 ? 1 : 0.25) : 1;
        ctx.strokeStyle = `rgba(${i % 2 ? col : col2},${life * 0.9 * tw})`; ctx.lineWidth = 1.7;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.fillStyle = `rgba(255,252,236,${life * tw})`;
        ctx.beginPath(); ctx.arc(x1, y1, 1.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  // ── Stadium: a two-tier arena bowl viewed head-on ────────────────────────
  drawStadium(W, H, gY, ts) {
    const ctx = this.ctx;
    const g = this.standGeom(W, H, gY);
    const { standTop, roofH, lowerBottom } = g;

    // Arena light glowing up into the night sky behind the roof
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const skyR = W * 0.6;
    const haze = ctx.createRadialGradient(W / 2, standTop, 0, W / 2, standTop, skyR);
    haze.addColorStop(0, 'rgba(90,150,255,0.14)'); haze.addColorStop(0.5, 'rgba(60,110,230,0.05)'); haze.addColorStop(1, 'rgba(40,80,200,0)');
    ctx.fillStyle = haze;
    ctx.fillRect(W / 2 - skyR, standTop - skyR, skyR * 2, skyR);
    ctx.restore();
    this.drawFireworks(g);

    this.ensureCrowdLayer(g);
    const ct = this._crowdTop, ch = this._crowdH;
    ctx.drawImage(this._crowdCanvas, -g.shift, ct, W, ch);
    if (g.shift > 0.5) ctx.drawImage(this._crowdCanvas, W - g.shift, ct, W, ch);
    this.drawWaveFans(g, ts);
    this.drawWaveGlow(g, ts);

    // Cheer flash — a brief warm wash over the crowd right after an accurate landing
    if (this.cheer > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = this.cheer * 0.3;
      const flash = ctx.createRadialGradient(W / 2, lowerBottom, 0, W / 2, lowerBottom, W * 0.7);
      flash.addColorStop(0, '#fff3c0'); flash.addColorStop(1, 'rgba(255,220,0,0)');
      ctx.fillStyle = flash;
      ctx.fillRect(0, standTop, W, lowerBottom - standTop);
      ctx.restore();
    }

    this.drawLedRibbon(g, ts);
    this.drawHoarding(g, ts);
    this.drawPyro(g, ts);
    this.drawFloodlightBeams(g, ts);
    this.wrapXs(g, 0.5, W * 0.15).forEach((cx) => this.drawJumbotron(cx, standTop - roofH, W * 0.22, H * 0.085, ts));
    this.drawFloodlightFixtures(g);

    // Soft shadow the hoarding casts onto the track
    const sh = ctx.createLinearGradient(0, gY, 0, gY + 10);
    sh.addColorStop(0, 'rgba(0,0,0,0.35)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sh; ctx.fillRect(0, gY, W, 10);
  }

  // Branded scoreboard screen straddling the roofline
  drawJumbotron(cx, roofTop, w, h, ts) {
    const ctx = this.ctx;
    const x = cx - w / 2, y = roofTop - h * 0.62;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const spill = ctx.createRadialGradient(cx, y + h / 2, 0, cx, y + h / 2, w * 0.7);
    spill.addColorStop(0, 'rgba(46,229,157,0.14)'); spill.addColorStop(1, 'rgba(46,229,157,0)');
    ctx.fillStyle = spill; ctx.fillRect(cx - w * 0.7, y + h / 2 - w * 0.7, w * 1.4, w * 1.4);
    ctx.restore();

    ctx.fillStyle = '#080D17';
    ctx.beginPath(); ctx.roundRect(x - 5, y - 5, w + 10, h + 10, 9); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1; ctx.stroke();

    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 5); ctx.clip();
    const screen = ctx.createLinearGradient(0, y, 0, y + h);
    screen.addColorStop(0, '#08201B'); screen.addColorStop(1, '#030C0B');
    ctx.fillStyle = screen; ctx.fillRect(x, y, w, h);

    ctx.font = `italic 800 ${Math.round(h * 0.46)}px ${FONT_NUM}`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const wa = ctx.measureText('BIKE ').width, wb = ctx.measureText('IT').width;
    const tx = cx - (wa + wb) / 2, ty = y + h * 0.4;
    ctx.fillStyle = '#F4F7FB'; ctx.fillText('BIKE ', tx, ty);
    ctx.fillStyle = '#2EE59D'; ctx.fillText('IT', tx + wa, ty);

    const status = this.jumbotronStatus(ts);
    ctx.font = `700 ${Math.round(h * 0.2)}px ${FONT_NUM}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = status.color;
    ctx.fillText(status.text, cx, y + h * 0.78);

    ctx.fillStyle = this.ledPattern(); ctx.fillRect(x, y, w, h);
    const gloss = ctx.createLinearGradient(0, y, 0, y + h);
    gloss.addColorStop(0, 'rgba(255,255,255,0.09)'); gloss.addColorStop(0.5, 'rgba(255,255,255,0)');
    ctx.fillStyle = gloss; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(x, y + ((ts * 0.05) % h), w, 2);
    ctx.restore();

    ctx.fillStyle = 'rgba(46,229,157,0.7)';
    ctx.fillRect(x + w * 0.3, y + h + 3, w * 0.4, 1.5);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  jumbotronStatus(ts) {
    const p = this.phase;
    if (p === 'flying' && this.burnT != null) return { text: 'DRAGON ATTACK!', color: '#FF6A2A' };
    if (p === 'approach' || p === 'ramp' || p === 'flying') {
      const dot = Math.floor(ts / 450) % 2 === 0 ? '●' : '○';
      const dist = p === 'flying' ? `  ${this.toMeters(this.bx, this.getRamp())}M` : '';
      return { text: `${dot} LIVE${dist}`, color: '#FF5C7A' };
    }
    if (p === 'crashing' || p === 'done') {
      return this.landedGood ? { text: 'NICE LANDING!', color: '#2EE59D' } : { text: 'WIPEOUT!', color: '#FF8A1F' };
    }
    return { text: 'PLACE YOUR BETS', color: '#FFD23F' };
  }

  // ── Ramp (world→screen via camX): a steel stunt kicker in the bike's lane,
  // dropped to the tyre contact plane so the wheels actually ride it. A
  // thick curved deck with grip slats and an LED edge strip sits on an open
  // steel truss — posts, cross-braces and a box tower under the lip — with
  // a branded banner slung between the posts, a hazard-striped base rail and
  // a polished gold launch lip. It never changes shape between resizes, so
  // it's baked once into its own layer and stamped each frame at its
  // scrolled position.
  drawRamp(r) {
    const key = `${this.cw}x${this.ch}@${this.dpr}:${r.rx}:${r.P2.x}:${r.gY}`;
    if (!this._rampLayer || this._rampLayer.key !== key) this._rampLayer = this.bakeRamp(r, key);
    const L = this._rampLayer;
    this.ctx.drawImage(L.canvas, L.x0 - this.camX, L.y0, L.w, L.h);
  }

  bakeRamp(r, key) {
    const pad = 40;
    const x0 = r.rx - pad, y0 = r.P2.y + RAMP_DROP - pad;
    const w = Math.ceil(r.P2.x + pad - x0), h = Math.ceil(r.gY + RAMP_DROP + pad - y0);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * this.dpr); canvas.height = Math.round(h * this.dpr);
    const bctx = canvas.getContext('2d');
    bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, -y0 * this.dpr);
    const realCtx = this.ctx, realCam = this.camX;
    this.ctx = bctx; this.camX = x0;
    try { this.paintRamp(r); } finally { this.ctx = realCtx; this.camX = realCam; }
    return { key, canvas, x0, y0, w, h };
  }

  paintRamp(r) {
    const ctx = this.ctx;
    const sx = (x) => x - this.camX;
    const P0 = { x: sx(r.P0.x), y: r.P0.y + RAMP_DROP };
    const P1 = { x: sx(r.P1.x), y: r.P1.y + RAMP_DROP };
    const P2 = { x: sx(r.P2.x), y: r.P2.y + RAMP_DROP };
    const x0 = sx(r.rx), gY = r.gY + RAMP_DROP;
    const rampH = gY - P2.y, rampW = P2.x - x0;
    const at = (t) => bp(P0, P1, P2, t);
    const thick = Math.max(5, rampH * 0.06), railH = Math.max(5, rampH * 0.07);
    const towerW = Math.max(9, rampW * 0.11);

    ctx.save();
    ctx.translate((x0 + P2.x) / 2, gY + 2); ctx.scale(1, 0.18);
    const shR = rampW * 0.75;
    const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, shR);
    shadow.addColorStop(0, 'rgba(0,0,0,0.5)'); shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow; ctx.beginPath(); ctx.arc(0, 0, shR, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Steel tube: dark outline, steel body and a thin highlight along one side
    ctx.lineCap = 'round';
    const tube = (ax, ay, bx, by, w) => {
      const L = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / L, ny = (bx - ax) / L;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.strokeStyle = '#070C16'; ctx.lineWidth = w + 1.8; ctx.stroke();
      ctx.strokeStyle = '#34425F'; ctx.lineWidth = w; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ax - nx * w * 0.22, ay - ny * w * 0.22); ctx.lineTo(bx - nx * w * 0.22, by - ny * w * 0.22);
      ctx.strokeStyle = 'rgba(196,214,244,0.42)'; ctx.lineWidth = Math.max(0.6, w * 0.28); ctx.stroke();
    };
    const tw = Math.max(1.6, rampW * 0.012);

    // Box tower under the lip, with X-bracing
    const tL = P2.x - towerW, tR = P2.x - tw * 0.6, tTop = P2.y + thick * 0.8, tBot = gY - railH;
    const bays = Math.max(2, Math.round((tBot - tTop) / (towerW * 1.25)));
    for (let b = 0; b < bays; b++) {
      const y0 = tTop + ((tBot - tTop) / bays) * b, y1 = tTop + ((tBot - tTop) / bays) * (b + 1);
      tube(tL, y0, tR, y1, tw * 0.75); tube(tR, y0, tL, y1, tw * 0.75);
    }
    tube(tL, tTop, tL, tBot, tw); tube(tR, tTop, tR, tBot, tw);

    // Posts from the deck to the base rail, braced in alternating diagonals
    const posts = [0.34, 0.56, 0.78].map((t) => { const p = at(t); return { x: p.x, top: p.y + thick * 0.9 }; });
    posts.push({ x: tL, top: tTop });
    for (let i = 0; i < posts.length - 1; i++) {
      const a = posts[i], b = posts[i + 1];
      if (i % 2) tube(a.x, a.top, b.x, tBot, tw * 0.75); else tube(a.x, tBot, b.x, b.top, tw * 0.75);
    }
    posts.slice(0, 3).forEach((p) => tube(p.x, p.top, p.x, tBot, tw));

    // Branded banner slung between the middle post and the tower
    const bx0 = posts[1].x + tw, bx1 = tL - tw;
    const bh = Math.min(rampH * 0.3, tBot - posts[1].top - 6), by1 = tBot - 2, by0 = by1 - bh;
    if (bh > 10 && bx1 - bx0 > 24) {
      const bg = ctx.createLinearGradient(0, by0, 0, by1);
      bg.addColorStop(0, '#132443'); bg.addColorStop(1, '#0A1428');
      ctx.fillStyle = bg; ctx.fillRect(bx0, by0, bx1 - bx0, bh);
      ctx.fillStyle = '#2EE59D'; ctx.fillRect(bx0, by0, bx1 - bx0, 1.5); ctx.fillRect(bx0, by1 - 1.5, bx1 - bx0, 1.5);
      ctx.font = `italic 800 ${Math.round(bh * 0.5)}px ${FONT_NUM}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const label = 'SEND IT', tw2 = ctx.measureText(label).width, maxW = (bx1 - bx0) * 0.84;
      ctx.save(); ctx.translate((bx0 + bx1) / 2, (by0 + by1) / 2 + 1);
      if (tw2 > maxW) ctx.scale(maxW / tw2, 1);
      ctx.fillStyle = '#F4F7FB'; ctx.fillText(label, 0, 0);
      ctx.restore();
      ctx.fillStyle = '#E8EEF6';
      [[bx0 + 3, by0 + 3], [bx1 - 3, by0 + 3], [bx0 + 3, by1 - 3], [bx1 - 3, by1 - 3]].forEach(([gx, gy]) => { ctx.beginPath(); ctx.arc(gx, gy, 1, 0, Math.PI * 2); ctx.fill(); });
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }

    // Base rail with hazard stripes
    const rx0 = posts[0].x - tw;
    ctx.save();
    ctx.beginPath(); ctx.rect(rx0, gY - railH, P2.x - rx0, railH); ctx.clip();
    ctx.fillStyle = '#FFD23F'; ctx.fillRect(rx0, gY - railH, P2.x - rx0, railH);
    ctx.fillStyle = '#121826'; ctx.beginPath();
    for (let xx = rx0 - railH; xx < P2.x; xx += railH * 2) {
      ctx.moveTo(xx, gY); ctx.lineTo(xx + railH, gY - railH); ctx.lineTo(xx + railH * 2, gY - railH); ctx.lineTo(xx + railH, gY); ctx.closePath();
    }
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(rx0, gY - railH, P2.x - rx0, 1);

    // Deck: a thick curved board, its top face lit
    const deckBand = () => {
      ctx.beginPath();
      ctx.moveTo(P0.x, P0.y);
      ctx.quadraticCurveTo(P1.x, P1.y, P2.x, P2.y);
      ctx.lineTo(P2.x, P2.y + thick);
      ctx.quadraticCurveTo(P1.x + thick * 0.4, P1.y + thick, P0.x + thick * 3, P0.y);
      ctx.closePath();
    };
    const dg = ctx.createLinearGradient(0, P2.y, 0, gY);
    dg.addColorStop(0, '#4A5E86'); dg.addColorStop(0.5, '#2E3D5E'); dg.addColorStop(1, '#1E2A44');
    ctx.fillStyle = dg; deckBand(); ctx.fill();
    ctx.strokeStyle = '#070C16'; ctx.lineWidth = 1.2; deckBand(); ctx.stroke();
    // Grip slats across the deck
    ctx.lineCap = 'butt';
    const steps = Math.max(10, Math.round(rampW / 9));
    ctx.beginPath();
    for (let i = 1; i < steps; i++) {
      const t = i / steps, p = at(t), tn = bt(P0, P1, P2, t), L = Math.hypot(tn.x, tn.y);
      const nx = -tn.y / L, ny = tn.x / L, d = thick * Math.min(1, t * 3) * 0.85;
      ctx.moveTo(p.x + nx * 0.6, p.y + ny * 0.6); ctx.lineTo(p.x + nx * d, p.y + ny * d);
    }
    ctx.strokeStyle = 'rgba(6,10,20,0.45)'; ctx.lineWidth = 1; ctx.stroke();
    // LED strip along the deck's edge: a soft wide glow under a bright core
    const strip = () => { ctx.beginPath(); ctx.moveTo(P0.x + thick * 1.6, P0.y - 0.5); ctx.quadraticCurveTo(P1.x + thick * 0.2, P1.y + thick * 0.55, P2.x - 1, P2.y + thick * 0.55); };
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(46,229,157,0.22)'; ctx.lineWidth = 6; strip(); ctx.stroke();
    ctx.strokeStyle = '#7CFFCB'; ctx.lineWidth = 1.4; strip(); ctx.stroke();
    // Bright top edge where the floodlights catch the running surface
    ctx.strokeStyle = 'rgba(226,238,255,0.6)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(P0.x, P0.y); ctx.quadraticCurveTo(P1.x, P1.y, P2.x, P2.y); ctx.stroke();

    // Marker lights along the deck
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let t = 0.12; t < 0.97; t += 0.11) {
      const p = at(t);
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 5);
      glow.addColorStop(0, 'rgba(220,255,240,0.85)'); glow.addColorStop(1, 'rgba(46,229,157,0)');
      ctx.fillStyle = glow; ctx.fillRect(p.x - 5, p.y - 5, 10, 10);
    }
    ctx.restore();

    // Polished gold launch lip
    const tn = bt(P0, P1, P2, 1), len = Math.hypot(tn.x, tn.y), ux = tn.x / len, uy = tn.y / len;
    const lip = Math.max(10, r.rw * 0.13);
    const lx = P2.x - ux * lip, ly = P2.y - uy * lip;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,210,63,0.3)'; ctx.lineWidth = 9;
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(P2.x, P2.y); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#B88A1E'; ctx.lineWidth = 4.2;
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(P2.x, P2.y); ctx.stroke();
    ctx.strokeStyle = '#FFD86A'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(lx, ly - 0.6); ctx.lineTo(P2.x, P2.y - 0.6); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(lx + ux * lip * 0.2, ly + uy * lip * 0.2 - 1); ctx.lineTo(lx + ux * lip * 0.6, ly + uy * lip * 0.6 - 1); ctx.stroke();
    ctx.lineCap = 'butt';
  }

  // ── Trail ─────────────────────────────────────────────────────────────────
  // The glowing trail behind the bike — teal in flight, flame-orange while
  // the dragon has him alight, red after the crash. Drawn as a few batched
  // chunks (older = fainter and thinner), each a soft wide glow under a
  // bright core, rather than a shadow blur on every segment every frame.
  drawTrail(crash) {
    const ctx = this.ctx, n = this.trail.length, chunks = 8;
    if (n < 2) return;
    const rgb = crash ? '255,60,50' : this.burnT != null ? '255,124,40' : '0,220,160';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let c = 0; c < chunks; c++) {
      const i0 = Math.floor((c / chunks) * (n - 1)), i1 = Math.floor(((c + 1) / chunks) * (n - 1));
      if (i1 <= i0) continue;
      const a = (c + 1) / chunks;
      ctx.beginPath(); ctx.moveTo(this.trail[i0].x - this.camX, this.trail[i0].y);
      for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(this.trail[i].x - this.camX, this.trail[i].y);
      ctx.strokeStyle = `rgba(${rgb},${a * 0.13})`; ctx.lineWidth = a * 9; ctx.stroke();
      ctx.strokeStyle = `rgba(${rgb},${a * (crash ? 0.5 : 0.42)})`; ctx.lineWidth = a * 3.5; ctx.stroke();
    }
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
  }

  // ── Wreckage: the "biker graveyard" ─────────────────────────────────────────
  // Each `this.wreckItems` entry (built once in buildWrecks) is a single,
  // independent piece of debris. Only its meter distance is stored — position
  // is re-derived from the current ramp each frame, so it stays put correctly
  // across resizes without living in stored world coordinates.
  static _wreckGroundBump(wx) { return Math.sin(wx * 0.11) * 2 + Math.sin(wx * 0.068) * 3 + Math.sin(wx * 0.23) * 1; }

  // Where a wreck item sits: in the pit below the groomed track, further down
  // (and bigger) the closer it is to the camera.
  wreckPlacement(it, H, r) {
    const wx = it.d >= 0 ? r.P2.x + it.d / 0.22 : r.rx + it.d;
    const pitTop = r.gY + H * TRACK_FRAC;
    const y = pitTop + (H - pitTop) * it.depthT + BikeGame._wreckGroundBump(wx) * (0.6 + it.depthT);
    return { wx, y, scale: it.scale * (0.85 + it.depthT * 0.45) * 1.45 };
  }

  // Every wreck item's screen position is `worldX - camX` — a pure 1:1
  // scroll, with no per-item animation except the 'brokenBiker' smoke. So
  // instead of iterating and redrawing every debris shape from scratch each
  // frame, the whole (static) field is baked once into one wide offscreen
  // canvas in world space (see ensureWreckLayer) and blitted with a single
  // drawImage each frame — exact same per-frame position, a fraction of the
  // draw calls. Only the handful of smoking 'brokenBiker' pieces still need
  // a live per-frame redraw (of just their smoke, not the whole shape).
  ensureWreckLayer(W, H, r) {
    // Keyed on the geometry it depends on (not on the ramp object, which is
    // recreated at times) so the wide baked layer is only rebuilt on resize.
    const key = `${W}x${H}:${r.P2.x}:${r.rx}:${r.gY}`;
    if (this._wreckCanvas && this._wreckKey === key) return;
    this._wreckKey = key;

    let minX = Infinity, maxX = -Infinity;
    this.wreckItems.forEach(it => {
      const wx = (it.d >= 0 ? r.P2.x + it.d / 0.22 : r.rx + it.d) + it.lat;
      minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
    });
    if (!isFinite(minX)) { minX = 0; maxX = 0; }
    const margin = 120;
    const x0 = minX - margin, x1 = maxX + margin;
    const y0 = r.gY - 60, y1 = H;
    const cw = Math.max(1, Math.ceil(x1 - x0)), ch = Math.max(1, Math.ceil(y1 - y0));

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cw * this.dpr);
    canvas.height = Math.round(ch * this.dpr);
    const bctx = canvas.getContext('2d');
    bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const realCtx = this.ctx;
    this.ctx = bctx;
    this.wreckItems.forEach((it, i) => {
      const { wx, y, scale } = this.wreckPlacement(it, H, r);
      // Baked with ts=0 and skipSmoke=true — 'brokenBiker' smoke is drawn
      // live every frame instead (see drawWrecks) since it genuinely animates.
      this.drawDebrisPiece(wx + it.lat - x0, y - y0, it.kind, i, 0, scale, it.flip, it.rot, it.phase, true);
    });
    this.ctx = realCtx;

    this._wreckCanvas = canvas;
    this._wreckX0 = x0; this._wreckY0 = y0; this._wreckCW = cw; this._wreckCH = ch;
  }

  drawWrecks(W, H, ts, r) {
    this.ensureWreckLayer(W, H, r);
    const ctx = this.ctx;
    // Whole layer scaled into CSS px (its backing store is DPR-sized)
    ctx.drawImage(this._wreckCanvas, this._wreckX0 - this.camX, this._wreckY0, this._wreckCW, this._wreckCH);

    // Live smoke overlay for the (few) smoking 'brokenBiker' wrecks — the
    // only part of the wreckage field that actually animates over time.
    this.wreckItems.forEach((it, i) => {
      if (it.kind !== 'brokenBiker') return;
      const { wx, y, scale } = this.wreckPlacement(it, H, r);
      const sx = wx - this.camX + it.lat;
      if (sx < -90 || sx > W + 90) return;
      this.drawWreckSmoke(sx + 8 * it.flip, y - 12 * scale, i + it.phase, ts);
    });
  }

  // A long bone: a tapered shaft between two bulbous, gradient-shaded ends
  // (the knobby epiphyses of a real femur), laid over a slightly larger dark
  // silhouette so it reads as one clean outlined shape at any size.
  drawBone(x1, y1, x2, y2, r) {
    const ctx = this.ctx;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const half = len / 2, shaftR = r * 0.6, capR = r * 1.4;
    ctx.save();
    ctx.translate((x1 + x2) / 2, (y1 + y2) / 2);
    ctx.rotate(Math.atan2(y2 - y1, x2 - x1));
    const shape = (pad) => {
      ctx.beginPath();
      ctx.moveTo(-half + capR * 0.55, -shaftR * 0.68 - pad);
      ctx.quadraticCurveTo(0, -shaftR - pad, half - capR * 0.55, -shaftR * 0.68 - pad);
      ctx.lineTo(half - capR * 0.55, shaftR * 0.68 + pad);
      ctx.quadraticCurveTo(0, shaftR + pad, -half + capR * 0.55, shaftR * 0.68 + pad);
      ctx.closePath();
      [-half, half].forEach((ex) => { ctx.moveTo(ex + capR * 0.68 + pad, 0); ctx.ellipse(ex, 0, capR * 0.68 + pad, capR + pad, 0, 0, Math.PI * 2); });
    };
    ctx.fillStyle = 'rgba(58,44,22,0.62)'; shape(0.55); ctx.fill();
    const shaft = ctx.createLinearGradient(0, -capR, 0, capR);
    shaft.addColorStop(0, '#FBF6E6'); shaft.addColorStop(0.45, '#E6DBB8'); shaft.addColorStop(1, '#B3A47C');
    ctx.fillStyle = shaft; shape(0); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    [-half, half].forEach((ex) => { ctx.beginPath(); ctx.ellipse(ex - capR * 0.2, -capR * 0.35, capR * 0.3, capR * 0.4, 0, 0, Math.PI * 2); ctx.fill(); });
    ctx.strokeStyle = 'rgba(110,95,60,0.3)'; ctx.lineWidth = Math.max(0.4, r * 0.14);
    ctx.beginPath(); ctx.moveTo(-half * 0.25, -shaftR * 0.35); ctx.lineTo(half * 0.15, shaftR * 0.4); ctx.stroke();
    ctx.restore();
  }

  // Two slim parallel bones, like the radius + ulna or tibia + fibula.
  drawBonePair(x1, y1, x2, y2, r) {
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const ox = (-(y2 - y1) / len) * r * 0.75, oy = ((x2 - x1) / len) * r * 0.75;
    this.drawBone(x1 + ox, y1 + oy, x2 + ox * 0.6, y2 + oy * 0.6, r * 0.55);
    this.drawBone(x1 - ox, y1 - oy, x2 - ox * 0.6, y2 - oy * 0.6, r * 0.7);
  }

  // A hand or foot: a cluster of small carpal/tarsal bones with five
  // jointed digits fanning out toward `angle`.
  drawBoneDigits(x, y, angle, size) {
    const ctx = this.ctx;
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
    ctx.fillStyle = 'rgba(58,44,22,0.62)';
    ctx.beginPath(); ctx.ellipse(size * 0.6, 0, size * 0.85, size * 0.62, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#E6DBB8';
    ctx.beginPath(); ctx.ellipse(size * 0.6, 0, size * 0.7, size * 0.48, 0, 0, Math.PI * 2); ctx.fill();
    ctx.lineCap = 'round';
    for (let f = 0; f < 5; f++) {
      const a = (f - 2) * 0.32, l = size * (f === 0 ? 1.3 : 1.9 - Math.abs(f - 2.2) * 0.22);
      const bx = size * 1.1, by = (f - 2) * size * 0.28;
      const ex = bx + Math.cos(a) * l, ey = by + Math.sin(a) * l;
      ctx.strokeStyle = 'rgba(58,44,22,0.62)'; ctx.lineWidth = size * 0.42;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.strokeStyle = '#EFE6CC'; ctx.lineWidth = size * 0.26;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.fillStyle = '#C8BA92';
      ctx.beginPath(); ctx.arc(bx + Math.cos(a) * l * 0.5, by + Math.sin(a) * l * 0.5, size * 0.13, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // A stylised skull: one silhouette for cranium + cheekbones, angular eye
  // sockets with a faint ember glow deep inside, an inverted-heart nasal
  // cavity, a row of upper teeth and a slightly dropped jaw. Shared by the
  // standalone 'skull' debris and the full humanSkeleton. Drawn at the local
  // origin (roughly 16 wide × 21 tall) — callers translate/rotate/scale first.
  drawSkullDetail() {
    const ctx = this.ctx;
    const BONE = '#E6DCC0', TEETH = '#F3ECD6', HOLE = '#0B0A08', INK = 'rgba(46,36,20,0.75)';

    const dome = ctx.createRadialGradient(-2.5, -5, 1, 0, -1, 10);
    dome.addColorStop(0, '#FBF5E4'); dome.addColorStop(0.55, BONE); dome.addColorStop(1, '#A99B76');
    ctx.fillStyle = dome;
    ctx.beginPath();
    ctx.moveTo(-7, 0.5);
    ctx.bezierCurveTo(-8, -6.5, -4.2, -9, 0, -9);
    ctx.bezierCurveTo(4.2, -9, 8, -6.5, 7, 0.5);
    ctx.bezierCurveTo(6.8, 2.4, 5.6, 3.2, 4.8, 3.6);
    ctx.lineTo(4, 5.8); ctx.lineTo(-4, 5.8); ctx.lineTo(-4.8, 3.6);
    ctx.bezierCurveTo(-5.6, 3.2, -6.8, 2.4, -7, 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = 0.7; ctx.stroke();

    ctx.fillStyle = 'rgba(120,100,60,0.18)';
    ctx.beginPath(); ctx.ellipse(-5.6, -1.5, 1.4, 3, 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(5.6, -1.5, 1.4, 3, -0.2, 0, Math.PI * 2); ctx.fill();

    [-1, 1].forEach((s) => {
      ctx.fillStyle = HOLE;
      ctx.beginPath();
      ctx.moveTo(s * 0.9, -2.6);
      ctx.quadraticCurveTo(s * 4.8, -4.4, s * 5.2, -0.8);
      ctx.quadraticCurveTo(s * 4.6, 1.8, s * 2.4, 1.6);
      ctx.quadraticCurveTo(s * 0.6, 1.2, s * 0.9, -2.6);
      ctx.closePath(); ctx.fill();
      const glow = ctx.createRadialGradient(s * 3, -0.6, 0, s * 3, -0.6, 1.8);
      glow.addColorStop(0, 'rgba(255,120,40,0.55)'); glow.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(s * 3, -0.6, 1.8, 0, Math.PI * 2); ctx.fill();
    });

    ctx.fillStyle = HOLE;
    ctx.beginPath();
    ctx.moveTo(0, 1.6);
    ctx.quadraticCurveTo(-1.6, 3.2, -0.9, 4.2);
    ctx.lineTo(0, 3.7); ctx.lineTo(0.9, 4.2);
    ctx.quadraticCurveTo(1.6, 3.2, 0, 1.6);
    ctx.fill();

    ctx.fillStyle = TEETH; ctx.fillRect(-3.6, 5.2, 7.2, 1.8);
    ctx.strokeStyle = INK; ctx.lineWidth = 0.4;
    ctx.beginPath();
    for (let t = -2.7; t <= 2.8; t += 0.9) { ctx.moveTo(t, 5.2); ctx.lineTo(t, 7); }
    ctx.stroke();

    ctx.fillStyle = BONE;
    ctx.beginPath();
    ctx.moveTo(-4.4, 7.6); ctx.lineTo(4.4, 7.6); ctx.lineTo(3.6, 10.4);
    ctx.quadraticCurveTo(0, 11.6, -3.6, 10.4);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = 0.6; ctx.stroke();
    ctx.fillStyle = TEETH; ctx.fillRect(-3.2, 7.6, 6.4, 1.4);
    ctx.strokeStyle = INK; ctx.lineWidth = 0.35;
    ctx.beginPath();
    for (let t = -2.4; t <= 2.5; t += 0.8) { ctx.moveTo(t, 7.6); ctx.lineTo(t, 9); }
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.ellipse(-2.6, -6.2, 2.4, 1.1, -0.35, 0, Math.PI * 2); ctx.fill();
  }

  // A blown-out puncture gash exposing dark rubber underneath — a small
  // reusable damage detail so a crashed tire reads as punctured rather than
  // just worn. `R` scales the gash to the tire it's cut into.
  drawPunctureGash(cx, cy, R, angle) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(angle);
    ctx.fillStyle = '#050403';
    ctx.beginPath();
    ctx.moveTo(-R * 0.22, -R * 0.14); ctx.lineTo(R * 0.24, -R * 0.05);
    ctx.lineTo(R * 0.18, R * 0.16); ctx.lineTo(-R * 0.17, R * 0.1);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(150,140,120,0.4)'; ctx.lineWidth = Math.max(0.4, R * 0.04);
    ctx.beginPath(); ctx.moveTo(-R * 0.22, -R * 0.14); ctx.lineTo(R * 0.24, -R * 0.05); ctx.stroke();
    ctx.restore();
  }

  // Continuous rising smoke + a flickering ember, both pure functions of `ts`
  // (plus a seed for phase offset) — no particle array to manage, so it works
  // equally well for a static graveyard pile or a bike mid-crash.
  drawWreckSmoke(x, y, seed, ts) {
    const ctx = this.ctx;
    const emberA = 0.3 + Math.sin(ts * 0.006 + seed) * 0.15;
    const eg = ctx.createRadialGradient(x, y, 0, x, y, 9);
    eg.addColorStop(0, `rgba(255,140,40,${Math.max(0, emberA)})`); eg.addColorStop(1, 'rgba(255,80,20,0)');
    ctx.fillStyle = eg; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();

    for (let i = 0; i < 4; i++) {
      const dur = 2600 + (i % 3) * 300;
      const t = ((ts + seed * 613 + i * (dur / 4) * 7) % dur) / dur;
      const rise = t * 46, sway = Math.sin(t * Math.PI * 2 + seed + i) * 8 * t;
      const alpha = (1 - t) * 0.38, rad = 4 + t * 13;
      const px = x + sway, py = y - 8 - rise;
      const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
      g.addColorStop(0, `rgba(70,70,75,${alpha})`); g.addColorStop(1, 'rgba(40,40,45,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2); ctx.fill();
    }
  }

  // A single, independent piece of graveyard debris (see WRECK_KINDS), drawn
  // around its ground contact point with a contact shadow, in one consistent
  // style: soft top-left light and clean dark outlines. Only the wrecked
  // bike smokes (drawn live, unscaled, so it always rises straight up).
  drawDebrisPiece(x, y, kind, seed, ts, scale, flip, rot, phase, skipSmoke) {
    const ctx = this.ctx;
    // The human skeleton is drawn smaller than its art, at about a person's
    // size beside the bike. The long fossil only tilts a little, so it lies
    // flat in the sand instead of looking propped on a slope.
    if (kind === 'humanSkeleton') scale *= 0.58;
    else if (kind === 'dinoBones') rot *= 0.25;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(scale * flip, scale);

    if (kind !== 'dinoBones' && kind !== 'humanSkeleton' && kind !== 'rocks') {
      const shadowR = kind === 'brokenBiker' ? 26 : kind === 'cowSkull' ? 16 : kind === 'tireLean' ? 13 : kind === 'graveCross' ? 10 : 12;
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath(); ctx.ellipse(0, 2, shadowR, shadowR * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    }

    if (kind === 'tireLean' || kind === 'tireFlat') this.drawPropTyre(kind === 'tireFlat');
    else if (kind === 'skull') this.drawPropSkullAndBones();
    else if (kind === 'bone') this.drawPropBonePile();
    else if (kind === 'helmet') this.drawPropHelmet();
    else if (kind === 'brokenBiker') this.drawPropWreckedBike();
    else if (kind === 'dinoBones') this.drawPropFossil();
    else if (kind === 'humanSkeleton') this.drawPropSkeleton();
    else if (kind === 'cowSkull') this.drawPropCowSkull();
    else if (kind === 'graveCross') this.drawPropGraveCross();
    else if (kind === 'rocks') this.drawPropRocks();

    ctx.restore();
    if (kind === 'brokenBiker' && !skipSmoke) this.drawWreckSmoke(x + 8 * flip, y - 12 * scale, seed + phase, ts);
  }

  // Loose dirt heaped around something half-buried: a lumpy dome, lit on top
  // and shaded at the base, with a few clods rolled off the sides.
  drawDirtMound(x, y, rx, ry) {
    const ctx = this.ctx;
    const lumps = 6;
    const dome = () => {
      ctx.beginPath();
      ctx.moveTo(x - rx, y + ry * 0.35);
      for (let i = 0; i < lumps; i++) {
        const t0 = i / lumps, t1 = (i + 1) / lumps;
        const h = (t) => Math.sin(t * Math.PI) * ry * 2.2 * (0.85 + ((i * 37) % 7) / 28);
        ctx.quadraticCurveTo(x - rx + rx * 2 * (t0 + t1) / 2, y - h((t0 + t1) / 2) - ry * 0.35, x - rx + rx * 2 * t1, y - h(t1) * 0.92 + ry * 0.2);
      }
      ctx.quadraticCurveTo(x, y + ry * 0.75, x - rx, y + ry * 0.35);
      ctx.closePath();
    };
    const g = ctx.createLinearGradient(0, y - ry * 2.4, 0, y + ry * 0.6);
    g.addColorStop(0, '#9C7246'); g.addColorStop(0.55, '#7A5532'); g.addColorStop(1, '#4E351D');
    ctx.fillStyle = g; dome(); ctx.fill();
    ctx.strokeStyle = 'rgba(40,26,12,0.55)'; ctx.lineWidth = 0.7; dome(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,226,180,0.12)';
    ctx.beginPath(); ctx.ellipse(x - rx * 0.25, y - ry * 1.4, rx * 0.35, ry * 0.35, -0.2, 0, Math.PI * 2); ctx.fill();
    [[-1.05, 0.15, 1.3], [1.08, 0.25, 1], [0.7, 0.55, 0.8], [-0.6, 0.6, 0.7]].forEach(([fx, fy, fr]) => {
      ctx.fillStyle = '#6A4A2A'; ctx.beginPath(); ctx.arc(x + fx * rx, y + fy * ry, fr, 0, Math.PI * 2); ctx.fill();
    });
  }

  // A knobby MX tyre on a buckled gold rim with snapped spokes — standing
  // tilted and half-sunk in the dirt, or lying flat with its side wall showing.
  drawPropTyre(flat) {
    const ctx = this.ctx;
    const R = 12;
    ctx.save();
    if (flat) { ctx.translate(0, -3.5); ctx.scale(1, 0.34); } else { ctx.translate(0, -10.5); ctx.rotate(0.22); ctx.scale(0.62, 1); }
    if (flat) {
      ctx.fillStyle = '#07080B';
      ctx.beginPath(); ctx.arc(0, 7, R + 1.2, 0, Math.PI * 2); ctx.fill();
    }
    const rubber = ctx.createRadialGradient(-R * 0.3, -R * 0.3, R * 0.2, 0, 0, R);
    rubber.addColorStop(0, '#30343C'); rubber.addColorStop(0.7, '#181B21'); rubber.addColorStop(1, '#08090C');
    ctx.fillStyle = rubber;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0B0D11';
    ctx.beginPath();
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2 + 0.1, h = 0.09, r0 = R - 0.4, r1 = R + 1.3;
      ctx.moveTo(Math.cos(a - h) * r0, Math.sin(a - h) * r0); ctx.lineTo(Math.cos(a - h) * r1, Math.sin(a - h) * r1);
      ctx.lineTo(Math.cos(a + h) * r1, Math.sin(a + h) * r1); ctx.lineTo(Math.cos(a + h) * r0, Math.sin(a + h) * r0); ctx.closePath();
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.lineWidth = 1.2; ctx.setLineDash([2.5, 2]);
    ctx.beginPath(); ctx.arc(0, 0, R * 0.84, 0.3, 2.2); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = flat ? '#3A2715' : 'rgba(10,8,6,0.92)';
    ctx.beginPath(); ctx.arc(0, 0, R * 0.64, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#C99A2E'; ctx.lineWidth = R * 0.1;
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2, rr = R * 0.66 + Math.sin(a * 3 + 1) * 0.5;
      if (i) ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); else ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,240,190,0.5)'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.arc(0, 0, R * 0.66, Math.PI * 1.1, Math.PI * 1.5); ctx.stroke();
    ctx.strokeStyle = 'rgba(200,206,216,0.7)'; ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let s = 0; s < 12; s++) {
      const a = (s / 12) * Math.PI * 2, snapped = s % 4 === 1;
      ctx.moveTo(Math.cos(a) * R * 0.12, Math.sin(a) * R * 0.12);
      ctx.lineTo(Math.cos(a + (snapped ? 0.3 : 0)) * R * (snapped ? 0.38 : 0.62), Math.sin(a + (snapped ? 0.3 : 0)) * R * (snapped ? 0.38 : 0.62));
    }
    ctx.stroke();
    ctx.fillStyle = '#B8C0CC'; ctx.beginPath(); ctx.arc(0, 0, R * 0.16, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#5B6475'; ctx.beginPath(); ctx.arc(0, 0, R * 0.07, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(150,110,62,0.28)';
    ctx.beginPath(); ctx.arc(0, 0, R + 1, Math.PI * 1.05, Math.PI * 1.95); ctx.arc(0, 0, R * 0.7, Math.PI * 1.95, Math.PI * 1.05, true); ctx.fill();
    ctx.restore();
    if (!flat) this.drawDirtMound(0, 1, 8, 3);
  }

  drawPropSkullAndBones() {
    const ctx = this.ctx;
    this.drawBone(-11, 1, 11, 8, 1.8);
    this.drawBone(-11, 8, 11, 1, 1.8);
    ctx.save(); ctx.translate(0, -8.5);
    this.drawSkullDetail();
    ctx.strokeStyle = 'rgba(90,78,50,0.45)'; ctx.lineWidth = 0.45;
    ctx.beginPath(); ctx.moveTo(3.4, -7.6); ctx.lineTo(4.6, -3.2); ctx.lineTo(3.6, -0.8); ctx.stroke();
    ctx.restore();
    this.drawSandDusting([[0, 7, 13, 0.35]]);
  }

  // A small pile: a femur, a curved rib, a vertebra and a finger bone.
  drawPropBonePile() {
    const ctx = this.ctx;
    const rib = () => { ctx.beginPath(); ctx.moveTo(-7, 6); ctx.quadraticCurveTo(0, -1, 9, 4); };
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(58,44,22,0.62)'; ctx.lineWidth = 2.5; rib(); ctx.stroke();
    ctx.strokeStyle = '#E9DFC2'; ctx.lineWidth = 1.4; rib(); ctx.stroke();
    this.drawBone(-12, 3, 9, -3, 1.9);
    ctx.fillStyle = 'rgba(58,44,22,0.62)';
    ctx.beginPath(); ctx.roundRect(5.5, 2.2, 4.4, 3.4, 1.2); ctx.fill();
    ctx.fillStyle = '#E6DBB8';
    ctx.beginPath(); ctx.roundRect(6, 2.6, 3.4, 2.6, 1); ctx.fill();
    ctx.strokeStyle = '#D9CDA8'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(5.2, 3.9); ctx.lineTo(3.8, 3.4); ctx.moveTo(10.2, 3.9); ctx.lineTo(11.6, 3.4); ctx.stroke();
    this.drawBone(-7, 8, -2, 7, 0.8);
    this.drawSandDusting([[-2, 7, 12, 0.3]]);
  }

  // The rider's MX helmet lying on its side: scuffed, cracked, goggles
  // shattered, with the snapped-off peak lying beside it.
  drawPropHelmet() {
    const ctx = this.ctx;
    ctx.save(); ctx.translate(0, -6); ctx.rotate(0.35); ctx.scale(1.15, 1.15);
    const helmet = () => {
      ctx.beginPath();
      ctx.moveTo(-4.8, 1.5);
      ctx.bezierCurveTo(-5.8, -4.5, -1.5, -6.6, 2.8, -5.6);
      ctx.lineTo(5.6, -3.6); ctx.lineTo(6.2, -0.4);
      ctx.quadraticCurveTo(8.6, 1.6, 8.2, 3.8);
      ctx.lineTo(4.6, 5.4);
      ctx.quadraticCurveTo(0.5, 5.6, -2.6, 4.2);
      ctx.closePath();
    };
    const shell = ctx.createRadialGradient(-1.6, -3, 0.6, 0, 0, 8);
    shell.addColorStop(0, '#FFFFFF'); shell.addColorStop(0.7, '#DCE2EA'); shell.addColorStop(1, '#9AA6B6');
    ctx.fillStyle = shell; helmet(); ctx.fill();
    ctx.save(); helmet(); ctx.clip();
    ctx.fillStyle = LIVERY.main;
    ctx.beginPath(); ctx.moveTo(-6, -2.6); ctx.lineTo(7, -4.4); ctx.lineTo(7, -2.6); ctx.lineTo(-6, -0.6); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#14223F'; ctx.beginPath(); ctx.arc(-5.2, 2.2, 3.6, 0, Math.PI * 2); ctx.fill();
    [[-2, 2.5, 2.4], [3, -1.5, 1.6], [1, 3.6, 1.8]].forEach(([sx, sy, sr]) => {
      const scuff = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
      scuff.addColorStop(0, 'rgba(120,86,48,0.55)'); scuff.addColorStop(1, 'rgba(120,86,48,0)');
      ctx.fillStyle = scuff; ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2); ctx.fill();
    });
    ctx.restore();
    helmet(); ctx.strokeStyle = 'rgba(4,8,16,0.85)'; ctx.lineWidth = 0.7; ctx.stroke();
    ctx.strokeStyle = 'rgba(20,14,8,0.75)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(-4, -3.5); ctx.lineTo(-1.6, -1.2); ctx.lineTo(-2.4, 1.2); ctx.lineTo(-0.4, 3); ctx.moveTo(-1.6, -1.2); ctx.lineTo(0.8, -2.4); ctx.stroke();
    ctx.strokeStyle = '#1B1F27'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(2, -1.9); ctx.lineTo(-5.4, -1.2); ctx.stroke();
    ctx.fillStyle = '#1B1F27';
    ctx.beginPath(); ctx.roundRect(1.9, -3.3, 4.7, 3, 1.2); ctx.fill();
    const lens = ctx.createLinearGradient(2.2, -3, 6.4, -0.6);
    lens.addColorStop(0, '#FFE08A'); lens.addColorStop(0.5, '#FF9A2E'); lens.addColorStop(1, '#E2442A');
    ctx.fillStyle = lens;
    ctx.beginPath(); ctx.roundRect(2.5, -2.8, 3.8, 2, 0.8); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 0.35;
    ctx.beginPath(); ctx.moveTo(3.2, -2.8); ctx.lineTo(4.1, -1.8); ctx.lineTo(3.6, -0.8); ctx.moveTo(4.1, -1.8); ctx.lineTo(5.6, -2.2); ctx.stroke();
    ctx.restore();
    ctx.save(); ctx.translate(9.5, 0.2); ctx.rotate(-0.3);
    ctx.fillStyle = LIVERY.main;
    ctx.beginPath(); ctx.moveTo(-5, -1); ctx.lineTo(5, -1.6); ctx.lineTo(4.2, 0.4); ctx.lineTo(-3.2, 0.6); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(4,8,16,0.85)'; ctx.lineWidth = 0.6; ctx.stroke();
    ctx.restore();
  }

  // A crashed MX bike in the rider's colours, nose-down with the front wheel
  // buried: twisted scorched front wheel, kinked gold fork, torn shroud,
  // cracked fender and number plate.
  drawPropWreckedBike() {
    const ctx = this.ctx;
    const INK = 'rgba(4,8,16,0.85)';
    const poly = (pts, fill) => {
      ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 0.9; ctx.stroke();
    };
    ctx.save(); ctx.translate(-2, -10); ctx.rotate(0.6); ctx.scale(0.78, 0.78);
    this.drawWheel(-15, 9.5, 11.5, 0.4, false, 0);
    this.drawWheel(15, 13, 11.5, 2.1, true, 0);
    poly([-2.5, 1.6, -13.5, 7.5, -13.5, 11, -2.5, 6], '#AEB7C4');
    ctx.fillStyle = '#262D3B';
    ctx.beginPath(); ctx.roundRect(-6.5, -5, 12.5, 10.5, 2.5); ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.fillStyle = '#9AA3B2'; ctx.beginPath(); ctx.arc(-1.5, 2, 3, 0, Math.PI * 2); ctx.fill();
    poly([-12, -11.5, -31, -15.5, -30, -13, -15, -8], '#E6EBF1');
    ctx.strokeStyle = 'rgba(20,14,8,0.7)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(-22, -13.5); ctx.lineTo(-20.5, -11.5); ctx.lineTo(-22.4, -10.2); ctx.stroke();
    poly([-5.5, -11, -17.5, -10.6, -15.5, -3.8, -6.5, -4.2], '#EEF2F6');
    ctx.fillStyle = '#14223F'; ctx.font = `italic 800 6px ${FONT_NUM}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('42', -11, -7.2);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    poly([-1.5, -14, -21, -12.2, -22, -10.6, -2, -11.4], '#121826');
    poly([8.5, -13.5, -2.5, -14, -4, -8, -1, -6.5, 1.5, -4, 3, -5.5, 4.5, -3, 7.5, -3.5], LIVERY.dark);
    ctx.fillStyle = 'rgba(20,14,8,0.55)';
    [[1, -9, 2.4], [-14, -10, 2], [-2, 1, 2.2]].forEach(([sx, sy, sr]) => { ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2); ctx.fill(); });
    ctx.lineCap = 'round';
    ctx.strokeStyle = INK; ctx.lineWidth = 3.8;
    ctx.beginPath(); ctx.moveTo(8.5, -13); ctx.lineTo(11, -2); ctx.lineTo(15, 13); ctx.stroke();
    ctx.strokeStyle = '#C99A2E'; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(8.5, -13); ctx.lineTo(11, -2); ctx.lineTo(15, 13); ctx.stroke();
    ctx.strokeStyle = '#1B1F27'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(8.5, -14.5); ctx.lineTo(5, -20); ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.restore();
    this.drawDirtMound(4, 2, 14, 5);
  }

  // A fossilised T. rex laid out where it fell, head thrown back in a last
  // roar: a deep skull full of windows (nostril, antorbital, eye socket,
  // temporal) with curved fangs and the jaw dropped open, an S-curved neck,
  // tall spines along the back, the ribcage and belly ribs, the big hip
  // (ilium, booted pubis, ischium), the famous tiny two-clawed arm, one leg
  // folded under the tail and the far one stretched forward, and a long
  // tapering tail with chevrons that runs off under a sand drift. Amber-ivory
  // fossil bone with dark outlines over a soft shadow, so it stands out on
  // the sand. Drawn about 92 wide, facing left, sitting on the origin.
  drawPropFossil() {
    const ctx = this.ctx;
    const INK = 'rgba(50,30,12,0.92)', HOLE = '#24150A';
    const NEAR = ['#F7EBCB', '#DCC089', '#A8814B'], FAR = ['#BDA275', '#9E8357', '#6F5836'];
    ctx.save(); ctx.scale(0.86, 0.86);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // Lit from the top left: a gradient across a shape toward that light
    const lit = (x, y, r, tone) => {
      const g = ctx.createLinearGradient(x - r * 0.5, y - r * 0.86, x + r * 0.5, y + r * 0.86);
      g.addColorStop(0, tone[0]); g.addColorStop(0.5, tone[1]); g.addColorStop(1, tone[2]);
      return g;
    };
    // A thin bone along a path: dark outline, bone body, then a highlight
    // nudged toward the light.
    const strokeBone = (path, w, tone = NEAR) => {
      ctx.strokeStyle = INK; ctx.lineWidth = w + 1; path(); ctx.stroke();
      ctx.strokeStyle = tone[1]; ctx.lineWidth = w; path(); ctx.stroke();
      ctx.save(); ctx.translate(-w * 0.12, -w * 0.16);
      ctx.strokeStyle = tone[0]; ctx.lineWidth = w * 0.36; path(); ctx.stroke();
      ctx.restore();
    };
    // A long limb bone between two joints: knobbly ends, slimmer shaft.
    const limb = (x1, y1, x2, y2, r1, r2, tone = NEAR) => {
      const len = Math.hypot(x2 - x1, y2 - y1) || 1, a = Math.atan2(y2 - y1, x2 - x1);
      ctx.save(); ctx.translate(x1, y1); ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(0, -r1);
      ctx.bezierCurveTo(len * 0.3, -r1 * 0.58, len * 0.7, -r2 * 0.58, len, -r2);
      ctx.arc(len, 0, r2, -Math.PI / 2, Math.PI / 2);
      ctx.bezierCurveTo(len * 0.7, r2 * 0.58, len * 0.3, r1 * 0.58, 0, r1);
      ctx.arc(0, 0, r1, Math.PI / 2, Math.PI * 1.5);
      ctx.closePath();
      ctx.restore();
      ctx.fillStyle = lit((x1 + x2) / 2, (y1 + y2) / 2, Math.max(r1, r2) * 1.4, tone); ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 0.65; ctx.stroke();
    };
    const claw = (x, y, a, s, tone = NEAR) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(0, -s * 0.45);
      ctx.quadraticCurveTo(s * 1, -s * 0.5, s * 1.35, s * 0.6);
      ctx.quadraticCurveTo(s * 0.7, s * 0.1, 0, s * 0.45);
      ctx.closePath(); ctx.restore();
      ctx.fillStyle = tone[2]; ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 0.45; ctx.stroke();
    };
    // A toe: two short joints then a claw, fanning toward `a`.
    const toe = (x, y, a, len, tone) => {
      const c = Math.cos(a), s = Math.sin(a), k = len * 0.42;
      limb(x, y, x + c * k, y + s * k, 0.62, 0.52, tone);
      limb(x + c * k, y + s * k, x + c * k * 1.9, y + s * k * 1.9, 0.5, 0.42, tone);
      claw(x + c * k * 1.9, y + s * k * 1.9, a + 0.15, 0.95, tone);
    };

    // The backbone as a smooth curve, skull joint to tail tip, sampled so
    // vertebrae can be laid along it by distance.
    const P = [[-27, -21], [-24.6, -16.6], [-20, -13.8], [-13, -13.6], [-4, -15.3], [5, -15.9], [12, -15.3],
      [20, -13.6], [29, -11], [38, -8.5], [46, -6.8], [53, -6], [58.5, -6]];
    const pts = [];
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
      for (let k = 0; k < 16; k++) {
        const t = k / 16, t2 = t * t, t3 = t2 * t;
        pts.push([0, 1].map((j) => 0.5 * (2 * p1[j] + (p2[j] - p0[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2
          + (3 * p1[j] - p0[j] - 3 * p2[j] + p3[j]) * t3)));
      }
    }
    pts.push(P[P.length - 1]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const L = cum[cum.length - 1];
    const at = (s) => {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < s) i++;
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], f = Math.max(0, Math.min(1, (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1)));
      const d = Math.hypot(bx - ax, by - ay) || 1, tx = (bx - ax) / d, ty = (by - ay) / d;
      return { x: ax + (bx - ax) * f, y: ay + (by - ay) * f, tx, ty, nx: ty, ny: -tx };
    };
    const NECK = 10, HIP = 46;
    const verts = [];
    for (let s = 1.4; s < L - 0.8;) {
      const tail = Math.max(0, (s - HIP) / (L - HIP));
      verts.push({ s, tail, size: s < NECK ? 1.85 : s < HIP ? 1.65 : 1.6 - tail * 1.15, ...at(s) });
      s += s < HIP ? 2.3 : 2.3 - tail * 0.85;
    }
    const belly = (x) => -1.4 - ((x + 2) / 13) ** 2 * 4.6;

    // Ground: a brushed-out hollow and soft contact shadows under the masses
    ctx.save(); ctx.translate(6, -5); ctx.scale(1, 0.36);
    const pit = ctx.createRadialGradient(0, 0, 6, 0, 0, 60);
    pit.addColorStop(0, 'rgba(34,20,8,0.3)'); pit.addColorStop(0.7, 'rgba(34,20,8,0.14)'); pit.addColorStop(1, 'rgba(34,20,8,0)');
    ctx.fillStyle = pit; ctx.beginPath(); ctx.arc(0, 0, 60, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    const blob = (x, y, rx, ry, a) => {
      ctx.save(); ctx.translate(x, y); ctx.scale(1, ry / rx);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, `rgba(22,12,4,${a})`); g.addColorStop(1, 'rgba(22,12,4,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };
    blob(-3, -6, 19, 9, 0.34); blob(14, -7, 11, 8, 0.3); blob(-37, -17, 14, 9, 0.3);
    for (let s = HIP; s < L; s += 5) { const p = at(s); blob(p.x + 1.5, p.y + 2.2, 5 - (s - HIP) / (L - HIP) * 3, 3, 0.26); }
    blob(20, 1, 9, 3.4, 0.28); blob(-2, 1.5, 9, 3, 0.22);

    // Far hind leg, stretched forward under the belly
    limb(13.4, -14, 4.8, -7.4, 1.8, 1.55, FAR);
    limb(4.8, -7.4, 0.6, 0.4, 1.45, 1.15, FAR);
    limb(0.6, 0.4, -5.6, 2.2, 1, 0.8, FAR);
    [Math.PI + 0.12, Math.PI - 0.3, Math.PI + 0.5].forEach((a, i) => toe(-5.8, 2.2, a, 3.4 - i * 0.3, FAR));

    // Spines along the back, short ribs down the neck, chevrons under the tail
    verts.forEach((v) => {
      const len = v.s < NECK ? 1.6 + (v.s / NECK) * 0.9 : v.s < HIP ? 3.2 + ((v.s - NECK) / (HIP - NECK)) * 1.7 : 4.6 * (1 - v.tail) ** 1.4 + 0.35;
      const b = v.size * 0.7, w = v.s < HIP ? 1.15 : 1.05 - v.tail * 0.62;
      strokeBone(() => {
        ctx.beginPath(); ctx.moveTo(v.x + v.nx * b, v.y + v.ny * b);
        ctx.lineTo(v.x + v.nx * (b + len) + v.tx * len * 0.34, v.y + v.ny * (b + len) + v.ty * len * 0.34);
      }, w);
      if (v.s < NECK) {
        strokeBone(() => {
          ctx.beginPath(); ctx.moveTo(v.x - v.nx * b, v.y - v.ny * b);
          ctx.lineTo(v.x - v.nx * (b + 1.2) + v.tx * 2.2, v.y - v.ny * (b + 1.2) + v.ty * 2.2);
        }, 0.8, FAR);
      }
      if (v.s > HIP + 1.5) {
        const cl = 3.6 * (1 - v.tail) ** 1.2 + 0.3;
        strokeBone(() => {
          ctx.beginPath(); ctx.moveTo(v.x - v.nx * b, v.y - v.ny * b);
          ctx.lineTo(v.x - v.nx * (b + cl) + v.tx * cl * 0.5, v.y - v.ny * (b + cl) + v.ty * cl * 0.5);
        }, w * 0.85, FAR);
      }
    });

    // Ribcage: each rib bows forward from the spine down to the belly,
    // shortest at the chest; belly ribs (gastralia) close it underneath.
    const ribs = verts.filter((v) => v.s > NECK + 1 && v.s < HIP - 4);
    strokeBone(() => {
      ctx.beginPath();
      ribs.forEach((v) => {
        const ex = v.x + 2.8, ey = belly(ex), sy = v.y + 0.8;
        ctx.moveTo(v.x, sy);
        ctx.bezierCurveTo(v.x - 2.6, sy + (ey - sy) * 0.35, ex - 3.2, sy + (ey - sy) * 0.8, ex, ey);
      });
    }, 1.15);
    strokeBone(() => {
      ctx.beginPath();
      for (let gx = -13.5; gx <= 7; gx += 2.05) {
        const b = belly(gx);
        ctx.moveTo(gx - 1.1, b + 0.9); ctx.quadraticCurveTo(gx, b + 1.7, gx + 1.1, b + 0.9);
      }
    }, 0.55, FAR);

    // Vertebrae: spool-shaped bodies along the curve
    verts.forEach((v) => {
      const h = v.size * 1.9, l = Math.max(1.1, (v.s < HIP ? 2.3 : 2.3 - v.tail * 0.85) * 0.86);
      ctx.save(); ctx.translate(v.x, v.y); ctx.rotate(Math.atan2(v.ty, v.tx));
      ctx.beginPath(); ctx.roundRect(-l / 2, -h / 2, l, h, Math.min(l, h) * 0.38);
      ctx.restore();
      ctx.fillStyle = lit(v.x, v.y, h, NEAR); ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 0.55; ctx.stroke();
    });

    // Hip: the pubis reaching forward to its boot, the ischium back, and the
    // long ilium blade on top
    limb(10.2, -12.6, 2.4, -4, 1.3, 0.95);
    ctx.beginPath(); ctx.ellipse(1.6, -3, 4.4, 1.4, -0.12, 0, Math.PI * 2);
    ctx.fillStyle = lit(1.6, -3, 3, NEAR); ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 0.65; ctx.stroke();
    limb(14.8, -12.8, 20.4, -7, 1.2, 0.75);
    const ilium = () => {
      ctx.beginPath();
      ctx.moveTo(2.6, -15);
      ctx.bezierCurveTo(0.6, -17.6, 2.4, -21.4, 7, -21.4);
      ctx.bezierCurveTo(10, -21.2, 12, -20.3, 14, -20.5);
      ctx.bezierCurveTo(18.5, -21, 22.4, -18.6, 23.8, -15.6);
      ctx.quadraticCurveTo(19, -13.2, 15, -13.2);
      ctx.quadraticCurveTo(12.6, -11.6, 10.2, -12.8);
      ctx.quadraticCurveTo(6.4, -13.2, 2.6, -15);
      ctx.closePath();
    };
    ilium(); ctx.fillStyle = lit(12, -17, 9, NEAR); ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 0.75; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,248,226,0.55)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(3, -18); ctx.bezierCurveTo(5, -20.4, 10, -20.2, 13.6, -19.6); ctx.quadraticCurveTo(19, -20, 21.6, -17); ctx.stroke();
    ctx.strokeStyle = 'rgba(92,62,28,0.45)'; ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(6, -15.8); ctx.quadraticCurveTo(13, -18.2, 20.5, -15.6);
    for (let k = 0; k < 4; k++) { ctx.moveTo(8 + k * 3, -17.6 - (k % 2) * 0.4); ctx.lineTo(8.8 + k * 3, -16.4 - (k % 2) * 0.4); }
    ctx.moveTo(15.6, -20.2); ctx.lineTo(14.6, -18.6); ctx.lineTo(15.3, -17.6);
    ctx.stroke();
    ctx.fillStyle = HOLE; ctx.beginPath(); ctx.arc(12.4, -13.7, 1.55, 0, Math.PI * 2); ctx.fill();

    // Near hind leg, folded with the foot tucked under the tail: femur,
    // shin (tibia + fibula), the long foot bones and three clawed toes
    limb(12.4, -13.7, 11, -4.4, 2.1, 1.85);
    limb(11.4, -4, 19.8, -0.3, 1.3, 0.85);
    limb(11, -4.5, 19.8, -0.7, 1.7, 1.25);
    limb(19.8, -0.6, 26.2, 1.6, 1.15, 0.85);
    [0.32, -0.12, 0.78].forEach((a, i) => toe(26.4, 1.7, a, 3.8 - i * 0.35, NEAR));

    // Shoulder blade and the famous tiny arm, two claws dangling in front of
    // the chest
    limb(-8.6, -15, -14.6, -6.6, 1.35, 0.95);
    ctx.beginPath(); ctx.ellipse(-15.4, -5.8, 1.9, 1.5, 0.5, 0, Math.PI * 2);
    ctx.fillStyle = lit(-15.4, -5.8, 2, NEAR); ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 0.6; ctx.stroke();
    limb(-16, -5.2, -18.4, -1.8, 0.85, 0.68);
    limb(-18.4, -1.8, -21.4, -1, 0.66, 0.52);
    claw(-21.6, -1, Math.PI - 0.1, 1.05); claw(-21.4, -0.6, Math.PI - 0.75, 0.95);

    // Skull: origin at the back where the neck joins, snout tipped up
    ctx.save(); ctx.translate(-27.2, -21); ctx.rotate(0.3);
    const tooth = (x, y, s, dir) => {
      const w = s * 0.52;
      ctx.moveTo(x - w * 0.5, y);
      ctx.quadraticCurveTo(x - w * 0.45, y + dir * s * 0.65, x + s * 0.3, y + dir * s);
      ctx.quadraticCurveTo(x + w * 0.3, y + dir * s * 0.45, x + w * 0.5, y);
      ctx.closePath();
    };
    const teeth = (draw) => {
      ctx.beginPath(); draw();
      ctx.fillStyle = '#FAF2DC'; ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 0.4; ctx.stroke();
    };
    // Lower jaw, hinged under the back of the skull and dropped open
    ctx.save(); ctx.translate(-2, 4.2); ctx.rotate(-0.5);
    teeth(() => [1.3, 1.9, 2.4, 2.5, 2.3, 2, 1.7, 1.4, 1.1].forEach((s, i) => tooth(-20.6 + i * 1.65, -0.6, s, -1)));
    const jaw = () => {
      ctx.beginPath();
      ctx.moveTo(1.8, -0.6);
      ctx.quadraticCurveTo(0.6, -1.7, -2, -1.3);
      ctx.quadraticCurveTo(-12, -0.5, -21.4, -1);
      ctx.quadraticCurveTo(-23.2, -0.6, -22.7, 0.9);
      ctx.quadraticCurveTo(-14, 3.3, -5, 3.9);
      ctx.quadraticCurveTo(0.6, 4, 1.8, -0.6);
      ctx.closePath();
    };
    jaw(); ctx.fillStyle = lit(-10, 1.4, 6, NEAR); ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 0.7; ctx.stroke();
    ctx.fillStyle = HOLE; ctx.beginPath(); ctx.ellipse(-4.6, 1.5, 2.2, 0.85, -0.05, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,248,226,0.5)'; ctx.lineWidth = 0.45;
    ctx.beginPath(); ctx.moveTo(-20.5, -0.4); ctx.quadraticCurveTo(-12, 0.3, -7.5, 0); ctx.stroke();
    ctx.restore();
    // Upper fangs along the tooth row, then the skull over their roots
    const row = (t) => [(1 - t) ** 2 * -24.2 + 2 * (1 - t) * t * -15 + t * t * -5.5, (1 - t) ** 2 * 1.2 + 2 * (1 - t) * t * 2.4 + t * t * 2.6];
    teeth(() => [1.5, 1.9, 2.9, 3.3, 3.2, 2.9, 2.6, 2.2, 1.8, 1.4].forEach((s, i) => {
      const [x, y] = row(0.04 + i * 0.096); tooth(x, y - 0.5, s + 0.4, 1);
    }));
    const skull = () => {
      ctx.beginPath();
      ctx.moveTo(0.8, -1.5);
      ctx.bezierCurveTo(1.6, -4.5, 0.5, -7.6, -2.5, -8.4);
      ctx.bezierCurveTo(-5, -9, -7.5, -8.6, -9, -8.9);
      ctx.lineTo(-9.9, -10); ctx.lineTo(-11.1, -8.5);
      ctx.bezierCurveTo(-15, -7.2, -20, -5.4, -23.4, -3.6);
      ctx.quadraticCurveTo(-25.4, -2.4, -25, -0.2);
      ctx.lineTo(-24.2, 1.2);
      ctx.quadraticCurveTo(-15, 2.4, -5.5, 2.6);
      ctx.lineTo(-3, 4.6); ctx.lineTo(-0.6, 4);
      ctx.quadraticCurveTo(1, 1.5, 0.8, -1.5);
      ctx.closePath();
    };
    skull(); ctx.fillStyle = lit(-12, -3, 10, NEAR); ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 0.8; ctx.stroke();
    // The windows through the skull: nostril, maxillary and antorbital
    // openings, the keyhole eye socket and the temporal opening behind it
    ctx.fillStyle = HOLE;
    ctx.beginPath();
    ctx.ellipse(-22.2, -2.2, 1.5, 0.8, -0.25, 0, Math.PI * 2);
    ctx.moveTo(-16.5, -1.6); ctx.ellipse(-17.4, -1.6, 0.9, 0.6, 0, 0, Math.PI * 2);
    ctx.moveTo(-15.6, -0.9); ctx.quadraticCurveTo(-13.2, -5.6, -9.4, -5.6); ctx.quadraticCurveTo(-8, -3, -8.4, -0.4); ctx.quadraticCurveTo(-12, 0.2, -15.6, -0.9);
    ctx.moveTo(-4.6, -5); ctx.ellipse(-6.2, -5, 1.6, 2.1, 0.15, 0, Math.PI * 2);
    ctx.moveTo(-5.3, -2.6); ctx.ellipse(-5.8, -2, 0.55, 1.3, 0.2, 0, Math.PI * 2);
    ctx.moveTo(-1.1, -3.4); ctx.ellipse(-2.6, -3.4, 1.5, 2.9, 0.22, 0, Math.PI * 2);
    ctx.fill();
    // Light catching the far rims of the openings, the nasal ridge and the
    // cheek bar; a couple of hairline cracks
    ctx.strokeStyle = 'rgba(255,248,226,0.6)'; ctx.lineWidth = 0.45;
    ctx.beginPath();
    ctx.moveTo(-14.6, -0.5); ctx.quadraticCurveTo(-11.6, 0, -8.8, -0.6);
    ctx.moveTo(-22.6, -4); ctx.bezierCurveTo(-18, -6, -14, -7.6, -10.6, -8.3);
    ctx.moveTo(-9.2, 0.6); ctx.quadraticCurveTo(-6, 0.9, -3.4, 1.7);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(92,62,28,0.5)'; ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(-19, -4.6); ctx.lineTo(-18.2, -3.4); ctx.lineTo(-18.8, -2.6); ctx.moveTo(-1.5, -7.2); ctx.lineTo(-0.6, -6); ctx.stroke();
    ctx.restore();

    // Sand drifted over the tail tip and the tucked foot
    this.drawSandDrift(55, -4.6, 9, 3.2);
    this.drawSandDusting([[52, -5, 10, 0.4], [31, 2.4, 8, 0.3], [-6, 3, 6, 0.18], [38, -8, 9, 0.14]]);
    ctx.restore();
  }

  // An anatomically complete skeleton sprawled on its back where it fell,
  // head to the left: skull rolled onto its side, a curving spine, a full
  // ribcage (ribs joined to the breastbone by greyer cartilage), collarbones
  // and shoulder blades, a butterfly pelvis, paired forearm/shin bones,
  // kneecaps and articulated hands and feet — one arm flung overhead, one
  // knee bent, every bone casting a soft shadow on the sand, and one foot
  // already half under a drift.
  drawPropSkeleton() {
    const ctx = this.ctx;
    const INK = 'rgba(58,44,22,0.62)', BONE = '#E6DBB8';
    ctx.save(); ctx.rotate(-0.05);

    // Joints for the pose
    const sh1 = [-14, -12.5], el1 = [-9.5, -21], wr1 = [-4.5, -27.8];
    const sh2 = [-14, 2.5], el2 = [-12.6, 11.4], wr2 = [-4.6, 14.2];
    const hp1 = [17.2, -8.2], kn1 = [29, -9.6], an1 = [39.6, -12.2];
    const hp2 = [17.2, -1.8], kn2 = [26, 6.4], an2 = [32.6, 15.2];

    // Soft contact shadows first, so every bone sits on the ground
    const shade = (pts, r) => {
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i], n = Math.ceil(Math.hypot(bx - ax, by - ay) / 2.5);
        for (let k = 0; k <= n; k++) {
          const x = ax + (bx - ax) * (k / n) + 0.9, y = ay + (by - ay) * (k / n) + 1.3;
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, 'rgba(24,14,6,0.2)'); g.addColorStop(1, 'rgba(24,14,6,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }
      }
    };
    shade([[-27, -5], [-16, -5], [13, -5]], 6);
    shade([[-12, -5], [-8, -5]], 9);
    shade([sh1, el1, wr1], 3); shade([sh2, el2, wr2], 3);
    shade([hp1, kn1, an1], 3.4); shade([hp2, kn2, an2], 3.4);
    shade([[13, -5], [18, -5]], 7);

    // Legs (under the pelvis)
    this.drawBone(...hp1, ...kn1, 1.75);
    this.drawBonePair(kn1[0] + 0.5, kn1[1], ...an1, 1.6);
    this.drawBoneDigits(an1[0] + 0.4, an1[1] - 0.2, -0.22, 1.6);
    this.drawBone(...hp2, ...kn2, 1.75);
    this.drawBonePair(kn2[0] + 0.3, kn2[1] + 0.5, ...an2, 1.6);
    this.drawBoneDigits(an2[0] + 0.2, an2[1] + 0.5, 1.05, 1.6);
    [kn1, kn2].forEach(([kx, ky]) => {
      ctx.fillStyle = INK; ctx.beginPath(); ctx.ellipse(kx, ky, 1.8, 1.45, 0, 0, Math.PI * 2); ctx.fill();
      const kg = ctx.createRadialGradient(kx - 0.4, ky - 0.4, 0.1, kx, ky, 1.4);
      kg.addColorStop(0, '#FBF5E4'); kg.addColorStop(1, '#C9BB93');
      ctx.fillStyle = kg; ctx.beginPath(); ctx.ellipse(kx, ky, 1.3, 1, 0, 0, Math.PI * 2); ctx.fill();
    });

    // Shoulder blades, peeking out from behind the ribcage
    [[-12.5, -11, -1], [-12.5, 1, 1]].forEach(([sx, sy, s]) => {
      ctx.beginPath(); ctx.moveTo(sx - 2.5, sy - s * 1.5); ctx.lineTo(sx + 3.8, sy - s * 2.8); ctx.quadraticCurveTo(sx + 2.6, sy + s * 0.6, sx + 1, sy + s * 2.5); ctx.closePath();
      ctx.fillStyle = 'rgba(214,202,170,0.9)'; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 0.6; ctx.stroke();
    });

    // Spine: cervical up to the skull, thoracic, then chunkier lumbar
    // vertebrae with their side wings
    for (let i = 0; i <= 16; i++) {
      const t = i / 16, vx = -21.5 + t * 35, vy = -5 - Math.sin(t * Math.PI) * 1.4, s = 0.8 + t * 0.7;
      ctx.fillStyle = INK; ctx.beginPath(); ctx.roundRect(vx - 1.2 * s, vy - 1.45 * s, 2.4 * s, 2.9 * s, 0.9 * s); ctx.fill();
      const vg = ctx.createLinearGradient(0, vy - 1.1 * s, 0, vy + 1.1 * s);
      vg.addColorStop(0, '#F6EFDA'); vg.addColorStop(1, '#C8BA92');
      ctx.fillStyle = vg; ctx.beginPath(); ctx.roundRect(vx - 0.9 * s, vy - 1.1 * s, 1.8 * s, 2.2 * s, 0.7 * s); ctx.fill();
      if (i > 11) {
        ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(vx, vy - 1.1 * s); ctx.lineTo(vx + 0.4, vy - 2.6 * s); ctx.moveTo(vx, vy + 1.1 * s); ctx.lineTo(vx + 0.4, vy + 2.6 * s); ctx.stroke();
        ctx.strokeStyle = '#DCD0AA'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(vx, vy - 1.1 * s); ctx.lineTo(vx + 0.4, vy - 2.6 * s); ctx.moveTo(vx, vy + 1.1 * s); ctx.lineTo(vx + 0.4, vy + 2.6 * s); ctx.stroke();
      }
    }

    // Ribcage: eight pairs fanning out from the breastbone and curling back
    // toward the spine, longest in the middle; the cartilage joining them to
    // the breastbone is greyer than the bone.
    const ribs = (part) => {
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const x = -15.2 + i * 2.15, len = 6.8 + Math.sin((i + 0.6) / 8 * Math.PI) * 2.6, back = 2.2 + i * 0.32;
        [-1, 1].forEach((s) => {
          const y0 = -5 + s * 0.9, mx = x + 0.6, my = -5 + s * len * 0.42;
          if (part === 'cart') { ctx.moveTo(x, y0); ctx.quadraticCurveTo(x - 0.3, -5 + s * len * 0.22, mx, my); }
          else { ctx.moveTo(mx, my); ctx.bezierCurveTo(x + 0.4, -5 + s * len * 0.82, x + back * 0.6, -5 + s * len * 1.04, x + back + 1.2, -5 + s * len * 0.86); }
        });
      }
    };
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(24,14,6,0.22)'; ctx.lineWidth = 2.4; ctx.save(); ctx.translate(0.6, 1); ribs('bone'); ctx.stroke(); ctx.restore();
    ctx.strokeStyle = INK; ctx.lineWidth = 2.1; ribs('bone'); ctx.stroke(); ribs('cart'); ctx.stroke();
    ctx.strokeStyle = '#C9C3AE'; ctx.lineWidth = 1.05; ribs('cart'); ctx.stroke();
    ctx.strokeStyle = '#EFE6CC'; ctx.lineWidth = 1.2; ribs('bone'); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.45; ribs('bone'); ctx.stroke();
    // Breastbone
    ctx.fillStyle = INK; ctx.beginPath(); ctx.roundRect(-16, -6.5, 12, 3, 1.3); ctx.fill();
    const st = ctx.createLinearGradient(0, -6.1, 0, -3.9);
    st.addColorStop(0, '#F6EFDA'); st.addColorStop(1, '#CDBF98');
    ctx.fillStyle = st; ctx.beginPath(); ctx.roundRect(-15.6, -6.1, 11.2, 2.2, 1); ctx.fill();
    // Collarbones
    this.drawBone(-16, -5.8, ...sh1, 0.75);
    this.drawBone(-16, -4.2, ...sh2, 0.75);

    // Pelvis: two iliac wings around the sacrum, hip sockets and the holes
    // of the obturator foramen
    const pelvis = () => {
      ctx.beginPath();
      ctx.moveTo(12, -5.6); ctx.bezierCurveTo(10.6, -10.4, 14, -14.4, 18.8, -12.8); ctx.bezierCurveTo(20.4, -10.6, 19.2, -8, 17, -7); ctx.closePath();
      ctx.moveTo(12, -4.4); ctx.bezierCurveTo(10.6, 0.4, 14, 4.4, 18.8, 2.8); ctx.bezierCurveTo(20.4, 0.6, 19.2, -2, 17, -3); ctx.closePath();
      ctx.moveTo(12.5, -6.7); ctx.lineTo(17.8, -5.6); ctx.lineTo(17.8, -4.4); ctx.lineTo(12.5, -3.3); ctx.closePath();
    };
    ctx.strokeStyle = INK; ctx.lineWidth = 1.3; pelvis(); ctx.stroke();
    const pg = ctx.createRadialGradient(14.6, -7.4, 1, 15, -5, 10);
    pg.addColorStop(0, '#F6EFDA'); pg.addColorStop(1, '#BBAD86');
    ctx.fillStyle = pg; pelvis(); ctx.fill();
    ctx.fillStyle = 'rgba(40,30,15,0.6)';
    [[17.2, -8.2], [17.2, -1.8]].forEach(([hx, hy]) => { ctx.beginPath(); ctx.arc(hx, hy, 1.3, 0, Math.PI * 2); ctx.fill(); });
    [[15.4, -10.4], [15.4, 0.4]].forEach(([ox, oy]) => { ctx.beginPath(); ctx.ellipse(ox, oy, 1.25, 0.85, 0, 0, Math.PI * 2); ctx.fill(); });
    ctx.fillStyle = 'rgba(40,30,15,0.35)';
    for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(14 + k * 1.3, -5.6 + (k % 2) * 0.1, 0.35, 0, Math.PI * 2); ctx.arc(14 + k * 1.3, -4.4, 0.35, 0, Math.PI * 2); ctx.fill(); }

    // Arms: one flung up overhead, the other bent at the side
    this.drawBone(...sh1, ...el1, 1.35);
    this.drawBonePair(...el1, ...wr1, 1.25);
    this.drawBoneDigits(wr1[0] + 0.2, wr1[1] - 0.5, -1.05, 1.35);
    this.drawBone(...sh2, ...el2, 1.3);
    this.drawBonePair(...el2, ...wr2, 1.2);
    this.drawBoneDigits(wr2[0] + 0.4, wr2[1], 0.15, 1.3);

    // Skull, rolled onto its side
    ctx.save(); ctx.translate(-26.2, -5); ctx.rotate(-1.35); ctx.scale(0.66, 0.66);
    this.drawSkullDetail();
    ctx.restore();
    ctx.restore();

    this.drawSandDrift(34.5, 16.5, 7.5, 3.6);
    this.drawSandDusting([[30, 10, 13, 0.32], [12, 2, 12, 0.16], [-6, -3, 10, 0.08]]);
  }

  // A drift of loose sand heaped over something half-buried: three
  // overlapping lumps that fade smoothly into the ground (no hard rim), lit
  // along the main crest, with a few loose grains.
  drawSandDrift(x, y, rx, ry) {
    const ctx = this.ctx;
    [[0, 0, 1], [-0.48, 0.18, 0.6], [0.52, 0.22, 0.52]].forEach(([ox, oy, k]) => {
      const r = rx * k;
      ctx.save(); ctx.translate(x + ox * rx, y + oy * ry); ctx.scale(1, ry / rx);
      const g = ctx.createRadialGradient(-r * 0.15, -r * 0.35, r * 0.05, 0, 0, r);
      g.addColorStop(0, 'rgba(180,138,86,0.97)'); g.addColorStop(0.45, 'rgba(148,108,64,0.82)'); g.addColorStop(1, 'rgba(112,80,46,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    });
    ctx.strokeStyle = 'rgba(236,202,150,0.32)'; ctx.lineWidth = Math.max(0.5, ry * 0.16); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.ellipse(x - rx * 0.05, y, rx * 0.5, ry * 0.5, 0, Math.PI * 1.15, Math.PI * 1.8); ctx.stroke();
    ctx.lineCap = 'butt';
    for (let i = 0; i < 6; i++) {
      const a = i * 2.4, d = (i % 3 + 1) / 4;
      ctx.fillStyle = i % 2 ? 'rgba(232,198,150,0.45)' : 'rgba(84,58,30,0.35)';
      ctx.beginPath(); ctx.arc(x + Math.cos(a) * rx * 0.55 * d, y + Math.sin(a) * ry * 0.45 * d, Math.max(0.3, ry * 0.07), 0, Math.PI * 2); ctx.fill();
    }
  }

  // A sun-bleached bull skull lying in the sand: a long face tapering to
  // the muzzle, deep eye sockets, the nasal cavity and sweeping horns that
  // darken toward their tips.
  drawPropCowSkull() {
    const ctx = this.ctx, INK = 'rgba(46,36,20,0.72)';
    ctx.save(); ctx.translate(0, -7); ctx.rotate(-0.1);
    [-1, 1].forEach((s) => {
      const hg = ctx.createLinearGradient(s * 4, -6, s * 19, -15);
      hg.addColorStop(0, '#EDE3CA'); hg.addColorStop(0.65, '#BFAA80'); hg.addColorStop(1, '#4E3F2A');
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.moveTo(s * 4, -6.8);
      ctx.bezierCurveTo(s * 10, -10.5, s * 15.5, -9.5, s * 19, -16);
      ctx.bezierCurveTo(s * 16.5, -10.5, s * 11, -5, s * 5, -3.4);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 0.6; ctx.stroke();
      ctx.strokeStyle = 'rgba(90,70,40,0.35)'; ctx.lineWidth = 0.4;
      ctx.beginPath();
      [0.3, 0.45, 0.6].forEach((t) => { const hx = s * (5 + t * 12), hy = -6 - t * 5; ctx.moveTo(hx, hy - 1.4); ctx.lineTo(hx + s * 0.8, hy + 1.2); });
      ctx.stroke();
    });
    const face = () => {
      ctx.beginPath();
      ctx.moveTo(-6, -7);
      ctx.quadraticCurveTo(0, -9.8, 6, -7);
      ctx.quadraticCurveTo(7.6, -3, 5.2, 0);
      ctx.quadraticCurveTo(3.5, 6, 2.7, 11);
      ctx.quadraticCurveTo(0, 12.6, -2.7, 11);
      ctx.quadraticCurveTo(-3.5, 6, -5.2, 0);
      ctx.quadraticCurveTo(-7.6, -3, -6, -7);
      ctx.closePath();
    };
    const fg = ctx.createRadialGradient(-1.6, -4, 0.8, 0, 1, 12);
    fg.addColorStop(0, '#FBF6E8'); fg.addColorStop(0.6, '#E4D9BD'); fg.addColorStop(1, '#A99A76');
    ctx.fillStyle = fg; face(); ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = 0.7; face(); ctx.stroke();
    [-1, 1].forEach((s) => {
      ctx.fillStyle = '#0D0B08';
      ctx.beginPath(); ctx.ellipse(s * 3.9, -2.2, 1.9, 1.5, s * 0.35, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.4;
      ctx.beginPath(); ctx.ellipse(s * 3.9, -2.2, 2.2, 1.8, s * 0.35, Math.PI * 1.1, Math.PI * 1.7); ctx.stroke();
    });
    ctx.fillStyle = '#16120C';
    ctx.beginPath(); ctx.moveTo(0, 3.4); ctx.quadraticCurveTo(1.6, 6.5, 0.9, 9.6); ctx.lineTo(-0.9, 9.6); ctx.quadraticCurveTo(-1.6, 6.5, 0, 3.4); ctx.fill();
    ctx.strokeStyle = 'rgba(90,72,44,0.45)'; ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(-1.5, -7.6); ctx.lineTo(-0.6, -5); ctx.lineTo(-1.4, -3.4); ctx.moveTo(2.4, 1); ctx.lineTo(3.2, 3.6); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.ellipse(-2.4, -6.4, 2.4, 1, -0.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    this.drawSandDrift(3, 6, 8, 2.6);
  }

  // A rider's memorial: a lashed wooden cross pushed into a mound of sand,
  // with a cracked helmet hung on the crossbar.
  drawPropGraveCross() {
    const ctx = this.ctx, INK = 'rgba(20,12,6,0.8)';
    const wood = ctx.createLinearGradient(-2, 0, 2, 0);
    wood.addColorStop(0, '#8A6440'); wood.addColorStop(0.5, '#6B4A2C'); wood.addColorStop(1, '#3E2A18');
    ctx.save(); ctx.rotate(0.06);
    ctx.fillStyle = wood; ctx.strokeStyle = INK; ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.roundRect(-1.7, -31, 3.4, 32, 0.6); ctx.fill(); ctx.stroke();
    const bar = ctx.createLinearGradient(0, -25, 0, -21.6);
    bar.addColorStop(0, '#8A6440'); bar.addColorStop(1, '#4A321E');
    ctx.fillStyle = bar;
    ctx.beginPath(); ctx.roundRect(-9, -25, 18, 3.4, 0.6); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(30,18,8,0.45)'; ctx.lineWidth = 0.35;
    ctx.beginPath();
    [-0.6, 0.5].forEach((gx) => { ctx.moveTo(gx, -29); ctx.lineTo(gx + 0.2, -2); });
    [-23.9, -22.6].forEach((gy) => { ctx.moveTo(-8, gy); ctx.lineTo(8, gy + 0.2); });
    ctx.stroke();
    ctx.strokeStyle = '#C9B48A'; ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let k = -1; k <= 1; k++) { ctx.moveTo(-2 + k * 0.4, -25.4); ctx.lineTo(2 + k * 0.4, -21.2); }
    ctx.moveTo(2.2, -25.4); ctx.lineTo(-2.2, -21.2);
    ctx.stroke();
    // The helmet, hanging from the right of the crossbar by its strap
    ctx.strokeStyle = '#1B1F27'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(6.5, -21.8); ctx.lineTo(6.8, -18.6); ctx.stroke();
    ctx.save(); ctx.translate(7, -14.4); ctx.rotate(0.2); ctx.scale(0.62, 0.62);
    const helmet = () => {
      ctx.beginPath();
      ctx.moveTo(-4.8, 1.5); ctx.bezierCurveTo(-5.8, -4.5, -1.5, -6.6, 2.8, -5.6);
      ctx.lineTo(5.6, -3.6); ctx.lineTo(6.2, -0.4); ctx.quadraticCurveTo(8.6, 1.6, 8.2, 3.8);
      ctx.lineTo(4.6, 5.4); ctx.quadraticCurveTo(0.5, 5.6, -2.6, 4.2); ctx.closePath();
    };
    const shell = ctx.createRadialGradient(-1.6, -3, 0.6, 0, 0, 8);
    shell.addColorStop(0, '#FFFFFF'); shell.addColorStop(0.7, '#DCE2EA'); shell.addColorStop(1, '#9AA6B6');
    ctx.fillStyle = shell; helmet(); ctx.fill();
    ctx.save(); helmet(); ctx.clip();
    ctx.fillStyle = LIVERY.main;
    ctx.beginPath(); ctx.moveTo(-6, -2.6); ctx.lineTo(7, -4.4); ctx.lineTo(7, -2.6); ctx.lineTo(-6, -0.6); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#14223F'; ctx.beginPath(); ctx.arc(-5.2, 2.2, 3.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    helmet(); ctx.strokeStyle = 'rgba(4,8,16,0.85)'; ctx.lineWidth = 0.7; ctx.stroke();
    ctx.strokeStyle = 'rgba(20,14,8,0.75)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(-3.6, -3.6); ctx.lineTo(-1.4, -1.2); ctx.lineTo(-2.2, 1.4); ctx.stroke();
    ctx.fillStyle = '#1B1F27'; ctx.beginPath(); ctx.roundRect(1.9, -3.3, 4.7, 3, 1.2); ctx.fill();
    ctx.fillStyle = '#FF9A2E'; ctx.beginPath(); ctx.roundRect(2.5, -2.8, 3.8, 2, 0.8); ctx.fill();
    ctx.restore();
    ctx.restore();
    this.drawSandDrift(0, 1.5, 9, 3.2);
  }

  // A pair of desert boulders with a dry tuft of grass between them.
  drawPropRocks() {
    const ctx = this.ctx;
    const boulder = (x, y, w, h, flip) => {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(x + w * 0.2, y + 0.6, w * 1.1, h * 0.28, 0, 0, Math.PI * 2); ctx.fill();
      const g = ctx.createLinearGradient(x - w, y - h * 2, x + w * 0.8, y);
      g.addColorStop(0, '#A8957A'); g.addColorStop(0.5, '#73624C'); g.addColorStop(1, '#3A3024');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x - w, y);
      ctx.bezierCurveTo(x - w * 1.05, y - h * 1.2, x - w * 0.3 * flip, y - h * 2.1, x + w * 0.25, y - h * 1.9);
      ctx.bezierCurveTo(x + w * 0.95, y - h * 1.6, x + w * 1.05, y - h * 0.5, x + w, y);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(30,22,14,0.6)'; ctx.lineWidth = 0.6; ctx.stroke();
      ctx.strokeStyle = 'rgba(30,22,14,0.4)'; ctx.lineWidth = 0.45;
      ctx.beginPath(); ctx.moveTo(x - w * 0.1, y - h * 1.7); ctx.lineTo(x + w * 0.15, y - h * 1.1); ctx.lineTo(x - w * 0.05, y - h * 0.6); ctx.stroke();
      ctx.fillStyle = 'rgba(255,238,206,0.2)';
      ctx.beginPath(); ctx.ellipse(x - w * 0.3, y - h * 1.5, w * 0.4, h * 0.3, -0.4, 0, Math.PI * 2); ctx.fill();
    };
    boulder(-5, 1, 8, 4.4, 1);
    ctx.strokeStyle = '#A99257'; ctx.lineWidth = 0.6; ctx.lineCap = 'round';
    ctx.beginPath();
    for (let k = -3; k <= 3; k++) { ctx.moveTo(3 + k * 0.5, 1.4); ctx.quadraticCurveTo(3 + k * 1.1, -2, 3 + k * 1.9, -4.5 + Math.abs(k) * 0.6); }
    ctx.stroke(); ctx.lineCap = 'butt';
    boulder(7, 2, 5.2, 2.8, -1);
    this.drawSandDrift(0, 2.4, 12, 2.2);
  }

  // A thin, uneven dusting of sand across a mostly-buried full skeleton —
  // each patch is a soft radial gradient, denser toward the "buried" end
  // (feet/tail) and thin-to-none over the exposed end (skull/reaching hand)
  // — so the whole shape still reads through the ground rather than
  // vanishing under a hard, opaque mound.
  drawSandDusting(patches) {
    const ctx = this.ctx;
    patches.forEach(([px, py, pr, op]) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, pr);
      g.addColorStop(0, `rgba(138,100,58,${op})`);
      g.addColorStop(0.6, `rgba(138,100,58,${op * 0.65})`);
      g.addColorStop(1, 'rgba(138,100,58,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
    });
  }

  // ── Biker — wheel & suspension helpers ──────────────────────────────────
  // An MX wheel: knobby tyre (tread that rotates with the wheel), a gold
  // anodised rim, laced wire spokes that blur out at speed, and a brake disc.
  // `spin` is an absolute angle derived from the bike's world position, so
  // rotation always matches ground speed with no drift and no extra state.
  drawWheel(cx, cy, wr, spin, crash = false, blurT = 0) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(cx, cy);

    const tyre = ctx.createRadialGradient(-wr * 0.3, -wr * 0.3, wr * 0.2, 0, 0, wr);
    tyre.addColorStop(0, crash ? '#3A2A1A' : '#2A2E36');
    tyre.addColorStop(0.7, crash ? '#1E140A' : '#15181E');
    tyre.addColorStop(1, '#07080B');
    ctx.fillStyle = tyre;
    ctx.beginPath(); ctx.arc(0, 0, wr, 0, Math.PI * 2); ctx.fill();

    const knobs = 18, half = (Math.PI / knobs) * 0.55, r0 = wr - 0.6, r1 = wr + 1.1;
    ctx.fillStyle = crash ? '#2A1C10' : '#0B0D11';
    ctx.beginPath();
    for (let k = 0; k < knobs; k++) {
      const a = spin + (k / knobs) * Math.PI * 2;
      ctx.moveTo(Math.cos(a - half) * r0, Math.sin(a - half) * r0);
      ctx.lineTo(Math.cos(a - half) * r1, Math.sin(a - half) * r1);
      ctx.lineTo(Math.cos(a + half) * r1, Math.sin(a + half) * r1);
      ctx.lineTo(Math.cos(a + half) * r0, Math.sin(a + half) * r0);
      ctx.closePath();
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, wr * 0.86, 0, Math.PI * 2); ctx.stroke();

    const rimR = wr * 0.74;
    ctx.strokeStyle = crash ? '#6B5426' : '#E8B53A'; ctx.lineWidth = Math.max(1.2, wr * 0.11);
    ctx.beginPath(); ctx.arc(0, 0, rimR, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.arc(0, 0, rimR, Math.PI * 1.1, Math.PI * 1.6); ctx.stroke();

    ctx.strokeStyle = `rgba(205,212,224,${0.6 * (1 - blurT * 0.7)})`; ctx.lineWidth = 0.55;
    ctx.beginPath();
    for (let s = 0; s < 16; s++) {
      const a = spin + (s / 16) * Math.PI * 2, a2 = a + (s % 2 ? 0.35 : -0.35);
      ctx.moveTo(Math.cos(a2) * wr * 0.14, Math.sin(a2) * wr * 0.14);
      ctx.lineTo(Math.cos(a) * rimR, Math.sin(a) * rimR);
    }
    ctx.stroke();
    if (blurT > 0.04) {
      ctx.fillStyle = `rgba(190,200,215,${0.16 * blurT})`;
      ctx.beginPath(); ctx.arc(0, 0, rimR - 0.6, 0, Math.PI * 2); ctx.fill();
    }

    ctx.fillStyle = crash ? '#4A4036' : '#8D96A6';
    ctx.beginPath(); ctx.arc(0, 0, wr * 0.36, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.arc(0, 0, wr * 0.24, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#D5DCE6';
    ctx.beginPath(); ctx.arc(0, 0, Math.max(1.2, wr * 0.14), 0, Math.PI * 2); ctx.fill();

    // Motion-blur streaks trailing the spin direction at speed
    if (blurT > 0.04) {
      ctx.save(); ctx.rotate(spin);
      ctx.strokeStyle = `rgba(255,255,255,${0.22 * blurT})`; ctx.lineWidth = wr * 0.16; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(0, 0, wr * 0.86, -1.05, -0.25); ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${0.12 * blurT})`; ctx.lineWidth = wr * 0.1;
      ctx.beginPath(); ctx.arc(0, 0, wr * 0.86, -1.6, -1.15); ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  // A compressed-zigzag suspension spring between two points — a cheap but
  // convincing coil at this scale, shared by the rear shock and used as a
  // visual accent near the fork.
  drawSpring(x1, y1, x2, y2, coils, width, color) {
    const ctx = this.ctx;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const ang = Math.atan2(y2 - y1, x2 - x1);
    ctx.save();
    ctx.translate(x1, y1); ctx.rotate(ang);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(0, 0);
    const steps = coils * 2, seg = len / steps;
    for (let i = 1; i <= steps; i++) ctx.lineTo(seg * i, (i % 2 === 0 ? 1 : -1) * width * 1.15);
    ctx.lineTo(len, 0);
    ctx.stroke();
    ctx.restore();
  }

  // Modern MX bike + rider in the brand palette, facing right, with the origin
  // at the bike's centre and the tyre contact patch at y ≈ +21.
  drawMotoRider(ts) {
    const ctx = this.ctx;
    const KIT = LIVERY.main, KIT_D = LIVERY.dark, NAVY = '#14223F', WHITE = '#F4F7FB', GOLD = '#E8B53A', INK = 'rgba(4,8,16,0.88)';
    const R = 11.5;
    const flying = this.phase === 'flying';
    const ramp = this.phase === 'ramp';
    // Suspension loads up through the ramp and breathes gently in the air.
    const sag = ramp ? Math.sin(this.rampT * Math.PI) * 2.6 : flying ? -1.4 + Math.sin(ts * 0.005) * 0.6 : 0;
    // The rider crouches into the ramp and stands up off the seat once airborne.
    const lift = flying ? 3 + Math.sin(ts * 0.005) * 0.8 : ramp ? -1.2 * Math.sin(this.rampT * Math.PI) : 0;
    const rear = { x: -15, y: 9.5 + sag * 0.4 }, front = { x: 17, y: 9.5 + sag * 0.2 };
    const blurT = flying ? Math.min(1, this.mult / 5) : ramp ? this.rampT : 0;

    const shape = (pts) => {
      ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath();
    };
    const ink = (w = 0.9) => { ctx.strokeStyle = INK; ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.stroke(); };
    const limb = (pts, w, color) => {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = INK; ctx.lineWidth = w + 1.8; ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke();
    };

    // ── Rider anatomy helpers ──
    // Two-bone IK: where the middle joint sits for bones l1/l2 reaching from
    // `a` toward `b`; `bend` (±1) picks which side the joint folds to. If `b`
    // is out of reach the limb just extends fully toward it.
    const ik = (a, b, l1, l2, bend) => {
      const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy) || 0.001;
      const ux = dx / dist, uy = dy / dist, d = Math.min(dist, l1 + l2 - 0.01);
      const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, l1 * l1 - along * along)) * bend;
      const joint = { x: a.x + ux * along - uy * h, y: a.y + uy * along + ux * h };
      const ex = b.x - joint.x, ey = b.y - joint.y, el = Math.hypot(ex, ey) || 1;
      return [joint, { x: joint.x + (ex / el) * l2, y: joint.y + (ey / el) * l2 }];
    };
    // A tapered, shaded limb segment (radius ra at `a`, rb at `b`) — darker
    // underneath and catching a thin highlight on top, so it reads as round.
    const capsule = (a, b, ra, rb, fill, shade = 'rgba(0,0,0,0.26)') => {
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L, ny = dx / L, angN = Math.atan2(ny, nx);
      ctx.beginPath();
      ctx.moveTo(a.x + nx * ra, a.y + ny * ra);
      ctx.lineTo(b.x + nx * rb, b.y + ny * rb);
      ctx.arc(b.x, b.y, rb, angN, angN + Math.PI, true);
      ctx.lineTo(a.x - nx * ra, a.y - ny * ra);
      ctx.arc(a.x, a.y, ra, angN + Math.PI, angN, true);
      ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      const dn = ny >= 0 ? 1 : -1;
      ctx.save(); ctx.clip();
      ctx.lineCap = 'round';
      ctx.strokeStyle = shade; ctx.lineWidth = Math.max(ra, rb) * 1.1;
      ctx.beginPath();
      ctx.moveTo(a.x + nx * dn * ra * 0.95, a.y + ny * dn * ra * 0.95); ctx.lineTo(b.x + nx * dn * rb * 0.95, b.y + ny * dn * rb * 0.95);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(a.x - nx * dn * ra * 0.6, a.y - ny * dn * ra * 0.6); ctx.lineTo(b.x - nx * dn * rb * 0.6, b.y - ny * dn * rb * 0.6);
      ctx.stroke();
      ctx.restore();
      ink(0.8);
    };
    // Tall MX boot built in the shin's own frame, so the foot always points
    // the right way whether it's on the peg or stretched out behind.
    const boot = (knee, ankle, fill, buckle) => {
      const vl = Math.hypot(ankle.x - knee.x, ankle.y - knee.y) || 1;
      const v = { x: (ankle.x - knee.x) / vl, y: (ankle.y - knee.y) / vl }, f = { x: v.y, y: -v.x };
      const p = (sv, sf) => [ankle.x + v.x * sv + f.x * sf, ankle.y + v.y * sv + f.y * sf];
      ctx.fillStyle = fill;
      shape([...p(-4.8, -2.3), ...p(-4.8, 2.0), ...p(0, 2.2), ...p(1.4, 5.0), ...p(3.2, 5.2), ...p(3.2, -2.6), ...p(1.0, -2.7)]);
      ctx.fill(); ink(0.8);
      ctx.strokeStyle = buckle; ctx.lineWidth = 0.7;
      ctx.beginPath();
      [-3.6, -2.0, -0.4].forEach((sv) => { ctx.moveTo(...p(sv, -2.2)); ctx.lineTo(...p(sv + 0.2, 2.0)); });
      ctx.stroke();
      ctx.strokeStyle = '#1B1F27'; ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(...p(3.2, -2.6)); ctx.lineTo(...p(3.2, 5.2)); ctx.stroke();
    };

    // ── Rider pose ──
    // Riding pose, blended toward the current air trick's pose (if any).
    const mixPt = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const tr = this.trickState(ts), pose = TRICK_POSES[tr.kind], e = pose ? tr.env : 0;
    const bob = pose && pose.float ? Math.sin(tr.p * Math.PI) * pose.float * e : 0;
    const toward = (key, base) => (pose && pose[key] ? mixPt(base, { x: pose[key][0], y: pose[key][1] - bob }, e) : base);
    const grip = { x: 6.2, y: -18.6 }, farGrip = { x: 6.9, y: -19.3 };
    const hip = toward('hip', { x: -9.5, y: -15 - lift * 0.9 });
    const shoulder = toward('shoulder', { x: -1.5, y: -28.5 - lift * 0.6 });
    const footTarget = toward('foot', { x: -2.5, y: 3 });
    const farFootTarget = pose && pose.farFoot ? toward('farFoot', { x: -1.5, y: 2.5 }) : { x: footTarget.x + 1, y: footTarget.y - 0.5 };
    const handTarget = toward('hand', grip), farHandTarget = toward('farHand', farGrip);
    const [knee, ankle] = ik(hip, footTarget, 12.4, 11, -1);
    const [elbow, hand] = ik(shoulder, handTarget, 7.6, 7.4, 1);
    this._riderC = mixPt(hip, shoulder, 0.5);

    this.drawWheel(rear.x, rear.y, R, this.bx / R, false, blurT);
    this.drawWheel(front.x, front.y, R, this.bx / R, false, blurT);

    // Chain + rear sprocket
    ctx.strokeStyle = '#3A4252'; ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(-2, 3.2); ctx.lineTo(rear.x, rear.y - 3.6);
    ctx.moveTo(-2, 6.8); ctx.lineTo(rear.x, rear.y + 3.6);
    ctx.stroke();
    ctx.strokeStyle = '#9AA3B2'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(rear.x, rear.y, 3.6, 0, Math.PI * 2); ctx.stroke();

    // Tapered aluminium swingarm
    const arm = ctx.createLinearGradient(0, -1, 0, 6);
    arm.addColorStop(0, '#DCE2EA'); arm.addColorStop(1, '#7C8594');
    ctx.fillStyle = arm;
    shape([-2.5, 1.6, rear.x + 1.5, rear.y - 2, rear.x + 1.5, rear.y + 1.4, -2.5, 6]);
    ctx.fill(); ink(0.8);

    this.drawSpring(-6, -9, -9.5, 3, 5, 1.5, GOLD);

    // Far-side arm and leg, in shadow behind the bike's bodywork
    const farHip = { x: hip.x + 1.2, y: hip.y - 0.6 }, farShoulder = { x: shoulder.x + 1.6, y: shoulder.y - 0.6 };
    const [farKnee, farAnkle] = ik(farHip, farFootTarget, 12.4, 11, -1);
    const [farElbow, farHand] = ik(farShoulder, farHandTarget, 7.6, 7.4, 1);
    capsule(farHip, farKnee, 3.4, 2.6, '#0C1528');
    capsule(farKnee, farAnkle, 2.4, 1.9, '#0C1528');
    boot(farKnee, farAnkle, '#9AA4B4', '#5B6475');
    capsule(farShoulder, farElbow, 2.1, 1.8, LIVERY.far);
    capsule(farElbow, farHand, 1.7, 1.5, LIVERY.farDark);
    ctx.fillStyle = '#0C1528'; ctx.beginPath(); ctx.arc(farHand.x, farHand.y, 1.7, 0, Math.PI * 2); ctx.fill();

    // Silencer angled up under the tail, with a throttle flame at the tip
    ctx.lineCap = 'round';
    ctx.strokeStyle = INK; ctx.lineWidth = 6.4;
    ctx.beginPath(); ctx.moveTo(-9, -5); ctx.lineTo(-23.5, -9.5); ctx.stroke();
    const can = ctx.createLinearGradient(0, -10, 0, -3);
    can.addColorStop(0, '#F2F5F9'); can.addColorStop(1, '#8D96A6');
    ctx.strokeStyle = can; ctx.lineWidth = 4.6;
    ctx.beginPath(); ctx.moveTo(-9, -5); ctx.lineTo(-23.5, -9.5); ctx.stroke();
    ctx.lineCap = 'butt'; ctx.strokeStyle = '#1B1F27';
    ctx.beginPath(); ctx.moveTo(-22, -9); ctx.lineTo(-24.6, -9.8); ctx.stroke();
    const gunningIt = ramp || (flying && Math.sin(ts * 0.011 + this.roundNum) > 0.55);
    if (gunningIt) {
      const flick = 0.6 + Math.sin(ts * 0.05) * 0.4, fr = (flying ? 2.4 : 3.6) * flick + 1;
      const flame = ctx.createRadialGradient(-26.5, -10.3, 0, -26.5, -10.3, fr);
      flame.addColorStop(0, 'rgba(255,240,170,0.95)'); flame.addColorStop(0.5, 'rgba(255,140,30,0.75)'); flame.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = flame; ctx.beginPath(); ctx.arc(-26.5, -10.3, fr, 0, Math.PI * 2); ctx.fill();
    }

    // Frame rails
    ctx.strokeStyle = '#AEB7C4'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-4, -10); ctx.lineTo(-4.5, 2.5);
    ctx.moveTo(8, -9); ctx.lineTo(5, 3);
    ctx.stroke();

    // Engine: cases, finned cylinder, polished clutch cover
    const eng = ctx.createLinearGradient(0, -6, 0, 6);
    eng.addColorStop(0, '#465066'); eng.addColorStop(1, '#1C222E');
    ctx.fillStyle = eng;
    ctx.beginPath(); ctx.roundRect(-6.5, -5, 12.5, 10.5, 2.5); ctx.fill(); ink(0.8);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let f = 0; f < 3; f++) { ctx.moveTo(-0.5 + f * 1.8, -4.6); ctx.lineTo(1.2 + f * 1.8, -1.6); }
    ctx.stroke();
    ctx.fillStyle = '#B9C2CF'; ctx.beginPath(); ctx.arc(-1.5, 2, 3, 0, Math.PI * 2); ctx.fill(); ink(0.6);
    ctx.fillStyle = '#5B6475'; ctx.beginPath(); ctx.arc(-1.5, 2, 1.2, 0, Math.PI * 2); ctx.fill();

    // Rear fender
    const fend = ctx.createLinearGradient(0, -16, 0, -8);
    fend.addColorStop(0, '#FFFFFF'); fend.addColorStop(1, '#C9D2DE');
    ctx.fillStyle = fend;
    shape([-12, -11.5, -31, -15.5, -30, -13, -15, -8]);
    ctx.fill(); ink();

    // Side number plate
    ctx.fillStyle = WHITE;
    shape([-5.5, -11, -17.5, -10.6, -15.5, -3.8, -6.5, -4.2]);
    ctx.fill(); ink();
    ctx.fillStyle = NAVY; ctx.font = `italic 800 6px ${FONT_NUM}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('42', -11, -7.2);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

    // Seat
    ctx.fillStyle = '#121826';
    shape([-1.5, -14, -21, -12.2, -22, -10.6, -2, -11.4]);
    ctx.fill(); ink(0.8);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(-3, -13.4); ctx.lineTo(-19.5, -12); ctx.stroke();

    // Tank + radiator shroud with livery
    const shroud = ctx.createLinearGradient(0, -15, 0, 0);
    shroud.addColorStop(0, LIVERY.light); shroud.addColorStop(0.5, KIT); shroud.addColorStop(1, KIT_D);
    ctx.fillStyle = shroud;
    shape([8.5, -13.5, -2.5, -14, -4, -8, 0.5, -1.5, 7.5, -3.5]);
    ctx.fill(); ink();
    ctx.fillStyle = WHITE;
    shape([7.5, -10.5, 0.5, -9.2, -1.2, -6.4, 6.6, -7.6]);
    ctx.fill();
    ctx.fillStyle = NAVY;
    shape([6.8, -6.4, 1.2, -5.2, 1.8, -3, 6.6, -4.4]);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(7.5, -13); ctx.lineTo(-1.5, -13.4); ctx.stroke();

    // Upside-down fork: dark outer tubes up top, gold inner legs at the axle
    const fx0 = 8.5, fy0 = -13;
    const fmx = fx0 + (front.x - fx0) * 0.5, fmy = fy0 + (front.y - fy0) * 0.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = INK; ctx.lineWidth = 4.6;
    ctx.beginPath(); ctx.moveTo(fx0, fy0); ctx.lineTo(front.x, front.y); ctx.stroke();
    ctx.strokeStyle = '#2B3344'; ctx.lineWidth = 3.2;
    ctx.beginPath(); ctx.moveTo(fx0, fy0); ctx.lineTo(fmx, fmy); ctx.stroke();
    ctx.strokeStyle = GOLD; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(fmx, fmy); ctx.lineTo(front.x, front.y); ctx.stroke();
    ctx.fillStyle = '#C9D1DC'; ctx.beginPath(); ctx.arc(front.x, front.y, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#AEB7C4';
    ctx.beginPath(); ctx.roundRect(fx0 - 2.5, fy0 - 1.5, 5, 2.8, 1); ctx.fill(); ink(0.6);

    // Front fender, riding just clear of the tyre
    ctx.fillStyle = WHITE;
    shape([11, -7, 28, -5.6, 27, -4, 12.5, -4.6]);
    ctx.fill(); ink(0.8);
    ctx.fillStyle = KIT;
    shape([17, -6.6, 28, -5.6, 27.6, -4.9, 17.4, -5.6]);
    ctx.fill();

    // Front number plate + handlebar
    ctx.fillStyle = WHITE;
    shape([10, -16.5, 13.8, -14.6, 12.8, -8.6, 10.2, -9.4]);
    ctx.fill(); ink(0.7);
    ctx.fillStyle = KIT;
    shape([10.4, -11.6, 13.2, -11, 12.9, -9.6, 10.3, -10.2]);
    ctx.fill();
    limb([{ x: 8.5, y: -14.5 }, grip], 1.6, '#1B1F27');

    // ── Rider (near side) ──
    // Leg: tapered thigh and calf, knee brace, white side stripe, tall boot
    capsule(hip, knee, 3.6, 2.8, NAVY);
    ctx.strokeStyle = 'rgba(244,247,251,0.55)'; ctx.lineWidth = 0.7; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(hip.x + 0.6, hip.y - 1.6); ctx.lineTo(knee.x - 0.4, knee.y - 1.4); ctx.stroke();
    capsule(knee, ankle, 2.6, 2.0, NAVY);
    capsule(knee, mixPt(knee, ankle, 0.42), 3.0, 2.5, '#1B2433');
    ctx.fillStyle = KIT;
    ctx.beginPath(); ctx.arc(knee.x, knee.y, 1.3, 0, Math.PI * 2); ctx.fill();
    boot(knee, ankle, WHITE, '#8D96A6');

    // Torso: rounded back and chest leaning into the attack position, a navy
    // chest protector up front and a white stripe down the side
    const tl = Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y) || 1;
    const tu = { x: (shoulder.x - hip.x) / tl, y: (shoulder.y - hip.y) / tl }, tn = { x: -tu.y, y: tu.x };
    const at = (base, along, side) => ({ x: base.x + tu.x * along + tn.x * side, y: base.y + tu.y * along + tn.y * side });
    const lowBack = at(hip, -0.4, -3.4), upBack = at(shoulder, -0.8, -3.6), top = at(shoulder, 1.8, 0.2);
    const chest = at(shoulder, -1.2, 3.4), belly = at(hip, 1.6, 3.6), backBulge = at(mixPt(hip, shoulder, 0.6), 0, -5);
    const jersey = ctx.createLinearGradient(shoulder.x, shoulder.y, hip.x, hip.y);
    jersey.addColorStop(0, LIVERY.light); jersey.addColorStop(0.45, KIT); jersey.addColorStop(1, KIT_D);
    ctx.fillStyle = jersey;
    ctx.beginPath();
    ctx.moveTo(lowBack.x, lowBack.y);
    ctx.quadraticCurveTo(backBulge.x, backBulge.y, upBack.x, upBack.y);
    ctx.quadraticCurveTo(top.x - tn.x * 2, top.y - tn.y * 2, top.x, top.y);
    ctx.quadraticCurveTo(chest.x + tu.x * 1.6, chest.y + tu.y * 1.6, chest.x, chest.y);
    ctx.lineTo(belly.x, belly.y);
    ctx.quadraticCurveTo(hip.x + tn.x * 2.2, hip.y + tn.y * 2.2, lowBack.x, lowBack.y);
    ctx.closePath();
    ctx.fill(); ink();
    ctx.fillStyle = NAVY;
    const pc = at(shoulder, -2, 1.4), pb = at(hip, 2.4, 1.6);
    shape([pc.x, pc.y, chest.x - tn.x * 0.4, chest.y - tn.y * 0.4, belly.x - tn.x * 0.6, belly.y - tn.y * 0.6, pb.x, pb.y]);
    ctx.fill();
    ctx.strokeStyle = 'rgba(244,247,251,0.7)'; ctx.lineWidth = 0.8;
    const s0 = at(hip, 1, -1.2), s1 = at(shoulder, -2.2, -1.4);
    ctx.beginPath(); ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y); ctx.stroke();

    // Neck brace
    const nb = at(shoulder, 1.4, 0.8);
    ctx.save(); ctx.translate(nb.x, nb.y); ctx.rotate(Math.atan2(tu.y, tu.x) + Math.PI / 2);
    ctx.fillStyle = '#1B1F27';
    ctx.beginPath(); ctx.ellipse(0, 0, 2.8, 1.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = KIT; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.ellipse(0, 0, 2.8, 1.6, 0, Math.PI, Math.PI * 2); ctx.stroke();
    ctx.restore();

    // Arm: upper arm with a sleeve stripe, elbow guard, forearm and glove
    capsule(shoulder, elbow, 2.3, 1.9, KIT);
    ctx.strokeStyle = 'rgba(244,247,251,0.75)'; ctx.lineWidth = 0.7;
    const ss = mixPt(shoulder, elbow, 0.55);
    ctx.beginPath(); ctx.moveTo(ss.x - 1.6, ss.y + 0.4); ctx.lineTo(ss.x + 1.6, ss.y - 0.6); ctx.stroke();
    capsule(elbow, hand, 1.85, 1.6, KIT_D);
    ctx.fillStyle = '#1B2433';
    ctx.beginPath(); ctx.arc(elbow.x, elbow.y, 1.7, 0, Math.PI * 2); ctx.fill(); ink(0.6);
    ctx.fillStyle = NAVY;
    ctx.beginPath(); ctx.arc(hand.x, hand.y, 1.9, 0, Math.PI * 2); ctx.fill(); ink(0.6);
    ctx.fillStyle = KIT; ctx.fillRect(hand.x - 0.4, hand.y - 1.6, 1.8, 0.9);

    // Helmet: an MX shell with a long chin bar, peak, vents, livery and
    // mirrored goggles on a strap — sized to the body, not a ball head. It
    // sits on the neck and turns with the torso, so it tips upside down in a
    // handstand and lies back in a lazy boy; the neck soaks up the first
    // ~35° either way, keeping the head level when the rider stands up.
    const c = at(shoulder, 6.8, 0.86);
    const turn = Math.atan2(tu.y, tu.x) - RIDE_TORSO;
    ctx.save();
    ctx.translate(c.x, c.y); ctx.rotate(turn - Math.max(-0.6, Math.min(0.6, turn))); ctx.scale(0.86, 0.86);
    const helmet = () => {
      ctx.beginPath();
      ctx.moveTo(-4.8, 1.5);
      ctx.bezierCurveTo(-5.8, -4.5, -1.5, -6.6, 2.8, -5.6);
      ctx.lineTo(5.6, -3.6); ctx.lineTo(6.2, -0.4);
      ctx.quadraticCurveTo(8.6, 1.6, 8.2, 3.8);
      ctx.lineTo(4.6, 5.4);
      ctx.quadraticCurveTo(0.5, 5.6, -2.6, 4.2);
      ctx.closePath();
    };
    const shell = ctx.createRadialGradient(-1.6, -3, 0.6, 0, 0, 8);
    shell.addColorStop(0, '#FFFFFF'); shell.addColorStop(0.7, '#E3E9F1'); shell.addColorStop(1, '#A9B5C5');
    ctx.fillStyle = shell; helmet(); ctx.fill();
    ctx.save(); helmet(); ctx.clip();
    ctx.fillStyle = KIT;
    ctx.beginPath(); ctx.moveTo(-6, -2.6); ctx.lineTo(7, -4.4); ctx.lineTo(7, -2.6); ctx.lineTo(-6, -0.6); ctx.closePath(); ctx.fill();
    ctx.fillStyle = NAVY;
    ctx.beginPath(); ctx.arc(-5.2, 2.2, 3.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(1, 4.6, 6, 1.8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    helmet(); ink();
    ctx.fillStyle = '#1B1F27';
    [[6.3, 2.1], [6.9, 3.4]].forEach(([vx, vy]) => { ctx.beginPath(); ctx.roundRect(vx, vy, 1.4, 0.6, 0.3); ctx.fill(); });
    ctx.fillStyle = KIT;
    shape([-1.6, -6.1, 9, -6.5, 8.2, -4.6, 3.2, -4.4]);
    ctx.fill(); ink(0.7);
    ctx.strokeStyle = '#1B1F27'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(2, -1.9); ctx.lineTo(-5.4, -1.2); ctx.stroke();
    ctx.fillStyle = '#1B1F27';
    ctx.beginPath(); ctx.roundRect(1.9, -3.3, 4.7, 3, 1.2); ctx.fill();
    const lens = ctx.createLinearGradient(2.2, -3, 6.4, -0.6);
    lens.addColorStop(0, '#FFE08A'); lens.addColorStop(0.5, '#FF9A2E'); lens.addColorStop(1, '#E2442A');
    ctx.fillStyle = lens;
    ctx.beginPath(); ctx.roundRect(2.5, -2.8, 3.8, 2, 0.8); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(3, -2.3); ctx.lineTo(4.6, -2.5); ctx.stroke();
    ctx.restore();
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
  }

  // ── Biker ─────────────────────────────────────────────────────────────────
  drawBiker(x, y, crash, ts) {
    const ctx = this.ctx;
    ctx.save(); ctx.translate(x, y);
    if (!crash) {
      let angle = 0;
      if (this.phase === 'ramp') { const r = this.getRamp(), tn = bt(r.P0, r.P1, r.P2, this.rampT); angle = Math.atan2(tn.y, tn.x); }
      else if (this.phase === 'flying') angle = Math.atan2(this.bvy, Math.max(this.bvx, .1)) * .45;
      // Flips rotate the whole bike + rider (eased so they snap round in the
      // middle of the window and settle level for the landing).
      const tr = this.trickState(ts);
      const baseAngle = angle;
      const flipAt = (p) => tr.flip * Math.PI * 2 * (p * p * (3 - 2 * p));
      if (tr.flip) angle += flipAt(tr.p);
      ctx.scale(BIKE_SCALE, BIKE_SCALE);
      const spinning = tr.flip && tr.p > 0 && tr.p < 1;
      if (spinning) {
        this.drawFlipSwoosh(angle, Math.sign(tr.flip), tr.env);
        // Fading afterimages trailing the rotation
        for (let k = 3; k >= 1; k--) {
          ctx.save(); ctx.globalAlpha = 0.15 / k; ctx.rotate(baseAngle + flipAt(Math.max(0, tr.p - k * 0.035)));
          this.drawMotoRider(ts);
          ctx.restore();
        }
      }
      if (tr.kind === 'whip' && tr.p > 0 && tr.p < 1) this.drawSpeedStreaks(Math.sin(tr.p * Math.PI));

      // Soft contact shadow on the ground plane — drawn before the rotate so
      // it stays flat under the bike instead of tilting with the lean, and
      // only while grounded (flight already reads via the particle trail).
      if (this.phase !== 'flying') {
        ctx.save();
        ctx.scale(1, 0.32);
        const grd = ctx.createRadialGradient(0.5, 64, 0, 0.5, 64, 30);
        grd.addColorStop(0, 'rgba(0,0,0,0.45)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(0.5, 64, 30, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      ctx.rotate(angle);
      // Whip: the bike yaws sideways, read as it foreshortening in side view.
      if (tr.kind === 'whip') ctx.scale(1 - 0.55 * Math.sin(tr.p * Math.PI), 1);
      this.drawMotoRider(ts);
      if (!tr.flip && tr.kind !== 'none' && tr.env > 0.05) this.drawTrickSparkles(tr.env, ts, Math.min(-18, (this._riderC?.y ?? -18) + 4));
    } else {
      const age = this.crashFrames; // 0 at the moment of impact, rising each frame
      this.drawExplosion(age, ts, false);
      ctx.save(); ctx.scale(BIKE_SCALE, BIKE_SCALE);
      this.drawWreck(age, ts);
      ctx.restore();
      this.drawExplosion(age, ts, true);
    }
    ctx.restore();
  }

  // The burnt-out bike after the blast: it tumbles, settles on the track and
  // keeps burning once the fireball has lifted.
  drawWreck(age, ts) {
    const ctx = this.ctx;
    const settle = 1 - Math.exp(-age / 9);
    ctx.save();
    ctx.rotate((this.roundNum % 2 ? 1 : -1) * settle * 2.4);
    const metal = ctx.createLinearGradient(-14, -6, 14, 8);
    metal.addColorStop(0, '#3A3532'); metal.addColorStop(0.5, '#1E1A18'); metal.addColorStop(1, '#0B0A09');
    ctx.fillStyle = metal; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.roundRect(-14, -6, 28, 9, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = LIVERY.far;
    ctx.beginPath(); ctx.moveTo(2, -6); ctx.lineTo(11, -5); ctx.lineTo(8, -1); ctx.lineTo(1, -2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#8A6A2A'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(12, -4); ctx.lineTo(15, 3); ctx.lineTo(13, 8); ctx.stroke();
    ctx.lineCap = 'butt';
    const blur = Math.max(0, 1 - age / 25), wheelSpin = 54 * (1 - Math.exp(-age / 30));
    this.drawWheel(-10, 8, 9, wheelSpin, true, blur);
    this.drawWheel(12, 7, 7.5, -wheelSpin * 1.3, true, blur);
    ctx.fillStyle = 'rgba(210,100,20,0.35)';
    [[-6, -3], [3, -1], [-2, 1], [8, 0]].forEach(([px, py]) => { ctx.beginPath(); ctx.arc(px, py, 1, 0, Math.PI * 2); ctx.fill(); });
    ctx.restore();

    if (age > 8) {
      // Still burning: a glow on the ground under the wreck, then each flame
      // as three nested, swaying tongues — red outside, orange, yellow core.
      const flameSeed = this.roundNum * 7 + 3, fa = Math.min(1, (age - 8) / 10);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const base = ctx.createRadialGradient(0, -2, 0, 0, -2, 28);
      base.addColorStop(0, `rgba(255,150,50,${0.5 * fa})`); base.addColorStop(1, 'rgba(255,90,30,0)');
      ctx.fillStyle = base; ctx.fillRect(-28, -30, 56, 56);
      ctx.restore();
      ctx.globalAlpha = fa;
      [[-8, -3, 1.6], [-1, -6, 2], [6, -2, 1.4], [-4, -7, 1.15], [10, 1, 1.1], [-11, 2, 0.9], [2, -1, 1.25]].forEach(([fx, fy, fs], fi) => {
        const flick = 0.7 + Math.sin(ts * 0.02 + flameSeed + fi * 2) * 0.3;
        const sway = Math.sin(ts * 0.013 + fi * 1.7) * 1.6 * fs;
        const h = (9 + flick * 7) * fs, w = (4 + flick * 2) * fs;
        ctx.save(); ctx.translate(fx, fy);
        [[1, 'rgba(226,58,20,0.85)'], [0.68, 'rgba(255,146,38,0.92)'], [0.38, 'rgba(255,238,170,0.96)']].forEach(([s, col]) => {
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.moveTo(0, 1);
          ctx.quadraticCurveTo(w * s * 1.05, -h * s * 0.35, sway * s, -h * s);
          ctx.quadraticCurveTo(-w * s * 1.05, -h * s * 0.35, 0, 1);
          ctx.closePath(); ctx.fill();
        });
        ctx.restore();
      });
      ctx.globalAlpha = 1;
    }
    if (age > 40) {
      this.drawWreckSmoke(0, -8, this.roundNum * 13 + 3, ts);
      this.drawWreckSmoke(6, -4, this.roundNum * 13 + 30, ts * 1.1);
    }
  }

  // Bomb-style crash, drawn in two passes around the wreck. Behind it: an
  // orange light pool thrown across the track, a charred scorch with blast
  // streaks, a shockwave and rolling dust skirt along the ground, and the
  // mushroom cloud — a smoke column under a billowing cap, shaded by the
  // moonlight above and lit orange from below by the fire. In front of it:
  // a white-hot flash with rays and a lens streak, the fireball (a white
  // core inside yellow, orange and red, cooling to soot as it climbs into
  // the cap), a shock ring, and burning chunks arcing out on smoke trails.
  // `age` is frames since impact; the crash phase runs ~90 frames, then
  // holds on the last one.
  drawExplosion(age, ts, front) {
    const ctx = this.ctx;
    const seed = this.roundNum * 7.31 + 1.7;
    const rnd = (k) => { const v = Math.sin((seed + k) * 12.9898) * 43758.5453; return v - Math.floor(v); };
    const c01 = (v) => Math.max(0, Math.min(1, v));
    const easeOut = (v) => 1 - Math.pow(1 - c01(v), 3);
    const ground = 21 * BIKE_SCALE, cy = ground - 24;
    // Path of the union of a list of billows at `scale`, ready to fill/clip.
    const union = (list, scale, dx = 0, dy = 0) => {
      ctx.beginPath();
      list.forEach((b) => {
        const r = b.r * scale;
        if (r > 0.5) { ctx.moveTo(b.x + dx + r, b.y + dy); ctx.arc(b.x + dx, b.y + dy, r, 0, Math.PI * 2); }
      });
    };
    const fillUnion = (list, scale, dx, dy, style, alpha) => {
      if (alpha <= 0.01) return;
      ctx.globalAlpha = alpha; ctx.fillStyle = style; union(list, scale, dx, dy); ctx.fill(); ctx.globalAlpha = 1;
    };
    const rise = easeOut((age - 4) / 86);
    const capY = ground - 74 - rise * 178, capR = 36 + rise * 58;

    if (!front) {
      // Fire light spilling across the track and the hoarding
      const pool = (1 - c01(age / 75)) * 0.6;
      if (pool > 0.01) {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.translate(0, ground); ctx.scale(1, 0.42);
        const lp = ctx.createRadialGradient(0, 0, 0, 0, 0, 260);
        lp.addColorStop(0, `rgba(255,150,60,${pool})`); lp.addColorStop(0.45, `rgba(255,110,40,${pool * 0.35})`); lp.addColorStop(1, 'rgba(255,90,30,0)');
        ctx.fillStyle = lp; ctx.beginPath(); ctx.arc(0, 0, 260, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      // Scorch mark with charred blast streaks
      if (age > 1) {
        const a = c01((age - 1) / 10) * 0.7;
        ctx.save(); ctx.translate(0, ground); ctx.scale(1, 0.24);
        const sc = ctx.createRadialGradient(0, 0, 0, 0, 0, 104);
        sc.addColorStop(0, `rgba(8,6,4,${a})`); sc.addColorStop(0.55, `rgba(20,12,7,${a * 0.6})`); sc.addColorStop(1, 'rgba(20,12,7,0)');
        ctx.fillStyle = sc; ctx.beginPath(); ctx.arc(0, 0, 104, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(14,9,6,${a * 0.7})`;
        for (let i = 0; i < 9; i++) {
          const ang = (i / 9) * Math.PI * 2 + rnd(i + 140), len = 80 + rnd(i + 150) * 70, w = 0.07 + rnd(i + 160) * 0.06;
          ctx.beginPath(); ctx.moveTo(Math.cos(ang - w) * 30, Math.sin(ang - w) * 30);
          ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len); ctx.lineTo(Math.cos(ang + w) * 30, Math.sin(ang + w) * 30);
          ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      }
      // Ground shockwave and the dust skirt it rolls up
      if (age < 34) {
        const k = easeOut(age / 34), f = 1 - age / 34;
        ctx.save(); ctx.translate(0, ground); ctx.scale(1, 0.2);
        ctx.strokeStyle = `rgba(255,236,206,${f * 0.55})`; ctx.lineWidth = 6 * f + 1;
        ctx.beginPath(); ctx.arc(0, 0, 30 + k * 300, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      if (age > 1 && age < 78) {
        const k = easeOut((age - 1) / 60), fade = 1 - c01((age - 30) / 48);
        const edge = 46 + k * 250;
        for (let i = 0; i < 20; i++) {
          const side = i % 2 ? 1 : -1, pr = (13 + rnd(i + 20) * 17) * (0.55 + k * 0.9);
          const px = side * edge * (0.62 + rnd(i) * 0.38), py = ground - pr * 0.42 - rnd(i + 40) * 14 * k;
          const g = ctx.createRadialGradient(px - pr * 0.25, py - pr * 0.3, pr * 0.1, px, py, pr);
          g.addColorStop(0, `rgba(196,160,116,${0.62 * fade})`); g.addColorStop(0.6, `rgba(150,116,80,${0.45 * fade})`); g.addColorStop(1, 'rgba(120,90,60,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
        }
      }

      // Mushroom cloud
      const smokeA = c01((age - 6) / 16) * (1 - c01((age - 74) / 120));
      if (smokeA > 0) {
        const stem = [], cap = [];
        for (let i = 0; i < 9; i++) {
          const f = i / 8;
          stem.push({ x: Math.sin(f * 3.4 + seed) * 7 * rise, y: ground - 8 + (capY + capR * 0.35 - ground + 8) * f, r: (12 + f * 10) * (0.7 + rise * 0.6) });
        }
        for (let i = 0; i < 13; i++) {
          const a = (i / 13) * Math.PI * 2 + rnd(i) * 0.45;
          cap.push({ x: Math.cos(a) * capR * 1.05, y: capY + Math.sin(a) * capR * 0.4, r: capR * (0.42 + rnd(i + 9) * 0.24) });
        }
        cap.push({ x: 0, y: capY - capR * 0.32, r: capR * 0.74 });
        cap.push({ x: -capR * 0.45, y: capY - capR * 0.12, r: capR * 0.5 });
        cap.push({ x: capR * 0.5, y: capY - capR * 0.08, r: capR * 0.46 });
        const all = [...stem, ...cap];
        fillUnion(all, 1.08, 0, 4, '#110C0B', smokeA);
        const body = ctx.createLinearGradient(0, capY - capR * 1.1, 0, ground);
        body.addColorStop(0, '#63564F'); body.addColorStop(0.45, '#40352F'); body.addColorStop(1, '#271F1C');
        fillUnion(all, 1, 0, 0, body, smokeA);
        fillUnion(cap, 0.74, -capR * 0.13, -capR * 0.17, '#7C6D64', smokeA * 0.85);
        fillUnion(cap, 0.44, -capR * 0.22, -capR * 0.3, '#998A80', smokeA * 0.65);
        fillUnion(cap.slice(0, 13).filter((_, i) => i % 3 === 1), 0.4, capR * 0.1, capR * 0.12, '#2A211E', smokeA * 0.45);
        // Fire-lit underside, fading as the flames die down
        const glow = c01(1 - (age - 8) / 64) * smokeA;
        if (glow > 0.01) {
          ctx.save(); union(all, 1); ctx.clip();
          const reach = ground - capY + capR;
          const fg = ctx.createRadialGradient(0, cy, 0, 0, cy, reach);
          fg.addColorStop(0, `rgba(255,150,50,${glow * 0.95})`); fg.addColorStop(0.5, `rgba(255,96,30,${glow * 0.45})`); fg.addColorStop(1, 'rgba(255,70,20,0)');
          ctx.fillStyle = fg; ctx.fillRect(-reach, cy - reach, reach * 2, reach * 2);
          ctx.restore();
        }
        // Embers drifting up through the smoke
        if (age > 10) {
          const ea = c01((age - 10) / 10) * (1 - c01((age - 70) / 80));
          ctx.save(); ctx.globalCompositeOperation = 'lighter';
          for (let i = 0; i < 22; i++) {
            const tt = (ts * 0.0004 + rnd(i + 50)) % 1;
            const ex = (rnd(i + 60) - 0.5) * capR * 1.7 + Math.sin(tt * 6 + i) * 4, ey = capY + capR * 0.6 - tt * capR * 1.3;
            ctx.fillStyle = `rgba(255,${150 + Math.round(rnd(i + 80) * 80)},60,${ea * (1 - tt) * 0.9})`;
            ctx.beginPath(); ctx.arc(ex, ey, 1.2 + rnd(i + 70) * 1.8, 0, Math.PI * 2); ctx.fill();
          }
          ctx.restore();
        }
      }
      return;
    }

    // ── Front pass ──
    // White-hot flash: a bloom, thin rays and a horizontal lens streak
    if (age < 6) {
      const f = 1 - age / 6;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const R = 240 * (0.55 + (1 - f) * 0.6);
      const bloom = ctx.createRadialGradient(0, cy, 0, 0, cy, R);
      bloom.addColorStop(0, `rgba(255,255,245,${f})`); bloom.addColorStop(0.25, `rgba(255,214,140,${f * 0.7})`); bloom.addColorStop(1, 'rgba(255,140,60,0)');
      ctx.fillStyle = bloom; ctx.fillRect(-R, cy - R, R * 2, R * 2);
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 + rnd(i + 90) * 0.3, len = R * (0.7 + rnd(i + 95) * 0.6), w = 0.035 + rnd(i + 98) * 0.03;
        const rg = ctx.createLinearGradient(0, cy, Math.cos(a) * len, cy + Math.sin(a) * len);
        rg.addColorStop(0, `rgba(255,246,220,${f * 0.9})`); rg.addColorStop(1, 'rgba(255,200,120,0)');
        ctx.fillStyle = rg;
        ctx.beginPath(); ctx.moveTo(Math.cos(a - w) * 12, cy + Math.sin(a - w) * 12);
        ctx.lineTo(Math.cos(a) * len, cy + Math.sin(a) * len); ctx.lineTo(Math.cos(a + w) * 12, cy + Math.sin(a + w) * 12);
        ctx.closePath(); ctx.fill();
      }
      const streak = ctx.createLinearGradient(-R * 1.6, 0, R * 1.6, 0);
      streak.addColorStop(0, 'rgba(160,210,255,0)'); streak.addColorStop(0.5, `rgba(235,246,255,${f * 0.8})`); streak.addColorStop(1, 'rgba(160,210,255,0)');
      ctx.fillStyle = streak; ctx.fillRect(-R * 1.6, cy - 2.5, R * 3.2, 5);
      ctx.restore();
    }

    // Burning chunks flung out on ballistic arcs, trailing smoke — drawn
    // before the fireball so they burst out of it rather than across it
    if (age > 2 && age < 46) {
      ctx.lineCap = 'round';
      for (let i = 0; i < 7; i++) {
        const a = -Math.PI * (0.18 + rnd(i + 200) * 0.64), sp = 7 + rnd(i + 210) * 6;
        const vx = Math.cos(a) * sp, vy = Math.sin(a) * sp, gv = 0.32;
        const at = (t) => ({ x: vx * t, y: cy + vy * t + 0.5 * gv * t * t });
        const t = Math.min(age, 46), p = at(t);
        if (p.y > ground) continue;
        const life = 1 - t / 46;
        for (let s = 1; s <= 6; s++) {
          const q0 = at(Math.max(4, t - s * 2.2)), q1 = at(Math.max(4, t - (s - 1) * 2.2));
          ctx.strokeStyle = `rgba(96,84,78,${0.3 * life * (1 - s / 7)})`; ctx.lineWidth = 2 + s * 1.3;
          ctx.beginPath(); ctx.moveTo(q0.x, q0.y); ctx.lineTo(q1.x, q1.y); ctx.stroke();
        }
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        const fg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 7);
        fg.addColorStop(0, `rgba(255,236,170,${life})`); fg.addColorStop(0.4, `rgba(255,140,40,${life * 0.8})`); fg.addColorStop(1, 'rgba(255,80,20,0)');
        ctx.fillStyle = fg; ctx.fillRect(p.x - 7, p.y - 7, 14, 14);
        ctx.restore();
        ctx.fillStyle = '#1A1412'; ctx.beginPath(); ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2); ctx.fill();
      }
      ctx.lineCap = 'butt';
    }

    // Fireball
    if (age < 62) {
      const k = easeOut(age / 11), cool = c01(age / 48), fade = 1 - c01((age - 36) / 26);
      const fire = [];
      let minY = Infinity, maxR = 0;
      for (let i = 0; i < 16; i++) {
        const a = rnd(i) * Math.PI * 2, dist = (0.12 + rnd(i + 11) * 0.88) * 74 * k;
        const lift = (cy - capY) * rise * (0.5 + rnd(i + 22) * 0.5);
        const b = { x: Math.cos(a) * dist, y: cy - Math.abs(Math.sin(a)) * dist * 0.8 - lift, r: (20 + rnd(i + 33) * 24) * (0.42 + k * 0.85) * (1 + rise * 0.3) };
        fire.push(b); minY = Math.min(minY, b.y); maxR = Math.max(maxR, Math.hypot(b.x, b.y - cy) + b.r);
      }
      const fcy = (minY + cy) / 2;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const heat = ctx.createRadialGradient(0, fcy, 0, 0, fcy, maxR * 1.7);
      heat.addColorStop(0, `rgba(255,160,70,${0.5 * (1 - cool) * fade})`); heat.addColorStop(1, 'rgba(255,90,30,0)');
      ctx.fillStyle = heat; ctx.fillRect(-maxR * 1.7, fcy - maxR * 1.7, maxR * 3.4, maxR * 3.4);
      ctx.restore();
      // Soot gathers round the outside as it cools…
      fillUnion(fire, 1.1 * (1 - cool * 0.1), 0, 3, '#33251F', fade * c01(cool * 2) * 0.7);
      // …around a body shaded hot-centre to cooler edge, dulling toward
      // smoke-brown as it cools rather than just going see-through…
      const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',');
      const bodyG = ctx.createRadialGradient(0, fcy, maxR * 0.05, 0, fcy, maxR);
      bodyG.addColorStop(0, `rgb(${lerp([255, 190, 80], [176, 74, 32], cool)})`);
      bodyG.addColorStop(0.55, `rgb(${lerp([244, 100, 30], [112, 42, 24], cool)})`);
      bodyG.addColorStop(1, `rgb(${lerp([170, 40, 22], [58, 30, 24], cool)})`);
      fillUnion(fire, 1.06 * (1 - cool * 0.3), 0, 0, bodyG, fade);
      // …with a yellow heart and a white-hot core that burn away first
      const midG = ctx.createRadialGradient(0, fcy - 4, 0, 0, fcy - 4, maxR * 0.8);
      midG.addColorStop(0, '#FFF3C4'); midG.addColorStop(0.5, '#FFC83F'); midG.addColorStop(1, '#FF7A1F');
      fillUnion(fire, 0.8 * (1 - cool * 0.58), 0, -3, midG, fade);
      fillUnion(fire, 0.46 * (1 - cool * 1.25), 0, -5, '#FFFBEA', fade);
    }

    // Shock ring
    if (age < 16) {
      const f = 1 - age / 16;
      ctx.strokeStyle = `rgba(255,240,214,${f * 0.8})`; ctx.lineWidth = 1 + f * 4;
      ctx.beginPath(); ctx.arc(0, cy, 30 + age * 19, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = `rgba(255,220,170,${f * 0.25})`; ctx.lineWidth = 10 * f + 2;
      ctx.beginPath(); ctx.arc(0, cy, 22 + age * 14, 0, Math.PI * 2); ctx.stroke();
    }
  }
}
