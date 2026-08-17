// Formas prontas e simples (modo padrão, pensado pra criança usar sem
// precisar mexer em nada — sem foto, sem recorte, sem sliders). Cada forma é
// um bitmap 8×8 numa cor só do padrão Hama, o que também simplifica a RA:
// com uma cor só, não precisa "escolher cor na paleta" — é só pinçar perto
// de um furo que a conta certa já aparece.

import { HAMA_PALETTE } from './pattern.js';

function colorRGB(name) {
  const found = HAMA_PALETTE.find((p) => p[0] === name);
  return found ? found[1] : [255, 255, 255];
}

// '#' = conta nessa célula, '.' = vazio. Cada linha do bitmap vira uma linha
// da grade (8 caracteres = 8 colunas).
const SHAPES_RAW = [
  {
    name: 'Coração',
    color: 'Vermelho',
    bitmap: [
      '.##..##.',
      '########',
      '########',
      '########',
      '.######.',
      '..####..',
      '...##...',
      '........',
    ],
  },
  {
    name: 'Estrela',
    color: 'Amarelo',
    bitmap: [
      '...##...',
      '...##...',
      '..####..',
      '########',
      '########',
      '..####..',
      '.##..##.',
      '#.....#.',
    ],
  },
  {
    name: 'Círculo',
    color: 'Laranja',
    bitmap: [
      '..####..',
      '.######.',
      '########',
      '########',
      '########',
      '########',
      '.######.',
      '..####..',
    ],
  },
  {
    name: 'Quadrado',
    color: 'Azul',
    bitmap: [
      '########',
      '########',
      '##....##',
      '##....##',
      '##....##',
      '##....##',
      '########',
      '########',
    ],
  },
  {
    name: 'Triângulo',
    color: 'Verde',
    bitmap: [
      '...##...',
      '...##...',
      '..####..',
      '..####..',
      '.######.',
      '.######.',
      '########',
      '########',
    ],
  },
  {
    name: 'Losango',
    color: 'Roxo',
    bitmap: [
      '...##...',
      '..####..',
      '.######.',
      '########',
      '########',
      '.######.',
      '..####..',
      '...##...',
    ],
  },
];

export const SHAPES = SHAPES_RAW.map((s) => {
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
});
