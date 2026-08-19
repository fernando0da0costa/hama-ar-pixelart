// Amostra de números (1, 2, 3) como formas seletáveis — mesmo esquema de
// bitmap 8×8 numa cor só das formas básicas. Amostra pequena de propósito;
// dá pra estender pra 0-9 completo depois seguindo o mesmo padrão.

import { buildShape } from './shape-utils.js';

const RAW = [
  {
    name: '1',
    color: 'Verde água',
    bitmap: [
      '...##...',
      '..###...',
      '.####...',
      '...##...',
      '...##...',
      '...##...',
      '...##...',
      '.######.',
    ],
  },
  {
    name: '2',
    color: 'Azul claro',
    bitmap: [
      '.######.',
      '##....##',
      '......##',
      '.....##.',
      '....##..',
      '...##...',
      '..##....',
      '########',
    ],
  },
  {
    name: '3',
    color: 'Rosa claro',
    bitmap: [
      '######..',
      '......##',
      '......##',
      '.####...',
      '......##',
      '......##',
      '##....##',
      '.######.',
    ],
  },
];

export const NUMBER_SHAPES = RAW.map(buildShape);
