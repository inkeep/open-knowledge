/**
 * ActivityPanelFileRow unit tests — render via `renderToString` and inspect the
 * static HTML shape. Interactive behavior (row click → diff, per-edit Restore
 * confirm, onNavigate firing) is exercised in Playwright E2E.
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { FileData } from '@/lib/use-activity-panel';
import { ActivityPanelFileRow } from './ActivityPanelFileRow';

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

const noopDrop = async (_d: string, _n: number): Promise<void> => {};

describe('ActivityPanelFileRow (static render)', () => {
  test('returns null when file has no bursts (defensive guard)', () => {
    const html = render(
      <ActivityPanelFileRow
        file={sampleFile({ bursts: [] })}
        sessionAlive={true}
        isWriting={false}
        onNavigate={() => {}}
        onUndoDrop={noopDrop}
        onSetVersion={() => {}}
      />,
    );
    expect(html).toBe('');
  });

  test('header shows filename, stat, relative timestamp', () => {
    const html = render(
      <ActivityPanelFileRow
        file={sampleFile()}
        sessionAlive={true}
        isWriting={false}
        onNavigate={() => {}}
        onUndoDrop={noopDrop}
        onSetVersion={() => {}}
      />,
    );
    expect(html).toContain('notes.md');
    const stripped = html.replaceAll('<!-- -->', '');
    expect(stripped).toContain('+10');
    expect(stripped).toContain('−2');
    expect(html).toContain('s ago');
  });

  test('renders every edit as an always-expanded clickable burst row — no slider, no carrot, no header undo icons', () => {
    const html = render(
      <ActivityPanelFileRow
        file={sampleFile()}
        sessionAlive={true}
        isWriting={false}
        onNavigate={() => {}}
        onUndoDrop={noopDrop}
        onSetVersion={() => {}}
      />,
    );
    // Both edits render up-front (no expand toggle gating them).
    const openMatches = html.match(/data-testid="activity-panel-burst-open"/g) ?? [];
    expect(openMatches).toHaveLength(2);
    // The old slider + header quick-undo affordances are gone.
    expect(html).not.toContain('data-testid="agent-undo-timeline"');
    expect(html).not.toContain('data-testid="activity-panel-file-row-carrot"');
    expect(html).not.toContain('data-testid="activity-panel-undo-last"');
    expect(html).not.toContain('data-testid="activity-panel-undo-all"');
  });

  test('each edit exposes a per-row Restore control', () => {
    const html = render(
      <ActivityPanelFileRow
        file={sampleFile()}
        sessionAlive={true}
        isWriting={false}
        onNavigate={() => {}}
        onUndoDrop={noopDrop}
        onSetVersion={() => {}}
      />,
    );
    const restoreMatches = html.match(/data-testid="activity-panel-burst-restore"/g) ?? [];
    expect(restoreMatches).toHaveLength(2);
  });

  test('Restore controls are disabled when the session has ended', () => {
    const html = render(
      <ActivityPanelFileRow
        file={sampleFile()}
        sessionAlive={false}
        isWriting={false}
        onNavigate={() => {}}
        onUndoDrop={noopDrop}
        onSetVersion={() => {}}
      />,
    );
    const idx = html.indexOf('data-testid="activity-panel-burst-restore"');
    expect(idx).toBeGreaterThan(-1);
    // React serializes a bare `disabled` on the button tag, near the testid.
    expect(html.slice(idx, idx + 300)).toContain('disabled');
  });

  test('writing indicator renders only when isWriting=true', () => {
    const off = render(
      <ActivityPanelFileRow
        file={sampleFile()}
        sessionAlive={true}
        isWriting={false}
        onNavigate={() => {}}
        onUndoDrop={noopDrop}
        onSetVersion={() => {}}
      />,
    );
    expect(off).not.toContain('>writing<');

    const on = render(
      <ActivityPanelFileRow
        file={sampleFile()}
        sessionAlive={true}
        isWriting={true}
        onNavigate={() => {}}
        onUndoDrop={noopDrop}
        onSetVersion={() => {}}
      />,
    );
    expect(on).toContain('>writing<');
  });

  test('filename click target has correct aria-label and data-testid', () => {
    const html = render(
      <ActivityPanelFileRow
        file={sampleFile()}
        sessionAlive={true}
        isWriting={false}
        onNavigate={() => {}}
        onUndoDrop={noopDrop}
        onSetVersion={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Navigate to notes.md"');
    expect(html).toContain('data-testid="activity-panel-file-row-filename"');
  });
});
