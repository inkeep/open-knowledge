import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup } from '@testing-library/react';
import {
  applyExtensionBadges,
  OK_EXT_BADGE_ATTR,
  OK_EXT_ROW_ATTR,
  OK_FULLNAME_ROW_ATTR,
} from './file-tree-extension-badge';


interface PierreRowInit {
  path: string;
  filename: string;
  includeDecoration?: boolean;
  includeAction?: boolean;
  centerSplit?: [string, string];
}

function buildPierreRow(init: PierreRowInit): HTMLElement {
  const row = document.createElement('div');
  row.setAttribute('data-type', 'item');
  row.setAttribute('data-item-path', init.path);

  const contentSection = document.createElement('div');
  contentSection.setAttribute('data-item-section', 'content');
  row.appendChild(contentSection);

  const truncateGroup = document.createElement('div');
  truncateGroup.setAttribute('data-truncate-group-container', 'middle');
  contentSection.appendChild(truncateGroup);

  let basenameText: string;
  let extensionText: string;
  if (init.centerSplit) {
    [basenameText, extensionText] = init.centerSplit;
  } else {
    const lastDot = init.filename.lastIndexOf('.');
    const splitIndex = lastDot >= 0 ? lastDot + 1 : init.filename.length;
    basenameText = init.filename.slice(0, splitIndex);
    extensionText = init.filename.slice(splitIndex);
  }

  truncateGroup.appendChild(buildTruncateSegment('1', basenameText, 'truncate'));
  truncateGroup.appendChild(buildTruncateSegment('1', extensionText, 'fruncate'));

  if (init.includeDecoration) {
    const decoration = document.createElement('div');
    decoration.setAttribute('data-item-section', 'decoration');
    decoration.appendChild(document.createElement('svg'));
    row.appendChild(decoration);
  }

  if (init.includeAction) {
    const action = document.createElement('div');
    action.setAttribute('data-item-section', 'action');
    row.appendChild(action);
  }

  return row;
}

function buildTruncateSegment(
  priority: '1' | '2',
  text: string,
  mode: 'truncate' | 'fruncate',
): HTMLElement {
  const segment = document.createElement('div');
  segment.setAttribute('data-truncate-segment-priority', priority);
  for (const variant of ['visible', 'overflow'] as const) {
    const contentDiv = document.createElement('div');
    contentDiv.setAttribute('data-truncate-content', variant);
    if (mode === 'truncate') {
      contentDiv.appendChild(document.createTextNode(text));
    } else {
      const span = document.createElement('span');
      span.textContent = text;
      contentDiv.appendChild(span);
    }
    segment.appendChild(contentDiv);
  }
  return segment;
}

function basenameTextOf(row: HTMLElement): string {
  const visible = row.querySelector<HTMLElement>(
    '[data-truncate-segment-priority]:first-of-type [data-truncate-content="visible"]',
  );
  return visible?.textContent ?? '';
}

function extensionTextOf(row: HTMLElement): string {
  const visible = row.querySelector<HTMLElement>(
    '[data-truncate-segment-priority]:last-of-type [data-truncate-content="visible"]',
  );
  return visible?.textContent ?? '';
}

function badgeOf(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>(`[${OK_EXT_BADGE_ATTR}]`);
}

describe('applyExtensionBadges — extension badge injection', () => {
  afterEach(() => {
    cleanup();
  });

  test('.md file: strips trailing dot from basename, injects NO badge', () => {
    const root = document.createElement('div');
    root.appendChild(
      buildPierreRow({ path: 'AGENTS.md', filename: 'AGENTS.md', includeAction: true }),
    );

    applyExtensionBadges(root);

    const row = root.firstElementChild as HTMLElement;
    expect(row.hasAttribute(OK_EXT_ROW_ATTR)).toBe(true);
    expect(basenameTextOf(row)).toBe('AGENTS');
    expect(badgeOf(row)).toBeNull();
  });

  test('.mdx file: strips trailing dot, injects "MDX" badge (uppercase, no leading dot)', () => {
    const root = document.createElement('div');
    root.appendChild(
      buildPierreRow({ path: 'notes/ideas.mdx', filename: 'ideas.mdx', includeAction: true }),
    );

    applyExtensionBadges(root);

    const row = root.firstElementChild as HTMLElement;
    expect(row.hasAttribute(OK_EXT_ROW_ATTR)).toBe(true);
    expect(basenameTextOf(row)).toBe('ideas');
    const badge = badgeOf(row);
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('MDX');
    expect(badge?.textContent).not.toMatch(/^\./);
  });

  test('multi-dot basename: strips only the trailing dot, preserves interior dots', () => {
    const root = document.createElement('div');
    root.appendChild(
      buildPierreRow({
        path: 'reports/report.2026.md',
        filename: 'report.2026.md',
        includeAction: true,
      }),
    );

    applyExtensionBadges(root);

    const row = root.firstElementChild as HTMLElement;
    expect(basenameTextOf(row)).toBe('report.2026');
    expect(badgeOf(row)).toBeNull();
  });

  test('.jpg file: injects "JPG" badge', () => {
    const root = document.createElement('div');
    root.appendChild(
      buildPierreRow({ path: 'images/cat.jpg', filename: 'cat.jpg', includeAction: true }),
    );

    applyExtensionBadges(root);

    const row = root.firstElementChild as HTMLElement;
    expect(badgeOf(row)?.textContent).toBe('JPG');
    expect(basenameTextOf(row)).toBe('cat');
  });

  test('.pdf file: injects "PDF" badge', () => {
    const root = document.createElement('div');
    root.appendChild(
      buildPierreRow({ path: 'sample.pdf', filename: 'sample.pdf', includeAction: true }),
    );

    applyExtensionBadges(root);

    const row = root.firstElementChild as HTMLElement;
    expect(badgeOf(row)?.textContent).toBe('PDF');
  });

  test('badge is inserted RIGHT BEFORE the action lane (decoration sits left of badge)', () => {
    const root = document.createElement('div');
    root.appendChild(
      buildPierreRow({
        path: 'symlink.mdx',
        filename: 'symlink.mdx',
        includeDecoration: true,
        includeAction: true,
      }),
    );

    applyExtensionBadges(root);

    const row = root.firstElementChild as HTMLElement;
    const decoration = row.querySelector<HTMLElement>('[data-item-section="decoration"]');
    const action = row.querySelector<HTMLElement>('[data-item-section="action"]');
    const badge = badgeOf(row);

    expect(decoration).not.toBeNull();
    expect(action).not.toBeNull();
    expect(badge).not.toBeNull();

    const order = Array.from(row.children);
    expect(order.indexOf(decoration as Element)).toBeLessThan(order.indexOf(badge as Element));
    expect(order.indexOf(badge as Element)).toBeLessThan(order.indexOf(action as Element));
  });

  test('folder row (path ends with `/`): no badge, basename untouched', () => {
    const root = document.createElement('div');
    root.appendChild(buildPierreRow({ path: 'notes/', filename: 'notes', includeAction: true }));

    applyExtensionBadges(root);

    const row = root.firstElementChild as HTMLElement;
    expect(row.hasAttribute(OK_EXT_ROW_ATTR)).toBe(false);
    expect(badgeOf(row)).toBeNull();
    expect(basenameTextOf(row)).toBe('notes');
  });

  test('extension-less file (e.g. LICENSE): no badge, no mutation', () => {
    const root = document.createElement('div');
    root.appendChild(buildPierreRow({ path: 'LICENSE', filename: 'LICENSE', includeAction: true }));

    applyExtensionBadges(root);

    const row = root.firstElementChild as HTMLElement;
    expect(row.hasAttribute(OK_EXT_ROW_ATTR)).toBe(false);
    expect(badgeOf(row)).toBeNull();
    expect(basenameTextOf(row)).toBe('LICENSE');
  });

  test('dotfiles remain readable when the sidebar shows all files', () => {
    for (const filename of ['.gitignore', '.DS_Store', '.okignore']) {
      const root = document.createElement('div');
      root.appendChild(buildPierreRow({ path: filename, filename, includeAction: true }));

      applyExtensionBadges(root);

      const row = root.firstElementChild as HTMLElement;
      expect(row.hasAttribute(OK_EXT_ROW_ATTR)).toBe(false);
      expect(badgeOf(row)).toBeNull();
      expect(basenameTextOf(row)).toBe('.');
      expect(`${basenameTextOf(row)}${extensionTextOf(row)}`).toBe(filename);
    }
  });

  test('idempotent: repeat call produces no further mutation', () => {
    const root = document.createElement('div');
    root.appendChild(
      buildPierreRow({ path: 'notes/ideas.mdx', filename: 'ideas.mdx', includeAction: true }),
    );

    applyExtensionBadges(root);
    const firstBadge = badgeOf(root.firstElementChild as HTMLElement);
    const firstBasenameText = basenameTextOf(root.firstElementChild as HTMLElement);

    applyExtensionBadges(root);
    const secondBadge = badgeOf(root.firstElementChild as HTMLElement);
    const secondBasenameText = basenameTextOf(root.firstElementChild as HTMLElement);

    expect(secondBadge).toBe(firstBadge);
    expect(secondBasenameText).toBe(firstBasenameText);
  });

  test('badge state self-heals when file is renamed from .mdx to .md', () => {
    const root = document.createElement('div');
    const row = buildPierreRow({
      path: 'notes/ideas.mdx',
      filename: 'ideas.mdx',
      includeAction: true,
    });
    root.appendChild(row);

    applyExtensionBadges(root);
    expect(badgeOf(row)?.textContent).toBe('MDX');

    row.setAttribute('data-item-path', 'notes/ideas.md');

    applyExtensionBadges(root);
    expect(badgeOf(row)).toBeNull();
  });

  test('badge respects DOM mutation contract: when no action lane, appended to row', () => {
    const root = document.createElement('div');
    root.appendChild(
      buildPierreRow({
        path: 'images/cat.png',
        filename: 'cat.png',
        includeAction: false,
      }),
    );

    applyExtensionBadges(root);

    const row = root.firstElementChild as HTMLElement;
    const badge = badgeOf(row);
    expect(badge).not.toBeNull();
    expect(row.lastElementChild).toBe(badge);
  });

  test('badge is aria-hidden (decorative — not announced as separate content)', () => {
    const root = document.createElement('div');
    root.appendChild(
      buildPierreRow({ path: 'sample.pdf', filename: 'sample.pdf', includeAction: true }),
    );

    applyExtensionBadges(root);

    const row = root.firstElementChild as HTMLElement;
    expect(badgeOf(row)?.getAttribute('aria-hidden')).toBe('true');
  });

  test('folder row: recomposes Pierre center-split into a single end-truncating full name', () => {
    const root = document.createElement('div');
    root.appendChild(
      buildPierreRow({
        path: 'projects/open-knowledge/',
        filename: 'open-knowledge',
        centerSplit: ['open-kn', 'owledge'],
        includeAction: true,
      }),
    );

    applyExtensionBadges(root);

    const row = root.firstElementChild as HTMLElement;
    expect(row.hasAttribute(OK_FULLNAME_ROW_ATTR)).toBe(true);
    expect(row.hasAttribute(OK_EXT_ROW_ATTR)).toBe(false);
    expect(badgeOf(row)).toBeNull();
    expect(basenameTextOf(row)).toBe('open-knowledge');
  });

  test('folder recompose is idempotent (repeat call leaves the same text node)', () => {
    const root = document.createElement('div');
    root.appendChild(
      buildPierreRow({
        path: 'projects/open-knowledge/',
        filename: 'open-knowledge',
        centerSplit: ['open-kn', 'owledge'],
        includeAction: true,
      }),
    );

    applyExtensionBadges(root);
    const first = basenameTextOf(root.firstElementChild as HTMLElement);
    applyExtensionBadges(root);
    const second = basenameTextOf(root.firstElementChild as HTMLElement);

    expect(first).toBe('open-knowledge');
    expect(second).toBe('open-knowledge');
  });

  test('flattened breadcrumb row (no middle truncate group) is left untouched', () => {
    const root = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-type', 'item');
    row.setAttribute('data-item-path', 'public/open-knowledge/docs/');
    const content = document.createElement('div');
    content.setAttribute('data-item-section', 'content');
    const flattened = document.createElement('div');
    flattened.setAttribute('data-item-flattened-subitems', '');
    for (const seg of ['public', 'open-knowledge', 'docs']) {
      const sub = document.createElement('span');
      sub.setAttribute('data-item-flattened-subitem', seg);
      sub.textContent = seg;
      flattened.appendChild(sub);
    }
    content.appendChild(flattened);
    row.appendChild(content);
    root.appendChild(row);

    applyExtensionBadges(root);

    expect(row.hasAttribute(OK_FULLNAME_ROW_ATTR)).toBe(false);
    expect(row.hasAttribute(OK_EXT_ROW_ATTR)).toBe(false);
    expect(badgeOf(row)).toBeNull();
  });
});
