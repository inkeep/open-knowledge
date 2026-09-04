import type { SkillScope } from '@inkeep/open-knowledge-core';

export interface SkillTrackPrompt {
  scope: SkillScope;
  name: string;
}

let pending: SkillTrackPrompt | null = null;
const listeners = new Set<() => void>();

export function getSkillTrackPrompt(): SkillTrackPrompt | null {
  return pending;
}

export function subscribeToSkillTrackPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function requestSkillTrackPrompt(prompt: SkillTrackPrompt): void {
  if (pending !== null && pending.scope === prompt.scope && pending.name === prompt.name) {
    return;
  }
  pending = prompt;
  notify();
}

export function clearSkillTrackPrompt(): void {
  if (pending === null) return;
  pending = null;
  notify();
}

export function __resetSkillTrackPromptForTests(): void {
  pending = null;
  listeners.clear();
}
