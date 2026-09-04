const listeners = new Set<() => void>();
let deletedDocName: string | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

export function markNoteWindowDocDeleted(docName: string): boolean {
  if (deletedDocName === docName) return true;
  deletedDocName = docName;
  emit();
  return true;
}

export function getNoteWindowDeletedDoc(): string | null {
  return deletedDocName;
}

export function subscribeNoteWindowDeleted(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetNoteWindowDeletedForTests(): void {
  deletedDocName = null;
  emit();
}
