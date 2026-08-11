import type { SkillScope } from '@inkeep/open-knowledge-core';

/**
 * The one pending "this skill is gitignored" prompt, module-level.
 *
 * The guard fires from `useOpenSkill` — the shared opener every surface routes
 * through (sidebar click, post-install redirect, adopt, deep link) — so it has
 * no dialog of its own to raise, and mounting one per surface would mean each
 * of them re-implementing the offer. One store plus one host mounted in `App`
 * keeps the answer identical wherever the open came from, which is the same
 * reason the install overlay lives in a store rather than component state.
 */
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
  // Deleting from a Set mid-iteration is safe (the entry is simply not
  // visited), so an unsubscribe during notify needs no defensive copy —
  // matching `skill-install-overlay-store`.
  for (const listener of listeners) listener();
}

/** Ask the host to explain why this skill can't open, and offer the fix. */
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

/** Test seam — a leaked prompt would make the next test render a stray dialog. */
export function __resetSkillTrackPromptForTests(): void {
  pending = null;
  listeners.clear();
}
