import { computePattern, nameForColor } from './pattern.js';
import { isArSupported, startAR, exitAR } from './ar-scene.js';
import { isWebcamSupported, startWebcam, exitWebcam, flipCamera } from './webcam-scene.js';
import { isRoomSupported, startRoom, exitRoom, setCaptureResolution, getCaptureResolution } from './room-scene.js';
import { SHAPES } from './shapes.js';
import { primeAudio } from './sound.js';
import { isCompleted, markCompleted, addHistoryEntry, getRecentHistory } from './progress.js';

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
const enterRoomBtn = document.getElementById('enterRoomBtn');
const arSupportMsg = document.getElementById('arSupportMsg');
const metaInfo = document.getElementById('metaInfo');
const legendPanel = document.getElementById('legendPanel');
const legendGrid = document.getElementById('legendGrid');
const historyPanel = document.getElementById('historyPanel');
const historyGrid = document.getElementById('historyGrid');
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
const captureResHud = document.getElementById('captureResHud');
const captureResSlider = document.getElementById('captureResSlider');
const captureResVal = document.getElementById('captureResVal');
const arLevel = document.getElementById('arLevel');
const levelInfo = document.getElementById('levelInfo');

let originalImage = null;
let dispScale = 1;
let activeMode = null; // 'ar' | 'webcam' | 'room' | null — setado quando um dos três botões é clicado
let arSupported = false;
let simSupported = false;
let roomSupported = false;
let crop = { x: 0, y: 0, w: 0, h: 0 };
let currentPattern = null;

// Cada botão só liga se (a) o aparelho suporta aquele modo e (b) já existe
// um padrão escolhido — chamado sempre que um dos dois muda.
function updateEnterButtons() {
  enterArRealBtn.disabled = !arSupported || !currentPattern;
  enterSimBtn.disabled = !simSupported || !currentPattern;
  enterRoomBtn.disabled = !roomSupported || !currentPattern;
}

// O jogo é sempre por fases: das formas prontas (SHAPES), ordenadas da mais
// fácil pra mais difícil pelo número de contas, avançando pra próxima
// sozinho quando o desenho atual é completado 100% certo. Só sai desse
// trilho quando o usuário sobe uma foto própria (applyPattern cancela o
// challengeMode nesse caso) — um desenho customizado não tem lugar natural
// numa escada de dificuldade curada.
const challengeOrder = [...SHAPES].sort((a, b) => a.totalBeads - b.totalBeads);
let challengeMode = true;
let challengeIndex = 0;
let advancingChallenge = false;

function updateChallengeUI() {
  const text = challengeMode
    ? `Nível ${challengeIndex + 1} de ${challengeOrder.length} · ${challengeOrder[challengeIndex].name}`
    : '';
  arLevel.textContent = text;
  levelInfo.textContent = text;
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
  // Só uma foto própria (fromChallenge=false vindo do upload) tira o jogo da
  // escada de fases — um desenho customizado não faz parte da progressão
  // curada de dificuldade, então vira um desenho avulso, sem avanço automático.
  if (!fromChallenge && challengeMode) {
    challengeMode = false;
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

// Miniatura em PNG (dataURL) de um desenho já concluído, pra guardar no
// histórico do localStorage — canvas próprio, pequeno de propósito (bead
// menor que o da prévia principal), pra manter o histórico leve.
function renderPatternToDataUrl(p, beadSize = 16) {
  const c = document.createElement('canvas');
  c.width = p.w * beadSize;
  c.height = p.h * beadSize;
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = false;
  cx.fillStyle = '#16191d';
  cx.fillRect(0, 0, c.width, c.height);

  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const cell = p.cells[y * p.w + x];
      if (!cell) continue;
      const cxp = x * beadSize + beadSize / 2;
      const cyp = y * beadSize + beadSize / 2;
      const radius = beadSize / 2 - 1;

      const grad = cx.createRadialGradient(cxp - radius * 0.35, cyp - radius * 0.35, radius * 0.15, cxp, cyp, radius);
      grad.addColorStop(0, 'rgba(255,255,255,0.35)');
      grad.addColorStop(0.25, `rgb(${cell.r},${cell.g},${cell.b})`);
      grad.addColorStop(1, `rgb(${Math.max(0, cell.r - 25)},${Math.max(0, cell.g - 25)},${Math.max(0, cell.b - 25)})`);

      cx.beginPath();
      cx.arc(cxp, cyp, radius, 0, Math.PI * 2);
      cx.fillStyle = grad;
      cx.fill();
    }
  }
  return c.toDataURL('image/png');
}

// Chamado sempre que qualquer um dos três modos (RA/webcam/sala) termina um
// desenho 100% certo — guarda a miniatura no localStorage (progress.js) e
// atualiza a lista "últimas 3 concluídas" da tela de setup.
function savePatternCompletion(patternData) {
  if (!patternData) return;
  const dataUrl = renderPatternToDataUrl(patternData);
  addHistoryEntry({
    name: patternData.name || 'Desenho',
    dataUrl,
    w: patternData.w,
    h: patternData.h,
    totalBeads: patternData.totalBeads,
  });
  renderRecentHistory();
}

function formatHistoryDate(at) {
  const d = new Date(at);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function renderRecentHistory() {
  const recent = getRecentHistory(3);
  historyGrid.innerHTML = '';
  historyPanel.style.display = recent.length ? 'block' : 'none';

  for (const entry of recent) {
    const card = document.createElement('div');
    card.className = 'history-card';

    const img = document.createElement('img');
    img.src = entry.dataUrl;
    img.alt = entry.name;
    card.appendChild(img);

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${entry.name} (${entry.totalBeads} contas)`;
    card.appendChild(name);

    const date = document.createElement('div');
    date.className = 'date';
    date.textContent = formatHistoryDate(entry.at);
    card.appendChild(date);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '💾 Salvar imagem';
    btn.addEventListener('click', () => {
      const link = document.createElement('a');
      link.download = `hama-${entry.name.replace(/[^\w-]+/g, '_')}.png`;
      link.href = entry.dataUrl;
      link.click();
    });
    card.appendChild(btn);

    historyGrid.appendChild(card);
  }
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
  roomSupported = isRoomSupported();

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

// Entra direto no jogo por fases: retoma no primeiro nível ainda não
// completado (progress.js/localStorage), ou no nível 1 se for a primeira vez
// ou já tiver completado tudo — sem precisar de nenhum passo manual antes.
(() => {
  const nextIdx = challengeOrder.findIndex((s) => !isCompleted(s.name));
  challengeIndex = nextIdx === -1 ? 0 : nextIdx;
  applyPattern(challengeOrder[challengeIndex], { fromChallenge: true });
  updateChallengeUI();
})();

function makeSceneCallbacks() {
  return {
    onProgress: (placed, correct, total, patternName) => {
      arProgress.textContent = `${placed} / ${total} contas · ${correct} corretas`;
      // Na sala 3D dá pra "fotografar" um quadro na parede e converter na
      // hora (protótipo de IA) sem sair da sessão — isso troca o desenho na
      // mesa sem passar pelo applyPattern da tela de setup. Um nome diferente
      // do nível atual é essa captura avulsa: conta como progresso na hora
      // (placar/som), mas não mexe no histórico de fases nem avança nível,
      // senão completar uma foto capturada avançaria o nível errado.
      const isCurrentLevel = !patternName || patternName === currentPattern?.name;
      if (total > 0 && correct === total && isCurrentLevel && currentPattern?.name) {
        markCompleted(currentPattern.name);
      }
      if (challengeMode && !advancingChallenge && total > 0 && correct === total && isCurrentLevel) {
        advanceChallenge();
      }
    },
    onHint: (text) => { arHint.textContent = text; },
    onPatternCompleted: (patternData) => savePatternCompletion(patternData),
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
  const start = activeMode === 'ar' ? startAR : activeMode === 'webcam' ? startWebcam : startRoom;
  try {
    setupScreen.hidden = true;
    arScreen.hidden = false;
    // Trocar de câmera (frontal/traseira) só faz sentido no modo webcam —
    // em RA imersiva (WebXR) é o próprio sistema do headset/celular que
    // controla a câmera de passagem, sem essa escolha.
    flipCameraBtn.hidden = activeMode !== 'webcam';
    // Barra de resolução da captura de foto só existe na sala 3D (é lá que
    // dá pra "fotografar" um quadro na parede ou subir sua própria foto).
    captureResHud.hidden = activeMode !== 'room';
    if (activeMode === 'room') {
      captureResSlider.value = getCaptureResolution();
      captureResVal.textContent = `${captureResSlider.value}×${captureResSlider.value}`;
    }
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
  else if (activeMode === 'webcam') exitWebcam();
  else exitRoom();

  advancingChallenge = false; // precisa cair antes do enterMode reengatar makeSceneCallbacks
  await enterMode(activeMode); // mantém o mesmo modo (RA ou simulação) do nível anterior
}

enterArRealBtn.addEventListener('click', () => enterMode('ar'));
enterSimBtn.addEventListener('click', () => enterMode('webcam'));
enterRoomBtn.addEventListener('click', () => enterMode('room'));

exitArBtn.addEventListener('click', () => {
  if (activeMode === 'ar') exitAR();
  else if (activeMode === 'webcam') exitWebcam();
  else if (activeMode === 'room') exitRoom();
});

flipCameraBtn.addEventListener('click', () => {
  if (activeMode === 'webcam') flipCamera();
});

captureResSlider.addEventListener('input', () => {
  captureResVal.textContent = `${captureResSlider.value}×${captureResSlider.value}`;
  setCaptureResolution(Number(captureResSlider.value));
});

updateLabels();
renderRecentHistory();
