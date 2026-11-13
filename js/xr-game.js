// Hama AR — modo WebXR (celular Android com ARCore).
//
// A placa 8×8 é fixada no plano da mesa detectado pelo ARCore (hit-test),
// sem marcadores. A imagem da câmera do próprio AR (WebXR Raw Camera Access,
// recurso 'camera-access') é copiada a cada ~60 ms e entregue ao MediaPipe
// HandLandmarker; o ponto médio entre polegar e indicador é projetado num
// raio da câmera e intersectado com o plano da placa — é assim que a pinça
// pega e solta contas em 3D. Toque na tela funciona como alternativa.
//
// Mesmas regras do jogo na webcam (webcam-scene.js): categorias e níveis
// (shapes/*), cor errada é recusada, pinça numa conta já encaixada copia a
// cor, abelhas roubam contas quando a criança demora e são espantadas com
// uma pinça, nível concluído avança sozinho, progresso salvo (progress.js).

import * as THREE from 'three';
import { HandLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
import { BASIC_SHAPES } from './shapes/basic.js';
import { LETTER_SHAPES } from './shapes/letters.js';
import { NUMBER_SHAPES } from './shapes/numbers.js';
import { isCompleted, markCompleted } from './progress.js';
import {
  primeAudio, startMusic, stopMusic, toggleMusic, isMusicEnabled, setMusicIntensity, triggerMusicFlourish,
  playPickup, playCorrect, playWrong, playComplete, playBeeSteal, playBeeSwat,
} from './sound.js';
import { beginFrame, endFrame, recordInference, recordPinch, recordFeedback } from './metrics.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';
const FLIP = params.get('flip') === '1';

const CATEGORIES = { hama: BASIC_SHAPES, matematica: NUMBER_SHAPES, palavras: LETTER_SHAPES };

// Geometria (metros). Passo de 2 cm: maior que a Hama real, para a criança
// enxergar e acertar o pino com a pinça.
const N = 8;
const PITCH = 0.02;
const PINCH_ON = 0.33, PINCH_OFF = 0.5; // distância polegar–indicador / tamanho da mão (histerese)
const PICK_RADIUS = PITCH * 0.8;
const TRAY_RADIUS = 0.045;
const HAND_LOST_GRACE_MS = 600; // a mão some por alguns quadros: não solta a conta na hora
const INFER_EVERY_MS = 60;
const LEVEL_ADVANCE_MS = 2200;
const BACK_DWELL_MS = 3000; // botão VOLTAR por gesto: apontar e segurar (como no modo webcam)
const WIN_DWELL_MS = 2200;
const DWELL_RADIUS = 0.03;

// Abelhas: mesma curva de dificuldade do modo webcam
const BEE_BASE_IDLE_MS = 11000, BEE_IDLE_STEP_MS = 900, BEE_MIN_IDLE_MS = 3500;
const BEE_MAX_COUNT_CAP = 4, BEE_LEVELS_PER_EXTRA_BEE = 2;
const BEE_BUZZ_MS = 1300;
const BEE_WANDER_SPEED = 0.05, BEE_SEEK_SPEED = 0.07, BEE_FLEE_SPEED = 0.25; // m/s
const BEE_MAX_SPEED_MULT = 2.4, BEE_SPEED_STEP = 0.16;
const BEE_STEAL_AGAIN_BASE = 0.12, BEE_STEAL_AGAIN_STEP = 0.09, BEE_STEAL_AGAIN_CAP = 0.8;
const BEE_SWAT_SCREEN = 0.09; // distância na tela (fração) para a pinça espantar

// ---------------------------------------------------------------- //
// Tela inicial
// ---------------------------------------------------------------- //

let hands = null;
function refreshCategoryLabels() {
  for (const [key, list] of Object.entries(CATEGORIES)) {
    const done = list.filter((s) => isCompleted(s.name)).length;
    $('c-' + key).textContent = `${done} de ${list.length} níveis concluídos`;
  }
}
refreshCategoryLabels();

(async () => {
  try {
    const fs = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    hands = await HandLandmarker.createFromOptions(fs, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO', numHands: 2,
    });
  } catch (e) {
    $('status').textContent = 'Rastreador de mãos não carregou (' + e.message + '). Dá para jogar por toque.';
  }
  const ok = navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  if (!ok) {
    $('status').innerHTML = 'Este navegador não oferece AR (WebXR). Use o <b>Chrome no Android</b> com o Google Play Services for AR.';
    return;
  }
  if (hands) $('status').textContent = 'Escolha uma categoria para começar.';
  document.querySelectorAll('.cat').forEach((b) => { b.disabled = false; });
})();

document.querySelectorAll('.cat').forEach((btn) => btn.addEventListener('click', () => {
  primeAudio();
  startMusic();
  startCategory(btn.dataset.cat);
}));

// ---------------------------------------------------------------- //
// three.js: cena, placa, bandeja, contas, abelhas
// ---------------------------------------------------------------- //

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.domElement.style.display = 'none';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);
scene.add(new THREE.HemisphereLight(0xffffff, 0x887766, 2.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(0.3, 1, 0.25);
scene.add(sun);

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.05, 0.065, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xf9c74f }),
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

const board = new THREE.Group();
board.visible = false;
scene.add(board);

function makeBeadGeometry() {
  const ro = 0.0092, ri = 0.0043, h = 0.013, b = 0.0018;
  const pts = [[ri, 0], [ro - b, 0], [ro, b], [ro, h - b], [ro - b, h], [ri + b * 0.5, h], [ri, h - b * 0.5], [ri, 0]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, 28);
}
const beadGeo = makeBeadGeometry();
const pegGeo = new THREE.CylinderGeometry(0.0025, 0.003, 0.008, 12).translate(0, 0.007, 0);

const plate = new THREE.Mesh(
  new THREE.BoxGeometry(N * PITCH + 0.012, 0.003, N * PITCH + 0.012),
  new THREE.MeshStandardMaterial({ color: 0xeef3f7, transparent: true, opacity: 0.65, roughness: 0.3 }),
);
plate.position.y = 0.0015;
board.add(plate);
const pegMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ec, roughness: 0.3 });

const cellPos = (gx, gy) => new THREE.Vector3((gx - (N - 1) / 2) * PITCH, 0.003, (gy - (N - 1) / 2) * PITCH);
for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
  const peg = new THREE.Mesh(pegGeo, pegMat);
  peg.position.copy(cellPos(gx, gy)).setY(0);
  board.add(peg);
}

const matCache = new Map();
function beadMat(rgb) {
  const k = rgb.join(',');
  if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial({ color: new THREE.Color(`rgb(${k})`), roughness: 0.3 }));
  return matCache.get(k);
}
const ghostCache = new Map();
function ghostMat(rgb) {
  const k = rgb.join(',');
  if (!ghostCache.has(k)) {
    ghostCache.set(k, new THREE.MeshStandardMaterial({
      color: new THREE.Color(`rgb(${k})`), transparent: true, opacity: 0.35, roughness: 0.5, depthWrite: false,
    }));
  }
  return ghostCache.get(k);
}
const rejectMat = new THREE.MeshStandardMaterial({ color: 0xef4444, transparent: true, opacity: 0.85, depthWrite: false });
const pulseMat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5, roughness: 0.4, depthWrite: false });

const levelGroup = new THREE.Group(); // tudo que muda por nível
board.add(levelGroup);

// Visual de cada mão (até 2): anel no ponto da pinça, marcadores do polegar
// e do indicador, e a conta segurada. O toque na tela tem a sua conta.
const tipGeo = new THREE.SphereGeometry(0.004, 14, 10);
function makeHandVis() {
  const cursor = new THREE.Mesh(new THREE.RingGeometry(0.011, 0.016, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xf9c74f, depthTest: false, transparent: true }));
  const thumb = new THREE.Mesh(tipGeo, new THREE.MeshBasicMaterial({ color: 0xf9c74f, depthTest: false, transparent: true }));
  const index = new THREE.Mesh(tipGeo, thumb.material);
  const carried = new THREE.Mesh(beadGeo, beadMat([255, 255, 255]));
  for (const m of [cursor, thumb, index]) m.renderOrder = 10;
  for (const m of [cursor, thumb, index, carried]) { m.visible = false; board.add(m); }
  return { cursor, thumb, index, carried };
}
function hideVis(v) { for (const m of Object.values(v)) m.visible = false; }
const handVis = [makeHandVis(), makeHandVis()];
const touchCarried = new THREE.Mesh(beadGeo, beadMat([255, 255, 255]));
touchCarried.visible = false;
board.add(touchCarried);

// Botões 3D deitados na mesa, acionados apontando o indicador e segurando
// (dwell), como o VOLTAR e o "jogar de novo" do modo webcam.
function labelTexture(icon, text, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillStyle = '#e6e8eb';
  x.font = '110px sans-serif';
  x.fillText(icon, 128, 108);
  x.fillStyle = color;
  x.font = 'bold 40px monospace';
  x.fillText(text, 128, 200);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function makeDwellButton(icon, text, color, pos) {
  const group = new THREE.Group();
  group.position.copy(pos);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.024, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x16191d, transparent: true, opacity: 0.88 }));
  disc.position.y = 0.002;
  const edge = new THREE.Mesh(new THREE.RingGeometry(0.024, 0.027, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color }));
  edge.position.y = 0.0022;
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.042, 0.042).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: labelTexture(icon, text, color), transparent: true }));
  label.position.y = 0.0025;
  const prog = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x4ade80, side: THREE.DoubleSide }));
  prog.position.y = 0.0028;
  group.add(disc, edge, label, prog);
  board.add(group);
  const btn = { group, edge, prog, hoverStart: 0, lastFrac: -1, color };
  btn.setProgress = (frac) => {
    const f = Math.round(frac * 40) / 40;
    if (f === btn.lastFrac) return;
    btn.lastFrac = f;
    prog.geometry.dispose();
    prog.geometry = f > 0 ? new THREE.RingGeometry(0.027, 0.032, 40, 1, Math.PI / 2, -f * Math.PI * 2).rotateX(-Math.PI / 2) : new THREE.BufferGeometry();
    edge.material.color.set(f > 0 ? 0x4ade80 : btn.color);
  };
  return btn;
}
const backBtn3D = makeDwellButton('◀', 'VOLTAR', '#f9c74f', new THREE.Vector3((N * PITCH) / 2 + 0.04, 0, -(N * PITCH) / 2 + 0.025));
const againBtn3D = makeDwellButton('🔁', 'DE NOVO', '#4ade80', new THREE.Vector3(-0.035, 0, (N * PITCH) / 2 + 0.045));
const menuBtn3D = makeDwellButton('🏠', 'MENU', '#f9c74f', new THREE.Vector3(0.035, 0, (N * PITCH) / 2 + 0.045));
againBtn3D.group.visible = menuBtn3D.group.visible = false;

// ---------------------------------------------------------------- //
// Estado do jogo
// ---------------------------------------------------------------- //

let order = [], levelIdx = 0, pattern = null;
let cells = []; // { gx, gy, target:{name,rgb}|null, filled, rejectedUntil, ghost, bead }
let tray = []; // { name, rgb, pos, bead, ring }
function newHand() { return { pinching: false, seenAt: 0, holding: null, paintKey: undefined, tip: null }; }
let handsSt = [newHand(), newHand()]; // por mão: pinça, cor segurada, último pino pintado
let touch = { src: null, holding: null, paintKey: undefined, fromTray: false, painted: false };
let tapColor = null; // cor escolhida com um toque (modo toque-toque)
let firstLevelIdx = 0; // demonstração da pinça no 1º nível jogado da categoria
function heldColor() {
  const h = handsSt.find((st) => st.holding);
  return h ? h.holding : touch.holding || tapColor;
}
function resetHands() {
  handsSt = [newHand(), newHand()];
  touch = { src: null, holding: null, paintKey: undefined, fromTray: false, painted: false };
  tapColor = null;
  for (const v of handVis) hideVis(v);
  touchCarried.visible = false;
}
let levelDone = false, categoryDone = false;
let bees = [], lastActivityAt = 0, lastBeeCheckAt = 0;
let confetti = [];

function startCategory(cat) {
  order = [...CATEGORIES[cat]].sort((a, b) => a.totalBeads - b.totalBeads);
  const next = order.findIndex((s) => !isCompleted(s.name));
  levelIdx = next === -1 ? 0 : next;
  firstLevelIdx = levelIdx;
  demoDone = false;
  loadLevel();
  enterAR();
}

function loadLevel() {
  pattern = order[levelIdx];
  levelDone = false;
  categoryDone = false;
  resetHands();
  againBtn3D.group.visible = menuBtn3D.group.visible = false;
  for (const b of bees) board.remove(b.group);
  bees = [];
  levelGroup.clear();
  $('endBox').style.display = 'none';

  // o desenho (até 8×8) centralizado na placa
  const ox = Math.floor((N - pattern.w) / 2), oy = Math.floor((N - pattern.h) / 2);
  cells = [];
  for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
    const px = gx - ox, py = gy - oy;
    const inside = px >= 0 && py >= 0 && px < pattern.w && py < pattern.h;
    const c = inside ? pattern.cells[py * pattern.w + px] : null;
    const target = c ? { name: c.name, rgb: [c.r, c.g, c.b] } : null;
    const cell = { gx, gy, target, filled: false, rejectedUntil: 0, ghost: null, bead: null };
    if (target) {
      cell.ghost = new THREE.Mesh(beadGeo, ghostMat(target.rgb));
      cell.ghost.position.copy(cellPos(gx, gy));
      levelGroup.add(cell.ghost);
    }
    cells.push(cell);
  }

  // bandeja: uma conta por cor, à esquerda da placa (do ponto de vista de quem joga)
  const dishGeo = new THREE.CylinderGeometry(0.015, 0.014, 0.003, 32);
  const dishMat = new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.6 });
  const ringGeo = new THREE.RingGeometry(0.017, 0.021, 32).rotateX(-Math.PI / 2);
  const n = pattern.legend.length;
  const gap = Math.min(0.036, (N * PITCH + 0.03) / Math.max(1, n));
  tray = pattern.legend.map((l, k) => {
    const pos = new THREE.Vector3(-(N * PITCH) / 2 - 0.035, 0, (k - (n - 1) / 2) * gap);
    const dish = new THREE.Mesh(dishGeo, dishMat);
    dish.position.copy(pos).setY(0.0015);
    const bead = new THREE.Mesh(beadGeo, beadMat([l.r, l.g, l.b]));
    bead.position.copy(pos).setY(0.003);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xf9c74f, transparent: true, opacity: 0.9 }));
    ring.position.copy(pos).setY(0.0035);
    ring.visible = false;
    levelGroup.add(dish, bead, ring);
    return { name: l.name, rgb: [l.r, l.g, l.b], pos, bead, ring };
  });

  lastActivityAt = performance.now();
  $('lvl').textContent = `Nível ${levelIdx + 1} de ${order.length} · ${pattern.name}`;
  reportProgress();
}

function nextTarget() {
  return cells.find((c) => c.target && !c.filled) || null;
}

function reportProgress() {
  const total = cells.filter((c) => c.target).length;
  const correct = cells.filter((c) => c.filled).length;
  $('prog').textContent = `${correct} / ${total} contas`;
  $('fill').style.width = `${total ? (correct / total) * 100 : 0}%`;
  if (total) setMusicIntensity(correct / total);
  if (total && correct === total && !levelDone) levelComplete();
}

function levelComplete() {
  levelDone = true;
  markCompleted(pattern.name);
  playComplete();
  triggerMusicFlourish();
  burstConfetti();
  for (const b of bees) fleeBee(b);
  if (levelIdx >= order.length - 1) {
    categoryDone = true;
    setHint('Você completou todos os níveis! 🎉 Aponte e segure em DE NOVO ou MENU.');
    setTimeout(() => {
      $('endBox').style.display = 'block';
      againBtn3D.group.visible = menuBtn3D.group.visible = true;
    }, 1200);
    return;
  }
  setHint('Nível concluído! Preparando o próximo…');
  setTimeout(() => { levelIdx++; loadLevel(); }, LEVEL_ADVANCE_MS);
}

$('againBtn').addEventListener('click', () => { levelIdx = 0; loadLevel(); });
$('menuBtn').addEventListener('click', () => session && session.end());

let lastHint = '';
function setHint(t) { if (t !== lastHint) { lastHint = t; $('hint').textContent = t; } }

function updateHint() {
  if (levelDone) return;
  if (performance.now() - lastErrorAt < 6000) return; // deixa o erro visível
  if (!board.visible) {
    setHint(reticle.visible ? 'Mesa encontrada! Toque na tela para colocar a placa.' : 'Procure a mesa: mova o celular devagar.');
    return;
  }
  if (bees.some((b) => b.state !== 'flee')) { setHint('Uma abelha! Faça a pinça em cima dela para espantar.'); return; }
  const nt = nextTarget();
  if (!nt) return;
  const held = heldColor();
  if (held) setHint(`Com a pinça fechada, passe a conta ${held.name.toLowerCase()} pelos pinos — eles vão sendo preenchidos.`);
  else setHint(`Pegue a conta ${nt.target.name.toLowerCase()} na bandeja com a pinça.`);
}

// ---------------------------------------------------------------- //
// Ações (pinça e toque usam as mesmas)
// ---------------------------------------------------------------- //

function nearestTray(p) {
  let best = null, bd = TRAY_RADIUS;
  for (const t of tray) { const d = Math.hypot(t.pos.x - p.x, t.pos.z - p.z); if (d < bd) { bd = d; best = t; } }
  return best;
}
function nearestCell(p) {
  const gx = Math.round(p.x / PITCH + (N - 1) / 2), gy = Math.round(p.z / PITCH + (N - 1) / 2);
  if (gx < 0 || gy < 0 || gx >= N || gy >= N) return null;
  const c = cells[gy * N + gx];
  const cp = cellPos(gx, gy);
  return Math.hypot(cp.x - p.x, cp.z - p.z) < PICK_RADIUS ? c : null;
}

// pega a cor: da bandeja, ou de uma conta já encaixada ("copiar")
function pickAt(p) {
  const t = nearestTray(p);
  if (t) return { name: t.name, rgb: t.rgb };
  const c = nearestCell(p);
  if (c && c.filled) return { name: c.target.name, rgb: c.target.rgb };
  return null;
}

// só encaixa se a cor bater com o alvo; cor errada é recusada (pino pisca vermelho)
function dropAt(p, color) {
  const c = nearestCell(p);
  if (!c || c.filled || !c.target) return false; // pino fora do desenho: ignora (como no modo webcam)
  if (c.target.name !== color.name) {
    c.rejectedUntil = performance.now() + 400;
    playWrong();
    pendingMetrics.events.push({ kind: 'erro' + evSuffix, at: performance.now() });
    return true;
  }
  c.filled = true;
  c.bead = new THREE.Mesh(beadGeo, beadMat(c.target.rgb));
  c.bead.position.copy(cellPos(c.gx, c.gy));
  levelGroup.add(c.bead);
  playCorrect();
  pendingMetrics.events.push({ kind: 'acerto' + evSuffix, at: performance.now() });
  lastActivityAt = performance.now();
  reportProgress();
  return true;
}

// Modo pintura (igual ao modo webcam): enquanto a pinça (ou o dedo na tela)
// continua fechada, preenche cada pino da cor certa por onde passa — só
// tenta de novo quando o pino "por baixo" muda, para não repetir o som de
// recusa parado em cima de um pino de outra cor.
let evSuffix = ''; // '' = pinça; '-toque' = toque na tela (para comparar as duas condições)
function paintStep(st, p) {
  evSuffix = st === touch ? '-toque' : '';
  const c = nearestCell(p);
  const key = c && c.target ? c.gy * N + c.gx : null;
  if (key === st.paintKey) return;
  st.paintKey = key;
  if (key !== null && !c.filled) { dropAt(p, st.holding); st.painted = true; }
}

function stealCell(c) {
  c.filled = false;
  if (c.bead) { levelGroup.remove(c.bead); c.bead = null; }
  playBeeSteal();
  reportProgress();
}

// ---------------------------------------------------------------- //
// Abelhas 3D
// ---------------------------------------------------------------- //

function makeBee() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.008, 16, 12), new THREE.MeshStandardMaterial({ color: 0xf9c74f, roughness: 0.5 }));
  body.scale.set(1.35, 1, 1);
  g.add(body);
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
  for (const x of [-0.003, 0.003]) {
    const s = new THREE.Mesh(new THREE.TorusGeometry(0.0078, 0.0016, 8, 20), stripeMat);
    s.rotation.y = Math.PI / 2;
    s.position.x = x;
    g.add(s);
  }
  const wingMat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
  const wings = [-1, 1].map((side) => {
    const w = new THREE.Mesh(new THREE.CircleGeometry(0.007, 16), wingMat);
    w.scale.set(0.6, 1, 1);
    w.position.set(0, 0.006, side * 0.005);
    w.rotation.x = Math.PI / 2;
    g.add(w);
    return w;
  });
  g.userData.wings = wings;
  return g;
}

function spawnBee(now) {
  const group = makeBee();
  const ang = Math.random() * Math.PI * 2;
  group.position.set(Math.cos(ang) * 0.16, 0.07, Math.sin(ang) * 0.16);
  board.add(group);
  bees.push({ group, state: 'buzz', bornAt: now, target: null, dir: new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize(), nextTurn: 0, steals: 0 });
}

function fleeBee(b) {
  b.state = 'flee';
  b.dir = b.group.position.clone().setY(0).normalize();
  if (b.dir.lengthSq() < 0.1) b.dir.set(1, 0, 0);
  b.dir.y = 0.8;
  b.dir.normalize();
}

function updateBees(now, dt) {
  const mult = Math.min(BEE_MAX_SPEED_MULT, 1 + BEE_SPEED_STEP * levelIdx);
  const idle = Math.max(BEE_MIN_IDLE_MS, BEE_BASE_IDLE_MS - BEE_IDLE_STEP_MS * levelIdx);
  const maxBees = Math.min(BEE_MAX_COUNT_CAP, 1 + Math.floor(levelIdx / BEE_LEVELS_PER_EXTRA_BEE));
  const stealAgain = Math.min(BEE_STEAL_AGAIN_CAP, BEE_STEAL_AGAIN_BASE + BEE_STEAL_AGAIN_STEP * levelIdx);

  if (board.visible && !levelDone && now - lastBeeCheckAt > 1400) {
    lastBeeCheckAt = now;
    const active = bees.filter((b) => b.state !== 'flee').length;
    if (now - lastActivityAt > idle && active < maxBees && cells.some((c) => c.filled)) {
      spawnBee(now);
      lastActivityAt = now;
    }
  }

  for (const b of bees) {
    const p = b.group.position;
    for (const w of b.group.userData.wings) w.rotation.y = Math.sin(now / 25) * 0.6;
    if (b.state === 'buzz') {
      if (now > b.nextTurn) { b.dir.set(Math.random() - 0.5, (Math.random() - 0.5) * 0.3, Math.random() - 0.5).normalize(); b.nextTurn = now + 380; }
      p.addScaledVector(b.dir, BEE_WANDER_SPEED * mult * dt);
      p.y = THREE.MathUtils.clamp(p.y, 0.04, 0.1);
      p.x = THREE.MathUtils.clamp(p.x, -0.18, 0.18); p.z = THREE.MathUtils.clamp(p.z, -0.18, 0.18);
      if (now - b.bornAt > BEE_BUZZ_MS) {
        const filled = cells.filter((c) => c.filled);
        if (filled.length) { b.target = filled[Math.floor(Math.random() * filled.length)]; b.state = 'seek'; } else fleeBee(b);
      }
    } else if (b.state === 'seek') {
      if (!b.target || !b.target.filled) {
        const filled = cells.filter((c) => c.filled);
        if (!filled.length) { fleeBee(b); continue; }
        b.target = filled[Math.floor(Math.random() * filled.length)];
      }
      const goal = cellPos(b.target.gx, b.target.gy).setY(0.02);
      const d = goal.clone().sub(p);
      const step = BEE_SEEK_SPEED * mult * dt;
      if (d.length() <= step) {
        stealCell(b.target);
        b.steals++;
        if (Math.random() < stealAgain && cells.some((c) => c.filled)) b.target = null; else fleeBee(b);
      } else p.addScaledVector(d.normalize(), step);
    } else {
      p.addScaledVector(b.dir, BEE_FLEE_SPEED * dt);
    }
    if (b.state !== 'flee') b.group.lookAt(board.localToWorld(p.clone().add(b.dir)));
  }
  bees = bees.filter((b) => {
    const gone = b.state === 'flee' && b.group.position.length() > 0.5;
    if (gone) board.remove(b.group);
    return !gone;
  });
}

// espantar: ponto da pinça (tela) perto da abelha projetada na tela
function trySwatScreen(sx, sy, proj, viewInv) {
  let hit = false;
  for (const b of bees) {
    if (b.state === 'flee') continue;
    const w = b.group.getWorldPosition(new THREE.Vector3()).applyMatrix4(viewInv).applyMatrix4(proj);
    const bx = (w.x + 1) / 2, by = (1 - w.y) / 2;
    if (Math.hypot(bx - sx, by - sy) < BEE_SWAT_SCREEN) { fleeBee(b); hit = true; }
  }
  if (hit) { playBeeSwat(); lastActivityAt = performance.now(); }
  return hit;
}

// ---------------------------------------------------------------- //
// Confete ao concluir o nível
// ---------------------------------------------------------------- //

const confettiGeo = new THREE.BoxGeometry(0.004, 0.0015, 0.006);
const CONFETTI_COLORS = [0xf9c74f, 0xf472b6, 0x4ade80, 0x1e5aa8, 0xc91e2a, 0x754a98, 0xed7423];
function burstConfetti() {
  for (let i = 0; i < 70; i++) {
    const m = new THREE.Mesh(confettiGeo, new THREE.MeshStandardMaterial({ color: CONFETTI_COLORS[i % CONFETTI_COLORS.length] }));
    m.position.set((Math.random() - 0.5) * 0.08, 0.02, (Math.random() - 0.5) * 0.08);
    board.add(m);
    confetti.push({ m, v: new THREE.Vector3((Math.random() - 0.5) * 0.35, 0.35 + Math.random() * 0.3, (Math.random() - 0.5) * 0.35), spin: Math.random() * 10, life: 2.2 });
  }
}
function updateConfetti(dt) {
  for (const c of confetti) {
    c.v.y -= 0.9 * dt;
    c.m.position.addScaledVector(c.v, dt);
    if (c.m.position.y < 0.002) { c.m.position.y = 0.002; c.v.set(0, 0, 0); }
    c.m.rotation.x += c.spin * dt; c.m.rotation.z += c.spin * 0.7 * dt;
    c.life -= dt;
  }
  confetti = confetti.filter((c) => { if (c.life <= 0) { board.remove(c.m); return false; } return true; });
}

// ---------------------------------------------------------------- //
// Sessão WebXR
// ---------------------------------------------------------------- //

let session = null, binding = null, hitSource = null, gl = null, grab = null;
let refSpace = null;

async function enterAR() {
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['camera-access', 'dom-overlay'],
      domOverlay: { root: $('overlay') },
    });
  } catch (e) {
    $('status').textContent = 'Não foi possível abrir o AR: ' + e.message;
    return;
  }
  $('intro').style.display = 'none';
  $('overlay').style.display = 'block';
  renderer.domElement.style.display = 'block';
  renderer.xr.setReferenceSpaceType('local');
  renderer.setAnimationLoop(onFrame);
  await renderer.xr.setSession(session);
  refSpace = renderer.xr.getReferenceSpace();
  gl = renderer.getContext();
  const camAccess = session.enabledFeatures ? session.enabledFeatures.includes('camera-access') : true;
  try { if (camAccess) binding = new XRWebGLBinding(session, gl); } catch { binding = null; }
  if (!binding) $('handSt').textContent = 'sem acesso à câmera do AR (camera-access): só toque na tela';
  else $('handSt').textContent = 'mão: – · pinça: – (coloque a placa e mostre a mão)';
  const viewer = await session.requestReferenceSpace('viewer');
  hitSource = await session.requestHitTestSource({ space: viewer });
  session.addEventListener('select', onSelect);
  session.addEventListener('selectstart', (ev) => { try { onSelectStart(ev); } catch (e) { showError('toque', e); } });
  session.addEventListener('selectend', (ev) => { try { onSelectEnd(ev); } catch (e) { showError('toque', e); } });
  session.addEventListener('end', onSessionEnd);
  board.visible = false;
}

function onSessionEnd() {
  renderer.setAnimationLoop(null);
  renderer.domElement.style.display = 'none';
  $('overlay').style.display = 'none';
  $('intro').style.display = 'block';
  stopMusic();
  session = null; binding = null; hitSource = null; grab = null; refSpace = null;
  board.visible = false;
  refreshCategoryLabels();
}

for (const id of ['ctrl', 'endBox']) $(id).addEventListener('beforexrselect', (e) => e.preventDefault());
$('exitBtn').addEventListener('click', () => session && session.end());
$('placeBtn').addEventListener('click', () => { board.visible = false; });
function updateMusicLabel() { $('musicBtn').textContent = isMusicEnabled() ? '🔊' : '🔇'; }
$('musicBtn').addEventListener('click', () => { toggleMusic(); updateMusicLabel(); });
updateMusicLabel();

// Coloca a placa no ponto do hit-test, virada para quem segura o celular.
function placeBoard(hitMatrix, viewerPos) {
  const pos = new THREE.Vector3().setFromMatrixPosition(hitMatrix);
  const up = new THREE.Vector3(0, 1, 0).applyMatrix4(new THREE.Matrix4().extractRotation(hitMatrix)).normalize();
  const toCam = viewerPos.clone().sub(pos);
  toCam.sub(up.clone().multiplyScalar(toCam.dot(up)));
  if (toCam.lengthSq() < 1e-8) toCam.set(0, 0, 1);
  toCam.normalize();
  const x = new THREE.Vector3().crossVectors(up, toCam).normalize();
  board.position.copy(pos);
  board.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, toCam));
  board.visible = true;
  lastActivityAt = performance.now();
}

// raio (mundo) → ponto no plano da placa, em coordenadas locais da placa
function rayToBoard(origin, dir) {
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(board.quaternion);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(up, board.position);
  const hit = new THREE.Vector3();
  if (!new THREE.Ray(origin, dir).intersectPlane(plane, hit)) return null;
  return board.worldToLocal(hit);
}

// Toque na tela: coloca a placa; depois, toque na bandeja escolhe a cor e
// toque no pino encaixa (alternativa à pinça, como o mouse no modo webcam).
function onSelect(ev) {
  try { handleSelect(ev); } catch (e) { showError('toque', e); }
}

function showError(where, e) {
  console.error(where, e);
  setHint(`Erro (${where}): ${e && e.message ? e.message : e}`);
  lastErrorAt = performance.now();
}
let lastErrorAt = 0;

function handleSelect(ev) {
  if (!board.visible) {
    if (!reticle.visible) { setHint('Ainda não achei a mesa: mova o celular devagar até o anel aparecer.'); return; }
    placeBoard(reticle.matrix, lastViewerPos);
    playPickup();
    return;
  }
}

function touchRay(frame, inputSource) {
  const pose = frame.getPose(inputSource.targetRaySpace, refSpace);
  if (!pose) return null;
  const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
  const origin = new THREE.Vector3().setFromMatrixPosition(m);
  const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(m)).normalize();
  return { origin, dir };
}

function buttonAt(p) {
  const btns = [backBtn3D, againBtn3D, menuBtn3D].filter((b) => b.group.visible);
  return btns.find((b) => Math.hypot(b.group.position.x - p.x, b.group.position.z - p.z) < DWELL_RADIUS) || null;
}
function fireButton(b) {
  if (b === backBtn3D || b === menuBtn3D) { if (session) session.end(); }
  else if (b === againBtn3D) { levelIdx = 0; firstLevelIdx = 0; loadLevel(); }
}

// Dedo na tela (equivale ao mouse do modo webcam): encostar na bandeja pega
// a cor; arrastar pinta os pinos; soltar encaixa. Tocar e soltar na bandeja
// sem arrastar "seleciona" a cor — depois é só tocar nos pinos.
function onSelectStart(ev) {
  if (!board.visible) return;
  const r = touchRay(ev.frame, ev.inputSource);
  if (!r) return;
  for (const b of bees) {
    if (b.state === 'flee') continue;
    if (new THREE.Ray(r.origin, r.dir).distanceToPoint(b.group.getWorldPosition(new THREE.Vector3())) < 0.02) {
      fleeBee(b); playBeeSwat(); lastActivityAt = performance.now(); return;
    }
  }
  const p = rayToBoard(r.origin, r.dir);
  if (!p) return;
  const btn = buttonAt(p);
  if (btn) { fireButton(btn); return; }
  if (levelDone) return;
  touch = { src: ev.inputSource, holding: null, paintKey: undefined, fromTray: false, painted: false };
  const t = nearestTray(p);
  if (t) { touch.holding = { name: t.name, rgb: t.rgb }; touch.fromTray = true; tapColor = null; playPickup(); return; }
  const c = nearestCell(p);
  if (c && tapColor) { touch.holding = tapColor; paintStep(touch, p); return; }
  if (c && c.filled) { touch.holding = { name: c.target.name, rgb: c.target.rgb }; touch.fromTray = true; touch.paintKey = c.gy * N + c.gx; playPickup(); }
}

function onSelectEnd(ev) {
  if (!touch.src) return;
  const r = touchRay(ev.frame, ev.inputSource);
  const p = r ? rayToBoard(r.origin, r.dir) : null;
  if (touch.holding && p) paintStep(touch, p);
  if (touch.holding && touch.fromTray && !touch.painted) tapColor = touch.holding; // tocou e soltou: cor selecionada
  else if (touch.painted) tapColor = null;
  touch = { src: null, holding: null, paintKey: undefined, fromTray: false, painted: false };
  touchCarried.visible = false;
}

function updateTouch(frame) {
  if (!touch.src || !touch.holding) return;
  const r = touchRay(frame, touch.src);
  const p = r ? rayToBoard(r.origin, r.dir) : null;
  if (!p) return;
  paintStep(touch, p);
  touchCarried.visible = true;
  touchCarried.material = beadMat(touch.holding.rgb);
  touchCarried.position.set(p.x, 0.028, p.z);
}

// ---------------------------------------------------------------- //
// Câmera do AR → MediaPipe
// ---------------------------------------------------------------- //

function makeGrabber(gl) {
  const vs = `#version 300 es
  in vec2 p; out vec2 uv;
  void main(){ uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
  const fs = `#version 300 es
  precision mediump float; in vec2 uv; uniform sampler2D tex; uniform float flip; out vec4 o;
  void main(){ o = texture(tex, vec2(uv.x, flip > 0.5 ? 1.0 - uv.y : uv.y)); }`;
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  const uTex = gl.getUniformLocation(prog, 'tex'), uFlip = gl.getUniformLocation(prog, 'flip');
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  let fbo = null, target = null, w = 0, h = 0, pixels = null;
  const canvas = document.createElement('canvas');
  const cctx = canvas.getContext('2d');
  return (tex, camW, camH) => {
    const s = 384 / Math.max(camW, camH);
    const nw = Math.round(camW * s), nh = Math.round(camH * s);
    if (nw !== w || nh !== h) {
      w = nw; h = nh;
      if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(target); }
      target = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      pixels = new Uint8ClampedArray(w * h * 4);
      canvas.width = w; canvas.height = h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(uTex, 0);
    gl.uniform1f(uFlip, FLIP ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    cctx.putImageData(new ImageData(pixels, w, h), 0, 0);
    return canvas;
  };
}

// Orientação imagem→tela: no S25 FE a imagem já vem alinhada com a tela
// (886×1920 × 384×832). Gira 90° só se as proporções forem trocadas;
// ?rot=90/180/270 e ?mir=1 sobrescrevem.
let orient = null;
function mapLm(p) {
  let x = orient.mir ? 1 - p.x : p.x, y = p.y;
  if (orient.rot === 90) [x, y] = [1 - y, x];
  else if (orient.rot === 180) [x, y] = [1 - x, 1 - y];
  else if (orient.rot === 270) [x, y] = [y, 1 - x];
  return { x, y };
}

let pinching = false, inferBusy = false, lastInferAt = 0;
let fpsFrames = 0, fpsHand = 0, fpsAt = performance.now(), lastFps = { r: 0, h: 0 }, lastInferMs = 0;

let trayDistCm = null, pinchRatio = null;
function setHandStatus(hand, pinch) {
  const held = heldColor();
  $('handSt').innerHTML = `mão: ${hand ? '<b style="color:#4ade80">sim</b>' : 'não'} · pinça: ${pinch ? '<b style="color:#4ade80">sim</b>' : 'não'}`
    + (hand && pinchRatio != null ? ` (${pinchRatio.toFixed(2)})` : '')
    + (hand && trayDistCm != null ? ` · bandeja a ${trayDistCm} cm` : '')
    + (held ? ` · <b style="color:#f9c74f">segurando ${held.name.toLowerCase()}</b>` : '');
}

function handleHand(res, proj, view) {
  const all = res.landmarks || [];
  if (DEBUG) drawDots(all[0]);
  const invP = proj.clone().invert();
  const camW = view.clone().invert();
  const toBoard = (q) => {
    const a = new THREE.Vector3(q.x * 2 - 1, 1 - q.y * 2, -1).applyMatrix4(invP).applyMatrix4(camW);
    const b = new THREE.Vector3(q.x * 2 - 1, 1 - q.y * 2, 1).applyMatrix4(invP).applyMatrix4(camW);
    return rayToBoard(a, b.sub(a).normalize());
  };
  const nowMs = performance.now();
  let anyHand = false, anyPinch = false;

  for (let i = 0; i < 2; i++) {
    const st = handsSt[i], vis = handVis[i];
    const raw = all[i];
    if (!raw || !board.visible) {
      // tolerância: a detecção falha em quadros soltos; só desiste depois de um tempo
      if (nowMs - st.seenAt > HAND_LOST_GRACE_MS) { handsSt[i] = newHand(); hideVis(vis); }
      continue;
    }
    st.seenAt = nowMs;
    anyHand = true;
    const lm = raw.map(mapLm);
    const ratio = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / (Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 1);
    const pinchNow = st.pinching ? ratio < PINCH_OFF : ratio < PINCH_ON;
    if (i === 0) { pinchRatio = ratio; pendingMetrics.pinch = { ratio, pinching: pinchNow }; }

    const mid = { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 };
    const p = toBoard(mid), pt = toBoard(lm[4]), pi = toBoard(lm[8]);
    st.tip = pi;
    if (!p) { hideVis(vis); st.pinching = pinchNow; continue; }
    if (i === 0) trayDistCm = tray.length ? Math.round(Math.min(...tray.map((t) => Math.hypot(t.pos.x - p.x, t.pos.z - p.z))) * 100) : null;

    const col = pinchNow ? 0x4ade80 : 0xf9c74f;
    vis.cursor.visible = true;
    vis.cursor.position.set(p.x, 0.005, p.z);
    vis.cursor.material.color.set(col);
    vis.thumb.material.color.set(col);
    if (pt) { vis.thumb.visible = true; vis.thumb.position.set(pt.x, 0.006, pt.z); }
    if (pi) { vis.index.visible = true; vis.index.position.set(pi.x, 0.006, pi.z); }

    if (pinchNow && !st.pinching && !st.holding && !levelDone) {
      // pinça começou em cima de uma abelha: espanta; senão pega da bandeja
      // ou copia a cor de uma conta já encaixada
      if (!trySwatScreen(mid.x, mid.y, proj, view)) {
        const c = pickAt(p);
        if (c) {
          st.holding = c;
          const cell = nearestCell(p);
          st.paintKey = cell && cell.target ? cell.gy * N + cell.gx : undefined;
          playPickup();
        }
      }
    }
    if (pinchNow && st.holding && !levelDone) paintStep(st, p);
    if (st.holding) {
      vis.carried.visible = true;
      vis.carried.material = beadMat(st.holding.rgb);
      vis.carried.position.set(p.x, 0.028, p.z);
    }
    if (!pinchNow && st.pinching && st.holding) {
      paintStep(st, p); // soltou em cima de um pino sem ter arrastado
      st.holding = null;
      st.paintKey = undefined;
      vis.carried.visible = false;
    }
    st.pinching = pinchNow;
    if (pinchNow) anyPinch = true;
  }
  setHandStatus(anyHand, anyPinch);
  updateDwell(nowMs);
}

// apontar o indicador (sem segurar conta) em cima de um botão 3D e segurar
function updateDwell(nowMs) {
  for (const [btn, ms] of [[backBtn3D, BACK_DWELL_MS], [againBtn3D, WIN_DWELL_MS], [menuBtn3D, WIN_DWELL_MS]]) {
    if (!btn.group.visible) { btn.hoverStart = 0; btn.setProgress(0); continue; }
    const over = handsSt.some((st) => st.tip && !st.holding && nowMs - st.seenAt < 300 &&
      Math.hypot(st.tip.x - btn.group.position.x, st.tip.z - btn.group.position.z) < DWELL_RADIUS);
    if (!over) { btn.hoverStart = 0; btn.setProgress(0); continue; }
    if (!btn.hoverStart) btn.hoverStart = nowMs;
    const frac = (nowMs - btn.hoverStart) / ms;
    btn.setProgress(Math.min(1, frac));
    if (frac >= 1) { btn.hoverStart = 0; btn.setProgress(0); fireButton(btn); }
  }
}

function drawDots(raw) {
  const c = $('dots');
  c.style.display = 'block';
  if (c.width !== window.innerWidth) { c.width = window.innerWidth; c.height = window.innerHeight; }
  const x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  if (!raw) return;
  x.fillStyle = '#4ade80';
  for (const p of raw.map(mapLm)) { x.beginPath(); x.arc(p.x * c.width, p.y * c.height, 5, 0, 7); x.fill(); }
}

// Demonstração da pinça (🖐️ ↔ 🤏) no 1º nível jogado da categoria,
// enquanto ninguém está segurando conta — como no modo webcam.
let demoDone = false; // a demonstração some de vez quando a primeira conta é pega
function updateDemo(now) {
  if (heldColor()) demoDone = true;
  const show = board.visible && !demoDone && !levelDone;
  const el = $('demo');
  el.style.display = show ? 'block' : 'none';
  if (show) $('demoHand').textContent = Math.floor(now / 500) % 2 === 0 ? '🤏' : '🖐️';
}

// ---------------------------------------------------------------- //
// Laço por quadro
// ---------------------------------------------------------------- //

let lastT = 0;
const lastViewerPos = new THREE.Vector3(0, 0, 1);
function onFrame(t, frame) {
  // O three.js também chama este callback pelo requestAnimationFrame da
  // página (sem XRFrame) quando o laço é ligado com a sessão já aberta —
  // esses quadros são ignorados; só o laço do AR tem a câmera.
  if (!frame || !refSpace) return;
  try { frameBody(t, frame); } catch (e) { showError('quadro', e); renderer.resetState(); }
}
// A inferência roda fora do quadro (setTimeout); o metrics.js zera os campos
// em beginFrame, então os resultados ficam aqui e entram no quadro seguinte.
// A latência do retorno vai do instante da decisão até o fim desse quadro.
const pendingMetrics = { inferMs: null, pinch: null, events: [] };
function flushMetrics() {
  if (pendingMetrics.inferMs !== null) recordInference(pendingMetrics.inferMs);
  if (pendingMetrics.pinch) recordPinch(pendingMetrics.pinch.ratio, pendingMetrics.pinch.pinching);
  for (const ev of pendingMetrics.events) recordFeedback(ev.kind, ev.at);
  pendingMetrics.inferMs = null; pendingMetrics.pinch = null; pendingMetrics.events = [];
}

function frameBody(t, frame) {
  beginFrame();
  flushMetrics();
  const dt = Math.min(0.05, lastT ? (t - lastT) / 1000 : 0);
  lastT = t;
  const now = performance.now();
  fpsFrames++;

  const vpose = frame.getViewerPose(refSpace);
  if (vpose) lastViewerPos.set(vpose.transform.position.x, vpose.transform.position.y, vpose.transform.position.z);

  if (hitSource && !board.visible) {
    const hits = frame.getHitTestResults(hitSource);
    reticle.visible = hits.length > 0;
    if (hits.length) reticle.matrix.fromArray(hits[0].getPose(refSpace).transform.matrix);
  } else reticle.visible = false;

  // pinos: fantasma da próxima conta pulsa e flutua; recusado pisca vermelho
  const nt = nextTarget();
  const wave = 0.5 + 0.5 * Math.sin(now / 200);
  for (const c of cells) {
    if (!c.ghost) continue;
    c.ghost.visible = !c.filled;
    if (now < c.rejectedUntil) { c.ghost.material = rejectMat; c.ghost.position.y = 0.003; }
    else if (c === nt) {
      pulseMat.color.setRGB(c.target.rgb[0] / 255, c.target.rgb[1] / 255, c.target.rgb[2] / 255, THREE.SRGBColorSpace);
      pulseMat.opacity = 0.35 + 0.4 * wave;
      c.ghost.material = pulseMat;
      c.ghost.position.y = 0.003 + 0.006 * wave;
    } else { c.ghost.material = ghostMat(c.target.rgb); c.ghost.position.y = 0.003; }
  }
  // bandeja sempre pulsando (como no modo webcam); a cor pedida pulsa mais
  const held = heldColor();
  const wanted = held ? held.name : nt ? nt.target.name : null;
  const slow = 0.5 + 0.5 * Math.sin(now / 260);
  for (const tr of tray) {
    const sel = tapColor && tapColor.name === tr.name;
    const strong = sel || tr.name === wanted;
    tr.ring.visible = true;
    tr.ring.material.color.set(sel ? 0x4ade80 : 0xf9c74f);
    tr.ring.material.opacity = strong ? 0.55 + 0.45 * slow : 0.25 + 0.3 * slow;
    const sc = 1 + (strong ? 0.3 : 0.15) * slow;
    tr.ring.scale.set(sc, 1, sc);
    tr.bead.position.y = 0.003 + (strong ? 0.004 * wave : 0);
  }
  updateTouch(frame);
  updateDemo(now);

  updateBees(now, dt);
  updateConfetti(dt);
  updateHint();
  renderer.render(scene, camera);

  // imagem da câmera → MediaPipe, fora do quadro XR (evita piscar)
  const pose = vpose;
  if (pose && binding && hands && board.visible && !inferBusy && now - lastInferAt > INFER_EVERY_MS) {
    const view = pose.views[0];
    if (view.camera) {
      try {
        if (!grab) grab = makeGrabber(gl);
        const camW = view.camera.width, camH = view.camera.height;
        const img = grab(binding.getCameraImage(view.camera), camW, camH);
        renderer.resetState();
        if (!orient) {
          const rot = Number(params.get('rot'));
          orient = {
            rot: [90, 180, 270].includes(rot) ? rot : ((camW > camH) !== (window.innerWidth > window.innerHeight) ? 90 : 0),
            mir: params.get('mir') === '1',
          };
        }
        const proj = new THREE.Matrix4().fromArray(view.projectionMatrix);
        const viewInv = new THREE.Matrix4().fromArray(view.transform.inverse.matrix);
        inferBusy = true;
        setTimeout(() => {
          try {
            const t0 = performance.now();
            const res = hands.detectForVideo(img, t0);
            lastInferMs = performance.now() - t0;
            pendingMetrics.inferMs = lastInferMs;
            fpsHand++;
            handleHand(res, proj, viewInv);
          } catch (e) { showError('mão', e); }
          lastInferAt = performance.now();
          inferBusy = false;
        }, 0);
      } catch (e) {
        renderer.resetState();
        if (DEBUG) $('diag').textContent = 'erro câmera: ' + e.message;
      }
    }
  }

  if (now - fpsAt > 1000) {
    lastFps = { r: Math.round(fpsFrames * 1000 / (now - fpsAt)), h: Math.round(fpsHand * 1000 / (now - fpsAt)) };
    fpsFrames = 0; fpsHand = 0; fpsAt = now;
    if (DEBUG) {
      $('diag').style.display = 'block';
      $('diag').textContent = `FPS ${lastFps.r} · mão ${lastFps.h}/s · inferência ${Math.round(lastInferMs)} ms · câmera ${binding ? 'sim' : 'NÃO'} · orient ${orient ? orient.rot + '°' + (orient.mir ? ' esp' : '') : '-'}`;
    }
  }
  endFrame();
}
