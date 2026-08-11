/**
 * RTL mount tests for the appliesTo folder picker combobox: cmdk row selection
 * authors `folder/**` globs without closing the popover, search filters the
 * list, covered descendants read as disabled, and hand-authored patterns
 * survive round-trips untouched.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Radix/cmdk reach for DOM globals the jsdom preload doesn't expose; hoist the
// same shims the sibling settings DOM tests use.
type WindowGlobals = { MutationObserver?: typeof MutationObserver; NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.MutationObserver === undefined &&
  globalWithDomShims.window?.MutationObserver !== undefined
) {
  globalWithDomShims.MutationObserver = globalWithDomShims.window.MutationObserver;
}
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}
// jsdom does not implement scrollIntoView; cmdk calls it on highlight.
if (typeof HTMLElement.prototype.scrollIntoView !== 'function') {
  HTMLElement.prototype.scrollIntoView = () => {};
}

let mockPageList: { pages: Set<string>; folderPaths: Set<string> } | null = null;

vi.doMock('@/components/PageListContext', () => ({
  useOptionalPageList: () => mockPageList,
}));

const { AppliesToFolderPicker } = await import('./applies-to-folder-picker');

const FILE = '.ok/schemas/doc.schema.json';

function mountPicker(globs: string[], onChange = vi.fn()) {
  render(<AppliesToFolderPicker file={FILE} globs={globs} disabled={false} onChange={onChange} />);
  return onChange;
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId(`frontmatter-schema-pick-folders-${FILE}`));
}

function folderItem(path: string): HTMLElement {
  return screen.getByTestId(`frontmatter-schema-folder-item-${FILE}-${path}`);
}

beforeEach(() => {
  mockPageList = {
    pages: new Set(['blog/a', 'blog/nested/b', 'guides/c', 'root-doc']),
    folderPaths: new Set(['blog', 'blog/nested', 'guides']),
  };
});

afterEach(() => {
  cleanup();
});

describe('AppliesToFolderPicker', () => {
  test('renders nothing without a page-list provider', () => {
    mockPageList = null;
    mountPicker([]);
    expect(screen.queryByTestId(`frontmatter-schema-pick-folders-${FILE}`)).toBeNull();
  });

  test('the trigger summarizes the current selection', () => {
    mountPicker(['blog/**', 'guides/**']);
    expect(screen.getByTestId(`frontmatter-schema-pick-folders-${FILE}`).textContent).toContain(
      '2 folders picked',
    );
  });

  test('selecting a folder authors its recursive glob and keeps the popover open', async () => {
    const user = userEvent.setup();
    const onChange = mountPicker([]);
    await openPicker(user);
    await user.click(folderItem('blog'));
    expect(onChange).toHaveBeenCalledWith(['blog/**']);
    // Multi-select: the list is still mounted for the next toggle.
    expect(screen.getByTestId(`frontmatter-schema-folder-tree-${FILE}`)).toBeTruthy();
  });

  test('exposes a labeled multi-select listbox to assistive technology', async () => {
    const user = userEvent.setup();
    mountPicker([]);
    await openPicker(user);

    const listbox = screen.getByRole('listbox');
    expect(listbox.getAttribute('aria-multiselectable')).toBe('true');
    const labeledComboboxes = screen.getAllByRole('combobox', {
      name: 'Pick folders this schema applies to',
    });
    expect(labeledComboboxes.some((element) => element.tagName === 'INPUT')).toBe(true);
  });

  test('selecting a picked folder removes only its pattern, keeping hand-authored globs', async () => {
    const user = userEvent.setup();
    const onChange = mountPicker(['blog/**', '!blog/drafts/**', 'notes']);
    await openPicker(user);
    expect(folderItem('blog').getAttribute('aria-checked')).toBe('true');
    await user.click(folderItem('blog'));
    expect(onChange).toHaveBeenCalledWith(['!blog/drafts/**', 'notes']);
  });

  test('a descendant of a picked folder is covered: checked and disabled', async () => {
    const user = userEvent.setup();
    const onChange = mountPicker(['blog/**']);
    await openPicker(user);
    const nested = folderItem('blog/nested');
    expect(nested.getAttribute('aria-checked')).toBe('true');
    expect(nested.getAttribute('aria-disabled')).toBe('true');
    await user.click(nested);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('typing in the search filters the rows', async () => {
    const user = userEvent.setup();
    mountPicker([]);
    await openPicker(user);
    await user.keyboard('guides');
    expect(folderItem('guides')).toBeTruthy();
    expect(screen.queryByTestId(`frontmatter-schema-folder-item-${FILE}-blog`)).toBeNull();
  });

  test('folders whose paths cannot round-trip through a recursive glob stay out of the picker', async () => {
    const user = userEvent.setup();
    mockPageList = {
      pages: new Set(['archive (old)/entry', 'guides/current']),
      folderPaths: new Set(['archive (old)', 'guides']),
    };
    mountPicker([]);
    await openPicker(user);

    expect(folderItem('guides')).toBeTruthy();
    expect(screen.queryByTestId(`frontmatter-schema-folder-item-${FILE}-archive (old)`)).toBeNull();
  });

  test('a search with no hits shows the empty message', async () => {
    const user = userEvent.setup();
    mountPicker([]);
    await openPicker(user);
    await user.keyboard('zzz-no-such-folder');
    expect(screen.queryByTestId(`frontmatter-schema-folder-item-${FILE}-blog`)).toBeNull();
    expect(screen.getByText('No folders match.')).toBeTruthy();
  });

  test('disabled: the trigger does not open the list or author globs', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AppliesToFolderPicker file={FILE} globs={[]} disabled={true} onChange={onChange} />);
    const trigger = screen.getByTestId(`frontmatter-schema-pick-folders-${FILE}`);
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId(`frontmatter-schema-folder-tree-${FILE}`)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('rows show per-folder doc counts', async () => {
    const user = userEvent.setup();
    mountPicker([]);
    await openPicker(user);
    const tree = screen.getByTestId(`frontmatter-schema-folder-tree-${FILE}`);
    expect(tree.textContent).toContain('blog');
    expect(tree.textContent).toContain('2 docs');
    expect(tree.textContent).toContain('1 doc');
  });

  test('empty project reads as an empty state, not a bare popover', async () => {
    const user = userEvent.setup();
    mockPageList = { pages: new Set(), folderPaths: new Set() };
    mountPicker([]);
    await openPicker(user);
    expect(screen.getByTestId(`frontmatter-schema-folder-tree-empty-${FILE}`)).toBeTruthy();
  });
});
