// Único modo de jogo: webcam comum (getUserMedia) + MediaPipe HandLandmarker
// — roda em qualquer notebook/celular com câmera, sem precisar de headset
// nem de immersive-ar. Interface startWebcam/exitWebcam com
// callbacks{onProgress,onHint,onExit}.
//
// O "quadro" não flutua ancorado no espaço real (isso exigiria WebXR) — ele
// fica desenhado como marca d'água sobre o vídeo da câmera, na cor certa de
// cada célula, ocupando uma área fixa da tela.

import {
  HandLandmarker,
  FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
import * as THREE from 'three';
import { createBeadGeometry } from './bead-geometry.js';
import { playPickup, playCorrect, playWrong, playComplete, playBeeSteal, playBeeSwat } from './sound.js';

const PINCH_THRESHOLD_RATIO = 0.075; // distância polegar↔indicador, como fração da largura do vídeo — mais generoso que o original (0.055) pra facilitar fechar a pinça
const HAND_LOST_GRACE_MS = 400; // tolera a mão sumir um pouco (borda da tela, oclusão) sem soltar a pinça sozinho
const BACK_DWELL_MS = 3000; // botão "voltar" do jogo: aponta e segura 3s (mesmo estilo Kinect), sem espelhar a imagem
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
let mode = null; // 'menu' | 'board' — o que a sessão de câmera atual está mostrando

// Menu de jogos: aponta o dedo indicador e segura sobre um botão pra
// escolher, sem precisar de pinça nem clique — a mesma câmera/rastreador do
// jogo, só que antes de qualquer padrão ser escolhido.
const MENU_DWELL_MS = 1100;
let menuItems = []; // {key, icon, label, x, y, r}
let menuPickRadius = 40;
let menuHoverKey = null;
let menuHoverStart = 0;
let menuPointer = null;
// 'user' = câmera frontal (padrão em notebook, só existe essa); 'environment'
// = câmera traseira (só em celular/tablet). Começa em 'user' porque é a
// única opção garantida em notebook; em celular dá pra trocar em runtime.
let facingMode = 'user';

// Espelhamento (esquerda↔direita) da câmera frontal, tipo "espelho" — é o
// que a maioria espera de uma selfie, mas pode confundir esquerda/direita de
// quem está do outro lado explicando o gesto, por isso é opcional (persiste
// em localStorage, ver MIRROR_KEY).
//
// IMPORTANTE: espelhar só o <video> via CSS e "corrigir" matematicamente as
// coordenadas da mão (como uma versão anterior desta função fazia) depende
// de uma suposição arriscada — se o frame que a câmera/navegador entrega já
// vem espelhado ou não (isso varia de aparelho pra aparelho/navegador pra
// navegador, é inconsistente). Errar essa suposição faz o dedo "andar ao
// contrário" do que a pessoa vê — exatamente o bug relatado. Por isso, em
// vez de espelhar só o vídeo, este código espelha o PALCO INTEIRO
// (stageEl: vídeo + canvas 3D + canvas 2D juntos, ver applyMirrorStyle) como
// uma imagem só, DEPOIS de tudo já desenhado — as contas/mão continuam
// calculadas e desenhadas exatamente como sem espelhamento (sempre
// alinhadas entre si, isso nunca muda), e o espelho vira só um espelho de
// verdade da tela final, sem precisar adivinhar a convenção da câmera. O
// único ajuste que sobra é o texto desenhado no canvas (fillText em
// drawDwellButton), que senão saíria de trás pra frente — e o clique do
// mouse (toVideoCoords), que precisa saber que o pixel visual que a pessoa
// clicou corresponde ao pixel espelhado do conteúdo.
const MIRROR_KEY = 'hama-ar:mirror-camera';
function loadMirrorPref() {
  try {
    const v = localStorage.getItem(MIRROR_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}
function saveMirrorPref(v) {
  try { localStorage.setItem(MIRROR_KEY, v ? '1' : '0'); } catch { /* sem localStorage, só não persiste */ }
}
let mirrorEnabled = loadMirrorPref();

// Só faz sentido espelhar a câmera frontal (selfie) — a traseira já mostra o
// mundo "do jeito certo", sem inversão, como qualquer câmera de trás de
// celular.
function shouldMirror() {
  return mirrorEnabled && facingMode === 'user';
}

function applyMirrorStyle() {
  if (stageEl) stageEl.style.transform = shouldMirror() ? 'scaleX(-1)' : 'none';
}

// Usado só pelo clique de mouse (fallback sem mão): traduz "em que pixel
// visual a pessoa clicou" pro pixel de conteúdo correspondente, já que o
// palco inteiro pode estar espelhado na tela (ver applyMirrorStyle) — isso é
// seguro de calcular porque é uma transformação NOSSA, no NOSSO elemento,
// sem depender de nenhuma suposição sobre a câmera/navegador.
function mirrorXCoord(vw, x) {
  return shouldMirror() ? vw - x : x;
}

export function isMirrorEnabled() { return mirrorEnabled; }

export function setMirrorEnabled(enabled) {
  mirrorEnabled = enabled;
  saveMirrorPref(enabled);
  applyMirrorStyle();
}

export function toggleMirror() {
  setMirrorEnabled(!mirrorEnabled);
  return mirrorEnabled;
}

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

// Botão "voltar" do jogo: desenhado num canto do tabuleiro, selecionável
// apontando e segurando 3s (ver BACK_DWELL_MS) — igual ao Kinect, sem
// precisar de pinça nem clique (o clique continua funcionando à parte, em
// onMouseDown). Posição/raio recalculados em buildBoardLayout.
let backButton = { x: 0, y: 0, r: 0 };
let backHovering = false;
let backHoverStart = 0;

// Mouse como alternativa à mão: clica e segura numa continha da bandeja
// pra pegar, arrasta até o furo certo e solta pra encaixar — mesma mecânica
// de pega-e-solta da mão, só que dirigida por mousedown/mousemove/mouseup
// em vez de landmarks do MediaPipe. Convive com a mão, não substitui.
let mouseState = { heldLegendIdx: null, beadMesh: null, paintLastCellKey: null };

// Abelhas: se a pessoa demora pra colocar a próxima conta, uma abelha
// aparece voando e, se ninguém espantar, vai lá e "rouba" (desfaz) uma
// célula já preenchida — pressão pra não ficar parada demais. Espantar é a
// mesma pinça de sempre, só que apontada pra ela em vez de pra bandeja/
// célula (ver trySwatBee, checado ANTES do pega-conta normal). Dificuldade
// (limiar de demora, velocidade, quantas abelhas ao mesmo tempo, chance de
// roubar de novo em seguida) sobe com o nível (ver startWebcam/difficultyLevel).
const BEE_BASE_IDLE_MS = 11000; // nível 0: quase 11s sem colocar nada pra primeira abelha aparecer
const BEE_IDLE_STEP_MS = 900; // cada nível reduz esse limiar
const BEE_MIN_IDLE_MS = 3500; // nunca fica impossivelmente curto
const BEE_SPAWN_CHECK_MS = 1400; // não tenta gerar abelha nova a cada frame, só de tempos em tempos
const BEE_BASE_MAX_COUNT = 1;
const BEE_MAX_COUNT_CAP = 4;
const BEE_LEVELS_PER_EXTRA_BEE = 2;
const BEE_BUZZ_MS = 1300; // tempo só voando/zoando antes de mirar numa célula, dá tempo de reagir
const BEE_WANDER_TURN_MS = 380; // troca de direção do "voo bêbado" durante o buzz
const BEE_WANDER_SPEED_FRAC = 0.10; // fração da largura do vídeo por segundo
const BEE_SEEK_SPEED_FRAC = 0.20;
const BEE_FLEE_SPEED_FRAC = 0.5;
const BEE_MAX_SPEED_MULT = 2.4;
const BEE_SPEED_STEP = 0.16;
const BEE_STEAL_AGAIN_BASE = 0.12; // chance de, depois de roubar uma, ir atrás de outra em vez de fugir
const BEE_STEAL_AGAIN_STEP = 0.09;
const BEE_STEAL_AGAIN_CAP = 0.8;
const BEE_SWAT_RADIUS_FACTOR = 1.4; // relativo ao raio visual da abelha

let bees = [];
let beeIdCounter = 0;
let lastActivityAt = 0;
let lastBeeSpawnCheckAt = 0;
let lastBeeFrameAt = 0;
let currentDifficulty = 0; // nível/fase atual (0-based), ver startWebcam
let beeHintShown = false; // mostra a dica de "espante a abelha" só na primeira vez da sessão
// true só na primeiríssima fase de cada categoria — usado pra mostrar a
// demonstração de "mão fechando" só nessa vez (ver drawHandCloseDemo). As
// próprias continhas da bandeja piscam sempre, em toda fase (ver
// drawTrayPulse), sem depender disto.
let isFirstLevelOfCategory = false;

// Tela de "categoria completa" (todas as fases da categoria escolhida foram
// vencidas) — desenhada no MESMO canvas do resto (não é HTML), com o mesmo
// mecanismo de apontar-e-segurar do botão "voltar" (ver checkBackButtonHover
// e checkWinButtonHover), pra continuar 100% acessível por gesto de mão. Ver
// showCategoryComplete (chamada por main.js) e callbacks.onPlayAgain.
const WIN_DWELL_MS = 2200;
let winActive = false;
let winHovering = false;
let winHoverStart = 0;

let callbacks = { onProgress: () => {}, onExit: () => {}, onHint: () => {}, onSelect: () => {}, onPlayAgain: () => {} };

function newHandState() {
  return {
    pinching: false, midpoint: null, heldLegendIdx: null, lastSeenAt: 0, beadMesh: null,
    thumbMarker: null, indexMarker: null, pincerLine: null,
    paintLastCellKey: null, // último furo tentado no modo pintura, pra não repetir o mesmo furo (ou o mesmo som de erro) a cada frame parado em cima dele
  };
}

export function isWebcamSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export async function startWebcam(patternData, cbs, containerEl, difficultyLevel = 0) {
  mode = 'board';
  pattern = patternData;
  callbacks = { ...callbacks, ...cbs };
  container = containerEl;
  cellMeshes = [];
  traySpheres = [];
  handStates = [newHandState(), newHandState()];
  completed = false;
  backHovering = false;
  backHoverStart = 0;
  currentDifficulty = Math.max(0, difficultyLevel);
  bees = [];
  beeHintShown = false;
  lastActivityAt = performance.now();
  lastBeeSpawnCheckAt = 0;
  lastBeeFrameAt = performance.now();
  isFirstLevelOfCategory = currentDifficulty === 0;
  winActive = false;
  winHovering = false;
  winHoverStart = 0;

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
  applyMirrorStyle();

  setupWebgl();
  mouseState = { heldLegendIdx: null, beadMesh: null, paintLastCellKey: null };
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
  callbacks.onHint('Pinça uma continha e arraste por cima dos furos da mesma cor pra pintar!');
  reportProgress();

  running = true;
  rafId = requestAnimationFrame(loop);
}

// Menu do jogo, jogado do mesmo jeito que o resto: em vez de clicar num
// botão HTML, aponta o dedo indicador pro joguinho que quer e segura um
// instante — sem pinça, só apontar e esperar (mais fácil de acertar de
// primeira que fechar a pinça). Reaproveita a MESMA câmera/rastreador de mão
// do jogo (loop/processHands/draw viram pro modo 'menu' enquanto isso).
export async function startMenu(items, cbs, containerEl) {
  mode = 'menu';
  callbacks = { ...callbacks, ...cbs };
  container = containerEl;
  menuItems = items.map((it) => ({ ...it, x: 0, y: 0, r: 0 }));
  menuHoverKey = null;
  menuHoverStart = 0;
  menuPointer = null;

  callbacks.onHint('Pedindo acesso à câmera...');

  video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.style.cssText = 'width:100%; height:100%; display:block;';

  overlay = document.createElement('canvas');
  overlay.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; display:block;';
  overlayCtx = overlay.getContext('2d');

  stageEl = document.createElement('div');
  stageEl.style.cssText = 'position:absolute; inset:0; margin:auto; background:#000; overflow:hidden; cursor:pointer;';
  stageEl.appendChild(video);
  stageEl.appendChild(overlay);
  container.appendChild(stageEl);
  applyMirrorStyle();

  setupMenuMouseInput();

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

  callbacks.onHint('Aponte o dedo pro joguinho e segure um instante pra escolher!');

  running = true;
  rafId = requestAnimationFrame(loop);
}

export function exitMenu() {
  teardownSession();
  mode = null;
}

async function openStream(requestedFacingMode) {
  const newStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: requestedFacingMode, width: { ideal: 960 }, height: { ideal: 720 } },
    audio: false,
  });
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = newStream;
  facingMode = requestedFacingMode;
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
  applyMirrorStyle();
  fitStage();
  callbacks.onHint(mode === 'menu'
    ? 'Aponte o dedo pro joguinho e segure um instante pra escolher!'
    : 'Pinça uma continha e arraste por cima dos furos da mesma cor pra pintar!');
}

// Chamada por main.js quando a última fase de uma categoria é concluída —
// troca o jogo (que continua rodando por baixo, câmera ligada) por uma tela
// de "completou tudo" desenhada no mesmo canvas, com um botão "jogar de
// novo" selecionável apontando-e-segurando, igual ao botão "voltar" — sem
// isso, quem só usa gesto de mão (sem mouse) ficaria sem jeito de continuar.
export function showCategoryComplete() {
  winActive = true;
  winHovering = false;
  winHoverStart = 0;
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
  const x = (evt.clientX - rect.left) * scaleX;
  const y = (evt.clientY - rect.top) * scaleY;
  return { x: mirrorXCoord(overlay.width, x), y };
}

function onMouseDown(evt) {
  const { x, y } = toVideoCoords(evt);
  if (winActive) {
    const winButton = getWinButtonLayout(overlay.width, overlay.height);
    if (Math.hypot(winButton.x - x, winButton.y - y) < winButton.r * 1.1) {
      evt.preventDefault();
      winActive = false;
      callbacks.onPlayAgain();
    }
    return;
  }
  if (Math.hypot(backButton.x - x, backButton.y - y) < backButton.r * 1.1) {
    evt.preventDefault();
    exitWebcam();
    return;
  }
  if (trySwatBee(x, y)) { evt.preventDefault(); return; }

  const source = findPickupSource(x, y);
  if (!source) return;
  evt.preventDefault();
  mouseState.heldLegendIdx = source.legendIdx;
  mouseState.paintLastCellKey = null;
  playPickup();
  if (!mouseState.beadMesh) {
    mouseState.beadMesh = makeBeadMesh(source.r, source.entry.r, source.entry.g, source.entry.b);
    handBeadGroup.add(mouseState.beadMesh);
  } else {
    mouseState.beadMesh.material.color.setRGB(source.entry.r / 255, source.entry.g / 255, source.entry.b / 255);
  }
  mouseState.beadMesh.position.set(x, y, 10);
  mouseState.beadMesh.visible = true;
}

function onMouseMove(evt) {
  if (mouseState.heldLegendIdx === null) return;
  const { x, y } = toVideoCoords(evt);
  mouseState.beadMesh.position.set(x, y, 10);

  const cell = findNearestCell(x, y, cellPickRadius);
  const key = cell ? cell.key : null;
  if (key !== mouseState.paintLastCellKey) {
    mouseState.paintLastCellKey = key;
    if (cell) fillCell(cell, mouseState.heldLegendIdx);
  }
}

function onMouseUp(evt) {
  if (mouseState.heldLegendIdx === null) return;
  const { x, y } = toVideoCoords(evt);
  const cell = findNearestCell(x, y, cellPickRadius);
  if (cell) fillCell(cell, mouseState.heldLegendIdx);
  mouseState.heldLegendIdx = null;
  mouseState.paintLastCellKey = null;
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

  if (mode === 'menu') {
    buildMenuLayout();
    return;
  }

  // Câmera ortográfica em espaço de pixel do vídeo (0..vw, 0..vh) — assim as
  // contas 3D usam exatamente as mesmas coordenadas x/y já calculadas pro
  // canvas 2D (cell.x/y, tray.x/y), sem precisar converter espaço nenhum.
  webglCamera = new THREE.OrthographicCamera(0, vw, 0, vh, -1000, 1000);
  webglCamera.position.z = 500;
  webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  webglRenderer.setSize(vw, vh, false);

  buildBoardLayout();
}

// Distribui os botões do menu numa fileira horizontal centralizada — mesma
// ideia da bandeja de contas (buildBoardLayout), só que com poucos alvos
// grandes em vez de muitas continhas pequenas.
function buildMenuLayout() {
  const vw = overlay.width || video.videoWidth || 640;
  const vh = overlay.height || video.videoHeight || 480;
  const n = menuItems.length;
  const r = Math.min(vw, vh) * 0.16;
  const spacing = n > 1 ? Math.min(r * 2.4, (vw * 0.85) / (n - 1)) : 0;
  const rowWidth = (n - 1) * spacing;

  menuPickRadius = r * 1.05;
  menuItems.forEach((it, idx) => {
    it.x = n > 1 ? vw / 2 - rowWidth / 2 + idx * spacing : vw / 2;
    it.y = vh / 2;
    it.r = r;
  });
}

// Área quadrada centralizada no vídeo onde o "quadro" de contas é
// desenhado como marca d'água, mais a bandeja de contas logo abaixo —
// coordenadas em pixels nativos do vídeo (== pixels do canvas de overlay).
function buildBoardLayout() {
  const vw = overlay.width || video.videoWidth || 640;
  const vh = overlay.height || video.videoHeight || 480;
  const size = Math.min(vw, vh) * 0.72;
  const boardX = (vw - size) / 2, boardY = (vh - size) / 2 - vh * 0.06;

  // Canto superior direito, longe do quadro/bandeja no centro — evita
  // confundir o botão de voltar com um furo enquanto monta.
  backButton = { x: vw * 0.9, y: vh * 0.13, r: Math.min(vw, vh) * 0.075 };

  const { w, h, cells, legend } = pattern;
  const cellSize = size / Math.max(w, h);
  const boardW = w * cellSize, boardH = h * cellSize;
  const offX = boardX + (size - boardW) / 2;
  const offY = boardY + (size - boardH) / 2;

  // Alcance generoso pra facilitar pegar a conta (pinça não precisa ser
  // exata), mas sem passar de ~80% da distância até o furo vizinho — senão,
  // numa grade densa, dá pra "alcançar" um furo dois passos longe.
  cellPickRadius = Math.max(vw * 0.026, Math.min(vw * 0.11, cellSize * 0.8));

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
  // Mesma ideia do cellPickRadius acima: alcance mais generoso pra facilitar
  // pegar a conta certa da bandeja, sem passar de ~45% do espaçamento entre
  // continhas vizinhas (senão dá pra "alcançar" a bandeja errada do lado).
  trayPickRadius = Math.max(vw * 0.026, Math.min(vw * 0.11, Math.min(trayR * 1.8, spacing * 0.45)));
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
  // processHands pode ter chamado exitWebcam/exitMenu no meio (botão de
  // voltar por gesto, ou seleção no menu) — nesse caso video/overlay/webgl já
  // podem ter sido desmontados ou reaproveitados por uma nova sessão que
  // começou a montar seu próprio estado; não desenha nem agenda mais um frame.
  if (!running) return;
  updateBees(performance.now());
  draw();
  rafId = requestAnimationFrame(loop);
}

function processHands(result) {
  if (mode === 'menu') {
    processMenuHands(result);
    return;
  }

  const vw = overlay.width, vh = overlay.height;
  const pinchThreshold = vw * PINCH_THRESHOLD_RATIO;

  const now = performance.now();

  if (winActive) {
    checkWinButtonHover(result, vw, vh, now);
    return;
  }

  checkBackButtonHover(result, vw, vh, now);

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

    if (state.pinching && !wasPinching && state.heldLegendIdx === null && trySwatBee(state.midpoint.x, state.midpoint.y)) {
      // pinça começou em cima de uma abelha: espanta ela em vez de pegar
      // conta — checado antes do pega-conta normal (ver trySwatBee).
    } else if (state.pinching && !wasPinching && state.heldLegendIdx === null) {
      // pinça começou perto da bandeja OU sobre uma célula já preenchida:
      // pega a conta/cor dali (mostra o mesh 3D dela grudado na mão) — ver
      // findPickupSource pro "copiar cor de um ponto já colocado".
      const source = findPickupSource(state.midpoint.x, state.midpoint.y);
      if (source) {
        state.heldLegendIdx = source.legendIdx;
        state.paintLastCellKey = null;
        playPickup();
        if (!state.beadMesh) {
          state.beadMesh = makeBeadMesh(source.r, source.entry.r, source.entry.g, source.entry.b);
          handBeadGroup.add(state.beadMesh);
        } else {
          state.beadMesh.material.color.setRGB(source.entry.r / 255, source.entry.g / 255, source.entry.b / 255);
        }
        state.beadMesh.visible = true;
      }
    }

    if (state.pinching && state.heldLegendIdx !== null && state.beadMesh) {
      // z um pouco à frente (500 é a câmera): garante que a conta na mão
      // sempre desenha por cima das da bandeja/grade quando sobrepõe.
      state.beadMesh.position.set(state.midpoint.x, state.midpoint.y, 10);
    }

    // Modo pintura, igual nos três jogos: enquanto a pinça continua fechada,
    // preenche qualquer furo da cor certa que o meio da pinça for passando
    // por cima — não precisa soltar em cima de cada um. Só tenta de novo
    // quando o furo "por baixo" muda, senão repetiria o mesmo som/flash de
    // rejeição a cada frame parado em cima de um furo de cor errada.
    if (state.pinching && state.heldLegendIdx !== null) {
      const cell = findNearestCell(state.midpoint.x, state.midpoint.y, cellPickRadius);
      const key = cell ? cell.key : null;
      if (key !== state.paintLastCellKey) {
        state.paintLastCellKey = key;
        if (cell) fillCell(cell, state.heldLegendIdx);
      }
    }

    if (!state.pinching && wasPinching && state.heldLegendIdx !== null) {
      // soltou a pinça: se estiver em cima de um furo, encaixa a conta ali
      // (no modo pintura isso normalmente já rolou durante o arraste; aqui
      // só cobre o caso de pinçar e soltar sem arrastar)
      const cell = findNearestCell(state.midpoint.x, state.midpoint.y, cellPickRadius);
      if (cell) fillCell(cell, state.heldLegendIdx);
      state.heldLegendIdx = null;
      state.paintLastCellKey = null;
      if (state.beadMesh) state.beadMesh.visible = false;
    }
  }
}

// Botão "voltar" do jogo (canto superior direito, ver buildBoardLayout):
// olha a ponta do indicador de QUALQUER mão detectada (não só a que está
// pinçando) e conta o tempo parado em cima, estilo Kinect — 3s (mais devagar
// que o menu, de propósito, já que aqui a mão normalmente está ocupada
// montando e não pode sair voltando sem querer).
function checkBackButtonHover(result, vw, vh, now) {
  const lms = result.landmarks || [];
  let hovering = false;
  for (const lm of lms) {
    const tip = lm[8];
    const x = tip.x * vw, y = tip.y * vh;
    if (Math.hypot(backButton.x - x, backButton.y - y) < backButton.r * 1.1) { hovering = true; break; }
  }

  if (!hovering) {
    backHovering = false;
    backHoverStart = 0;
    return;
  }
  if (!backHovering) {
    backHovering = true;
    backHoverStart = now;
    return;
  }
  if (now - backHoverStart >= BACK_DWELL_MS) {
    backHovering = false;
    backHoverStart = 0;
    exitWebcam();
  }
}

// Posição/raio do botão "jogar de novo" da tela de categoria completa —
// centralizado, calculado a partir de vw/vh (sem persistir em nenhum estado,
// pra nunca ficar desalinhado com o que draw() está desenhando agora).
function getWinButtonLayout(vw, vh) {
  return { x: vw / 2, y: vh * 0.64, r: Math.min(vw, vh) * 0.13 };
}

// Mesmo mecanismo do botão "voltar" (checkBackButtonHover) — aponta e
// segura, sem exigir pinça — só que aponta pra callbacks.onPlayAgain() em
// vez de exitWebcam().
function checkWinButtonHover(result, vw, vh, now) {
  const winButton = getWinButtonLayout(vw, vh);
  const lms = result.landmarks || [];
  let hovering = false;
  for (const lm of lms) {
    const tip = lm[8];
    const x = tip.x * vw, y = tip.y * vh;
    if (Math.hypot(winButton.x - x, winButton.y - y) < winButton.r * 1.1) { hovering = true; break; }
  }

  if (!hovering) {
    winHovering = false;
    winHoverStart = 0;
    return;
  }
  if (!winHovering) {
    winHovering = true;
    winHoverStart = now;
    return;
  }
  if (now - winHoverStart >= WIN_DWELL_MS) {
    winHovering = false;
    winHoverStart = 0;
    winActive = false;
    callbacks.onPlayAgain();
  }
}

// Aponta e segura: usa só a ponta do indicador (landmark 8) da primeira mão
// detectada como "cursor" — sem exigir pinça, pra ser óbvio de primeira
// ("aponta pro joguinho") mesmo pra quem nunca usou o app.
function processMenuHands(result) {
  const vw = overlay.width, vh = overlay.height;
  const lm = result.landmarks && result.landmarks[0];

  if (!lm) {
    menuPointer = null;
    menuHoverKey = null;
    menuHoverStart = 0;
    return;
  }

  const tip = lm[8];
  menuPointer = { x: tip.x * vw, y: tip.y * vh };

  const now = performance.now();
  const hit = menuItems.find((it) => Math.hypot(it.x - menuPointer.x, it.y - menuPointer.y) < menuPickRadius);

  if (!hit) {
    menuHoverKey = null;
    menuHoverStart = 0;
    return;
  }

  if (menuHoverKey !== hit.key) {
    menuHoverKey = hit.key;
    menuHoverStart = now;
    return;
  }

  if (now - menuHoverStart >= MENU_DWELL_MS) {
    const key = hit.key;
    menuHoverKey = null;
    menuHoverStart = 0;
    callbacks.onSelect(key);
  }
}

// Círculo com ícone/rótulo e anel de progresso preenchendo enquanto o dedo
// fica parado em cima (dwell) — usado tanto pelos botões do menu quanto pelo
// botão de voltar do jogo, só muda o tamanho/posição e o tempo de espera.
function drawDwellButton(x, y, r, icon, label, hovering, frac) {
  overlayCtx.beginPath();
  overlayCtx.arc(x, y, r, 0, Math.PI * 2);
  overlayCtx.fillStyle = 'rgba(22,25,29,0.78)';
  overlayCtx.fill();
  overlayCtx.lineWidth = Math.max(2, r * 0.05);
  overlayCtx.strokeStyle = hovering ? '#4ade80' : '#f9c74f';
  overlayCtx.stroke();

  if (hovering && frac > 0) {
    overlayCtx.beginPath();
    overlayCtx.moveTo(x, y);
    overlayCtx.arc(x, y, r * 1.08, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    overlayCtx.closePath();
    overlayCtx.fillStyle = 'rgba(74,222,128,0.35)';
    overlayCtx.fill();
  }

  overlayCtx.textAlign = 'center';
  overlayCtx.textBaseline = 'middle';
  overlayCtx.font = `${Math.round(r * 0.78)}px sans-serif`;
  fillTextMirrored(icon, x, y - r * 0.2);

  overlayCtx.font = `bold ${Math.max(11, Math.round(r * 0.19))}px 'Courier New', monospace`;
  overlayCtx.fillStyle = '#e6e8eb';
  fillTextMirrored(label, x, y + r * 0.5);
}

// Desenha texto no overlay 2D já pré-espelhado quando a câmera está
// espelhada — todo o palco (vídeo + canvas) é espelhado de uma vez via CSS
// (ver applyMirrorStyle), então sem isso qualquer texto desenhado aqui
// (botões do menu, "VOLTAR", a abelha) sairia invertido/ilegível junto.
// Espelha só o desenho do glifo em volta do próprio ponto (x,y), sem mudar
// onde ele acaba na tela, pra o espelhamento do palco desfazer isso.
function fillTextMirrored(text, x, y) {
  if (!shouldMirror()) { overlayCtx.fillText(text, x, y); return; }
  overlayCtx.save();
  overlayCtx.translate(x, y);
  overlayCtx.scale(-1, 1);
  overlayCtx.fillText(text, 0, 0);
  overlayCtx.restore();
}

function drawMenu() {
  const vw = overlay.width;
  const now = performance.now();

  for (const it of menuItems) {
    const hovering = menuHoverKey === it.key;
    const frac = hovering ? Math.min(1, (now - menuHoverStart) / MENU_DWELL_MS) : 0;
    drawDwellButton(it.x, it.y, it.r, it.icon, it.label, hovering, frac);
  }

  if (menuPointer) {
    overlayCtx.beginPath();
    overlayCtx.arc(menuPointer.x, menuPointer.y, Math.max(6, vw * 0.012), 0, Math.PI * 2);
    overlayCtx.fillStyle = menuHoverKey ? '#4ade80' : '#f9c74f';
    overlayCtx.fill();
  }
}

function onMenuMouseDown(evt) {
  const { x, y } = toVideoCoords(evt);
  const hit = menuItems.find((it) => Math.hypot(it.x - x, it.y - y) < menuPickRadius);
  if (hit) callbacks.onSelect(hit.key);
}

function setupMenuMouseInput() {
  stageEl.addEventListener('mousedown', onMenuMouseDown);
}

function teardownMenuMouseInput() {
  if (stageEl) stageEl.removeEventListener('mousedown', onMenuMouseDown);
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

// De onde uma pinça/clique pode "pegar" uma cor pra segurar: a bandeja (like
// sempre) OU, como atalho tipo "copiar", uma célula já preenchida no próprio
// quadro — pega a cor dali e deixa continuar pintando a partir daquele ponto,
// sem precisar voltar até a bandeja pra cada nova sequência.
function findPickupSource(x, y) {
  const tray = findNearestTray(x, y, trayPickRadius);
  if (tray) return { legendIdx: tray.legendIdx, entry: tray.entry, r: tray.r };

  const cell = findNearestCell(x, y, cellPickRadius);
  if (cell && cell.filled) {
    const legendIdx = pattern.legend.findIndex((e) => e.name === cell.target.name);
    if (legendIdx !== -1) return { legendIdx, entry: pattern.legend[legendIdx], r: cell.r };
  }
  return null;
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
  lastActivityAt = performance.now(); // colocou uma conta agora — reseta o "relógio de demora" das abelhas
  reportProgress();
}

// Remove o mesh 3D de uma célula sem apagar o "fantasma"/pista de cor por
// baixo — usado quando uma abelha rouba a célula (ver stealCell), pra ela
// voltar a ficar vazia (e reencaixável) exatamente como antes de preencher.
function removeCellBead(cell) {
  if (!cell.beadMesh) return;
  cellBeadGroup.remove(cell.beadMesh);
  cell.beadMesh.geometry.dispose();
  cell.beadMesh.material.dispose();
  cell.beadMesh = null;
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

function pickRandomFilledCell(excludeKey) {
  const candidates = cellMeshes.filter((c) => c.filled && c.key !== excludeKey);
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function spawnBee() {
  const vw = overlay.width, vh = overlay.height;
  const margin = Math.max(24, vw * 0.05);
  const edge = Math.floor(Math.random() * 4);
  let x, y;
  if (edge === 0) { x = -margin; y = Math.random() * vh; }
  else if (edge === 1) { x = vw + margin; y = Math.random() * vh; }
  else if (edge === 2) { x = Math.random() * vw; y = -margin; }
  else { x = Math.random() * vw; y = vh + margin; }

  bees.push({
    id: beeIdCounter++,
    x, y,
    r: Math.max(14, vw * 0.028),
    state: 'buzz', // buzz (zoando, ainda inofensiva) -> seek (indo roubar) -> steal (no ato) -> flee (espantada/fugindo)
    bornAt: performance.now(),
    wanderAngle: Math.random() * Math.PI * 2,
    nextWanderAt: 0,
    targetCell: null,
  });

  if (!beeHintShown) {
    beeHintShown = true;
    callbacks.onHint('Uma abelha apareceu! Pinça ela pra espantar antes que ela roube uma conta.');
  }
}

// Move uma abelha um passo (dt em segundos) e cuida das transições de
// estado (zoando → mirando numa célula → roubando → fugindo). speedMult e
// stealAgainChance já vêm calculados pra dificuldade atual (ver updateBees).
function stepBee(bee, now, dt, speedMult, stealAgainChance) {
  const vw = overlay.width, vh = overlay.height;

  if (bee.state === 'buzz') {
    if (now >= bee.nextWanderAt) {
      bee.wanderAngle += (Math.random() - 0.5) * 2.2;
      bee.nextWanderAt = now + BEE_WANDER_TURN_MS;
    }
    const speed = BEE_WANDER_SPEED_FRAC * vw * speedMult;
    bee.x += Math.cos(bee.wanderAngle) * speed * dt;
    bee.y += Math.sin(bee.wanderAngle) * speed * dt;
    // Não deixa a fase de "zoando" fugir pra muito longe do tabuleiro —
    // ela ainda não é uma ameaça, só está avisando que vai atacar.
    bee.x = Math.max(0, Math.min(vw, bee.x));
    bee.y = Math.max(0, Math.min(vh, bee.y));

    if (now - bee.bornAt >= BEE_BUZZ_MS) {
      const target = pickRandomFilledCell(null);
      if (target) { bee.state = 'seek'; bee.targetCell = target; }
      else { bee.bornAt = now; } // nada pra roubar ainda — continua zoando
    }
    return;
  }

  if (bee.state === 'seek') {
    // Se a célula-alvo foi esvaziada (jogador preencheu de novo, ou outra
    // abelha chegou primeiro) ou não existe mais, escolhe outra.
    if (!bee.targetCell || !bee.targetCell.filled) {
      const target = pickRandomFilledCell(null);
      if (!target) { bee.state = 'flee'; return; }
      bee.targetCell = target;
    }
    const dx = bee.targetCell.x - bee.x, dy = bee.targetCell.y - bee.y;
    const dist = Math.hypot(dx, dy);
    const speed = BEE_SEEK_SPEED_FRAC * vw * speedMult;
    if (dist < Math.max(6, bee.r * 0.6)) {
      stealCell(bee.targetCell);
      const nextTarget = Math.random() < stealAgainChance ? pickRandomFilledCell(bee.targetCell.key) : null;
      if (nextTarget) { bee.targetCell = nextTarget; }
      else { bee.state = 'flee'; bee.targetCell = null; }
    } else {
      bee.x += (dx / dist) * speed * dt;
      bee.y += (dy / dist) * speed * dt;
    }
    return;
  }

  // flee: sai voando na direção que já estava indo (ou pra fora da tela, se
  // acabou de ser espantada) até sair da área visível, aí é removida.
  const speed = BEE_FLEE_SPEED_FRAC * vw * speedMult;
  bee.x += Math.cos(bee.wanderAngle) * speed * dt;
  bee.y += Math.sin(bee.wanderAngle) * speed * dt;
  const margin = vw * 0.08;
  if (bee.x < -margin || bee.x > vw + margin || bee.y < -margin || bee.y > vh + margin) {
    bee.dead = true;
  }
}

function stealCell(cell) {
  cell.filled = false;
  cell.correct = false;
  removeCellBead(cell);
  playBeeSteal();
  reportProgress();
}

function beeSwatRadius(bee) {
  return bee.r * BEE_SWAT_RADIUS_FACTOR;
}

// Chamado quando uma pinça COMEÇA perto de uma abelha (ver processHands) —
// espanta a abelha mais próxima dentro do raio em vez de deixar esse mesmo
// gesto contar como "pegar conta". Devolve true se espantou alguma.
function trySwatBee(x, y) {
  let best = null, bestDist = Infinity;
  for (const bee of bees) {
    if (bee.state === 'flee') continue;
    const d = Math.hypot(bee.x - x, bee.y - y);
    if (d < beeSwatRadius(bee) && d < bestDist) { bestDist = d; best = bee; }
  }
  if (!best) return false;
  best.state = 'flee';
  best.targetCell = null;
  best.wanderAngle = Math.atan2(best.y - y, best.x - x); // sai correndo pra longe da pinça
  playBeeSwat();
  return true;
}

function updateBees(now) {
  if (completed || winActive || !running || mode !== 'board') return;
  const dt = Math.min(0.05, Math.max(0, (now - lastBeeFrameAt) / 1000));
  lastBeeFrameAt = now;

  const lvl = currentDifficulty;
  const idleThreshold = Math.max(BEE_MIN_IDLE_MS, BEE_BASE_IDLE_MS - lvl * BEE_IDLE_STEP_MS);
  const maxBees = Math.min(BEE_MAX_COUNT_CAP, BEE_BASE_MAX_COUNT + Math.floor(lvl / BEE_LEVELS_PER_EXTRA_BEE));
  const speedMult = Math.min(BEE_MAX_SPEED_MULT, 1 + lvl * BEE_SPEED_STEP);
  const stealAgainChance = Math.min(BEE_STEAL_AGAIN_CAP, BEE_STEAL_AGAIN_BASE + lvl * BEE_STEAL_AGAIN_STEP);

  const idleFor = now - lastActivityAt;
  if (idleFor > idleThreshold && bees.length < maxBees && now - lastBeeSpawnCheckAt > BEE_SPAWN_CHECK_MS) {
    lastBeeSpawnCheckAt = now;
    spawnBee();
  }

  for (const bee of bees) stepBee(bee, now, dt, speedMult, stealAgainChance);
  if (bees.some((b) => b.dead)) bees = bees.filter((b) => !b.dead);
}

function drawBees(now) {
  if (bees.length === 0) return;
  overlayCtx.textAlign = 'center';
  overlayCtx.textBaseline = 'middle';
  for (const bee of bees) {
    const bob = Math.sin(now / 70 + bee.id) * (bee.r * 0.14);
    const scale = bee.state === 'seek' ? 1.15 : 1;
    overlayCtx.globalAlpha = bee.state === 'flee' ? 0.8 : 1;
    overlayCtx.font = `${Math.round(bee.r * 2 * scale)}px sans-serif`;
    fillTextMirrored('🐝', bee.x, bee.y + bob);
  }
  overlayCtx.globalAlpha = 1;
}

// Seta apontando pra bandeja, só na 1ª fase de cada categoria (ver
// startWebcam) — o "pegar a conta" era o ponto menos óbvio pra quem nunca
// jogou; some assim que a pessoa pega a primeira (ver fillCell).
function anyHandHolding() {
  return handStates.some((s) => s.heldLegendIdx !== null) || mouseState.heldLegendIdx !== null;
}

// Dica animada de pinça: dois pontinhos (polegar/indicador) abrindo e
// fechando em loop contínuo, tipo demonstração do gesto, com um "pisca" de
// opacidade pra chamar atenção. Aparece em toda fase (não só na primeira),
// mas some enquanto alguma mão/mouse já está de fato segurando uma conta
// (ver anyHandHolding) — reaparece assim que solta. Na 1ª fase de cada
// categoria vem maior e com o texto explicando (ver isFirstLevelOfCategory).
// Voltou a ideia original (não o par de pontinhos simulando pinça — não
// ficou claro pra quem jogou): as próprias continhas da bandeja piscam
// (anel pulsando) SEMPRE, em toda fase/tela — sem exceção, não some nem
// enquanto a mão já está segurando algo.
function drawTrayPulse(now) {
  if (traySpheres.length === 0) return;
  const pulse = 0.5 + 0.5 * Math.sin(now / 260);
  overlayCtx.globalAlpha = 0.35 + pulse * 0.5;
  overlayCtx.lineCap = 'round';
  for (const tray of traySpheres) {
    overlayCtx.beginPath();
    overlayCtx.arc(tray.x, tray.y, tray.r * (1.15 + pulse * 0.25), 0, Math.PI * 2);
    overlayCtx.lineWidth = Math.max(2, tray.r * 0.16);
    overlayCtx.strokeStyle = '#f9c74f';
    overlayCtx.stroke();
  }
  overlayCtx.globalAlpha = 1;
}

// Demonstração de uma mão fechando (🖐️ ↔ 🤏, alternando) por cima da
// bandeja — só na primeiríssima fase de cada categoria (ver
// isFirstLevelOfCategory), some enquanto a mão/mouse já está segurando algo
// (não faz sentido mostrar "feche a mão" bem onde a mão de verdade está).
function drawHandCloseDemo(now) {
  if (!isFirstLevelOfCategory || anyHandHolding() || traySpheres.length === 0) return;

  const first = traySpheres[0], last = traySpheres[traySpheres.length - 1];
  const cx = (first.x + last.x) / 2;
  const baseR = first.r * 1.6;
  const bob = Math.sin(now / 300) * (baseR * 0.35);
  const cy = first.y - baseR * 2.5 + bob;
  const closed = Math.floor(now / 500) % 2 === 0;

  overlayCtx.textAlign = 'center';
  overlayCtx.textBaseline = 'middle';
  overlayCtx.font = `${Math.round(baseR * 1.8)}px sans-serif`;
  fillTextMirrored(closed ? '🤏' : '🖐️', cx, cy);

  overlayCtx.font = `bold ${Math.max(11, Math.round(baseR * 0.4))}px 'Courier New', monospace`;
  overlayCtx.fillStyle = '#f9c74f';
  fillTextMirrored('pinça uma continha assim!', cx, cy - baseR * 1.3);
}

// Tela de "categoria completa" — desenhada por cima de tudo enquanto
// winActive (ver showCategoryComplete/checkWinButtonHover), com o mesmo
// botão de apontar-e-segurar do "voltar" (drawDwellButton), só apontando
// pra callbacks.onPlayAgain() em vez de exitWebcam().
function drawWinScreen(now) {
  const vw = overlay.width, vh = overlay.height;
  const unit = Math.min(vw, vh);

  overlayCtx.fillStyle = 'rgba(13,15,18,0.86)';
  overlayCtx.fillRect(0, 0, vw, vh);

  overlayCtx.textAlign = 'center';
  overlayCtx.textBaseline = 'middle';
  const titleY = vh * 0.28;
  overlayCtx.font = `bold ${Math.round(unit * 0.07)}px 'Courier New', monospace`;
  overlayCtx.fillStyle = '#f9c74f';
  fillTextMirrored('🎉 VOCÊ COMPLETOU TUDO! 🎉', vw / 2, titleY);

  overlayCtx.font = `${Math.round(unit * 0.038)}px 'Courier New', monospace`;
  overlayCtx.fillStyle = '#e6e8eb';
  fillTextMirrored('todos os desenhos dessa categoria foram montados', vw / 2, titleY + unit * 0.06);

  const winButton = getWinButtonLayout(vw, vh);
  const frac = winHovering ? Math.min(1, (now - winHoverStart) / WIN_DWELL_MS) : 0;
  drawDwellButton(winButton.x, winButton.y, winButton.r, '🔁', 'JOGAR DE NOVO', winHovering, frac);
}

function draw() {
  const vw = overlay.width, vh = overlay.height;
  overlayCtx.clearRect(0, 0, vw, vh);

  if (mode === 'menu') {
    drawMenu();
    return;
  }

  const now = performance.now();

  if (winActive) {
    drawWinScreen(now);
    webglRenderer.render(webglScene, webglCamera);
    return;
  }

  drawTrayPulse(now);
  drawHandCloseDemo(now);

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

  drawBees(now);

  const backFrac = backHovering ? Math.min(1, (now - backHoverStart) / BACK_DWELL_MS) : 0;
  drawDwellButton(backButton.x, backButton.y, backButton.r, '◀', 'VOLTAR', backHovering, backFrac);

  webglRenderer.render(webglScene, webglCamera);
}

// Compartilhado entre exitWebcam (jogo) e exitMenu: solta a câmera, cancela o
// loop e desmonta o DOM. O que muda entre os dois é só qual listener de mouse
// tinha sido registrado (board vs. menu) e se dispara callbacks.onExit no final.
function teardownSession() {
  running = false;
  if (rafId !== null) cancelAnimationFrame(rafId);
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
  if (mode === 'menu') teardownMenuMouseInput(); else teardownMouseInput();
  if (stageEl && stageEl.parentElement) stageEl.parentElement.removeChild(stageEl);
  stageEl = null;
  if (webglRenderer) { webglRenderer.dispose(); webglRenderer = null; }
  webglScene = null;
  webglCamera = null;
  trayBeadGroup = null;
  cellBeadGroup = null;
  handBeadGroup = null;
  pincerGroup = null;
}

export function exitWebcam() {
  teardownSession();
  mode = null;
  callbacks.onExit();
}
