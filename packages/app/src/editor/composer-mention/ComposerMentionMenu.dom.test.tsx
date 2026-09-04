import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ComposerMentionMenu } from './ComposerMentionMenu';
import type { MentionItem } from './composer-mention';

afterEach(cleanup);

const PAGE: MentionItem = {
  docName: 'specs/2026-06-22-some-very-long-feature-name/SPEC',
  title: 'SPEC',
  path: 'specs/2026-06-22-some-very-long-feature-name/SPEC.md',
};
const FOLDER: MentionItem = {
  docName: 'specs/2026-06-22-some-very-long-feature-name',
  title: 'some-very-long-feature-name',
  path: 'specs/2026-06-22-some-very-long-feature-name',
};
const ASSET: MentionItem = {
  docName: '/docs/public/diagram.png',
  title: 'diagram.png',
  path: 'docs/public/diagram.png',
};

function renderMenu(items: MentionItem[], selectedIndex = 0) {
  return render(
    <ComposerMentionMenu
      items={items}
      query="spec"
      selectedIndex={selectedIndex}
      onSelect={() => {}}
    />,
  );
}

function optionFor(item: MentionItem): HTMLElement {
  return screen.getByTestId(`composer-mention-option-${item.docName}`);
}

describe('ComposerMentionMenu — link visibility', () => {
  test('renders the full serialized path verbatim (no truncation of the tail)', () => {
    renderMenu([PAGE]);
    expect(optionFor(PAGE).textContent).toContain(PAGE.path);
  });

  test('the path span wraps (break-all + line-clamp) rather than single-line truncate', () => {
    renderMenu([PAGE]);
    const pathSpan = optionFor(PAGE).querySelector('.break-all');
    expect(pathSpan).not.toBeNull();
    expect(pathSpan?.className).toContain('line-clamp-2');
    expect(pathSpan?.className).not.toContain('truncate');
  });
});

describe('ComposerMentionMenu — folder differentiation', () => {
  test('a folder row carries a trailing slash, a Folder label, and a folder kind marker', () => {
    renderMenu([FOLDER]);
    const row = optionFor(FOLDER);
    expect(row.dataset.mentionKind).toBe('folder');
    expect(row.textContent).toContain(`${FOLDER.path}/`);
    expect(within(row).getByText('Folder')).toBeDefined();
  });

  test('a page row is not marked as a folder and gets no trailing slash or label', () => {
    renderMenu([PAGE]);
    const row = optionFor(PAGE);
    expect(row.dataset.mentionKind).toBe('page');
    expect(row.textContent).not.toContain(`${PAGE.path}/`);
    expect(within(row).queryByText('Folder')).toBeNull();
  });

  test('an asset row is classified as an asset, not a folder', () => {
    renderMenu([ASSET]);
    const row = optionFor(ASSET);
    expect(row.dataset.mentionKind).toBe('asset');
    expect(within(row).queryByText('Folder')).toBeNull();
  });
});

describe('ComposerMentionMenu — existing behavior preserved', () => {
  test('the selected row is marked active and aria-selected', () => {
    renderMenu([PAGE, FOLDER], 1);
    expect(optionFor(PAGE).getAttribute('aria-selected')).toBe('false');
    const folderRow = optionFor(FOLDER);
    expect(folderRow.getAttribute('aria-selected')).toBe('true');
    expect(folderRow.dataset.active).toBe('true');
  });

  test('each row still renders an icon glyph', () => {
    renderMenu([PAGE, FOLDER, ASSET]);
    for (const item of [PAGE, FOLDER, ASSET]) {
      expect(optionFor(item).querySelector('svg')).not.toBeNull();
    }
  });

  test('the empty state shows the no-matches copy', () => {
    render(<ComposerMentionMenu items={[]} query="zzz" selectedIndex={0} onSelect={() => {}} />);
    expect(screen.getByText('No matching docs')).toBeDefined();
  });
});

describe('ComposerMentionMenu — listbox accessibility', () => {
  test('the listbox carries an accessible name', () => {
    renderMenu([PAGE, FOLDER]);
    const listbox = screen.getByRole('listbox');
    expect(listbox.getAttribute('aria-label')).toBe('Doc mention suggestions');
  });

  test('each option carries a stable, listbox-scoped id', () => {
    renderMenu([PAGE, FOLDER, ASSET]);
    const listbox = screen.getByRole('listbox');
    const listboxId = listbox.id;
    expect(listboxId).not.toBe('');
    const options = screen.getAllByRole('option');
    options.forEach((opt, idx) => {
      expect(opt.id).toBe(`${listboxId}-option-${idx}`);
    });
  });

  test('the sr-only live region announces the SELECTED item and tracks selectedIndex', () => {
    const { container } = renderMenu([PAGE, FOLDER, ASSET], 1);
    const live = container.querySelector('[aria-live="polite"][aria-atomic="true"]');
    expect(live).not.toBeNull();
    expect(live?.className).toContain('sr-only');
    expect(live?.textContent).toBe(FOLDER.title);

    cleanup();

    const { container: container2 } = renderMenu([PAGE, FOLDER, ASSET], 2);
    const live2 = container2.querySelector('[aria-live="polite"][aria-atomic="true"]');
    expect(live2?.textContent).toBe(ASSET.title);
  });
});

describe('ComposerMentionMenu — fetch error state', () => {
  test('renders a distinct aria-live retry hint instead of the empty state', () => {
    render(<ComposerMentionMenu items={[]} query="" selectedIndex={0} onSelect={() => {}} error />);
    const hint = screen.getByText("Couldn't load docs — type @ again to retry");
    expect(hint).toBeDefined();
    expect(hint.getAttribute('aria-live')).toBe('assertive');
    expect(screen.queryByText('Type to find a doc')).toBeNull();
  });
});
