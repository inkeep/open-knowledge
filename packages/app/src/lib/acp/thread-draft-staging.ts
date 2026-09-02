const pending = new Map<string, string>();

const listeners = new Map<string, (text: string) => void>();

export function stageThreadDraft(threadId: string, text: string): void {
  if (text.trim() === '') return;
  const listener = listeners.get(threadId);
  if (listener !== undefined) {
    listener(text);
    return;
  }
  pending.set(threadId, text);
}

export function subscribeStagedThreadDraft(
  threadId: string,
  onDraft: (text: string) => void,
): () => void {
  listeners.set(threadId, onDraft);
  const held = pending.get(threadId);
  if (held !== undefined) {
    pending.delete(threadId);
    onDraft(held);
  }
  return () => {
    if (listeners.get(threadId) === onDraft) listeners.delete(threadId);
  };
}

export function resetStagedThreadDrafts(): void {
  pending.clear();
  listeners.clear();
}
