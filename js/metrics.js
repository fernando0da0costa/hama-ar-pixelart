// Instrumentação para as medições do artigo (A2.3, Tabela de medições /
// RNF2 / RNF3). Desligada por padrão — só liga com ?metrics=1 na URL, e aí
// não muda nada no jogo: só registra, mostra um painel no canto e permite
// baixar o CSV (botão no painel, ou hamaMetrics.download() no console,
// inclusive pelo chrome://inspect no celular).
//
// O que é medido, por quadro do laço (requestAnimationFrame):
//  - inferMs: tempo da chamada handLandmarker.detectForVideo() (o componente de IA)
//  - frameMs: intervalo desde o quadro anterior (→ FPS)
//  - loopMs: início do quadro até o fim do draw() (processamento + desenho)
//  - pinchRatio / pinching: distância polegar↔indicador ÷ largura do vídeo, e
//    o estado binário da pinça (mão 0) — base do RNF3 (alternâncias por segundo)
//  - modo placa física: markers (quantos dos 4 marcadores foram vistos),
//    markerMs (detecção ArUco + homografia) e colorMs (classificação de cor
//    dos 64 pinos); eventos 'acerto'/'erro' = mudança confirmada de um pino
// E por evento de encaixe (acerto/erro): feedbackMs = do início do quadro em
// que a pinça foi interpretada até o fim do desenho desse mesmo quadro (RNF2).
// Não inclui a latência de captura da câmera nem a de exibição da tela.

const ENABLED = new URLSearchParams(location.search).get('metrics') === '1';
const MAX_FRAMES = 60 * 60 * 10; // ~10 min a 60 fps; depois descarta os mais antigos

const frames = [];
const events = [];
let frameStart = 0;
let lastFrameStart = 0;
let inferMs = null;
let pinch = null;
let board = null;
let pendingEvents = [];
let panel = null;
let panelText = null;
let lastPanelUpdate = 0;
let sessionStart = 0;
let inFrame = false;
let prevWasWarmup = false;
let warmupDone = false; // 1ª inferência inclui a inicialização do grafo/GPU — fica marcada e fora do resumo

export function metricsEnabled() { return ENABLED; }

export function beginFrame() {
  if (!ENABLED) return;
  lastFrameStart = frameStart;
  frameStart = performance.now();
  if (!sessionStart) sessionStart = frameStart;
  inFrame = true;
  inferMs = null;
  pinch = null;
  board = null;
}

export function recordInference(ms) {
  if (!ENABLED) return;
  inferMs = ms;
}

export function recordPinch(ratio, pinching) {
  if (!ENABLED || pinch) return; // só a primeira mão do quadro
  pinch = { ratio, pinching };
}

export function recordBoard({ markers, markerMs, colorMs }) {
  if (!ENABLED) return;
  board = { markers, markerMs, colorMs };
}

export function recordFeedback(kind, decidedAt = null) {
  if (!ENABLED) return;
  // decidedAt (modo WebXR): instante em que o resultado da inferência gerou o
  // evento, fora do quadro; o feedbackMs passa a ir desse instante até o fim
  // do desenho do quadro seguinte. Sem ele: fora do laço = veio do mouse
  // (evento DOM entre quadros), marcado separado por não ser comparável.
  if (decidedAt !== null) pendingEvents.push({ kind, decidedAt });
  else pendingEvents.push(inFrame ? kind : `${kind}-mouse`);
}

export function endFrame() {
  if (!ENABLED) return;
  inFrame = false;
  const end = performance.now();
  frames.push({
    t: frameStart - sessionStart,
    // intervalo que inclui o quadro de aquecimento também fica de fora do FPS
    frameMs: lastFrameStart && warmupDone && !prevWasWarmup ? frameStart - lastFrameStart : null,
    inferMs,
    loopMs: end - frameStart,
    warmup: inferMs !== null && !warmupDone ? 1 : 0,
    pinchRatio: pinch ? pinch.ratio : null,
    pinching: pinch ? (pinch.pinching ? 1 : 0) : null,
    markers: board ? board.markers : null,
    markerMs: board ? board.markerMs : null,
    colorMs: board ? board.colorMs : null,
  });
  prevWasWarmup = frames[frames.length - 1].warmup === 1;
  if (inferMs !== null) warmupDone = true;
  if (frames.length > MAX_FRAMES) frames.shift();
  for (const ev of pendingEvents) {
    if (typeof ev === 'object') events.push({ t: ev.decidedAt - sessionStart, kind: ev.kind, feedbackMs: end - ev.decidedAt });
    else events.push({ t: frameStart - sessionStart, kind: ev, feedbackMs: end - frameStart });
  }
  pendingEvents = [];
  if (end - lastPanelUpdate > 500) {
    lastPanelUpdate = end;
    updatePanel();
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// Alternâncias do estado de pinça por segundo, só contando quadros em que a
// mão foi vista (RNF3: segurar 5 s perto do limiar e contar as trocas).
function toggleRate(list) {
  let toggles = 0, prev = null, first = null, last = null;
  for (const f of list) {
    if (f.pinching === null) continue;
    if (first === null) first = f.t;
    last = f.t;
    if (prev !== null && f.pinching !== prev) toggles++;
    prev = f.pinching;
  }
  const secs = first === null ? 0 : (last - first) / 1000;
  return secs > 0 ? toggles / secs : null;
}

export function summary(windowMs = Infinity) {
  const now = frames.length ? frames[frames.length - 1].t : 0;
  const list = frames.filter((f) => now - f.t <= windowMs && !f.warmup);
  const infer = list.map((f) => f.inferMs).filter((v) => v !== null);
  const frame = list.map((f) => f.frameMs).filter((v) => v !== null);
  const fb = events.filter((e) => now - e.t <= windowMs && !e.kind.endsWith('-mouse')).map((e) => e.feedbackMs);
  const meanFrame = frame.length ? frame.reduce((a, b) => a + b, 0) / frame.length : null;
  const marker = list.map((f) => f.markerMs).filter((v) => v !== null && v !== undefined);
  const color = list.map((f) => f.colorMs).filter((v) => v !== null && v !== undefined);
  return {
    frames: list.length,
    inferP50: percentile(infer, 50),
    inferP95: percentile(infer, 95),
    fps: meanFrame ? 1000 / meanFrame : null,
    togglesPerSec: toggleRate(list),
    feedbackEvents: fb.length,
    feedbackP95: percentile(fb, 95),
    markerP50: percentile(marker, 50),
    colorP50: percentile(color, 50),
  };
}

function fmt(v, d = 1) { return v === null || v === undefined ? '—' : v.toFixed(d); }

function updatePanel() {
  if (!panel) createPanel();
  const all = summary();
  const last5 = summary(5000);
  const p = frames.length ? frames[frames.length - 1] : null;
  panelText.textContent =
    `métricas (${all.frames} quadros)\n` +
    `inferência P50/P95: ${fmt(all.inferP50)} / ${fmt(all.inferP95)} ms\n` +
    `FPS médio: ${fmt(all.fps)}\n` +
    `pinça d/L agora: ${p && p.pinchRatio !== null ? p.pinchRatio.toFixed(3) : '—'}\n` +
    `alternâncias/s (últimos 5 s): ${fmt(last5.togglesPerSec, 2)}\n` +
    `retorno P95 (${all.feedbackEvents} encaixes): ${fmt(all.feedbackP95)} ms` +
    (all.markerP50 !== null ? `\nplaca: marcadores ${p && p.markers !== null ? p.markers : '—'}/4 · ArUco P50 ${fmt(all.markerP50)} ms · cor P50 ${fmt(all.colorP50)} ms` : '');
}

function createPanel() {
  panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:9999;background:rgba(0,0,0,.72);color:#fff;' +
    'font:11px/1.35 monospace;padding:6px 8px;border-radius:6px;white-space:pre;';
  panelText = document.createElement('div');
  const buttons = document.createElement('div');
  buttons.style.cssText = 'margin-top:4px;display:flex;gap:6px;';
  for (const [label, fn] of [['baixar CSV', download], ['zerar', reset]]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'font:11px monospace;padding:2px 6px;';
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    buttons.appendChild(b);
  }
  panel.append(panelText, buttons);
  document.body.appendChild(panel);
}

export function reset() {
  frames.length = 0;
  events.length = 0;
  pendingEvents = [];
  sessionStart = 0;
  warmupDone = false;
  prevWasWarmup = false;
  lastFrameStart = 0;
  frameStart = 0;
}

function toCSV() {
  const lines = ['tipo,t_ms,frame_ms,infer_ms,loop_ms,pinch_ratio,pinching,aquecimento,evento,feedback_ms,marcadores,aruco_ms,cor_ms'];
  const n = (v, d = 3) => (v === null || v === undefined ? '' : v.toFixed(d));
  for (const f of frames) {
    lines.push(`quadro,${n(f.t, 1)},${n(f.frameMs)},${n(f.inferMs)},${n(f.loopMs)},${n(f.pinchRatio, 4)},${f.pinching ?? ''},${f.warmup},,,${f.markers ?? ''},${n(f.markerMs)},${n(f.colorMs)}`);
  }
  for (const e of events) {
    lines.push(`evento,${n(e.t, 1)},,,,,,,${e.kind},${n(e.feedbackMs)},,,`);
  }
  return lines.join('\n');
}

export function download() {
  const blob = new Blob([toCSV()], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hama-metricas-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

if (ENABLED) {
  window.hamaMetrics = { summary, download, reset, toCSV };
  console.info('[hama-metrics] instrumentação ligada (?metrics=1). Use hamaMetrics.summary() / hamaMetrics.download().');
}
