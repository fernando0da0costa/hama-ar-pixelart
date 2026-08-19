// Formas básicas (modo padrão, pensado pra criança usar sem precisar mexer
// em nada — sem foto, sem recorte, sem sliders). Cada forma é um bitmap 8×8
// numa cor só do padrão Hama, o que também simplifica a RA: com uma cor só,
// não precisa "escolher cor na paleta" — é só pinçar perto de um furo que a
// conta certa já aparece.

import { buildShape } from './shape-utils.js';

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
];

export const BASIC_SHAPES = RAW.map(buildShape);
