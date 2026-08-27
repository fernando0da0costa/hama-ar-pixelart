// Banco de fotos-amostra pro protótipo de "aponta a câmera e converte pra
// Hama" da sala 3D (room-scene.js). Cada entrada é desenhada por código
// (gradientes/formas num canvas 2D), não baixada da internet — assim o
// projeto não depende de rede nem de licença de imagem de terceiro, e ainda
// assim o computePattern (pattern.js) trata cada canvas exatamente como
// trataria uma foto de verdade enviada por upload. Pra crescer o banco, basta
// acrescentar uma entrada nova aqui com um `draw(cx, s)`.

export const SAMPLE_PHOTOS = [
  { label: 'Maçã', draw: drawApple },
  { label: 'Girassol', draw: drawSunflower },
  { label: 'Balão de coração', draw: drawHeartBalloon },
  { label: 'Laranja', draw: drawOrange },
  { label: 'Melancia', draw: drawWatermelon },
];

export function makeSamplePhotoCanvas(drawFn, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  drawFn(c.getContext('2d'), size);
  return c;
}

function drawApple(cx, s) {
  const bg = cx.createLinearGradient(0, 0, 0, s);
  bg.addColorStop(0, '#dff1e8');
  bg.addColorStop(1, '#bfe0cf');
  cx.fillStyle = bg;
  cx.fillRect(0, 0, s, s);

  const cxp = s * 0.5, cyp = s * 0.56, r = s * 0.32;
  const body = cx.createRadialGradient(cxp - r * 0.4, cyp - r * 0.4, r * 0.1, cxp, cyp, r);
  body.addColorStop(0, '#ff8a7a');
  body.addColorStop(0.5, '#e5342f');
  body.addColorStop(1, '#a3161b');
  cx.fillStyle = body;
  cx.beginPath();
  cx.arc(cxp, cyp, r, 0, Math.PI * 2);
  cx.fill();

  cx.strokeStyle = '#5a3a20';
  cx.lineWidth = s * 0.018;
  cx.beginPath();
  cx.moveTo(cxp, cyp - r);
  cx.quadraticCurveTo(cxp + s * 0.02, cyp - r - s * 0.12, cxp + s * 0.03, cyp - r - s * 0.16);
  cx.stroke();

  cx.fillStyle = '#3f8f3a';
  cx.beginPath();
  cx.ellipse(cxp + s * 0.07, cyp - r - s * 0.08, s * 0.06, s * 0.035, -0.6, 0, Math.PI * 2);
  cx.fill();
}

function drawSunflower(cx, s) {
  const bg = cx.createLinearGradient(0, 0, 0, s);
  bg.addColorStop(0, '#8ec9f0');
  bg.addColorStop(1, '#eaf6ff');
  cx.fillStyle = bg;
  cx.fillRect(0, 0, s, s);

  const cxp = s * 0.5, cyp = s * 0.48;
  const petalR = s * 0.3, petalLen = s * 0.16;
  cx.fillStyle = '#f6c31a';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const px = cxp + Math.cos(a) * petalR;
    const py = cyp + Math.sin(a) * petalR;
    cx.save();
    cx.translate(px, py);
    cx.rotate(a);
    cx.beginPath();
    cx.ellipse(0, 0, petalLen, petalLen * 0.42, 0, 0, Math.PI * 2);
    cx.fill();
    cx.restore();
  }
  const center = cx.createRadialGradient(cxp, cyp, s * 0.02, cxp, cyp, s * 0.16);
  center.addColorStop(0, '#7a4a1e');
  center.addColorStop(1, '#4a2c10');
  cx.fillStyle = center;
  cx.beginPath();
  cx.arc(cxp, cyp, s * 0.16, 0, Math.PI * 2);
  cx.fill();

  cx.strokeStyle = '#3f8f3a';
  cx.lineWidth = s * 0.025;
  cx.beginPath();
  cx.moveTo(cxp, cyp + s * 0.3);
  cx.lineTo(cxp, s * 0.95);
  cx.stroke();
}

function drawHeartBalloon(cx, s) {
  const bg = cx.createLinearGradient(0, 0, 0, s);
  bg.addColorStop(0, '#cfe4ff');
  bg.addColorStop(1, '#fbeaf1');
  cx.fillStyle = bg;
  cx.fillRect(0, 0, s, s);

  const cxp = s * 0.5, top = s * 0.32, w = s * 0.28;
  const body = cx.createRadialGradient(cxp - w * 0.3, top, w * 0.1, cxp, top + w * 0.3, w);
  body.addColorStop(0, '#ff9bb8');
  body.addColorStop(0.6, '#f2467e');
  body.addColorStop(1, '#c21f5a');
  cx.fillStyle = body;
  cx.beginPath();
  cx.moveTo(cxp, top + w * 0.9);
  cx.bezierCurveTo(cxp - w * 1.3, top - w * 0.3, cxp - w * 0.6, top - w * 1.1, cxp, top - w * 0.3);
  cx.bezierCurveTo(cxp + w * 0.6, top - w * 1.1, cxp + w * 1.3, top - w * 0.3, cxp, top + w * 0.9);
  cx.fill();

  cx.strokeStyle = '#8a8f99';
  cx.lineWidth = s * 0.01;
  cx.beginPath();
  cx.moveTo(cxp, top + w * 0.9);
  cx.quadraticCurveTo(cxp - s * 0.05, s * 0.75, cxp, s * 0.95);
  cx.stroke();
}

function drawOrange(cx, s) {
  const bg = cx.createLinearGradient(0, 0, 0, s);
  bg.addColorStop(0, '#fff3d6');
  bg.addColorStop(1, '#ffe0b0');
  cx.fillStyle = bg;
  cx.fillRect(0, 0, s, s);

  const cxp = s * 0.5, cyp = s * 0.54, r = s * 0.3;
  const body = cx.createRadialGradient(cxp - r * 0.35, cyp - r * 0.35, r * 0.08, cxp, cyp, r);
  body.addColorStop(0, '#ffb454');
  body.addColorStop(0.55, '#f5821f');
  body.addColorStop(1, '#c85e0f');
  cx.fillStyle = body;
  cx.beginPath();
  cx.arc(cxp, cyp, r, 0, Math.PI * 2);
  cx.fill();

  cx.fillStyle = '#3f8f3a';
  cx.beginPath();
  cx.ellipse(cxp, cyp - r - s * 0.02, s * 0.045, s * 0.03, 0, 0, Math.PI * 2);
  cx.fill();
  cx.beginPath();
  cx.ellipse(cxp + s * 0.05, cyp - r - s * 0.03, s * 0.05, s * 0.03, 0.5, 0, Math.PI * 2);
  cx.fill();
}

function drawWatermelon(cx, s) {
  const bg = cx.createLinearGradient(0, 0, 0, s);
  bg.addColorStop(0, '#cdeaff');
  bg.addColorStop(1, '#eafaf0');
  cx.fillStyle = bg;
  cx.fillRect(0, 0, s, s);

  const cxp = s * 0.5, cyp = s * 0.58, r = s * 0.32;
  cx.save();
  cx.beginPath();
  cx.arc(cxp, cyp, r, Math.PI, Math.PI * 2);
  cx.closePath();
  cx.clip();

  cx.fillStyle = '#e8e8e0';
  cx.fillRect(cxp - r, cyp - r, r * 2, r);

  const flesh = cx.createLinearGradient(0, cyp - r, 0, cyp);
  flesh.addColorStop(0, '#3fae4a');
  flesh.addColorStop(0.12, '#eef3d8');
  flesh.addColorStop(0.22, '#ff5a6e');
  flesh.addColorStop(1, '#ff8a97');
  cx.fillStyle = flesh;
  cx.fillRect(cxp - r, cyp - r * 0.9, r * 2, r * 0.9);

  cx.fillStyle = '#2a1a1a';
  const seedOffsets = [-0.5, -0.22, 0.05, 0.32, 0.55];
  for (const o of seedOffsets) {
    cx.beginPath();
    cx.ellipse(cxp + o * r, cyp - r * 0.45, s * 0.014, s * 0.024, o * 0.6, 0, Math.PI * 2);
    cx.fill();
  }
  cx.restore();
}
