/**
 * ActivityPanelFileRow unit tests — render via `renderToString` (same
 * pattern as jsx-component-prop-panel.test.tsx) and inspect the static HTML
 * shape. Interactive behavior (carrot toggle, undo dialog flow, onNavigate
 * firing) is exercised in Playwright E2E.
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { FileData } from '@/lib/use-activity-panel';
import { ActivityPanelFileRow } from './ActivityPanelFileRow';

// The header-row undo buttons are wrapped in Radix `Tooltip`, which requires
// a `TooltipProvider` ancestor. Production wires this at the app root
// (`main.tsx`); tests wrap here so `renderToString` does not throw
// "`Tooltip` must be used within `TooltipProvider`".
function render(ui: React.ReactElement): string {
  return renderToString(<TooltipProvider>{ui}</TooltipProvider>);
}

function sampleFile(overrides?: Partial<FileData>): FileData {
  return {
    docName: 'notes.md',
    additionsTotal: 10,
    deletionsTotal: 2,
    lastTs: Date.now() - 15_000,
    bursts: [
      { stackIndex: 1, ts: Date.now() - 15_000, additions: 4, deletions: 0 },
      { stackIndex: 0, ts: Date.now() - 45_000, additions: 6, deletions: 2 },
    ],
    ...overrides,
  };
}

const noopFetch = async (_d: string, _i: number): Promise<string> => '';
const noopAsync = async (_d: string): Promise<void> => {};

describe('ActivityPanelFileRow (static render)', () => {
  test('returns null when file has no bursts (D-P18 defensive guard)', () => {
    const html = render(
      <ActivityPanelFileRow
        file={sampleFile({ bursts: [] })}
        sessionAlive={true}
        isWriting={false}
        onNavigate={() => {}}
        onUndoLast={noopAsync}
        onUndoAll={noopAsync}
        fetchBurstDiff={noopFetch}
      />,
    );
    expect(html).toBe('');
  });

  test('collapsed state: shows filename, stat, relative timestamp', () => {
    const html = render(
      <ActivityPanelFileRow
        file={sampleFile()}
        sessionAlive={true}
        isWriting={false}
        onNavigate={() => {}}
        onUndoLast={noopAsync}
        onUndoAll={noopAsync}
        fetchBurstDiff={noopFetch}
      />,
    );
    expect(html).toContain('notes.md');
    // React's server renderer inserts `<!-- -->` comment markers between
    // adjacent text/expression nodes — strip them before asserting content.
    const stripped = html.replaceAll('<!-- -->', '');
    // Diff stats use unicode '−' minus for deletions (distinct from ASCII '-').
    expect(stripped).toContain('+10');
    expect(stripped).toContain('−2');
    // 15s ago ⇒ 's ago' pattern should appear.
    expect(html).toContain('s ago');
  });

  test('writing indicator renders only when isWriting=true', () => {
    const off = render(
      <ActivityPanelFileRow
        file={sampleFile()}
        sessionAlive={true}
        isWriting={false}
        onNavigate={() => {}}
        onUndoLast={noopAsync}
        onUndoAll={noopAsync}
        fetchBurstDiff={noopFetch}
      />,
    );
    expect(off).not.toContain('>writing<');

    const on = render(
      <ActivityPanelFileRow
        file={sampleFile()}
        sessionAlive={true}
        isWriting={true}
        onNavigate={() => {}}
        onUndoLast={noopAsync}
        onUndoAll={noopAsync}
        fetchBurstDiff={noopFetch}
      />,
    );
    expect(on).toContain('>writing<');
  });

  test('collapsed row renders both undo buttons in the header, confirm dialog not shown', () => {
    const html = render(
      <ActivityPanelFileRow
        file={sampleFile()}
        sessionAlive={true}
        isWriting={false}
        onNavigate={() => {}}
        onUndoLast={noopAsync}
        onUndoAll={noopAsync}
        fetchBurstDiff={noopFetch}
      />,
    );
    // Both undo buttons are now always in the header row (not gated on
    // expansion) — verified via data-testids that are stable across layout
    // shifts. aria-label carries the docName for screen-reader context.
    expect(html).toContain('data-testid="activity-panel-undo-last"');
    expect(html).toContain('data-testid="activity-panel-undo-all"');
    expect(html).toContain('aria-label="Undo last edit on notes.md"');
    expect(html).toContain('aria-label="Undo all edits on notes.md"');
    // Radix Dialog uses a Portal which emits nothing in SSR when `open=false`,
    // so the dialog title text never appears on the collapsed row.
    expect(html).not.toContain('Undo all edits on this file?');
  });

  test('undo buttons are disabled when sessionAlive=false', () => {
    const html = render(
      <ActivityPanelFileRow
        file={sampleFile()}
        sessionAlive={false}
        isWriting={false}
        onNavigate={() => {}}
        onUndoLast={noopAsync}
        onUndoAll={noopAsync}
        fetchBurstDiff={noopFetch}
      />,
    );
    // Both buttons carry the disabled attribute so click events won't fire
    // and screen readers announce the unavailable state.
    const undoLastIdx = html.indexOf('data-testid="activity-panel-undo-last"');
    const undoAllIdx = html.indexOf('data-testid="activity-panel-undo-all"');
    expect(undoLastIdx).toBeGreaterThan(-1);
    expect(undoAllIdx).toBeGreaterThan(-1);
    // Scan the surrounding button tag for `disabled` — React serializes the
    // attribute with no value (just the bare word).
    const windowBefore = 400;
    const undoLastSlice = html.slice(Math.max(0, undoLastIdx - windowBefore), undoLastIdx);
    const undoAllSlice = html.slice(Math.max(0, undoAllIdx - windowBefore), undoAllIdx);
    expect(undoLastSlice).toContain('disabled');
    expect(undoAllSlice).toContain('disabled');
  });

  test('collapsed row carrot uses right-pointing chevron (▸), not down (▾)', () => {
    const html = render(
      <ActivityPanelFileRow
        file={sampleFile()}
        sessionAlive={true}
        isWriting={false}
        onNavigate={() => {}}
        onUndoLast={noopAsync}
        onUndoAll={noopAsync}
        fetchBurstDiff={noopFetch}
      />,
    );
    // The collapsed carrot uses lucide-react's ChevronRight — verify
    // aria-expanded is false (the semantic signal consumers rely on).
    expect(html).toContain('aria-expanded="false"');
  });

  test('filename click target has correct aria-label and data-testid', () => {
    const html = render(
      <ActivityPanelFileRow
        file={sampleFile()}
        sessionAlive={true}
        isWriting={false}
        onNavigate={() => {}}
        onUndoLast={noopAsync}
        onUndoAll={noopAsync}
        fetchBurstDiff={noopFetch}
      />,
    );
    expect(html).toContain('aria-label="Navigate to notes.md"');
    expect(html).toContain('data-testid="activity-panel-file-row-filename"');
  });
});
