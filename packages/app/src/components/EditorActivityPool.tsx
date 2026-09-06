import {
  isEditableTextDocFile,
  isExcalidrawDocFile,
  isManagedArtifactDocName,
  isMarkdownDocFile,
  isMermaidDocFile,
  parseTemplateContentDocName,
  randomUUID,
} from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { RefreshCw } from 'lucide-react';
import {
  Activity,
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Spinner } from '@/components/ui/spinner';
import { type PoolEntrySnapshot, useDocumentContext } from '@/editor/DocumentContext';
import { peekRenameSnapshot, setActivityMountList } from '@/editor/editor-cache';
import { isSystemDoc } from '@/editor/is-system-doc';
import { clearMountId, getMountId, setMountId } from '@/editor/mount-id-registry';
import type { ServerRestartRecoveryState } from '@/editor/provider-pool';
import {
  BODY_ANCHOR_ATTR,
  getDocScrollState,
  rememberDocScrollState,
  scrollFraction,
  scrollSuppressionHolder,
} from '@/editor/scroll-restore-coordination';
import { TiptapEditor } from '@/editor/TiptapEditor';
import type { EditorModeValue } from '@/editor/use-editor-mode';
import { useLifecycleStatus } from '@/hooks/use-lifecycle-status';
import { parseProjectSkillContentDocName } from '@/lib/managed-artifact-doc-name';
import { isNoteWindow } from '@/lib/note-window-mode';
import { mark, ProfilerBoundary } from '@/lib/perf';
import { readNumericOverride } from '@/lib/perf/env-override';
import { cn } from '@/lib/utils';
import { DocumentBoundary } from './DocumentBoundary';
import { DocumentErrorBoundary } from './DocumentErrorBoundary';
import { EditorSkeleton } from './EditorSkeleton';
import { PageHeader } from './PageHeader';
import { usePageList } from './PageListContext';
import { PropertyPanel } from './PropertyPanel';
import {
  clampTargetToContent,
  computeRestoreTarget,
  hasLandedAt,
  hasRestoreRunway,
  isExternalScroll,
  measureAnchor,
  measureContentExtent,
  RESTORE_BACKSTOP_MS,
  shouldRecordScrollPosition,
} from './scroll-restore';
import { Button } from './ui/button';

const LazyDiffViewBoundary = lazy(async () => {
  const mod = await import('./DiffViewBoundary');
  return { default: mod.DiffViewBoundary };
});

const ManagedArtifactProperties = lazy(async () => ({
  default: (await import('./ManagedArtifactProperties')).ManagedArtifactProperties,
}));

const MermaidDocEditor = lazy(async () => ({
  default: (await import('./MermaidDocEditor')).MermaidDocEditor,
}));
const ExcalidrawDocEditor = lazy(async () => ({
  default: (await import('./ExcalidrawDocEditor')).ExcalidrawDocEditor,
}));
const TextDocEditor = lazy(async () => ({
  default: (await import('./TextDocEditor')).TextDocEditor,
}));

/**
 * Large-doc threshold in Y.Text characters. Above this, the non-active editor
 * is defer-mounted on cold load instead of pre-mounting both per
 * precedent #18(b)'s small-to-medium-doc default. Once the user toggles to
 * the deferred mode, that editor mounts and stays mounted — so subsequent
 * toggles remain CSS-only and cost nothing.
 *
 * Value rationale (500_000 chars ≈ 500 KB plain text):
 *   - README.md / AGENTS.md / CLAUDE.md (≤150 KB) — BELOW. No change from
 *     pre-mount-both default; toggle stays instant.
 *   - perf-fixtures/big-doc.md (3.25 MB, generated) — ABOVE. Cold load skips the non-active
 *     editor's initial mount+parse; first toggle pays the cost; subsequent
 *     toggles are instant.
 *
 * The threshold is a tuning knob, not a contract. Moving it UP regresses
 * the fix for smaller "large" docs; moving it DOWN unnecessarily delays
 * first-toggle UX for medium docs where pre-mount-both was already fast
 * enough.
 *
 * FIRST-TOGGLE COST: On a 3.25 MB doc, the first mode toggle after cold
 * load pays the deferred editor's cold mount — measured at
 * `toSourceMs ≈ 223 ms`. Proportional scaling to a ~9.7 MB doc puts first
 * toggle in the 500–800 ms range. Perceptible but well below the ~1 s
 * hang threshold. Subsequent toggles remain CSS-only. Future engineers:
 * do not assume defer-mount is free at the toggle boundary; it trades
 * cold-load latency for one-time first-toggle latency on the deferred
 * mode. See `ACTIVITY_MOUNT_LIMIT` — both constants are parts of
 * the same Activity-mount hygiene pattern.
 */
export const LARGE_DOC_CHAR_THRESHOLD = readNumericOverride('LARGE_DOC_CHAR_THRESHOLD', 500_000);

/**
 * Pure helper — given the doc size and the current mode-visit history,
 * compute which editors should be rendered.
 *
 * Below the threshold: always both (pre-mount-both, precedent #18(b) default).
 * Above the threshold: only modes that have been visited at least once.
 * Active mode is ALWAYS considered visited for the purpose of this computation,
 * so the call site never sees `renderSource=false && renderVisual=false`.
 *
 * `isLarge` surfaces the threshold branch taken so the caller can emit an
 * `ok/activity/defer-mount` mark for observability. It is NOT load-bearing
 * for the gating decision itself — always derive render flags from this
 * helper's output.
 */
interface EditorMountGateArgs {
  ytextLength: number;
  isSourceMode: boolean;
  visitedSource: boolean;
  visitedVisual: boolean;
  threshold?: number;
}

interface EditorMountGate {
  renderSource: boolean;
  renderVisual: boolean;
  isLarge: boolean;
}

export function computeEditorMountGate(args: EditorMountGateArgs): EditorMountGate {
  const threshold = args.threshold ?? LARGE_DOC_CHAR_THRESHOLD;
  const isLarge = args.ytextLength > threshold;
  if (!isLarge) {
    return { renderSource: true, renderVisual: true, isLarge: false };
  }
  const renderSource = args.isSourceMode || args.visitedSource;
  const renderVisual = !args.isSourceMode || args.visitedVisual;
  return { renderSource, renderVisual, isLarge: true };
}

interface ShouldEmitFirstToggleArgs {
  isActive: boolean;
  isLarge: boolean;
  renderSource: boolean;
  renderVisual: boolean;
  hasEmittedFirstToggle: boolean;
}

export function shouldEmitFirstToggle(args: ShouldEmitFirstToggleArgs): boolean {
  if (args.hasEmittedFirstToggle) return false;
  if (!args.isActive) return false;
  if (!args.isLarge) return false;
  return args.renderSource && args.renderVisual;
}

export function computeEffectiveSourceMode(
  isActive: boolean,
  isSourceMode: boolean,
  lastActiveIsSourceMode: boolean,
): boolean {
  return isActive ? isSourceMode : lastActiveIsSourceMode;
}

export function computeIsNewDoc(args: {
  docName: string;
  pages: ReadonlySet<string>;
  loading: boolean;
}): boolean {
  const { docName, pages, loading } = args;
  return (
    !loading &&
    !pages.has(docName) &&
    !isManagedArtifactDocName(docName) &&
    parseTemplateContentDocName(docName) === null &&
    isMarkdownDocFile(docName)
  );
}

/**
 * Minimum number of editors mounted concurrently inside `<Activity>`
 * boundaries. Decoupled from `MAX_POOL` (exported from `provider-pool.ts`,
 * default 10) per precedent #18(c): every visible split-pane document is
 * mandatory, then MRU hidden documents fill this warm floor. Pool-resident
 * docs outside that list keep their warm provider (so revisiting is fast via
 * Suspense-gated remount with `syncPromise` resolving immediately from
 * `hasSynced=true`) but skip the per-editor memory + observer-CPU cost of
 * keeping the TipTap + CodeMirror instances alive.
 *
 * 3 covers the "alt-tab between recent docs" pattern dominant for the
 * primary personas.
 *
 * Changing either this value or `MAX_POOL` is an ASK_FIRST boundary — they're
 * coupled by design. If one moves, audit the other for sympathetic impact.
 *
 * **LIMIT=3 is a stable decision, not a temporary holdpoint.** Both the
 * TipTap-editor-cost argument (LIMIT=1 doesn't avoid `createEditor` cost
 * because `@tiptap/react`'s `useEditor` destroys on effect-cleanup anyway)
 * and the scroll-state argument (scroll preservation requires refs to
 * survive, which requires Activity hidden not full unmount) stand
 * independently of the V2 editor cache. A module-level editor cache changes
 * the first argument's mechanics but not the second — LIMIT stays at 3 to
 * keep ScrollPreservingContainer's `useRef` alive across navigation.
 *
 * Reducing this value to 1 was attempted as a warm-switch fix, then
 * REVERTED — LIMIT=1 broke scroll-position survival across A→B→A because
 * `ScrollPreservingContainer` stores its saved scrollTop in a `useRef`, and
 * refs persist across `<Activity>` mode flips but are lost on full unmount.
 * With LIMIT=3, ScrollPreservingContainer stays mounted for non-active docs
 * (effects paused via Activity-hidden; ref state preserved), so revisiting
 * restores scroll position. With LIMIT=1, the container unmounts on nav and
 * the ref is destroyed. TipTap editor state WAS being destroyed regardless
 * (its `useEditor` schedules destroy on effect-cleanup, so LIMIT=3 + hidden
 * transition = same destroy path as LIMIT=1 + unmount), but scroll state was
 * load-bearing. Conclusion: warm-switch latency is architecturally bounded
 * by TipTap's `createEditor` overhead (~350 ms schema + Yjs bind + DOM attach,
 * fixed cost regardless of doc size or `ACTIVITY_MOUNT_LIMIT`); unlocking
 * <100 ms warm-switch requires a module-level Editor cache outside React's
 * lifecycle.
 *
 * See `LARGE_DOC_CHAR_THRESHOLD` — both constants are parts of the same
 * Activity-mount hygiene pattern (precedent #18(c) / precedent #24).
 */
export const ACTIVITY_MOUNT_LIMIT = readNumericOverride('ACTIVITY_MOUNT_LIMIT', 3);

export function loadSourceEditorModule() {
  return import('@/editor/SourceEditor');
}

const LazySourceEditor = lazy(async () => {
  const mod = await loadSourceEditorModule();
  return { default: mod.SourceEditor };
});

interface EditorActivityPoolProps {
  activeDocName: string;
  visibleDocNames?: ReadonlySet<string>;
  activityHosts?: ReadonlyMap<string, HTMLElement>;
  parkingHost?: HTMLElement | null;
  renderToolbar?: (docName: string, provider: PoolEntrySnapshot['provider']) => ReactNode;
  isSourceMode: boolean;
  editorPlaceholder?: string;
  previousDocName?: string;
  onNavigateBack?: (previousDocName: string) => void;
  onRecycle: (docName: string) => void;
}

export function computeActivityMountList<T extends { docName: string; lastAccessedAt: number }>(
  entries: ReadonlyArray<T>,
  visibleDocNames: ReadonlySet<string> | string | null,
  limit: number,
): ReadonlyArray<T> {
  if (limit <= 0) return [];
  const filtered = entries.filter((e) => !isSystemDoc(e.docName));
  const sorted = [...filtered].sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);

  if (typeof visibleDocNames === 'string' || visibleDocNames === null) {
    const top = sorted.slice(0, limit);
    if (visibleDocNames === null || top.some((entry) => entry.docName === visibleDocNames)) {
      return top;
    }
    const active = filtered.find((entry) => entry.docName === visibleDocNames);
    return active === undefined ? top : [...top.slice(0, limit - 1), active];
  }

  const visibleNames = visibleDocNames;
  const entriesByDocName = new Map(filtered.map((entry) => [entry.docName, entry]));
  const visible = [...visibleNames]
    .filter((docName) => !isSystemDoc(docName))
    .map((docName) => entriesByDocName.get(docName))
    .filter((entry): entry is T => entry !== undefined);
  const mountedDocNames = new Set(visible.map((entry) => entry.docName));
  const targetSize = Math.max(limit, visible.length);

  for (const entry of sorted) {
    if (mountedDocNames.size >= targetSize) break;
    if (mountedDocNames.has(entry.docName)) continue;
    visible.push(entry);
    mountedDocNames.add(entry.docName);
  }

  return visible;
}

type ServerRestartRecoveryView =
  | {
      kind: 'recovering';
      title: string;
      summary: string;
    }
  | {
      kind: 'failed';
      title: string;
      summary: string;
      actionLabel: string;
    };

export function getServerRestartRecoveryView(
  docName: string,
  state: ServerRestartRecoveryState,
): ServerRestartRecoveryView | null {
  if (state.kind === 'idle') return null;

  if (state.kind === 'failed' && state.failedDocNames.includes(docName)) {
    return {
      kind: 'failed',
      title: t`Couldn't reconnect after server restart`,
      summary:
        state.reason === 'clear-data-timeout'
          ? t`Local collaboration data for "${docName}" could not be cleared in time. Reload to retry.`
          : t`Local collaboration data for "${docName}" could not be cleared. Reload to retry.`,
      actionLabel: t`Reload`,
    };
  }

  if (state.kind === 'recovering' && state.docNames.includes(docName)) {
    return {
      kind: 'recovering',
      title: t`Reconnecting after server restart`,
      summary:
        state.phase === 'clearing-local-cache'
          ? t`Clearing local collaboration data for "${docName}" before reconnecting.`
          : t`Reopening "${docName}" with a fresh local collaboration cache.`,
    };
  }

  return null;
}

export function EditorActivityPool(props: EditorActivityPoolProps) {
  return (
    <ProfilerBoundary name="activity-pool">
      <EditorActivityPoolInner {...props} />
    </ProfilerBoundary>
  );
}

function EditorActivityPoolInner({
  activeDocName,
  visibleDocNames,
  activityHosts,
  parkingHost,
  renderToolbar,
  isSourceMode,
  editorPlaceholder,
  previousDocName,
  onNavigateBack,
  onRecycle,
}: EditorActivityPoolProps) {
  const { poolEntries, serverRestartRecovery } = useDocumentContext();
  const { pages, loading } = usePageList();
  const effectiveVisibleDocNames = visibleDocNames ?? new Set([activeDocName]);
  const mountList = computeActivityMountList(
    poolEntries,
    effectiveVisibleDocNames,
    ACTIVITY_MOUNT_LIMIT,
  );

  const priorMountKeyRef = useRef<string>('');
  const mountKey = mountList.map((e) => e.docName).join(',');
  const poolEntriesRef = useRef(poolEntries);
  useLayoutEffect(() => {
    poolEntriesRef.current = poolEntries;
  }, [poolEntries]);
  useLayoutEffect(() => {
    if (priorMountKeyRef.current === mountKey) return;
    const prior = priorMountKeyRef.current ? priorMountKeyRef.current.split(',') : [];
    const mounted = mountKey ? mountKey.split(',') : [];
    const evicted = prior.filter((d) => !mounted.includes(d));
    const newlyMounted = mounted.filter((d) => !prior.includes(d));
    for (const docName of evicted) {
      clearMountId(docName);
    }
    for (const docName of newlyMounted) {
      const entry = poolEntriesRef.current.find((e) => e.docName === docName);
      const adopted = entry?.poolEventId;
      const mountId = adopted && adopted.length > 0 ? adopted : randomUUID();
      setMountId(docName, mountId);
    }
    mark('ok/activity/mount-list-change', {
      active: activeDocName,
      mounted,
      evicted,
    });
    priorMountKeyRef.current = mountKey;
    // cached-but-not-Activity-mounted editors (precedent #27(b)). Bounds
    setActivityMountList(mounted);
  }, [mountKey, activeDocName]);

  return (
    <>
      {mountList.map((entry) => (
        <ActivityEntryHost
          key={entry.docName}
          docName={entry.docName}
          hostMount={activityHosts?.get(entry.docName) ?? parkingHost ?? null}
        >
          <ActivityEntry
            entry={entry}
            isVisible={effectiveVisibleDocNames.has(entry.docName)}
            toolbar={
              effectiveVisibleDocNames.has(entry.docName)
                ? renderToolbar?.(entry.docName, entry.provider)
                : null
            }
            isSourceMode={isSourceMode}
            editorPlaceholder={editorPlaceholder}
            isNewDoc={computeIsNewDoc({ docName: entry.docName, pages, loading })}
            previousDocName={previousDocName}
            onNavigateBack={onNavigateBack}
            onRecycle={onRecycle}
            serverRestartRecovery={serverRestartRecovery}
          />
        </ActivityEntryHost>
      ))}
    </>
  );
}

interface ActivityEntryProps {
  entry: PoolEntrySnapshot;
  isVisible: boolean;
  toolbar?: ReactNode;
  isSourceMode: boolean;
  editorPlaceholder?: string;
  isNewDoc: boolean;
  previousDocName?: string;
  onNavigateBack?: (previousDocName: string) => void;
  onRecycle: (docName: string) => void;
  serverRestartRecovery: ServerRestartRecoveryState;
}

function geometry(el: HTMLElement, contentBottom: number | null) {
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    ...(contentBottom !== null ? { contentBottom } : {}),
  };
}

function ActivityEntryHost({
  docName,
  hostMount,
  children,
}: {
  docName: string;
  hostMount: HTMLElement | null;
  children: ReactNode;
}) {
  const [host] = useState<HTMLDivElement>(() => {
    const element = document.createElement('div');
    element.setAttribute('data-ok-activity-host', docName);
    element.className = 'relative h-full min-h-0';
    return element;
  });

  useLayoutEffect(() => {
    if (hostMount === null) return;
    hostMount.append(host);
    return () => host.remove();
  }, [host, hostMount]);

  return hostMount === null ? children : createPortal(children, host);
}

export function ScrollPreservingContainer({
  isActive,
  docName,
  mode,
  initialScrollTop,
  bodyAnchorRef,
  hasToolbar = true,
  children,
}: {
  isActive: boolean;
  docName: string;
  mode: EditorModeValue;
  initialScrollTop?: number;
  bodyAnchorRef?: RefObject<HTMLElement | null>;
  hasToolbar?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const savedScrollTop = useRef<number>(initialScrollTop ?? 0);
  const savedAnchorPos = useRef<number | null>(null);

  const isActiveRef = useRef(isActive);
  const isRestoringRef = useRef(false);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  const modeRef = useRef(mode);
  useLayoutEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      if (!isActiveRef.current || isRestoringRef.current) return;
      if (el.scrollTop > 0) {
        const anchor = measureAnchor(el, bodyAnchorRef?.current);
        if (!shouldRecordScrollPosition(anchor)) return;
        savedScrollTop.current = el.scrollTop;
        savedAnchorPos.current = anchor.kind === 'measured' ? anchor.contentPos : null;
        if (anchor.kind === 'measured') {
          rememberDocScrollState(docName, {
            offset: el.scrollTop - anchor.contentPos,
            mode: modeRef.current,
            fraction: scrollFraction(el.scrollTop, el.scrollHeight, el.clientHeight),
          });
        }
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [bodyAnchorRef, docName]);

  useLayoutEffect(() => {
    if (!isActive) return;
    const el = ref.current;
    if (!el) return;
    if (scrollSuppressionHolder(docName) === 'landing') return;

    const saved = getDocScrollState(docName);
    if (saved && saved.mode !== modeRef.current) {
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      const target = Math.round(saved.fraction * maxScroll);
      const applicable = maxScroll > 0;
      if (applicable) el.scrollTop = target;
      mark('ok/scroll-restore/cross-mode', {
        docName,
        savedMode: saved.mode,
        mode: modeRef.current,
        fraction: Number(saved.fraction.toFixed(4)),
        target,
        applied: applicable && el.scrollTop === target,
        ...geometry(el, measureContentExtent(el)),
      });
      return;
    }

    const rawTarget = savedScrollTop.current;

    const sharedOffset = saved?.offset;
    const instanceOffset =
      savedAnchorPos.current !== null ? rawTarget - savedAnchorPos.current : null;
    const bodyOffset: number | null = sharedOffset ?? instanceOffset;
    if (rawTarget === 0 && bodyOffset === null) return;
    const measureFrame = (): { target: number | null; contentBottom: number | null } => {
      const contentBottom = measureContentExtent(el);
      const target = computeRestoreTarget(
        rawTarget,
        bodyOffset,
        measureAnchor(el, bodyAnchorRef?.current),
      );
      return {
        target:
          target === null ? null : clampTargetToContent(target, contentBottom, el.clientHeight),
        contentBottom,
      };
    };
    isRestoringRef.current = true;
    const priorOverflowAnchor = el.style.overflowAnchor;
    el.style.overflowAnchor = 'none';

    const startTs = performance.now();
    let phase2Marked = false;
    let hasLandedOnce = false;

    let frame = measureFrame();
    if (frame.target !== null) {
      el.scrollTop = frame.target;
      if (
        hasLandedAt(el.scrollTop, frame.target) &&
        hasRestoreRunway(frame.target, frame.contentBottom, el.scrollHeight)
      ) {
        hasLandedOnce = true;
        mark('ok/scroll-restore/phase1-success', {
          docName,
          target: frame.target,
          elapsedMs: performance.now() - startTs,
          ...geometry(el, frame.contentBottom),
        });
      }
    }
    let prevScrollTop = el.scrollTop;

    let done = false;
    let raf = 0;
    const finish = () => {
      if (done) return;
      done = true;
      isRestoringRef.current = false;
      el.style.overflowAnchor = priorOverflowAnchor;
      cancelAnimationFrame(raf);
      clearTimeout(safetyTimer);
      el.removeEventListener('wheel', yieldToUser);
      el.removeEventListener('touchstart', yieldToUser);
      el.removeEventListener('mousedown', yieldToUser);
      el.removeEventListener('keydown', yieldToUser);
    };
    const yieldToUser = () => {
      if (!hasLandedOnce) {
        mark('ok/scroll-restore/yielded', {
          docName,
          reason: 'user',
          elapsedMs: performance.now() - startTs,
          ...geometry(el, null),
        });
      }
      finish();
    };
    el.addEventListener('wheel', yieldToUser, { passive: true });
    el.addEventListener('touchstart', yieldToUser, { passive: true });
    el.addEventListener('mousedown', yieldToUser);
    el.addEventListener('keydown', yieldToUser);
    const tick = () => {
      if (done) return;
      const holder = scrollSuppressionHolder(docName);
      if (holder) {
        mark('ok/scroll-restore/superseded', {
          docName,
          holder,
          elapsedMs: performance.now() - startTs,
          finalScrollTop: el.scrollTop,
        });
        if (!hasLandedOnce) {
          mark('ok/scroll-restore/yielded', {
            docName,
            reason: holder,
            elapsedMs: performance.now() - startTs,
            ...geometry(el, null),
          });
        }
        finish();
        return;
      }
      if (isExternalScroll(prevScrollTop, el.scrollTop)) {
        if (!hasLandedOnce) {
          mark('ok/scroll-restore/yielded', {
            docName,
            reason: 'external',
            elapsedMs: performance.now() - startTs,
            ...geometry(el, null),
          });
        }
        finish();
        return;
      }
      frame = measureFrame();
      if (
        frame.target !== null &&
        !hasLandedAt(el.scrollTop, frame.target) &&
        hasRestoreRunway(frame.target, frame.contentBottom, el.scrollHeight)
      ) {
        el.scrollTop = frame.target;
        if (hasLandedAt(el.scrollTop, frame.target) && !phase2Marked) {
          mark('ok/scroll-restore/phase2-success', {
            docName,
            target: frame.target,
            elapsedMs: performance.now() - startTs,
            ...geometry(el, frame.contentBottom),
          });
          phase2Marked = true;
          hasLandedOnce = true;
        }
      }
      prevScrollTop = el.scrollTop;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const safetyTimer = setTimeout(() => {
      if (done) return;
      const final = measureFrame();
      const finalTarget = final.target;
      if (
        finalTarget === null ||
        (!hasLandedAt(el.scrollTop, finalTarget) &&
          hasRestoreRunway(finalTarget, final.contentBottom, el.scrollHeight))
      ) {
        mark('ok/scroll-restore/abandoned', {
          docName,
          ...(finalTarget !== null ? { target: finalTarget } : {}),
          anchorMeasurable: finalTarget !== null,
          elapsedMs: performance.now() - startTs,
          ...geometry(el, final.contentBottom),
        });
      }
      finish();
    }, RESTORE_BACKSTOP_MS);

    return finish;
  }, [isActive, bodyAnchorRef, docName]);

  return (
    <div
      ref={ref}
      data-testid="editor-scroll-container"
      className={cn(
        'editor-doc-scroll subtle-scrollbar h-full overflow-y-auto',
        isNoteWindow() || !hasToolbar ? 'pt-0 scroll-pt-0' : 'pt-14 scroll-pt-14',
      )}
      style={{ overflowAnchor: 'auto' }}
    >
      {children}
    </div>
  );
}

function SourceEditorSlot({
  entry,
  isActive,
  isSourceMode,
  editorPlaceholder,
}: {
  entry: PoolEntrySnapshot;
  isActive: boolean;
  isSourceMode: boolean;
  editorPlaceholder?: string;
}) {
  const sourceModeRequested = isActive && isSourceMode;
  const [hasLoadedSourceEditor, setHasLoadedSourceEditor] = useState(sourceModeRequested);

  useEffect(() => {
    if (sourceModeRequested) {
      setHasLoadedSourceEditor(true);
    }
  }, [sourceModeRequested]);

  if (!hasLoadedSourceEditor && !sourceModeRequested) {
    return null;
  }

  return (
    <Suspense fallback={<EditorSkeleton />}>
      <LazySourceEditor
        docName={entry.docName}
        ytext={entry.provider.document.getText('source')}
        provider={entry.provider}
        placeholder={editorPlaceholder}
        isSourceModeActive={sourceModeRequested}
      />
    </Suspense>
  );
}

function ServerRestartRecoveryPanel({ view }: { view: ServerRestartRecoveryView }) {
  const isFailed = view.kind === 'failed';
  return (
    <div
      data-slot="server-restart-recovery"
      role={isFailed ? 'alert' : 'status'}
      aria-busy={!isFailed}
      className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center"
    >
      <div className="flex size-12 items-center justify-center rounded-full border bg-muted text-muted-foreground">
        {isFailed ? (
          <RefreshCw className="size-5" aria-hidden="true" />
        ) : (
          <Spinner className="size-5" aria-hidden="true" />
        )}
      </div>
      <div className="flex flex-col items-center gap-1">
        <h2 className="text-lg font-medium">{view.title}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{view.summary}</p>
      </div>
      {isFailed ? (
        <Button type="button" onClick={() => window.location.reload()}>
          <RefreshCw className="size-4" aria-hidden="true" />
          {view.actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

function WarmContentFallback({ html }: { html: string }) {
  return (
    <div className="tiptap-editor h-full pointer-events-none" aria-hidden="true">
      <div
        className="tiptap ProseMirror tiptap-editor-portal-content"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: editor.getHTML() routes through DOMSerializer.serializeFragment — attribute values via setAttribute(), text via createTextNode(); both escape correctly
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function ActivityEntry({
  entry,
  isVisible,
  toolbar,
  isSourceMode,
  editorPlaceholder,
  isNewDoc,
  previousDocName,
  onNavigateBack,
  onRecycle,
  serverRestartRecovery,
}: ActivityEntryProps) {
  const recoveryView = getServerRestartRecoveryView(entry.docName, serverRestartRecovery);

  // (preserving precedent #18(b)'s hybrid render tree — Suspense + error
  const lifecycleStatus = useLifecycleStatus(entry.docName);
  const isConflict = lifecycleStatus === 'conflict';
  const isMermaid = isMermaidDocFile(entry.docName);
  const isExcalidraw = isExcalidrawDocFile(entry.docName);
  const isTextDoc = !isMermaid && !isExcalidraw && isEditableTextDocFile(entry.docName);
  const isDualEditor = !isConflict && isMarkdownDocFile(entry.docName);
  const [portalTarget] = useState<HTMLDivElement>(() => {
    const target = document.createElement('div');
    target.setAttribute('data-ok-editor-portal', entry.docName);
    target.style.display = 'contents';
    return target;
  });

  const bodyAnchorRef = useRef<HTMLDivElement>(null);

  // Small/medium docs keep pre-mount-both (precedent #18(b) default): mode swap
  const ytextLength = entry.provider.document.getText('source').length;

  const [lastVisibleIsSourceMode, setLastVisibleIsSourceMode] = useState(isSourceMode);
  useEffect(() => {
    if (isVisible && lastVisibleIsSourceMode !== isSourceMode) {
      setLastVisibleIsSourceMode(isSourceMode);
    }
  }, [isVisible, isSourceMode, lastVisibleIsSourceMode]);
  const effectiveIsSourceMode = computeEffectiveSourceMode(
    isVisible,
    isSourceMode,
    lastVisibleIsSourceMode,
  );

  const [visitedSource, setVisitedSource] = useState(effectiveIsSourceMode);
  const [visitedVisual, setVisitedVisual] = useState(!effectiveIsSourceMode);

  useEffect(() => {
    if (effectiveIsSourceMode && !visitedSource) setVisitedSource(true);
    else if (!effectiveIsSourceMode && !visitedVisual) setVisitedVisual(true);
  }, [effectiveIsSourceMode, visitedSource, visitedVisual]);

  const gate = computeEditorMountGate({
    ytextLength,
    isSourceMode: effectiveIsSourceMode,
    visitedSource,
    visitedVisual,
  });

  const priorGateKeyRef = useRef<string>('');
  const gateKey = `${gate.isLarge}-${gate.renderSource}-${gate.renderVisual}`;
  useEffect(() => {
    if (priorGateKeyRef.current === gateKey) return;
    priorGateKeyRef.current = gateKey;
    if (gate.isLarge) {
      mark('ok/activity/defer-mount', {
        docName: entry.docName,
        ytextLength,
        isSourceMode: effectiveIsSourceMode,
        renderSource: gate.renderSource,
        renderVisual: gate.renderVisual,
      });
    }
  }, [
    gateKey,
    gate.isLarge,
    gate.renderSource,
    gate.renderVisual,
    entry.docName,
    ytextLength,
    effectiveIsSourceMode,
  ]);

  const [warmSnapshot] = useState(() => peekRenameSnapshot(entry.docName));
  const warmHtml = warmSnapshot?.html ?? null;

  const [hasEmittedFirstToggle, setHasEmittedFirstToggle] = useState(false);
  useEffect(() => {
    if (
      !shouldEmitFirstToggle({
        isActive: isVisible,
        isLarge: gate.isLarge,
        renderSource: gate.renderSource,
        renderVisual: gate.renderVisual,
        hasEmittedFirstToggle,
      })
    ) {
      return;
    }
    mark('ok/cold/first-toggle', {
      docName: entry.docName,
      mountId: getMountId(entry.docName),
      ytextLength,
      modeEnteredFirst: effectiveIsSourceMode ? 'source' : 'visual',
    });
    setHasEmittedFirstToggle(true);
  }, [
    hasEmittedFirstToggle,
    isVisible,
    gate.isLarge,
    gate.renderSource,
    gate.renderVisual,
    entry.docName,
    ytextLength,
    effectiveIsSourceMode,
  ]);

  return (
    <Activity mode={isVisible ? 'visible' : 'hidden'} name={`editor:${entry.docName}`}>
      {}
      <ScrollPreservingContainer
        isActive={isVisible}
        docName={entry.docName}
        mode={effectiveIsSourceMode ? 'source' : 'wysiwyg'}
        initialScrollTop={warmSnapshot?.scrollTop}
        bodyAnchorRef={bodyAnchorRef}
        hasToolbar={!isConflict}
      >
        {recoveryView ? (
          <ServerRestartRecoveryPanel view={recoveryView} />
        ) : (
          <>
            {}
            <DocumentErrorBoundary
              activeDocName={entry.docName}
              previousDocName={previousDocName}
              onNavigateBack={onNavigateBack}
              onRecycle={onRecycle}
            >
              {}
              <Suspense
                fallback={
                  warmHtml && isDualEditor ? (
                    <WarmContentFallback html={warmHtml} />
                  ) : (
                    <EditorSkeleton />
                  )
                }
              >
                <DocumentBoundary docName={entry.docName} provider={entry.provider}>
                  {isConflict ? (
                    /* While `lifecycle.status === 'conflict'` the
                       DiffViewBoundary replaces the editor children. The
                       outer DocumentBoundary's syncPromise gate + the
                       Suspense/error scopes above stay intact (precedent
                       #18(b) hybrid render tree preserved — we swap children,
                       not boundaries). Y.Doc identity is unchanged across
                       the swap, so Y.Text content + undo history survive. */
                    <Suspense fallback={<EditorSkeleton />}>
                      <LazyDiffViewBoundary docName={entry.docName} provider={entry.provider} />
                    </Suspense>
                  ) : isMermaid ? (
                    /* Standalone Mermaid doc: dedicated diagram (wysiwyg) + editable
                       source editor, both bound to this doc's Y.Text('source').
                       Swaps the editor CHILDREN inside the same DocumentBoundary
                       (like the conflict branch above) so the precedent #18(b)
                       hybrid render tree + Y.Doc identity are preserved. */
                    <MermaidDocEditor
                      docName={entry.docName}
                      provider={entry.provider}
                      isSourceMode={effectiveIsSourceMode}
                    />
                  ) : isExcalidraw ? (
                    <Suspense fallback={<EditorSkeleton />}>
                      <ExcalidrawDocEditor provider={entry.provider} />
                    </Suspense>
                  ) : isTextDoc ? (
                    <TextDocEditor docName={entry.docName} provider={entry.provider} />
                  ) : (
                    <div className="flex h-full flex-col">
                      {}
                      {!effectiveIsSourceMode &&
                        (isManagedArtifactDocName(entry.docName) ||
                        parseProjectSkillContentDocName(entry.docName) ||
                        parseTemplateContentDocName(entry.docName) ? (
                          <Suspense fallback={null}>
                            <ManagedArtifactProperties
                              docName={entry.docName}
                              provider={entry.provider}
                            />
                          </Suspense>
                        ) : (
                          <>
                            <PageHeader provider={entry.provider} />
                            <PropertyPanel provider={entry.provider} />
                          </>
                        ))}
                      {}
                      <div
                        ref={bodyAnchorRef}
                        aria-hidden
                        className="h-0"
                        {...{ [BODY_ANCHOR_ATTR]: '' }}
                      />
                      <div className="relative flex-1">
                        {gate.renderSource ? (
                          <div
                            className={effectiveIsSourceMode ? 'h-full' : 'ok-mode-hidden h-full'}
                          >
                            <SourceEditorSlot
                              entry={entry}
                              isActive={isVisible}
                              isSourceMode={effectiveIsSourceMode}
                              editorPlaceholder={editorPlaceholder}
                            />
                          </div>
                        ) : null}
                        {gate.renderVisual ? (
                          <div
                            className={effectiveIsSourceMode ? 'ok-mode-hidden h-full' : 'h-full'}
                          >
                            <TiptapEditor
                              key={`${entry.docName}-${String(isNewDoc)}-${entry.poolEventId}`}
                              provider={entry.provider}
                              placeholder={editorPlaceholder}
                              isSourceMode={effectiveIsSourceMode}
                              portalTarget={portalTarget}
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )}
                </DocumentBoundary>
              </Suspense>
            </DocumentErrorBoundary>
          </>
        )}
      </ScrollPreservingContainer>
      {toolbar}
    </Activity>
  );
}
