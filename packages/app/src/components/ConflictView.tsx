import {
  type SyncConflictContentSuccess,
  type SynthesisedConflictRegion,
  synthesiseConflictMarkersWithRegions,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import type {
  FileDiffMetadata,
  MergeConflictMarkerRow,
  MergeConflictRegion,
  MergeConflictResolution,
} from '@pierre/diffs';
import { UnresolvedFile } from '@pierre/diffs';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useConflictFooterHeightVar } from '@/hooks/use-conflict-footer-height';
import { okPierreTheme } from '@/lib/pierre-theme';
import type { ConflictSnapshot } from './conflict-history';
import { ConflictHistory } from './conflict-history';

interface ConflictViewProps {
  fileName: string;
  conflictKind?: SyncConflictContentSuccess['conflictKind'];
  ours: string;
  base: string;
  theirs: string;
  onResolve: (content: string, selection?: MergeConflictResolution) => void | Promise<void>;
}

interface ConflictControl {
  key: string;
  host: HTMLElement;
  conflict: MergeConflictRegion;
}

const CONFLICT_WORD_DIFF_CSS = `
[data-merge-conflict="current"] [data-diff-span] {
  background-color: color-mix(in oklab, var(--diff-added) 32%, transparent);
}
[data-merge-conflict="incoming"] [data-diff-span] {
  background-color: color-mix(in oklab, var(--diff-modified) 32%, transparent);
}
/* Pierre rounds every span and never joins the final diff item into the one
   before it, so a line whose last word changed renders as two boxes with a
   seam — "Priya | Raman" against a single "Marcus Webb" on the other side.
   The break is positional, not meaningful, so flatten the touching corners and
   let adjacent spans read as one run. Cheaper than patching the span builder,
   which is shared by every diff surface in the app. */
[data-diff-span]:has(+ [data-diff-span]) {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
[data-diff-span] + [data-diff-span] {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
`;

let _nextId = 0;

function remainingConflictCount(contents: string): number {
  return contents.split('\n').filter((line) => line.startsWith('<<<<<<< ')).length;
}

function parseAgreesWithSynthesis(
  written: readonly SynthesisedConflictRegion[],
  parsed: MergeConflictRegion,
): boolean {
  const expected = written[parsed.conflictIndex];
  if (!expected) return false;
  return (
    parsed.startLineIndex === expected.startLineIndex &&
    parsed.separatorLineIndex === expected.separatorLineIndex &&
    parsed.endLineIndex === expected.endLineIndex
  );
}

function matchTrailingNewline(resolved: string, ours: string, theirs: string): string {
  if (ours.endsWith('\n') || theirs.endsWith('\n')) return resolved;
  return resolved.endsWith('\n') ? resolved.slice(0, -1) : resolved;
}

function isSnapshotAllResolved(snapshot: ConflictSnapshot): boolean {
  const { fileDiff } = snapshot;
  if (!fileDiff) return false;
  return fileDiff.additionLines.join('') === fileDiff.deletionLines.join('');
}

export function ConflictView({
  fileName,
  conflictKind = 'git',
  ours,
  base,
  theirs,
  onResolve,
}: ConflictViewProps) {
  const { t } = useLingui();
  const containerRef = useRef<HTMLElement>(null);
  const onResolveRef = useRef(onResolve);
  const conflictFooterRef = useConflictFooterHeightVar(true);
  const handleActionRef = useRef<
    ((conflict: MergeConflictRegion, resolution: MergeConflictResolution) => void) | null
  >(null);
  const handleUndoRef = useRef<(() => void) | null>(null);
  const handleRedoRef = useRef<(() => void) | null>(null);
  const handleIdenticalChoiceRef = useRef<((selection: MergeConflictResolution) => void) | null>(
    null,
  );
  const handleApplyRef = useRef<(() => void | Promise<void>) | null>(null);
  const [controls, setControls] = useState<ConflictControl[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [allResolved, setAllResolved] = useState(false);
  const [parseMismatch, setParseMismatch] = useState(false);
  const [liveRemaining, setLiveRemaining] = useState<
    number | 'all-resolved' | 'unavailable' | null
  >(null);
  const applyingRef = useRef(false);
  const [isApplying, setIsApplying] = useState(false);
  const [showBase, setShowBase] = useState(false);
  const identicalStaleVersions = conflictKind === 'stale-external-write' && ours === theirs;

  useEffect(() => {
    onResolveRef.current = onResolve;
  });

  useEffect(() => {
    setControls((prev) => {
      const live = prev.filter((c) => c.host.isConnected);
      return live.length === prev.length ? prev : live;
    });
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { text: markerText, regions: writtenRegions } = synthesiseConflictMarkersWithRegions(
      ours,
      conflictKind === 'stale-external-write' ? null : base || null,
      theirs,
      {
        includeBaseSection: showBase,
      },
    );

    const history = new ConflictHistory({ file: { name: fileName, contents: markerText } });
    setCanUndo(false);
    setCanRedo(false);
    setAllResolved(false);
    setParseMismatch(false);
    let verifyParse = true;
    let parseMismatched = false;

    function syncState(snapshot: ConflictSnapshot) {
      const resolved =
        isSnapshotAllResolved(snapshot) &&
        (conflictKind !== 'stale-external-write' || snapshot.selection !== undefined);
      setCanUndo(history.canUndo);
      setCanRedo(history.canRedo);
      setAllResolved(resolved);
      const remaining =
        conflictKind === 'stale-external-write' && !resolved
          ? 1
          : remainingConflictCount(history.current.file.contents);
      setLiveRemaining(resolved ? 'all-resolved' : remaining);
    }

    const inst = new UnresolvedFile({
      theme: okPierreTheme(),
      overflow: 'wrap',
      lineDiffType: showBase ? 'none' : 'word-alt',
      unsafeCSS: CONFLICT_WORD_DIFF_CSS,
      onMergeConflictAction: (payload) => {
        handleActionRef.current?.(payload.conflict, payload.resolution);
      },
      mergeConflictActionsType: (action) => {
        const host = document.createElement('div');
        _nextId += 1;
        const key = `cc-${_nextId}`;
        if (parseMismatched) return host;
        if (verifyParse && !parseAgreesWithSynthesis(writtenRegions, action.conflict)) {
          parseMismatched = true;
          console.warn(
            JSON.stringify({
              event: 'conflict-parse-mismatch',
              'doc.name': fileName,
              conflictIndex: action.conflict.conflictIndex,
              expected: writtenRegions[action.conflict.conflictIndex] ?? null,
              parsed: {
                startLineIndex: action.conflict.startLineIndex,
                separatorLineIndex: action.conflict.separatorLineIndex,
                endLineIndex: action.conflict.endLineIndex,
              },
            }),
          );
          setParseMismatch(true);
          setControls([]);
          return host;
        }
        setControls((prev) => [...prev, { key, host, conflict: action.conflict }]);
        return host;
      },
    });

    function rerenderAndRestore(snapshot: ConflictSnapshot) {
      if (!container) return;
      verifyParse = false;
      const scrollTop = container.scrollTop;
      inst.render({
        file: snapshot.file,
        fileDiff: snapshot.fileDiff,
        actions: snapshot.actions,
        markerRows: snapshot.markerRows,
        forceRender: true,
      });
      container.scrollTop = scrollTop;
      container.focus();
    }

    handleActionRef.current = (conflict, resolution) => {
      if (parseMismatched) {
        console.warn(
          JSON.stringify({
            event: 'conflict-action-refused-parse-mismatch',
            'doc.name': fileName,
            conflictIndex: conflict.conflictIndex,
            resolution,
          }),
        );
        setLiveRemaining('unavailable');
        return;
      }
      const resolved = inst.resolveConflict(conflict.conflictIndex, resolution);
      if (!resolved) {
        console.warn(
          JSON.stringify({
            event: 'conflict-resolve-declined',
            'doc.name': fileName,
            conflictIndex: conflict.conflictIndex,
            resolution,
          }),
        );
        setLiveRemaining('unavailable');
        return;
      }

      const snapshot: ConflictSnapshot = { ...resolved, selection: resolution };
      history.push(snapshot);

      const done = isSnapshotAllResolved(snapshot);
      syncState(snapshot);
      if (done) setControls([]);

      rerenderAndRestore(snapshot);
    };

    handleUndoRef.current = () => {
      const snapshot = history.undo();
      if (!snapshot) return;
      syncState(snapshot);
      rerenderAndRestore(snapshot);
    };

    handleRedoRef.current = () => {
      const snapshot = history.redo();
      if (!snapshot) return;
      const done = isSnapshotAllResolved(snapshot);
      syncState(snapshot);
      if (done) setControls([]);
      rerenderAndRestore(snapshot);
    };

    handleIdenticalChoiceRef.current = (selection) => {
      if (parseMismatched) {
        console.warn(
          JSON.stringify({
            event: 'conflict-action-refused-parse-mismatch',
            'doc.name': fileName,
            resolution: selection,
          }),
        );
        setLiveRemaining('unavailable');
        return;
      }
      const snapshot: ConflictSnapshot = { ...history.current, selection };
      history.push(snapshot);
      syncState(snapshot);
      rerenderAndRestore(snapshot);
    };

    handleApplyRef.current = () => {
      const content = matchTrailingNewline(history.current.file.contents, ours, theirs);
      return conflictKind === 'stale-external-write'
        ? onResolveRef.current(content, history.current.selection)
        : onResolveRef.current(content);
    };

    inst.render({
      file: { name: fileName, contents: markerText },
      containerWrapper: container,
    });

    const initCache = (
      inst as unknown as {
        computedCache: {
          fileDiff?: FileDiffMetadata;
          actions?: ConflictSnapshot['actions'];
          markerRows?: MergeConflictMarkerRow[];
        };
      }
    ).computedCache;
    if (initCache.fileDiff) {
      const initial: ConflictSnapshot = {
        file: { name: fileName, contents: markerText },
        fileDiff: initCache.fileDiff,
        actions: initCache.actions,
        markerRows: initCache.markerRows,
      };
      history.reset(initial);
      setAllResolved(conflictKind !== 'stale-external-write' && isSnapshotAllResolved(initial));
    }

    return () => {
      inst.cleanUp();
      handleActionRef.current = null;
      handleUndoRef.current = null;
      handleRedoRef.current = null;
      handleIdenticalChoiceRef.current = null;
      handleApplyRef.current = null;
      setControls([]);
      setCanUndo(false);
      setCanRedo(false);
      setAllResolved(false);
      setParseMismatch(false);
    };
  }, [fileName, ours, base, theirs, showBase, conflictKind]);

  const absentStageBanner =
    conflictKind === 'stale-external-write'
      ? null
      : !ours
        ? t`This file was deleted on the current branch (delete-modify conflict).`
        : !theirs
          ? t`This file was deleted on the incoming branch (modify-delete conflict).`
          : !base
            ? t`No common ancestor — both branches added this file (add/add conflict).`
            : null;

  return (
    <div className="flex h-full flex-col">
      {conflictKind === 'stale-external-write' && (
        <div className="shrink-0 px-3 py-2">
          <Alert role="status">
            <AlertDescription>
              {t`The file was restored to an older version. Current is the version OpenKnowledge protected. Incoming is the restored version. Choose which version to keep, then apply your changes.`}
              {identicalStaleVersions
                ? ` ${t`Both versions are identical. Choosing Accept current leaves OpenKnowledge's protection on, so another save of the older version is refused again. Choosing Accept incoming turns that protection off.`}`
                : null}
            </AlertDescription>
          </Alert>
        </div>
      )}
      {}
      {absentStageBanner && (
        <p role="status" className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">
          {absentStageBanner}
        </p>
      )}
      {}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {liveRemaining === null
          ? ''
          : liveRemaining === 'all-resolved'
            ? t`All conflicts resolved. Apply changes to save.`
            : liveRemaining === 'unavailable'
              ? t`That conflict is no longer available.`
              : t`Conflicts remaining: ${liveRemaining}.`}
      </div>
      {parseMismatch && (
        <p role="status" className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">
          {t`This file contains lines that look like conflict markers, so the conflict boundaries can't be read reliably. Resolve it by hand or with Ask AI.`}
        </p>
      )}
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-2">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={parseMismatch || !canUndo}
          onClick={() => handleUndoRef.current?.()}
        >
          {t`Undo`}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={parseMismatch || !canRedo}
          onClick={() => handleRedoRef.current?.()}
        >
          {t`Redo`}
        </Button>
        {base && conflictKind !== 'stale-external-write' ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-pressed={showBase}
            aria-label={t`Show original`}
            title={canUndo || canRedo ? t`Undo your resolutions to change this.` : undefined}
            disabled={parseMismatch || canUndo || canRedo}
            onClick={() => setShowBase((v) => !v)}
          >
            {showBase ? t`Hide original` : t`Show original`}
          </Button>
        ) : null}
      </div>
      {identicalStaleVersions && !parseMismatch && !allResolved && (
        <div className="shrink-0 px-3 py-2">
          <ConflictActions
            onSelect={(selection) => handleIdenticalChoiceRef.current?.(selection)}
          />
        </div>
      )}
      <section
        ref={containerRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-focusable scroll container — Chromium doesn't make overflow:auto elements focusable without tabIndex, and axe's scrollable-region-focusable requires the stop. Same pattern as SyncStatusBadge's scroll container.
        tabIndex={0}
        aria-label={t`Conflict diff for ${fileName}`}
        className="conflict-view min-h-0 flex-1 overflow-y-auto subtle-scrollbar"
      />
      {}
      <div
        ref={conflictFooterRef}
        className="flex shrink-0 items-center justify-end gap-2 border-t px-3 py-2"
      >
        {allResolved && !parseMismatch && (
          <Button
            type="button"
            size="sm"
            disabled={isApplying}
            onClick={() => {
              if (applyingRef.current) return;
              applyingRef.current = true;
              setIsApplying(true);
              void Promise.resolve(handleApplyRef.current?.()).finally(() => {
                applyingRef.current = false;
                setIsApplying(false);
              });
            }}
          >
            {t`Apply changes`}
          </Button>
        )}
      </div>
      {}
      {!parseMismatch &&
        controls.map((control) =>
          createPortal(
            <ConflictActions
              conflictIndex={control.conflict.conflictIndex}
              onSelect={(selection) => handleActionRef.current?.(control.conflict, selection)}
            />,
            control.host,
            control.key,
          ),
        )}
    </div>
  );
}

function ConflictActions({
  conflictIndex,
  onSelect,
}: {
  conflictIndex?: number;
  onSelect: (selection: MergeConflictResolution) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        size="xs"
        variant="outline"
        aria-label={
          conflictIndex === undefined
            ? undefined
            : t`Accept current version for conflict ${conflictIndex + 1}`
        }
        onClick={() => onSelect('current')}
      >
        {t`Accept current`}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="outline"
        aria-label={
          conflictIndex === undefined
            ? undefined
            : t`Accept incoming version for conflict ${conflictIndex + 1}`
        }
        onClick={() => onSelect('incoming')}
      >
        {t`Accept incoming`}
      </Button>
      {conflictIndex !== undefined && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-label={t`Accept both versions for conflict ${conflictIndex + 1}`}
          onClick={() => onSelect('both')}
        >
          {t`Accept both`}
        </Button>
      )}
    </div>
  );
}
