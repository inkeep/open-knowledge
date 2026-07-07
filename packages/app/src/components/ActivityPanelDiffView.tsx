/**
 * ActivityPanelDiffView — the single inline-diff renderer for the document
 * panel side pane. Built on `react-diff-view` and used by both:
 *   - the Agent Activity Panel — per-burst diffs lazy-fetched from
 *     `GET /api/agent-burst-diff?agentId=<>&docName=<>&stackIndex=<>`
 *     (server synthesizes via `synthesizeStackItemDiffText`).
 *   - the Timeline tab — per-entry diffs computed client-side in
 *     `useTimelineEntryDiff` via `diff.createPatch` against the live
 *     Y.Text, so the user's unsaved WIP is part of the comparison.
 *
 * Input: a unified-diff string. Empty input renders a subtle "No changes"
 * placeholder instead of an empty hunk — that case shows up when a burst
 * StackItem has no net effect, or a Timeline entry is byte-identical to
 * current after frontmatter stripping.
 *
 * The `viewType` prop selects unified (default — Activity Panel hardcodes
 * this) vs split layout (Timeline plumbs the user's split/unified preference
 * down from the editor header).
 *
 * Diff table colours come from `react-diff-view`'s stylesheet, loaded only
 * with this lazy module.
 */
import { Trans } from '@lingui/react/macro';
import type * as React from 'react';
import { Diff, Hunk, parseDiff } from 'react-diff-view';
import 'react-diff-view/style/index.css';

interface ActivityPanelDiffViewProps {
  diff: string;
  viewType?: 'split' | 'unified';
}

/**
 * `diff.createPatch` (jsdiff) emits an `Index:` + `===` preamble that
 * `react-diff-view`'s parseDiff does NOT handle — it throws
 * "undefined is not an object (evaluating 'currentHunk.changes')". Strip
 * everything before the first `--- ` line so the parser sees a clean unified
 * diff.
 */
function stripIndexHeader(diff: string): string {
  const idx = diff.indexOf('\n--- ');
  if (idx >= 0) return diff.slice(idx + 1);
  // Already starts with `--- ` (or doesn't have the header): pass through.
  return diff;
}

export function ActivityPanelDiffView({
  diff,
  viewType = 'unified',
}: ActivityPanelDiffViewProps): React.JSX.Element {
  if (!diff.trim()) {
    return (
      <div className="activity-panel-diff px-3 py-2 text-xs text-muted-foreground italic">
        <Trans>No changes</Trans>
      </div>
    );
  }

  // parseDiff returns an array of files — for our single-file synthesis we
  // get exactly one. Tolerate malformed input by falling back to raw <pre>.
  let files: ReturnType<typeof parseDiff>;
  try {
    files = parseDiff(stripIndexHeader(diff));
  } catch {
    return (
      <pre className="activity-panel-diff font-mono text-xs whitespace-pre-wrap px-3 py-2">
        {diff}
      </pre>
    );
  }

  // Defense in depth: jsdiff can produce a non-empty patch header (Index/---/+++)
  // for byte-identical inputs that still parses to one file with zero hunks.
  // The Timeline hook short-circuits this case before it lands here, but the
  // server-synthesized burst path could in principle hit it too.
  if (files.every((f) => f.hunks.length === 0)) {
    return (
      <div className="activity-panel-diff px-3 py-2 text-xs text-muted-foreground italic">
        <Trans>No changes</Trans>
      </div>
    );
  }

  return (
    <div className="activity-panel-diff">
      {files.map((file) => (
        <Diff
          key={`${file.oldPath ?? 'a'}→${file.newPath ?? 'b'}`}
          viewType={viewType}
          diffType={file.type}
          hunks={file.hunks}
        >
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      ))}
    </div>
  );
}
