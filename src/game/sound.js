// Bike It's audio — every sound is synthesized live with WebAudio, so there
// are no files to download. Three buses feed a gentle compressor: `sfx`
// (game sounds), `crowd` (the stadium's ambience) and `music` (the backing
// loop), each with its own switch, plus a shared stadium reverb that the
// big sounds send into. Browsers keep audio locked until the player
// interacts, so the context is only created/resumed by unlockAudio(), which
// the app calls on the first tap or key press.

let ac = null;
let out = null;            // { master, sfx, crowd, music, verb }
let sfxOn = true;
let musicOn = false;
let sfxVolume = 0.8;
let musicVolume = 0.5;

function ctx() {
  if (ac) return ac;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ac = new AC();
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4;
  comp.attack.value = 0.003; comp.release.value = 0.25;
  comp.connect(ac.destination);
  const master = ac.createGain(); master.gain.value = 0.9; master.connect(comp);
  const bus = (v) => { const g = ac.createGain(); g.gain.value = v; g.connect(master); return g; };
  const verb = ac.createConvolver();
  verb.buffer = impulse(1.8, 2.6);
  const verbIn = ac.createGain(); verbIn.gain.value = 0.32; verbIn.connect(verb); verb.connect(master);
  out = { master, verb: verbIn, sfx: bus(0), crowd: bus(0), music: bus(0) };
  applyLevels(0);
  return ac;
}

// Only play while the context is actually running: sounds scheduled into a
// still-locked context would all burst out together the moment it unlocks.
function live() { return ac && ac.state === 'running' ? ac : null; }

function applyLevels(glide = 0.15) {
  if (!out) return;
  const t = ac.currentTime;
  out.sfx.gain.setTargetAtTime(sfxOn ? sfxVolume : 0, t, glide || 0.001);
  out.crowd.gain.setTargetAtTime(sfxOn ? sfxVolume * 0.62 : 0, t, glide || 0.001);
  out.music.gain.setTargetAtTime(musicOn ? musicVolume * 0.42 : 0, t, glide || 0.001);
}

// A stadium-sized reverb tail: decaying stereo noise.
function impulse(seconds, decay) {
  const len = Math.floor(ac.sampleRate * seconds), buf = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

let whiteBuf = null, brownBuf = null, crackleBuf = null;
function white() {
  if (whiteBuf) return whiteBuf;
  const n = ac.sampleRate * 2, b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return (whiteBuf = b);
}
// Brown noise: deep and rumbly, for explosions, fire and the crowd's body
function brown() {
  if (brownBuf) return brownBuf;
  const n = ac.sampleRate * 2, b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
  return (brownBuf = b);
}
// Sparse pops and snaps, looped under a fire so it crackles
function crackle() {
  if (crackleBuf) return crackleBuf;
  const n = ac.sampleRate * 2, b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
  for (let k = 0; k < 70; k++) {
    const at = Math.floor(Math.random() * (n - 900)), amp = 0.25 + Math.random() * 0.75, len = 60 + Math.random() * 500;
    for (let i = 0; i < len; i++) d[at + i] += (Math.random() * 2 - 1) * amp * Math.pow(1 - i / len, 3);
  }
  return (crackleBuf = b);
}

// ── Building blocks ────────────────────────────────────────────────────────
// A tone from f0 gliding to f1 with a quick attack and an exponential tail.
function tone({ type = 'sine', f0, f1 = f0, t = 0, dur = 0.2, gain: peak = 0.2, attack = 0.008, bus = 'sfx', pan = 0, verb = 0, filter = null }) {
  const gain = Math.max(0.0002, peak);
  const a = live(); if (!a) return;
  const t0 = a.currentTime + t, o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  let node = o;
  if (filter) { const f = a.createBiquadFilter(); f.type = filter.type; f.frequency.value = filter.f; f.Q.value = filter.q || 0.8; node.connect(f); node = f; }
  node.connect(g);
  route(g, bus, pan, verb);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

// A burst of filtered noise; the filter can sweep from f0 to f1.
function noise({ src = 'white', t = 0, dur = 0.3, gain: peak = 0.2, attack = 0.005, type = 'bandpass', f0 = 1000, f1 = f0, q = 0.8, bus = 'sfx', pan = 0, verb = 0, offset = 0 }) {
  const gain = Math.max(0.0002, peak);
  const a = live(); if (!a) return;
  const t0 = a.currentTime + t, s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  s.buffer = src === 'brown' ? brown() : src === 'crackle' ? crackle() : white(); s.loop = true;
  f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  s.connect(f); f.connect(g);
  route(g, bus, pan, verb);
  s.start(t0, offset || Math.random() * 1.5); s.stop(t0 + dur + 0.05);
}

function route(node, bus, pan, verb) {
  let n = node;
  if (pan && ac.createStereoPanner) { const p = ac.createStereoPanner(); p.pan.value = pan; n.connect(p); n = p; }
  n.connect(out[bus]);
  if (verb > 0) { const s = ac.createGain(); s.gain.value = verb; n.connect(s); s.connect(out.verb); }
}

// ── Switches ───────────────────────────────────────────────────────────────
export function unlockAudio() {
  const a = ctx(); if (!a) return;
  const go = () => {
    applyLevels();
    if (sfxOn) startCrowd();
    if (musicOn) startMusic();
  };
  if (a.state === 'suspended') a.resume().then(go).catch(() => {}); else go();
}
export function setSoundEnabled(on) {
  sfxOn = !!on;
  if (!ac) return;
  applyLevels();
  if (sfxOn) { if (live()) startCrowd(); } else { stopCrowd(); stopEngine(); stopWind(); stopBurn(); }
}
export function setMusicEnabled(on) {
  musicOn = !!on;
  if (!ac) return;
  applyLevels();
  if (musicOn) { if (live()) startMusic(); } else stopMusic();
}
export function setSfxVolume(v) { sfxVolume = Math.max(0, Math.min(1, v)); applyLevels(); }
export function setMusicVolume(v) { musicVolume = Math.max(0, Math.min(1, v)); applyLevels(); }

// ── Interface ──────────────────────────────────────────────────────────────
export function playClick() {
  tone({ type: 'triangle', f0: 1650, f1: 1250, dur: 0.05, gain: 0.07 });
}
// Chips clinking onto the table as a bet goes down
export function playBet() {
  [0, 0.07, 0.15].forEach((t, i) => {
    tone({ f0: 2350 + i * 160, dur: 0.22, gain: 0.09, t, verb: 0.15 });
    tone({ f0: 3520 + i * 210, dur: 0.12, gain: 0.05, t });
    noise({ t, dur: 0.03, gain: 0.05, type: 'highpass', f0: 5000 });
  });
}
export function playDeposit() {
  [660, 880, 1175, 1568].forEach((f, i) => tone({ type: 'triangle', f0: f, t: i * 0.07, dur: 0.22, gain: 0.12, verb: 0.2 }));
}
export function playWithdraw() {
  [880, 660, 523].forEach((f, i) => tone({ type: 'triangle', f0: f, t: i * 0.08, dur: 0.2, gain: 0.11 }));
}

// 3-2-1 beeps; the final "GO" is higher, brighter and longer
export function playCountdownBeep(isFinal = false) {
  if (isFinal) {
    tone({ type: 'square', f0: 880, f1: 1320, dur: 0.45, gain: 0.08, filter: { type: 'lowpass', f: 3200 }, verb: 0.25 });
    tone({ f0: 1760, dur: 0.4, gain: 0.07 });
    crowdSwell(0.5, 1.6);
  } else {
    tone({ type: 'square', f0: 620, dur: 0.16, gain: 0.07, filter: { type: 'lowpass', f: 2400 } });
    tone({ f0: 1240, dur: 0.12, gain: 0.04 });
  }
}

// ── The bike ───────────────────────────────────────────────────────────────
// A single-cylinder dirt bike: two detuned saws and a square sub through a
// soft-clipping shaper and a lowpass, chopped by a firing-rate "putt" so it
// thumps rather than drones. setEnginePitch(0…1) revs it with the bike's speed.
let engine = null;
export function startEngine() {
  const a = live(); if (!a || engine || !sfxOn) return;
  const t = a.currentTime;
  const o1 = a.createOscillator(), o2 = a.createOscillator(), sub = a.createOscillator();
  o1.type = 'sawtooth'; o2.type = 'sawtooth'; sub.type = 'square';
  const mix = a.createGain(); mix.gain.value = 0.5;
  [o1, o2].forEach((o) => o.connect(mix));
  const subG = a.createGain(); subG.gain.value = 0.35; sub.connect(subG); subG.connect(mix);
  const shaper = a.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const x = (i / 255) * 2 - 1; curve[i] = Math.tanh(x * 2.4); }
  shaper.curve = curve;
  const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2.2;
  const putt = a.createGain(); putt.gain.value = 0.7;
  const lfo = a.createOscillator(), lfoG = a.createGain(); lfo.type = 'square'; lfoG.gain.value = 0.3;
  lfo.connect(lfoG); lfoG.connect(putt.gain);
  const amp = a.createGain(); amp.gain.value = 0.0001;
  mix.connect(shaper); shaper.connect(lp); lp.connect(putt); putt.connect(amp); amp.connect(out.sfx);
  [o1, o2, sub, lfo].forEach((o) => o.start(t));
  amp.gain.exponentialRampToValueAtTime(0.09, t + 0.15);
  engine = { o1, o2, sub, lfo, lp, amp };
  setEnginePitch(0);
}
export function setEnginePitch(ratio) {
  const a = live(); if (!a || !engine) return;
  const r = Math.max(0, Math.min(1, ratio)), t = a.currentTime, f = 42 + r * 105;
  engine.o1.frequency.setTargetAtTime(f, t, 0.06);
  engine.o2.frequency.setTargetAtTime(f * 1.012, t, 0.06);
  engine.sub.frequency.setTargetAtTime(f / 2, t, 0.06);
  engine.lfo.frequency.setTargetAtTime(f / 2, t, 0.06);
  engine.lp.frequency.setTargetAtTime(520 + r * 2600, t, 0.06);
  engine.amp.gain.setTargetAtTime(0.08 + r * 0.06, t, 0.06);
}
export function stopEngine() {
  if (!engine || !ac) return;
  const { o1, o2, sub, lfo, amp } = engine, t = ac.currentTime;
  engine = null;
  amp.gain.cancelScheduledValues(t);
  amp.gain.setTargetAtTime(0.0001, t, 0.09);
  [o1, o2, sub, lfo].forEach((o) => { try { o.stop(t + 0.5); } catch { /* already stopped */ } });
}

// Leaving the lip: a last rev, a deep whoomp and the air rushing past
export function playTakeoff() {
  stopEngine();
  tone({ type: 'sawtooth', f0: 150, f1: 260, dur: 0.32, gain: 0.08, filter: { type: 'lowpass', f: 1800 } });
  tone({ f0: 95, f1: 48, dur: 0.4, gain: 0.22 });
  noise({ dur: 0.7, gain: 0.16, f0: 450, f1: 2600, q: 0.7, verb: 0.2 });
  crowdSwell(0.85, 2.4);
}
// The flame cannons either side of the ramp: two roaring "fwoomps"
export function playCannons() {
  [[-0.55, 0], [0.55, 0.06]].forEach(([pan, t]) => {
    noise({ src: 'brown', t, dur: 1.2, gain: 0.32, attack: 0.03, type: 'lowpass', f0: 900, f1: 260, pan, verb: 0.3 });
    noise({ t, dur: 0.5, gain: 0.08, type: 'bandpass', f0: 1800, f1: 700, pan });
    tone({ f0: 80, f1: 46, t, dur: 0.45, gain: 0.16, pan });
  });
}

// Air rushing past through the flight, building with the jump
let wind = null;
export function startWind() {
  const a = live(); if (!a || wind || !sfxOn) return;
  const s = a.createBufferSource(); s.buffer = white(); s.loop = true;
  const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 400; f.Q.value = 0.6;
  const whistle = a.createBiquadFilter(); whistle.type = 'bandpass'; whistle.frequency.value = 1800; whistle.Q.value = 9;
  const g = a.createGain(), wg = a.createGain(); g.gain.value = 0.0001; wg.gain.value = 0.15;
  s.connect(f); f.connect(g); s.connect(whistle); whistle.connect(wg); wg.connect(g); g.connect(out.sfx);
  s.start();
  g.gain.exponentialRampToValueAtTime(0.06, a.currentTime + 0.3);
  wind = { s, f, whistle, g };
}
export function setWindIntensity(mult) {
  const a = live(); if (!a || !wind) return;
  const k = Math.max(0, Math.min(1, (mult - 1) / 6)), t = a.currentTime;
  wind.f.frequency.setTargetAtTime(380 + k * 1900, t, 0.1);
  wind.whistle.frequency.setTargetAtTime(1500 + k * 1600, t, 0.1);
  wind.g.gain.setTargetAtTime(0.05 + k * 0.1, t, 0.1);
}
export function stopWind() {
  if (!wind || !ac) return;
  const { s, g } = wind, t = ac.currentTime;
  wind = null;
  g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0.0001, t, 0.08);
  try { s.stop(t + 0.4); } catch { /* already stopped */ }
}

// A mid-air trick: a fast swish with a sparkle on top
export function playTrick() {
  noise({ dur: 0.28, gain: 0.1, f0: 1600, f1: 6000, q: 1.2 });
  [1568, 2093, 2637].forEach((f, i) => tone({ type: 'triangle', f0: f, t: 0.05 + i * 0.05, dur: 0.18, gain: 0.05, verb: 0.3 }));
}

// ── The dragon ─────────────────────────────────────────────────────────────
// A snarling roar: a growling saw with a wobble, through a throaty formant,
// with breath rasping over it and a sub underneath
export function playDragonRoar(far = false) {
  const a = live(); if (!a) return;
  const k = far ? 0.35 : 1, t0 = a.currentTime;
  const o = a.createOscillator(), vib = a.createOscillator(), vibG = a.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(78, t0); o.frequency.linearRampToValueAtTime(128, t0 + 0.35); o.frequency.linearRampToValueAtTime(70, t0 + 1.25);
  vib.frequency.value = 9; vibG.gain.value = 9; vib.connect(vibG); vibG.connect(o.frequency);
  const form = a.createBiquadFilter(); form.type = 'bandpass'; form.frequency.value = 620; form.Q.value = 1.4;
  const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = far ? 900 : 2200;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.5 * k, t0 + 0.12); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.35);
  o.connect(form); form.connect(lp); lp.connect(g);
  route(g, 'sfx', far ? 0.4 : 0, 0.45);
  o.start(t0); vib.start(t0); o.stop(t0 + 1.4); vib.stop(t0 + 1.4);
  noise({ dur: 1.2, gain: 0.12 * k, attack: 0.1, f0: 1300, f1: 700, q: 0.9, verb: 0.3 });
  tone({ f0: 52, f1: 38, dur: 1.1, gain: 0.25 * k, attack: 0.1 });
}
// Fire pouring out of its jaws: a roaring rush that swells and dies
export function playDragonFire(dur = 1, far = false) {
  const k = far ? 0.3 : 1;
  noise({ src: 'brown', dur: dur + 0.3, gain: 0.4 * k, attack: 0.08, type: 'lowpass', f0: 700, f1: 1800, verb: 0.25 });
  noise({ dur: dur + 0.2, gain: 0.12 * k, attack: 0.1, f0: 2400, f1: 900, q: 0.6 });
  noise({ src: 'crackle', dur: dur + 0.4, gain: 0.35 * k, attack: 0.1, type: 'highpass', f0: 1500 });
}
// The rider and bike on fire: a low roar with crackles, looping until it goes out
let burn = null;
export function startBurn() {
  const a = live(); if (!a || burn || !sfxOn) return;
  const roar = a.createBufferSource(); roar.buffer = brown(); roar.loop = true;
  const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
  const cr = a.createBufferSource(); cr.buffer = crackle(); cr.loop = true;
  const hp = a.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200;
  const g = a.createGain(), cg = a.createGain(); g.gain.value = 0.0001; cg.gain.value = 0.6;
  roar.connect(lp); lp.connect(g); cr.connect(hp); hp.connect(cg); cg.connect(g); g.connect(out.sfx);
  roar.start(); cr.start();
  g.gain.exponentialRampToValueAtTime(0.22, a.currentTime + 0.3);
  burn = { roar, cr, g };
}
export function stopBurn() {
  if (!burn || !ac) return;
  const { roar, cr, g } = burn, t = ac.currentTime;
  burn = null;
  g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0.0001, t, 0.15);
  [roar, cr].forEach((s) => { try { s.stop(t + 0.8); } catch { /* already stopped */ } });
}

// ── The crash ──────────────────────────────────────────────────────────────
// The bomb going off: a sharp crack, a sub-bass boom, the roar of the
// fireball rolling up, a long rumble round the stadium and debris clattering
// down — then the wreck crackling as it burns.
export function playExplosion() {
  stopEngine(); stopWind(); stopBurn();
  noise({ dur: 0.14, gain: 0.45, type: 'highpass', f0: 1400, verb: 0.3 });
  tone({ f0: 92, f1: 26, dur: 1.2, gain: 0.85, attack: 0.004 });
  noise({ src: 'brown', dur: 1.7, gain: 0.8, attack: 0.01, type: 'lowpass', f0: 1600, f1: 160, verb: 0.5 });
  noise({ src: 'brown', t: 0.25, dur: 2.8, gain: 0.35, attack: 0.3, type: 'lowpass', f0: 220, f1: 90, verb: 0.4 });
  noise({ src: 'crackle', t: 0.2, dur: 2.6, gain: 0.4, attack: 0.2, type: 'highpass', f0: 1800 });
  for (let i = 0; i < 7; i++) {
    const t = 0.45 + Math.random() * 1.3, f = 900 + Math.random() * 1800, pan = Math.random() * 1.6 - 0.8;
    tone({ type: 'triangle', f0: f, f1: f * 0.92, t, dur: 0.16, gain: 0.07, pan });
    noise({ t, dur: 0.07, gain: 0.08, type: 'bandpass', f0: 600, q: 0.7, pan });
  }
  crowdGasp();
}
// Fireworks over the roof after a great call: whistling climbs, bangs, glitter
export function playFireworks(shells = 3) {
  for (let i = 0; i < shells; i++) {
    const t = 0.2 + i * 0.42 + Math.random() * 0.15, pan = Math.random() * 1.4 - 0.7;
    tone({ f0: 700, f1: 2200, t, dur: 0.45, gain: 0.025, pan });
    noise({ t: t + 0.45, dur: 0.18, gain: 0.3, type: 'lowpass', f0: 2400, f1: 500, pan, verb: 0.5 });
    noise({ src: 'crackle', t: t + 0.55, dur: 0.9, gain: 0.18, type: 'highpass', f0: 3000, pan, verb: 0.3 });
  }
}

// ── Results ────────────────────────────────────────────────────────────────
// A win fanfare that grows with the tier, the crowd going up with it
export function playWin(tier) {
  const seqs = { 8: [523, 659, 784, 1047, 1319, 1568], 3: [523, 659, 784, 1047], 1.5: [523, 659, 784] };
  const notes = seqs[tier] || seqs[1.5];
  notes.forEach((f, i) => {
    const t = i * 0.11, last = i === notes.length - 1, dur = last ? 0.7 : 0.2;
    tone({ type: 'square', f0: f, t, dur, gain: 0.06, filter: { type: 'lowpass', f: 3600 }, verb: 0.25 });
    tone({ type: 'triangle', f0: f * 2, t, dur, gain: 0.04 });
  });
  crowdCheer(tier >= 8 ? 1 : tier >= 3 ? 0.8 : 0.55);
  if (tier >= 3) playFireworks(tier >= 8 ? 5 : 3);
}
// A sagging "wah-wah" and the crowd groaning
export function playLose() {
  [311, 294, 277, 247].forEach((f, i) => {
    const last = i === 3;
    tone({ type: 'sawtooth', f0: f, f1: last ? f * 0.82 : f, t: i * 0.24, dur: last ? 0.7 : 0.22, gain: 0.07, filter: { type: 'lowpass', f: 1100 } });
  });
  crowdGroan();
}

// ── The crowd ──────────────────────────────────────────────────────────────
// The stadium's bed of sound: a murmur and a layer of chatter, each slowly
// breathing, with whistles, clap ripples, a drum and the odd air horn
// popping up at random. crowdSwell() makes the whole stand rise for a moment.
let crowd = null;
export function startCrowd() {
  const a = live(); if (!a || crowd || !sfxOn) return;
  const t = a.currentTime;
  const layer = (src, type, f, q, level) => {
    const s = a.createBufferSource(); s.buffer = src; s.loop = true;
    const fl = a.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = a.createGain(); g.gain.value = level;
    s.connect(fl); fl.connect(g);
    s.start(t, Math.random() * 1.5);
    return { s, g };
  };
  const bed = a.createGain(); bed.gain.value = 0.0001; bed.connect(out.crowd);
  const murmur = layer(brown(), 'bandpass', 520, 0.6, 0.55);
  const chatter = layer(white(), 'bandpass', 1500, 1.4, 0.05);
  murmur.g.connect(bed); chatter.g.connect(bed);
  const lfo = (rate, depth, param) => { const o = a.createOscillator(), g = a.createGain(); o.frequency.value = rate; g.gain.value = depth; o.connect(g); g.connect(param); o.start(t); return o; };
  const lfos = [lfo(0.11, 0.18, murmur.g.gain), lfo(0.31, 0.025, chatter.g.gain)];
  bed.gain.exponentialRampToValueAtTime(0.32, t + 2.5);
  crowd = { bed, sources: [murmur.s, chatter.s], lfos, timer: null };
  const next = () => {
    if (!crowd) return;
    crowdMoment();
    crowd.timer = setTimeout(next, 2200 + Math.random() * 4800);
  };
  crowd.timer = setTimeout(next, 1800);
}
export function stopCrowd() {
  if (!crowd || !ac) return;
  const c = crowd, t = ac.currentTime;
  crowd = null;
  clearTimeout(c.timer);
  c.bed.gain.cancelScheduledValues(t); c.bed.gain.setTargetAtTime(0.0001, t, 0.3);
  [...c.sources, ...c.lfos].forEach((s) => { try { s.stop(t + 1.5); } catch { /* already stopped */ } });
}
// One of the little things a crowd does on its own
function crowdMoment() {
  const r = Math.random(), pan = Math.random() * 1.6 - 0.8;
  if (r < 0.34) {
    // A fan whistling: two-tone, rising
    const f = 1900 + Math.random() * 700;
    tone({ f0: f, f1: f * 1.18, dur: 0.22, gain: 0.03, bus: 'crowd', pan, verb: 0.4 });
    tone({ f0: f * 0.95, f1: f * 1.3, t: 0.28, dur: 0.32, gain: 0.03, bus: 'crowd', pan, verb: 0.4 });
  } else if (r < 0.62) {
    clapRipple(0.6 + Math.random() * 0.8, 0.5, pan);
  } else if (r < 0.8) {
    // A section of the stand cheering briefly
    noise({ src: 'brown', dur: 1.4, gain: 0.25, attack: 0.35, type: 'bandpass', f0: 700, f1: 900, q: 0.7, bus: 'crowd', pan, verb: 0.4 });
  } else if (r < 0.94) {
    // The stadium drum: boom… boom
    [0, 0.42].forEach((t) => { tone({ f0: 110, f1: 55, t, dur: 0.35, gain: 0.12, bus: 'crowd', verb: 0.5 }); noise({ t, dur: 0.06, gain: 0.04, type: 'lowpass', f0: 900, bus: 'crowd' }); });
  } else {
    // An air horn somewhere up in the stand
    [233, 294, 349].forEach((f) => tone({ type: 'sawtooth', f0: f, dur: 0.75, gain: 0.025, attack: 0.03, bus: 'crowd', pan, verb: 0.5, filter: { type: 'lowpass', f: 2400 } }));
  }
}
function clapRipple(len, level, pan = 0) {
  const n = Math.round(10 + len * 22);
  for (let i = 0; i < n; i++) {
    noise({ t: Math.random() * len, dur: 0.05, gain: 0.02 + Math.random() * 0.03 * level, type: 'bandpass', f0: 1100 + Math.random() * 1400, q: 1.2, bus: 'crowd', pan: pan + (Math.random() - 0.5) * 0.6, verb: 0.2 });
  }
}
// The whole stand lifting for `secs` seconds (anticipation, a big moment)
export function crowdSwell(level = 0.6, secs = 2) {
  if (!live() || !sfxOn) return;
  noise({ src: 'brown', dur: secs, gain: 0.5 * level, attack: secs * 0.35, type: 'bandpass', f0: 600, f1: 950, q: 0.55, bus: 'crowd', verb: 0.35 });
  noise({ dur: secs * 0.9, gain: 0.05 * level, attack: secs * 0.3, type: 'bandpass', f0: 1700, q: 1, bus: 'crowd' });
}
// A roar with whistles, applause and — for the big ones — air horns
export function crowdCheer(level = 0.7) {
  if (!live() || !sfxOn) return;
  noise({ src: 'brown', dur: 3.4, gain: 0.85 * level, attack: 0.25, type: 'bandpass', f0: 750, f1: 620, q: 0.5, bus: 'crowd', verb: 0.45 });
  noise({ dur: 3, gain: 0.09 * level, attack: 0.25, type: 'bandpass', f0: 2000, q: 0.9, bus: 'crowd' });
  clapRipple(2.6, level);
  for (let i = 0; i < Math.round(2 + level * 4); i++) {
    const f = 1900 + Math.random() * 1100, t = 0.2 + Math.random() * 1.6, pan = Math.random() * 1.6 - 0.8;
    tone({ f0: f, f1: f * 1.25, t, dur: 0.28, gain: 0.035, bus: 'crowd', pan, verb: 0.4 });
  }
  if (level > 0.75) {
    [0.3, 1.1].forEach((t) => [233, 294, 349].forEach((f) => tone({ type: 'sawtooth', f0: f, t, dur: 0.6, gain: 0.03, attack: 0.03, bus: 'crowd', verb: 0.5, filter: { type: 'lowpass', f: 2400 } })));
  }
}
// "Ooooh" — the stand catching its breath as the bike goes up in flames
export function crowdGasp() {
  if (!live() || !sfxOn) return;
  noise({ src: 'brown', t: 0.15, dur: 1.6, gain: 0.55, attack: 0.3, type: 'bandpass', f0: 480, f1: 820, q: 1.1, bus: 'crowd', verb: 0.4 });
}
// "Awww" — falling away
export function crowdGroan() {
  if (!live() || !sfxOn) return;
  noise({ src: 'brown', dur: 1.8, gain: 0.5, attack: 0.15, type: 'bandpass', f0: 760, f1: 330, q: 1.3, bus: 'crowd', verb: 0.4 });
}

// ── Music ──────────────────────────────────────────────────────────────────
// A driving stadium groove, generated live: four-on-the-floor kick, claps,
// hats, a pumping bass and pad chords over Am–F–C–G, with an arpeggio that
// comes in when things heat up (setMusicIntensity). Notes are scheduled a
// little ahead on the audio clock by a light timer, so timing stays tight.
const BPM = 112, STEP = 60 / BPM / 4;
const PROG = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // MIDI: Am F C G
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
let music = null;
export function startMusic() {
  const a = live(); if (!a || music || !musicOn) return;
  const bus = a.createGain(); bus.gain.value = 0.0001;
  const warm = a.createBiquadFilter(); warm.type = 'lowpass'; warm.frequency.value = 5200;
  bus.connect(warm); warm.connect(out.music);
  bus.gain.exponentialRampToValueAtTime(1, a.currentTime + 2);
  music = { bus, step: 0, next: a.currentTime + 0.1, intensity: 0.4, timer: null };
  const tick = () => {
    if (!music) return;
    while (music.next < a.currentTime + 0.15) { scheduleStep(music.step, music.next); music.step++; music.next += STEP; }
    music.timer = setTimeout(tick, 30);
  };
  tick();
}
export function stopMusic() {
  if (!music || !ac) return;
  const m = music, t = ac.currentTime;
  music = null;
  clearTimeout(m.timer);
  m.bus.gain.cancelScheduledValues(t); m.bus.gain.setTargetAtTime(0.0001, t, 0.4);
  setTimeout(() => { try { m.bus.disconnect(); } catch { /* gone */ } }, 3000);
}
export function setMusicIntensity(k) { if (music) music.intensity = Math.max(0, Math.min(1, k)); }

function scheduleStep(step, t) {
  const m = music, s = step % 16, bar = Math.floor(step / 16) % 4, chord = PROG[bar];
  const voice = (fn) => fn(m.bus);
  // Kick on every beat
  if (s % 4 === 0) voice((dst) => drum(dst, t, 'kick'));
  // Clap on 2 and 4
  if (s === 4 || s === 12) voice((dst) => drum(dst, t, 'clap'));
  // Hats on the offbeats, sixteenths when it heats up
  if (s % 2 === 1 || (m.intensity > 0.6 && Math.random() < 0.5)) voice((dst) => drum(dst, t, s === 14 ? 'open' : 'hat'));
  // Bass: root and octave pumping on eighths
  if (s % 2 === 0) {
    const root = chord[0] - 24 + (s === 6 || s === 14 ? 12 : 0);
    voice((dst) => synth(dst, t, hz(root), STEP * 1.8, 'sawtooth', 0.11, 700));
  }
  // Pad chord at the top of each bar
  if (s === 0) chord.forEach((n) => voice((dst) => synth(dst, t, hz(n), STEP * 15, 'sawtooth', 0.028, 1400, 0.35)));
  // Arpeggio over the chord when the game is in full swing
  if (m.intensity > 0.3 && s % 2 === 0) {
    const n = chord[(s / 2) % 3] + 12 + (s >= 8 ? 12 : 0);
    voice((dst) => synth(dst, t, hz(n), STEP * 1.2, 'square', 0.022 * m.intensity, 3000));
  }
}
function synth(dst, t, f, dur, type, gain, cutoff, attack = 0.01) {
  const o = ac.createOscillator(), o2 = ac.createOscillator(), lp = ac.createBiquadFilter(), g = ac.createGain();
  o.type = type; o2.type = type; o.frequency.value = f; o2.frequency.value = f * 1.006;
  lp.type = 'lowpass'; lp.frequency.value = cutoff;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.setValueAtTime(gain, t + Math.max(attack, dur * 0.6)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(lp); o2.connect(lp); lp.connect(g); g.connect(dst);
  o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
}
function drum(dst, t, kind) {
  if (kind === 'kick') {
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(0.55, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g); g.connect(dst); o.start(t); o.stop(t + 0.35);
    return;
  }
  const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
  s.buffer = white();
  const len = kind === 'clap' ? 0.16 : kind === 'open' ? 0.22 : 0.05;
  f.type = kind === 'clap' ? 'bandpass' : 'highpass'; f.frequency.value = kind === 'clap' ? 1500 : 7500; f.Q.value = kind === 'clap' ? 0.9 : 0.7;
  const peak = kind === 'clap' ? 0.22 : kind === 'open' ? 0.06 : 0.05;
  g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  s.connect(f); f.connect(g); g.connect(dst);
  s.start(t, Math.random()); s.stop(t + len + 0.02);
}

// ── Game events ────────────────────────────────────────────────────────────
// One entry point for everything the game engine reports (BikeGame's
// onSfx callback), so the engine stays free of any audio code.
export function gameSfx(name, v) {
  if (!sfxOn) return;
  switch (name) {
    case 'race-start': startEngine(); setMusicIntensity(0.8); break;
    case 'engine': setEnginePitch(v); break;
    case 'takeoff': playTakeoff(); startWind(); break;
    case 'cannons': playCannons(); break;
    case 'wind': setWindIntensity(v); break;
    case 'trick': playTrick(); break;
    case 'dragon-roar': playDragonRoar(); break;
    case 'dragon-fire': playDragonFire(1); break;
    case 'dragon-puff': playDragonFire(0.6, true); break;
    case 'burn-start': startBurn(); break;
    case 'crash': playExplosion(); setMusicIntensity(0.4); break;
    case 'stop': stopEngine(); stopWind(); stopBurn(); break;
    default: break;
  }
}
