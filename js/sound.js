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
  // Triangle em vez de sawtooth (sem harmônicos ásperos) e glide curto de
  // apenas um tom inteiro (220->196Hz) em vez de queda de quinta: sinaliza
  // "não é essa" sem soar como alarme, por causa da sensibilidade sensorial
  // do público-alvo (crianças com TEA).
  beep({ freq: 220, duration: 0.12, type: 'triangle', gain: 0.12, glideTo: 196 });
}

export function playBeeSteal() {
  // Abelha rouba uma conta já colocada: descida rápida (triangle, sem
  // harmônicos ásperos) — dá um aviso claro sem soar como alarme forte.
  beep({ freq: 320, duration: 0.16, type: 'triangle', gain: 0.16, glideTo: 150 });
}

export function playBeeSwat() {
  // Espantou a abelha: subida curtinha e satisfatória.
  beep({ freq: 480, duration: 0.09, type: 'triangle', gain: 0.18, glideTo: 820 });
}

export function playComplete() {
  // Fanfarra tipo "fase completa" de videogame: sobe rápido e termina com um
  // acorde (as duas últimas notas juntas) em vez de só mais uma nota solta.
  [523, 659, 784, 1047].forEach((freq, i) => beep({ freq, duration: 0.16, type: 'sine', gain: 0.22, delay: i * 0.075 }));
  beep({ freq: 1318, duration: 0.3, type: 'sine', gain: 0.16, delay: 0.075 * 3 });
}

// ------------------------------------------------------------------ //
// Música de fundo — riff de rock clássico em RTTTL (aquele formato de texto
// puro que ia em toque de celular Nokia), tocado em loop com onda quadrada
// (o "beep" característico de toque antigo) por cima do mesmo filtro passa-
// baixa de sempre, pra não ficar estridente. O brilho do filtro e um baixo
// grave por baixo do riff sobem com setMusicIntensity(fração 0..1)
// acompanhando o progresso — riff sozinho e mais fechado no começo do
// desenho, com baixo e mais brilho conforme vai acertando.
// ------------------------------------------------------------------ //

const MUSIC_KEY = 'hama-ar:music-enabled';
const SCHEDULE_AHEAD = 0.12; // segundos de antecedência pra agendar notas (evita jitter do setInterval)
const TICK_MS = 30;

// Playlist de riffs de rock em RTTTL — d=duração padrão, o=oitava padrão,
// b=andamento (bpm). Cada vez que a música (re)começa (ver startMusic), uma
// delas é escolhida ao acaso e toca em loop contínuo até a próxima troca de
// fase (ver tickMusic) — mais variedade que ficar preso num riff só.
const RTTTL_TUNES = [
  // O riff clássico de "Iron Man" (Black Sabbath).
  'IronMan:d=4,o=5,b=120:b,d,d,e,e,8g,8f#,8g,8f#,8g,4d,8d,e,e',
  // Riff autoral em power chord, mais longo (duas frases + fecho).
  'PowerRiff:d=8,o=4,b=138:e,e,g,e,e,g,a,g,e,e,g,e,e,g,4a,g,d,d,f,d,d,f,g,f,d,d,f,d,4e,4e',
  // Linha de "solo" autoral, mais aguda e melódica, com um pico numa oitava acima.
  'SoloLine:d=8,o=5,b=150:g,a,b,a,g,e,d,e,g,a,b,d6,b,a,g,e,d,e,4g,a,b,a,g,e,d,4c,d,e,4d',
];

// Frequências em Hz na 4ª oitava — cada oitava acima dobra, ver noteFrequency.
const NOTE_BASE_FREQ = {
  c: 261.63, 'c#': 277.18, d: 293.66, 'd#': 311.13, e: 329.63, f: 349.23,
  'f#': 369.99, g: 392.00, 'g#': 415.30, a: 440.00, 'a#': 466.16, b: 493.88,
};

function noteFrequency(name, octave) {
  if (name === 'p') return 0; // pausa
  return NOTE_BASE_FREQ[name] * Math.pow(2, octave - 4);
}

// Converte uma string RTTTL em {bpm, notes:[{freq, seconds}]} — cada nota já
// vem com a duração exata em segundos (whole note = 4 semínimas, ponto
// aumenta 50%), pronta pra agendar direto no Web Audio, sem reparsear nada
// dentro do loop de reprodução (ver tickMusic).
function parseRTTTL(tune) {
  const [, header, body] = tune.split(':');
  const defaults = { d: 4, o: 5, b: 63 };
  for (const part of header.split(',')) {
    const [key, value] = part.split('=');
    if (key === 'd') defaults.d = parseInt(value, 10);
    else if (key === 'o') defaults.o = parseInt(value, 10);
    else if (key === 'b') defaults.b = parseInt(value, 10);
  }
  const wholeNoteSeconds = (60 / defaults.b) * 4;

  const notes = body.split(',').map((token) => {
    const m = token.trim().toLowerCase().match(/^(\d+)?(p|[a-g]#?)(\.)?(\d)?(\.)?$/);
    if (!m) return null;
    const duration = m[1] ? parseInt(m[1], 10) : defaults.d;
    const name = m[2];
    const octave = m[4] ? parseInt(m[4], 10) : defaults.o;
    const dotted = Boolean(m[3] || m[5]);
    let seconds = wholeNoteSeconds / duration;
    if (dotted) seconds *= 1.5;
    return { freq: noteFrequency(name, octave), seconds };
  }).filter(Boolean);

  return { bpm: defaults.b, notes };
}

const PARSED_TUNES = RTTTL_TUNES.map(parseRTTTL);
let activeRiff = PARSED_TUNES[0]; // trocada ao acaso a cada startMusic()

function loadMusicPref() {
  try {
    const v = localStorage.getItem(MUSIC_KEY);
    return v === null ? true : v === '1';
  } catch { return true; }
}

function saveMusicPref(v) {
  try { localStorage.setItem(MUSIC_KEY, v ? '1' : '0'); } catch {}
}

let musicEnabled = loadMusicPref();
let musicGain = null;
let musicFilter = null;
let musicTimer = null;
let noteIndex = 0;
let nextNoteTime = 0;
let musicIntensity = 0.35;
let musicBoostUntil = 0;

export function isMusicEnabled() { return musicEnabled; }

function ensureMusicNodes() {
  if (musicGain) return;
  const audioCtx = getCtx();
  musicFilter = audioCtx.createBiquadFilter();
  musicFilter.type = 'lowpass';
  musicFilter.frequency.value = 850; // Começo macio para preservação sensorial
  musicGain = audioCtx.createGain();
  musicGain.gain.value = 0;
  musicFilter.connect(musicGain);
  musicGain.connect(audioCtx.destination);
}

function scheduleTone(freq, time, duration, gain, type) {
  const audioCtx = getCtx();
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, time);
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(gain, time + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  osc.connect(g);
  g.connect(musicFilter);
  osc.start(time);
  osc.stop(time + duration + 0.05);
}

// Toca uma nota do riff (onda quadrada, o "beep" clássico de toque antigo) —
// pausas (freq 0) só avançam o tempo, sem som. Acima de uma certa
// intensidade, dobra com um baixo grave (2 oitavas abaixo, triangular pra
// não ficar áspero) por baixo da mesma nota, dando corpo de "banda" ao riff
// solo conforme o desenho vai sendo preenchido certo.
function scheduleRiffNote(note, time, intensity) {
  if (note.freq <= 0) return;
  const melodyGain = 0.09 + intensity * 0.05;
  scheduleTone(note.freq, time, note.seconds * 0.92, melodyGain, 'square');
  if (intensity > 0.35) {
    const bassGain = 0.05 + intensity * 0.03;
    scheduleTone(note.freq / 4, time, note.seconds * 0.9, bassGain, 'triangle');
  }
}

function tickMusic() {
  if (!musicEnabled) return;
  const audioCtx = getCtx();

  const boosted = performance.now() < musicBoostUntil;
  const currentIntensity = boosted ? 1.0 : musicIntensity;
  // O filtro abre dinamicamente, abrindo espaço pra onda quadrada brilhar
  // mais conforme o desenho avança, sem ficar estridente desde o começo.
  const targetFilterFreq = 900 + currentIntensity * 2200;
  if (musicFilter) {
    musicFilter.frequency.setTargetAtTime(targetFilterFreq, audioCtx.currentTime, 0.15);
  }

  while (nextNoteTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
    const note = activeRiff.notes[noteIndex];
    scheduleRiffNote(note, nextNoteTime, currentIntensity);
    nextNoteTime += note.seconds;
    noteIndex = (noteIndex + 1) % activeRiff.notes.length;
  }
}

export function startMusic() {
  if (!musicEnabled) return;
  const audioCtx = getCtx();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  ensureMusicNodes();
  if (musicTimer) clearInterval(musicTimer);

  activeRiff = PARSED_TUNES[Math.floor(Math.random() * PARSED_TUNES.length)];
  nextNoteTime = audioCtx.currentTime + 0.05;
  noteIndex = 0;

  musicGain.gain.setValueAtTime(musicGain.gain.value, audioCtx.currentTime);
  musicGain.gain.linearRampToValueAtTime(1.0, audioCtx.currentTime + 1.5);

  musicTimer = setInterval(tickMusic, TICK_MS);
}

export function stopMusic() {
  if (!musicTimer) return;
  clearInterval(musicTimer);
  musicTimer = null;

  const audioCtx = getCtx();
  if (musicGain) {
    musicGain.gain.setValueAtTime(musicGain.gain.value, audioCtx.currentTime);
    musicGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.4);
  }
}

export function toggleMusic() {
  musicEnabled = !musicEnabled;
  saveMusicPref(musicEnabled);
  if (musicEnabled) {
    startMusic();
  } else {
    stopMusic();
  }
  return musicEnabled;
}

export function setMusicIntensity(fraction) {
  musicIntensity = Math.max(0, Math.min(1, fraction));
}

export function triggerMusicFlourish(durationMs = 4000) {
  musicBoostUntil = performance.now() + durationMs;
}