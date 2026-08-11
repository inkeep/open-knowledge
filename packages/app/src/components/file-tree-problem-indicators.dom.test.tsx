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
    expect(errorBadge?.getAttribute('aria-label')).toBe('3 problems: 2 errors, 1 warning');
    expect(errorBadge?.hasAttribute('aria-hidden')).toBe(false);

    const warningRow = rows.get('guides/b.md');
    expect(warningRow?.getAttribute(OK_PROBLEM_ROW_ATTR)).toBe('warning');
    const warningBadge = warningRow?.querySelector(`[${OK_PROBLEM_BADGE_ATTR}]`);
    expect(warningBadge?.textContent).toBe('4');
    expect(warningBadge?.getAttribute('aria-label')).toBe('4 problems: 0 errors, 4 warnings');

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
});
