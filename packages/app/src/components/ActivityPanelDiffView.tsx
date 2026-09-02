import { Trans } from '@lingui/react/macro';
import type * as React from 'react';
import { Diff, Hunk, parseDiff } from 'react-diff-view';
import 'react-diff-view/style/index.css';

interface ActivityPanelDiffViewProps {
  diff: string;
  viewType?: 'split' | 'unified';
}

function stripIndexHeader(diff: string): string {
  const idx = diff.indexOf('\n--- ');
  if (idx >= 0) return diff.slice(idx + 1);
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
