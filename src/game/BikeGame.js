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
  const rx = W * 0.30;
  const rw = W * 0.14;
  const rh = H * 0.28;
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

export class BikeGame {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks;

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

    this.raf = null;
    this.cdTimer = null;
    this._loop = this.loop.bind(this);
    this._onResize = () => { this.resize(); if (this.phase === 'idle') this.drawIdle(); };

    this.resize();
    window.addEventListener('resize', this._onResize);
    this.drawIdle();
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.cdTimer) clearInterval(this.cdTimer);
  }

  resize() {
    this.canvas.width = this.canvas.offsetWidth;
    this.canvas.height = this.canvas.offsetHeight;
    this.R = null;
  }

  getRamp() { if (!this.R) this.R = computeRamp(this.canvas.width, this.canvas.height); return this.R; }

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
    this.cdTimer = setInterval(() => {
      val--;
      this.cb.onCountdown?.(Math.max(val, 0));
      if (val <= 0) {
        clearInterval(this.cdTimer);
        setTimeout(() => {
          this.cb.onCountdown?.(null);
          this.beginRace();
        }, 500);
      }
    }, 1000);
  }

  beginRace() {
    this.mult = 1; this.flyTs = null; this.trail = []; this.particles = [];
    this.rampT = 0; this.crashFrames = 0; this.camX = 0; this.camTargetX = 0;
    this.approachTs = null; this.rampTs = null; this.pendingCrash = false;
    this._lastDist = null;

    const r = computeRamp(this.canvas.width, this.canvas.height); this.R = r;
    this.bx = r.P0.x - this.canvas.width * 0.20; this.by = r.gY; this.bvx = 3.8; this.bvy = 0;

    this.cb.onRaceStart?.();
    this.phase = 'approach';
    this.cb.onPhase?.('approach');
    this.raf = requestAnimationFrame(this._loop);
  }

  reset() {
    this.phase = 'idle';
    this.camX = 0; this.camTargetX = 0; this.camY = 0; this.camTargetY = 0;
    this.drawIdle();
  }

  // ── Game loop ────────────────────────────────────────────────────────────
  loop(ts) {
    const W = this.canvas.width, H = this.canvas.height, r = this.getRamp();

    if (this.phase === 'approach') {
      if (!this.approachTs) this.approachTs = ts;
      this.bvx = 3.8 + (ts - this.approachTs) / 160; this.bx += this.bvx; this.by = r.gY; this.camX = 0;
      this.camY += (0 - this.camY) * 0.08;
      this.drawScene(ts, false);
      if (this.bx >= r.P0.x) { this.bx = r.P0.x; this.by = r.P0.y; this.rampT = 0; this.rampTs = ts; this.phase = 'ramp'; }
      this.raf = requestAnimationFrame(this._loop); return;
    }

    if (this.phase === 'ramp') {
      this.rampT = Math.min((ts - this.rampTs) / 550, 1);
      const pt = bp(r.P0, r.P1, r.P2, this.rampT); this.bx = pt.x; this.by = pt.y; this.camX = 0;
      this.camY += (0 - this.camY) * 0.08;
      this.drawScene(ts, false);
      if (this.rampT >= 1) {
        const tn = bt(r.P0, r.P1, r.P2, 1);
        const spd = 8 + Math.log(Math.max(1.01, this.crashAt)) / Math.log(200) * 32;
        const len = Math.hypot(tn.x, tn.y);
        this.bvx = (tn.x / len) * spd; this.bvy = (tn.y / len) * spd;
        this.phase = 'flying'; this.flyTs = ts;
        this.cb.onPhase?.('flying');
      }
      this.raf = requestAnimationFrame(this._loop); return;
    }

    if (this.phase === 'flying') {
      const el = ts - this.flyTs; this.mult = this.calcMult(el);
      this.camTargetX = Math.max(0, this.bx - W * 0.38);
      this.camX += (this.camTargetX - this.camX) * 0.07;
      this.camTargetY = this.by < r.gY - H * 0.05 ? Math.max(0, H * 0.38 - this.by) : 0;
      this.camY += (this.camTargetY - this.camY) * 0.06;

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
      this.physStep(r); this.drawScene(ts, false);
      this.raf = requestAnimationFrame(this._loop); return;
    }

    if (this.phase === 'crashing') {
      this.crashFrames++;
      this.camTargetY = this.by < r.gY - H * 0.05 ? Math.max(0, H * 0.38 - this.by) : 0;
      this.camY += (this.camTargetY - this.camY) * 0.08;
      this.physStep(r); this.drawScene(ts, true);
      if (this.crashFrames < 90) { this.raf = requestAnimationFrame(this._loop); return; }
      this.phase = 'done';
      this.cb.onPhase?.('done');
      this.cb.onLanded?.(this.actualDist);
    }
  }

  physStep(r) {
    this.bvy += 0.14; this.bx += this.bvx; this.by += this.bvy;
    if (this.phase !== 'crashing') this.bvx = 3.2 + this.mult * 0.85;
    if (this.by >= r.gY) {
      this.by = r.gY;
      if (this.phase === 'flying') {
        this.bvx = 0; this.bvy = 0;
        this.actualDist = this.toMeters(this.bx, r);
        this.pendingCrash = false;
        this.phase = 'crashing';
        this.spawnParticles();
        this.cb.onShake?.();
      } else if (this.phase === 'crashing') {
        this.bvx = 0; this.bvy = 0;
      }
    }
  }

  // ── Particles ────────────────────────────────────────────────────────────
  spawnParticles() {
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 7;
      this.particles.push({
        x: this.bx, y: this.by, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 3, life: 1,
        col: ['#00ffcc', '#ffdd00', '#ff4400', '#00ff88', '#0088ff'][Math.floor(Math.random() * 5)], r: 3 + Math.random() * 5,
      });
    }
  }
  tickParticles() {
    const ctx = this.ctx;
    this.particles.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.vy += 0.2; p.life -= 0.02;
      if (p.life <= 0) return;
      ctx.globalAlpha = p.life; ctx.fillStyle = p.col;
      ctx.shadowColor = p.col; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(p.x - this.camX, p.y, p.r * p.life, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    });
    this.particles = this.particles.filter(p => p.life > 0);
    ctx.globalAlpha = 1;
  }

  // ── Scene ────────────────────────────────────────────────────────────────
  drawScene(ts, crash) {
    const W = this.canvas.width, H = this.canvas.height, r = this.getRamp(), ctx = this.ctx;
    ctx.fillStyle = '#09101e'; ctx.fillRect(0, 0, W, H);
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
    this.drawBiker(this.bx - this.camX, this.by, crash);
    ctx.restore();
  }

  drawIdle() {
    const W = this.canvas.width, H = this.canvas.height, r = computeRamp(W, H); this.R = r; this.camX = 0;
    this.ctx.clearRect(0, 0, W, H);
    this.drawBg(W, H, 0, r); this.drawStadium(W, H, r.gY, 0); this.drawRamp(r);
    this.drawBiker(r.P0.x - this.canvas.width * 0.18 - this.camX, r.gY, false);
  }

  // ── Prediction marker ────────────────────────────────────────────────────
  drawPredMarker(r, H) {
    if (this.phase !== 'flying' && this.phase !== 'crashing') return;
    const ctx = this.ctx;
    const wx = r.P2.x + this.pred / 0.22;
    const sx = wx - this.camX;
    if (sx < -60 || sx > this.canvas.width + 60) return;
    ctx.strokeStyle = 'rgba(255,220,0,0.75)'; ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]); ctx.shadowColor = '#ffdd00'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(sx, r.gY - 90); ctx.lineTo(sx, r.gY + 8); ctx.stroke();
    ctx.setLineDash([]); ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,220,0,.95)'; ctx.font = 'bold 11px Segoe UI';
    ctx.fillText('📍 ' + this.pred + 'm', sx - 18, r.gY - 96);
  }

  // ── Background ────────────────────────────────────────────────────────────
  drawBg(W, H, ts, r) {
    const ctx = this.ctx;
    const sky = ctx.createLinearGradient(0, 0, 0, H * 0.70);
    sky.addColorStop(0, '#09101e'); sky.addColorStop(0.5, '#0d1428'); sky.addColorStop(1, '#0f1a24');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H * 0.70);

    for (let i = 0; i < 130; i++) {
      const sx = (Math.sin(i * 131.7) * .5 + .5) * W, sy = (Math.cos(i * 93.1) * .5 + .5) * H * 0.44;
      const tw = Math.sin(i * 13.1 + ts * .0013) * .5 + .5, a = 0.2 + tw * 0.75;
      ctx.fillStyle = i % 6 === 0 ? `rgba(0,200,255,${a})` : i % 4 === 0 ? `rgba(0,255,160,${a * .7})` : `rgba(200,220,255,${a * .6})`;
      ctx.beginPath(); ctx.arc(sx, sy, 0.5 + tw * 0.9, 0, Math.PI * 2); ctx.fill();
    }

    const mx = W * 0.84, my = H * 0.09;
    const mg = ctx.createRadialGradient(mx, my, 0, mx, my, 80);
    mg.addColorStop(0, 'rgba(0,180,150,.1)'); mg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(mx, my, 80, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = '#88ddcc'; ctx.shadowBlur = 28;
    ctx.fillStyle = '#c8f0e8'; ctx.beginPath(); ctx.arc(mx, my, 24, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0d1428'; ctx.beginPath(); ctx.arc(mx + 8, my - 4, 20, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    // Dirt ground base
    const grd = ctx.createLinearGradient(0, H * 0.70, 0, H);
    grd.addColorStop(0, '#6b4520'); grd.addColorStop(0.18, '#523318'); grd.addColorStop(1, '#2a1808');
    ctx.fillStyle = grd; ctx.fillRect(0, H * 0.70, W, H);

    // Bumpy track surface
    ctx.fillStyle = '#7a5228';
    ctx.beginPath(); ctx.moveTo(-5, H * 0.70);
    for (let px = 0; px <= W + 10; px += 4) {
      const wx = px + this.camX;
      const bump = Math.sin(wx * 0.11) * 2 + Math.sin(wx * 0.068) * 3 + Math.sin(wx * 0.23) * 1;
      ctx.lineTo(px, H * 0.72 + bump);
    }
    ctx.lineTo(W + 5, H); ctx.lineTo(-5, H); ctx.closePath(); ctx.fill();

    // Worn center strip
    ctx.fillStyle = 'rgba(170,120,60,0.22)';
    ctx.fillRect(0, H * 0.72, W, 10);

    // Tire tracks
    ctx.strokeStyle = 'rgba(30,15,5,0.5)'; ctx.lineWidth = 3;
    ctx.setLineDash([22, 18]);
    const _co = this.camX % 40;
    ctx.beginPath(); ctx.moveTo(-_co, H * 0.723); ctx.lineTo(W + 40, H * 0.723); ctx.stroke();
    ctx.setLineDash([]);

    // Dirt clumps
    for (let i = 0; i < 14; i++) {
      const cx = ((i * 137.5 + this.camX * 0.4) % (W + 80)) - 15;
      const cy = H * 0.725 + 4 + i % 4 * 3;
      ctx.fillStyle = `rgba(${110 + i * 4},${68 + i * 3},${32 + i * 2},0.55)`;
      ctx.beginPath(); ctx.ellipse(cx, cy, 4 + i % 3 * 2, 2 + i % 2, 0, 0, Math.PI * 2); ctx.fill();
    }

    // Ground edge line
    ctx.strokeStyle = '#8b5e3c'; ctx.lineWidth = 2;
    ctx.shadowColor = '#a0713d'; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(0, H * 0.72); ctx.lineTo(W, H * 0.72); ctx.stroke();
    ctx.shadowBlur = 0;

    // Distance markers (world-space, scrolling)
    ctx.font = '10px Segoe UI'; ctx.lineWidth = 1;
    for (let d = 0; d <= 800; d += 25) {
      const wx = r.P2.x + d / 0.22, sx = wx - this.camX;
      if (sx < -40 || sx > W + 40) continue;
      ctx.fillStyle = d % 100 === 0 ? '#3a7090' : '#1e4062';
      ctx.strokeStyle = d % 100 === 0 ? '#3a7090' : '#1e4062';
      if (d > 0) ctx.fillText(d + 'm', sx - 8, H * 0.775);
      ctx.beginPath(); ctx.moveTo(sx, H * 0.72); ctx.lineTo(sx, H * 0.75); ctx.stroke();
    }
  }

  // ── Stadium ───────────────────────────────────────────────────────────────
  drawStadium(W, H, gY, ts) {
    const ctx = this.ctx;
    const par = this.camX * 0.12;

    // Bowl
    const wg = ctx.createLinearGradient(0, H * 0.04, 0, gY);
    wg.addColorStop(0, '#0e1e34'); wg.addColorStop(1, '#111e32');
    ctx.fillStyle = wg;
    ctx.beginPath();
    ctx.moveTo(W * 0.02 - par, gY);
    ctx.lineTo(W * 0.07 - par, H * 0.13);
    ctx.quadraticCurveTo(W * 0.5, H * 0.01, W * 0.93 + par, H * 0.13);
    ctx.lineTo(W * 0.98 + par, gY);
    ctx.closePath(); ctx.fill();

    // Rim
    ctx.strokeStyle = '#1a3a50'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(W * 0.07 - par, H * 0.13);
    ctx.quadraticCurveTo(W * 0.5, H * 0.01, W * 0.93 + par, H * 0.13); ctx.stroke();
    ctx.strokeStyle = '#00bb88'; ctx.lineWidth = 1.8;
    ctx.shadowColor = '#00ffaa'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(W * 0.07 - par, H * 0.13);
    ctx.quadraticCurveTo(W * 0.5, H * 0.01, W * 0.93 + par, H * 0.13); ctx.stroke();
    ctx.shadowBlur = 0;

    // Stands
    this.drawStand(W * 0.02 - par, H * 0.24, W * 0.30 - par, H * 0.24, W * 0.28 - par, gY, W * 0.01 - par, gY, 9);
    this.drawStand(W * 0.70 + par, H * 0.24, W * 0.98 + par, H * 0.24, W * 0.99 + par, gY, W * 0.72 + par, gY, 9);

    // Crowd silhouette
    ctx.fillStyle = '#1e4460';
    ctx.beginPath(); ctx.moveTo(W * 0.02 - par, H * 0.24);
    for (let x = W * 0.02 - par; x <= W * 0.98 + par; x += 6) {
      const h = 4 + Math.sin(x * .28 + ts * .002) * 2.5 + Math.sin(x * .65 + .8) * 2;
      ctx.lineTo(x, H * 0.24 - h); ctx.lineTo(x + 3, H * 0.24);
    }
    ctx.lineTo(W * 0.98 + par, H * 0.24); ctx.closePath(); ctx.fill();

    // Floodlight towers
    const poles = [W * 0.16 - par, W * 0.34 - par * .6, W * 0.66 + par * .6, W * 0.84 + par];
    poles.forEach(px => {
      const topY = H * 0.055;
      const bw = W * 0.115;
      const bg2 = ctx.createRadialGradient(px, topY, 0, px, topY + H * .44, H * .62);
      bg2.addColorStop(0, 'rgba(255,248,210,.24)'); bg2.addColorStop(.4, 'rgba(230,240,255,.10)'); bg2.addColorStop(1, 'rgba(200,230,255,0)');
      ctx.fillStyle = bg2;
      ctx.beginPath(); ctx.moveTo(px, topY); ctx.lineTo(px - bw, gY); ctx.lineTo(px + bw, gY); ctx.closePath(); ctx.fill();

      const pg = ctx.createRadialGradient(px, gY, 0, px, gY, bw * .85);
      pg.addColorStop(0, 'rgba(255,248,210,.16)'); pg.addColorStop(.5, 'rgba(200,230,255,.07)'); pg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = pg; ctx.save(); ctx.scale(1, .25);
      ctx.beginPath(); ctx.arc(px, gY / .25, bw * .85, 0, Math.PI * 2); ctx.fill(); ctx.restore();

      ctx.strokeStyle = '#1e4060'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(px, gY); ctx.lineTo(px, topY); ctx.stroke();
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px - 18, topY); ctx.lineTo(px + 18, topY); ctx.stroke();
      ctx.fillStyle = '#243850'; ctx.fillRect(px - 15, topY - 5, 30, 8);
      ctx.fillStyle = '#fffae0'; ctx.shadowColor = '#ffe060'; ctx.shadowBlur = 50;
      ctx.beginPath(); ctx.arc(px, topY - 2, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,228,100,.4)'; ctx.lineWidth = 7; ctx.shadowBlur = 22;
      ctx.beginPath(); ctx.arc(px, topY - 2, 13, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;
    });
  }

  drawStand(x1, y1, x2, y2, x3, y3, x4, y4, rows) {
    const ctx = this.ctx;
    ctx.fillStyle = '#0f2038';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.lineTo(x4, y4);
    ctx.closePath(); ctx.fill();
    for (let i = 0; i <= rows; i++) {
      const t = i / rows;
      ctx.strokeStyle = '#1e4060'; ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(x1 + (x4 - x1) * t, y1 + (y4 - y1) * t);
      ctx.lineTo(x2 + (x3 - x2) * t, y2 + (y3 - y2) * t);
      ctx.stroke();
    }
  }

  // ── Ramp (world→screen via camX) ──────────────────────────────────────────
  drawRamp(r) {
    const ctx = this.ctx;
    const sx = x => x - this.camX;
    const rg = ctx.createLinearGradient(sx(r.rx), r.gY - r.rh, sx(r.rx + r.rw), r.gY);
    rg.addColorStop(0, '#021630'); rg.addColorStop(1, '#010a18');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.moveTo(sx(r.rx), r.gY); ctx.lineTo(sx(r.P0.x), r.P0.y);
    ctx.quadraticCurveTo(sx(r.P1.x), r.P1.y, sx(r.P2.x), r.P2.y);
    ctx.lineTo(sx(r.P2.x) + 6, r.gY); ctx.closePath(); ctx.fill();

    ctx.strokeStyle = '#00a888'; ctx.lineWidth = 2.2;
    ctx.shadowColor = '#00ffcc'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(sx(r.P0.x), r.P0.y);
    ctx.quadraticCurveTo(sx(r.P1.x), r.P1.y, sx(r.P2.x), r.P2.y); ctx.stroke();

    ctx.fillStyle = '#00ffcc'; ctx.shadowBlur = 18;
    ctx.beginPath(); ctx.arc(sx(r.P2.x), r.P2.y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = '#1a4060'; ctx.lineWidth = 0.7;
    for (let t = 0.2; t < 1; t += 0.2) {
      const pt = bp(r.P0, r.P1, r.P2, t);
      ctx.beginPath(); ctx.moveTo(sx(pt.x), pt.y); ctx.lineTo(sx(pt.x) + 2, r.gY); ctx.stroke();
    }
  }

  // ── Trail ─────────────────────────────────────────────────────────────────
  drawTrail(crash) {
    const ctx = this.ctx;
    for (let i = 1; i < this.trail.length; i++) {
      const a = i / this.trail.length, p = this.trail[i], pp = this.trail[i - 1];
      ctx.strokeStyle = crash ? `rgba(255,60,50,${a * .5})` : `rgba(0,220,160,${a * .4})`;
      ctx.shadowColor = crash ? '#ff3333' : '#00ffaa'; ctx.shadowBlur = a * 5; ctx.lineWidth = a * 3.5;
      ctx.beginPath(); ctx.moveTo(pp.x - this.camX, pp.y); ctx.lineTo(p.x - this.camX, p.y); ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  // ── Biker ─────────────────────────────────────────────────────────────────
  drawBiker(x, y, crash) {
    const ctx = this.ctx;
    ctx.save(); ctx.translate(x, y);
    if (!crash) {
      let angle = 0;
      if (this.phase === 'ramp') { const r = this.getRamp(), tn = bt(r.P0, r.P1, r.P2, this.rampT); angle = Math.atan2(tn.y, tn.x); }
      else if (this.phase === 'flying') angle = Math.atan2(this.bvy, Math.max(this.bvx, .1)) * .45;
      ctx.rotate(angle);

      const rwx = -15, rwy = 9, rwr = 11; // rear (bigger)
      const fwx = 16, fwy = 9, fwr = 9;   // front

      [[rwx, rwy, rwr], [fwx, fwy, fwr]].forEach(([wx, wy, wr]) => {
        ctx.fillStyle = '#111'; ctx.strokeStyle = '#333'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(wx, wy, wr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = '#666'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(wx, wy, wr * 0.54, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = '#555'; ctx.lineWidth = 1;
        for (let s = 0; s < 6; s++) { const a = s * Math.PI / 3; ctx.beginPath(); ctx.moveTo(wx, wy); ctx.lineTo(wx + Math.cos(a) * wr * 0.54, wy + Math.sin(a) * wr * 0.54); ctx.stroke(); }
        ctx.fillStyle = '#888'; ctx.beginPath(); ctx.arc(wx, wy, 2.2, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 2;
        for (let s = 0; s < 8; s++) { const a = s * Math.PI / 4; ctx.beginPath(); ctx.moveTo(wx + Math.cos(a) * (wr - 2.5), wy + Math.sin(a) * (wr - 2.5)); ctx.lineTo(wx + Math.cos(a) * wr, wy + Math.sin(a) * wr); ctx.stroke(); }
      });

      // Swingarm
      ctx.strokeStyle = '#cc4400'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-3, 3); ctx.lineTo(rwx + 5, rwy - 3); ctx.stroke();

      // Front fork
      ctx.strokeStyle = '#aaa'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(fwx - 3, -2); ctx.lineTo(fwx - 3, fwy - fwr); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(fwx + 2, -2); ctx.lineTo(fwx + 2, fwy - fwr); ctx.stroke();

      // Main frame
      ctx.strokeStyle = '#d94400'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.shadowColor = '#ff6600'; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.moveTo(rwx + 6, rwy - 5); ctx.lineTo(fwx - 3, -3); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-2, -16); ctx.lineTo(rwx + 8, rwy - 5); ctx.stroke();
      ctx.shadowBlur = 0;

      // Engine block
      ctx.fillStyle = '#3a1e08'; ctx.strokeStyle = '#5a3010'; ctx.lineWidth = 1.2;
      ctx.fillRect(-9, -5, 15, 9); ctx.strokeRect(-9, -5, 15, 9);
      ctx.strokeStyle = '#4a2810'; ctx.lineWidth = 0.8;
      for (let f = 0; f < 4; f++) { ctx.beginPath(); ctx.moveTo(-9, -4 + f * 2); ctx.lineTo(6, -4 + f * 2); ctx.stroke(); }

      // Exhaust pipe
      ctx.strokeStyle = '#bbb'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(5, 0); ctx.quadraticCurveTo(18, 3, 20, 11); ctx.stroke();
      ctx.strokeStyle = '#888'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(18, 9); ctx.lineTo(22, 13); ctx.stroke();

      // Seat
      ctx.fillStyle = '#1a0800'; ctx.strokeStyle = '#442211'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(-11, -11, 14, 5, 2); ctx.fill(); ctx.stroke();

      // Handlebars
      ctx.strokeStyle = '#999'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(fwx - 2, -3); ctx.lineTo(fwx - 4, -16); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(fwx - 10, -16); ctx.lineTo(fwx + 4, -16); ctx.stroke();
      ctx.strokeStyle = '#222'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(fwx - 10, -16); ctx.lineTo(fwx - 7, -16); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(fwx + 1, -16); ctx.lineTo(fwx + 4, -16); ctx.stroke();

      // Rider legs
      ctx.strokeStyle = '#cc2200'; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-5, -4); ctx.lineTo(-10, 3); ctx.lineTo(rwx + 7, rwy - 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(2, -4); ctx.lineTo(5, 2); ctx.lineTo(fwx - 3, fwy - 4); ctx.stroke();
      ctx.fillStyle = '#3a1800'; ctx.strokeStyle = '#5a2800'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(rwx + 1, rwy - 5, 9, 6, 1); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.roundRect(fwx - 9, fwy - 5, 9, 6, 1); ctx.fill(); ctx.stroke();

      // Torso
      ctx.fillStyle = '#cc2200'; ctx.strokeStyle = '#ff4400'; ctx.lineWidth = 1.5;
      ctx.shadowColor = '#ff3300'; ctx.shadowBlur = 7;
      ctx.beginPath(); ctx.roundRect(-7, -23, 13, 14, 2); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff'; ctx.font = 'bold 6px Arial'; ctx.textAlign = 'center';
      ctx.fillText('42', 0, -13); ctx.textAlign = 'left';
      ctx.strokeStyle = 'rgba(255,200,100,0.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-7, -18); ctx.lineTo(6, -18); ctx.stroke();

      // Arms
      ctx.strokeStyle = '#cc3300'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(1, -18); ctx.lineTo(fwx - 3, -16); ctx.stroke();

      // Helmet
      ctx.fillStyle = '#e03500'; ctx.shadowColor = '#ff5500'; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(0, -29, 9, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ff6600';
      ctx.beginPath(); ctx.arc(0, -29, 9, Math.PI * 1.15, Math.PI * 1.85); ctx.lineTo(0, -29); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(0,200,255,0.65)';
      ctx.beginPath(); ctx.ellipse(2, -27, 6, 3.5, 0.2, 0, Math.PI); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(2, -27, 6, 3.5, 0.2, 0, Math.PI); ctx.stroke();

    } else {
      // Crash - bike tumbles + explosion
      ctx.save();
      ctx.rotate(this.crashFrames * 0.18);
      ctx.fillStyle = '#ff5500'; ctx.shadowColor = '#ff8800'; ctx.shadowBlur = 30;
      ctx.beginPath(); ctx.roundRect(-14, -6, 28, 9, 3); ctx.fill();
      ctx.beginPath(); ctx.arc(-10, 8, 9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(10, 8, 7, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
    }
    ctx.restore();
  }
}
