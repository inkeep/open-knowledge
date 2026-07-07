import { undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { getChunks, MergeView, unifiedMergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { basicDarkInit, basicLightInit } from '@uiw/codemirror-theme-basic';
import { basicSetup } from 'codemirror';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConflictFooterHeightVar } from '@/hooks/use-conflict-footer-height';
import { Button } from './ui/button';

const darkTheme = basicDarkInit({
  settings: {
    background: 'var(--background)',
    gutterBackground: 'var(--muted)',
  },
});

const lightTheme = basicLightInit({
  settings: {
    background: 'var(--background)',
    gutterBackground: 'var(--muted)',
  },
});

const conflictMergeControlTheme = EditorView.theme({
  '.cm-deletedChunk .cm-chunkButtons': {
    display: 'flex',
    gap: '0.25rem',
  },
  ".cm-deletedChunk .cm-chunkButtons button[data-slot='button']": {
    margin: '0',
    border: '1px solid transparent',
    borderRadius: 'min(var(--radius-md), 10px)',
    color: 'var(--primary-foreground)',
  },
  ".cm-deletedChunk .cm-chunkButtons button[data-slot='button'][data-variant='destructive']": {
    color: 'var(--destructive)',
  },
});

export type DiffLayout = 'unified' | 'split';

interface MergeControlPortal {
  id: number;
  host: HTMLElement;
  type: 'reject' | 'accept';
  action: (event: MouseEvent) => void;
}

function createMergeControlRenderer({
  addControl,
  nextId,
  removeControl,
  root,
}: {
  addControl: (control: MergeControlPortal) => void;
  nextId: () => number;
  removeControl: (id: number) => void;
  root: HTMLElement;
}) {
  return (type: 'reject' | 'accept', action: (event: MouseEvent) => void): HTMLElement => {
    const host = document.createElement('span');
    host.className = 'inline-flex';
    const id = nextId();
    addControl({ id, host, type, action });
    queueMicrotask(() => {
      if (!root.contains(host)) removeControl(id);
    });
    return host;
  };
}

interface DiffViewProps {
  oldContent: string;
  newContent: string;
  layout: DiffLayout;
  /** When true, renders a conflict-resolution editor with per-hunk Accept/Reject. */
  conflictMode?: boolean;
  /**
   * When true, renders `newContent` as a plain read-only CodeMirror surface
   * — no diff against `oldContent`, no hunks, no merge controls. Used by the
   * delete-vs-modify resolution surfaces in `DiffViewBoundary` to preview
   * the surviving file content without diff coloring (the user is choosing
   * between "keep this file" and "delete this file"; the changes-since-base
   * view added noise without informing the decision). When set, `layout`
   * and `conflictMode` are ignored; `oldContent` is unused.
   */
  previewMode?: boolean;
  /**
   * When provided, replaces `newContent` as the bytes shown in the `ours`
   * pane. Lets the conflict-mode caller surface the in-memory Y.Text snapshot
   * (what the user typed mid-conflict, including pre-conflict unflushed
   * edits) instead of the git-index `:2:` bytes — so what the user SEES in
   * the diff IS what a `strategy: 'content'` resolve would write. When
   * omitted the component behaves identically to before.
   */
  oursOverride?: string;
  /** Called with the merged document when all hunks are resolved. */
  onResolve?: (content: string) => void;
  /** Called when the user aborts the merge. */
  onAbort?: () => void;
}

export function DiffView({
  oldContent,
  newContent,
  layout,
  conflictMode,
  previewMode,
  oursOverride,
  onResolve,
  onAbort,
}: DiffViewProps) {
  const { t } = useLingui();
  // When the caller hands us an explicit `ours` snapshot (the Y.Text bytes
  // the user has been seeing in the editor), it takes precedence over the
  // legacy `newContent` prop. This keeps the displayed `ours` pane equal
  // to what a `strategy: 'content'` resolve would write — closing the
  // byte-divergence vs `git show :2:` for any loaded doc with unflushed
  // pre-conflict Y.Text edits.
  const effectiveNewContent = oursOverride ?? newContent;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MergeView | EditorView | null>(null);
  const mergeControlIdRef = useRef(0);
  const { resolvedTheme } = useTheme();
  const onResolveRef = useRef(onResolve);
  const onAbortRef = useRef(onAbort);
  // Tracks unresolved hunk count in conflictMode so the "Save resolution"
  // button can gate on it. null = pre-init (no view yet).
  const [chunksRemaining, setChunksRemaining] = useState<number | null>(null);
  const [mergeControls, setMergeControls] = useState<MergeControlPortal[]>([]);
  // Keeps the floating Ask AI composer stacked above the conflict footer —
  // see the contract note in use-conflict-footer-height.ts.
  const conflictFooterRef = useConflictFooterHeightVar(conflictMode === true);
  useEffect(() => {
    onResolveRef.current = onResolve;
    onAbortRef.current = onAbort;
  });

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    setMergeControls([]);
    const mergeControlHosts = new Map<number, HTMLElement>();
    let disposed = false;
    const removeMergeControl = (id: number) => {
      if (disposed || !mergeControlHosts.delete(id)) return;
      setMergeControls((controls) => controls.filter((control) => control.id !== id));
    };
    const mergeControlObserver = new MutationObserver(() => {
      for (const [id, host] of mergeControlHosts) {
        if (!root.contains(host)) removeMergeControl(id);
      }
    });
    mergeControlObserver.observe(root, { childList: true, subtree: true });

    const theme = resolvedTheme === 'dark' ? darkTheme : lightTheme;
    const readOnly = [EditorView.editable.of(false), EditorState.readOnly.of(true)];
    const sharedExtensions = [basicSetup, markdown(), ...readOnly, theme, EditorView.lineWrapping];

    // Clear any previous view
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    if (previewMode) {
      // Preview mode: plain read-only CodeMirror surface for `newContent`.
      // No `unifiedMergeView` extension — no diff against `oldContent`,
      // no hunk markers, no gutter chrome. Used by the delete-vs-modify
      // resolution surfaces to show the surviving file as-is; the user
      // is choosing whether to keep or delete it, not which hunks to
      // accept. Resets `chunksRemaining` to null since the concept does
      // not apply here — the merge-resolution footer (rendered below in
      // conflictMode) is intentionally hidden in this mode by the
      // `conflictMode && ...` guards at the JSX layer.
      const view = new EditorView({
        doc: effectiveNewContent,
        extensions: sharedExtensions,
        parent: root,
      });
      viewRef.current = view;
      setChunksRemaining(null);
    } else if (conflictMode) {
      // Conflict mode: unified diff with per-hunk Accept/Reject buttons.
      // editable=false prevents typing; readOnly is NOT set so merge ops can mutate the doc.
      const renderMergeControl = createMergeControlRenderer({
        addControl: (control) => {
          if (disposed) return;
          mergeControlHosts.set(control.id, control.host);
          setMergeControls((controls) => [...controls, control]);
        },
        nextId: () => {
          mergeControlIdRef.current += 1;
          return mergeControlIdRef.current;
        },
        removeControl: removeMergeControl,
        root,
      });
      const conflictExtensions = [
        basicSetup,
        markdown(),
        EditorView.editable.of(false),
        theme,
        conflictMergeControlTheme,
        EditorView.lineWrapping,
        unifiedMergeView({
          original: oldContent,
          highlightChanges: true,
          gutter: true,
          mergeControls: renderMergeControl,
          collapseUnchanged: { margin: 3, minSize: 4 },
        }),
        EditorView.updateListener.of((update) => {
          // @codemirror/merge's acceptChunk dispatches effects-only (no doc
          // change), so we cannot gate on update.docChanged. Re-read chunks
          // on every update and let the explicit "Save resolution" button
          // drive completion.
          const result = getChunks(update.state);
          setChunksRemaining(result ? result.chunks.length : 0);
        }),
      ];
      const view = new EditorView({
        doc: effectiveNewContent,
        extensions: conflictExtensions,
        parent: root,
      });
      viewRef.current = view;
      // Seed initial hunk count (updateListener only fires on subsequent updates).
      const initial = getChunks(view.state);
      setChunksRemaining(initial ? initial.chunks.length : 0);
    } else if (layout === 'split') {
      const mv = new MergeView({
        a: { doc: oldContent, extensions: sharedExtensions },
        b: { doc: effectiveNewContent, extensions: sharedExtensions },
        parent: root,
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: { margin: 3, minSize: 4 },
      });
      viewRef.current = mv;
    } else {
      const view = new EditorView({
        doc: effectiveNewContent,
        extensions: [
          ...sharedExtensions,
          unifiedMergeView({
            original: oldContent,
            highlightChanges: true,
            gutter: true,
            mergeControls: false,
            collapseUnchanged: { margin: 3, minSize: 4 },
          }),
        ],
        parent: root,
      });
      viewRef.current = view;
    }

    return () => {
      disposed = true;
      mergeControlObserver.disconnect();
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [oldContent, effectiveNewContent, layout, resolvedTheme, conflictMode, previewMode]);

  function handleSaveResolution() {
    const view = viewRef.current;
    if (!view || !(view instanceof EditorView)) return;
    onResolveRef.current?.(view.state.doc.toString());
  }

  function handleUndo() {
    const view = viewRef.current;
    if (!view || !(view instanceof EditorView)) return;
    undo(view);
  }

  const allResolved = chunksRemaining === 0;
  const hunksLabel =
    chunksRemaining === null
      ? ''
      : chunksRemaining === 0
        ? t`All hunks resolved`
        : plural(chunksRemaining, {
            one: '# unresolved hunk',
            other: '# unresolved hunks',
          });

  return (
    <div className="flex flex-col h-full">
      <div
        ref={containerRef}
        className="diff-view min-h-0 flex-1 overflow-y-auto subtle-scrollbar"
      />
      {mergeControls.map((control) =>
        createPortal(
          <Button
            type="button"
            variant={control.type === 'accept' ? 'default' : 'destructive'}
            size="xs"
            onClick={(event) => {
              control.action(event.nativeEvent);
            }}
          >
            {control.type === 'accept' ? t`Accept` : t`Reject`}
          </Button>,
          control.host,
          control.id,
        ),
      )}
      {conflictMode && (
        <div
          ref={conflictFooterRef}
          className="flex items-center justify-between gap-2 px-3 py-2 border-t shrink-0"
        >
          <span
            className={`text-xs ${allResolved ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}
          >
            {hunksLabel}
          </span>
          <div className="flex items-center gap-2">
            {onAbort && (
              <Button className="uppercase font-mono" variant="ghost" size="sm" onClick={onAbort}>
                <Trans>Exit merge</Trans>
              </Button>
            )}
            <Button
              className="uppercase font-mono"
              variant="outline"
              size="sm"
              onClick={handleUndo}
            >
              Undo
            </Button>
            {onResolve && (
              <Button
                variant="default"
                size="sm"
                disabled={!allResolved}
                onClick={handleSaveResolution}
              >
                <Trans>Save resolution</Trans>
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
