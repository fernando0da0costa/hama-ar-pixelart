// Efeitos sonoros curtos, sintetizados na hora via Web Audio API — sem
// arquivo de áudio pra empacotar/baixar. Usado pelos dois modos (webcam e RA
// imersiva) nos mesmos quatro eventos: pegar conta, encaixar certo, errar a
// cor, completar o desenho.

let ctx = null;

function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

// Navegadores só deixam o AudioContext tocar de verdade depois de um gesto
// direto do usuário (clique/toque) — chame isto dentro do handler de clique
// que já existe pra entrar em RA/webcam, antes da sessão começar, pra já
// destravar o áudio pro resto da sessão (que dispara som a partir de gesto
// de mão, não de clique).
export function primeAudio() {
  const audioCtx = getCtx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function beep({ freq, duration, type = 'sine', gain = 0.2, glideTo = null, delay = 0 }) {
  const audioCtx = getCtx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const t0 = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + duration);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g);
  g.connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

export function playPickup() {
  beep({ freq: 520, duration: 0.08, type: 'triangle', gain: 0.15 });
}

export function playCorrect() {
  beep({ freq: 660, duration: 0.12, type: 'sine', gain: 0.2, glideTo: 880 });
}

export function playWrong() {
  beep({ freq: 180, duration: 0.18, type: 'sawtooth', gain: 0.15, glideTo: 110 });
}

export function playComplete() {
  [523, 659, 784, 1047].forEach((freq, i) => beep({ freq, duration: 0.16, type: 'sine', gain: 0.2, delay: i * 0.09 }));
}
