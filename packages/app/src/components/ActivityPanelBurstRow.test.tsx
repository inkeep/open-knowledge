/**
 * ActivityPanelBurstRow unit tests — static HTML shape via renderToString.
 * Click-to-open (row → full-pane AgentDiffPane) and the Restore confirm flow
 * are exercised in Playwright.
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ActivityPanelBurstRow } from './ActivityPanelBurstRow';

function render(ui: React.ReactElement): string {
  return renderToString(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('ActivityPanelBurstRow (static render)', () => {
  test('renders diff stats + relative timestamp; diff is not rendered inline', () => {
    const html = render(
      <ActivityPanelBurstRow
        burst={{ stackIndex: 3, ts: Date.now() - 15_000, additions: 7, deletions: 3 }}
        docName="notes.md"
        editCount={5}
        sessionAlive={true}
        inFlight={false}
        onOpenDiff={() => {}}
        onRestore={() => {}}
      />,
    );
    const stripped = html.replaceAll('<!-- -->', '');
    expect(stripped).toContain('+7');
    expect(stripped).toContain('−3');
    expect(html).toContain('s ago');
    // The diff opens in the main pane, not inline in this narrow panel.
    expect(html).not.toContain('Loading diff');
    expect(html).not.toContain('activity-panel-diff');
  });

  test('absolute HH:MM format shows for bursts older than one hour', () => {
    const html = render(
      <ActivityPanelBurstRow
        burst={{
          stackIndex: 0,
          ts: Date.now() - 3 * 60 * 60 * 1_000,
          additions: 1,
          deletions: 0,
        }}
        docName="x.md"
        editCount={3}
        sessionAlive={true}
        inFlight={false}
        onOpenDiff={() => {}}
        onRestore={() => {}}
      />,
    );
    // 3h ago → relative "m ago" / "h ago" logic. We accept either the hour
    // formatting or colon-separated absolute time.
    expect(html.includes('h ago') || /\d\d:\d\d/.test(html)).toBe(true);
  });

  test('row exposes aria-pressed for the active-diff highlight', () => {
    const html = render(
      <ActivityPanelBurstRow
        burst={{ stackIndex: 1, ts: Date.now(), additions: 0, deletions: 0 }}
        docName="y.md"
        editCount={3}
        sessionAlive={true}
        inFlight={false}
        onOpenDiff={() => {}}
        onRestore={() => {}}
      />,
    );
    // No diff open in the store during SSR → not pressed.
    expect(html).toContain('aria-pressed="false"');
  });

  test('exposes a per-row Restore control, enabled when newer edits exist and the session is alive', () => {
    // burstNumber = stackIndex + 1 = 2; editCount 5 → 3 newer edits to undo.
    const html = render(
      <ActivityPanelBurstRow
        burst={{ stackIndex: 1, ts: Date.now(), additions: 2, deletions: 0 }}
        docName="notes.md"
        editCount={5}
        sessionAlive={true}
        inFlight={false}
        onOpenDiff={() => {}}
        onRestore={() => {}}
      />,
    );
    const idx = html.indexOf('data-testid="activity-panel-burst-restore"');
    expect(idx).toBeGreaterThan(-1);
    expect(html).toContain('aria-label="Restore to edit 2 of notes.md"');
    expect(html.slice(idx, idx + 300)).not.toContain('disabled');
  });

  test('Restore is disabled on the newest burst (nothing newer to undo)', () => {
    // stackIndex 4 → burstNumber 5 === editCount 5 → 0 newer edits.
    const html = render(
      <ActivityPanelBurstRow
        burst={{ stackIndex: 4, ts: Date.now(), additions: 1, deletions: 0 }}
        docName="notes.md"
        editCount={5}
        sessionAlive={true}
        inFlight={false}
        onOpenDiff={() => {}}
        onRestore={() => {}}
      />,
    );
    const idx = html.indexOf('data-testid="activity-panel-burst-restore"');
    expect(idx).toBeGreaterThan(-1);
    expect(html.slice(idx, idx + 300)).toContain('disabled');
  });

  test('Restore is disabled when the session has ended', () => {
    const html = render(
      <ActivityPanelBurstRow
        burst={{ stackIndex: 0, ts: Date.now(), additions: 1, deletions: 0 }}
        docName="notes.md"
        editCount={5}
        sessionAlive={false}
        inFlight={false}
        onOpenDiff={() => {}}
        onRestore={() => {}}
      />,
    );
    const idx = html.indexOf('data-testid="activity-panel-burst-restore"');
    expect(idx).toBeGreaterThan(-1);
    expect(html.slice(idx, idx + 300)).toContain('disabled');
  });
});
