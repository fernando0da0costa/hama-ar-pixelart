import { isWebcamSupported, startWebcam, exitWebcam, startMenu, exitMenu, flipCamera, isMirrorEnabled, toggleMirror, showCategoryComplete } from './webcam-scene.js';
import { BASIC_SHAPES } from './shapes/basic.js';
import { LETTER_SHAPES } from './shapes/letters.js';
import { NUMBER_SHAPES } from './shapes/numbers.js';
import { primeAudio, startMusic, isMusicEnabled, toggleMusic, setMusicIntensity, triggerMusicFlourish } from './sound.js';
import { isCompleted, markCompleted } from './progress.js';

// Três joguinhos, cada um com sua própria lista de formas (mesmo esquema de
// bitmap de contas) — escolhidos apontando/segurando o dedo num dos botões
// do menu (câmera já ligada, sem tela de configuração no meio).
const CATEGORIES = {
  hama: BASIC_SHAPES,
  matematica: NUMBER_SHAPES,
  palavras: LETTER_SHAPES,
};

const MENU_ITEMS = [
  { key: 'hama', icon: '🧶', label: 'HAMA' },
  { key: 'matematica', icon: '🔢', label: 'MATEMÁTICA' },
  { key: 'palavras', icon: '🔤', label: 'PALAVRAS' },
];

const welcomeScreen = document.getElementById('welcomeScreen');
const welcomeStatus = document.getElementById('welcomeStatus');
const menuScreen = document.getElementById('menuScreen');
const menuHint = document.getElementById('menuHint');
const menuFlipCameraBtn = document.getElementById('menuFlipCameraBtn');
const arScreen = document.getElementById('arScreen');
const arProgress = document.getElementById('arProgress');
const arProgressFill = document.getElementById('arProgressFill');
const arHint = document.getElementById('arHint');
const exitArBtn = document.getElementById('exitArBtn');
const flipCameraBtn = document.getElementById('flipCameraBtn');
const arLevel = document.getElementById('arLevel');
const musicToggleBtn = document.getElementById('musicToggleBtn');
const mirrorToggleBtn = document.getElementById('mirrorToggleBtn');
const winScreen = document.getElementById('winScreen'); // só o confete decorativo (pointer-events:none) — o texto/botão de "jogar de novo" agora são desenhados no canvas do jogo (ver showCategoryComplete), pra serem selecionáveis por gesto de mão igual ao botão "voltar"

let currentPattern = null;

// O jogo é sempre por fases: das formas da categoria escolhida no menu,
// ordenadas da mais fácil pra mais difícil pelo número de contas, avançando
// pra próxima sozinha quando o desenho atual é completado 100% certo
// (progresso salvo em progress.js/localStorage).
let challengeOrder = [];
let challengeIndex = 0;
let advancingChallenge = false;

function updateChallengeUI() {
  arLevel.textContent = `Nível ${challengeIndex + 1} de ${challengeOrder.length} · ${challengeOrder[challengeIndex].name}`;
  arProgressFill.style.width = '0%';
}

// Navegador só libera áudio de verdade depois de um gesto direto do usuário
// (clique/toque/tecla) — como o fluxo agora é 100% por gesto de mão (sem
// nenhum clique obrigatório), pega o primeiro clique/toque que acontecer por
// qualquer motivo (ex.: o clique de apoio do mouse no menu/jogo) pra
// destravar o áudio e ligar a música de fundo.
function unlockAudioOnce() {
  primeAudio();
  startMusic();
  window.removeEventListener('pointerdown', unlockAudioOnce);
  window.removeEventListener('keydown', unlockAudioOnce);
}
window.addEventListener('pointerdown', unlockAudioOnce);
window.addEventListener('keydown', unlockAudioOnce);

function updateMusicBtnLabel() {
  musicToggleBtn.textContent = isMusicEnabled() ? '🔊' : '🔇';
}
updateMusicBtnLabel();
musicToggleBtn.addEventListener('click', () => {
  toggleMusic();
  updateMusicBtnLabel();
});

// Espelhar a câmera frontal (tipo espelho de verdade) é opcional — quem já
// está acostumado a ver a própria mão "ao contrário" numa webcam pode
// preferir desligar. Preferência persiste em localStorage (ver MIRROR_KEY em
// webcam-scene.js), então só precisa configurar uma vez.
function updateMirrorBtnLabel() {
  mirrorToggleBtn.classList.toggle('is-off', !isMirrorEnabled());
}
updateMirrorBtnLabel();
mirrorToggleBtn.addEventListener('click', () => {
  toggleMirror();
  updateMirrorBtnLabel();
});

// ------------------------------------------------------------------ //
// Fluxo: boas-vindas (checa câmera) → menu com a câmera já ligada (aponta e
// segura o dedo num botão pra escolher) → jogo. Sem tela de configuração no
// meio — é pra ser um joguinho, não um sistema.
// ------------------------------------------------------------------ //

// Abertura fica no ar por pelo menos MIN_INTRO_MS — sem isso, como o único
// check real (isWebcamSupported) é síncrono, a tela de boas-vindas piscava e
// já sumia antes de dar tempo de ver a animação. As mensagens abaixo são só
// decorativas (nenhuma delas espera algo de verdade acontecer).
const MIN_INTRO_MS = 3000;
const BOOT_MESSAGES = [
  'Preparando as continhas...',
  'Testando a câmera...',
  'Ligando o rastreador de mãos...',
  'Tudo pronto!',
];

(async () => {
  if (!isWebcamSupported()) {
    welcomeStatus.textContent = 'Câmera não encontrada — não dá pra jogar neste aparelho/navegador.';
    return;
  }

  const stepMs = MIN_INTRO_MS / BOOT_MESSAGES.length;
  for (const msg of BOOT_MESSAGES) {
    welcomeStatus.textContent = msg;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }

  welcomeScreen.classList.add('fade-out');
  welcomeScreen.addEventListener('transitionend', () => { welcomeScreen.hidden = true; }, { once: true });

  await openMenu();
})();

async function openMenu() {
  menuScreen.hidden = false;
  menuFlipCameraBtn.hidden = false;
  try {
    await startMenu(MENU_ITEMS, {
      onHint: (text) => { menuHint.textContent = text; },
      onSelect: (category) => selectCategory(category),
    }, menuScreen);
  } catch (err) {
    console.error('Falha ao iniciar o menu:', err);
    menuHint.textContent = 'Não foi possível ligar a câmera: ' + err.message;
  }
}

function selectCategory(category) {
  exitMenu();
  menuScreen.hidden = true;

  challengeOrder = [...CATEGORIES[category]].sort((a, b) => a.totalBeads - b.totalBeads);
  const nextIdx = challengeOrder.findIndex((s) => !isCompleted(s.name));
  challengeIndex = nextIdx === -1 ? 0 : nextIdx;
  currentPattern = challengeOrder[challengeIndex];
  updateChallengeUI();

  enterGame();
}

function makeSceneCallbacks() {
  return {
    onProgress: (placed, correct, total) => {
      arProgress.textContent = `${placed} / ${total} contas · ${correct} corretas`;
      arProgressFill.style.width = `${total > 0 ? (correct / total) * 100 : 0}%`;
      if (total > 0) setMusicIntensity(correct / total);
      const done = total > 0 && correct === total;
      if (done && currentPattern?.name) markCompleted(currentPattern.name);
      if (done) triggerMusicFlourish();
      if (done && !advancingChallenge) advanceChallenge();
    },
    onHint: (text) => { arHint.textContent = text; },
    onExit: () => {
      // Durante o avanço automático de nível, o próprio advanceChallenge já
      // controla a troca de tela — não deixa esse onExit (disparado pela
      // saída/reentrada da sessão) voltar pro menu no meio.
      if (advancingChallenge) return;
      winScreen.hidden = true;
      arScreen.hidden = true;
      openMenu();
    },
    onPlayAgain: () => window.location.reload(),
  };
}

async function enterGame() {
  primeAudio(); // precisa ser chamado a partir de um clique/gesto de verdade pra destravar o áudio
  startMusic();
  try {
    arScreen.hidden = false;
    flipCameraBtn.hidden = false;
    await startWebcam(currentPattern, makeSceneCallbacks(), arScreen, challengeIndex);
  } catch (err) {
    console.error('Falha ao iniciar:', err);
    alert('Não foi possível iniciar: ' + err.message);
    arScreen.hidden = true;
    openMenu();
  }
}

// Ao completar um nível: sai da sessão atual, carrega o próximo desenho (mais
// difícil, ainda dentro da mesma categoria) e entra de novo automaticamente.
async function advanceChallenge() {
  advancingChallenge = true;
  const isLast = challengeIndex >= challengeOrder.length - 1;
  if (isLast) {
    arHint.textContent = 'Você completou todos os níveis! 🎉';
    winScreen.hidden = false; // só o confete decorativo — texto/botão ficam no canvas (showCategoryComplete)
    showCategoryComplete();
    advancingChallenge = false; // deixa "◀ Voltar" continuar funcionando por baixo da tela de vitória
    return;
  }
  arHint.textContent = 'Nível concluído! Preparando o próximo...';
  await new Promise((resolve) => setTimeout(resolve, 1800));

  challengeIndex++;
  currentPattern = challengeOrder[challengeIndex];
  updateChallengeUI();

  exitWebcam();

  advancingChallenge = false; // precisa cair antes do enterGame reengatar makeSceneCallbacks
  await enterGame();
}

exitArBtn.addEventListener('click', exitWebcam);

flipCameraBtn.addEventListener('click', flipCamera);
menuFlipCameraBtn.addEventListener('click', flipCamera);
