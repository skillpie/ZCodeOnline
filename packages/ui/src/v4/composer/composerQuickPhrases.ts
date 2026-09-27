import { useSyncExternalStore } from "react";

export interface ComposerQuickPhrase {
  id: string;
  text: string;
}

const STORAGE_KEY = "zcode:composer:quick-phrases";
const EMPTY: readonly ComposerQuickPhrase[] = [];

let cache: readonly ComposerQuickPhrase[] | null = null;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

function parsePhrases(raw: unknown): readonly ComposerQuickPhrase[] {
  if (!Array.isArray(raw)) return EMPTY;
  const phrases: ComposerQuickPhrase[] = [];
  for (const item of raw) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as ComposerQuickPhrase).id === "string" &&
      typeof (item as ComposerQuickPhrase).text === "string" &&
      (item as ComposerQuickPhrase).text.trim().length > 0
    ) {
      phrases.push(item as ComposerQuickPhrase);
    }
  }
  return phrases;
}

function readStorage(): readonly ComposerQuickPhrase[] {
  // 隐私模式 / 存储被禁用时降级为内存态：本实例可用、不持久化、不报错。
  try {
    if (typeof window === "undefined" || typeof localStorage === "undefined") {
      return EMPTY;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    return parsePhrases(JSON.parse(raw) as unknown);
  } catch {
    return EMPTY;
  }
}

function persist(phrases: readonly ComposerQuickPhrase[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(phrases));
  } catch {
    // 忽略写入失败（配额 / 禁用），内存态继续生效。
  }
}

function commit(next: readonly ComposerQuickPhrase[]): void {
  cache = next;
  persist(next);
  emitChange();
}

export function subscribeComposerQuickPhrases(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getComposerQuickPhrases(): readonly ComposerQuickPhrase[] {
  cache ??= readStorage();
  return cache;
}

export function addComposerQuickPhrase(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  commit([...getComposerQuickPhrases(), { id: crypto.randomUUID(), text: trimmed }]);
}

export function removeComposerQuickPhrase(id: string): void {
  const current = getComposerQuickPhrases();
  const next = current.filter((phrase) => phrase.id !== id);
  if (next.length === current.length) return;
  commit(next);
}

export function useComposerQuickPhrases(): readonly ComposerQuickPhrase[] {
  return useSyncExternalStore(subscribeComposerQuickPhrases, getComposerQuickPhrases, () => EMPTY);
}
