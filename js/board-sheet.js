// Geometria da folha de marcadores (marcadores.html) — compartilhada entre a
// página de impressão e o modo placa física (board-scene.js), pra que as
// coordenadas em milímetros dos dois lados sejam sempre as mesmas.
//
// A folha é um A4 deitado (297×210 mm) com quatro marcadores ArUco
// (dicionário ARUCO_MIP_36h12, ids 0–3) nos cantos. A placa perfurada fica no
// meio da folha, entre os marcadores. Todas as coordenadas abaixo são em mm,
// com origem no canto superior esquerdo da folha.

export const SHEET_W_MM = 297;
export const SHEET_H_MM = 210;
export const MARKER_MM = 35;
export const MARKER_MARGIN_MM = 10;
export const MARKER_DICTIONARY = 'ARUCO_MIP_36h12';

const c = MARKER_MARGIN_MM + MARKER_MM / 2;

// Centro de cada marcador na folha, por id: 0 = sup. esq., 1 = sup. dir.,
// 2 = inf. dir., 3 = inf. esq. (sentido horário).
export const MARKER_CENTERS_MM = {
  0: [c, c],
  1: [SHEET_W_MM - c, c],
  2: [SHEET_W_MM - c, SHEET_H_MM - c],
  3: [c, SHEET_H_MM - c],
};

// Faixas de papel branco que nunca ficam embaixo da placa — usadas como
// referência de branco pra corrigir a iluminação (balanço de branco).
export const WHITE_REF_MM = [
  [SHEET_W_MM / 2, 6],
  [SHEET_W_MM / 2, SHEET_H_MM - 6],
];

// Grade de contas: 8×8 pinos. O passo padrão é o das contas Hama Maxi
// (10 mm, maiores e mais fáceis pra criança pegar); ?passo=5 usa as Midi.
export const GRID_N = 8;
export function gridPitchMm() {
  const p = Number(new URLSearchParams(location.search).get('passo'));
  return p === 5 ? 5 : 10;
}

// Posição padrão da grade: centralizada na folha. Se a placa não estiver
// exatamente no meio, o botão "Ajustar grade" grava a posição real.
export function defaultGridCornersMm(pitch = gridPitchMm()) {
  const span = (GRID_N - 1) * pitch; // distância entre os centros dos pinos dos cantos
  const x0 = SHEET_W_MM / 2 - span / 2;
  const y0 = SHEET_H_MM / 2 - span / 2;
  return [[x0, y0], [x0 + span, y0], [x0 + span, y0 + span], [x0, y0 + span]];
}
