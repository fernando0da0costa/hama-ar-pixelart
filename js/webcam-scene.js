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
import * as THREE from 'three';
import { createBeadGeometry } from './bead-geometry.js';
import { playPickup, playCorrect, playWrong, playComplete } from './sound.js';

const PINCH_THRESHOLD_RATIO = 0.055; // distância polegar↔indicador, como fração da largura do vídeo
const HAND_LOST_GRACE_MS = 400; // tolera a mão sumir um pouco (borda da tela, oclusão) sem soltar a pinça sozinho
// Sem headset aqui não tem profundidade real — a câmera olha de frente pro
// vídeo. Inclinar a conta nesse ângulo (em vez de deixá-la de "frente pro
// furo", que pareceria só um anel achatado) é o que faz o tubo 3D ficar
// reconhecível como conta, com a parede lateral e o furo visíveis ao mesmo
// tempo, tipo uma foto de continhas espalhadas na mesa vistas de cima.
const BEAD_TILT = THREE.MathUtils.degToRad(58);

let video, overlay, overlayCtx, webglCanvas, webglRenderer, webglScene, webglCamera;
let container, stageEl, resizeHandler = null;
let trayBeadGroup, cellBeadGroup, handBeadGroup, pincerGroup;
let handLandmarker = null;
let stream = null;
let running = false;
let rafId = null;
// 'user' = câmera frontal (padrão em notebook, só existe essa); 'environment'
// = câmera traseira (só em celular/tablet). Começa em 'user' porque é a
// única opção garantida em notebook; em celular dá pra trocar em runtime.
let facingMode = 'user';

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
let completed = false; // trava o som de conclusão pra não repetir a cada frame depois que já bateu 100%
// Mouse como alternativa à mão: clica e segura numa continha da bandeja
// pra pegar, arrasta até o furo certo e solta pra encaixar — mesma mecânica
// de pega-e-solta da mão, só que dirigida por mousedown/mousemove/mouseup
// em vez de landmarks do MediaPipe. Convive com a mão, não substitui.
let mouseState = { heldLegendIdx: null, beadMesh: null };

let callbacks = { onProgress: () => {}, onExit: () => {}, onHint: () => {} };

function newHandState() {
  return {
    pinching: false, midpoint: null, heldLegendIdx: null, lastSeenAt: 0, beadMesh: null,
    thumbMarker: null, indexMarker: null, pincerLine: null,
  };
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
  completed = false;

  callbacks.onHint('Pedindo acesso à câmera...');

  video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.style.cssText = 'width:100%; height:100%; display:block;';

  overlay = document.createElement('canvas');
  overlay.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; display:block;';
  overlayCtx = overlay.getContext('2d');

  // Canvas WebGL separado pras contas de verdade (tubo furado em 3D, mesma
  // geometria da RA imersiva). Fica ENTRE o vídeo e o overlay 2D: o overlay
  // continua por cima pra desenhar o "fantasma" (marca d'água de cor-alvo),
  // o anel verde de acerto e o cursor da mão sem precisar redesenhar por
  // cima da conta 3D.
  webglCanvas = document.createElement('canvas');
  webglCanvas.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; display:block; pointer-events:none;';

  // "Letterbox": o palco fica travado na proporção real da câmera e
  // centralizado — sem isso o vídeo e o overlay esticam fora de escala e a
  // marca d'água some do lugar certo (era o bug do "ficou gigante").
  stageEl = document.createElement('div');
  stageEl.style.cssText = 'position:absolute; inset:0; margin:auto; background:#000; overflow:hidden; cursor:crosshair;';
  stageEl.appendChild(video);
  stageEl.appendChild(webglCanvas);
  stageEl.appendChild(overlay);
  container.appendChild(stageEl);

  setupWebgl();
  mouseState = { heldLegendIdx: null, beadMesh: null };
  setupMouseInput();

  try {
    await openStream(facingMode);
  } catch (e) {
    callbacks.onHint('Não consegui acessar a câmera: ' + e.message);
    throw e;
  }

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

async function openStream(mode) {
  const newStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: mode, width: { ideal: 960 }, height: { ideal: 720 } },
    audio: false,
  });
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = newStream;
  facingMode = mode;
  video.srcObject = stream;
  await video.play();
}

// Troca entre câmera frontal e traseira sem sair do modo webcam — em
// notebook só existe frontal (o navegador ignora 'environment' e devolve a
// mesma), mas em celular/tablet com as duas, dá pra escolher qual delas
// mostra a mão pinçando.
export async function flipCamera() {
  const nextMode = facingMode === 'user' ? 'environment' : 'user';
  callbacks.onHint('Trocando de câmera...');
  try {
    await openStream(nextMode);
  } catch (e) {
    // openStream só troca o stream depois de conseguir o novo — se falhou
    // (ex.: notebook só tem uma câmera), o stream antigo continua tocando
    // normalmente, só avisa e mantém como estava.
    callbacks.onHint('Esse aparelho não tem outra câmera pra trocar.');
    return;
  }
  fitStage();
  callbacks.onHint('Pinça uma continha na bandeja de baixo, carrega até o furo certo e solta!');
}

function setupWebgl() {
  webglRenderer = new THREE.WebGLRenderer({ canvas: webglCanvas, antialias: true, alpha: true });
  webglRenderer.setClearColor(0x000000, 0);

  webglScene = new THREE.Scene();
  webglScene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.3));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(0.4, -0.6, 1);
  webglScene.add(dirLight);

  trayBeadGroup = new THREE.Group();
  cellBeadGroup = new THREE.Group();
  handBeadGroup = new THREE.Group();
  pincerGroup = new THREE.Group();
  webglScene.add(trayBeadGroup, cellBeadGroup, handBeadGroup, pincerGroup);
}

// Marcador "tipo pinça": uma bolinha na ponta do polegar, outra na ponta do
// indicador, ligadas por uma linha — mostra exatamente onde o sistema está
// lendo os dois dedos e se a distância entre eles já conta como pinça
// fechada (verde) ou ainda está aberta (amarelo). Existe pra dar um jeito de
// calibrar visualmente quando a pinça não está sendo reconhecida direito.
function ensurePincerMarkers(state) {
  if (state.thumbMarker) return;
  const geo = new THREE.SphereGeometry(1, 12, 8); // raio real vem da escala, setada a cada frame
  state.thumbMarker = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xf9c74f }));
  state.indexMarker = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xf9c74f }));
  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  state.pincerLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xf9c74f }));
  pincerGroup.add(state.thumbMarker, state.indexMarker, state.pincerLine);
}

function updatePincerMarkers(state, tx, ty, ix, iy, vw) {
  ensurePincerMarkers(state);
  const r = vw * 0.01;
  const color = state.pinching ? 0x4ade80 : 0xf9c74f;

  state.thumbMarker.scale.setScalar(r);
  state.thumbMarker.position.set(tx, ty, 15);
  state.thumbMarker.material.color.setHex(color);
  state.thumbMarker.visible = true;

  state.indexMarker.scale.setScalar(r);
  state.indexMarker.position.set(ix, iy, 15);
  state.indexMarker.material.color.setHex(color);
  state.indexMarker.visible = true;

  state.pincerLine.material.color.setHex(color);
  const pos = state.pincerLine.geometry.attributes.position;
  pos.setXYZ(0, tx, ty, 15);
  pos.setXYZ(1, ix, iy, 15);
  pos.needsUpdate = true;
  state.pincerLine.visible = true;
}

function hidePincerMarkers(state) {
  if (state.thumbMarker) state.thumbMarker.visible = false;
  if (state.indexMarker) state.indexMarker.visible = false;
  if (state.pincerLine) state.pincerLine.visible = false;
}

// Converte coordenadas de tela (clientX/clientY) pra pixels nativos do vídeo
// (mesmo espaço de cell.x/y, tray.x/y) — considera o letterbox do stageEl.
function toVideoCoords(evt) {
  const rect = overlay.getBoundingClientRect();
  const scaleX = overlay.width / rect.width;
  const scaleY = overlay.height / rect.height;
  return { x: (evt.clientX - rect.left) * scaleX, y: (evt.clientY - rect.top) * scaleY };
}

function onMouseDown(evt) {
  const { x, y } = toVideoCoords(evt);
  const tray = findNearestTray(x, y, trayPickRadius);
  if (!tray) return;
  evt.preventDefault();
  mouseState.heldLegendIdx = tray.legendIdx;
  playPickup();
  if (!mouseState.beadMesh) {
    mouseState.beadMesh = makeBeadMesh(tray.r, tray.entry.r, tray.entry.g, tray.entry.b);
    handBeadGroup.add(mouseState.beadMesh);
  } else {
    mouseState.beadMesh.material.color.setRGB(tray.entry.r / 255, tray.entry.g / 255, tray.entry.b / 255);
  }
  mouseState.beadMesh.position.set(x, y, 10);
  mouseState.beadMesh.visible = true;
}

function onMouseMove(evt) {
  if (mouseState.heldLegendIdx === null) return;
  const { x, y } = toVideoCoords(evt);
  mouseState.beadMesh.position.set(x, y, 10);
}

function onMouseUp(evt) {
  if (mouseState.heldLegendIdx === null) return;
  const { x, y } = toVideoCoords(evt);
  const cell = findNearestCell(x, y, cellPickRadius);
  if (cell) fillCell(cell, mouseState.heldLegendIdx);
  mouseState.heldLegendIdx = null;
  mouseState.beadMesh.visible = false;
}

function setupMouseInput() {
  stageEl.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function teardownMouseInput() {
  if (stageEl) stageEl.removeEventListener('mousedown', onMouseDown);
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
}

// Refaz do zero as contas 3D da bandeja e das células já preenchidas —
// mesma lógica de "descarta e reconstrói" que buildBoardLayout já usa pra
// cellMeshes/traySpheres a cada resize, só que pros meshes WebGL.
function rebuildBeadMeshes() {
  trayBeadGroup.clear();
  cellBeadGroup.clear();

  for (const tray of traySpheres) {
    tray.beadMesh = makeBeadMesh(tray.r, tray.entry.r, tray.entry.g, tray.entry.b);
    tray.beadMesh.position.set(tray.x, tray.y, 0);
    trayBeadGroup.add(tray.beadMesh);
  }

  for (const cell of cellMeshes) {
    if (cell.filled) addCellBead(cell);
  }
}

function makeBeadMesh(radius, r, g, b) {
  const geo = createBeadGeometry(radius);
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(r / 255, g / 255, b / 255), roughness: 0.35 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = BEAD_TILT;
  return mesh;
}

function addCellBead(cell) {
  cell.beadMesh = makeBeadMesh(cell.r * 0.85, cell.paintR, cell.paintG, cell.paintB);
  cell.beadMesh.position.set(cell.x, cell.y, 0);
  cellBeadGroup.add(cell.beadMesh);
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

  // Câmera ortográfica em espaço de pixel do vídeo (0..vw, 0..vh) — assim as
  // contas 3D usam exatamente as mesmas coordenadas x/y já calculadas pro
  // canvas 2D (cell.x/y, tray.x/y), sem precisar converter espaço nenhum.
  webglCamera = new THREE.OrthographicCamera(0, vw, 0, vh, -1000, 1000);
  webglCamera.position.z = 500;
  webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  webglRenderer.setSize(vw, vh, false);

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

  rebuildBeadMeshes();
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
        hidePincerMarkers(state);
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
    updatePincerMarkers(state, tx, ty, ix, iy, vw);

    if (state.pinching && !wasPinching && state.heldLegendIdx === null) {
      // pinça começou perto da bandeja: pega a conta (mostra o mesh 3D dela
      // grudado na mão, do tamanho da conta da bandeja)
      const tray = findNearestTray(state.midpoint.x, state.midpoint.y, trayPickRadius);
      if (tray) {
        state.heldLegendIdx = tray.legendIdx;
        playPickup();
        if (!state.beadMesh) {
          state.beadMesh = makeBeadMesh(tray.r, tray.entry.r, tray.entry.g, tray.entry.b);
          handBeadGroup.add(state.beadMesh);
        } else {
          state.beadMesh.material.color.setRGB(tray.entry.r / 255, tray.entry.g / 255, tray.entry.b / 255);
        }
        state.beadMesh.visible = true;
      }
    }

    if (state.pinching && state.heldLegendIdx !== null && state.beadMesh) {
      // z um pouco à frente (500 é a câmera): garante que a conta na mão
      // sempre desenha por cima das da bandeja/grade quando sobrepõe.
      state.beadMesh.position.set(state.midpoint.x, state.midpoint.y, 10);
    }

    if (!state.pinching && wasPinching && state.heldLegendIdx !== null) {
      // soltou a pinça: se estiver em cima de um furo, encaixa a conta ali
      const cell = findNearestCell(state.midpoint.x, state.midpoint.y, cellPickRadius);
      if (cell) fillCell(cell, state.heldLegendIdx);
      state.heldLegendIdx = null;
      if (state.beadMesh) state.beadMesh.visible = false;
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
    playWrong();
    return;
  }
  if (cell.filled) return;
  cell.filled = true;
  cell.correct = true;
  cell.paintR = entry.r; cell.paintG = entry.g; cell.paintB = entry.b;
  addCellBead(cell);
  playCorrect();
  reportProgress();
}

function reportProgress() {
  let placed = 0, correct = 0;
  for (const c of cellMeshes) { if (c.filled) placed++; if (c.correct) correct++; }
  callbacks.onProgress(placed, correct, cellMeshes.length);
  if (!completed && cellMeshes.length > 0 && correct === cellMeshes.length) {
    completed = true;
    playComplete();
    callbacks.onPatternCompleted?.(pattern);
  }
}

function draw() {
  const vw = overlay.width, vh = overlay.height;
  overlayCtx.clearRect(0, 0, vw, vh);
  const now = performance.now();

  // furos: marca d'água transparente na cor certa; a conta preenchida em si
  // agora é o mesh 3D (webgl, desenhado por baixo deste canvas) — aqui só
  // sobra o anel verde de "correto" por cima dela. Tentativa com cor errada
  // pisca vermelho um instante e volta a vazio, sem encaixar.
  for (const cell of cellMeshes) {
    if (cell.filled) {
      overlayCtx.beginPath();
      overlayCtx.arc(cell.x, cell.y, cell.r, 0, Math.PI * 2);
      overlayCtx.lineWidth = Math.max(1, cell.r * 0.14);
      overlayCtx.strokeStyle = 'rgba(74,222,128,0.95)';
      overlayCtx.stroke();
    } else if (cell.rejectedUntil && now < cell.rejectedUntil) {
      overlayCtx.beginPath();
      overlayCtx.arc(cell.x, cell.y, cell.r, 0, Math.PI * 2);
      overlayCtx.fillStyle = 'rgba(248,113,113,0.55)';
      overlayCtx.fill();
      overlayCtx.lineWidth = Math.max(1, cell.r * 0.14);
      overlayCtx.strokeStyle = 'rgba(248,113,113,0.95)';
      overlayCtx.stroke();
    } else {
      overlayCtx.beginPath();
      overlayCtx.arc(cell.x, cell.y, cell.r, 0, Math.PI * 2);
      overlayCtx.fillStyle = `rgba(${cell.target.r},${cell.target.g},${cell.target.b},0.4)`;
      overlayCtx.fill();
    }
  }

  // cursor da mão agora é 100% 3D: o indicador de pinça (bolinha em cada
  // ponta de dedo + linha) é atualizado em processHands/updatePincerMarkers,
  // e a conta carregada é o beadMesh — nada mais a desenhar aqui em 2D.

  webglRenderer.render(webglScene, webglCamera);
}

export function exitWebcam() {
  running = false;
  if (rafId !== null) cancelAnimationFrame(rafId);
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
  teardownMouseInput();
  if (stageEl && stageEl.parentElement) stageEl.parentElement.removeChild(stageEl);
  stageEl = null;
  if (webglRenderer) { webglRenderer.dispose(); webglRenderer = null; }
  webglScene = null;
  webglCamera = null;
  trayBeadGroup = null;
  cellBeadGroup = null;
  handBeadGroup = null;
  pincerGroup = null;
  callbacks.onExit();
}
