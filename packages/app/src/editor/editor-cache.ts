/**
 * V2 editor cache — module-level `Map<docName, Entry>` that survives React
 * unmount, SPA navigation, Activity mode flips, StrictMode double-invoke, HMR.
 *
 * Contract (precedent #27(a)):
 *
 *   mount{Tiptap,Cm}Editor({ docName, container, factory })
 *     — CACHE HIT: reparent editor.editorView.dom / view.dom into `container`,
 *       restore scrollTop + focus, set activeMountKey = docName.
 *     — CACHE MISS: factory(container) constructs a fresh editor that mounts
 *       itself into container; the returned tuple is cached.
 *     — CACHE_ENABLED=false: always calls factory, never caches (pre-V2 path).
 *
 *   park{Tiptap,Cm}Editor(entry)
 *     — detach DOM from parent, capture scrollTop, clear activeMountKey.
 *       NEVER destroys. Editor keeps running — local Y.js observers still
 *       fire, plugin state survives, only DOM painting stops.
 *     — CACHE_ENABLED=false: destroys (restores pre-V2 destroy-on-unmount
 *       semantic — the consumer's cleanup path still runs).
 *
 *   evict{Tiptap,Cm}Editor(docName)
 *     — THE ONLY PATH that calls provider.destroy() / ydoc.destroy().
 *       editor.destroy() / view.destroy() are also called on the
 *       __uncached / kill-switch park branch (see park{Tiptap,Cm}Editor).
 *       Called on LRU eviction (MAX_CACHE) or explicit tear-down.
 *
 * Why raw `editor.editorView.dom` reparent and NOT `Editor.mount()/unmount()`:
 *   @tiptap/extension-drag-handle@4.x captures the `editor` ref in a plugin
 *   closure, reads `editor.view.dom.parentElement` from the `view(view)`
 *   lifecycle callback, and hits TipTap's throwing-proxy during the
 *   re-create path (the proxy throws while the new `EditorView` is
 *   mid-construction). STOP rule: this module MUST NOT call `editor.mount()`
 *   or `editor.unmount()`.
 *
 * Why CM6 uses the symmetric pattern: `EditorView.setRoot()` is only needed
 *   for cross-Document reparent (iframe/ShadowRoot); within-Document reparent
 *   needs no API call at all — W3C DOM observers (Mutation / Resize /
 *   Intersection) survive reparent by spec.
 *
 * Emergency kill switch: flip `CACHE_ENABLED = false`,
 *   redeploy. mount() short-circuits to factory-only (no storage); park()
 *   destroys immediately. This is NOT a feature flag — no config system, no
 *   rollout percentage, no user targeting. One-line edit for fire-drill
 *   rollback during a production incident.
 */

import type { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { RenamedDocMapping } from '@inkeep/open-knowledge-core';
import { isMarkdownDocFile } from '@inkeep/open-knowledge-core';
import type { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import { mark } from '@/lib/perf';
import { readNumericOverride } from '@/lib/perf/env-override';
import { unregisterSourceView } from './active-source-view';
import { getMountId } from './mount-id-registry';
import { invalidateMountPromise } from './mount-promise';
import { scrollSuppressionHolder } from './scroll-restore-coordination';

export function readEditorUndoManager(editor: Editor): { restore?: unknown } | null {
  try {
    const state = editor.state;
    const pluginState = yUndoPluginKey.getState(state) as
      | { undoManager?: { restore?: unknown } }
      | null
      | undefined;
    return pluginState?.undoManager ?? null;
  } catch (err) {
    mark('ok/cache/undo-manager-read-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export const CACHE_ENABLED = true;

export const MAX_CACHE = readNumericOverride('MAX_CACHE', 10);

export const VIEW_COUNT_CACHE_THRESHOLD = readNumericOverride('VIEW_COUNT_CACHE_THRESHOLD', 50);

export const BYTES_CACHE_THRESHOLD = readNumericOverride('BYTES_CACHE_THRESHOLD', 8_000_000);

interface SizeStats {
  viewCount: number;
  bytes: number;
}

export function shouldCacheEditor(stats: SizeStats): boolean {
  if (stats.viewCount > 0 && stats.viewCount >= VIEW_COUNT_CACHE_THRESHOLD) return false;
  if (stats.bytes > BYTES_CACHE_THRESHOLD) return false;
  return true;
}

export interface TiptapCacheEntry {
  editor: Editor;
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
  scrollTop: number;
  hadFocus: boolean;
  activeMountKey: string | null;
  parkingNode: HTMLElement | null;
  __uncached?: boolean;
}

export interface CmCacheEntry {
  view: EditorView;
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
  /**
   * The theme `Compartment` embedded in `view` at construction. Stored on the
   * entry — NOT held per React component — because the view is cached and
   * reparented across Activity flips while its consuming `SourceEditor`
   * component remounts (precedent #27(a)). A per-component compartment would
   * not be part of the reused view's config, so a theme-change reconfigure
   * dispatched against it is a silent no-op and the cached view keeps the
   * theme it was built with (stale syntax highlight after a dark/light toggle
   * on backgrounded docs). Consumers reconfigure THIS compartment.
   */
  themeCompartment: Compartment;
  wordWrapCompartment: Compartment;
  placeholderCompartment: Compartment;
  lintCompartment: Compartment;
  scrollTop: number;
  hadFocus: boolean;
  activeMountKey: string | null;
  parkingNode: HTMLElement | null;
  __uncached?: boolean;
}

interface TiptapFactoryResult {
  editor: Editor;
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
}

type TiptapFactory = (container: HTMLElement) => TiptapFactoryResult;

interface CmFactoryResult {
  view: EditorView;
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
  themeCompartment: Compartment;
  wordWrapCompartment: Compartment;
  placeholderCompartment: Compartment;
  lintCompartment: Compartment;
}

type CmFactory = (container: HTMLElement) => CmFactoryResult;

interface MountTiptapParams {
  docName: string;
  container: HTMLElement;
  factory: TiptapFactory;
  sizeStats?: SizeStats;
}

interface MountCmParams {
  docName: string;
  container: HTMLElement;
  factory: CmFactory;
  sizeStats?: SizeStats;
}

const tiptapCache = new Map<string, TiptapCacheEntry>();
const cmCache = new Map<string, CmCacheEntry>();

export type RenameSelectionJSON =
  | { type: 'text'; anchor: number; head: number }
  | { type: 'node'; from: number };

export interface RenameSnapshot {
  html: string;
  scrollTop: number;
  selection: RenameSelectionJSON | null;
}

const renameSnapshotStore = new Map<string, RenameSnapshot>();

export function storeRenameSnapshot(toDocName: string, snapshot: RenameSnapshot): void {
  if (renameSnapshotStore.size >= MAX_CACHE) {
    const oldest = renameSnapshotStore.keys().next().value;
    if (oldest !== undefined) renameSnapshotStore.delete(oldest);
  }
  renameSnapshotStore.set(toDocName, snapshot);
  mark('ok/cache/snapshot-stored', {
    toDocName,
    htmlBytes: snapshot.html.length,
    hasScroll: snapshot.scrollTop > 0,
    hasSelection: snapshot.selection !== null,
  });
}

export function peekRenameSnapshot(docName: string): RenameSnapshot | null {
  return renameSnapshotStore.get(docName) ?? null;
}

export function __consumeRenameSnapshot(docName: string): RenameSnapshot | null {
  const snapshot = renameSnapshotStore.get(docName) ?? null;
  renameSnapshotStore.delete(docName);
  mark('ok/cache/snapshot-consumed', {
    docName,
    hit: snapshot !== null,
    hasScroll: snapshot !== null && snapshot.scrollTop > 0,
    hasSelection: snapshot !== null && snapshot.selection !== null,
  });
  return snapshot;
}

export function clearRenameSnapshot(docName: string): void {
  const hadEntry = renameSnapshotStore.has(docName);
  if (!hadEntry) return;
  const snapshot = renameSnapshotStore.get(docName) ?? null;
  renameSnapshotStore.delete(docName);
  mark('ok/cache/snapshot-consumed', {
    docName,
    hit: snapshot !== null,
    hasScroll: snapshot !== null && snapshot.scrollTop > 0,
    hasSelection: snapshot !== null && snapshot.selection !== null,
  });
}

export function __resetRenameSnapshotStore(): void {
  renameSnapshotStore.clear();
}

export function visibleEditorScrollContainer(): HTMLDivElement | null {
  if (typeof document === 'undefined') return null;
  const containers = document.querySelectorAll<HTMLDivElement>(EDITOR_SCROLL_CONTAINER_SELECTOR);
  for (const el of containers) {
    if (el.getClientRects().length > 0) return el;
  }
  return null;
}

const EDITOR_SCROLL_CONTAINER_SELECTOR = '[data-testid="editor-scroll-container"]';

export function editorScrollContainerOf(el: Element): HTMLDivElement | null {
  return el.closest<HTMLDivElement>(EDITOR_SCROLL_CONTAINER_SELECTOR);
}

function readActiveScrollTop(): number {
  try {
    return visibleEditorScrollContainer()?.scrollTop ?? 0;
  } catch (err) {
    mark('ok/cache/snapshot-scroll-read-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

function captureSelection(editor: Editor): RenameSelectionJSON | null {
  try {
    const sel = editor.state.selection;
    if (sel instanceof TextSelection) {
      return { type: 'text', anchor: sel.anchor, head: sel.head };
    }
    if (sel instanceof NodeSelection) {
      return { type: 'node', from: sel.from };
    }
    return null;
  } catch (err) {
    mark('ok/cache/snapshot-selection-read-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function captureRenameSnapshots(renamed: readonly RenamedDocMapping[]): void {
  for (const renamedDoc of renamed) {
    try {
      const cachedEntry = peekTiptap(renamedDoc.fromDocName);
      if (cachedEntry && !cachedEntry.editor.isDestroyed) {
        if (cachedEntry.ytext.length === 0) {
          mark('ok/cache/snapshot-skipped-empty', {
            fromDocName: renamedDoc.fromDocName,
          });
          continue;
        }
        if (!isMarkdownDocFile(renamedDoc.toDocName)) {
          mark('ok/cache/snapshot-skipped-class-change', {
            fromDocName: renamedDoc.fromDocName,
            toDocName: renamedDoc.toDocName,
          });
          continue;
        }
        storeRenameSnapshot(renamedDoc.toDocName, {
          html: cachedEntry.editor.getHTML(),
          scrollTop: readActiveScrollTop(),
          selection: captureSelection(cachedEntry.editor),
        });
      } else {
        mark('ok/cache/snapshot-skipped', { fromDocName: renamedDoc.fromDocName });
      }
    } catch (err) {
      mark('ok/cache/snapshot-capture-failed', {
        fromDocName: renamedDoc.fromDocName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const tiptapLru: string[] = [];
const cmLru: string[] = [];

let activityMountList: ReadonlySet<string> = new Set();

function tryCreateParkingNode(): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const el = document.createElement('div');
  el.setAttribute('data-ok-editor-parking', '');
  el.style.display = 'none';
  el.style.position = 'absolute';
  el.style.left = '-99999px';
  return el;
}

export function mountTiptapEditor(params: MountTiptapParams): TiptapCacheEntry {
  const { docName, container, factory, sizeStats } = params;

  const gateRefuses = sizeStats ? !shouldCacheEditor(sizeStats) : false;
  if (!CACHE_ENABLED || gateRefuses) {
    const fresh = factory(container);
    mark('ok/cache/miss', {
      docName,
      mountId: getMountId(docName),
      viewCount: sizeStats?.viewCount ?? -1,
      bytes: sizeStats?.bytes ?? -1,
      reason: !CACHE_ENABLED ? 'kill-switch' : 'size-gate',
    });
    return {
      editor: fresh.editor,
      ydoc: fresh.ydoc,
      ytext: fresh.ytext,
      provider: fresh.provider,
      scrollTop: 0,
      hadFocus: false,
      activeMountKey: docName,
      parkingNode: null,
      __uncached: true,
    };
  }

  const reuse = tiptapCache.get(docName);
  if (reuse) {
    mark('ok/cache/reparent-start', {
      docName,
      mountId: getMountId(docName),
      kind: 'tiptap',
      viewCount: sizeStats?.viewCount ?? -1,
      bytes: sizeStats?.bytes ?? -1,
    });
    reparentTiptapDom(reuse, container);
    reuse.activeMountKey = docName;
    touchLru(tiptapLru, docName);
    if (scrollSuppressionHolder(docName) !== 'landing') container.scrollTop = reuse.scrollTop;
    if (reuse.hadFocus) {
      try {
        reuse.editor.commands.focus();
      } catch {}
    }
    mark('ok/cache/reparent-end', {
      docName,
      mountId: getMountId(docName),
      kind: 'tiptap',
      viewCount: sizeStats?.viewCount ?? -1,
      bytes: sizeStats?.bytes ?? -1,
    });
    mark('ok/cache/hit', { docName, mountId: getMountId(docName), kind: 'tiptap' });
    if (sizeStats) {
      mark('ok/cold/editor-mount-stats', {
        docName,
        mountId: getMountId(docName),
        viewCount: sizeStats.viewCount,
        bytes: sizeStats.bytes,
        cacheHit: true,
        kind: 'tiptap',
      });
    }
    return reuse;
  }

  while (tiptapCache.size >= MAX_CACHE) {
    const oldest = findEvictable(tiptapLru, docName);
    if (!oldest) break;
    evictTiptapEditor(oldest);
  }

  const fresh = factory(container);
  const entry: TiptapCacheEntry = {
    editor: fresh.editor,
    ydoc: fresh.ydoc,
    ytext: fresh.ytext,
    provider: fresh.provider,
    scrollTop: 0,
    hadFocus: false,
    activeMountKey: docName,
    parkingNode: null,
  };
  tiptapCache.set(docName, entry);
  touchLru(tiptapLru, docName);
  mark('ok/cache/miss', {
    docName,
    mountId: getMountId(docName),
    viewCount: sizeStats?.viewCount ?? -1,
    bytes: sizeStats?.bytes ?? -1,
    reason: 'cold',
    kind: 'tiptap',
  });
  if (sizeStats) {
    mark('ok/cold/editor-mount-stats', {
      docName,
      mountId: getMountId(docName),
      viewCount: sizeStats.viewCount,
      bytes: sizeStats.bytes,
      cacheHit: false,
      kind: 'tiptap',
    });
  }
  return entry;
}

export function parkTiptapEditor(entry: TiptapCacheEntry): void {
  const docName = entry.activeMountKey;
  if (!CACHE_ENABLED || entry.__uncached) {
    if (docName) {
      invalidateMountPromise(docName);
    }
    const undoManager = readEditorUndoManager(entry.editor);
    try {
      entry.editor.destroy();
    } catch (err) {
      mark('ok/cache/park-destroy-failed', {
        docName: docName ?? '',
        kind: 'tiptap',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (undoManager) {
      undoManager.restore = undefined;
    }
    entry.activeMountKey = null;
    return;
  }

  const view = getTiptapEditorView(entry.editor);
  if (view) {
    entry.hadFocus = computeHadFocus(view.dom);
    const scrollSrc = view.scrollDOM ?? view.dom.parentElement ?? view.dom;
    entry.scrollTop = (scrollSrc as HTMLElement).scrollTop ?? 0;
    const parent = view.dom.parentElement;
    if (parent) {
      parent.removeChild(view.dom);
    }
    entry.parkingNode ||= tryCreateParkingNode();
    if (entry.parkingNode) {
      entry.parkingNode.appendChild(view.dom);
    }
  }

  entry.activeMountKey = null;
}

export function evictTiptapEditor(docName: string): boolean {
  invalidateMountPromise(docName);
  const entry = tiptapCache.get(docName);
  if (!entry) return false;

  const undoManager = readEditorUndoManager(entry.editor);
  try {
    entry.editor.destroy();
  } catch (err) {
    mark('ok/cache/evict-failed', {
      docName,
      kind: 'tiptap',
      stage: 'editor',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (undoManager) {
    undoManager.restore = undefined;
  }
  try {
    entry.provider.destroy();
  } catch (err) {
    mark('ok/cache/evict-failed', {
      docName,
      kind: 'tiptap',
      stage: 'provider',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    entry.ydoc.destroy();
  } catch (err) {
    mark('ok/cache/evict-failed', {
      docName,
      kind: 'tiptap',
      stage: 'ydoc',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  tiptapCache.delete(docName);
  const lruIdx = tiptapLru.indexOf(docName);
  if (lruIdx !== -1) tiptapLru.splice(lruIdx, 1);
  mark('ok/cache/evict', { docName, kind: 'tiptap' });
  return true;
}

export function mountCmEditor(params: MountCmParams): CmCacheEntry {
  const { docName, container, factory, sizeStats } = params;

  const gateRefuses = sizeStats ? !shouldCacheEditor(sizeStats) : false;
  if (!CACHE_ENABLED || gateRefuses) {
    const fresh = factory(container);
    mark('ok/cache/miss', {
      docName,
      mountId: getMountId(docName),
      viewCount: sizeStats?.viewCount ?? -1,
      bytes: sizeStats?.bytes ?? -1,
      reason: !CACHE_ENABLED ? 'kill-switch' : 'size-gate',
      kind: 'cm',
    });
    return {
      view: fresh.view,
      ydoc: fresh.ydoc,
      ytext: fresh.ytext,
      provider: fresh.provider,
      themeCompartment: fresh.themeCompartment,
      wordWrapCompartment: fresh.wordWrapCompartment,
      placeholderCompartment: fresh.placeholderCompartment,
      lintCompartment: fresh.lintCompartment,
      scrollTop: 0,
      hadFocus: false,
      activeMountKey: docName,
      parkingNode: null,
      __uncached: true,
    };
  }

  const reuse = cmCache.get(docName);
  if (reuse) {
    mark('ok/cache/reparent-start', {
      docName,
      mountId: getMountId(docName),
      kind: 'cm',
      viewCount: sizeStats?.viewCount ?? -1,
      bytes: sizeStats?.bytes ?? -1,
    });
    reparentCmDom(reuse, container);
    reuse.activeMountKey = docName;
    touchLru(cmLru, docName);
    if (scrollSuppressionHolder(docName) !== 'landing') container.scrollTop = reuse.scrollTop;
    if (reuse.hadFocus) {
      try {
        reuse.view.focus();
      } catch {}
    }
    mark('ok/cache/reparent-end', {
      docName,
      mountId: getMountId(docName),
      kind: 'cm',
      viewCount: sizeStats?.viewCount ?? -1,
      bytes: sizeStats?.bytes ?? -1,
    });
    mark('ok/cache/hit', { docName, mountId: getMountId(docName), kind: 'cm' });
    if (sizeStats) {
      mark('ok/cold/editor-mount-stats', {
        docName,
        mountId: getMountId(docName),
        viewCount: sizeStats.viewCount,
        bytes: sizeStats.bytes,
        cacheHit: true,
        kind: 'cm',
      });
    }
    return reuse;
  }

  while (cmCache.size >= MAX_CACHE) {
    const oldest = findEvictable(cmLru, docName);
    if (!oldest) break;
    evictCmEditor(oldest);
  }

  const fresh = factory(container);
  const entry: CmCacheEntry = {
    view: fresh.view,
    ydoc: fresh.ydoc,
    ytext: fresh.ytext,
    provider: fresh.provider,
    themeCompartment: fresh.themeCompartment,
    wordWrapCompartment: fresh.wordWrapCompartment,
    placeholderCompartment: fresh.placeholderCompartment,
    lintCompartment: fresh.lintCompartment,
    scrollTop: 0,
    hadFocus: false,
    activeMountKey: docName,
    parkingNode: null,
  };
  cmCache.set(docName, entry);
  touchLru(cmLru, docName);
  mark('ok/cache/miss', {
    docName,
    mountId: getMountId(docName),
    viewCount: sizeStats?.viewCount ?? -1,
    bytes: sizeStats?.bytes ?? -1,
    reason: 'cold',
    kind: 'cm',
  });
  if (sizeStats) {
    mark('ok/cold/editor-mount-stats', {
      docName,
      mountId: getMountId(docName),
      viewCount: sizeStats.viewCount,
      bytes: sizeStats.bytes,
      cacheHit: false,
      kind: 'cm',
    });
  }
  return entry;
}

export function parkCmEditor(entry: CmCacheEntry): void {
  if (!CACHE_ENABLED || entry.__uncached) {
    try {
      entry.view.destroy();
    } catch (err) {
      mark('ok/cache/park-destroy-failed', {
        docName: entry.activeMountKey ?? '',
        kind: 'cm',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    entry.activeMountKey = null;
    return;
  }

  const dom = entry.view.dom;
  entry.hadFocus = computeHadFocus(dom as HTMLElement);
  const scrollSrc = entry.view.scrollDOM ?? dom;
  entry.scrollTop = (scrollSrc as HTMLElement).scrollTop ?? 0;
  const parent = dom.parentElement;
  if (parent) {
    parent.removeChild(dom);
  }
  entry.parkingNode ||= tryCreateParkingNode();
  if (entry.parkingNode) {
    entry.parkingNode.appendChild(dom);
  }
  entry.activeMountKey = null;
}

export function evictCmEditor(docName: string): boolean {
  const entry = cmCache.get(docName);
  if (!entry) return false;

  unregisterSourceView(docName, entry.view);

  try {
    entry.view.destroy();
  } catch (err) {
    mark('ok/cache/evict-failed', {
      docName,
      kind: 'cm',
      stage: 'view',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    entry.provider.destroy();
  } catch (err) {
    mark('ok/cache/evict-failed', {
      docName,
      kind: 'cm',
      stage: 'provider',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    entry.ydoc.destroy();
  } catch (err) {
    mark('ok/cache/evict-failed', {
      docName,
      kind: 'cm',
      stage: 'ydoc',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  cmCache.delete(docName);
  const lruIdx = cmLru.indexOf(docName);
  if (lruIdx !== -1) cmLru.splice(lruIdx, 1);
  mark('ok/cache/evict', { docName, kind: 'cm' });
  return true;
}

function getTiptapEditorView(editor: Editor): { dom: HTMLElement; scrollDOM?: HTMLElement } | null {
  const view = (editor as unknown as { editorView?: { dom: HTMLElement; scrollDOM?: HTMLElement } })
    .editorView;
  return view ?? null;
}

function computeHadFocus(root: HTMLElement): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!active) return false;
  if (active === root) return true;
  return root.contains(active);
}

function reparentTiptapDom(entry: TiptapCacheEntry, container: HTMLElement): void {
  const view = getTiptapEditorView(entry.editor);
  if (!view) return;
  const dom = view.dom;
  const prevParent = dom.parentElement;
  if (prevParent && prevParent !== container) {
    prevParent.removeChild(dom);
  }
  if (dom.parentElement !== container) {
    container.appendChild(dom);
  }
}

function reparentCmDom(entry: CmCacheEntry, container: HTMLElement): void {
  const dom = entry.view.dom;
  const prevParent = dom.parentElement;
  if (prevParent && prevParent !== container) {
    prevParent.removeChild(dom);
  }
  if (dom.parentElement !== container) {
    container.appendChild(dom);
  }
}

function touchLru(lru: string[], docName: string): void {
  const idx = lru.indexOf(docName);
  if (idx !== -1) lru.splice(idx, 1);
  lru.push(docName);
}

function findEvictable(lru: string[], mountingDocName: string): string | null {
  for (const docName of lru) {
    if (docName === mountingDocName) continue;
    if (activityMountList.has(docName)) continue;
    return docName;
  }
  mark('ok/cache/evict-fallback-activity-saturated', {
    mountingDocName,
    lruLength: lru.length,
    activityMountCount: activityMountList.size,
  });
  for (const docName of lru) {
    if (docName === mountingDocName) continue;
    return docName;
  }
  return null;
}

export function setActivityMountList(docNames: readonly string[]): void {
  const prev = activityMountList;
  const next = new Set(docNames);

  for (const docName of prev) {
    if (next.has(docName)) continue;
    const provider = findProvider(docName);
    if (!provider) continue;
    try {
      provider.disconnect();
      mark('ok/cache/disconnect', { docName });
    } catch (err) {
      mark('ok/cache/disconnect-failed', {
        docName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const docName of next) {
    if (prev.has(docName)) continue;
    const provider = findProvider(docName);
    if (!provider) continue;
    const emitFailed = (err: unknown): void => {
      mark('ok/cache/connect-failed', {
        docName,
        message: err instanceof Error ? err.message : String(err),
      });
    };
    try {
      const result = provider.connect();
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).then(
          () => mark('ok/cache/connect', { docName }),
          (err) => emitFailed(err),
        );
      } else {
        mark('ok/cache/connect', { docName });
      }
    } catch (err) {
      emitFailed(err);
    }
  }

  activityMountList = next;
}

let activeProviderPool: {
  entries: ReadonlyMap<string, { provider: HocuspocusProvider }>;
} | null = null;

function findProvider(docName: string): HocuspocusProvider | null {
  const tip = tiptapCache.get(docName);
  if (tip) return tip.provider;
  const cm = cmCache.get(docName);
  if (cm) return cm.provider;
  if (activeProviderPool) {
    const entry = activeProviderPool.entries.get(docName);
    if (entry) return entry.provider;
  }
  return null;
}

export function subscribePoolEviction(pool: {
  onEvict: (cb: (docName: string) => void) => () => void;
  entries: ReadonlyMap<string, { provider: HocuspocusProvider }>;
}): () => void {
  activeProviderPool = pool;
  const unsubscribeEviction = pool.onEvict((docName) => {
    evictTiptapEditor(docName);
    evictCmEditor(docName);
  });
  return () => {
    unsubscribeEviction();
    if (activeProviderPool === pool) {
      activeProviderPool = null;
    }
  };
}

export function __getCacheSize(kind: 'tiptap' | 'cm'): number {
  return kind === 'tiptap' ? tiptapCache.size : cmCache.size;
}

export function __getCacheOrder(kind: 'tiptap' | 'cm'): string[] {
  return kind === 'tiptap' ? [...tiptapLru] : [...cmLru];
}

export function peekTiptap(docName: string): TiptapCacheEntry | undefined {
  return tiptapCache.get(docName);
}

export function __peekCm(docName: string): CmCacheEntry | undefined {
  return cmCache.get(docName);
}

export function __getActivityMountList(): string[] {
  return [...activityMountList];
}

export function __resetCacheForTests(): void {
  for (const docName of tiptapCache.keys()) evictTiptapEditor(docName);
  for (const docName of cmCache.keys()) evictCmEditor(docName);
  activityMountList = new Set();
  activeProviderPool = null;
  renameSnapshotStore.clear();
}
