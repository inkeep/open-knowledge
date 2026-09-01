import type {
  FileContents,
  FileDiffMetadata,
  MergeConflictMarkerRow,
  UnresolvedFile,
} from '@pierre/diffs';

type ResolveReturn = NonNullable<ReturnType<UnresolvedFile['resolveConflict']>>;

export interface ConflictSnapshot {
  file: FileContents;
  fileDiff?: FileDiffMetadata;
  actions?: ResolveReturn['actions'];
  markerRows?: MergeConflictMarkerRow[];
}

// Memory cost per entry ≈ 2.4× the file size (diff model line arrays + file
// string). Cap of 50 entries × 2.4 × 100 KB file ≈ 12 MB worst-case.
const MAX_DEPTH = 50;

export class ConflictHistory {
  private readonly stack: ConflictSnapshot[];
  private idx: number;

  constructor(initial: ConflictSnapshot) {
    this.stack = [initial];
    this.idx = 0;
  }

  get current(): ConflictSnapshot {
    const entry = this.stack[this.idx];
    if (!entry) throw new Error('ConflictHistory: stack is empty — invariant violated');
    return entry;
  }

  get canUndo(): boolean {
    return this.idx > 0;
  }

  get canRedo(): boolean {
    return this.idx < this.stack.length - 1;
  }

  push(snapshot: ConflictSnapshot): void {
    this.stack.splice(this.idx + 1);
    this.stack.push(snapshot);
    this.idx++;
    // Preserve the initial entry; trim oldest resolved entries when over cap.
    if (this.stack.length > MAX_DEPTH + 1) {
      this.stack.splice(1, this.stack.length - MAX_DEPTH - 1);
      this.idx = this.stack.length - 1;
    }
  }

  // Backfills the initial stack entry (index 0) with the full computed snapshot
  // once Pierre has synchronously populated its computedCache after the first render.
  // Required so rerenderAndRestore() can pass fileDiff+actions to forceRender when
  // the user undoes all the way back to the initial state.
  reset(initial: ConflictSnapshot): void {
    this.stack[0] = initial;
  }

  undo(): ConflictSnapshot | null {
    if (!this.canUndo) return null;
    this.idx--;
    return this.stack[this.idx] ?? null;
  }

  redo(): ConflictSnapshot | null {
    if (!this.canRedo) return null;
    this.idx++;
    return this.stack[this.idx] ?? null;
  }
}
