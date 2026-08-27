// Progresso do modo desafio salvo no navegador (localStorage) — quais
// formas já foram completadas 100% certas, pra marcar na grade de seleção
// (grade fica visível de novo mesmo depois de fechar e abrir o navegador) e
// permitir retomar do próximo nível não feito em vez de sempre recomeçar do
// nível 1.

const STORAGE_KEY = 'hama-ar:progress:v1';

// Quantas miniaturas concluídas guardar no total — a lista mostra só as 3
// mais recentes, mas guarda algumas a mais no histórico completo (cada
// miniatura em base64 pesa uns KB, então não deixa crescer sem limite).
const HISTORY_LIMIT = 15;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { completed: [], history: [] };
    const data = JSON.parse(raw);
    return {
      completed: Array.isArray(data.completed) ? data.completed : [],
      history: Array.isArray(data.history) ? data.history : [],
    };
  } catch {
    return { completed: [], history: [] };
  }
}

let state = load();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage indisponível (aba anônima, quota cheia etc.) — degrada
    // silenciosamente pra "sem memória entre sessões", sem quebrar o app.
  }
}

// shapeName é o nome da forma (p.ex. "Coração", "A", "Quadrado 1×1") — único
// dentro de SHAPES, serve como chave simples sem precisar de um id à parte.
export function isCompleted(shapeName) {
  return state.completed.includes(shapeName);
}

export function markCompleted(shapeName) {
  if (!state.completed.includes(shapeName)) {
    state.completed.push(shapeName);
    persist();
  }
}

export function completedCount() {
  return state.completed.length;
}

// Guarda uma miniatura (dataURL PNG) de um desenho recém-concluído — mais
// recente primeiro. Serve tanto pra lista "últimas concluídas" da tela de
// setup quanto pra deixar o usuário baixar aquela imagem específica depois,
// sem precisar ter aquele desenho aberto de novo.
export function addHistoryEntry({ name, dataUrl, w, h, totalBeads }) {
  state.history.unshift({ name, dataUrl, w, h, totalBeads, at: Date.now() });
  state.history = state.history.slice(0, HISTORY_LIMIT);
  persist();
}

export function getRecentHistory(n = 3) {
  return state.history.slice(0, n);
}
