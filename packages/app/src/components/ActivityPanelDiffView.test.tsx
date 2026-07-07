/**
 * ActivityPanelDiffView unit tests — verify the rendering branch logic by
 * walking the returned React element tree. Follows the existing repo pattern
 * in `GraphLegend.test.tsx` (no DOM rendering deps).
 *
 * What we verify:
 *   - Empty / whitespace-only diff input → "No changes" placeholder branch.
 *   - Valid unified-diff input → react-diff-view's Diff component is rendered.
 *   - Unparseable input doesn't crash (fallback to <pre> or placeholder).
 */
import { describe, expect, test } from 'bun:test';
import { createPatch } from 'diff';
import type { ReactElement, ReactNode } from 'react';
import { ActivityPanelDiffView } from './ActivityPanelDiffView';

type ElementWithProps = ReactElement<{
  className?: string;
  children?: ReactNode;
  diff?: unknown;
  hunks?: unknown;
}>;

function childrenArray(node: ReactNode): ReactNode[] {
  if (Array.isArray(node)) return node;
  return [node];
}

function collectText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(collectText).join('');
  const el = node as ElementWithProps;
  return collectText(el.props.children ?? null);
}

/** Walks the element tree and returns the first element whose props.className matches. */
function findByClassName(node: ReactNode, className: string): ReactElement | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByClassName(child, className);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ElementWithProps;
  if (el.props?.className === className) return el;
  const children = childrenArray(el.props?.children ?? null);
  for (const child of children) {
    const hit = findByClassName(child, className);
    if (hit) return hit;
  }
  return null;
}

describe('ActivityPanelDiffView', () => {
  test('renders "No changes" placeholder for empty input', () => {
    const el = ActivityPanelDiffView({ diff: '' });
    expect(collectText(el)).toContain('No changes');
  });

  test('renders "No changes" placeholder for whitespace-only input', () => {
    const el = ActivityPanelDiffView({ diff: '   \n  \n' });
    expect(collectText(el)).toContain('No changes');
  });

  test('renders a diff container (not the placeholder) for a valid unified-diff with added line', () => {
    const diff = createPatch('notes.md', 'hello\n', 'hello\nworld\n', undefined, undefined, {
      context: 3,
    });
    const el = ActivityPanelDiffView({ diff });
    // The valid-diff branch mounts a div.activity-panel-diff wrapping the
    // react-diff-view Diff component. The placeholder branch has its own div
    // with px-3 py-2 italic copy containing "No changes". Verify the wrapper
    // is present AND we're NOT in the placeholder path.
    expect(findByClassName(el, 'activity-panel-diff')).not.toBeNull();
    expect(collectText(el)).not.toContain('No changes');
  });

  test('renders a diff container for a valid unified-diff with deleted line', () => {
    const diff = createPatch('notes.md', 'keep\ngone\n', 'keep\n', undefined, undefined, {
      context: 3,
    });
    const el = ActivityPanelDiffView({ diff });
    expect(findByClassName(el, 'activity-panel-diff')).not.toBeNull();
    expect(collectText(el)).not.toContain('No changes');
  });

  test('unparseable input does not crash', () => {
    // parseDiff on "garbage" returns [] (or throws, depending on input) —
    // we either render the placeholder or the raw <pre> fallback. In all
    // cases the call must not throw.
    expect(() => ActivityPanelDiffView({ diff: 'not-a-diff' })).not.toThrow();
  });
});
