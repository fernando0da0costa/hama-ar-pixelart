// Agrega todas as formas selecionáveis (básicas, letras, números) num único
// SHAPES, pra manter a mesma interface que main.js já importava — o conteúdo
// de cada categoria mora em ./shapes/*.js.

import { BASIC_SHAPES } from './shapes/basic.js';
import { LETTER_SHAPES } from './shapes/letters.js';
import { NUMBER_SHAPES } from './shapes/numbers.js';

export const SHAPES = [...BASIC_SHAPES, ...LETTER_SHAPES, ...NUMBER_SHAPES];
