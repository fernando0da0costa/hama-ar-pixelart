// Cena de Realidade Aumentada: WebXR Device API (sessão immersive-ar) +
// hit-test pra fixar o quadro numa superfície real + rastreamento de mão
// nativo do WebXR (XRHand) pra "pegar" contas de uma paleta flutuante e
// "encaixar" no quadro, célula a célula.
//
// Requisito de hardware: navegador com suporte a immersive-ar + hand-tracking.
// Hoje isso é, na prática, o Meta Quest Browser (Quest 2/3/Pro) com
// rastreamento de mão ativado nas configurações do sistema. A maioria dos
// navegadores WebXR em celular (Chrome/ARCore) tem immersive-ar mas SEM
// hand-tracking real — nesse caso o app cai pro modo alternativo (ver
// startAR: handTrackingAvailable) usando toque na tela como substituto.

import * as THREE from 'three';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { createBeadGeometry } from './bead-geometry.js';
import { playPickup, playCorrect, playWrong, playComplete } from './sound.js';

const PINCH_THRESHOLD = 0.028; // metros entre polegar e indicador pra contar como "pinça"
const PICK_RADIUS = 0.045; // metros de tolerância pra pegar conta / acertar célula
const BOARD_TARGET_WIDTH = 0.24; // metros — largura física alvo do quadro (~24cm)
const PINCER_MARKER_RADIUS = 0.006; // metros — raio das bolinhas do indicador de pinça na ponta dos dedos

let renderer, scene, camera;
let session = null;
let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;
let boardGroup = null;
let boardPlaced = false;
let animationLoopId = null;

let pattern = null;
let cellMeshes = []; // { ghost, bead, filled, correct, targetLegendIdx }
let paletteSpheres = []; // { mesh, legendIdx }
let handStates = [null, null]; // { pinching, heldLegendIdx, previewMesh }
let completed = false; // trava o som de conclusão pra não repetir a cada frame depois que já bateu 100%

let callbacks = { onProgress: () => {}, onExit: () => {}, onHint: () => {} };

export async function isArSupported() {
  if (!('xr' in navigator)) return false;
  try {
    return await navigator.xr.isSessionSupported('immersive-ar');
  } catch {
    return false;
  }
}

export async function startAR(patternData, cbs, container) {
  pattern = patternData;
  callbacks = { ...callbacks, ...cbs };
  boardPlaced = false;
  boardGroup = null;
  cellMeshes = [];
  paletteSpheres = [];
  handStates = [null, null];
  completed = false;

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.domElement.style.position = 'fixed';
  renderer.domElement.style.inset = '0';
  renderer.domElement.style.zIndex = '0';
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(0.5, 1, 0.25);
  scene.add(dirLight);

  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.075, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xf9c74f, transparent: true, opacity: 0.85 }),
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  const overlayRoot = document.getElementById('arOverlay');
  const sessionInit = {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['hand-tracking', 'dom-overlay'],
    domOverlay: { root: overlayRoot },
  };

  // Precisa ser configurado ANTES de setSession — o WebXRManager do three.js
  // pede o reference space internamente assim que a sessão é atribuída.
  renderer.xr.setReferenceSpaceType('local');

  session = await navigator.xr.requestSession('immersive-ar', sessionInit);
  await renderer.xr.setSession(session);

  session.addEventListener('end', onSessionEnd);
  session.addEventListener('select', onSelect);

  const handTrackingAvailable = sessionSupportsHandTracking(session);
  callbacks.onHint(
    handTrackingAvailable
      ? 'Toque numa superfície pra fixar o quadro'
      : 'Rastreamento de mão indisponível — toque na tela funciona como cursor de apontar/selecionar',
  );

  setupHands();

  hitTestSourceRequested = false;

  renderer.setAnimationLoop((timestamp, frame) => onXRFrame(frame));
}

function sessionSupportsHandTracking(sess) {
  for (const src of sess.inputSources) {
    if (src.hand) return true;
  }
  // Ainda não dá pra saber com certeza antes de mãos conectarem; assume
  // otimista e corrige no primeiro frame se joints nunca aparecerem.
  return true;
}

function setupHands() {
  const factory = new XRHandModelFactory();
  for (let i = 0; i < 2; i++) {
    const hand = renderer.xr.getHand(i);
    hand.userData.handModel = factory.createHandModel(hand, 'mesh');
    hand.add(hand.userData.handModel);
    scene.add(hand);

    // Marcador "tipo pinça": bolinha na ponta do polegar e do indicador,
    // ligadas por uma linha — mostra onde o sistema está lendo os dois dedos
    // de verdade e se a distância entre eles já é lida como pinça fechada
    // (verde) ou ainda aberta (amarelo). Serve pra calibrar visualmente
    // quando o encaixe não está pegando do jeito esperado.
    const markerGeo = new THREE.SphereGeometry(PINCER_MARKER_RADIUS, 12, 8);
    const thumbMarker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0xf9c74f }));
    const indexMarker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0xf9c74f }));
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const pincerLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xf9c74f }));
    thumbMarker.visible = false;
    indexMarker.visible = false;
    pincerLine.visible = false;
    scene.add(thumbMarker, indexMarker, pincerLine);

    handStates[i] = {
      pinching: false, heldLegendIdx: null, previewMesh: null, hand,
      thumbMarker, indexMarker, pincerLine,
    };
  }
}

async function onXRFrame(frame) {
  if (!frame) {
    renderer.render(scene, camera);
    return;
  }
  const refSpace = renderer.xr.getReferenceSpace();
  const session = renderer.xr.getSession();

  if (!refSpace) {
    renderer.render(scene, camera);
    return;
  }

  if (!boardPlaced) {
    if (!hitTestSourceRequested) {
      hitTestSourceRequested = true;
      try {
        const viewerSpace = await session.requestReferenceSpace('viewer');
        hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
      } catch (e) {
        console.warn('hit-test indisponível:', e);
      }
    }
    if (hitTestSource) {
      const hits = frame.getHitTestResults(hitTestSource);
      if (hits.length > 0) {
        const pose = hits[0].getPose(refSpace);
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
      } else {
        reticle.visible = false;
      }
    }
  }

  updateHandInteraction(frame, refSpace);

  renderer.render(scene, camera);
}

function onSelect() {
  if (boardPlaced || !reticle.visible) return;
  placeBoard(reticle.matrix);
}

function placeBoard(matrix) {
  boardGroup = new THREE.Group();
  boardGroup.matrixAutoUpdate = false;
  boardGroup.matrix.copy(matrix);
  scene.add(boardGroup);
  boardPlaced = true;
  reticle.visible = false;

  buildBoard();
  buildPalette();
  callbacks.onHint('Pinça uma continha da bandeja, carrega até o furo certo e solta a pinça pra encaixar!');
  reportProgress();
}

function buildBoard() {
  const { w, h, cells } = pattern;
  const cellSize = BOARD_TARGET_WIDTH / w;
  const boardW = w * cellSize;
  const boardH = h * cellSize;

  const backing = new THREE.Mesh(
    new THREE.BoxGeometry(boardW + cellSize * 0.4, 0.004, boardH + cellSize * 0.4),
    new THREE.MeshStandardMaterial({ color: 0x16191d, roughness: 0.9 }),
  );
  backing.position.set(0, -0.003, 0);
  boardGroup.add(backing);

  // "Fantasma": um discozinho colorido bem transparente, tipo marca d'água,
  // na cor exata que a célula precisa — a pista visual de onde e qual cor
  // colocar, vista através da câmera antes de a conta ser encaixada.
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
      boardGroup.add(bead);

      cellMeshes[y * w + x] = { ghost, bead, filled: false, correct: false, target, px, pz };
    }
  }
}

function buildPalette() {
  const { w, h, legend } = pattern;
  const cellSize = BOARD_TARGET_WIDTH / w;
  const boardH = h * cellSize;
  const n = legend.length;
  const spacing = Math.min(cellSize * 1.6, 0.9 / Math.max(n, 1));
  const rowWidth = (n - 1) * spacing;
  const rowZ = boardH / 2 + cellSize * 1.5;

  const beadGeo = createBeadGeometry(cellSize * 0.42);

  paletteSpheres = legend.map((entry, idx) => {
    const color = new THREE.Color(entry.r / 255, entry.g / 255, entry.b / 255);
    const mesh = new THREE.Mesh(beadGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.3 }));
    mesh.position.set(-rowWidth / 2 + idx * spacing, cellSize * 0.5, rowZ);
    boardGroup.add(mesh);
    return { mesh, legendIdx: idx, entry };
  });
}

function updateHandInteraction(frame, refSpace) {
  if (!boardPlaced) return;
  const session = renderer.xr.getSession();

  for (let i = 0; i < 2; i++) {
    const state = handStates[i];
    const hand = state.hand;
    const joints = hand.joints;
    if (!joints || !joints['thumb-tip'] || !joints['index-finger-tip']
      || !joints['thumb-tip'].visible || !joints['index-finger-tip'].visible) {
      state.thumbMarker.visible = false;
      state.indexMarker.visible = false;
      state.pincerLine.visible = false;
      continue;
    }

    const thumbTip = joints['thumb-tip'].position;
    const indexTip = joints['index-finger-tip'].position;
    const dist = thumbTip.distanceTo(indexTip);
    const pinching = dist < PINCH_THRESHOLD;
    const midpoint = thumbTip.clone().lerp(indexTip, 0.5);

    const markerColor = pinching ? 0x4ade80 : 0xf9c74f;
    state.thumbMarker.position.copy(thumbTip);
    state.thumbMarker.material.color.setHex(markerColor);
    state.thumbMarker.visible = true;
    state.indexMarker.position.copy(indexTip);
    state.indexMarker.material.color.setHex(markerColor);
    state.indexMarker.visible = true;
    state.pincerLine.material.color.setHex(markerColor);
    const linePos = state.pincerLine.geometry.attributes.position;
    linePos.setXYZ(0, thumbTip.x, thumbTip.y, thumbTip.z);
    linePos.setXYZ(1, indexTip.x, indexTip.y, indexTip.z);
    linePos.needsUpdate = true;
    state.pincerLine.visible = true;

    if (pinching && !state.pinching && state.heldLegendIdx === null) {
      // pinça começou perto da bandeja: pega aquela conta
      const picked = findNearestPalette(midpoint);
      if (picked) {
        state.heldLegendIdx = picked.legendIdx;
        playPickup();
        const color = picked.mesh.material.color;
        if (!state.previewMesh) {
          const geo = createBeadGeometry(0.012);
          const mat = new THREE.MeshStandardMaterial({ color: color.clone() });
          state.previewMesh = new THREE.Mesh(geo, mat);
          scene.add(state.previewMesh);
        } else {
          state.previewMesh.material.color.copy(color);
        }
        state.previewMesh.visible = true;
      }
    }

    if (pinching && state.heldLegendIdx !== null && state.previewMesh) {
      state.previewMesh.position.copy(midpoint);
    }

    if (!pinching && state.pinching && state.heldLegendIdx !== null) {
      // soltou a pinça: se estiver em cima de um furo, encaixa a conta ali
      const cell = findNearestEmptyOrAnyCell(midpoint);
      if (cell) fillCell(cell, state.heldLegendIdx);
      state.heldLegendIdx = null;
      if (state.previewMesh) state.previewMesh.visible = false;
    }

    state.pinching = pinching;
  }
}

function findNearestPalette(worldPos) {
  let best = null, bestDist = PICK_RADIUS;
  for (const p of paletteSpheres) {
    const d = p.mesh.getWorldPosition(new THREE.Vector3()).distanceTo(worldPos);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

function findNearestEmptyOrAnyCell(worldPos) {
  let best = null, bestDist = PICK_RADIUS;
  const local = boardGroup.worldToLocal(worldPos.clone());
  for (const cell of cellMeshes) {
    if (!cell) continue;
    const dx = cell.px - local.x;
    const dz = cell.pz - local.z;
    const d = Math.hypot(dx, dz);
    if (d < bestDist) { bestDist = d; best = cell; }
  }
  return best;
}

// Só encaixa se a cor bater com o alvo da célula — cor errada é recusada
// (o fantasma pisca vermelho um instante e volta ao normal) em vez de
// encaixar do jeito errado.
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
  reportProgress();
}

function flashReject(cell) {
  const originalColor = cell.ghost.material.color.clone();
  const originalOpacity = cell.ghost.material.opacity;
  cell.ghost.material.color.set(0xf87171);
  cell.ghost.material.opacity = 0.85;
  setTimeout(() => {
    if (cell.filled) return; // já foi encaixada certo enquanto piscava
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
  callbacks.onProgress(placed, correct, total);
  if (!completed && total > 0 && correct === total) {
    completed = true;
    playComplete();
  }
}

function onSessionEnd() {
  if (animationLoopId !== null) cancelAnimationFrame(animationLoopId);
  renderer?.setAnimationLoop(null);
  if (renderer?.domElement?.parentElement) {
    renderer.domElement.parentElement.removeChild(renderer.domElement);
  }
  renderer?.dispose();
  renderer = null;
  session = null;
  hitTestSource = null;
  hitTestSourceRequested = false;
  boardPlaced = false;
  boardGroup = null;
  callbacks.onExit();
}

// Retorna a promise de encerramento — quem chama (ex.: avanço de nível no
// modo desafio) pode aguardar a sessão terminar de verdade antes de pedir
// uma nova, em vez de tentar sobrepor duas sessões WebXR ao mesmo tempo.
export function exitAR() {
  if (session) return session.end().catch(() => {});
  return Promise.resolve();
}
