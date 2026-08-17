// Modo alternativo: webcam comum (getUserMedia) + MediaPipe HandLandmarker,
// igual à técnica do projeto "mão robótica" — roda em qualquer notebook/PC
// com câmera, sem precisar de headset nem de immersive-ar. Serve pra testar
// a lógica de pegar-e-encaixar agora; quando migrar pra um celular com WebXR
// (immersive-ar), é o ar-scene.js que assume, com a MESMA interface
// (startX/exitX/callbacks{onProgress,onHint,onExit}) e a MESMA mecânica
// (pinça numa conta da bandeja = pega; carrega até a célula certa; solta a
// pinça em cima = encaixa), só que ancorado no mundo real em 3D em vez de
// fixo na tela em 2D.
//
// Aqui o "quadro" não flutua ancorado no espaço real (isso exige WebXR) —
// ele fica desenhado como marca d'água sobre o vídeo da câmera, na cor certa
// de cada célula, ocupando uma área fixa da tela.

import {
  HandLandmarker,
  FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';

const PINCH_THRESHOLD_RATIO = 0.055; // distância polegar↔indicador, como fração da largura do vídeo
const HAND_LOST_GRACE_MS = 400; // tolera a mão sumir um pouco (borda da tela, oclusão) sem soltar a pinça sozinho

let video, overlay, overlayCtx, container, stageEl, resizeHandler = null;
let handLandmarker = null;
let stream = null;
let running = false;
let rafId = null;

let pattern = null;
let cellMeshes = []; // { key, x, y, r, target, filled, correct }
let traySpheres = []; // { x, y, r, legendIdx, entry }
let handStates = [newHandState(), newHandState()];
// Tolerância de "pegar/soltar", recalculada em buildBoardLayout — precisa
// encolher junto com furos/contas bem pequenos (grade densa, paleta com
// muitas cores), senão o alcance passa a cobrir vários furos vizinhos e fica
// fácil encaixar sem querer no lugar errado.
let cellPickRadius = 40;
let trayPickRadius = 40;

let callbacks = { onProgress: () => {}, onExit: () => {}, onHint: () => {} };

function newHandState() {
  return { pinching: false, midpoint: null, heldLegendIdx: null, lastSeenAt: 0 };
}

export function isWebcamSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export async function startWebcam(patternData, cbs, containerEl) {
  pattern = patternData;
  callbacks = { ...callbacks, ...cbs };
  container = containerEl;
  cellMeshes = [];
  traySpheres = [];
  handStates = [newHandState(), newHandState()];

  callbacks.onHint('Pedindo acesso à câmera...');

  video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.style.cssText = 'width:100%; height:100%; display:block;';

  overlay = document.createElement('canvas');
  overlay.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; display:block;';
  overlayCtx = overlay.getContext('2d');

  // "Letterbox": o palco fica travado na proporção real da câmera e
  // centralizado — sem isso o vídeo e o overlay esticam fora de escala e a
  // marca d'água some do lugar certo (era o bug do "ficou gigante").
  stageEl = document.createElement('div');
  stageEl.style.cssText = 'position:absolute; inset:0; margin:auto; background:#000; overflow:hidden;';
  stageEl.appendChild(video);
  stageEl.appendChild(overlay);
  container.appendChild(stageEl);

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (e) {
    callbacks.onHint('Não consegui acessar a câmera: ' + e.message);
    throw e;
  }
  video.srcObject = stream;
  await video.play();

  callbacks.onHint('Carregando o rastreador de mãos...');
  await ensureHandLandmarker();

  fitStage();
  resizeHandler = () => fitStage();
  window.addEventListener('resize', resizeHandler);

  buildBoardLayout();
  callbacks.onHint('Pinça uma continha na bandeja de baixo, carrega até o furo certo e solta!');
  reportProgress();

  running = true;
  rafId = requestAnimationFrame(loop);
}

async function ensureHandLandmarker() {
  if (handLandmarker) return;
  const filesetResolver = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  );
  handLandmarker = await HandLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: 2,
  });
}

function fitStage() {
  const vw = video.videoWidth || 4;
  const vh = video.videoHeight || 3;
  // Trava a caixa na proporção nativa da câmera, sem passar do viewport, e
  // centraliza (margin:auto + inset:0, com max-width/max-height calculados
  // a partir do aspect-ratio real) — isso é o que garante responsividade.
  stageEl.style.width = '100%';
  stageEl.style.height = '100%';
  stageEl.style.maxWidth = `calc(100vh * ${vw} / ${vh})`;
  stageEl.style.maxHeight = `calc(100vw * ${vh} / ${vw})`;
  overlay.width = vw;
  overlay.height = vh;
  buildBoardLayout();
}

// Área quadrada centralizada no vídeo onde o "quadro" de contas é
// desenhado como marca d'água, mais a bandeja de contas logo abaixo —
// coordenadas em pixels nativos do vídeo (== pixels do canvas de overlay).
function buildBoardLayout() {
  const vw = overlay.width || video.videoWidth || 640;
  const vh = overlay.height || video.videoHeight || 480;
  const size = Math.min(vw, vh) * 0.72;
  const boardX = (vw - size) / 2, boardY = (vh - size) / 2 - vh * 0.06;

  const { w, h, cells, legend } = pattern;
  const cellSize = size / Math.max(w, h);
  const boardW = w * cellSize, boardH = h * cellSize;
  const offX = boardX + (size - boardW) / 2;
  const offY = boardY + (size - boardH) / 2;

  // Nunca deixa o alcance passar de ~70% da distância até o furo vizinho
  // (senão, numa grade densa, dá pra "alcançar" um furo dois passos longe).
  cellPickRadius = Math.max(vw * 0.02, Math.min(vw * 0.09, cellSize * 0.7));

  const prevFilled = new Map(cellMeshes.map((c) => [c.key, {
    filled: c.filled, correct: c.correct, paintR: c.paintR, paintG: c.paintG, paintB: c.paintB,
  }]));
  cellMeshes = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const target = cells[y * w + x];
      if (!target) continue;
      const key = y * w + x;
      const prev = prevFilled.get(key);
      cellMeshes.push({
        key,
        x: offX + x * cellSize + cellSize / 2,
        y: offY + y * cellSize + cellSize / 2,
        r: cellSize * 0.44,
        target,
        filled: prev?.filled || false,
        correct: prev?.correct || false,
        paintR: prev?.paintR, paintG: prev?.paintG, paintB: prev?.paintB,
      });
    }
  }

  // Bandeja: uma fileira de continhas pra pegar, uma por cor do padrão,
  // logo abaixo do quadro. Com muitas cores (paleta automática do modo
  // avançado, até 16), o espaçamento "ideal" facilmente estouraria a
  // largura do vídeo — por isso o espaçamento é sempre recalculado pra
  // caber em 88% da largura, e o raio da conta encolhe junto (com um piso
  // mínimo pra continuar tocável).
  const trayY = boardY + boardH + vh * 0.09;
  const n = legend.length;
  const idealR = Math.min(cellSize * 0.5, vw * 0.045);
  const maxRowWidth = vw * 0.88;
  const spacing = n > 1 ? Math.min(idealR * 2.6, maxRowWidth / (n - 1)) : idealR * 2.6;
  const trayR = Math.max(vw * 0.014, Math.min(idealR, spacing / 2.6));
  trayPickRadius = Math.max(vw * 0.02, Math.min(vw * 0.09, trayR * 1.4));
  const rowWidth = (n - 1) * spacing;
  traySpheres = legend.map((entry, idx) => ({
    x: vw / 2 - rowWidth / 2 + idx * spacing,
    y: trayY,
    r: trayR,
    legendIdx: idx,
    entry,
  }));
}

function loop() {
  if (!running) return;
  if (video.readyState >= 2 && handLandmarker) {
    const result = handLandmarker.detectForVideo(video, performance.now());
    processHands(result);
  }
  draw();
  rafId = requestAnimationFrame(loop);
}

function processHands(result) {
  const vw = overlay.width, vh = overlay.height;
  const pinchThreshold = vw * PINCH_THRESHOLD_RATIO;

  const now = performance.now();

  for (let i = 0; i < 2; i++) {
    const state = handStates[i];
    const lm = result.landmarks && result.landmarks[i];

    if (!lm) {
      // Mão não detectada neste frame — pode ser um flicker (saiu um
      // pouquinho da borda, ficou de perfil, foi ocluída) e não quer dizer
      // que os dedos abriram de verdade. Dentro da janela de tolerância,
      // congela o estado (não mexe em pinching/heldLegendIdx) em vez de
      // soltar a conta sozinho; só cancela de vez se ficar sumida por muito
      // tempo, e mesmo assim sem tentar encaixar em posição desatualizada.
      if (now - state.lastSeenAt > HAND_LOST_GRACE_MS) {
        state.pinching = false;
        state.midpoint = null;
        state.heldLegendIdx = null;
      }
      continue;
    }
    state.lastSeenAt = now;

    const thumb = lm[4], index = lm[8];
    const tx = thumb.x * vw, ty = thumb.y * vh;
    const ix = index.x * vw, iy = index.y * vh;
    const dist = Math.hypot(tx - ix, ty - iy);

    const wasPinching = state.pinching;
    state.pinching = dist < pinchThreshold;
    state.midpoint = { x: (tx + ix) / 2, y: (ty + iy) / 2 };

    if (state.pinching && !wasPinching && state.heldLegendIdx === null) {
      // pinça começou perto da bandeja: pega a conta
      const tray = findNearestTray(state.midpoint.x, state.midpoint.y, trayPickRadius);
      if (tray) state.heldLegendIdx = tray.legendIdx;
    }

    if (!state.pinching && wasPinching && state.heldLegendIdx !== null) {
      // soltou a pinça: se estiver em cima de um furo, encaixa a conta ali
      const cell = findNearestCell(state.midpoint.x, state.midpoint.y, cellPickRadius);
      if (cell) fillCell(cell, state.heldLegendIdx);
      state.heldLegendIdx = null;
    }
  }
}

function findNearestTray(x, y, radius) {
  let best = null, bestDist = radius;
  for (const tray of traySpheres) {
    const d = Math.hypot(tray.x - x, tray.y - y);
    if (d < bestDist) { bestDist = d; best = tray; }
  }
  return best;
}

function findNearestCell(x, y, radius) {
  let best = null, bestDist = radius;
  for (const cell of cellMeshes) {
    const d = Math.hypot(cell.x - x, cell.y - y);
    if (d < bestDist) { bestDist = d; best = cell; }
  }
  return best;
}

// Só encaixa se a cor bater com o alvo da célula — cor errada é recusada
// (a célula pisca vermelho um instante e continua vazia) em vez de ficar
// preenchida do jeito errado.
function fillCell(cell, legendIdx) {
  const entry = pattern.legend[legendIdx];
  if (entry.name !== cell.target.name) {
    cell.rejectedUntil = performance.now() + 350;
    return;
  }
  if (cell.filled) return;
  cell.filled = true;
  cell.correct = true;
  cell.paintR = entry.r; cell.paintG = entry.g; cell.paintB = entry.b;
  reportProgress();
}

function reportProgress() {
  let placed = 0, correct = 0;
  for (const c of cellMeshes) { if (c.filled) placed++; if (c.correct) correct++; }
  callbacks.onProgress(placed, correct, cellMeshes.length);
}

function draw() {
  const vw = overlay.width, vh = overlay.height;
  overlayCtx.clearRect(0, 0, vw, vh);
  const now = performance.now();

  // furos: marca d'água transparente na cor certa; preenchidos ficam sólidos
  // com borda verde (só existe preenchido correto agora); tentativa com cor
  // errada pisca vermelho um instante e volta a vazio, sem encaixar.
  for (const cell of cellMeshes) {
    overlayCtx.beginPath();
    overlayCtx.arc(cell.x, cell.y, cell.r, 0, Math.PI * 2);
    if (cell.filled) {
      overlayCtx.fillStyle = `rgba(${cell.paintR},${cell.paintG},${cell.paintB},0.95)`;
      overlayCtx.fill();
      overlayCtx.lineWidth = Math.max(1, cell.r * 0.14);
      overlayCtx.strokeStyle = 'rgba(74,222,128,0.95)';
      overlayCtx.stroke();
    } else if (cell.rejectedUntil && now < cell.rejectedUntil) {
      overlayCtx.fillStyle = 'rgba(248,113,113,0.55)';
      overlayCtx.fill();
      overlayCtx.lineWidth = Math.max(1, cell.r * 0.14);
      overlayCtx.strokeStyle = 'rgba(248,113,113,0.95)';
      overlayCtx.stroke();
    } else {
      overlayCtx.fillStyle = `rgba(${cell.target.r},${cell.target.g},${cell.target.b},0.4)`;
      overlayCtx.fill();
    }
  }

  // bandeja: continhas paradas esperando a criança pegar
  for (const tray of traySpheres) {
    overlayCtx.beginPath();
    overlayCtx.arc(tray.x, tray.y, tray.r, 0, Math.PI * 2);
    overlayCtx.fillStyle = `rgb(${tray.entry.r},${tray.entry.g},${tray.entry.b})`;
    overlayCtx.fill();
    overlayCtx.lineWidth = Math.max(1, tray.r * 0.15);
    overlayCtx.strokeStyle = 'rgba(255,255,255,0.5)';
    overlayCtx.stroke();
  }

  // mãozinhas: pontinho no meio do polegar+indicador; enquanto segura uma
  // conta, ela viaja junto, do tamanho de uma conta de verdade
  for (const state of handStates) {
    if (!state.midpoint) continue;
    if (state.heldLegendIdx !== null) {
      const entry = pattern.legend[state.heldLegendIdx];
      const r = traySpheres[0] ? traySpheres[0].r : vw * 0.03;
      overlayCtx.beginPath();
      overlayCtx.arc(state.midpoint.x, state.midpoint.y, r, 0, Math.PI * 2);
      overlayCtx.fillStyle = `rgb(${entry.r},${entry.g},${entry.b})`;
      overlayCtx.fill();
      overlayCtx.lineWidth = 2;
      overlayCtx.strokeStyle = 'rgba(255,255,255,0.85)';
      overlayCtx.stroke();
    } else {
      overlayCtx.beginPath();
      overlayCtx.arc(state.midpoint.x, state.midpoint.y, vw * 0.012, 0, Math.PI * 2);
      overlayCtx.fillStyle = state.pinching ? 'rgba(74,222,128,0.9)' : 'rgba(249,199,79,0.85)';
      overlayCtx.fill();
    }
  }
}

export function exitWebcam() {
  running = false;
  if (rafId !== null) cancelAnimationFrame(rafId);
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
  if (stageEl && stageEl.parentElement) stageEl.parentElement.removeChild(stageEl);
  stageEl = null;
  callbacks.onExit();
}
