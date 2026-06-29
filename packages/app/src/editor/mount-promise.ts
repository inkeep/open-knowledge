
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { Editor } from '@tiptap/core';
import type * as Y from 'yjs';
import { mark } from '@/lib/perf';
import { readNumericOverride } from '@/lib/perf/env-override';
import { emitColdMountChild, finalizeColdMountSpan } from '@/lib/perf/otel-spans';
import '@/lib/perf/scheduler-polyfill-shim';
import {
  mountTiptapEditor,
  peekTiptap,
  readEditorUndoManager,
  type TiptapCacheEntry,
} from './editor-cache';


interface ConstructedTiptapBundle {
  editor: Editor;
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
}

interface MountTiptapEditorPromiseParams {
  docName: string;
  mountId: string;
  construct: () => ConstructedTiptapBundle;
  sizeStats?: { viewCount: number; bytes: number };
}

export class MountAbortError extends Error {
  readonly docName: string;
  constructor(docName: string) {
    super(`Mount aborted for "${docName}"`);
    this.name = 'MountAbortError';
    this.docName = docName;
  }
}

function getStalledThresholdMs(): number {
  return readNumericOverride('MOUNT_STALLED_THRESHOLD_MS', 10_000);
}


interface MountPromiseEntry {
  promise: Promise<TiptapCacheEntry>;
  rejectFn: (error: Error) => void;
  controller: AbortController;
  mountId: string;
  createdAt: number;
  settled: boolean;
  resolved: boolean;
  preMountEditor: Editor | null;
  stalledHandle: ReturnType<typeof setTimeout> | null;
  stalledMarkEmitted: boolean;
}

function clearStalledTimer(entry: MountPromiseEntry): void {
  if (entry.stalledHandle !== null) {
    clearTimeout(entry.stalledHandle);
    entry.stalledHandle = null;
  }
}

function emitStalledOnce(entry: MountPromiseEntry, docName: string, now: number): void {
  if (entry.stalledMarkEmitted) return;
  entry.stalledMarkEmitted = true;
  const elapsed = now - entry.createdAt;
  mark('ok/mount/stalled', {
    docName,
    mountId: entry.mountId,
    elapsedMs: elapsed,
  });
}

const cache = new Map<string, MountPromiseEntry>();


type StalledSubscriber = (docName: string, mountId: string) => void;
const stalledSubscribers = new Set<StalledSubscriber>();

export function subscribeMountStalled(callback: StalledSubscriber): () => void {
  stalledSubscribers.add(callback);
  for (const [docName, entry] of cache) {
    if (entry.stalledMarkEmitted && !entry.settled) {
      try {
        callback(docName, entry.mountId);
      } catch {
      }
    }
  }
  return () => {
    stalledSubscribers.delete(callback);
  };
}

function fanOutStalled(docName: string, entry: MountPromiseEntry): void {
  for (const sub of stalledSubscribers) {
    try {
      sub(docName, entry.mountId);
    } catch {
    }
  }
}


let visibilityHandlerInstalled = false;

function visibilityHandler(): void {
  if (typeof document === 'undefined') return;
  if (document.visibilityState !== 'visible') return;
  __reapStalledOnVisible(Date.now());
}

function installVisibilityHandler(): void {
  if (visibilityHandlerInstalled) return;
  if (typeof document === 'undefined') return;
  if (typeof document.addEventListener !== 'function') return;
  document.addEventListener('visibilitychange', visibilityHandler);
  visibilityHandlerInstalled = true;
}

function uninstallVisibilityHandler(): void {
  if (!visibilityHandlerInstalled) return;
  if (typeof document === 'undefined') return;
  if (typeof document.removeEventListener !== 'function') return;
  document.removeEventListener('visibilitychange', visibilityHandler);
  visibilityHandlerInstalled = false;
}

export function __reapStalledOnVisible(now: number): void {
  const threshold = getStalledThresholdMs();
  for (const [docName, entry] of cache) {
    if (entry.settled) continue;
    if (entry.stalledMarkEmitted) continue;
    if (now - entry.createdAt < threshold) continue;
    emitStalledOnce(entry, docName, now);
    fanOutStalled(docName, entry);
  }
}


export function mountTiptapEditorPromise(
  params: MountTiptapEditorPromiseParams,
): Promise<TiptapCacheEntry> {
  const { docName, mountId, construct, sizeStats } = params;

  const existing = cache.get(docName);
  if (existing) return existing.promise;

  const controller = new AbortController();
  const createdAt = Date.now();
  let resolveFn: (entry: TiptapCacheEntry) => void = () => {};
  let rejectFn: (error: Error) => void = () => {};
  const promise = new Promise<TiptapCacheEntry>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  const entry: MountPromiseEntry = {
    promise,
    rejectFn,
    controller,
    mountId,
    createdAt,
    settled: false,
    resolved: false,
    preMountEditor: null,
    stalledHandle: null,
    stalledMarkEmitted: false,
  };

  entry.stalledHandle = setTimeout(() => {
    if (entry.settled) return;
    emitStalledOnce(entry, docName, Date.now());
    fanOutStalled(docName, entry);
  }, getStalledThresholdMs());

  controller.signal.addEventListener('abort', () => {
    if (entry.settled) return;
    entry.settled = true;
    clearStalledTimer(entry);
    if (entry.preMountEditor) {
      destroyPreMountEditor(docName, entry.preMountEditor, 'aborted');
      entry.preMountEditor = null;
    }
    cache.delete(docName);
    if (cache.size === 0) uninstallVisibilityHandler();
    mark('ok/mount/reject', { docName, mountId: entry.mountId, reason: 'aborted' });
    rejectFn(new MountAbortError(docName));
    finalizeColdMountSpan(entry.mountId);
  });

  cache.set(docName, entry);
  installVisibilityHandler();
  mark('ok/mount/create', { docName, mountId: entry.mountId });

  runMountBody({
    docName,
    construct,
    sizeStats,
    entry,
    resolveFn,
    rejectFn,
  }).catch((err) => {
    if (entry.preMountEditor) {
      destroyPreMountEditor(docName, entry.preMountEditor, 'backstop');
      entry.preMountEditor = null;
    }
    if (entry.settled) {
      mark('ok/mount/post-settle-throw', {
        docName,
        mountId: entry.mountId,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    entry.settled = true;
    clearStalledTimer(entry);
    const wrapped = err instanceof Error ? err : new Error(String(err));
    mark('ok/mount/reject', {
      docName,
      mountId: entry.mountId,
      reason: 'unhandled-body-throw',
      message: wrapped.message,
    });
    rejectFn(wrapped);
    finalizeColdMountSpan(entry.mountId);
  });

  return promise;
}

export function mountPromiseHasResolved(docName: string): boolean {
  return cache.get(docName)?.resolved === true;
}

export function getMountAbortController(docName: string): AbortController | null {
  return cache.get(docName)?.controller ?? null;
}

export function invalidateMountPromise(docName: string): void {
  const entry = cache.get(docName);
  if (!entry) return;
  entry.settled = true;
  clearStalledTimer(entry);
  if (entry.preMountEditor) {
    destroyPreMountEditor(docName, entry.preMountEditor, 'aborted');
    entry.preMountEditor = null;
  }
  cache.delete(docName);
  if (cache.size === 0) uninstallVisibilityHandler();
  mark('ok/mount/invalidate', { docName, mountId: entry.mountId });
  finalizeColdMountSpan(entry.mountId);
  entry.controller.abort();
}


interface MountBodyParams {
  docName: string;
  construct: () => ConstructedTiptapBundle;
  sizeStats?: { viewCount: number; bytes: number };
  entry: MountPromiseEntry;
  resolveFn: (entry: TiptapCacheEntry) => void;
  rejectFn: (error: Error) => void;
}

/**
 * Destroy a pre-mount editor with the same UndoManager-restore cleanup that
 * `editor-cache.ts` applies at park / evict (precedent #18(c) leak-cleanup).
 * Capturing the UndoManager BEFORE `editor.destroy()` is required because
 * `editor.state` is only safely readable while the editor is alive; clearing
 * `restore` AFTER destroy breaks the @tiptap/extension-collaboration closure
 * that retains the full editor graph (~30 MB per cycle on multi-MB docs).
 *
 * Idempotent on pre-mount editors per TipTap source verification. Emits a
 * telemetry mark on destroy() failure so a regression in TipTap's pre-mount-
 * destroy idempotency surfaces in traces rather than vanishing — mirrors
 * `editor-cache.ts`'s `ok/cache/evict-failed` discipline.
 */
function destroyPreMountEditor(
  docName: string,
  editor: Editor,
  stage: 'aborted' | 'mount-failed' | 'v2-register-failed' | 'backstop',
): void {
  const undoManager = readEditorUndoManager(editor);
  try {
    editor.destroy();
  } catch (err) {
    mark('ok/mount/destroy-failed', {
      docName,
      stage,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (undoManager) {
    undoManager.restore = undefined;
  }
}

async function runMountBody(params: MountBodyParams): Promise<void> {
  const { docName, construct, sizeStats, entry, resolveFn, rejectFn } = params;

  const transient = document.createElement('div');

  if (peekTiptap(docName) !== undefined) {
    const v2HitEntry = mountTiptapEditor({
      docName,
      container: transient as unknown as HTMLElement,
      factory: () => {
        throw new Error(
          `mount-promise: V2 cache contract violation — factory invoked on HIT for "${docName}"`,
        );
      },
    });
    entry.settled = true;
    entry.resolved = true;
    clearStalledTimer(entry);
    resolveFn(v2HitEntry);
    return;
  }


  await scheduler.yield();

  if (entry.controller.signal.aborted) {
    return;
  }

  let constructed: ConstructedTiptapBundle | null = null;
  try {
    constructed = construct();
  } catch (err) {
    entry.settled = true;
    clearStalledTimer(entry);
    const wrapped = err instanceof Error ? err : new Error(String(err));
    mark('ok/mount/reject', {
      docName,
      mountId: entry.mountId,
      reason: 'construct-failed',
      message: wrapped.message,
    });
    rejectFn(wrapped);
    finalizeColdMountSpan(entry.mountId);
    return;
  }
  entry.preMountEditor = constructed.editor;

  await scheduler.yield();

  if (entry.controller.signal.aborted) {
    entry.preMountEditor = null;
    return;
  }

  try {
    constructed.editor.mount(transient);
  } catch (err) {
    destroyPreMountEditor(docName, constructed.editor, 'mount-failed');
    entry.preMountEditor = null;
    entry.settled = true;
    clearStalledTimer(entry);
    const wrapped = err instanceof Error ? err : new Error(String(err));
    mark('ok/mount/reject', {
      docName,
      mountId: entry.mountId,
      reason: 'mount-failed',
      message: wrapped.message,
    });
    rejectFn(wrapped);
    finalizeColdMountSpan(entry.mountId);
    return;
  }

  let v2MissEntry: TiptapCacheEntry;
  try {
    v2MissEntry = mountTiptapEditor({
      docName,
      container: transient as unknown as HTMLElement,
      sizeStats,
      factory: () => constructed,
    });
  } catch (err) {
    destroyPreMountEditor(docName, constructed.editor, 'v2-register-failed');
    entry.preMountEditor = null;
    entry.settled = true;
    clearStalledTimer(entry);
    const wrapped = err instanceof Error ? err : new Error(String(err));
    mark('ok/mount/reject', {
      docName,
      mountId: entry.mountId,
      reason: 'v2-register-failed',
      message: wrapped.message,
    });
    rejectFn(wrapped);
    finalizeColdMountSpan(entry.mountId);
    return;
  }

  entry.preMountEditor = null;
  entry.settled = true;
  entry.resolved = true;
  clearStalledTimer(entry);
  const elapsed = Date.now() - entry.createdAt;
  mark('ok/mount/resolve', {
    docName,
    mountId: entry.mountId,
    elapsedMs: elapsed,
  });
  mark.histogram('ok/mount/resolve-elapsed-ms', { docName, mountId: entry.mountId }, elapsed);
  resolveFn(v2MissEntry);
  const nowMs = Date.now();
  emitColdMountChild(
    entry.mountId,
    'ok.mount-promise',
    { 'doc.name': docName, elapsed_ms: elapsed },
    entry.createdAt,
    nowMs,
  );
  finalizeColdMountSpan(entry.mountId, nowMs);
}


export function __resetMountPromiseCache(): void {
  for (const entry of cache.values()) {
    entry.settled = true;
    clearStalledTimer(entry);
    entry.controller.abort();
  }
  cache.clear();
  stalledSubscribers.clear();
  uninstallVisibilityHandler();
}

export function __mountPromiseSettled(docName: string): boolean {
  return cache.get(docName)?.settled ?? false;
}

export function __mountPromiseCacheSize(): number {
  return cache.size;
}

export function __mountPromiseStalledEmitted(docName: string): boolean {
  return cache.get(docName)?.stalledMarkEmitted ?? false;
}

export function __mountPromiseVisibilityHandlerInstalled(): boolean {
  return visibilityHandlerInstalled;
}
