// Camada 3D do modo placa física: a partir da homografia folha→imagem
// (marcadores ArUco), estima a pose da câmera e renderiza com three.js uma
// placa perfurada com pinos, as contas Hama (tubinhos com furo), as
// contas-fantasma dos alvos e a bandeja — tudo registrado no plano da folha,
// em perspectiva, com luz e sombra projetada no papel.
//
// Mundo = coordenadas da folha em mm: X para a direita, Y para baixo (no
// papel), Z = X×Y aponta para DENTRO da mesa. "Para cima" é −Z.

import * as THREE from 'three';
import { SHEET_W_MM, SHEET_H_MM } from './board-sheet.js';
import { applyH } from './board-vision.js';

let renderer = null, scene, camera, canvas, root;
let W = 640, H = 480;
let fEst = 0; // distância focal estimada (px), suavizada
let pitch = 10;
let pinObjs = []; // por pino: { peg, ghost, bead }
let trayObjs = []; // { color, bead }
let carryObjs = [];
let beadGeo, pegGeo;
const matCache = new Map();
const ghostCache = new Map();
let pulseMat;
const ray = new THREE.Raycaster();
const liftPlane = new THREE.Plane();

export function init3D(stageEl, beforeEl) {
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; display:block; pointer-events:none;';
  stageEl.insertBefore(canvas, beforeEl);
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, 4 / 3, 10, 5000);
  camera.matrixAutoUpdate = false;
  root = new THREE.Group();
  root.visible = false;
  scene.add(root);

  root.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(SHEET_W_MM * 0.3, SHEET_H_MM * 0.1, -420);
  sun.target.position.set(SHEET_W_MM / 2, SHEET_H_MM / 2, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -180, right: 180, top: 180, bottom: -180, near: 50, far: 900 });
  sun.shadow.bias = -0.0015;
  root.add(sun, sun.target);

  // Recebe a sombra no papel (invisível fora da sombra).
  const shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(SHEET_W_MM, SHEET_H_MM),
    new THREE.ShadowMaterial({ opacity: 0.35 }),
  );
  shadowPlane.rotation.x = Math.PI; // normal para −Z (para cima)
  shadowPlane.position.set(SHEET_W_MM / 2, SHEET_H_MM / 2, -0.1);
  shadowPlane.receiveShadow = true;
  root.add(shadowPlane);

  pulseMat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5, roughness: 0.4, depthWrite: false });
}

// Conta Hama: tubo curto (raio externo 0,47p, furo 0,22p, altura 0,75p) com
// bordas arredondadas; eixo em −Z, base em z = 0.
function makeBeadGeometry(p) {
  const ro = 0.47 * p, ri = 0.22 * p, h = 0.75 * p, b = 0.1 * p;
  const pts = [
    [ri, 0], [ro - b, 0], [ro, b], [ro, h - b], [ro - b, h], [ri + b * 0.5, h], [ri, h - b * 0.5], [ri, b * 0.5], [ri, 0],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(pts, 28);
  g.rotateX(-Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

function colorMat(rgb) {
  const key = rgb.join(',');
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({
      color: new THREE.Color(`rgb(${key})`), roughness: 0.32, metalness: 0.0,
    }));
  }
  return matCache.get(key);
}

function ghostMat(rgb) {
  const key = rgb.join(',');
  if (!ghostCache.has(key)) {
    ghostCache.set(key, new THREE.MeshStandardMaterial({
      color: new THREE.Color(`rgb(${key})`), transparent: true, opacity: 0.32, roughness: 0.5, depthWrite: false,
    }));
  }
  return ghostCache.get(key);
}

function clearGroup(objs) {
  for (const o of objs) for (const m of Object.values(o)) if (m && m.isObject3D) root.remove(m);
}

// Monta a placa, pinos, fantasmas e bandeja para o desenho atual.
// pins: [{ gx, gy, target }]; gridToMat: homografia grade→folha (mm);
// tray: [{ color, mx, my }]; colorOf(name) → [r,g,b].
export function setLayout({ pins, gridToMat, pitchMm, tray, colorOf, showPegboard = true }) {
  if (!renderer) return;
  clearGroup(pinObjs);
  clearGroup(trayObjs);
  clearGroup(carryObjs);
  for (const o of root.children.filter((c) => c.userData.layout)) root.remove(o);
  pitch = pitchMm;
  beadGeo = makeBeadGeometry(pitch);
  pegGeo = new THREE.CylinderGeometry(0.13 * pitch, 0.15 * pitch, 0.55 * pitch, 12);
  pegGeo.rotateX(-Math.PI / 2);
  pegGeo.translate(0, 0, -0.275 * pitch);

  const n = Math.round(Math.sqrt(pins.length));
  const pos = (gx, gy) => applyH(gridToMat, gx, gy);

  if (showPegboard) {
    // Placa perfurada translúcida (cor pérola) sob a área da grade.
    const c0 = pos(-0.6, -0.6), c1 = pos(n - 0.4, -0.6), c3 = pos(-0.6, n - 0.4);
    const w = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]), hgt = Math.hypot(c3[0] - c0[0], c3[1] - c0[1]);
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(w, hgt, 0.12 * pitch),
      new THREE.MeshStandardMaterial({ color: 0xeef3f7, transparent: true, opacity: 0.55, roughness: 0.25 }),
    );
    const mid = pos((n - 1) / 2, (n - 1) / 2);
    plate.position.set(mid[0], mid[1], -0.06 * pitch);
    plate.rotation.z = Math.atan2(c1[1] - c0[1], c1[0] - c0[0]);
    plate.receiveShadow = true;
    plate.userData.layout = true;
    root.add(plate);
  }
  const pegMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ec, transparent: true, opacity: 0.85, roughness: 0.3 });

  pinObjs = pins.map((p) => {
    const [x, y] = pos(p.gx, p.gy);
    const o = {};
    if (showPegboard) {
      o.peg = new THREE.Mesh(pegGeo, pegMat);
      o.peg.position.set(x, y, -0.12 * pitch);
      o.peg.castShadow = true;
      root.add(o.peg);
    }
    if (p.target) {
      o.ghost = new THREE.Mesh(beadGeo, ghostMat(colorOf(p.target)));
      o.ghost.position.set(x, y, -0.12 * pitch);
      o.ghost.userData.rgb = colorOf(p.target);
      root.add(o.ghost);
    }
    o.bead = new THREE.Mesh(beadGeo, colorMat([255, 255, 255]));
    o.bead.position.set(x, y, -0.12 * pitch);
    o.bead.castShadow = true;
    o.bead.visible = false;
    root.add(o.bead);
    return o;
  });

  const dishGeo = new THREE.CylinderGeometry(0.75 * pitch, 0.7 * pitch, 0.15 * pitch, 32);
  dishGeo.rotateX(-Math.PI / 2);
  const dishMat = new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.6 });
  trayObjs = tray.map((t) => {
    const dish = new THREE.Mesh(dishGeo, dishMat);
    dish.position.set(t.mx, t.my, -0.075 * pitch);
    dish.receiveShadow = true;
    const bead = new THREE.Mesh(beadGeo, colorMat(colorOf(t.color)));
    bead.position.set(t.mx, t.my, -0.15 * pitch);
    bead.castShadow = true;
    root.add(dish, bead);
    return { color: t.color, dish, bead };
  });

  carryObjs = [0, 1].map(() => {
    const bead = new THREE.Mesh(beadGeo, colorMat([255, 255, 255]));
    bead.castShadow = true;
    bead.visible = false;
    root.add(bead);
    return { bead };
  });
}

export function resize3D(vw, vh) {
  if (!renderer) return;
  W = vw; H = vh;
  renderer.setSize(vw, vh, false);
  fEst = 0;
}

// Estima f pela ortogonalidade das colunas de H (ponto principal no centro);
// sem estimativa confiável (vista quase frontal), usa ~ câmera de celular.
function estimateFocal(Hc) {
  const [a, b, , d, e, , g, h] = Hc;
  const cands = [];
  const den1 = g * h;
  if (Math.abs(den1) > 1e-12) cands.push(-(a * b + d * e) / den1);
  const den2 = h * h - g * g;
  if (Math.abs(den2) > 1e-12) cands.push((a * a + d * d - b * b - e * e) / den2);
  const lo = 0.5 * Math.max(W, H), hi = 2.2 * Math.max(W, H);
  const ok = cands.filter((f2) => f2 > 0).map(Math.sqrt).filter((f) => f > lo && f < hi);
  return ok.length ? ok.reduce((s, f) => s + f, 0) / ok.length : null;
}

function updatePose(Hm) {
  const cx = W / 2, cy = H / 2;
  // Hc = T(−c)·H
  const Hc = [
    Hm[0] - cx * Hm[6], Hm[1] - cx * Hm[7], Hm[2] - cx * Hm[8],
    Hm[3] - cy * Hm[6], Hm[4] - cy * Hm[7], Hm[5] - cy * Hm[8],
    Hm[6], Hm[7], Hm[8],
  ];
  const fNew = estimateFocal(Hc);
  const fDefault = 0.8 * Math.max(W, H);
  if (!fEst) fEst = fNew || fDefault;
  else if (fNew) fEst = fEst * 0.9 + fNew * 0.1;
  const f = fEst;

  const b1 = new THREE.Vector3(Hc[0] / f, Hc[3] / f, Hc[6]);
  const b2 = new THREE.Vector3(Hc[1] / f, Hc[4] / f, Hc[7]);
  const b3 = new THREE.Vector3(Hc[2] / f, Hc[5] / f, Hc[8]);
  let lambda = 2 / (b1.length() + b2.length());
  if (b3.z * lambda < 0) lambda = -lambda; // folha na frente da câmera
  const r1 = b1.multiplyScalar(lambda).normalize();
  const r2raw = b2.multiplyScalar(lambda);
  const r2 = r2raw.sub(r1.clone().multiplyScalar(r2raw.dot(r1))).normalize();
  const r3 = new THREE.Vector3().crossVectors(r1, r2);
  const t = b3.multiplyScalar(lambda);

  // Vista (mundo→câmera three.js) = diag(1,−1,−1)·[R|t]
  const view = new THREE.Matrix4().set(
    r1.x, r2.x, r3.x, t.x,
    -r1.y, -r2.y, -r3.y, -t.y,
    -r1.z, -r2.z, -r3.z, -t.z,
    0, 0, 0, 1,
  );
  camera.matrix.copy(view).invert();
  camera.matrixWorldNeedsUpdate = true;

  const near = 10, far = 5000;
  camera.projectionMatrix.set(
    (2 * f) / W, 0, 0, 0,
    0, (2 * f) / H, 0, 0,
    0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near),
    0, 0, -1, 0,
  );
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

// Ponto da imagem → ponto 3D a `liftMm` acima da folha (para a conta segurada).
function imageToLifted(x, y, liftMm) {
  camera.updateMatrixWorld(true);
  ray.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -((y / H) * 2 - 1)), camera);
  liftPlane.set(new THREE.Vector3(0, 0, 1), liftMm); // z + lift = 0 → z = −lift (acima da folha)
  const out = new THREE.Vector3();
  return ray.ray.intersectPlane(liftPlane, out) ? out : null;
}

// state: { H_matToImg, pins:[{state, virtual, target}], nextPin, now,
//          carries:[{color, x, y}], colorOf }
export function render3D(state) {
  if (!renderer) return;
  if (!state.H_matToImg) { root.visible = false; renderer.render(scene, camera); return; }
  root.visible = true;
  updatePose(state.H_matToImg);

  const pulse = 0.3 + 0.3 * (0.5 + 0.5 * Math.sin(state.now / 200));
  state.pins.forEach((p, i) => {
    const o = pinObjs[i];
    if (!o) return;
    const filled = p.state !== 'vazio';
    if (o.ghost) {
      o.ghost.visible = !(filled && p.state === p.target) && !(p.virtual && filled);
      if (p === state.nextPin) {
        pulseMat.color.setRGB(...o.ghost.userData.rgb.map((v) => v / 255), THREE.SRGBColorSpace);
        pulseMat.opacity = pulse;
        o.ghost.material = pulseMat;
        o.ghost.position.z = -0.12 * pitch - 0.25 * pitch * (0.5 + 0.5 * Math.sin(state.now / 200));
      } else {
        o.ghost.material = ghostMat(o.ghost.userData.rgb);
        o.ghost.position.z = -0.12 * pitch;
      }
    }
    // conta virtual em 3D; a conta física já está na imagem real
    o.bead.visible = !!(p.virtual && filled);
    if (o.bead.visible) o.bead.material = colorMat(state.colorOf(p.state));
  });

  carryObjs.forEach((c, i) => {
    const carry = state.carries[i];
    if (!carry) { c.bead.visible = false; return; }
    const pt = imageToLifted(carry.x, carry.y, 1.2 * pitch);
    if (!pt) { c.bead.visible = false; return; }
    c.bead.visible = true;
    c.bead.material = colorMat(state.colorOf(carry.color));
    c.bead.position.copy(pt);
  });

  renderer.render(scene, camera);
}

export function dispose3D() {
  if (!renderer) return;
  renderer.dispose();
  if (canvas && canvas.parentElement) canvas.parentElement.removeChild(canvas);
  renderer = null;
  pinObjs = []; trayObjs = []; carryObjs = [];
  matCache.clear(); ghostCache.clear();
}
