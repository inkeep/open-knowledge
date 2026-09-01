import type { EditorActiveTargetSnapshot } from '../shared/ipc-channels.ts';

export function createEmptyActiveTarget(): EditorActiveTargetSnapshot {
  return { kind: null };
}

export class EditorActiveTargetRegistry {
  readonly #targets = new Map<number, EditorActiveTargetSnapshot>();
  #selectedWindowId: number | null = null;

  update(windowId: number, target: EditorActiveTargetSnapshot): void {
    this.#targets.set(windowId, target);
    this.#selectedWindowId = windowId;
  }

  get(windowId: number): EditorActiveTargetSnapshot {
    return this.#targets.get(windowId) ?? createEmptyActiveTarget();
  }

  current(focusedWindowId: number | null = null): EditorActiveTargetSnapshot {
    const windowId = focusedWindowId ?? this.#selectedWindowId;
    return windowId === null ? createEmptyActiveTarget() : this.get(windowId);
  }

  delete(windowId: number): void {
    this.#targets.delete(windowId);
    if (this.#selectedWindowId === windowId) this.#selectedWindowId = null;
  }
}

export function docNameFromActiveTarget(target: EditorActiveTargetSnapshot): string | null {
  return target.kind === 'doc' && target.identifier.length > 0 ? target.identifier : null;
}
