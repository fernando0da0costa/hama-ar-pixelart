// Formas básicas (modo padrão, pensado pra criança usar sem precisar mexer
// em nada — sem foto, sem recorte, sem sliders). Cada forma é um bitmap 8×8
// numa cor só do padrão Hama, o que também simplifica a RA: com uma cor só,
// não precisa "escolher cor na paleta" — é só pinçar perto de um furo que a
// conta certa já aparece.

import { buildShape, buildMultiShape } from './shape-utils.js';

const RAW = [
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
  {
    // A forma mais simples possível: uma única conta. Bom pra testar
    // pega-e-encaixa sem a grade densa das outras formas atrapalhar.
    name: 'Quadrado 1×1',
    color: 'Rosa',
    bitmap: ['#'],
  },
  {
    name: 'Cruz',
    color: 'Vinho',
    bitmap: [
      '...##...',
      '...##...',
      '...##...',
      '########',
      '########',
      '...##...',
      '...##...',
      '...##...',
    ],
  },
  {
    name: 'Seta',
    color: 'Cinza claro',
    bitmap: [
      '...##...',
      '..####..',
      '.######.',
      '########',
      '...##...',
      '...##...',
      '...##...',
      '...##...',
    ],
  },
  {
    name: 'Casa',
    color: 'Marrom',
    bitmap: [
      '...##...',
      '..####..',
      '.######.',
      '########',
      '########',
      '########',
      '###..###',
      '###..###',
    ],
  },
  {
    name: 'Lua',
    color: 'Turquesa',
    bitmap: [
      '..####..',
      '.######.',
      '##....##',
      '##......',
      '##......',
      '##....##',
      '.######.',
      '..####..',
    ],
  },
  {
    name: 'Flor',
    color: 'Rosa claro',
    bitmap: [
      '..#..#..',
      '.######.',
      '########',
      '.######.',
      '...##...',
      '...##...',
      '..####..',
      '.######.',
    ],
  },
];

// Única forma com mais de uma cor por desenho — mostra que a bandeja
// já suporta várias cores ao mesmo tempo (ver buildMultiShape), não só o
// esquema "uma forma, uma cor" das demais formas básicas.
const RAINBOW_RAW = {
  name: 'Arco-íris',
  palette: {
    R: 'Vermelho', O: 'Laranja', Y: 'Amarelo', G: 'Verde',
    C: 'Azul claro', B: 'Azul', P: 'Roxo', K: 'Rosa',
  },
  bitmap: [
    '.OYGCBP.',
    'ROYGCBPK',
    'ROYGCBPK',
    'ROYGCBPK',
    'ROYGCBPK',
    'ROYGCBPK',
    'ROYGCBPK',
    'ROYGCBPK',
  ],
};

export const BASIC_SHAPES = [...RAW.map(buildShape), buildMultiShape(RAINBOW_RAW)];
