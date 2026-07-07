/**
 * Tests for the `[[`-wiki-link picker's row layout.

 *
 * The polish widened the popup and switched the secondary path/docName line
 * from single-line end-truncation to a break-all/line-clamp wrap so a long
 * link's discriminating tail stays legible. These tests pin that the full path
 * text renders and the wrap classes are present, while the existing
 * page/asset/create/anchor rendering + selection markers stay intact.
 *
 * Folder rows: folders arrive at this component already collapsed to
 * `kind:'page'` by the upstream `buildSuggestionItems` mapping (the
 * `WikiLinkSuggestionItem` union has no `folder` variant), so a dedicated
 * folder affordance is not assertable here. Symlinks are
 * likewise not represented in the item shape.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import type { WikiLinkSuggestionItem } from '../extensions/wiki-link-suggestion';
import { WikiLinkSuggestionMenu } from './WikiLinkSuggestionMenu';

afterEach(cleanup);

const LONG = 'specs/2026-06-22-some-very-long-feature-name';

const PAGE: WikiLinkSuggestionItem = { kind: 'page', docName: `${LONG}/SPEC`, title: 'SPEC' };
const ASSET: WikiLinkSuggestionItem = {
  kind: 'asset',
  target: `/${LONG}/diagram.png`,
  path: `${LONG}/diagram.png`,
  title: 'diagram.png',
};
const ANCHOR: WikiLinkSuggestionItem = {
  kind: 'anchor',
  docName: 'notes',
  level: 2,
  text: 'A heading',
  slug: 'a-heading',
};

function renderMenu(items: WikiLinkSuggestionItem[], selectedIndex = 0) {
  return render(
    <WikiLinkSuggestionMenu
      items={items}
      query=""
      selectedIndex={selectedIndex}
      onSelect={() => {}}
    />,
  );
}

describe('WikiLinkSuggestionMenu — link visibility', () => {
  test('a page row renders its full docName when it differs from the title', () => {
    renderMenu([PAGE]);
    const listbox = screen.getByRole('listbox');
    expect(listbox.textContent).toContain(PAGE.docName);
    const secondary = listbox.querySelector('.break-all');
    expect(secondary).not.toBeNull();
    expect(secondary?.className).toContain('line-clamp-2');
    expect(secondary?.className).not.toContain('truncate');
  });

  test('an asset row renders its full path with the wrap classes', () => {
    renderMenu([ASSET]);
    const listbox = screen.getByRole('listbox');
    expect(listbox.textContent).toContain(ASSET.path);
    const secondary = listbox.querySelector('.break-all');
    expect(secondary?.className).toContain('line-clamp-2');
  });

  test('a create row renders the would-be filename without single-line truncation', () => {
    const create: WikiLinkSuggestionItem = {
      kind: 'create',
      docName: `${LONG}/new-doc`,
      title: 'new doc',
      actionLabel: 'Insert unresolved link "new doc"',
    };
    renderMenu([create]);
    const listbox = screen.getByRole('listbox');
    expect(listbox.textContent).toContain(`${create.docName}.md`);
    expect(listbox.querySelector('.break-all')?.className).toContain('line-clamp-2');
  });
});

describe('WikiLinkSuggestionMenu — existing behavior preserved', () => {
  test('the selected option is aria-selected and data-selected', () => {
    renderMenu([PAGE, ASSET], 1);
    const options = screen.getAllByRole('option');
    expect(options[0]?.getAttribute('aria-selected')).toBe('false');
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(options[1]?.getAttribute('data-selected')).toBe('true');
  });

  test('non-anchor rows render an icon glyph', () => {
    renderMenu([PAGE, ASSET]);
    for (const option of screen.getAllByRole('option')) {
      expect(option.querySelector('svg')).not.toBeNull();
    }
  });

  test('an anchor row still renders its H{level} badge and heading text', () => {
    renderMenu([ANCHOR]);
    const option = screen.getByRole('option');
    expect(option.textContent).toContain('H2');
    expect(option.textContent).toContain('A heading');
  });

  test('the empty state surfaces the no-pages copy', () => {
    render(<WikiLinkSuggestionMenu items={[]} query="" selectedIndex={0} onSelect={() => {}} />);
    expect(screen.getByText('No pages found')).toBeDefined();
  });
});
