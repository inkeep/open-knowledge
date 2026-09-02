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
      '3 problems. 2 errors and 1 warning in this file. Open the Problems panel for details.',
    );
    expect(errorBadge?.hasAttribute('aria-hidden')).toBe(false);

    const warningRow = rows.get('guides/b.md');
    expect(warningRow?.getAttribute(OK_PROBLEM_ROW_ATTR)).toBe('warning');
    const warningBadge = warningRow?.querySelector(`[${OK_PROBLEM_BADGE_ATTR}]`);
    expect(warningBadge?.textContent).toBe('4');
    expect(warningBadge?.getAttribute('aria-label')).toBe(
      '4 problems. 4 warnings in this file. Open the Problems panel for details.',
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

  test('a recycled row rebinds its existing badge to the current file', () => {
    const { root, rows } = buildTree(['a.md']);
    const row = rows.get('a.md');
    const activated: string[] = [];
    const onActivate = (treePath: string) => activated.push(treePath);
    applyProblemIndicators(root, new Map([['a', { errorCount: 1, warningCount: 0 }]]), onActivate);
    const badge = row?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);

    if (row) row.dataset.itemPath = 'b.md';
    applyProblemIndicators(root, new Map([['b', { errorCount: 0, warningCount: 2 }]]), onActivate);

    const reboundBadge = row?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);
    expect(reboundBadge).toBe(badge);
    expect(reboundBadge?.textContent).toBe('2');
    expect(reboundBadge?.getAttribute('aria-label')).toBe(
      '2 problems. 2 warnings in this file. Open the Problems panel for details.',
    );
    reboundBadge?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(activated).toEqual(['b.md']);
  });

  test('counts above 99 clamp the badge label', () => {
    const { root, rows } = buildTree(['a.md']);
    applyProblemIndicators(root, new Map([['a', { errorCount: 100, warningCount: 50 }]]));
    const badge = rows.get('a.md')?.querySelector(`[${OK_PROBLEM_BADGE_ATTR}]`);
    expect(badge?.textContent).toBe('99+');
    expect(badge?.getAttribute('aria-label')).toBe(
      '99+ problems. 100 errors and 50 warnings in this file. Open the Problems panel for details.',
    );
  });

  test('badge carries its own hover tooltip and leads its accessible name with the visible count', () => {
    const { root, rows } = buildTree(['a.md']);
    applyProblemIndicators(root, new Map([['a', { errorCount: 0, warningCount: 1 }]]));
    const badge = rows.get('a.md')?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);
    expect(badge?.title).toBe('1 warning in this file. Open the Problems panel for details.');
    expect(badge?.getAttribute('aria-label')).toBe(
      '1 problem. 1 warning in this file. Open the Problems panel for details.',
    );
    expect(badge?.getAttribute('role')).toBe('img');
  });

  test('the badge title outranks the full-path title FileTree stamps on the row', () => {
    const { root, rows } = buildTree(['guides/a.md']);
    const row = rows.get('guides/a.md');
    if (row) row.title = 'guides/a.md';
    applyProblemIndicators(root, new Map([['guides/a', { errorCount: 1, warningCount: 0 }]]));
    const badge = row?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);
    expect(badge?.title).toBe('1 error in this file. Open the Problems panel for details.');
    expect(badge?.title).not.toBe(row?.title);
  });

  test('badge stays a pointer hit target so its tooltip can surface', () => {
    const withoutComments = FILE_TREE_PROBLEM_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const badgeRule = withoutComments.match(
      new RegExp(`\\[${OK_PROBLEM_BADGE_ATTR}\\]\\s*\\{([^}]*)\\}`),
    )?.[1];
    expect(badgeRule).toBeDefined();
    expect(badgeRule).not.toMatch(/pointer-events:\s*none/);
  });

  test('clicking the badge activates its own doc without selecting the row', () => {
    const { root, rows } = buildTree(['guides/a.md']);
    const activated: string[] = [];
    const rowClicks: number[] = [];
    rows.get('guides/a.md')?.addEventListener('click', () => rowClicks.push(1));

    applyProblemIndicators(
      root,
      new Map([['guides/a', { errorCount: 1, warningCount: 0 }]]),
      (treePath) => activated.push(treePath),
    );
    rows
      .get('guides/a.md')
      ?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(activated).toEqual(['guides/a.md']);
    expect(rowClicks).toHaveLength(0);
  });

  test('the badge activates on Enter and on Space, and Space does not scroll the tree', () => {
    const { root, rows } = buildTree(['guides/a.md']);
    const activated: string[] = [];
    applyProblemIndicators(
      root,
      new Map([['guides/a', { errorCount: 1, warningCount: 0 }]]),
      (treePath) => activated.push(treePath),
    );
    const badge = rows.get('guides/a.md')?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    badge?.dispatchEvent(enter);
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    badge?.dispatchEvent(space);

    expect(activated).toEqual(['guides/a.md', 'guides/a.md']);
    expect(space.defaultPrevented).toBe(true);
  });

  test('keys the tree navigates with are left to the tree', () => {
    const { root, rows } = buildTree(['a.md']);
    const activated: string[] = [];
    const reachedRow: string[] = [];
    rows
      .get('a.md')
      ?.addEventListener('keydown', (event) => reachedRow.push((event as KeyboardEvent).key));

    applyProblemIndicators(root, new Map([['a', { errorCount: 1, warningCount: 0 }]]), (treePath) =>
      activated.push(treePath),
    );
    rows
      .get('a.md')
      ?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`)
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    expect(activated).toHaveLength(0);
    expect(reachedRow).toEqual(['ArrowDown']);
  });

  test('an activatable badge announces exactly what the inert one announced', () => {
    const counts = new Map([['a', { errorCount: 2, warningCount: 1 }]]);
    const inert = buildTree(['a.md']);
    applyProblemIndicators(inert.root, counts);
    const inertBadge = inert.rows
      .get('a.md')
      ?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);

    const operable = buildTree(['a.md']);
    applyProblemIndicators(operable.root, counts, () => {});
    const operableBadge = operable.rows
      .get('a.md')
      ?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);

    expect(operableBadge?.getAttribute('role')).toBe('button');
    expect(operableBadge?.getAttribute('tabindex')).toBe('0');
    expect(operableBadge?.getAttribute('aria-label')).toBe(inertBadge?.getAttribute('aria-label'));
    expect(operableBadge?.title).toBe(inertBadge?.title);
  });

  test('a focused badge gets a ring instead of the outline reset it inherits', () => {
    const withoutComments = FILE_TREE_PROBLEM_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const focusRule = withoutComments.match(
      new RegExp(`\\[${OK_PROBLEM_BADGE_ATTR}\\]:focus-visible\\s*\\{([^}]*)\\}`),
    )?.[1];
    expect(focusRule).toBeDefined();
    expect(focusRule).toMatch(/outline:/);
    expect(focusRule).not.toMatch(/outline:\s*none/);
  });

  test('hover is pointer-gated and activation has its own pressed state', () => {
    const withoutComments = FILE_TREE_PROBLEM_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).toMatch(
      new RegExp(
        `@media\\s*\\(hover:\\s*hover\\)[\\s\\S]*\\[${OK_PROBLEM_BADGE_ATTR}\\]\\[role='button'\\]:hover`,
      ),
    );
    expect(withoutComments).toMatch(
      new RegExp(`\\[${OK_PROBLEM_BADGE_ATTR}\\]\\[role='button'\\]:active\\s*\\{`),
    );
  });

  test('the badge keeps a shape under forced colors, and severity stays readable', () => {
    const withoutComments = FILE_TREE_PROBLEM_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const forcedColorsBlock = withoutComments.match(
      /@media\s*\(forced-colors:\s*active\)\s*\{([\s\S]*)\}/,
    )?.[1];
    expect(forcedColorsBlock).toBeDefined();
    expect(forcedColorsBlock).toMatch(
      new RegExp(`\\[${OK_PROBLEM_BADGE_ATTR}\\]\\s*\\{[^}]*border:[^}]*CanvasText`),
    );
    expect(forcedColorsBlock).toMatch(
      new RegExp(`${OK_PROBLEM_ROW_ATTR}='error'[^{]*\\{[^}]*border-width:`),
    );
  });

  test('re-applying the pass does not stack activations on the badge', () => {
    const { root, rows } = buildTree(['a.md']);
    const counts = new Map([['a', { errorCount: 1, warningCount: 0 }]]);
    const activated: string[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      applyProblemIndicators(root, counts, (treePath) => activated.push(treePath));
    }
    rows
      .get('a.md')
      ?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(activated).toEqual(['a.md']);
  });

  test('a later pass replaces the handler an earlier pass installed', () => {
    const { root, rows } = buildTree(['a.md']);
    const counts = new Map([['a', { errorCount: 1, warningCount: 0 }]]);
    const stale: string[] = [];
    const fresh: string[] = [];
    applyProblemIndicators(root, counts, (treePath) => stale.push(treePath));
    applyProblemIndicators(root, counts, (treePath) => fresh.push(treePath));
    rows
      .get('a.md')
      ?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(stale).toHaveLength(0);
    expect(fresh).toEqual(['a.md']);
  });

  test("a modified click stays the tree's multi-select gesture", () => {
    const { root, rows } = buildTree(['a.md']);
    const activated: string[] = [];
    const reachedRow: string[] = [];
    const row = rows.get('a.md');
    row?.addEventListener('click', () => reachedRow.push('click'));
    applyProblemIndicators(root, new Map([['a', { errorCount: 1, warningCount: 0 }]]), (treePath) =>
      activated.push(treePath),
    );
    const badge = row?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);

    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      badge?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true }),
      );
    }

    expect(activated).toHaveLength(0);
    expect(reachedRow).toHaveLength(4);
  });

  test("the host's ctrl/meta+Space selection chord reaches the row", () => {
    const { root, rows } = buildTree(['a.md']);
    const activated: string[] = [];
    const reachedRow: string[] = [];
    const row = rows.get('a.md');
    row?.addEventListener('keydown', () => reachedRow.push('keydown'));
    applyProblemIndicators(root, new Map([['a', { errorCount: 1, warningCount: 0 }]]), (treePath) =>
      activated.push(treePath),
    );
    const badge = row?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);

    const chord = new KeyboardEvent('keydown', {
      key: ' ',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    badge?.dispatchEvent(chord);

    expect(activated).toHaveLength(0);
    expect(reachedRow).toEqual(['keydown']);
    expect(chord.defaultPrevented).toBe(false);
  });

  test('holding the key down activates once, the way a real button does', () => {
    const { root, rows } = buildTree(['a.md']);
    const activated: Array<{ treePath: string; source: 'pointer' | 'keyboard' }> = [];
    applyProblemIndicators(
      root,
      new Map([['a', { errorCount: 1, warningCount: 0 }]]),
      (treePath, source) => activated.push({ treePath, source }),
    );
    const badge = rows.get('a.md')?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);

    badge?.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    for (let tick = 0; tick < 3; tick += 1) {
      badge?.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', repeat: true, bubbles: true, cancelable: true }),
      );
    }

    expect(activated).toEqual([{ treePath: 'a.md', source: 'keyboard' }]);
  });

  test('the operable badge claims a hit area the painted chip is too small for', () => {
    const withoutComments = FILE_TREE_PROBLEM_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const hitArea = withoutComments.match(
      new RegExp(`\\[${OK_PROBLEM_BADGE_ATTR}\\]\\[role='button'\\]::after\\s*\\{([^}]*)\\}`),
    )?.[1];
    expect(hitArea).toBeDefined();
    expect(hitArea).toMatch(/position:\s*absolute/);
    expect(hitArea).toMatch(/inset:\s*-\d/);
    expect(
      withoutComments.match(
        new RegExp(`\\[${OK_PROBLEM_BADGE_ATTR}\\]\\[role='button'\\]\\s*\\{([^}]*)\\}`),
      )?.[1],
    ).toMatch(/position:\s*relative/);
  });

  test('dropping the activation handler retires the control instead of leaving it dead', () => {
    const { root, rows } = buildTree(['a.md']);
    const counts = new Map([['a', { errorCount: 1, warningCount: 0 }]]);
    const activated: string[] = [];
    applyProblemIndicators(root, counts, (treePath) => activated.push(treePath));
    applyProblemIndicators(root, counts);

    const badge = rows.get('a.md')?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);
    expect(badge?.getAttribute('role')).toBe('img');
    expect(badge?.hasAttribute('tabindex')).toBe(false);
    badge?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(activated).toHaveLength(0);
  });

  test('a healed row keeps nothing that could still fire', () => {
    const { root, rows } = buildTree(['a.md']);
    const activated: string[] = [];
    const onActivate = (treePath: string) => activated.push(treePath);
    applyProblemIndicators(root, new Map([['a', { errorCount: 1, warningCount: 0 }]]), onActivate);
    applyProblemIndicators(root, new Map(), onActivate);

    const row = rows.get('a.md');
    expect(row?.querySelector(`[${OK_PROBLEM_BADGE_ATTR}]`)).toBeNull();
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(activated).toHaveLength(0);
  });

  test('a badge that heals while focused hands focus back to its row', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const row = document.createElement('button');
    row.setAttribute('data-type', 'item');
    row.setAttribute('data-item-path', 'a.md');
    const action = document.createElement('span');
    action.setAttribute('data-item-section', 'action');
    row.appendChild(action);
    shadow.appendChild(row);

    applyProblemIndicators(shadow, new Map([['a', { errorCount: 1, warningCount: 0 }]]), () => {});
    const badge = row.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);
    badge?.focus();
    expect(shadow.activeElement).toBe(badge);

    applyProblemIndicators(shadow, new Map(), () => {});

    expect(row.querySelector(`[${OK_PROBLEM_BADGE_ATTR}]`)).toBeNull();
    expect(shadow.activeElement).toBe(row);
    host.remove();
  });

  test('tooltip tracks the counts as they change', () => {
    const { root, rows } = buildTree(['a.md']);
    applyProblemIndicators(root, new Map([['a', { errorCount: 1, warningCount: 0 }]]));
    const badge = rows.get('a.md')?.querySelector<HTMLElement>(`[${OK_PROBLEM_BADGE_ATTR}]`);
    expect(badge?.title).toBe('1 error in this file. Open the Problems panel for details.');
    expect(badge?.getAttribute('aria-label')).toBe(
      '1 problem. 1 error in this file. Open the Problems panel for details.',
    );

    applyProblemIndicators(root, new Map([['a', { errorCount: 3, warningCount: 2 }]]));
    expect(badge?.title).toBe(
      '3 errors and 2 warnings in this file. Open the Problems panel for details.',
    );
    expect(badge?.getAttribute('aria-label')).toBe(
      '5 problems. 3 errors and 2 warnings in this file. Open the Problems panel for details.',
    );
  });
});
