import { computePattern, nameForColor } from './pattern.js';
import { isArSupported, startAR, exitAR } from './ar-scene.js';
import { isWebcamSupported, startWebcam, exitWebcam, flipCamera } from './webcam-scene.js';
import { SHAPES } from './shapes.js';
import { primeAudio } from './sound.js';
import { isCompleted, markCompleted } from './progress.js';

const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const dropLabel = document.getElementById('dropLabel');
const removeBgToggle = document.getElementById('removeBgToggle');
const removeBgStatus = document.getElementById('removeBgStatus');
const DEFAULT_BG_HINT = removeBgStatus.textContent;
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const emptyState = document.getElementById('emptyState');
const gridW = document.getElementById('gridW');
const gridH = document.getElementById('gridH');
const colorsCount = document.getElementById('colorsCount');
const colorsVal = document.getElementById('colorsVal');
const simplifyTolerance = document.getElementById('simplifyTolerance');
const simplifyVal = document.getElementById('simplifyVal');
const paletteMode = document.getElementById('paletteMode');
const downloadBtn = document.getElementById('downloadBtn');
const enterArRealBtn = document.getElementById('enterArRealBtn');
const enterSimBtn = document.getElementById('enterSimBtn');
const arSupportMsg = document.getElementById('arSupportMsg');
const metaInfo = document.getElementById('metaInfo');
const legendPanel = document.getElementById('legendPanel');
const legendGrid = document.getElementById('legendGrid');
const resetCropBtn = document.getElementById('resetCropBtn');
const originalSample = document.getElementById('originalSample');
const originalEmpty = document.getElementById('originalEmpty');
const originalDims = document.getElementById('originalDims');
const resolutionSlider = document.getElementById('resolutionSlider');
const resolutionVal = document.getElementById('resolutionVal');

const cropCanvas = document.getElementById('cropCanvas');
const cropCtx = cropCanvas.getContext('2d');
const cropEmpty = document.getElementById('cropEmpty');
const cropWrap = document.getElementById('cropWrap');

const setupScreen = document.getElementById('setupScreen');
const arScreen = document.getElementById('arScreen');
const arProgress = document.getElementById('arProgress');
const arHint = document.getElementById('arHint');
const exitArBtn = document.getElementById('exitArBtn');
const flipCameraBtn = document.getElementById('flipCameraBtn');
const challengeToggle = document.getElementById('challengeToggle');
const arLevel = document.getElementById('arLevel');

let originalImage = null;
let dispScale = 1;
let activeMode = null; // 'ar' | 'webcam' | null — setado quando um dos dois botões é clicado
let arSupported = false;
let simSupported = false;
let crop = { x: 0, y: 0, w: 0, h: 0 };
let currentPattern = null;

// Cada botão só liga se (a) o aparelho suporta aquele modo e (b) já existe
// um padrão escolhido — chamado sempre que um dos dois muda.
function updateEnterButtons() {
  enterArRealBtn.disabled = !arSupported || !currentPattern;
  enterSimBtn.disabled = !simSupported || !currentPattern;
}

// Modo desafio: das formas prontas (SHAPES), ordenadas da mais fácil pra
// mais difícil pelo número de contas, e avança pra próxima sozinho quando
// o desenho atual é completado 100% certo.
const challengeOrder = [...SHAPES].sort((a, b) => a.totalBeads - b.totalBeads);
let challengeMode = false;
let challengeIndex = 0;
let advancingChallenge = false;

function updateChallengeUI() {
  arLevel.textContent = challengeMode
    ? `Nível ${challengeIndex + 1} de ${challengeOrder.length} · ${challengeOrder[challengeIndex].name}`
    : '';
}

function updateLabels() {
  colorsVal.textContent = colorsCount.value;
  resolutionVal.textContent = gridW.value + '×' + gridH.value;
  simplifyVal.textContent = simplifyTolerance.value + '%';
}

function drawCropOverlay() {
  if (!originalImage) return;
  cropCtx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
  cropCtx.drawImage(originalImage, 0, 0, cropCanvas.width, cropCanvas.height);

  cropCtx.fillStyle = 'rgba(0,0,0,0.55)';
  cropCtx.fillRect(0, 0, cropCanvas.width, crop.y);
  cropCtx.fillRect(0, crop.y + crop.h, cropCanvas.width, cropCanvas.height - (crop.y + crop.h));
  cropCtx.fillRect(0, crop.y, crop.x, crop.h);
  cropCtx.fillRect(crop.x + crop.w, crop.y, cropCanvas.width - (crop.x + crop.w), crop.h);

  cropCtx.strokeStyle = '#f9c74f';
  cropCtx.lineWidth = 2;
  cropCtx.strokeRect(crop.x, crop.y, crop.w, crop.h);

  const hs = 8;
  const corners = [
    [crop.x, crop.y], [crop.x + crop.w, crop.y],
    [crop.x, crop.y + crop.h], [crop.x + crop.w, crop.y + crop.h],
  ];
  cropCtx.fillStyle = '#f9c74f';
  for (const c of corners) cropCtx.fillRect(c[0] - hs / 2, c[1] - hs / 2, hs, hs);
}

function setupCropCanvas() {
  const maxW = Math.min(cropWrap.clientWidth || 260, 320);
  const scale = maxW / originalImage.width;
  cropCanvas.width = Math.round(originalImage.width * scale);
  cropCanvas.height = Math.round(originalImage.height * scale);
  dispScale = originalImage.width / cropCanvas.width;

  crop = { x: 0, y: 0, w: cropCanvas.width, h: cropCanvas.height };
  cropCanvas.style.display = 'block';
  cropEmpty.style.display = 'none';
  drawCropOverlay();
}

function getPos(evt) {
  const rect = cropCanvas.getBoundingClientRect();
  const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
  const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
  const scaleX = cropCanvas.width / rect.width;
  const scaleY = cropCanvas.height / rect.height;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

let dragMode = null;
let dragStart = null;
let cropStart = null;

function hitTestHandle(pos) {
  const hs = 12;
  const corners = {
    tl: [crop.x, crop.y], tr: [crop.x + crop.w, crop.y],
    bl: [crop.x, crop.y + crop.h], br: [crop.x + crop.w, crop.y + crop.h],
  };
  for (const key in corners) {
    const c = corners[key];
    if (Math.abs(pos.x - c[0]) < hs && Math.abs(pos.y - c[1]) < hs) return key;
  }
  if (pos.x > crop.x && pos.x < crop.x + crop.w && pos.y > crop.y && pos.y < crop.y + crop.h) return 'move';
  return 'new';
}

function onDragStart(evt) {
  if (!originalImage) return;
  evt.preventDefault();
  const pos = getPos(evt);
  dragMode = hitTestHandle(pos);
  dragStart = pos;
  cropStart = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
  if (dragMode === 'new') crop = { x: pos.x, y: pos.y, w: 0, h: 0 };
}

function clampCrop() {
  crop.x = Math.max(0, Math.min(crop.x, cropCanvas.width));
  crop.y = Math.max(0, Math.min(crop.y, cropCanvas.height));
  crop.w = Math.max(10, Math.min(crop.w, cropCanvas.width - crop.x));
  crop.h = Math.max(10, Math.min(crop.h, cropCanvas.height - crop.y));
}

function onDragMove(evt) {
  if (!dragMode || !originalImage) return;
  evt.preventDefault();
  const pos = getPos(evt);
  const dx = pos.x - dragStart.x;
  const dy = pos.y - dragStart.y;

  if (dragMode === 'new') {
    crop.w = pos.x - crop.x;
    crop.h = pos.y - crop.y;
    if (crop.w < 0) { crop.x = pos.x; crop.w = Math.abs(crop.w); }
    if (crop.h < 0) { crop.y = pos.y; crop.h = Math.abs(crop.h); }
  } else if (dragMode === 'move') {
    crop.x = cropStart.x + dx;
    crop.y = cropStart.y + dy;
  } else if (dragMode === 'tl') {
    crop.x = cropStart.x + dx; crop.y = cropStart.y + dy;
    crop.w = cropStart.w - dx; crop.h = cropStart.h - dy;
  } else if (dragMode === 'tr') {
    crop.y = cropStart.y + dy;
    crop.w = cropStart.w + dx; crop.h = cropStart.h - dy;
  } else if (dragMode === 'bl') {
    crop.x = cropStart.x + dx;
    crop.w = cropStart.w - dx; crop.h = cropStart.h + dy;
  } else if (dragMode === 'br') {
    crop.w = cropStart.w + dx; crop.h = cropStart.h + dy;
  }

  clampCrop();
  drawCropOverlay();
}

function onDragEnd() {
  if (!dragMode) return;
  dragMode = null;
  render();
}

cropCanvas.addEventListener('mousedown', onDragStart);
cropCanvas.addEventListener('mousemove', onDragMove);
window.addEventListener('mouseup', onDragEnd);
cropCanvas.addEventListener('touchstart', onDragStart, { passive: false });
cropCanvas.addEventListener('touchmove', onDragMove, { passive: false });
window.addEventListener('touchend', onDragEnd);

resetCropBtn.addEventListener('click', () => {
  if (!originalImage) return;
  crop = { x: 0, y: 0, w: cropCanvas.width, h: cropCanvas.height };
  drawCropOverlay();
  render();
});

function applyPattern(p, { fromChallenge = false } = {}) {
  // Qualquer escolha manual de forma/foto cancela o modo desafio — ele só
  // faz sentido guiando a sequência sozinho; se o usuário escolheu outra
  // coisa, é porque não quer mais seguir a sequência automática.
  if (!fromChallenge && challengeMode) {
    challengeMode = false;
    challengeToggle.checked = false;
    updateChallengeUI();
  }

  currentPattern = p;

  drawPreview(p);
  drawLegend(p);

  canvas.style.display = 'block';
  emptyState.style.display = 'none';
  downloadBtn.disabled = false;
  updateEnterButtons();

  metaInfo.innerHTML =
    '<span>Grade: <b>' + p.w + '×' + p.h + '</b></span>' +
    '<span>Total de contas: <b>' + p.totalBeads + '</b></span>' +
    '<span>Cores usadas: <b>' + p.legend.length + '</b></span>';
}

function render() {
  if (!originalImage) return;

  const w = Math.max(5, Math.min(24, parseInt(gridW.value, 10) || 12));
  const h = Math.max(5, Math.min(24, parseInt(gridH.value, 10) || 12));

  const p = computePattern(originalImage, crop, dispScale, {
    w, h,
    paletteMode: paletteMode.value,
    colorsCount: parseInt(colorsCount.value, 10),
    simplifyTolerance: parseInt(simplifyTolerance.value, 10),
  });

  applyPattern(p);
}

function makeThumbnail(p, size) {
  const thumb = document.createElement('canvas');
  thumb.width = size;
  thumb.height = size;
  const tctx = thumb.getContext('2d');
  tctx.fillStyle = '#0d0f12';
  tctx.fillRect(0, 0, size, size);

  const cell = size / Math.max(p.w, p.h);
  const offX = (size - p.w * cell) / 2;
  const offY = (size - p.h * cell) / 2;

  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const c = p.cells[y * p.w + x];
      if (!c) continue;
      tctx.beginPath();
      tctx.arc(offX + x * cell + cell / 2, offY + y * cell + cell / 2, cell * 0.42, 0, Math.PI * 2);
      tctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
      tctx.fill();
    }
  }
  return thumb;
}

const SHAPE_GRID_SIZE = 6;

// Sorteia n itens distintos de arr (Fisher-Yates parcial) — usado pra
// mostrar só uma amostra pequena das 36 formas de cada vez, em vez da grade
// inteira, e trocar a cada carregamento da tela.
function pickRandomSubset(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function buildShapeGrid() {
  const shapeGrid = document.getElementById('shapeGrid');
  shapeGrid.innerHTML = '';
  const buttons = [];

  pickRandomSubset(SHAPES, SHAPE_GRID_SIZE).forEach((shape) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shape-btn';
    btn.dataset.shapeName = shape.name;

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'thumb-wrap';
    thumbWrap.appendChild(makeThumbnail(shape, 64));
    const badge = document.createElement('span');
    badge.className = 'done-badge';
    badge.textContent = '✓';
    thumbWrap.appendChild(badge);
    btn.appendChild(thumbWrap);

    const label = document.createElement('span');
    label.textContent = shape.name;
    btn.appendChild(label);
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      applyPattern(shape);
    });
    shapeGrid.appendChild(btn);
    buttons.push(btn);
  });

  refreshShapeBadges();

  // Já entra com uma forma aleatória escolhida — zero passos até ter algo pra
  // ver, e dá variedade a cada visita (senão seria sempre o Coração primeiro).
  if (buttons.length) buttons[Math.floor(Math.random() * buttons.length)].click();
}

// Marca com ✓ as formas já completadas antes (progress.js/localStorage) —
// chamado de novo toda vez que uma forma é concluída, pra atualizar sem
// precisar reconstruir a grade inteira.
function refreshShapeBadges() {
  document.querySelectorAll('.shape-btn').forEach((btn) => {
    btn.classList.toggle('completed', isCompleted(btn.dataset.shapeName));
  });
}

function drawPreview(p) {
  const beadSize = 26;
  canvas.width = p.w * beadSize;
  canvas.height = p.h * beadSize;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#16191d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const cell = p.cells[y * p.w + x];
      if (!cell) continue;
      const cx = x * beadSize + beadSize / 2;
      const cy = y * beadSize + beadSize / 2;
      const radius = beadSize / 2 - 2;

      const grad = ctx.createRadialGradient(cx - radius * 0.35, cy - radius * 0.35, radius * 0.15, cx, cy, radius);
      grad.addColorStop(0, 'rgba(255,255,255,0.35)');
      grad.addColorStop(0.25, `rgb(${cell.r},${cell.g},${cell.b})`);
      grad.addColorStop(1, `rgb(${Math.max(0, cell.r - 25)},${Math.max(0, cell.g - 25)},${Math.max(0, cell.b - 25)})`);

      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function drawLegend(p) {
  legendGrid.innerHTML = '';
  for (const entry of p.legend) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="swatch" style="background: rgb(${entry.r},${entry.g},${entry.b})"></span><b>${entry.count}×</b><span>${entry.name}</span>`;
    legendGrid.appendChild(item);
  }
  legendPanel.style.display = 'block';
}

async function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) return;

  dropLabel.textContent = 'Carregando ' + file.name + '...';
  let imgSrc = null;

  if (removeBgToggle.checked) {
    try {
      removeBgStatus.textContent = 'Isolando o objeto (pode levar alguns segundos na primeira vez, baixando o modelo)...';
      const { removeBackground } = await import('https://esm.sh/@imgly/background-removal');
      const resultBlob = await removeBackground(file);
      imgSrc = URL.createObjectURL(resultBlob);
      removeBgStatus.textContent = 'Fundo removido. ' + DEFAULT_BG_HINT;
    } catch (err) {
      console.error('Falha ao remover fundo:', err);
      removeBgStatus.textContent = 'Não consegui isolar o objeto agora — usando a imagem original.';
    }
  }

  const finishLoad = (src) => {
    const img = new Image();
    img.onload = () => {
      originalImage = img;
      dropLabel.textContent = file.name;
      originalSample.src = src;
      originalSample.style.display = 'block';
      originalEmpty.style.display = 'none';
      originalDims.textContent = 'Original: ' + img.width + '×' + img.height + 'px';
      setupCropCanvas();
      render();
    };
    img.src = src;
  };

  if (imgSrc) {
    finishLoad(imgSrc);
  } else {
    const reader = new FileReader();
    reader.onload = (e) => finishLoad(e.target.result);
    reader.readAsDataURL(file);
  }
}

fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]));
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag');
  loadFile(e.dataTransfer.files[0]);
});

gridW.addEventListener('change', () => { syncResolutionFromGrid(); render(); });
gridH.addEventListener('change', () => { syncResolutionFromGrid(); render(); });
colorsCount.addEventListener('input', () => { updateLabels(); render(); });
simplifyTolerance.addEventListener('input', () => { updateLabels(); render(); });
paletteMode.addEventListener('change', render);

resolutionSlider.addEventListener('input', () => {
  gridW.value = resolutionSlider.value;
  gridH.value = resolutionSlider.value;
  updateLabels();
  render();
});

function syncResolutionFromGrid() {
  const avg = Math.round((parseInt(gridW.value, 10) + parseInt(gridH.value, 10)) / 2);
  resolutionSlider.value = Math.max(5, Math.min(24, avg));
  updateLabels();
}

document.querySelectorAll('.presets button').forEach((btn) => {
  btn.addEventListener('click', () => {
    gridW.value = btn.dataset.w;
    gridH.value = btn.dataset.h;
    syncResolutionFromGrid();
    render();
  });
});

downloadBtn.addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = 'padrao-contas.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
});

window.addEventListener('resize', () => {
  if (originalImage) {
    const oldCrop = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
    const oldW = cropCanvas.width, oldH = cropCanvas.height;
    setupCropCanvas();
    const rx = cropCanvas.width / oldW, ry = cropCanvas.height / oldH;
    crop = { x: oldCrop.x * rx, y: oldCrop.y * ry, w: oldCrop.w * rx, h: oldCrop.h * ry };
    clampCrop();
    drawCropOverlay();
  }
});

// ------------------------------------------------------------------ //
// RA ou simulação — dois botões independentes em vez de escolha automática:
// "Usar Realidade Aumentada" exige WebXR immersive-ar de verdade (Quest
// Browser ou celular com ARCore+WebXR); "Simular sem RA" é a webcam comum
// (mesma interação de pinça, só que 2D e sem ancoragem no mundo real), útil
// mesmo em aparelhos que TÊM suporte a RA, pra testar sem headset.
// ------------------------------------------------------------------ //

(async () => {
  arSupported = await isArSupported();
  simSupported = isWebcamSupported();

  if (arSupported && simSupported) {
    arSupportMsg.textContent = 'RA imersiva disponível — "Usar Realidade Aumentada" fixa o quadro no mundo real. "Simular sem RA" abre a versão de teste pela câmera comum, sem precisar de headset.';
  } else if (arSupported) {
    arSupportMsg.textContent = 'RA imersiva disponível, mas este navegador não tem acesso à câmera comum pro modo de simulação.';
  } else if (simSupported) {
    // Sem RA de verdade, o botão de RA desabilitado (cinza) só atrapalha —
    // some com ele e deixa o Simular como a opção óbvia e chamativa.
    enterArRealBtn.hidden = true;
    enterSimBtn.classList.remove('secondary');
    enterSimBtn.classList.add('primary', 'cta-pulse');
    arSupportMsg.textContent = 'Este aparelho não tem RA imersiva (precisa de Quest ou celular com WebXR) — use "Simular sem RA" pela webcam comum.';
  } else {
    arSupportMsg.textContent = 'Este navegador não tem câmera nem suporte a RA imersiva.';
  }

  updateEnterButtons();
})();

buildShapeGrid();

challengeToggle.addEventListener('change', () => {
  challengeMode = challengeToggle.checked;
  if (challengeMode) {
    challengeIndex = 0;
    const doneCount = challengeOrder.filter((s) => isCompleted(s.name)).length;
    if (doneCount > 0) {
      const resume = confirm(
        `Você já completou ${doneCount} de ${challengeOrder.length} níveis antes. Continuar de onde parou?`
        + '\n\n"OK" continua no próximo nível não feito. "Cancelar" recomeça do nível 1.',
      );
      if (resume) {
        const nextIdx = challengeOrder.findIndex((s) => !isCompleted(s.name));
        challengeIndex = nextIdx === -1 ? 0 : nextIdx; // -1 = já completou tudo, recomeça do 1
      }
    }
    document.querySelectorAll('.shape-btn.selected').forEach((b) => b.classList.remove('selected'));
    applyPattern(challengeOrder[challengeIndex], { fromChallenge: true });
  }
  updateChallengeUI();
});

function makeSceneCallbacks() {
  return {
    onProgress: (placed, correct, total) => {
      arProgress.textContent = `${placed} / ${total} contas · ${correct} corretas`;
      if (total > 0 && correct === total && currentPattern?.name) {
        markCompleted(currentPattern.name);
        refreshShapeBadges();
      }
      if (challengeMode && !advancingChallenge && total > 0 && correct === total) {
        advanceChallenge();
      }
    },
    onHint: (text) => { arHint.textContent = text; },
    onExit: () => {
      // Durante o avanço automático de nível, o próprio advanceChallenge já
      // controla a troca de tela — não deixa esse onExit (disparado pela
      // saída/reentrada da sessão) voltar pra tela de configuração no meio.
      if (advancingChallenge) return;
      setupScreen.hidden = false;
      arScreen.hidden = true;
    },
  };
}

async function enterMode(mode) {
  if (!currentPattern || !mode) return;
  activeMode = mode;
  primeAudio(); // precisa ser chamado a partir de um clique de verdade pra destravar o áudio
  const start = activeMode === 'ar' ? startAR : startWebcam;
  try {
    setupScreen.hidden = true;
    arScreen.hidden = false;
    // Trocar de câmera (frontal/traseira) só faz sentido no modo webcam —
    // em RA imersiva (WebXR) é o próprio sistema do headset/celular que
    // controla a câmera de passagem, sem essa escolha.
    flipCameraBtn.hidden = activeMode !== 'webcam';
    await start(currentPattern, makeSceneCallbacks(), arScreen);
  } catch (err) {
    console.error('Falha ao iniciar:', err);
    alert('Não foi possível iniciar: ' + err.message);
    setupScreen.hidden = false;
    arScreen.hidden = true;
  }
}

// Ao completar um nível no modo desafio: sai da sessão atual, carrega o
// próximo desenho (mais difícil) e entra de novo automaticamente. Reaproveita
// o mesmo start/exit que o botão usa, em vez de tentar trocar o padrão com a
// sessão viva — mais simples e reaproveita tudo que já existe.
async function advanceChallenge() {
  advancingChallenge = true;
  const isLast = challengeIndex >= challengeOrder.length - 1;
  if (isLast) {
    arHint.textContent = 'Você completou todos os níveis! 🎉';
    advancingChallenge = false;
    return;
  }
  arHint.textContent = 'Nível concluído! Preparando o próximo...';
  await new Promise((resolve) => setTimeout(resolve, 1800));

  challengeIndex++;
  applyPattern(challengeOrder[challengeIndex], { fromChallenge: true });
  updateChallengeUI();

  if (activeMode === 'ar') await exitAR();
  else exitWebcam();

  advancingChallenge = false; // precisa cair antes do enterMode reengatar makeSceneCallbacks
  await enterMode(activeMode); // mantém o mesmo modo (RA ou simulação) do nível anterior
}

enterArRealBtn.addEventListener('click', () => enterMode('ar'));
enterSimBtn.addEventListener('click', () => enterMode('webcam'));

exitArBtn.addEventListener('click', () => {
  if (activeMode === 'ar') exitAR();
  else if (activeMode === 'webcam') exitWebcam();
});

flipCameraBtn.addEventListener('click', () => {
  if (activeMode === 'webcam') flipCamera();
});

updateLabels();
