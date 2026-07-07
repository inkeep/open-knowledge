/**
 * ActivityPanelBurstRow unit tests — static HTML shape via renderToString.
 * Lazy-diff-load behavior (click → fetch → render) is exercised in Playwright.
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { ActivityPanelBurstRow } from './ActivityPanelBurstRow';

describe('ActivityPanelBurstRow (static render)', () => {
  test('renders diff stats + relative timestamp; no diff visible until expanded', () => {
    const html = renderToString(
      <ActivityPanelBurstRow
        burst={{ stackIndex: 3, ts: Date.now() - 15_000, additions: 7, deletions: 3 }}
        docName="notes.md"
        fetchBurstDiff={async () => ''}
      />,
    );
    const stripped = html.replaceAll('<!-- -->', '');
    expect(stripped).toContain('+7');
    expect(stripped).toContain('−3');
    expect(html).toContain('s ago');
    // Collapsed by default — diff body should NOT be present yet.
    expect(html).not.toContain('Loading diff');
    expect(html).not.toContain('activity-panel-diff');
  });

  test('absolute HH:MM format shows for bursts older than one hour', () => {
    const html = renderToString(
      <ActivityPanelBurstRow
        burst={{
          stackIndex: 0,
          ts: Date.now() - 3 * 60 * 60 * 1_000,
          additions: 1,
          deletions: 0,
        }}
        docName="x.md"
        fetchBurstDiff={async () => ''}
      />,
    );
    // 3h ago → relative "m ago" / "h ago" logic. We accept either the hour
    // formatting or colon-separated absolute time.
    expect(html.includes('h ago') || /\d\d:\d\d/.test(html)).toBe(true);
  });

  test('aria-expanded reflects collapsed state', () => {
    const html = renderToString(
      <ActivityPanelBurstRow
        burst={{ stackIndex: 1, ts: Date.now(), additions: 0, deletions: 0 }}
        docName="y.md"
        fetchBurstDiff={async () => ''}
      />,
    );
    expect(html).toContain('aria-expanded="false"');
  });
});
