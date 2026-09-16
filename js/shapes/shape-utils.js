// Conversão comum de bitmap ASCII ('#'/'.') pra forma pronta ({w,h,cells,
// legend,totalBeads}) — usada por basic.js, letters.js e numbers.js, pra não
// repetir essa lógica em cada arquivo de formas.

import { HAMA_PALETTE } from '../pattern.js';

export function colorRGB(name) {
  const found = HAMA_PALETTE.find((p) => p[0] === name);
  return found ? found[1] : [255, 255, 255];
}

export function buildShape(s) {
  const [r, g, b] = colorRGB(s.color);
  const h = s.bitmap.length;
  const w = s.bitmap[0].length;
  const cells = new Array(w * h).fill(null);
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (s.bitmap[y][x] === '#') {
        cells[y * w + x] = { r, g, b, name: s.color };
        count++;
      }
    }
  }
  return {
    name: s.name,
    w, h, cells,
    legend: [{ r, g, b, name: s.color, count }],
    totalBeads: count,
  };
}

// Igual a buildShape, mas pra formas com mais de uma cor: em vez de um
// bitmap '#'/'.', cada caractere do bitmap indexa uma cor num mapa
// {caractere: nomeDaCor} (s.palette) — '.' continua sendo "sem conta aqui".
// A bandeja do jogo já sabe desenhar várias cores (usada hoje só pelo modo
// "foto" antigo via k-means); isso só reaproveita esse suporte pras formas
// prontas, pra dar variedade de cor dentro de um único desenho.
export function buildMultiShape(s) {
  const h = s.bitmap.length;
  const w = s.bitmap[0].length;
  const cells = new Array(w * h).fill(null);
  const legendByChar = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = s.bitmap[y][x];
      if (ch === '.' || ch === undefined) continue;
      const colorName = s.palette[ch];
      if (!colorName) continue;
      const [r, g, b] = colorRGB(colorName);
      cells[y * w + x] = { r, g, b, name: colorName };
      if (!legendByChar.has(ch)) legendByChar.set(ch, { r, g, b, name: colorName, count: 0 });
      legendByChar.get(ch).count++;
    }
  }
  const legend = [...legendByChar.values()];
  return {
    name: s.name,
    w, h, cells,
    legend,
    totalBeads: legend.reduce((sum, entry) => sum + entry.count, 0),
  };
}
