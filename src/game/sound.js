// WebAudio jingles. The AudioContext is created lazily so it is unlocked by the
// user gesture (the "Place Bet" click) before any sound plays.

let audioCtx = null;
function ctx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

// Independent SFX/music levels (0..1) — everything below scales its gain
// against one of these instead of a hardcoded constant, so the settings
// sliders affect sounds that are already scheduled/looping, not just future
// ones.
let sfxVolume = 0.8;
let musicVolume = 0.5;
export function setSfxVolume(v) { sfxVolume = Math.max(0, Math.min(1, v)); }
export function setMusicVolume(v) {
  musicVolume = Math.max(0, Math.min(1, v));
  if (ambientNodes) ambientNodes.master.gain.setTargetAtTime(0.09 * musicVolume, ctx().currentTime, 0.2);
}

export function playWin(tier) {
  const ac = ctx();
  const sequences = {
    8: [523, 659, 784, 1047, 1319], // bullseye: big ascending fanfare
    3: [523, 659, 784, 1047],       // great call
    1.5: [523, 659, 784],           // close enough
  };
  const notes = sequences[tier] || sequences[1.5];
  notes.forEach((freq, i) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.type = 'square';
    o.frequency.value = freq;
    const t = ac.currentTime + i * 0.13;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18 * sfxVolume, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.start(t); o.stop(t + 0.2);
  });
}

export function playDeposit() {
  const ac = ctx();
  const notes = [660, 880, 1175];
  notes.forEach((freq, i) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.type = 'triangle';
    o.frequency.value = freq;
    const t = ac.currentTime + i * 0.09;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16 * sfxVolume, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.start(t); o.stop(t + 0.17);
  });
}

export function playWithdraw() {
  const ac = ctx();
  const notes = [700, 500];
  notes.forEach((freq, i) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.type = 'triangle';
    o.frequency.value = freq;
    const t = ac.currentTime + i * 0.1;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16 * sfxVolume, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.start(t); o.stop(t + 0.18);
  });
}

// A short beep for the 3-2-1 countdown; the final tick (val === 0, "GO") gets
// a higher-pitched, longer, louder beep so it reads as the actual launch cue.
export function playCountdownBeep(isFinal = false) {
  const ac = ctx();
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.connect(g); g.connect(ac.destination);
  o.type = 'sine';
  o.frequency.value = isFinal ? 880 : 520;
  const t = ac.currentTime;
  const peak = (isFinal ? 0.22 : 0.15) * sfxVolume;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + (isFinal ? 0.35 : 0.15));
  o.start(t); o.stop(t + (isFinal ? 0.37 : 0.17));
}

// A quick upward blip for a successful mid-flight trick tap.
export function playTrick() {
  const ac = ctx();
  const notes = [740, 1050];
  notes.forEach((freq, i) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.type = 'triangle';
    o.frequency.value = freq;
    const t = ac.currentTime + i * 0.05;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.15 * sfxVolume, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.start(t); o.stop(t + 0.14);
  });
}

// Shared white-noise buffer used by both the wind loop and the crash thud —
// generated once and reused rather than allocating a fresh buffer per call.
let noiseBuffer = null;
function getNoiseBuffer(ac) {
  if (noiseBuffer) return noiseBuffer;
  const size = ac.sampleRate * 2;
  const buffer = ac.createBuffer(1, size, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buffer;
  return buffer;
}

// Engine: a looping buzzy oscillator for the approach/ramp run-up. Pitch and
// filter brightness both track `setEnginePitch(ratio)` (0..1, driven by the
// bike's current speed) so it reads as revving rather than a static drone.
let engineNodes = null;
export function startEngine() {
  if (engineNodes) return;
  const ac = ctx();
  const o = ac.createOscillator();
  const filter = ac.createBiquadFilter();
  const g = ac.createGain();
  filter.type = 'lowpass'; filter.frequency.value = 700;
  o.type = 'sawtooth'; o.frequency.value = 55;
  o.connect(filter); filter.connect(g); g.connect(ac.destination);
  g.gain.value = 0;
  g.gain.linearRampToValueAtTime(0.05 * sfxVolume, ac.currentTime + 0.12);
  o.start();
  engineNodes = { o, filter, g };
}
export function setEnginePitch(ratio) {
  if (!engineNodes) return;
  const ac = ctx();
  const r = Math.max(0, Math.min(1, ratio));
  engineNodes.o.frequency.setTargetAtTime(55 + r * 150, ac.currentTime, 0.05);
  engineNodes.filter.frequency.setTargetAtTime(600 + r * 2000, ac.currentTime, 0.05);
  engineNodes.g.gain.setTargetAtTime((0.045 + r * 0.03) * sfxVolume, ac.currentTime, 0.05);
}
export function stopEngine() {
  if (!engineNodes) return;
  const ac = ctx();
  const { o, g } = engineNodes;
  g.gain.cancelScheduledValues(ac.currentTime);
  g.gain.setValueAtTime(g.gain.value, ac.currentTime);
  g.gain.linearRampToValueAtTime(0, ac.currentTime + 0.15);
  engineNodes = null;
  setTimeout(() => { try { o.stop(); } catch { /* already stopped */ } }, 220);
}

// Wind: filtered looping noise for the flight itself. `setWindIntensity(mult)`
// sweeps the bandpass frequency and gain upward with the current payout
// multiplier so a longer flight audibly builds.
let windNodes = null;
export function startWind() {
  if (windNodes) return;
  const ac = ctx();
  const src = ac.createBufferSource();
  src.buffer = getNoiseBuffer(ac); src.loop = true;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass'; filter.frequency.value = 350; filter.Q.value = 0.6;
  const g = ac.createGain(); g.gain.value = 0;
  src.connect(filter); filter.connect(g); g.connect(ac.destination);
  src.start();
  g.gain.linearRampToValueAtTime(0.05 * sfxVolume, ac.currentTime + 0.2);
  windNodes = { src, filter, g };
}
export function setWindIntensity(mult) {
  if (!windNodes) return;
  const ac = ctx();
  const t = Math.max(0, Math.min(1, (mult - 1) / 6));
  windNodes.filter.frequency.setTargetAtTime(300 + t * 2200, ac.currentTime, 0.08);
  windNodes.g.gain.setTargetAtTime((0.045 + t * 0.09) * sfxVolume, ac.currentTime, 0.08);
}
export function stopWind() {
  if (!windNodes) return;
  const ac = ctx();
  const { src, g } = windNodes;
  g.gain.cancelScheduledValues(ac.currentTime);
  g.gain.setValueAtTime(g.gain.value, ac.currentTime);
  g.gain.linearRampToValueAtTime(0, ac.currentTime + 0.15);
  windNodes = null;
  setTimeout(() => { try { src.stop(); } catch { /* already stopped */ } }, 200);
}

// A low thump + a short filtered noise burst on landing/crash impact.
export function playCrashThud() {
  const ac = ctx();
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(140, ac.currentTime);
  o.frequency.exponentialRampToValueAtTime(40, ac.currentTime + 0.25);
  o.connect(g); g.connect(ac.destination);
  g.gain.setValueAtTime(0.32 * sfxVolume, ac.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.3);
  o.start(); o.stop(ac.currentTime + 0.32);

  const src = ac.createBufferSource();
  src.buffer = getNoiseBuffer(ac);
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass'; filter.frequency.value = 1100;
  const ng = ac.createGain();
  src.connect(filter); filter.connect(ng); ng.connect(ac.destination);
  ng.gain.setValueAtTime(0.26 * sfxVolume, ac.currentTime);
  ng.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.2);
  src.start(); src.stop(ac.currentTime + 0.22);
}

// A soft, looping three-tone night-air pad — the "Background Music" toggle.
// Kept deliberately quiet/simple (sustained detuned sines, no melody) so it
// sits behind the SFX rather than competing with it.
let ambientNodes = null;
export function startAmbient() {
  if (ambientNodes) return;
  const ac = ctx();
  const master = ac.createGain();
  master.gain.value = 0;
  master.connect(ac.destination);
  master.gain.linearRampToValueAtTime(0.09 * musicVolume, ac.currentTime + 1.5);

  const oscs = [110, 164.8, 220].map((freq, i) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.value = i === 0 ? 1 : 0.5;
    o.connect(g); g.connect(master);
    o.start();
    return o;
  });

  ambientNodes = { master, oscs };
}

export function stopAmbient() {
  if (!ambientNodes) return;
  const ac = ctx();
  const { master, oscs } = ambientNodes;
  const now = ac.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setValueAtTime(master.gain.value, now);
  master.gain.linearRampToValueAtTime(0, now + 0.6);
  ambientNodes = null;
  setTimeout(() => { oscs.forEach(o => { try { o.stop(); } catch { /* already stopped */ } }); }, 700);
}

export function playLose() {
  const ac = ctx();
  const notes = [300, 220, 160];
  notes.forEach((freq, i) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const t = ac.currentTime + i * 0.18;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.2, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.start(t); o.stop(t + 0.25);
  });
}
