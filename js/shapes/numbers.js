// Números 0-9 completos como formas seletáveis — mesmo esquema de bitmap
// 8×8 numa cor só das formas básicas. Cada dígito segue o layout de um
// display de sete segmentos (barra de cima, duas verticais de cima, barra do
// meio, duas verticais de baixo, barra de baixo) — dá um conjunto visualmente
// consistente pros 10 dígitos, em vez de dependido de desenho livre.
//
// Bandas de linha do grid 8×8 (colunas 1 e 6 fazem as verticais, colunas 0 e
// 7 ficam sempre vazias):
//   linha 0: barra de cima
//   linhas 1-3: verticais de cima (esquerda=col1, direita=col6)
//   linha 4: barra do meio
//   linhas 5-6: verticais de baixo (esquerda=col1, direita=col6)
//   linha 7: barra de baixo

import { buildShape } from './shape-utils.js';

const RAW = [
  {
    name: '0',
    color: 'Cinza claro',
    bitmap: [
      '.######.',
      '.#....#.',
      '.#....#.',
      '.#....#.',
      '........',
      '.#....#.',
      '.#....#.',
      '.######.',
    ],
  },
  {
    name: '1',
    color: 'Vermelho',
    bitmap: [
      '........',
      '......#.',
      '......#.',
      '......#.',
      '........',
      '......#.',
      '......#.',
      '........',
    ],
  },
  {
    name: '2',
    color: 'Laranja',
    bitmap: [
      '.######.',
      '......#.',
      '......#.',
      '......#.',
      '.######.',
      '.#......',
      '.#......',
      '.######.',
    ],
  },
  {
    name: '3',
    color: 'Amarelo',
    bitmap: [
      '.######.',
      '......#.',
      '......#.',
      '......#.',
      '.######.',
      '......#.',
      '......#.',
      '.######.',
    ],
  },
  {
    name: '4',
    color: 'Verde',
    bitmap: [
      '........',
      '.#....#.',
      '.#....#.',
      '.#....#.',
      '.######.',
      '......#.',
      '......#.',
      '........',
    ],
  },
  {
    name: '5',
    color: 'Verde água',
    bitmap: [
      '.######.',
      '.#......',
      '.#......',
      '.#......',
      '.######.',
      '......#.',
      '......#.',
      '.######.',
    ],
  },
  {
    name: '6',
    color: 'Azul',
    bitmap: [
      '.######.',
      '.#......',
      '.#......',
      '.#......',
      '.######.',
      '.#....#.',
      '.#....#.',
      '.######.',
    ],
  },
  {
    name: '7',
    color: 'Azul claro',
    bitmap: [
      '.######.',
      '......#.',
      '......#.',
      '......#.',
      '........',
      '......#.',
      '......#.',
      '........',
    ],
  },
  {
    name: '8',
    color: 'Roxo',
    bitmap: [
      '.######.',
      '.#....#.',
      '.#....#.',
      '.#....#.',
      '.######.',
      '.#....#.',
      '.#....#.',
      '.######.',
    ],
  },
  {
    name: '9',
    color: 'Rosa',
    bitmap: [
      '.######.',
      '.#....#.',
      '.#....#.',
      '.#....#.',
      '.######.',
      '......#.',
      '......#.',
      '.######.',
    ],
  },
];

export const NUMBER_SHAPES = RAW.map(buildShape);
