/**
 * DOM test for the problem-indicator processor. Mirrors the extension-badge
 * test's approach: build Pierre-shaped rows by hand and exercise
 * `applyProblemIndicators` directly against a counts snapshot. Covers the
 * decision layer — tint attribute + count on problem rows, nothing on clean
 * rows, healing removal, idempotence — while the real shadow-root color is
 * the e2e's job (jsdom doesn't paint unsafeCSS).
 */

import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  applyProblemIndicators,
  FILE_TREE_PROBLEM_CSS,
  OK_PROBLEM_BADGE_ATTR,
  OK_PROBLEM_ROW_ATTR,
} from './file-tree-problem-indicators';

afterEach(() => {
  cleanup();
});

function buildRow(path: string): HTMLElement {
  const row = document.createElement('div');
  row.setAttribute('data-type', 'item');
  row.setAttribute('data-item-path', path);
  const contentSection = document.createElement('div');
  contentSection.setAttribute('data-item-section', 'content');
  contentSection.textContent = path;
  row.appendChild(contentSection);
  const actionSection = document.createElement('div');
  actionSection.setAttribute('data-item-section', 'action');
  row.appendChild(actionSection);
  return row;
}

function buildTree(paths: string[]): { root: HTMLElement; rows: Map<string, HTMLElement> } {
  const root = document.createElement('div');
  const rows = new Map<string, HTMLElement>();
  for (const path of paths) {
    const row = buildRow(path);
    root.appendChild(row);
    rows.set(path, row);
  }
  return { root, rows };
}

describe('applyProblemIndicators', () => {
  test('tints error red-severity, warning yellow-severity, with total counts', () => {
    const { root, rows } = buildTree(['a.md', 'guides/b.md', 'clean.md']);
    applyProblemIndicators(
      root,
      new Map([
        ['a', { errorCount: 2, warningCount: 1 }],
        ['guides/b', { errorCount: 0, warningCount: 4 }],
      ]),
    );

    const errorRow = rows.get('a.md');
    expect(errorRow?.getAttribute(OK_PROBLEM_ROW_ATTR)).toBe('error');
    const errorBadge = errorRow?.querySelector(`[${OK_PROBLEM_BADGE_ATTR}]`);
    expect(errorBadge?.textContent).toBe('3');
    expect(errorBadge?.getAttribute('aria-label')).toBe(
      '2 errors and 1 warning in this file. Open the Problems panel for details.',
    );
    expect(errorBadge?.hasAttribute('aria-hidden')).toBe(false);

    const warningRow = rows.get('guides/b.md');
    expect(warningRow?.getAttribute(OK_PROBLEM_ROW_ATTR)).toBe('warning');
    const warningBadge = warningRow?.querySelector(`[${OK_PROBLEM_BADGE_ATTR}]`);
    expect(warningBadge?.textContent).toBe('4');
    expect(warningBadge?.getAttribute('aria-label')).toBe(
      '4 warnings in this file. Open the Problems panel for details.',
    );

    const cleanRow = rows.get('clean.md');
    expect(cleanRow?.hasAttribute(OK_PROBLEM_ROW_ATTR)).toBe(false);
    expect(cleanRow?.querySelector(`[${OK_PROBLEM_BADGE_ATTR}]`)).toBeNull();
  });

  test('healed rows lose tint and badge on the next apply', () => {
    const { root, rows } = buildTree(['a.md']);
    applyProblemIndicators(root, new Map([['a', { errorCount: 1, warningCount: 0 }]]));
    expect(rows.get('a.md')?.getAttribute(OK_PROBLEM_ROW_ATTR)).toBe('error');

    applyProblemIndicators(root, new Map());
    expect(rows.get('a.md')?.hasAttribute(OK_PROBLEM_ROW_ATTR)).toBe(false);
    expect(rows.get('a.md')?.querySelector(`[${OK_PROBLEM_BADGE_ATTR}]`)).toBeNull();
  });

  test('folder rows are never tinted even when a same-named doc has problems', () => {
    const { root, rows } = buildTree(['guides/']);
    applyProblemIndicators(root, new Map([['guides', { errorCount: 1, warningCount: 0 }]]));
    expect(rows.get('guides/')?.hasAttribute(OK_PROBLEM_ROW_ATTR)).toBe(false);
  });

  test('severity downgrades in place when errors heal but warnings remain', () => {
    const { root, rows } = buildTree(['a.md']);
    applyProblemIndicators(root, new Map([['a', { errorCount: 1, warningCount: 2 }]]));
    applyProblemIndicators(root, new Map([['a', { errorCount: 0, warningCount: 2 }]]));
    const row = rows.get('a.md');
    expect(row?.getAttribute(OK_PROBLEM_ROW_ATTR)).toBe('warning');
    expect(row?.querySelector(`[${OK_PROBLEM_BADGE_ATTR}]`)?.textContent).toBe('2');
  });

  test('repeated applies are idempotent (one badge, same attrs)', () => {
    const { root, rows } = buildTree(['a.md']);
    const counts = new Map([['a', { errorCount: 0, warningCount: 1 }]]);
    applyProblemIndicators(root, counts);
    applyProblemIndicators(root, counts);
    expect(rows.get('a.md')?.querySelectorAll(`[${OK_PROBLEM_BADGE_ATTR}]`)).toHaveLength(1);
  });

  test('counts above 99 clamp the badge label', () => {
    const { root, rows } = buildTree(['a.md']);
    applyProblemIndicators(root, new Map([['a', { errorCount: 100, warningCount: 50 }]]));
    expect(rows.get('a.md')?.querySelector(`[${OK_PROBLEM_BADGE_ATTR}]`)?.textContent).toBe('99+');
  });

  test('badge carries its own hover tooltip, not just an accessible name', () => {
    const { root, rows } = buildTree(['a.md']);
    applyProblemIndicators(root, new Map([['a', { errorCount: 0, warningCount: 1 }]]));
    const badge = rows.get('a.md')?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);
    expect(badge?.title).toBe('1 warning in this file. Open the Problems panel for details.');
    expect(badge?.getAttribute('aria-label')).toBe(badge?.title);
    // Without a name-from-author role the aria-label is dropped and a screen
    // reader announces the bare digit, which is the thing this fix is about.
    expect(badge?.getAttribute('role')).toBe('img');
  });

  test('the badge title outranks the full-path title FileTree stamps on the row', () => {
    const { root, rows } = buildTree(['guides/a.md']);
    const row = rows.get('guides/a.md');
    // FileTree stamps the row's own title imperatively; the badge is a
    // descendant, so only a title of its own resolves under the cursor.
    if (row) row.title = 'guides/a.md';
    applyProblemIndicators(root, new Map([['guides/a', { errorCount: 1, warningCount: 0 }]]));
    const badge = row?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);
    expect(badge?.title).toBe('1 error in this file. Open the Problems panel for details.');
    expect(badge?.title).not.toBe(row?.title);
  });

  test('badge stays a pointer hit target so its tooltip can surface', () => {
    // jsdom does not apply the shadow root's adopted stylesheet, so the
    // declaration is where this contract is observable here. The rendered
    // element is pinned at real-browser fidelity in tests/stress/unified-
    // problems.e2e.ts, which reads getComputedStyle on the live badge.
    //
    // Slice to the badge's own rule first: a row-tint selector may one day
    // want `pointer-events: none` for its own reasons, and that must not red
    // a test named for the badge.
    const withoutComments = FILE_TREE_PROBLEM_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const badgeRule = withoutComments.match(
      new RegExp(`\\[${OK_PROBLEM_BADGE_ATTR}\\]\\s*\\{([^}]*)\\}`),
    )?.[1];
    expect(badgeRule).toBeDefined();
    expect(badgeRule).not.toMatch(/pointer-events:\s*none/);
  });

  test('tooltip tracks the counts as they change', () => {
    const { root, rows } = buildTree(['a.md']);
    applyProblemIndicators(root, new Map([['a', { errorCount: 1, warningCount: 0 }]]));
    const badge = rows.get('a.md')?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);
    expect(badge?.title).toBe('1 error in this file. Open the Problems panel for details.');
    expect(badge?.getAttribute('aria-label')).toBe(badge?.title);

    // Both attributes are written behind separate value-gates, so the update
    // path has to assert both: breaking one guard leaves the other passing.
    applyProblemIndicators(root, new Map([['a', { errorCount: 3, warningCount: 2 }]]));
    expect(badge?.title).toBe(
      '3 errors and 2 warnings in this file. Open the Problems panel for details.',
    );
    expect(badge?.getAttribute('aria-label')).toBe(badge?.title);
  });
});
