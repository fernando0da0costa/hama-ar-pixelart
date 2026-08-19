// Progresso do modo desafio salvo no navegador (localStorage) — quais
// formas já foram completadas 100% certas, pra marcar na grade de seleção
// (grade fica visível de novo mesmo depois de fechar e abrir o navegador) e
// permitir retomar do próximo nível não feito em vez de sempre recomeçar do
// nível 1.

const STORAGE_KEY = 'hama-ar:progress:v1';

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { completed: [] };
    const data = JSON.parse(raw);
    return { completed: Array.isArray(data.completed) ? data.completed : [] };
  } catch {
    return { completed: [] };
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
