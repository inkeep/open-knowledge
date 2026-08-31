/**
 * ConflictView — renders a both-modified merge conflict through Pierre's
 * vanilla UnresolvedFile class (not the React wrapper).
 *
 * Receives pre-fetched ours/base/theirs bytes from DiffViewBoundary,
 * synthesises diff3 conflict markers, and mounts Pierre into the host div.
 * Resolution fires onResolve once "Apply changes" is confirmed, allowing
 * undo/redo of any resolution before the file is written.
 *
 * Per-conflict shadcn Buttons are portaled into light-DOM host elements
 * that Pierre manages via mergeConflictActionsType. handleActionRef stores
 * the action handler (defined inside the effect so inst stays in scope)
 * so that JSX portal buttons can call it without making it a dep.
 * The prune effect (no deps) removes disconnected hosts after each
 * forceRender cycle.
 */

import {
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
import { Button } from '@/components/ui/button';
import { useConflictFooterHeightVar } from '@/hooks/use-conflict-footer-height';
import { okPierreTheme } from '@/lib/pierre-theme';
import type { ConflictSnapshot } from './conflict-history';
import { ConflictHistory } from './conflict-history';

interface ConflictViewProps {
  /** On-disk path of the conflicted file, shown in Pierre's file header. */
  fileName: string;
  ours: string;
  base: string;
  theirs: string;
  onResolve: (content: string) => void | Promise<void>;
}

interface ConflictControl {
  key: string;
  host: HTMLElement;
  conflict: MergeConflictRegion;
}

/**
 * Pierre styles intra-line diff spans only on `change-addition` /
 * `change-deletion` rows. Conflict rows are neither — they carry
 * `data-line-type="context"` plus `data-merge-conflict`, so the spans it
 * generates land unstyled and invisible. These rules give them the fill,
 * keyed to the same channels the row backgrounds use: ours reads as an
 * addition, theirs as a modification.
 *
 * Injected through Pierre's own `unsafeCSS` rather than `globals.css` because
 * the spans live inside the shadow root, where page rules cannot reach.
 *
 * Reads the app tokens, not the `--diffs-*` names globals.css derives from
 * them: those are what Pierre would write at `:host`, and the theme test
 * treats their appearance in shadow-root CSS as the bundled-palette
 * regression. App tokens inherit through the boundary just as well.
 */
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

/**
 * How many conflict blocks are still unresolved in a snapshot's text.
 *
 * Counted from the marker bytes rather than Pierre's model because resolving a
 * region deletes its markers outright — so the count needs no bookkeeping and
 * cannot drift from what the user is looking at.
 */
function remainingConflictCount(contents: string): number {
  return contents.split('\n').filter((line) => line.startsWith('<<<<<<< ')).length;
}

/**
 * Does one of Pierre's parsed conflict regions sit where we wrote it?
 *
 * The markers are unambiguous only on the way out. Seven `=` is a separator to
 * us and to Pierre's `/^={7,}$/` — and also a line a user may have typed, as a
 * setext heading underline, a divider rule, or a quoted conflict marker in a
 * document about git. Once such a line sits inside a conflict section the text
 * carries two lines that look identical and nothing says which is structural,
 * so Pierre anchors the split on the wrong one. Resolving against those
 * boundaries drops the user's own lines and reports success.
 *
 * Since we synthesised the text, we know where every marker really is.
 * Comparing the two is exact — integers both sides should agree on, not bytes
 * subject to normalisation — so this cannot cry wolf on a correct parse.
 */
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

/**
 * Pierre rebuilds the file from its parsed rows and always terminates the last
 * one, so a source that ended mid-line comes back with a newline it never had.
 * Only strip when BOTH sides agree the file has no EOF newline — when they
 * disagree the correct answer depends on which side won each region, which the
 * rebuilt text no longer records.
 */
function matchTrailingNewline(resolved: string, ours: string, theirs: string): string {
  if (ours.endsWith('\n') || theirs.endsWith('\n')) return resolved;
  return resolved.endsWith('\n') ? resolved.slice(0, -1) : resolved;
}

// Returns true when the snapshot's diff model has no remaining divergent regions,
// i.e. all conflicts have been accepted.
function isSnapshotAllResolved(snapshot: ConflictSnapshot): boolean {
  const { fileDiff } = snapshot;
  if (!fileDiff) return false;
  return fileDiff.additionLines.join('') === fileDiff.deletionLines.join('');
}

export function ConflictView({ fileName, ours, base, theirs, onResolve }: ConflictViewProps) {
  const { t } = useLingui();
  const containerRef = useRef<HTMLElement>(null);
  const onResolveRef = useRef(onResolve);
  const conflictFooterRef = useConflictFooterHeightVar(true);
  // handleActionRef / handleUndoRef / handleRedoRef / handleApplyRef store handlers
  // defined inside the [ours,base,theirs] effect so inst and history stay in scope.
  const handleActionRef = useRef<
    ((conflict: MergeConflictRegion, resolution: MergeConflictResolution) => void) | null
  >(null);
  const handleUndoRef = useRef<(() => void) | null>(null);
  const handleRedoRef = useRef<(() => void) | null>(null);
  const handleApplyRef = useRef<(() => void | Promise<void>) | null>(null);
  const [controls, setControls] = useState<ConflictControl[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [allResolved, setAllResolved] = useState(false);
  // Set when Pierre's parse disagrees with the markers we wrote — see
  // `parseAgreesWithSynthesis`. Every control is withheld in that state.
  const [parseMismatch, setParseMismatch] = useState(false);
  // Resolve / undo / redo mutate the diff imperatively and move focus to the
  // scroll container, so a sighted user sees the change and a screen-reader
  // user gets silence — including when `Apply changes` appears, which is the
  // terminal action of the whole workflow. This region is always mounted and
  // starts empty: a live region inserted at the same moment as its text is
  // unreliably announced.
  // `null` = nothing announced yet, so the region renders empty on mount.
  const [liveRemaining, setLiveRemaining] = useState<
    number | 'all-resolved' | 'unavailable' | null
  >(null);
  // Apply runs `git add` + `git commit --no-edit` server-side, so a second
  // click races the first against the working tree and reports
  // "no conflict tracked for file" — an error toast after a success.
  //
  // The latch is the ref, not the state beside it. React batches, so several
  // clicks dispatched before the next render all observe `isApplying === false`
  // and the disabled attribute never gets a chance to apply; only a ref updates
  // in time to turn the second click away. The state exists to grey the button.
  const applyingRef = useRef(false);
  const [isApplying, setIsApplying] = useState(false);
  // The merge base is the capability this view exists to provide, but three
  // stacked versions of a paragraph is a lot to read when you only need two.
  // Hidden by default; revealed on demand.
  const [showBase, setShowBase] = useState(false);

  // Keep onResolve current without remounting Pierre on every render.
  useEffect(() => {
    onResolveRef.current = onResolve;
    // `t` is bound to the Lingui context object, which is swapped on every
    // `i18n.activate()` — including an external `.ok/config.yml` language edit
    // or a change made in another window. Held in the dep array below it would
    // re-run the mount effect: a new ConflictHistory, `inst.cleanUp()`, every
    // state reset — silently discarding accepted-but-unapplied resolutions for
    // a language change. Nothing in the effect needs it synchronously; Pierre
    // renders no translated strings, and the live region composes its own text
    // in render from the count this effect stores.
  });

  // Prune disconnected hosts after every render — Pierre removes slot wrappers
  // on forceRender, leaving hosts detached. New hosts aren't connected yet when
  // mergeConflictActionsType fires, so filtering by isConnected is deferred here.
  useEffect(() => {
    setControls((prev) => {
      const live = prev.filter((c) => c.host.isConnected);
      return live.length === prev.length ? prev : live;
    });
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Treat empty-string base as absent so synthesiseConflictMarkers picks
    // the 2-way format instead of a diff3 block with an empty base section.
    const { text: markerText, regions: writtenRegions } = synthesiseConflictMarkersWithRegions(
      ours,
      base || null,
      theirs,
      {
        // The base always feeds the three-way merge — it is what determines which
        // regions actually conflict. Only its display is toggled. Passing a null
        // base instead would collapse the entire file into one conflict block.
        includeBaseSection: showBase,
      },
    );

    const history = new ConflictHistory({ file: { name: fileName, contents: markerText } });
    setCanUndo(false);
    setCanRedo(false);
    setAllResolved(false);
    setParseMismatch(false);
    // Pierre reports its regions through `mergeConflictActionsType`, which
    // fires after render() returns rather than inside it — so the check runs
    // per region as each arrives. It applies only to the initial parse of the
    // text we synthesised; every later render is of Pierre's own resolved
    // output, whose boundaries we never wrote and cannot predict.
    let verifyParse = true;
    let parseMismatched = false;

    function syncState(resolved: boolean) {
      setCanUndo(history.canUndo);
      setCanRedo(history.canRedo);
      setAllResolved(resolved);
      const remaining = remainingConflictCount(history.current.file.contents);
      // A COUNT, not a sentence. Lingui's `t` macro is name-based, so it only
      // transforms a tag literally spelled `t` — aliasing it through a ref
      // leaves a raw tagged template, which the React Compiler then refuses to
      // lower once it carries an interpolation. Both facts are invisible to
      // typecheck and tests and surface only in the production build. Keeping
      // `t` out of this effect's deps (a locale change must not rebuild the
      // instance) and composing the message in render satisfies both.
      setLiveRemaining(resolved ? 'all-resolved' : remaining);
    }

    const inst = new UnresolvedFile({
      theme: okPierreTheme(),
      // Conflict bodies are prose paragraphs, not code. Pierre defaults to
      // horizontal scroll, which hides all but the first ~110 characters of a
      // long paragraph behind a scrollbar and makes the three versions look
      // identical, since only their shared opening is visible.
      overflow: 'wrap',
      // Word-level highlighting inside conflicts, restored by our patch to
      // Pierre's UnresolvedFileHunksRenderer, which otherwise pins this to
      // 'none'. Measured on a genuine three-way divergence: it pairs ours
      // against theirs and marks the differing words on each side.
      //
      // Only in two-way mode. With a base section present the pairing produces
      // nothing at all, so leaving it on there would make highlighting appear
      // and vanish as the user toggles Show original — which is very likely why
      // upstream pins it off rather than reasoning per-mode. Tying it to the
      // toggle makes the capability change something the user just asked for.
      lineDiffType: showBase ? 'none' : 'word-alt',
      unsafeCSS: CONFLICT_WORD_DIFF_CSS,
      // onMergeConflictAction keeps Pierre in controlled mode so
      // inst.render({ ...resolved, forceRender: true }) works correctly.
      onMergeConflictAction: (payload) => {
        handleActionRef.current?.(payload.conflict, payload.resolution);
      },
      mergeConflictActionsType: (action) => {
        const host = document.createElement('div');
        _nextId += 1;
        const key = `cc-${_nextId}`;
        // Append-only: host isn't connected yet when this fires (Pierre
        // connects it after the function returns). Pruning happens in the
        // no-dep effect above, which runs after each render.
        // Latched, not per-region: Pierre reports each region separately, so
        // clearing `controls` on the one that disagrees still let every LATER
        // region append to the freshly emptied array — a refusal banner beside
        // live Accept buttons on the same file.
        if (parseMismatched) return host;
        if (verifyParse && !parseAgreesWithSynthesis(writtenRegions, action.conflict)) {
          // With a boundary wrong, "accept current" writes the wrong bytes.
          // No control on this file can be trusted, so withhold all of them:
          // an honest dead end beats a silent one.
          parseMismatched = true;
          // The only controlless state that emitted nothing. A mismatch means
          // either a document carrying marker-lookalike lines or a Pierre
          // parser regression, and the two are indistinguishable from the UI —
          // so a "blank conflict pane" report arrives with no way to tell them
          // apart. Expected-vs-parsed is the whole diagnosis in one line.
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

    // After every forceRender, restore scroll position (line-anchor: save before
    // render, restore after — browser clamps when content shrinks, so this does
    // not leave the viewport past the end) and return focus to the scrollable
    // container so keyboard users can immediately navigate to the next conflict.
    function rerenderAndRestore(snapshot: ConflictSnapshot) {
      if (!container) return;
      verifyParse = false;
      const scrollTop = container.scrollTop;
      inst.render({ ...snapshot, forceRender: true });
      container.scrollTop = scrollTop;
      container.focus();
    }

    handleActionRef.current = (conflict, resolution) => {
      // The four render sites withhold every control once the parse is
      // mismatched, so this is unreachable through the UI. It is here because
      // the render gate protects the *controls*, not the mutation: Pierre owns
      // the shadow DOM these buttons live in and reuses its hosts, so a control
      // that outlives a re-parse could reach this with an index the refusal was
      // declared against. `parseMismatched` is the effect-scoped latch, not the
      // state — it flips before React re-renders the gates.
      //
      // Announced and logged for the same reason the `!resolved` branch below
      // is: this fires only when a control the gates cannot reach was clicked,
      // so a bare return would leave the user clicking a live-looking button
      // in silence, in the one case the guard exists for. Its own event name —
      // the diagnosis is "the parse check fired", which pairs with the
      // `conflict-parse-mismatch` warn and is a different fault from the stale
      // `conflictIndex` the sibling reports.
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
        // Reachable, not theoretical: controls are deliberately NOT cleared on
        // undo (Pierre reuses its hosts), so a retained control can carry a
        // conflictIndex from an earlier parse — and a stale index leaves that
        // button dead for the rest of the session. Bare `return` made the click
        // land on an enabled control and do nothing, with no log and total
        // silence for a screen-reader user. Contrast history.undo()/redo(),
        // whose null returns are unreachable behind their disabled attributes.
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

      // Pierre's output is used as-is. Patching it here corrupted every
      // conflict after the first: the snapshot carried our edited
      // `file.contents` alongside Pierre's `fileDiff` describing the UNedited
      // text, and Pierre positions conflicts from `fileDiff`. The second
      // resolution then spliced into the separator line and dropped both of its
      // content lines. `both` on two prose paragraphs consequently produces a
      // run-on where a blank line belongs — cosmetic, editable, and much
      // cheaper than silent data loss.
      const snapshot: ConflictSnapshot = resolved;
      history.push(snapshot);

      const done = isSnapshotAllResolved(snapshot);
      syncState(done);
      if (done) setControls([]);

      rerenderAndRestore(snapshot);
    };

    handleUndoRef.current = () => {
      const snapshot = history.undo();
      if (!snapshot) return;
      syncState(isSnapshotAllResolved(snapshot));
      // Deliberately NOT clearing controls here. Pierre only calls
      // mergeConflictActionsType for conflicts whose action set changed; it
      // reuses the host for any it considers unchanged. Wiping the list assumed
      // every host would be re-requested, so a reused host lost its entry and
      // never regained one — its buttons were gone for the rest of the session.
      // Visible only when undoing a resolve of the LAST conflict, since
      // resolving an earlier one renumbers the survivor and makes Pierre treat
      // it as changed. The prune effect drops genuinely detached hosts.
      rerenderAndRestore(snapshot);
    };

    handleRedoRef.current = () => {
      const snapshot = history.redo();
      if (!snapshot) return;
      const done = isSnapshotAllResolved(snapshot);
      syncState(done);
      if (done) setControls([]);
      rerenderAndRestore(snapshot);
    };

    handleApplyRef.current = () =>
      onResolveRef.current(matchTrailingNewline(history.current.file.contents, ours, theirs));

    inst.render({
      file: { name: fileName, contents: markerText },
      containerWrapper: container,
    });

    // Pierre's parseMergeConflictDiffFromFile runs synchronously inside render(),
    // so computedCache.fileDiff is already populated here. Backfill the initial
    // history entry with the full snapshot so rerenderAndRestore() can pass
    // fileDiff+actions to forceRender when undoing to the initial state — passing
    // only `file` after initialization throws inside UnresolvedFile.getOrComputeDiff.
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
      // A file can arrive with no divergent region at all: the server records a
      // conflict whenever the three-way merge declines, and it declines on
      // grounds a line-level re-merge does not reproduce. Seeding from the
      // parse rather than from `false` is what puts Apply on screen — with no
      // regions there is no Accept control to press, so nothing would ever set
      // it and the file could only be resolved by handing it to an agent.
      setAllResolved(isSnapshotAllResolved(initial));
    }

    return () => {
      inst.cleanUp();
      handleActionRef.current = null;
      handleUndoRef.current = null;
      handleRedoRef.current = null;
      handleApplyRef.current = null;
      setControls([]);
      setCanUndo(false);
      setCanRedo(false);
      setAllResolved(false);
      setParseMismatch(false);
    };
  }, [fileName, ours, base, theirs, showBase]);

  // Derive the absent-stage kind from the incoming props. These banners
  // surface context that Pierre's own rendering cannot express: an empty ours
  // section looks identical to a render failure without a label.
  const absentStageBanner = !ours
    ? t`This file was deleted on the current branch (delete-modify conflict).`
    : !theirs
      ? t`This file was deleted on the incoming branch (modify-delete conflict).`
      : !base
        ? t`No common ancestor — both branches added this file (add/add conflict).`
        : null;

  return (
    <div className="flex h-full flex-col">
      {/* Both strips are `role="status"`: the boundary swaps this view in without
          a navigation, so a screen reader reaching the pane in document order
          would otherwise meet an empty diff and no reason for it. Announcing
          them is what makes the absent stage and the refusal legible at all —
          they exist precisely because there is nothing to render. */}
      {absentStageBanner && (
        <p role="status" className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">
          {absentStageBanner}
        </p>
      )}
      {/* Light DOM on purpose: a live region inside Pierre's `<diffs-container>`
          shadow root is announced unreliably across screen readers. */}
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
        {base ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-pressed={showBase}
            // The visible label swaps to name the ACTION; the accessible name
            // stays put. APG is explicit that a toggle's label should not move
            // with its state — "Hide original, toggle button, pressed" has the
            // label describing the undo and `pressed` describing the state.
            aria-label={t`Show original`}
            // The rationale below never reached the user: the control simply
            // went dead after the first resolve. `title` rather than a Tooltip
            // because a disabled button swallows the pointer events Radix
            // needs.
            title={canUndo || canRedo ? t`Undo your resolutions to change this.` : undefined}
            // Toggling re-synthesises the marker text, which re-parses every
            // conflict and renumbers their indices, so any in-progress
            // resolution would be discarded. Gate on either direction being
            // live rather than silently dropping the user's work: undoing back
            // to the start leaves canUndo false while a full redo stack is
            // still standing, and that stack is work too.
            disabled={parseMismatch || canUndo || canRedo}
            onClick={() => setShowBase((v) => !v)}
          >
            {showBase ? t`Hide original` : t`Show original`}
          </Button>
        ) : null}
      </div>
      <section
        ref={containerRef}
        // A scrollable region needs a real tab stop or a keyboard user cannot
        // scroll it (WCAG 2.1.1). Normally they would tab into an Accept
        // button, but in the refusal and all-resolved states there are no
        // controls at all and the whole diff becomes mouse-only. Being
        // focusable also gives rerenderAndRestore() a named place to return
        // focus to, rather than an anonymous div.
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-focusable scroll container — Chromium doesn't make overflow:auto elements focusable without tabIndex, and axe's scrollable-region-focusable requires the stop. Same pattern as SyncStatusBadge's scroll container.
        tabIndex={0}
        aria-label={t`Conflict diff for ${fileName}`}
        className="conflict-view min-h-0 flex-1 overflow-y-auto subtle-scrollbar"
      />
      {/* The footer stays mounted even while empty: useConflictFooterHeightVar
          publishes its height so the floating Ask AI composer stacks above it. */}
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
      {/* Each trio repeats verbatim per conflict, so the visible labels alone give
          a screen-reader user browsing by button "Accept current" N times with
          nothing to tell them apart. The 1-based conflict number is the
          disambiguator, and it is already in hand — the same `conflictIndex` the
          click handler resolves against. */}
      {!parseMismatch &&
        controls.map((control) =>
          createPortal(
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="xs"
                variant="outline"
                aria-label={t`Accept current version for conflict ${control.conflict.conflictIndex + 1}`}
                onClick={() => handleActionRef.current?.(control.conflict, 'current')}
              >
                {t`Accept current`}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                aria-label={t`Accept incoming version for conflict ${control.conflict.conflictIndex + 1}`}
                onClick={() => handleActionRef.current?.(control.conflict, 'incoming')}
              >
                {t`Accept incoming`}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                aria-label={t`Accept both versions for conflict ${control.conflict.conflictIndex + 1}`}
                onClick={() => handleActionRef.current?.(control.conflict, 'both')}
              >
                {t`Accept both`}
              </Button>
            </div>,
            control.host,
            control.key,
          ),
        )}
    </div>
  );
}
