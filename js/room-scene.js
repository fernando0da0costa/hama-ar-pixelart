// Modo alternativo #3: sala 3D totalmente sintética (sem câmera nenhuma,
// sem WebXR) — o quadro de contas fica sobre uma mesa no meio de uma salinha
// gerada em three.js, e a câmera orbita ao redor com o mouse (arrastar o
// fundo gira, scroll dá zoom). A interação com as contas é por dois cliques
// (igual ao fallback de toque do ar-scene.js pra celular sem rastreamento de
// mão): clica numa continha da bandeja pra escolher a cor, depois clica no
// furo certo pra encaixar — em vez de clicar-arrastar-soltar, que competia
// com o próprio arrastar do OrbitControls e fazia a câmera girar sem querer
// no meio da tentativa de pegar uma conta.
//
// Protótipo do item de IA+RA: como a WebXR Device API não expõe de forma
// portátil o frame bruto da câmera de passagem durante uma sessão
// immersive-ar (não dá pra "fotografar de dentro da RA" num Quest/celular de
// forma confiável), simulamos aqui a ideia — "aponta a câmera pro quadro real
// e ele vira continhas Hama na mesa" — com fotos penduradas na parede no
// lugar de objetos reais. Clicar numa foto dispara o MESMO pipeline de IA
// (k-means/paleta Hama) que já existe pra fotos enviadas por upload
// (pattern.js), só que a partir de uma imagem "vista" na sala em vez de um
// arquivo — e já simplificado (grade pequena, paleta Hama fixa), sem sliders.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createBeadGeometry } from './bead-geometry.js';
import { playPickup, playCorrect, playWrong, playComplete } from './sound.js';
import { computePattern } from './pattern.js';
import { SAMPLE_PHOTOS, makeSamplePhotoCanvas } from './sample-photos.js';

const BOARD_TARGET_WIDTH = 0.5; // metros — largura do quadro sobre a mesa
const TABLE_TOP_Y = 0.75; // altura da superfície da mesa
let captureGrid = 16; // grade da conversão automática — ajustável pela barra lateral (captureResHud)
let lastCapturedEntry = null; // última foto da parede convertida — permite recalcular ao vivo
let liveResizeTimer = null;

// Muda a resolução e, se o desenho que já está na mesa veio de uma foto
// capturada (não é um nível fixo do desafio), refaz a conversão com a grade
// nova — sem isso a barra só valeria pra próxima foto clicada, e o quadro
// que já estava montado ficava do jeito antigo, parecendo que o ajuste não
// fazia nada. O recálculo é "debounced" (só roda ~120ms depois de parar de
// mexer): em grades grandes (até 40×40) reconstruir o quadro a cada pixel
// arrastado na barra travaria a tela.
export function setCaptureResolution(n) {
  captureGrid = Math.max(8, Math.min(40, Math.round(n)));
  if (!lastCapturedEntry) return;
  clearTimeout(liveResizeTimer);
  liveResizeTimer = setTimeout(() => captureFromPhoto(lastCapturedEntry), 120);
}

export function getCaptureResolution() {
  return captureGrid;
}

let renderer, scene, camera, controls;
let container = null;
let resizeHandler = null;
let rafId = null;
let running = false;

let boardGroup = null;
let pattern = null;
let cellSize = 0.04;
let cellMeshes = []; // { ghost, bead, filled, correct, target, px, pz }
let paletteSpheres = []; // { mesh, legendIdx, entry }
let completed = false;

let selectedLegendIdx = null;
let selectedTrayMesh = null;
let previewBeadMesh = null;
let pickPlane = null;
let highlightedCells = []; // furos que aceitam a cor selecionada agora
let painting = false; // true enquanto o botão está pressionado e arrastando sobre o quadro, pintando furos compatíveis

let deselectBeadMesh = null; // grupo 3D da "conta" de soltar cor, primeira na bandeja

let wallPhotos = []; // { picture, source, label, isUploadSlot? }
let capturing = false; // trava novo clique de captura enquanto uma já está em andamento
let fileInputEl = null; // <input type="file"> real, oculto, usado pelo quadro "sua foto"

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

let callbacks = { onProgress: () => {}, onExit: () => {}, onHint: () => {} };

// Checagem só de API (sem criar contexto WebGL de verdade) — logo após o
// carregamento da página, criar um contexto pode falhar transitoriamente
// enquanto o processo de GPU do navegador ainda está de pé, o que deixava o
// botão nascendo desabilitado por corrida de tempo.
export function isRoomSupported() {
  return typeof window.WebGLRenderingContext !== 'undefined';
}

export async function startRoom(patternData, cbs, containerEl) {
  pattern = patternData;
  callbacks = { ...callbacks, ...cbs };
  container = containerEl;
  cellMeshes = [];
  paletteSpheres = [];
  wallPhotos = [];
  deselectBeadMesh = null;
  capturing = false;
  lastCapturedEntry = null;
  clearTimeout(liveResizeTimer);
  completed = false;
  selectedLegendIdx = null;
  selectedTrayMesh = null;
  previewBeadMesh = null;
  highlightedCells = [];
  painting = false;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.domElement.style.position = 'fixed';
  renderer.domElement.style.inset = '0';
  renderer.domElement.style.zIndex = '0';
  renderer.domElement.style.touchAction = 'none';
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdfe6f0);

  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 30);
  camera.position.set(0, TABLE_TOP_Y + 1.2, 1.9);

  buildLights();
  buildRoom();
  await buildWallPhotos();
  buildTable();
  buildBoard();
  buildPalette();

  const target = new THREE.Vector3(0, TABLE_TOP_Y + 0.05, 0);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 1.1;
  controls.maxDistance = 3.2;
  controls.minPolarAngle = Math.PI * 0.18;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.update();

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  fileInputEl = document.createElement('input');
  fileInputEl.type = 'file';
  fileInputEl.accept = 'image/*';
  fileInputEl.style.display = 'none';
  fileInputEl.addEventListener('change', onFileChosen);
  document.body.appendChild(fileInputEl);

  resizeHandler = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resizeHandler);

  callbacks.onHint(`Nível "${pattern.name}". Clica numa continha da mesa pra escolher a cor (os furos compatíveis brilham) e clica ou arrasta sobre os furos pra encaixar em sequência, tipo um balde de tinta — clica noutra continha pra trocar de cor. Não sabe qual cor vai num furo? Clica direto nele sem cor nenhuma selecionada, que ele descobre e já encaixa. 📸 Ou clica numa foto na parede pra "fotografar" ela e virar continhas na mesa (protótipo de IA) — o último quadro, tracejado, deixa escolher uma foto sua.`);
  reportProgress();

  running = true;
  const loop = () => {
    if (!running) return;
    controls.update();
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function makeCheckerTexture() {
  const size = 256;
  const squares = 8;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const cx = c.getContext('2d');
  const step = size / squares;
  for (let y = 0; y < squares; y++) {
    for (let x = 0; x < squares; x++) {
      cx.fillStyle = (x + y) % 2 === 0 ? '#eef1f6' : '#d7dce4';
      cx.fillRect(x * step, y * step, step, step);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildLights() {
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8bfc9, 1.4));
  const dir = new THREE.DirectionalLight(0xffffff, 1.3);
  dir.position.set(1.5, 3, 1.2);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  dir.shadow.camera.left = -2; dir.shadow.camera.right = 2;
  dir.shadow.camera.top = 2; dir.shadow.camera.bottom = -2;
  scene.add(dir);

  const lamp = new THREE.PointLight(0xfff3d6, 0.9, 7, 2);
  lamp.position.set(0, 2.3, 0.3);
  scene.add(lamp);

  const fill = new THREE.PointLight(0xffffff, 0.5, 7, 2);
  fill.position.set(-1.5, 1.8, 1.8);
  scene.add(fill);
}

function buildRoom() {
  const W = 5, H = 2.8, D = 5;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf3f0e9, roughness: 0.95 });
  const floorMat = new THREE.MeshStandardMaterial({ map: makeCheckerTexture(), roughness: 0.9 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0xfbfbf9, roughness: 1 });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, D), ceilMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = H;
  scene.add(ceiling);

  const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat);
  back.position.set(0, H / 2, -D / 2);
  back.receiveShadow = true;
  scene.add(back);

  const front = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat);
  front.position.set(0, H / 2, D / 2);
  front.rotation.y = Math.PI;
  scene.add(front);

  const left = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wallMat);
  left.position.set(-W / 2, H / 2, 0);
  left.rotation.y = Math.PI / 2;
  left.receiveShadow = true;
  scene.add(left);

  const right = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wallMat);
  right.position.set(W / 2, H / 2, 0);
  right.rotation.y = -Math.PI / 2;
  right.receiveShadow = true;
  scene.add(right);
}

// Fotos reais (arquivos de verdade, não desenhadas por código) pra pendurar
// junto das procedurais — só entram aqui imagens sem problema de direito
// autoral/marca registrada (paisagem genérica). Logos e personagens que
// apareceram na pasta /imagem foram propositalmente deixados de fora.
const REAL_PHOTOS = [
  { label: 'Paisagem', src: 'imagem/paisagem-natural-og.webp' },
];

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
    img.src = src;
  });
}

// Textura do quadro vazio "adiciona sua foto" — moldura tracejada com um "+",
// pra distinguir visualmente dos quadros já com foto.
function makeUploadSlotTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const cx = c.getContext('2d');
  cx.fillStyle = '#2a2e37';
  cx.fillRect(0, 0, size, size);

  cx.strokeStyle = '#8a9099';
  cx.lineWidth = size * 0.025;
  cx.setLineDash([size * 0.05, size * 0.04]);
  cx.strokeRect(size * 0.08, size * 0.08, size * 0.84, size * 0.84);
  cx.setLineDash([]);

  cx.strokeStyle = '#f9c74f';
  cx.lineWidth = size * 0.06;
  cx.lineCap = 'round';
  cx.beginPath();
  cx.moveTo(size * 0.5, size * 0.32);
  cx.lineTo(size * 0.5, size * 0.56);
  cx.moveTo(size * 0.38, size * 0.44);
  cx.lineTo(size * 0.62, size * 0.44);
  cx.stroke();

  cx.fillStyle = '#f4f1ea';
  cx.font = `bold ${Math.round(size * 0.085)}px sans-serif`;
  cx.textAlign = 'center';
  cx.fillText('sua foto', size / 2, size * 0.76);

  return new THREE.CanvasTexture(c);
}

// Pendura as fotos-amostra na parede do fundo (mesmo esquema visual de
// quadro/moldura de antes), guardando a fonte original de cada uma (canvas
// pras procedurais, <img> pras reais) — clicar numa foto passa essa fonte
// pro computePattern (pattern.js), o mesmo pipeline de IA (paleta Hama por
// distância de cor) usado no upload.
async function buildWallPhotos() {
  const D = 5;
  const size = 0.5, gap = 0.15;

  const procedural = SAMPLE_PHOTOS.map((s) => ({ label: s.label, source: makeSamplePhotoCanvas(s.draw) }));
  let real = [];
  try {
    real = await Promise.all(REAL_PHOTOS.map(async (p) => ({ label: p.label, source: await loadImage(p.src) })));
  } catch (e) {
    console.warn('Não consegui carregar uma foto real da parede:', e);
  }
  // Último quadro da fileira é sempre o slot vazio "adiciona sua foto" — sem
  // `source` ainda (só ganha um quando o usuário escolhe um arquivo).
  const allPhotos = [...procedural, ...real, { label: 'Sua foto', source: null, isUploadSlot: true }];

  const n = allPhotos.length;
  const rowWidth = n * size + (n - 1) * gap;
  const startX = -rowWidth / 2 + size / 2;
  const wallZ = -D / 2;
  const y = 1.8;

  wallPhotos = allPhotos.map((entry, idx) => {
    const x = startX + idx * (size + gap);

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(size + 0.05, size + 0.05, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x3a2a1f, roughness: 0.6 }),
    );
    frame.position.set(x, y, wallZ + 0.011);
    frame.castShadow = true;
    scene.add(frame);

    const tex = entry.isUploadSlot ? makeUploadSlotTexture() : new THREE.Texture(entry.source);
    if (!entry.isUploadSlot) tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    const picture = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: tex }),
    );
    picture.position.set(x, y, wallZ + 0.022);
    scene.add(picture);

    return { picture, source: entry.source, label: entry.label, isUploadSlot: entry.isUploadSlot };
  });
}

// O "clique de câmera": roda o mesmo pipeline de IA usado no upload de foto
// (computePattern, k-means/paleta Hama) em cima da fonte da foto da parede,
// numa grade pequena de propósito ("melhor resolução com menos pontos" =
// simplifica automaticamente, sem sliders) — e troca o desenho da mesa pro
// resultado, sem sair da sala.
function captureFromPhoto(entry) {
  if (capturing) return;
  capturing = true;
  callbacks.onHint(`📸 Fotografando "${entry.label}"...`);

  const srcW = entry.source.naturalWidth || entry.source.width;
  const srcH = entry.source.naturalHeight || entry.source.height;
  const captured = computePattern(entry.source, { x: 0, y: 0, w: srcW, h: srcH }, 1, {
    w: captureGrid,
    h: captureGrid,
    paletteMode: 'hama',
    colorsCount: 8,
    simplifyTolerance: 0,
  });
  captured.name = `Foto: ${entry.label}`;

  pattern = captured;
  lastCapturedEntry = entry;
  completed = false;
  clearSelection();
  buildBoard();
  buildPalette();
  callbacks.onHint(`Convertido! "${captured.name}" — ${captured.totalBeads} contas, ${captured.legend.length} cores. Clica numa continha da mesa pra montar.`);
  reportProgress();
  capturing = false;
}

// Abre o seletor de arquivo nativo do navegador (galeria/arquivos do
// aparelho) — chamado só a partir de um clique de verdade (dentro de
// onPointerDown), que é exatamente o gesto do usuário que a Picker API
// exige pra abrir sem ser bloqueada.
function openFilePicker() {
  fileInputEl?.click();
}

// Depois que o usuário escolhe uma foto de verdade: carrega, pendura no
// quadro "sua foto" (photo vira permanente ali pro resto da sessão, clicável
// de novo depois) e já converte na hora — mesmo pipeline de IA das outras.
async function onFileChosen(evt) {
  const file = evt.target.files[0];
  if (fileInputEl) fileInputEl.value = ''; // permite escolher o mesmo arquivo de novo depois
  if (!file || !file.type.startsWith('image/')) return;

  const slot = wallPhotos.find((p) => p.isUploadSlot);
  if (!slot) return;

  callbacks.onHint('Carregando sua foto...');
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    slot.source = img;
    slot.label = file.name.replace(/\.[a-z0-9]+$/i, '') || 'Sua foto';

    const tex = new THREE.Texture(img);
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    slot.picture.material.map = tex;
    slot.picture.material.needsUpdate = true;

    captureFromPhoto(slot);
  } catch (e) {
    console.warn('Falha ao carregar foto do usuário:', e);
    callbacks.onHint('Não consegui abrir essa imagem — tenta outra.');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function buildTable() {
  const topMat = new THREE.MeshStandardMaterial({ color: 0x6b4a35, roughness: 0.6 });
  const legMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1f, roughness: 0.7 });

  const top = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 1.05), topMat);
  top.position.y = TABLE_TOP_Y - 0.025;
  top.castShadow = true;
  top.receiveShadow = true;
  scene.add(top);

  const legGeo = new THREE.BoxGeometry(0.06, TABLE_TOP_Y - 0.05, 0.06);
  const offsets = [
    [0.68, 0.45], [-0.68, 0.45], [0.68, -0.45], [-0.68, -0.45],
  ];
  for (const [x, z] of offsets) {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(x, (TABLE_TOP_Y - 0.05) / 2, z);
    leg.castShadow = true;
    scene.add(leg);
  }
}

function buildBoard() {
  if (boardGroup) scene.remove(boardGroup);

  const { w, h, cells } = pattern;
  cellSize = BOARD_TARGET_WIDTH / w;
  const boardW = w * cellSize;
  const boardH = h * cellSize;

  boardGroup = new THREE.Group();
  boardGroup.position.set(0, TABLE_TOP_Y, -boardH * 0.35);
  scene.add(boardGroup);

  const backing = new THREE.Mesh(
    new THREE.BoxGeometry(boardW + cellSize * 0.4, 0.006, boardH + cellSize * 0.4),
    new THREE.MeshStandardMaterial({ color: 0x16191d, roughness: 0.9 }),
  );
  backing.position.set(0, -0.003, 0);
  backing.receiveShadow = true;
  boardGroup.add(backing);

  const ghostGeo = new THREE.CircleGeometry(cellSize * 0.46, 24).rotateX(-Math.PI / 2);
  const beadGeo = createBeadGeometry(cellSize * 0.38);

  cellMeshes = new Array(w * h).fill(null);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const target = cells[y * w + x];
      if (!target) continue;

      const px = (x - w / 2 + 0.5) * cellSize;
      const pz = (y - h / 2 + 0.5) * cellSize;

      const targetColor = new THREE.Color(target.r / 255, target.g / 255, target.b / 255);
      const ghost = new THREE.Mesh(ghostGeo, new THREE.MeshBasicMaterial({
        color: targetColor, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false,
      }));
      ghost.position.set(px, 0.001, pz);
      boardGroup.add(ghost);

      const bead = new THREE.Mesh(beadGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 }));
      bead.position.set(px, cellSize * 0.4, pz);
      bead.visible = false;
      bead.castShadow = true;
      boardGroup.add(bead);

      cellMeshes[y * w + x] = { ghost, bead, filled: false, correct: false, target, px, pz };
    }
  }

  pickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(TABLE_TOP_Y + cellSize * 0.5));
}

// Textura da "conta de soltar cor": um furo/bolinha neutra com o símbolo
// universal de proibido desenhado em cima — pintada plana (igual às fotos da
// parede e aos furos-fantasma), pra ficar legível de qualquer ângulo da
// câmera orbital sem depender de acertar a orientação de uma peça 3D.
function makeForbiddenBeadTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const cx = c.getContext('2d');
  const r = size * 0.42;

  const grad = cx.createRadialGradient(size * 0.38, size * 0.32, r * 0.15, size / 2, size / 2, r);
  grad.addColorStop(0, '#f4f1ea');
  grad.addColorStop(1, '#8a9099');
  cx.fillStyle = grad;
  cx.beginPath();
  cx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
  cx.fill();

  cx.strokeStyle = '#e5342f';
  cx.lineWidth = size * 0.1;
  cx.beginPath();
  cx.arc(size / 2, size / 2, r * 0.92, 0, Math.PI * 2);
  cx.stroke();
  cx.beginPath();
  cx.moveTo(size * 0.22, size * 0.22);
  cx.lineTo(size * 0.78, size * 0.78);
  cx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A "conta de soltar cor": uma conta neutra normal (mesmo tamanho e altura
// das outras, pra ficar visualmente na mesma fileira) com um disco fino do
// símbolo de proibido grudado em cima, voltado pra câmera de cima. Sempre a
// primeira da bandeja — clicar nela larga a cor selecionada, igual clicar de
// novo na própria continha já fazia, só que num lugar fixo e óbvio.
function buildDeselectBead(x, y, z, beadGeo) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const bead = new THREE.Mesh(beadGeo, new THREE.MeshStandardMaterial({ color: 0xb8bfc9, roughness: 0.4 }));
  bead.position.y = y;
  bead.castShadow = true;
  group.add(bead);

  const decal = new THREE.Mesh(
    new THREE.CircleGeometry(cellSize * 0.46, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: makeForbiddenBeadTexture() }),
  );
  decal.position.y = y + cellSize * 0.5;
  group.add(decal);

  boardGroup.add(group);
  return group;
}

function buildPalette() {
  const { w, h, legend } = pattern;
  const boardH = h * cellSize;
  const n = legend.length;
  const totalSlots = n + 1; // +1 pela conta de soltar cor, sempre a primeira
  const spacing = Math.min(cellSize * 1.8, 0.85 / Math.max(totalSlots - 1, 1));
  const rowWidth = (totalSlots - 1) * spacing;
  const rowZ = boardH / 2 + cellSize * 2.2;
  const startX = -rowWidth / 2;

  const beadGeo = createBeadGeometry(cellSize * 0.44);

  deselectBeadMesh = buildDeselectBead(startX, cellSize * 0.4, rowZ, beadGeo);

  paletteSpheres = legend.map((entry, idx) => {
    const color = new THREE.Color(entry.r / 255, entry.g / 255, entry.b / 255);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.3 });
    const mesh = new THREE.Mesh(beadGeo, mat);
    mesh.position.set(startX + (idx + 1) * spacing, cellSize * 0.4, rowZ);
    mesh.castShadow = true;
    boardGroup.add(mesh);
    return { mesh, legendIdx: idx, entry, baseY: cellSize * 0.4, exhausted: false };
  });
}

function pointerToNdc(evt) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((evt.clientY - rect.top) / rect.height) * 2 + 1;
}

// Clique único (sem arrastar) em cada alvo possível, nessa ordem de
// prioridade: foto na parede (captura por IA) > continha da bandeja > furo do
// quadro. Clicar em qualquer outro lugar (mesa, chão, parede vazia) não faz
// nada aqui — sobra pro OrbitControls tratar como início de giro de câmera.
//
// Trava o orbit assim que o clique começa em cima de QUALQUER um desses
// alvos (não só se ele "acerta" o clique certinho) — sem isso, se a mão
// tremer um pixel durante o clique numa conta pequena, o OrbitControls lê
// aquilo como início de arrasto e a mesa/câmera gira junto, atrapalhando a
// mira. Só solta o orbit de novo quando o botão do mouse é solto.
function onPointerDown(evt) {
  pointerToNdc(evt);
  raycaster.setFromCamera(pointerNdc, camera);

  const photoHits = raycaster.intersectObjects(wallPhotos.map((p) => p.picture));
  if (photoHits.length > 0) {
    controls.enabled = false;
    const entry = wallPhotos.find((p) => p.picture === photoHits[0].object);
    if (entry.isUploadSlot) openFilePicker();
    else captureFromPhoto(entry);
    return;
  }

  if (deselectBeadMesh) {
    const deselectHits = raycaster.intersectObject(deselectBeadMesh, true);
    if (deselectHits.length > 0) {
      controls.enabled = false;
      dropSelectedColor();
      return;
    }
  }

  const trayHits = raycaster.intersectObjects(paletteSpheres.map((p) => p.mesh));
  if (trayHits.length > 0) {
    const picked = paletteSpheres.find((p) => p.mesh === trayHits[0].object);
    if (picked.exhausted) return; // cor sem furo nenhum sobrando — não seleciona
    controls.enabled = false;
    selectColor(picked === getSelectedTray() ? null : picked);
    // Não solta o botão: dá pra continuar arrastando pro quadro sem soltar,
    // pintando os furos compatíveis assim que o mouse passa por cima.
    painting = selectedLegendIdx !== null;
    return;
  }

  const cellHits = raycaster.intersectObjects(cellMeshes.filter(Boolean).map((c) => c.ghost));
  if (cellHits.length > 0) {
    const cell = cellMeshes.find((c) => c && c.ghost === cellHits[0].object);
    if (cell && !cell.filled) {
      controls.enabled = false;
      painting = true; // segurando e arrastando a partir daqui pinta cada furo compatível que o mouse passar

      if (selectedLegendIdx === null) {
        // "Qual cor vai aqui?" — sem nenhuma cor na mão, clicar num furo vazio
        // descobre e já seleciona a cor certa pra ELE (acende na bandeja),
        // encaixa ali na hora, e deixa selecionada pra continuar pintando os
        // outros furos da mesma cor em seguida — ajuda quando não dá pra
        // saber de cabeça qual cor da paleta Hama é aquela.
        const needed = paletteSpheres.find((p) => p.entry.name === cell.target.name);
        if (needed) {
          selectColor(needed);
          fillCell(cell, needed.legendIdx);
          callbacks.onHint(`Esse furo era "${needed.entry.name}" — já encaixei! A cor ficou selecionada (acesa na bandeja) pra continuar nos outros furos iguais.`);
        }
      } else {
        fillCell(cell, selectedLegendIdx);
        // Não limpa a seleção — "modo balde de tinta": a cor continua na mão
        // pra encaixar em quantos furos compatíveis quiser em sequência, até
        // clicar noutra continha (troca de cor) ou na mesma (desmarca).
      }
    }
  }
}

// Reativa o orbit quando o botão é solto, não importa onde — cobre tanto um
// clique certeiro quanto um clique que começou numa conta/furo e "escorregou"
// enquanto pressionado.
function onPointerUp() {
  if (controls) controls.enabled = true;
  painting = false;
}

function getSelectedTray() {
  return paletteSpheres.find((p) => p.mesh === selectedTrayMesh) || null;
}

// Destaca a continha escolhida (aumenta um pouco) e mostra uma prévia dela
// flutuando sobre a mesa, que segue o mouse livremente — sem nenhum botão
// pressionado, então nunca disputa com o arrastar do OrbitControls. Também
// acende os furos que aceitam essa cor (brilho + leve zoom), pra ajudar a
// mirar em vez de deixar todos os furos com a mesma aparência apagada.
function selectColor(picked) {
  if (selectedTrayMesh) selectedTrayMesh.scale.setScalar(1);

  if (!picked) {
    clearSelection();
    return;
  }

  selectedLegendIdx = picked.legendIdx;
  selectedTrayMesh = picked.mesh;
  picked.mesh.scale.setScalar(1.3);
  playPickup();

  if (!previewBeadMesh) {
    const geo = createBeadGeometry(cellSize * 0.42);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    previewBeadMesh = new THREE.Mesh(geo, mat);
    previewBeadMesh.castShadow = true;
    scene.add(previewBeadMesh);
  }
  previewBeadMesh.material.color.copy(picked.mesh.material.color);
  previewBeadMesh.position.copy(picked.mesh.getWorldPosition(new THREE.Vector3()));
  previewBeadMesh.visible = true;

  highlightMatchingCells(picked.entry.name);
  callbacks.onHint(`Cor selecionada: ${picked.entry.name} — os furos brilhando aceitam essa cor. Clica em quantos quiser em sequência; clica noutra continha pra trocar de cor.`);
}

function highlightMatchingCells(colorName) {
  clearCellHighlight();
  highlightedCells = cellMeshes.filter((c) => c && !c.filled && c.target.name === colorName);
  for (const cell of highlightedCells) {
    cell.ghost.material.opacity = 0.9;
    cell.ghost.scale.setScalar(1.18);
  }
}

function clearCellHighlight() {
  for (const cell of highlightedCells) {
    cell.ghost.scale.setScalar(1); // sempre desfaz o zoom, mesmo se acabou de ser encaixada
    if (cell.filled) continue; // já foi encaixada enquanto brilhava — deixa o verde de "correto" como está
    cell.ghost.material.opacity = 0.4;
  }
  highlightedCells = [];
}

function clearSelection() {
  if (selectedTrayMesh) selectedTrayMesh.scale.setScalar(1);
  selectedTrayMesh = null;
  selectedLegendIdx = null;
  if (previewBeadMesh) previewBeadMesh.visible = false;
  clearCellHighlight();
}

// Clicar na conta de "proibido" da bandeja larga a cor selecionada — clicar
// de novo na própria continha já fazia isso, mas nem sempre é óbvio; essa é
// uma forma explícita e sempre no mesmo lugar (primeira da fileira).
export function dropSelectedColor() {
  if (selectedLegendIdx === null) return;
  clearSelection();
  callbacks.onHint('Cor solta. Clica numa continha da mesa pra escolher outra.');
}

// Atualiza a prévia da conta (roda mesmo sem botão pressionado — não
// interfere no orbit) e, se estiver "pintando" (botão pressionado desde uma
// conta/furo), encaixa em silêncio cada furo compatível que o mouse for
// passando por cima, tipo pincel de balde de tinta arrastado. Furos que não
// combinam com a cor são só ignorados aqui — sem flash vermelho nem bipe de
// erro a cada um, que ficaria irritante numa arrastada rápida pelo quadro
// (o clique avulso em fillCell continua dando esse aviso normalmente).
function onPointerMove(evt) {
  if (selectedLegendIdx === null) return;
  pointerToNdc(evt);
  raycaster.setFromCamera(pointerNdc, camera);

  if (painting) {
    const cellHits = raycaster.intersectObjects(cellMeshes.filter(Boolean).map((c) => c.ghost));
    if (cellHits.length > 0) {
      const cell = cellMeshes.find((c) => c && c.ghost === cellHits[0].object);
      const entry = pattern.legend[selectedLegendIdx];
      if (cell && !cell.filled && cell.target.name === entry.name) {
        fillCell(cell, selectedLegendIdx);
      }
    }
  }

  if (!previewBeadMesh) return;
  const point = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(pickPlane, point)) {
    previewBeadMesh.position.copy(point);
  }
}

function fillCell(cell, legendIdx) {
  const entry = pattern.legend[legendIdx];
  if (entry.name !== cell.target.name) {
    flashReject(cell);
    playWrong();
    return;
  }
  if (cell.filled) return;
  cell.filled = true;
  cell.correct = true;
  cell.bead.visible = true;
  cell.bead.material.color.setRGB(entry.r / 255, entry.g / 255, entry.b / 255);
  cell.ghost.material.color.set(0x4ade80);
  cell.ghost.material.opacity = 0.85;
  playCorrect();
  checkColorExhausted(legendIdx);
  reportProgress();
}

// Quando não sobra nenhum furo vazio daquela cor, a continha correspondente
// na bandeja "esgota": apaga (fica translúcida), não dá mais pra selecionar,
// e se estava selecionada nesse instante, solta sozinha — sem isso dava pra
// ficar com uma cor na mão sem lugar nenhum onde encaixar.
function checkColorExhausted(legendIdx) {
  const entry = pattern.legend[legendIdx];
  const stillMissing = cellMeshes.some((c) => c && !c.filled && c.target.name === entry.name);
  if (stillMissing) return;

  const traySlot = paletteSpheres.find((p) => p.legendIdx === legendIdx);
  if (traySlot && !traySlot.exhausted) {
    traySlot.exhausted = true;
    traySlot.mesh.material.transparent = true;
    traySlot.mesh.material.opacity = 0.25;
  }

  if (selectedLegendIdx === legendIdx) {
    clearSelection();
    callbacks.onHint(`Já colocou toda a cor "${entry.name}" — escolhe outra continha.`);
  }
}

function flashReject(cell) {
  const originalColor = cell.ghost.material.color.clone();
  const originalOpacity = cell.ghost.material.opacity;
  cell.ghost.material.color.set(0xf87171);
  cell.ghost.material.opacity = 0.85;
  setTimeout(() => {
    if (cell.filled) return;
    cell.ghost.material.color.copy(originalColor);
    cell.ghost.material.opacity = originalOpacity;
  }, 350);
}

function reportProgress() {
  let placed = 0, correct = 0, total = 0;
  for (const cell of cellMeshes) {
    if (!cell) continue;
    total++;
    if (cell.filled) placed++;
    if (cell.correct) correct++;
  }
  callbacks.onProgress(placed, correct, total, pattern?.name);
  if (!completed && total > 0 && correct === total) {
    completed = true;
    playComplete();
    callbacks.onPatternCompleted?.(pattern);
  }
}

export function exitRoom() {
  running = false;
  if (rafId !== null) cancelAnimationFrame(rafId);
  if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
  if (renderer) {
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
  }
  window.removeEventListener('pointerup', onPointerUp);
  controls?.dispose();
  controls = null;
  if (renderer?.domElement?.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement);
  renderer?.dispose();
  renderer = null;
  scene = null;
  camera = null;
  boardGroup = null;
  previewBeadMesh = null;
  selectedTrayMesh = null;
  selectedLegendIdx = null;
  wallPhotos = [];
  deselectBeadMesh = null;
  lastCapturedEntry = null;
  clearTimeout(liveResizeTimer);
  painting = false;
  if (fileInputEl) {
    fileInputEl.removeEventListener('change', onFileChosen);
    fileInputEl.remove();
    fileInputEl = null;
  }
  callbacks.onExit();
}
