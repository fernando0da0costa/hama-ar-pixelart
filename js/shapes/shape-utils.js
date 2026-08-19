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
