// WebAudio jingles. The AudioContext is created lazily so it is unlocked by the
// user gesture (the "Place Bet" click) before any sound plays.

let audioCtx = null;
function ctx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
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
    g.gain.linearRampToValueAtTime(0.18, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.start(t); o.stop(t + 0.2);
  });
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
