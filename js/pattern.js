// Geração do padrão de contas (grade + paleta + legenda) a partir de uma imagem.
// Portado do Pixel-art-web (index.html), como módulo reutilizável tanto pela
// tela de configuração quanto pela cena de RA.

export const HAMA_PALETTE = [
  ['Branco', [255, 255, 255]], ['Preto', [0, 0, 0]], ['Cinza', [148, 148, 148]],
  ['Vermelho', [201, 30, 42]], ['Laranja', [237, 116, 35]], ['Amarelo', [250, 213, 44]],
  ['Amarelo claro', [252, 238, 150]], ['Verde', [24, 133, 58]], ['Verde claro', [140, 198, 90]],
  ['Verde água', [60, 177, 150]], ['Azul', [30, 90, 168]], ['Azul claro', [107, 175, 222]],
  ['Roxo', [117, 74, 152]], ['Rosa', [237, 131, 169]], ['Rosa claro', [248, 196, 207]],
  ['Marrom', [122, 79, 45]], ['Bege', [222, 190, 150]], ['Vinho', [130, 30, 50]],
  ['Turquesa', [30, 160, 180]], ['Salmão', [240, 140, 110]], ['Dourado', [200, 160, 50]],
  ['Verde escuro', [30, 80, 40]], ['Azul marinho', [20, 40, 90]], ['Cinza claro', [200, 200, 200]],
];

function buildAutoPalette(pixels, k) {
  const samples = [];
  for (let i = 0; i < pixels.length; i += 4) {
    samples.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
  }
  if (samples.length === 0) return { colors: [], weights: [] };
  let centroids = [];
  for (let i = 0; i < k; i++) {
    centroids.push(samples[Math.floor((i * samples.length) / k)].slice());
  }
  let weights = centroids.map(() => 0);
  for (let iter = 0; iter < 6; iter++) {
    const sums = centroids.map(() => [0, 0, 0, 0]);
    for (const p of samples) {
      let best = 0, bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const cc = centroids[c];
        const d = (p[0] - cc[0]) ** 2 + (p[1] - cc[1]) ** 2 + (p[2] - cc[2]) ** 2;
        if (d < bestDist) { bestDist = d; best = c; }
      }
      sums[best][0] += p[0]; sums[best][1] += p[1]; sums[best][2] += p[2]; sums[best][3]++;
    }
    centroids = centroids.map((c, i) => (sums[i][3] > 0
      ? [Math.round(sums[i][0] / sums[i][3]), Math.round(sums[i][1] / sums[i][3]), Math.round(sums[i][2] / sums[i][3])]
      : c));
    weights = sums.map((s) => s[3]);
  }
  return { colors: centroids, weights };
}

function mergeSimilarColors(colors, weights, tolerancePercent) {
  if (tolerancePercent <= 0 || colors.length <= 1) {
    return colors.map((c, i) => ({ color: c, weight: weights[i] || 1 }));
  }
  const threshold = (tolerancePercent / 100) * 140;
  let clusters = colors.map((c, i) => ({ color: c.slice(), weight: weights[i] || 1 }));
  let merged = true;
  while (merged) {
    merged = false;
    outer:
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i], b = clusters[j];
        const d = Math.sqrt((a.color[0] - b.color[0]) ** 2 + (a.color[1] - b.color[1]) ** 2 + (a.color[2] - b.color[2]) ** 2);
        if (d < threshold) {
          const totalW = a.weight + b.weight;
          const newColor = [
            Math.round((a.color[0] * a.weight + b.color[0] * b.weight) / totalW),
            Math.round((a.color[1] * a.weight + b.color[1] * b.weight) / totalW),
            Math.round((a.color[2] * a.weight + b.color[2] * b.weight) / totalW),
          ];
          clusters.splice(j, 1);
          clusters[i] = { color: newColor, weight: totalW };
          merged = true;
          break outer;
        }
      }
    }
  }
  return clusters;
}

function nearestColorIndex(r, g, b, palette) {
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i];
    const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

export function nameForColor(rgb) {
  let bestName = '', bestDist = Infinity;
  for (const p of HAMA_PALETTE) {
    const c = p[1];
    const d = (rgb[0] - c[0]) ** 2 + (rgb[1] - c[1]) ** 2 + (rgb[2] - c[2]) ** 2;
    if (d < bestDist) { bestDist = d; bestName = p[0]; }
  }
  return bestName;
}

// image: HTMLImageElement já carregada.
// crop: {x,y,w,h} em pixels de tela do canvas de recorte.
// dispScale: fator pra converter crop (tela) -> pixels reais da imagem.
// options: { w, h, paletteMode: 'auto'|'hama', colorsCount, simplifyTolerance }
// Retorna { w, h, cells, legend, totalBeads } onde cells é um array w*h de
// {r,g,b,name} ou null (transparente / sem conta ali).
export function computePattern(image, crop, dispScale, options) {
  const w = Math.max(5, Math.min(60, options.w));
  const h = Math.max(5, Math.min(60, options.h));
  const k = options.colorsCount;

  const sx = crop.x * dispScale;
  const sy = crop.y * dispScale;
  const sw = crop.w * dispScale;
  const sh = crop.h * dispScale;

  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext('2d');
  tctx.imageSmoothingEnabled = true;
  tctx.drawImage(image, sx, sy, sw, sh, 0, 0, w, h);
  const imgData = tctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  let palette;
  if (options.paletteMode === 'hama') {
    palette = HAMA_PALETTE.map((p) => p[1]);
  } else {
    const built = buildAutoPalette(data, Math.min(k, w * h));
    const merged = mergeSimilarColors(built.colors, built.weights, options.simplifyTolerance);
    palette = merged.map((m) => m.color);
  }

  const cells = new Array(w * h).fill(null);
  const colorCounts = new Map();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 30) continue;
      const idx = nearestColorIndex(r, g, b, palette);
      const c = palette[idx];
      const name = nameForColor(c);
      cells[y * w + x] = { r: c[0], g: c[1], b: c[2], name };
      const key = c.join(',');
      colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
    }
  }

  const legend = [...colorCounts.entries()]
    .map(([key, count]) => {
      const [r, g, b] = key.split(',').map(Number);
      return { r, g, b, name: nameForColor([r, g, b]), count };
    })
    .sort((a, b) => b.count - a.count);

  const totalBeads = legend.reduce((sum, l) => sum + l.count, 0);

  return { w, h, cells, legend, totalBeads };
}
