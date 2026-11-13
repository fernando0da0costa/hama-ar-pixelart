// Modo placa física: a câmera fica ACIMA de uma placa perfurada Hama de
// verdade, apoiada sobre a folha de marcadores (marcadores.html). Os quatro
// marcadores ArUco dos cantos da folha dão, a cada quadro, a homografia entre
// a folha e a imagem — com ela a grade-alvo é desenhada exatamente em cima
// dos pinos reais, e a cor de cada pino é lida da própria imagem.
//
// Quem decide se acertou é a leitura da placa (classificação de cor por
// pino), não o gesto: a mão só GUIA — destaca o pino sob o indicador e,
// com a pinça fechada, confere se a conta segurada é da cor certa antes de
// encaixar. Mesma interface de callbacks do webcam-scene.js
// (onProgress/onHint/onExit/onPlayAgain).
//
// Requer js-aruco2 carregado como script clássico (window.AR), ver index.html.

import { getHandLandmarker, isMirrorEnabled } from './webcam-scene.js';
import { init3D, resize3D, setLayout, render3D, dispose3D } from './board-3d.js';
import { HAMA_PALETTE } from './pattern.js';
import { playCorrect, playWrong, playBeeSwat, playComplete } from './sound.js';
import { beginFrame, endFrame, recordInference, recordPinch, recordFeedback, recordBoard } from './metrics.js';
import {
  MARKER_CENTERS_MM, MARKER_MM, MARKER_DICTIONARY, WHITE_REF_MM, GRID_N, defaultGridCornersMm, gridPitchMm,
} from './board-sheet.js';
import {
  homographyFrom4, homographyLSQ, applyH, invertH, multiplyH, rgbToLab, deltaE, sampleRing,
  whiteBalanceGains, applyGains, classifyLab, refineCentroids, medianLab,
  convexHull, expandPolygon, pointInPolygon,
} from './board-vision.js';

const PINCH_THRESHOLD_RATIO = 0.075; // mesmo limiar do modo virtual (Eq. 3 do artigo)
const HAND_LOST_GRACE_MS = 400;
const BACK_DWELL_MS = 3000;
const PROC_W = 640; // resolução de processamento (ArUco + amostragem de cor)
// Plano travado: câmera e folha ficam paradas, então a última homografia
// vale indefinidamente quando a mão tampa os marcadores; qualquer marcador
// que reaparece (1 já basta: 4 cantos) atualiza a estimativa.
const MARKER_INNER_MM = MARKER_MM * 0.8; // quadrado preto detectado (borda branca de 1 módulo em 10)
const STABLE_FRAMES = 6; // quadros seguidos com a mesma leitura pra confirmar mudança de um pino
const REJECT_DELTA = 30; // ΔE máximo pra aceitar uma cor (acima disso: indeterminado)
const AUTO_CALIBRATE_AFTER = 20; // quadros seguidos com os 4 marcadores antes da calibração automática
const GRID_KEY = 'hama-ar:grid-corners-mm';

// Cores "de distração" que a placa reconhece além das cores do desenho, pra
// detectar conta de cor errada. Cinzas ficam de fora (confundem com pino/sombra).
const DISTRACTORS = ['Branco', 'Preto', 'Vermelho', 'Laranja', 'Amarelo', 'Verde', 'Azul', 'Roxo', 'Rosa', 'Marrom'];

// Abelhas (RF11): mesma curva de dificuldade do modo virtual, mas aqui a
// abelha não "rouba" — conta física não some. Ela pousa em cima da próxima
// célula a preencher, tampando a dica, até ser espantada com uma pinça.
const BEE_BASE_IDLE_MS = 11000, BEE_IDLE_STEP_MS = 900, BEE_MIN_IDLE_MS = 3500;
const BEE_MAX_COUNT_CAP = 4, BEE_LEVELS_PER_EXTRA_BEE = 2;
const BEE_SEEK_SPEED_FRAC = 0.2, BEE_FLEE_SPEED_FRAC = 0.5;
const BEE_MAX_SPEED_MULT = 2.4, BEE_SPEED_STEP = 0.16;

let video, overlay, ctx, stageEl, container, proc, procCtx;
let stream = null, running = false, rafId = null, resizeHandler = null;
let facingMode = 'environment';
let callbacks = { onProgress: () => {}, onHint: () => {}, onExit: () => {}, onPlayAgain: () => {} };
let detector = null, handLandmarker = null;

let pattern = null;
let difficulty = 0;
let pins = []; // 64 pinos: { gx, gy, target, x, y, cand, candCount, state, occluded }
let H_matToImg = null; // folha (mm) → imagem (px do vídeo)
let H_gridToImg = null, H_imgToGrid = null; // grade (índice do pino) → imagem e volta
let G_gridToMat = null; // grade → folha (posição da placa na folha)
let lastMarkersAt = 0, markersSeen = 0, consecutiveFull = 0, hQuality = 0;
let pitchPx = 20;

let gains = [1, 1, 1];
let classes = []; // [{ id, lab }] — id 'vazio' ou nome da cor
let calibrated = false, calibratingUntil = 0;

let hands = [newHand(), newHand()];
let backHoverStart = 0;
let bees = [], lastActivityAt = 0;
let completeShown = false, winActive = false;
let gridAdjust = null; // { points: [] } enquanto o usuário marca os 4 cantos
let lastHint = '';
let hintHoldUntil = 0; // segura mensagens pontuais (calibração, ajuste) antes de voltar às dicas automáticas
let lastMarkers = []; // [{ id, pts }] em px do vídeo — contorno desenhado como diagnóstico
let lastAutoCalibAt = 0;
let pointerCarry = null; // cor escolhida na bandeja por toque/clique (sem mão)

function newHand() {
  return { pinching: false, lastSeenAt: 0, tip: null, mid: null, hull: null, cell: null, beadColor: undefined, carry: null };
}

// ---------------------------------------------------------------- //
// Sessão
// ---------------------------------------------------------------- //

export async function startBoard(patternData, cbs, containerEl, difficultyLevel = 0) {
  if (!window.AR) throw new Error('js-aruco2 não carregou (sem internet?)');
  pattern = patternData;
  callbacks = { ...callbacks, ...cbs };
  container = containerEl;
  difficulty = Math.max(0, difficultyLevel);
  hands = [newHand(), newHand()];
  bees = [];
  completeShown = false;
  winActive = false;
  gridAdjust = null;
  calibrated = false;
  consecutiveFull = 0;
  lastActivityAt = performance.now();
  H_matToImg = null;
  hQuality = 0;
  G_gridToMat = loadGridCorners();
  buildPins();
  buildClasses();

  detector = detector || new window.AR.Detector({ dictionaryName: MARKER_DICTIONARY });

  video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.style.cssText = 'width:100%; height:100%; display:block;';
  overlay = document.createElement('canvas');
  overlay.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; display:block;';
  ctx = overlay.getContext('2d');
  proc = document.createElement('canvas');
  procCtx = proc.getContext('2d', { willReadFrequently: true });

  stageEl = document.createElement('div');
  stageEl.style.cssText = 'position:absolute; inset:0; margin:auto; background:#000; overflow:hidden; cursor:crosshair;';
  stageEl.append(video, overlay);
  init3D(stageEl, overlay);
  relayout3D();
  container.appendChild(stageEl);
  overlay.addEventListener('pointerdown', onPointerDown);

  hint('Pedindo acesso à câmera...');
  await openStream(facingMode);
  applyBoardMirror();
  hint('Carregando o rastreador de mãos...');
  handLandmarker = await getHandLandmarker();

  fitStage();
  resizeHandler = () => fitStage();
  window.addEventListener('resize', resizeHandler);

  reportProgress();
  running = true;
  rafId = requestAnimationFrame(loop);
}

export function exitBoard() {
  teardown();
  callbacks.onExit();
}

function relayout3D() {
  setLayout({
    pins, gridToMat: G_gridToMat, pitchMm: gridPitchMm(), tray: trayLayoutMm(), colorOf,
    showPegboard: new URLSearchParams(location.search).get('placaVirtual') !== '0',
  });
}

function teardown() {
  dispose3D();
  running = false;
  if (rafId !== null) cancelAnimationFrame(rafId);
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
  if (stageEl && stageEl.parentElement) stageEl.parentElement.removeChild(stageEl);
  stageEl = null;
  mirrored = false;
}

async function openStream(requested) {
  let s;
  try {
    s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: requested, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
  } catch (e) {
    hint('Não consegui acessar a câmera: ' + e.message);
    throw e;
  }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = s;
  facingMode = requested;
  video.srcObject = stream;
  await video.play();
}

export async function flipBoardCamera() {
  try { await openStream(facingMode === 'user' ? 'environment' : 'user'); } catch { return; }
  fitStage();
}

export function showBoardComplete() {
  winActive = true;
}

function fitStage() {
  const vw = video.videoWidth || 4, vh = video.videoHeight || 3;
  stageEl.style.width = '100%';
  stageEl.style.height = '100%';
  stageEl.style.maxWidth = `calc(100vh * ${vw} / ${vh})`;
  stageEl.style.maxHeight = `calc(100vw * ${vh} / ${vw})`;
  overlay.width = vw;
  resize3D(vw, vh);
  overlay.height = vh;
  proc.width = PROC_W;
  proc.height = Math.round(PROC_W * vh / vw);
}

// Espelhamento: mesma regra do modo virtual (botão 🪞), espelhando o PALCO
// inteiro (vídeo + canvas) via CSS — a detecção e a homografia continuam no
// quadro original. Só a câmera traseira não espelha; webcams de notebook não
// informam facingMode e contam como frontais.
let mirrored = false;
function actualFacing() {
  const track = stream && stream.getVideoTracks()[0];
  const fm = track && track.getSettings ? track.getSettings().facingMode : undefined;
  return fm || (facingMode === 'environment' && /Android|iPhone|iPad/i.test(navigator.userAgent) ? 'environment' : 'user');
}
function applyBoardMirror() {
  const want = isMirrorEnabled() && actualFacing() !== 'environment';
  if (want === mirrored && stageEl && stageEl.dataset.m === String(want)) return;
  mirrored = want;
  if (stageEl) { stageEl.style.transform = want ? 'scaleX(-1)' : 'none'; stageEl.dataset.m = String(want); }
}

// Texto no canvas: desfaz o espelho localmente pra continuar legível.
function fillTextUnmirrored(text, x, y) {
  if (!mirrored) { ctx.fillText(text, x, y); return; }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(-1, 1);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function hint(text, holdMs = 0) {
  if (holdMs) hintHoldUntil = performance.now() + holdMs;
  if (text === lastHint) return;
  lastHint = text;
  callbacks.onHint(text);
}

// ---------------------------------------------------------------- //
// Grade, classes de cor e calibração
// ---------------------------------------------------------------- //

function buildPins() {
  // A forma é um bitmap 8×8; cada pino da área 8×8 da placa recebe o alvo
  // correspondente (ou null = deve ficar vazio).
  pins = [];
  for (let gy = 0; gy < GRID_N; gy++) {
    for (let gx = 0; gx < GRID_N; gx++) {
      const inShape = gx < pattern.w && gy < pattern.h;
      const target = inShape ? pattern.cells[gy * pattern.w + gx] : null;
      pins.push({ gx, gy, target: target ? target.name : null, x: 0, y: 0, cand: null, candCount: 0, state: 'vazio', occluded: false });
    }
  }
}

function buildClasses(vazioLab = null) {
  const names = new Set([...pattern.legend.map((l) => l.name), ...DISTRACTORS]);
  classes = [...names].map((name) => {
    const rgb = (HAMA_PALETTE.find((p) => p[0] === name) || [name, [128, 128, 128]])[1];
    return { id: name, lab: rgbToLab(rgb) };
  });
  if (vazioLab) {
    // Pino vazio muito parecido com uma cor de distração (ex.: placa
    // transparente sobre papel branco × conta branca): tira a distração, pra
    // não ver conta onde não tem. Cores do próprio desenho nunca saem.
    const legendNames = new Set(pattern.legend.map((l) => l.name));
    classes = classes.filter((c) => legendNames.has(c.id) || deltaE(c.lab, vazioLab) > 18);
    classes.push({ id: 'vazio', lab: vazioLab });
  }
}

// Ajuste plausível: cada canto a no máximo 25 mm do canto padrão (a placa
// fica sobre o quadrado tracejado). Um ajuste mal tocado espalhava os pinos
// para fora da folha, e eles liam a cor da parede como "conta errada".
const MAX_ADJUST_MM = 25;
function plausibleCorners(pts) {
  const def = defaultGridCornersMm();
  return Array.isArray(pts) && pts.length === 4 && pts.every((p, i) =>
    Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
    Math.hypot(p[0] - def[i][0], p[1] - def[i][1]) <= MAX_ADJUST_MM);
}

function loadGridCorners() {
  try {
    const raw = JSON.parse(localStorage.getItem(GRID_KEY) || 'null');
    if (plausibleCorners(raw)) return gridHomography(raw);
    if (raw) localStorage.removeItem(GRID_KEY); // ajuste antigo inválido: descarta
  } catch { /* sem localStorage: usa a posição padrão */ }
  return gridHomography(defaultGridCornersMm());
}

function gridHomography(cornersMm) {
  const last = GRID_N - 1;
  return homographyFrom4([[0, 0], [last, 0], [last, last], [0, last]], cornersMm);
}

// "Ajustar grade": o usuário clica/toca no centro dos 4 pinos dos cantos da
// área 8×8 (sup. esq., sup. dir., inf. dir., inf. esq.). Grava a posição em
// mm da folha, então vale enquanto a placa não for mexida em cima dela.
export function startGridAdjust() {
  gridAdjust = { points: [] };
  hint('Ajuste: toque no pino do canto SUPERIOR ESQUERDO da área 8×8.');
}

const CORNER_NAMES = ['SUPERIOR ESQUERDO', 'SUPERIOR DIREITO', 'INFERIOR DIREITO', 'INFERIOR ESQUERDO'];

function onPointerDown(evt) {
  if (!gridAdjust) { onPointerPlay(evt); return; }
  if (!H_matToImg) { hint('Mostre os 4 marcadores para a câmera antes de ajustar.'); return; }
  const rect = overlay.getBoundingClientRect();
  let x = ((evt.clientX - rect.left) / rect.width) * overlay.width;
  if (mirrored) x = overlay.width - x; // toque na tela espelhada → pixel do quadro
  const y = ((evt.clientY - rect.top) / rect.height) * overlay.height;
  gridAdjust.points.push(applyH(invertH(H_matToImg), x, y));
  if (gridAdjust.points.length < 4) {
    hint(`Ajuste: toque no pino do canto ${CORNER_NAMES[gridAdjust.points.length]}.`);
    return;
  }
  if (!plausibleCorners(gridAdjust.points)) {
    gridAdjust = null;
    hint('Ajuste ignorado: os toques ficaram longe da área tracejada. Tente de novo.', 3500);
    return;
  }
  const H = gridHomography(gridAdjust.points);
  if (H) {
    G_gridToMat = H;
    relayout3D();
    try { localStorage.setItem(GRID_KEY, JSON.stringify(gridAdjust.points)); } catch { /* ok */ }
    hint('Grade ajustada!', 2500);
  }
  gridAdjust = null;
}

function pointerToFrame(evt) {
  const rect = overlay.getBoundingClientRect();
  let x = ((evt.clientX - rect.left) / rect.width) * overlay.width;
  const y = ((evt.clientY - rect.top) / rect.height) * overlay.height;
  if (mirrored) x = overlay.width - x;
  return [x, y];
}

// Jogar sem mão (toque/clique): toca numa cor da bandeja e depois no pino.
function onPointerPlay(evt) {
  if (!H_imgToGrid) { hint('Mostre os 4 marcadores da folha para a câmera.', 2000); return; }
  const [x, y] = pointerToFrame(evt);
  const tray = trayHit(x, y);
  if (tray) { pointerCarry = pointerCarry === tray ? null : tray; return; }
  const p = pinAt(x, y);
  if (!p) return;
  if (pointerCarry) placeVirtual(p, pointerCarry);
  else if (p.virtual) clearVirtual(p);
}

// ---------------------------------------------------------------- //
// Bandeja de contas virtuais (presa na folha pelos marcadores)
// ---------------------------------------------------------------- //

// Coluna(s) de cores na margem esquerda da folha, entre os marcadores.
function trayLayoutMm() {
  const legend = pattern.legend;
  const perCol = 6, gap = 14, rMm = 5.5;
  return legend.map((l, i) => {
    const col = Math.floor(i / perCol), row = i % perCol;
    const nInCol = Math.min(perCol, legend.length - col * perCol);
    return { color: l.name, mx: 82 - col * 18, my: 105 + (row - (nInCol - 1) / 2) * gap, rMm };
  });
}

function trayLayoutPx() {
  if (!H_matToImg) return [];
  return trayLayoutMm().map((t) => {
    const [x, y] = applyH(H_matToImg, t.mx, t.my);
    const [x2, y2] = applyH(H_matToImg, t.mx + t.rMm, t.my);
    return { color: t.color, x, y, r: Math.hypot(x2 - x, y2 - y) };
  });
}

function trayHit(x, y) {
  for (const t of trayLayoutPx()) if (Math.hypot(x - t.x, y - t.y) < t.r * 1.6) return t.color;
  return null;
}

function pinAt(x, y) {
  if (!H_imgToGrid) return null;
  const [gx, gy] = applyH(H_imgToGrid, x, y);
  const cx = Math.round(gx), cy = Math.round(gy);
  if (cx < 0 || cx >= GRID_N || cy < 0 || cy >= GRID_N) return null;
  return pins[cy * GRID_N + cx];
}

function placeVirtual(p, color) {
  if (p.state !== 'vazio' && !p.virtual) return; // já tem conta física
  p.virtual = true;
  p.cand = null; p.candCount = 0;
  confirmPin(p, color);
}

function clearVirtual(p) {
  p.virtual = false;
  p.state = 'vazio';
  p.cand = null; p.candCount = 0;
  reportProgress();
}

// Conta Hama com volume: gradiente radial (luz no canto sup. esq.) e furo.
function drawBead(x, y, r, rgb, alpha = 1) {
  const [R0, G0, B0] = rgb;
  const light = `rgba(${Math.min(255, R0 + 90)},${Math.min(255, G0 + 90)},${Math.min(255, B0 + 90)},${alpha})`;
  const dark = `rgba(${Math.round(R0 * 0.45)},${Math.round(G0 * 0.45)},${Math.round(B0 * 0.45)},${alpha})`;
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  g.addColorStop(0, light);
  g.addColorStop(0.45, `rgba(${R0},${G0},${B0},${alpha})`);
  g.addColorStop(1, dark);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = r * 0.5;
  ctx.shadowOffsetX = r * 0.15;
  ctx.shadowOffsetY = r * 0.25;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.32, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(0,0,0,${0.45 * alpha})`;
  ctx.fill();
}

function drawTray(now) {
  const next = nextEmptyTarget();
  for (const t of trayLayoutPx()) {
    const selected = pointerCarry === t.color;
    const suggested = next && next.target === t.color;
    if (selected || suggested) {
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r * (1.35 + (suggested ? 0.1 * Math.sin(now / 200) : 0)), 0, Math.PI * 2);
      ctx.lineWidth = Math.max(2, t.r * 0.18);
      ctx.strokeStyle = selected ? '#4ade80' : '#f9c74f';
      ctx.stroke();
    }
  }
}

function drawMarkerOutlines() {
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#4ade80';
  ctx.fillStyle = '#4ade80';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const m of lastMarkers) {
    ctx.beginPath();
    m.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    const cx = m.pts.reduce((a, p) => a + p[0], 0) / 4, cy = m.pts.reduce((a, p) => a + p[1], 0) / 4;
    fillTextUnmirrored(String(m.id), cx, cy);
  }
}

// Calibração de cor (Posição 2 — fora do laço de quadro, com indicação
// visual): mede o papel branco da folha pro balanço de branco, estima a cor
// do pino vazio pela mediana dos pinos (supõe a maior parte ainda vazia) e,
// se já houver contas na placa, reajusta os centróides por k-means.
export function calibrateColors(auto = false) {
  if (!H_matToImg) { hint('Mostre os 4 marcadores para calibrar as cores.'); return; }
  if (!auto) calibratingUntil = performance.now() + 700;
  setTimeout(() => {
    const img = procCtx.getImageData(0, 0, proc.width, proc.height);
    const s = proc.width / overlay.width;
    const whites = WHITE_REF_MM.map(([mx, my]) => {
      const [x, y] = applyH(H_matToImg, mx, my);
      return sampleRing(img, x * s, y * s, 0, pitchPx * s * 0.6);
    }).filter(Boolean);
    if (whites.length) {
      const avg = [0, 1, 2].map((i) => whites.reduce((a, w) => a + w[i], 0) / whites.length);
      gains = whiteBalanceGains(avg);
    }
    const samples = pins.map((p) => samplePin(img, p, s)).filter(Boolean);
    if (samples.length < GRID_N * GRID_N / 2) { if (!auto) hint('A placa precisa estar visível para calibrar.', 2500); return; }
    const hadCalibration = calibrated;
    buildClasses(medianLab(samples));
    if (hadCalibration) classes = refineCentroids(samples, classes);
    calibrated = true;
    for (const p of pins) { p.cand = null; p.candCount = 0; }
    if (!auto || hadCalibration) hint(hadCalibration ? 'Cores recalibradas.' : 'Cores calibradas.', 2500);
  }, 0);
}

function samplePin(img, p, s) {
  const rgb = sampleRing(img, p.x * s, p.y * s, pitchPx * s * 0.22, pitchPx * s * 0.42);
  return rgb ? rgbToLab(applyGains(rgb, gains)) : null;
}

// ---------------------------------------------------------------- //
// Laço por quadro
// ---------------------------------------------------------------- //

function loop() {
  if (!running) return;
  beginFrame();
  const now = performance.now();
  const vw = overlay.width, vh = overlay.height;
  applyBoardMirror();

  // 1) Registro da placa: marcadores → homografia folha→imagem
  procCtx.drawImage(video, 0, 0, proc.width, proc.height);
  const img = procCtx.getImageData(0, 0, proc.width, proc.height);
  const s = proc.width / vw;
  const tMarkers = performance.now();
  const found = {};
  lastMarkers = [];
  for (const m of detector.detect(img)) {
    if (MARKER_CENTERS_MM[m.id] === undefined) continue;
    lastMarkers.push({ id: m.id, pts: m.corners.map((c) => [c.x / s, c.y / s]) });
    const cx = m.corners.reduce((a, c) => a + c.x, 0) / 4 / s;
    const cy = m.corners.reduce((a, c) => a + c.y, 0) / 4 / s;
    found[m.id] = [cx, cy];
  }
  markersSeen = Object.keys(found).length;
  if (markersSeen >= 1) {
    // cantos do quadrado preto em mm: sup. esq., sup. dir., inf. dir., inf. esq.
    const src = [], dst = [];
    const hh = MARKER_INNER_MM / 2;
    for (const m of lastMarkers) {
      const [cx, cy] = MARKER_CENTERS_MM[m.id];
      const mm = [[cx - hh, cy - hh], [cx + hh, cy - hh], [cx + hh, cy + hh], [cx - hh, cy + hh]];
      for (let k = 0; k < 4; k++) { src.push(mm[k]); dst.push(m.pts[k]); }
    }
    const H = homographyLSQ(src, dst);
    // 1 marcador sozinho erra até ~2 pinos na grade (teste sintético): só
    // serve pra começar; ≥ 2 marcadores (erro < 3 px) sempre atualizam. Uma
    // estimativa boa travada nunca é trocada por uma de 1 marcador.
    if (H && (markersSeen >= 2 || !H_matToImg || hQuality <= 1)) {
      H_matToImg = H;
      hQuality = markersSeen;
      lastMarkersAt = now;
    }
  }
  consecutiveFull = markersSeen >= 2 ? consecutiveFull + 1 : 0;
  const markerMs = performance.now() - tMarkers;
  const registered = !!H_matToImg;
  if (registered) updatePinPositions();

  // 2) Percepção da mão
  const tInfer = performance.now();
  const result = handLandmarker.detectForVideo(video, now);
  recordInference(performance.now() - tInfer);
  processHands(result, now, vw, vh, img, s, registered);

  // 3) Classificação de cor por pino (pinos sob a mão mantêm o estado)
  let colorMs = null;
  if (registered && !calibrated && consecutiveFull >= AUTO_CALIBRATE_AFTER && now - lastAutoCalibAt > 2000) {
    lastAutoCalibAt = now;
    calibrateColors(true);
  }
  if (registered && calibrated) {
    const tColor = performance.now();
    classifyPins(img, s);
    colorMs = performance.now() - tColor;
  }
  recordBoard({ markers: markersSeen, markerMs, colorMs });

  updateBees(now, vw);
  checkBackButton(now, vw, vh);
  updateHint(registered);
  draw(now, vw, vh, registered);
  endFrame();
  rafId = requestAnimationFrame(loop);
}

function updatePinPositions() {
  H_gridToImg = multiplyH(H_matToImg, G_gridToMat);
  H_imgToGrid = invertH(H_gridToImg);
  for (const p of pins) [p.x, p.y] = applyH(H_gridToImg, p.gx, p.gy);
  const a = applyH(H_gridToImg, 0, 0), b = applyH(H_gridToImg, GRID_N - 1, 0);
  pitchPx = Math.hypot(b[0] - a[0], b[1] - a[1]) / (GRID_N - 1);
}

function classifyPins(img, s) {
  const handPolys = hands.map((h) => h.hull).filter(Boolean);
  for (const p of pins) {
    if (p.x < 0 || p.y < 0 || p.x >= overlay.width || p.y >= overlay.height) continue;
    if (p.virtual) continue; // conta virtual colocada pela mão/toque: a leitura de cor não mexe
    p.occluded = handPolys.some((poly) => pointInPolygon(p.x, p.y, poly));
    if (p.occluded) { p.cand = null; p.candCount = 0; continue; }
    const lab = samplePin(img, p, s);
    if (!lab) continue;
    const { id } = classifyLab(lab, classes, REJECT_DELTA);
    if (id === null) continue; // indeterminado: mantém o estado confirmado
    if (id === p.cand) p.candCount++; else { p.cand = id; p.candCount = 1; }
    if (p.candCount >= STABLE_FRAMES && id !== p.state) confirmPin(p, id);
  }
}

function confirmPin(p, id) {
  p.state = id;
  lastActivityAt = performance.now();
  if (id === 'vazio') { reportProgress(); return; }
  if (id === p.target) { playCorrect(); recordFeedback('acerto'); } else { playWrong(); recordFeedback('erro'); }
  reportProgress();
}

function pinStatus(p) {
  if (p.state === 'vazio') return 'vazio';
  return p.state === p.target ? 'certo' : 'errado';
}

function reportProgress() {
  let placed = 0, correct = 0, total = 0, extra = 0;
  for (const p of pins) {
    if (p.target) total++;
    if (p.state === 'vazio') continue;
    placed++;
    if (p.state === p.target) correct++; else extra++;
  }
  callbacks.onProgress(placed, correct, total, extra);
  if (total > 0 && correct === total && extra === 0 && !completeShown) {
    completeShown = true;
    playComplete();
  }
  if (correct < total || extra > 0) completeShown = false;
}

// ---------------------------------------------------------------- //
// Mão: célula sob o indicador, pinça e conferência da conta segurada
// ---------------------------------------------------------------- //

function processHands(result, now, vw, vh, img, s, registered) {
  const lms = result.landmarks || [];
  for (let i = 0; i < 2; i++) {
    const h = hands[i];
    const lm = lms[i];
    if (!lm) {
      if (now - h.lastSeenAt > HAND_LOST_GRACE_MS) Object.assign(h, newHand());
      continue;
    }
    h.lastSeenAt = now;
    const pts = lm.map((p) => [p.x * vw, p.y * vh]);
    h.hull = expandPolygon(convexHull(pts), 1.25);
    h.tip = pts[8];
    const d = Math.hypot(pts[4][0] - pts[8][0], pts[4][1] - pts[8][1]);
    const pinching = d < PINCH_THRESHOLD_RATIO * vw;
    recordPinch(d / vw, pinching);
    h.mid = [(pts[4][0] + pts[8][0]) / 2, (pts[4][1] + pts[8][1]) / 2];

    const tipCell = registered ? pinAt(h.tip[0], h.tip[1]) : null;
    const midCell = registered ? pinAt(h.mid[0], h.mid[1]) : null;

    if (pinching && !h.pinching) {
      swatBeeAt(h.mid);
      // pega uma conta da bandeja, ou tira uma conta virtual já colocada
      const tray = registered ? trayHit(h.mid[0], h.mid[1]) : null;
      if (tray) h.carry = tray;
      else if (midCell && midCell.virtual) { h.carry = midCell.state; clearVirtual(midCell); }
    }
    if (!pinching && h.pinching && h.carry) {
      if (midCell) placeVirtual(midCell, h.carry);
      h.carry = null;
    }
    h.pinching = pinching;
    h.cell = h.carry ? midCell : tipCell;

    // Conta segurada: lê a cor entre as pontas do polegar e do indicador,
    // só entre as cores (sem "vazio").
    h.beadColor = undefined;
    if (pinching && calibrated) {
      const rgb = sampleRing(img, h.mid[0] * s, h.mid[1] * s, 0, pitchPx * s * 0.35);
      if (rgb) {
        const lab = rgbToLab(applyGains(rgb, gains));
        h.beadColor = classifyLab(lab, classes.filter((c) => c.id !== 'vazio'), REJECT_DELTA).id;
      }
    }
  }
}

function checkBackButton(now, vw, vh) {
  const btn = backButtonLayout(vw, vh);
  const hovering = hands.some((h) => h.tip && Math.hypot(h.tip[0] - btn.x, h.tip[1] - btn.y) < btn.r * 1.1);
  if (!hovering) { backHoverStart = 0; return; }
  if (!backHoverStart) { backHoverStart = now; return; }
  if (now - backHoverStart >= BACK_DWELL_MS) { backHoverStart = 0; exitBoard(); }
}

function backButtonLayout(vw, vh) {
  return { x: vw * 0.92, y: vh * 0.12, r: Math.min(vw, vh) * 0.07 };
}

// ---------------------------------------------------------------- //
// Abelhas
// ---------------------------------------------------------------- //

function nextEmptyTarget() {
  return pins.find((p) => p.target && p.state !== p.target) || null;
}

function updateBees(now, vw) {
  const dt = Math.min(0.1, (now - (updateBees.last || now)) / 1000);
  updateBees.last = now;
  const mult = Math.min(BEE_MAX_SPEED_MULT, 1 + BEE_SPEED_STEP * difficulty);
  const idleMs = Math.max(BEE_MIN_IDLE_MS, BEE_BASE_IDLE_MS - BEE_IDLE_STEP_MS * difficulty);
  const maxBees = Math.min(BEE_MAX_COUNT_CAP, 1 + Math.floor(difficulty / BEE_LEVELS_PER_EXTRA_BEE));

  const active = bees.filter((b) => b.state !== 'flee').length;
  if (calibrated && H_gridToImg && !completeShown && now - lastActivityAt > idleMs && active < maxBees) {
    const target = nextEmptyTarget();
    if (target) {
      const side = Math.random() < 0.5 ? -0.05 : 1.05;
      bees.push({ x: side * vw, y: Math.random() * overlay.height * 0.6, state: 'seek', target });
      lastActivityAt = now; // a próxima só depois de outro período parado
      if (bees.length === 1) hint('Uma abelha! Espante com uma pinça em cima dela.', 3000);
    }
  }

  for (const b of bees) {
    if (b.state === 'seek' || b.state === 'hover') {
      if (b.target.state === b.target.target) b.target = nextEmptyTarget() || b.target;
      const dx = b.target.x - b.x, dy = b.target.y - b.y;
      const dist = Math.hypot(dx, dy);
      const step = BEE_SEEK_SPEED_FRAC * vw * mult * dt;
      if (dist <= step) { b.state = 'hover'; b.x = b.target.x + Math.sin(now / 180) * pitchPx * 0.15; b.y = b.target.y; } else { b.x += (dx / dist) * step; b.y += (dy / dist) * step; }
    } else {
      b.x += b.vx * dt; b.y += b.vy * dt;
    }
  }
  bees = bees.filter((b) => b.state !== 'flee' || (b.x > -vw * 0.2 && b.x < vw * 1.2 && b.y > -vw * 0.2 && b.y < vw * 1.2));
}

function swatBeeAt([x, y]) {
  const vw = overlay.width;
  for (const b of bees) {
    if (b.state === 'flee') continue;
    if (Math.hypot(b.x - x, b.y - y) < Math.max(pitchPx * 1.3, vw * 0.04)) {
      const ang = Math.random() * Math.PI * 2;
      Object.assign(b, { state: 'flee', vx: Math.cos(ang) * BEE_FLEE_SPEED_FRAC * vw, vy: Math.sin(ang) * BEE_FLEE_SPEED_FRAC * vw });
      playBeeSwat();
      lastActivityAt = performance.now();
    }
  }
}

// ---------------------------------------------------------------- //
// Dicas e desenho
// ---------------------------------------------------------------- //

function updateHint(registered) {
  if (gridAdjust || performance.now() < hintHoldUntil) return;
  if (!H_matToImg) { hint('Aponte a câmera para a folha (basta 1 marcador visível).'); return; }
  if (hQuality < 2) { hint('Mostre pelo menos 2 marcadores para a grade ficar precisa.'); return; }
  const extra = pins.filter((p) => p.state !== 'vazio' && p.state !== p.target).length;
  if (extra > 0) { hint(`Há ${extra} conta(s) no lugar errado (marcadas com X).`); return; }
  if (completeShown) { hint('Desenho completo!'); return; }
  const next = nextEmptyTarget();
  if (next) hint(`Pegue a conta ${next.target.toLowerCase()} na bandeja (pinça ou toque) e solte no pino que pisca.`);
}

function draw(now, vw, vh, registered) {
  ctx.clearRect(0, 0, vw, vh);

  // 3D (three.js, canvas por baixo deste): placa, pinos, contas e bandeja
  render3D({
    H_matToImg: registered ? H_matToImg : null,
    pins, nextPin: nextEmptyTarget(), now, colorOf,
    carries: hands.map((h) => (h.carry && h.mid ? { color: h.carry, x: h.mid[0], y: h.mid[1] } : null)),
  });
  if (H_gridToImg) {
    drawStatus();
    drawTray(now);
  }
  // Mão por cima do conteúdo virtual: recorta o próprio vídeo no contorno
  // da mão e redesenha por cima (oclusão).
  const polys = hands.map((h) => h.hull).filter(Boolean);
  if (polys.length && video.readyState >= 2) {
    ctx.save();
    ctx.beginPath();
    for (const poly of polys) {
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (const [x, y] of poly.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();
    }
    ctx.clip();
    ctx.drawImage(video, 0, 0, vw, vh);
    ctx.restore();
  }
  drawMarkerOutlines();

  drawHands();
  drawBees();
  const btn = backButtonLayout(vw, vh);
  const frac = backHoverStart ? Math.min(1, (now - backHoverStart) / BACK_DWELL_MS) : 0;
  drawDwellButton(btn.x, btn.y, btn.r, '◀', 'VOLTAR', !!backHoverStart, frac);

  if (now < calibratingUntil) drawBanner('🎨 calibrando cores...', vw, vh);
  if (gridAdjust) drawAdjustPoints();
  if (winActive) drawBanner('🎉 Categoria completa! Toque em ◀ Voltar', vw, vh);
}

// Estado de cada pino em 2D por cima do 3D: anel verde (certo), X vermelho
// (conta errada — física ou virtual).
function drawStatus() {
  const r = pitchPx * 0.42;
  ctx.lineWidth = Math.max(1.5, pitchPx * 0.08);
  for (const p of pins) {
    const st = pinStatus(p);
    if (st === 'certo') {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 1.15, 0, Math.PI * 2);
      ctx.strokeStyle = '#4ade80';
      ctx.stroke();
    } else if (st === 'errado') {
      ctx.strokeStyle = '#ef4444';
      ctx.beginPath();
      ctx.moveTo(p.x - r * 0.7, p.y - r * 0.7); ctx.lineTo(p.x + r * 0.7, p.y + r * 0.7);
      ctx.moveTo(p.x + r * 0.7, p.y - r * 0.7); ctx.lineTo(p.x - r * 0.7, p.y + r * 0.7);
      ctx.stroke();
    }
  }
}

function drawHands() {
  for (const h of hands) {
    if (!h.tip) continue;
    if (h.cell) {
      // destaque do pino sob o indicador (desenhado POR CIMA da mão de propósito)
      ctx.beginPath();
      ctx.arc(h.cell.x, h.cell.y, pitchPx * 0.6, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(2, pitchPx * 0.1);
      ctx.strokeStyle = '#f9c74f';
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(h.tip[0], h.tip[1], Math.max(5, pitchPx * 0.15), 0, Math.PI * 2);
    ctx.fillStyle = h.pinching ? '#4ade80' : '#f9c74f';
    ctx.fill();

    if (h.pinching && h.beadColor !== undefined) {
      const target = h.cell ? h.cell.target : null;
      let label, color;
      if (h.beadColor === null) { label = '?'; color = '#e6e8eb'; } else if (!h.cell) { label = h.beadColor; color = '#e6e8eb'; } else if (!target) { label = '✗ fora do desenho'; color = '#ef4444'; } else if (h.beadColor === target) { label = '✓ ' + h.beadColor; color = '#4ade80'; } else { label = `✗ precisa ${target.toLowerCase()}`; color = '#ef4444'; }
      ctx.font = `bold ${Math.max(14, Math.round(pitchPx * 0.55))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const [x, y] = [h.mid[0], h.mid[1] - pitchPx * 0.9];
      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = 'rgba(22,25,29,0.8)';
      ctx.fillRect(x - w / 2, y - pitchPx * 0.7 - 6, w, pitchPx * 0.7 + 10);
      ctx.fillStyle = color;
      fillTextUnmirrored(label, x, y);
    }
  }
}

function drawBees() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.max(22, Math.round(pitchPx * 1.3))}px sans-serif`;
  for (const b of bees) fillTextUnmirrored('🐝', b.x, b.y);
}

function drawAdjustPoints() {
  ctx.fillStyle = '#f472b6';
  for (const [mx, my] of gridAdjust.points) {
    const [x, y] = applyH(H_matToImg, mx, my);
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBanner(text, vw, vh) {
  ctx.font = `bold ${Math.round(vh * 0.045)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 30;
  ctx.fillStyle = 'rgba(22,25,29,0.85)';
  ctx.fillRect(vw / 2 - w / 2, vh * 0.9 - vh * 0.04, w, vh * 0.08);
  ctx.fillStyle = '#f9c74f';
  fillTextUnmirrored(text, vw / 2, vh * 0.9);
}

function drawDwellButton(x, y, r, icon, label, hovering, frac) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(22,25,29,0.78)';
  ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.05);
  ctx.strokeStyle = hovering ? '#4ade80' : '#f9c74f';
  ctx.stroke();
  if (hovering && frac > 0) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, r * 1.08, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(74,222,128,0.35)';
    ctx.fill();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e6e8eb';
  ctx.font = `${Math.round(r * 0.7)}px sans-serif`;
  fillTextUnmirrored(icon, x, y - r * 0.15);
  ctx.font = `bold ${Math.max(10, Math.round(r * 0.22))}px 'Courier New', monospace`;
  fillTextUnmirrored(label, x, y + r * 0.5);
}

function colorOf(name) {
  return (HAMA_PALETTE.find((p) => p[0] === name) || [name, [255, 255, 255]])[1];
}
