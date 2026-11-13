// Funções puras de visão do modo placa física: homografia, cor (CIELAB),
// classificação por centróide mais próximo e recalibração por k-means, e o
// contorno da mão usado pra desenhar a grade "por trás" dela. Sem DOM aqui,
// pra dar pra testar em Node.

// ---------------------------------------------------------------- //
// Homografia (4 pontos, DLT com h33 = 1)
// ---------------------------------------------------------------- //

// Resolve H tal que dst ~ H·src, para 4 pares de pontos [x, y].
export function homographyFrom4(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [X, Y] = src[i];
    const [x, y] = dst[i];
    A.push([X, Y, 1, 0, 0, 0, -x * X, -x * Y, x]);
    A.push([0, 0, 0, X, Y, 1, -y * X, -y * Y, y]);
  }
  const h = solveLinear(A);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

// Mínimos quadrados (N ≥ 4 pares): resolve as equações normais AᵀA·h = Aᵀb.
// Usado com os cantos de todos os marcadores visíveis (1 marcador = 4 cantos).
export function homographyLSQ(src, dst) {
  if (src.length < 4) return null;
  const N = Array.from({ length: 8 }, () => new Array(9).fill(0));
  const add = (row, rhs) => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) N[i][j] += row[i] * row[j];
      N[i][8] += row[i] * rhs;
    }
  };
  for (let k = 0; k < src.length; k++) {
    const [X, Y] = src[k], [x, y] = dst[k];
    add([X, Y, 1, 0, 0, 0, -x * X, -x * Y], x);
    add([0, 0, 0, X, Y, 1, -y * X, -y * Y], y);
  }
  const h = solveLinear(N);
  if (!h || h.some((t) => !Number.isFinite(t))) return null;
  return [...h, 1];
}

// Eliminação de Gauss com pivotamento parcial; A é n×(n+1) (matriz aumentada).
function solveLinear(A) {
  const n = A.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let k = col; k <= n; k++) A[r][k] -= f * A[col][k];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ].map((v) => v / det);
  return inv.map((v) => v / inv[8]);
}

// Composição: (H1·H2)(p) = H1(H2(p)).
export function multiplyH(H1, H2) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = H1[i * 3] * H2[j] + H1[i * 3 + 1] * H2[3 + j] + H1[i * 3 + 2] * H2[6 + j];
    }
  }
  return r.map((v) => v / r[8]);
}

// ---------------------------------------------------------------- //
// Cor
// ---------------------------------------------------------------- //

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// sRGB (0–255) → CIELAB (D65).
export function rgbToLab([r, g, b]) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// Média RGB de um anel em volta do centro do pino (rIn..rOut, em pixels) —
// anel e não disco porque a conta Hama é furada: no centro aparece o pino.
// Pixels muito escuros (sombra) ou estourados (reflexo) ficam de fora.
export function sampleRing(img, cx, cy, rIn, rOut) {
  const { width, height, data } = img;
  let sr = 0, sg = 0, sb = 0, n = 0;
  const x0 = Math.max(0, Math.floor(cx - rOut)), x1 = Math.min(width - 1, Math.ceil(cx + rOut));
  const y0 = Math.max(0, Math.floor(cy - rOut)), y1 = Math.min(height - 1, Math.ceil(cy + rOut));
  const rIn2 = rIn * rIn, rOut2 = rOut * rOut;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 < rIn2 || d2 > rOut2) continue;
      const k = (y * width + x) * 4;
      const r = data[k], g = data[k + 1], b = data[k + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 18) continue; // sombra profunda
      if (mn > 250) continue; // reflexo especular
      sr += r; sg += g; sb += b; n++;
    }
  }
  if (n) return [sr / n, sg / n, sb / n];
  // tudo excluído (ex.: papel branco estourado pela luz): usa todos os pixels
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 < rIn2 || d2 > rOut2) continue;
      const k = (y * width + x) * 4;
      sr += data[k]; sg += data[k + 1]; sb += data[k + 2]; n++;
    }
  }
  return n ? [sr / n, sg / n, sb / n] : null;
}

// Balanço de branco (von Kries): escala cada canal para que a referência de
// papel branco vire um branco neutro.
export function whiteBalanceGains(whiteRgb, targetWhite = 235) {
  if (!whiteRgb) return [1, 1, 1];
  return whiteRgb.map((v) => Math.min(3, Math.max(0.33, targetWhite / Math.max(1, v))));
}

export function applyGains(rgb, gains) {
  return rgb.map((v, i) => Math.min(255, v * gains[i]));
}

// Centróide mais próximo, com rejeição: acima de `delta` vira indeterminado
// (null). classes: [{ id, lab }].
export function classifyLab(lab, classes, delta) {
  let best = null, bestD = Infinity;
  for (const c of classes) {
    const d = deltaE(lab, c.lab);
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD < delta ? { id: best.id, dist: bestD } : { id: null, dist: bestD };
}

// Recalibração por k-means: parte dos centróides atuais (paleta nominal já
// corrigida + "vazio") e reajusta cada um pela média das amostras atribuídas
// a ele. Só move centróides com pelo menos `minMembers` amostras, e no máximo
// `maxShift` em ΔE — evita que uma cor sem nenhuma conta na placa "fuja".
export function refineCentroids(samplesLab, classes, { iterations = 5, minMembers = 2, maxShift = 25 } = {}) {
  const start = classes.map((c) => c.lab.slice());
  let cents = classes.map((c) => c.lab.slice());
  for (let it = 0; it < iterations; it++) {
    const sums = cents.map(() => [0, 0, 0, 0]);
    for (const s of samplesLab) {
      let bi = 0, bd = Infinity;
      for (let k = 0; k < cents.length; k++) {
        const d = deltaE(s, cents[k]);
        if (d < bd) { bd = d; bi = k; }
      }
      sums[bi][0] += s[0]; sums[bi][1] += s[1]; sums[bi][2] += s[2]; sums[bi][3]++;
    }
    cents = cents.map((c, k) => {
      const [a, b, l, n] = sums[k];
      if (n < minMembers) return c;
      const m = [a / n, b / n, l / n];
      const shift = deltaE(m, start[k]);
      if (shift <= maxShift) return m;
      const t = maxShift / shift; // limita o deslocamento ao raio permitido
      return start[k].map((v, i) => v + (m[i] - v) * t);
    });
  }
  return classes.map((c, k) => ({ ...c, lab: cents[k] }));
}

// Mediana por componente — usada pra estimar a cor do pino vazio assumindo
// que a maior parte da área ainda está sem contas.
export function medianLab(list) {
  if (!list.length) return null;
  return [0, 1, 2].map((i) => {
    const s = list.map((v) => v[i]).sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  });
}

// ---------------------------------------------------------------- //
// Contorno da mão (oclusão)
// ---------------------------------------------------------------- //

// Fecho convexo (monotone chain) dos pontos [x, y].
export function convexHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Expande o polígono a partir do centróide (margem pra cobrir a pele em
// volta dos pontos, que ficam no meio dos dedos).
export function expandPolygon(poly, factor) {
  if (!poly.length) return poly;
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
