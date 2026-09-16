// Geometria da conta de verdade, usada pela cena webcam (webcam-scene.js).
// Uma conta Hama/Perler não é uma esfera: é um tubo furado (perfil
// revolucionado em torno do eixo Y),
// com um furo passante no meio pra "empalhar" na grade/pino — LatheGeometry
// com um perfil em U aberto gera exatamente essa forma, sem precisar de CSG
// (subtração booleana).

import * as THREE from 'three';

export const BEAD_HOLE_RATIO = 0.42; // furo central, como fração do raio externo
export const BEAD_HEIGHT_RATIO = 1.7; // altura do tubo, como fração do raio externo

export function createBeadGeometry(outerRadius) {
  const holeR = outerRadius * BEAD_HOLE_RATIO;
  const halfH = (outerRadius * BEAD_HEIGHT_RATIO) / 2;
  const profile = [
    new THREE.Vector2(holeR, -halfH),
    new THREE.Vector2(outerRadius, -halfH),
    new THREE.Vector2(outerRadius, halfH),
    new THREE.Vector2(holeR, halfH),
  ];
  return new THREE.LatheGeometry(profile, 24);
}
