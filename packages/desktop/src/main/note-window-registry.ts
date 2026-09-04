export type NoteWindowEntryPoint = 'tab-menu' | 'palette' | 'window-menu';

export interface NoteWindowContext {
  readonly projectRoot: string;
  readonly collabUrl: string;
  readonly apiOrigin: string;
  readonly currentDocName: string;
}

interface NoteWindowRecord {
  readonly projectRoot: string;
  readonly collabUrl: string;
  readonly apiOrigin: string;
  currentDocName: string;
  touchSeq: number;
}

const noteWindows = new Map<number, NoteWindowRecord>();
let touchCounter = 0;

export function registerNoteWindow(windowId: number, context: NoteWindowContext): void {
  touchCounter += 1;
  noteWindows.set(windowId, { ...context, touchSeq: touchCounter });
}

export function getNoteWindowContext(windowId: number): NoteWindowContext | undefined {
  const record = noteWindows.get(windowId);
  if (!record) return undefined;
  const { touchSeq: _touchSeq, ...context } = record;
  return context;
}

export function unregisterNoteWindow(windowId: number): void {
  noteWindows.delete(windowId);
}

export function setNoteWindowDoc(windowId: number, docName: string): boolean {
  const record = noteWindows.get(windowId);
  if (!record) return false;
  record.currentDocName = docName;
  return true;
}

export function touchNoteWindow(windowId: number): void {
  const record = noteWindows.get(windowId);
  if (!record) return;
  touchCounter += 1;
  record.touchSeq = touchCounter;
}

export function findNoteWindowForDoc(projectRoot: string, docName: string): number | undefined {
  let bestId: number | undefined;
  let bestSeq = -1;
  for (const [windowId, record] of noteWindows) {
    if (record.projectRoot !== projectRoot) continue;
    if (record.currentDocName !== docName) continue;
    if (record.touchSeq > bestSeq) {
      bestSeq = record.touchSeq;
      bestId = windowId;
    }
  }
  return bestId;
}

export function listNoteWindowsForProject(projectRoot: string): number[] {
  return [...noteWindows.entries()]
    .filter(([, record]) => record.projectRoot === projectRoot)
    .sort((a, b) => a[1].touchSeq - b[1].touchSeq)
    .map(([windowId]) => windowId);
}

export function listNoteWindows(): Array<{ windowId: number; context: NoteWindowContext }> {
  return [...noteWindows.entries()]
    .sort((a, b) => a[1].touchSeq - b[1].touchSeq)
    .map(([windowId, record]) => {
      const { touchSeq: _touchSeq, ...context } = record;
      return { windowId, context };
    });
}

export function __resetNoteWindowRegistryForTests(): void {
  noteWindows.clear();
  touchCounter = 0;
}
