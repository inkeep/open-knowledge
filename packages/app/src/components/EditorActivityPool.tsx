/**
 * EditorActivityPool — bounded `<Activity>` rendering for the most-recently-active
 * pooled docs. `ACTIVITY_MOUNT_LIMIT = 3` decouples from `MAX_POOL = 10`;
 * `__system__` is filtered out as a defense-in-depth.
 *
 * Why `ACTIVITY_MOUNT_LIMIT < MAX_POOL`: `setupObservers` (provider-pool.ts)
 * wires Y.js bidirectional bridges that fire regardless of Activity mode —
 * they are NOT React effects and do not pause when Activity flips to hidden.
 * Bounding mounted editors at 3 caps the editor-instance memory cost (≈30-90MB
 * for TipTap + CodeMirror) without preventing the pool from holding warm
 * providers (≈5-10MB each) for fast Suspense-gated remount on revisit.
 *
 * `TiptapEditor` stays on the initial path; `SourceEditor` is lazy-loaded the
 * first time a doc actually enters source mode. Large docs additionally defer
 * the non-active editor until that mode is first visited. After the initial
 * visits, the doc keeps both editors mounted behind hidden-mode wrappers so
 * subsequent mode swaps stay CSS-only for that Activity.
 *
 * ERROR + SUSPENSE SCOPING (per-Activity, not global).
 *   Each `<Activity>` wraps its own `<DocumentErrorBoundary>` + `<Suspense>`.
 *   Rationale: `<Activity mode="hidden">` silences suspends in the hidden
 *   subtree (good) but does NOT intercept synchronous throws from
 *   `use(rejectedPromise)` (React 19.2 behavior). A single global boundary
 *   above the pool caused any hidden doc's cached rejection to re-throw
 *   into the visible UI when a healthy doc was active. Scoping per-Activity
 *   confines each error to its own subtree — hidden Activities' errors
 *   render into hidden DOM (`display:none`), and become visible again
 *   naturally when the user navigates back.
 *
 *   `resetKeys={[entry.docName]}` is intentionally stable for each Activity
 *   instance — auto-reset on navigation is not needed when the boundary is
 *   per-Activity (visibility is handled by Activity itself). Error clears
 *   only via (a) imperative "Try again" (recycle), (b) "Back to previous"
 *   (invalidate + nav), or (c) Activity eviction from the MRU mount list.
 */

import { isManagedArtifactDocName } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Loader2, RefreshCw } from 'lucide-react';
import {
  Activity,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type PoolEntrySnapshot, useDocumentContext } from '@/editor/DocumentContext';
import { peekRenameSnapshot, setActivityMountList } from '@/editor/editor-cache';
import { isSystemDoc } from '@/editor/is-system-doc';
import { clearMountId, getMountId, setMountId } from '@/editor/mount-id-registry';
import type { ServerRestartRecoveryState } from '@/editor/provider-pool';
import { TiptapEditor } from '@/editor/TiptapEditor';
import { useLifecycleStatus } from '@/hooks/use-lifecycle-status';
import { parseProjectSkillContentDocName } from '@/lib/managed-artifact-doc-name';
import { mark, ProfilerBoundary } from '@/lib/perf';
import { readNumericOverride } from '@/lib/perf/env-override';
import { DiffViewBoundary } from './DiffViewBoundary';
import { DocumentBoundary } from './DocumentBoundary';
import { DocumentErrorBoundary } from './DocumentErrorBoundary';
import { EditorSkeleton } from './EditorSkeleton';
import { PageHeader } from './PageHeader';
import { usePageList } from './PageListContext';
import { PropertyPanel } from './PropertyPanel';
import { Button } from './ui/button';

const ManagedArtifactProperties = lazy(async () => ({
  default: (await import('./ManagedArtifactProperties')).ManagedArtifactProperties,
}));

export const LARGE_DOC_CHAR_THRESHOLD = readNumericOverride('LARGE_DOC_CHAR_THRESHOLD', 500_000);

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
  isLarge: boolean;
  renderSource: boolean;
  renderVisual: boolean;
  hasEmittedFirstToggle: boolean;
}

export function shouldEmitFirstToggle(args: ShouldEmitFirstToggleArgs): boolean {
  if (args.hasEmittedFirstToggle) return false;
  if (!args.isLarge) return false;
  return args.renderSource && args.renderVisual;
}

/**
 * Maximum number of editors mounted concurrently inside `<Activity>` boundaries.
 * Decoupled from `MAX_POOL` (exported from `provider-pool.ts`, default 10) per
 * precedent #18(c) — pool-resident-but-not-Activity-mounted docs keep their
 * warm provider (so revisiting is fast via Suspense-gated remount with
 * `syncPromise` resolving immediately from `hasSynced=true`) but skip the
 * per-editor memory + observer-CPU cost of keeping the TipTap + CodeMirror
 * instances alive.
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
 * See `LARGE_DOC_CHAR_THRESHOLD` above — both constants are parts of the same
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
  isSourceMode: boolean;
  editorPlaceholder?: string;
  previousDocName?: string;
  onNavigateBack?: (previousDocName: string) => void;
  onRecycle: (docName: string) => void;
}

export function computeActivityMountList<T extends { docName: string; lastAccessedAt: number }>(
  entries: ReadonlyArray<T>,
  activeDocName: string | null,
  limit: number,
): ReadonlyArray<T> {
  if (limit <= 0) return [];
  const filtered = entries.filter((e) => !isSystemDoc(e.docName));
  const sorted = [...filtered].sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
  const top = sorted.slice(0, limit);

  if (activeDocName === null) return top;
  if (top.some((e) => e.docName === activeDocName)) return top;

  const active = filtered.find((e) => e.docName === activeDocName);
  if (!active) return top;
  return [...top.slice(0, limit - 1), active];
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
  isSourceMode,
  editorPlaceholder,
  previousDocName,
  onNavigateBack,
  onRecycle,
}: EditorActivityPoolProps) {
  const { poolEntries, serverRestartRecovery } = useDocumentContext();
  const { pages, loading } = usePageList();

  const mountList = computeActivityMountList(poolEntries, activeDocName, ACTIVITY_MOUNT_LIMIT);

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
      const mountId = adopted && adopted.length > 0 ? adopted : crypto.randomUUID();
      setMountId(docName, mountId);
    }
    mark('ok/activity/mount-list-change', {
      active: activeDocName,
      mounted,
      evicted,
    });
    priorMountKeyRef.current = mountKey;
    setActivityMountList(mounted);
  }, [mountKey, activeDocName]);

  return (
    <>
      {mountList.map((entry) => (
        <ActivityEntry
          key={entry.docName}
          entry={entry}
          isActive={entry.docName === activeDocName}
          isSourceMode={isSourceMode}
          editorPlaceholder={editorPlaceholder}
          isNewDoc={
            !loading && !pages.has(entry.docName) && !isManagedArtifactDocName(entry.docName)
          }
          previousDocName={previousDocName}
          onNavigateBack={onNavigateBack}
          onRecycle={onRecycle}
          serverRestartRecovery={serverRestartRecovery}
        />
      ))}
    </>
  );
}

interface ActivityEntryProps {
  entry: PoolEntrySnapshot;
  isActive: boolean;
  isSourceMode: boolean;
  editorPlaceholder?: string;
  isNewDoc: boolean;
  previousDocName?: string;
  onNavigateBack?: (previousDocName: string) => void;
  onRecycle: (docName: string) => void;
  serverRestartRecovery: ServerRestartRecoveryState;
}

function ScrollPreservingContainer({
  isActive,
  initialScrollTop,
  children,
}: {
  isActive: boolean;
  initialScrollTop?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const savedScrollTop = useRef<number>(initialScrollTop ?? 0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop > 0) savedScrollTop.current = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    if (!isActive) return;
    const el = ref.current;
    if (!el) return;
    const target = savedScrollTop.current;
    if (target === 0) return;

    const startTs = performance.now();
    let phase2Marked = false;

    el.scrollTop = target;
    if (el.scrollTop === target && el.scrollHeight > target) {
      mark('ok/scroll-restore/phase1-success', {
        target,
        elapsedMs: performance.now() - startTs,
      });
    }

    let done = false;
    let raf = 0;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      clearTimeout(safetyTimer);
      el.removeEventListener('wheel', onUserInterrupt);
      el.removeEventListener('touchstart', onUserInterrupt);
    };
    const onUserInterrupt = () => finish();
    el.addEventListener('wheel', onUserInterrupt, { passive: true });
    el.addEventListener('touchstart', onUserInterrupt, { passive: true });
    const tick = () => {
      if (done) return;
      if (el.scrollTop !== target && el.scrollHeight > target) {
        el.scrollTop = target;
        if (el.scrollTop === target && !phase2Marked) {
          mark('ok/scroll-restore/phase2-success', {
            target,
            elapsedMs: performance.now() - startTs,
          });
          phase2Marked = true;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const safetyTimer = setTimeout(() => {
      if (done) return;
      if (el.scrollTop !== target && el.scrollHeight > target) {
        mark('ok/scroll-restore/abandoned', {
          target,
          elapsedMs: performance.now() - startTs,
          scrollHeight: el.scrollHeight,
          finalScrollTop: el.scrollTop,
        });
      }
      finish();
    }, 2000);

    return finish;
  }, [isActive]);

  return (
    <div
      ref={ref}
      data-testid="editor-scroll-container"
      className="editor-doc-scroll subtle-scrollbar h-full overflow-y-auto pt-14 scroll-pt-14"
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
          <Loader2 className="size-5 animate-spin" aria-hidden="true" />
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
  isActive,
  isSourceMode,
  editorPlaceholder,
  isNewDoc,
  previousDocName,
  onNavigateBack,
  onRecycle,
  serverRestartRecovery,
}: ActivityEntryProps) {
  const recoveryView = getServerRestartRecoveryView(entry.docName, serverRestartRecovery);

  const lifecycleStatus = useLifecycleStatus(entry.docName);
  const isConflict = lifecycleStatus === 'conflict';

  const [portalTarget] = useState<HTMLDivElement>(() => {
    const target = document.createElement('div');
    target.setAttribute('data-ok-editor-portal', entry.docName);
    target.style.display = 'contents';
    return target;
  });

  const ytextLength = entry.provider.document.getText('source').length;

  const [visitedSource, setVisitedSource] = useState(isSourceMode);
  const [visitedVisual, setVisitedVisual] = useState(!isSourceMode);

  useEffect(() => {
    if (isSourceMode && !visitedSource) setVisitedSource(true);
    else if (!isSourceMode && !visitedVisual) setVisitedVisual(true);
  }, [isSourceMode, visitedSource, visitedVisual]);

  const gate = computeEditorMountGate({
    ytextLength,
    isSourceMode,
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
        isSourceMode,
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
    isSourceMode,
  ]);

  const [warmSnapshot] = useState(() => peekRenameSnapshot(entry.docName));
  const warmHtml = warmSnapshot?.html ?? null;


  const [hasEmittedFirstToggle, setHasEmittedFirstToggle] = useState(false);
  useEffect(() => {
    if (
      !shouldEmitFirstToggle({
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
      modeEnteredFirst: isSourceMode ? 'source' : 'visual',
    });
    setHasEmittedFirstToggle(true);
  }, [
    hasEmittedFirstToggle,
    gate.isLarge,
    gate.renderSource,
    gate.renderVisual,
    entry.docName,
    ytextLength,
    isSourceMode,
  ]);

  return (
    <Activity mode={isActive ? 'visible' : 'hidden'} name={`editor:${entry.docName}`}>
      {/* Per-Activity scroll container with save/restore across Activity
          visibility flips. See ScrollPreservingContainer for the full
          rationale. Hoisting the scroller to EditorArea would make scroll
          state cross-document and collapse scrollHeight on hidden-mode
          effect cleanup. */}
      <ScrollPreservingContainer isActive={isActive} initialScrollTop={warmSnapshot?.scrollTop}>
        {recoveryView ? (
          <ServerRestartRecoveryPanel view={recoveryView} />
        ) : (
          <>
            {/* Per-Activity error + suspense scoping — see file-level docstring
            "ERROR + SUSPENSE SCOPING" for rationale. `activeDocName` passed
            to the boundary is this Activity's OWN docName (entry.docName),
            not the globally-active doc. This keeps the error state tied to
            the Activity instance: a healthy doc becoming active does not
            reset an errored doc's boundary, and revisiting an errored doc
            re-reveals the same error UI. */}
            <DocumentErrorBoundary
              activeDocName={entry.docName}
              previousDocName={previousDocName}
              onNavigateBack={onNavigateBack}
              onRecycle={onRecycle}
            >
              {/*
            Suspense fallback = `EditorSkeleton`. Earlier iteration shipped
            an Option E "static mdast→React preview" fallback that read disk
            bytes and rendered a fumadocs-style tree; the visual jump from
            preview to the real editor (different typography + spacing)
            was jarring enough that we dropped the preview in favor of the
            neutral skeleton. See commit history for `FallbackDocumentRender`
            removal. The perceived-first-paint budget (<500ms P95) still
            applies — the skeleton meets it trivially.
          */}
              <Suspense
                fallback={warmHtml ? <WarmContentFallback html={warmHtml} /> : <EditorSkeleton />}
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
                    <DiffViewBoundary docName={entry.docName} provider={entry.provider} />
                  ) : (
                    /* Dual-editor mount with size-gated defer for large docs. Small
                  docs render both (pre-mount-both default — mode swap stays
                  CSS-only after first source visit). SourceEditor itself is
                  lazy-loaded the first time this doc is shown in source mode.
                  Large docs (>LARGE_DOC_CHAR_THRESHOLD) also defer the non-
                  active editor until its mode is visited at least once — see
                  computeEditorMountGate + evidence/s1-diagnosis.md.

                  Stacking: the wrapper is position:relative + h-full. The
                  non-active child carries `.ok-mode-hidden`, which sets
                  `position:absolute; inset:0; pointer-events:none` alongside
                  `content-visibility:hidden + contain-intrinsic-size`. That
                  takes the hidden editor out of normal flow so its 8000px
                  reserved intrinsic size doesn't size the wrapper or any
                  shared grid row (earlier grid-based stacking sized rows to
                  the MAX intrinsic size across children, stretching the
                  visible editor to 8000px and creating bottom whitespace on
                  short docs — see globals.css §.ok-mode-hidden). */
                    <div className="flex h-full flex-col">
                      {/* Property region (WYSIWYG only — source mode surfaces the
                        raw YAML directly in CodeMirror). Managed-artifact docs
                        (skills/templates) render their own identity panel in
                        place of the document PageHeader + PropertyPanel: `name`
                        (and a skill's `scope`) are identity, not free-form
                        frontmatter, and they have no cover/icon. Regular docs get
                        PageHeader (decorative cover+icon, null when unset) +
                        PropertyPanel (frontmatter table, null when empty). */}
                      {!isSourceMode &&
                        (isManagedArtifactDocName(entry.docName) ||
                        parseProjectSkillContentDocName(entry.docName) ? (
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
                      <div className="relative flex-1">
                        {gate.renderSource ? (
                          <div className={isSourceMode ? 'h-full' : 'ok-mode-hidden h-full'}>
                            <SourceEditorSlot
                              entry={entry}
                              isActive={isActive}
                              isSourceMode={isSourceMode}
                              editorPlaceholder={editorPlaceholder}
                            />
                          </div>
                        ) : null}
                        {gate.renderVisual ? (
                          <div className={isSourceMode ? 'ok-mode-hidden h-full' : 'h-full'}>
                            <TiptapEditor
                              key={`${entry.docName}-${String(isNewDoc)}-${entry.poolEventId}`}
                              provider={entry.provider}
                              placeholder={editorPlaceholder}
                              isSourceMode={isSourceMode}
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
    </Activity>
  );
}
