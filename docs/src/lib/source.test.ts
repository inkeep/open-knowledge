import { flattenTree } from 'fumadocs-core/page-tree';
import { describe, expect, test, vi } from 'vitest';
import type { DocsPageTreeItem } from './sidebar-title.ts';

/**
 * The generated `.source/server` artifact imports every page in `content/` as
 * `*.mdx?collection=docs`. Vite's import analysis cannot resolve those
 * specifiers without the Next/Fumadocs transform, which this package's Vitest
 * config does not register. Faking that one artifact keeps `loader()` and the
 * sidebar transformer real, which is what lets these tests go red if the
 * `pageTree` wiring is ever dropped from `source.ts`.
 */
vi.doMock('../../.source/server', () => ({
  docs: {
    toFumadocsSource: () => ({
      files: [
        {
          type: 'page',
          path: 'workflows/entity-vault.mdx',
          slugs: ['workflows', 'entity-vault'],
          data: {
            title: 'Entity vault (GBrain-compatible) workflow',
            sidebarTitle: 'Entity vault (GBrain)',
          },
        },
        {
          type: 'page',
          path: 'workflows/plain-notes.mdx',
          slugs: ['workflows', 'plain-notes'],
          data: { title: 'Plain notes' },
        },
        {
          type: 'page',
          path: 'workflows/worldbuilding.mdx',
          slugs: ['workflows', 'worldbuilding'],
          data: { title: 'Worldbuilding', sidebarTitle: '' },
        },
        {
          type: 'page',
          path: 'workflows/plain-notes-spaced.mdx',
          slugs: ['workflows', 'plain-notes-spaced'],
          data: { title: 'Codebase wiki', sidebarTitle: '   ' },
        },
        {
          type: 'page',
          path: 'workflows/padded.mdx',
          slugs: ['workflows', 'padded'],
          data: { title: 'Software lifecycle', sidebarTitle: '  Lifecycle  ' },
        },
        {
          type: 'meta',
          path: 'workflows/meta.json',
          data: {
            title: 'Workflows',
            pages: [
              'entity-vault',
              'plain-notes',
              'worldbuilding',
              'plain-notes-spaced',
              'padded',
              '[External guide](https://example.com/guide)',
            ],
          },
        },
      ],
    }),
  },
}));

const { source } = await import('./source.ts');

/** Page-tree item for every page row in the built tree, keyed by URL. */
function pageTreeItems(): Map<string, DocsPageTreeItem> {
  return new Map(
    flattenTree(source.pageTree.children).map((item) => [item.url, item as DocsPageTreeItem]),
  );
}

describe('docs sidebar labels', () => {
  test('a page with sidebarTitle keeps its title and carries a short sidebar label', () => {
    expect(pageTreeItems().get('/docs/workflows/entity-vault')).toMatchObject({
      name: 'Entity vault (GBrain-compatible) workflow',
      sidebarTitle: 'Entity vault (GBrain)',
    });
  });

  test('a page without sidebarTitle keeps its title without a sidebar override', () => {
    expect(pageTreeItems().get('/docs/workflows/plain-notes')).toMatchObject({
      name: 'Plain notes',
    });
    expect(pageTreeItems().get('/docs/workflows/plain-notes')).not.toHaveProperty('sidebarTitle');
  });

  // The schema admits `sidebarTitle: ''`. It is falsy, so the emptiness test
  // catches it with or without the trim; this pins the fallback so a guard
  // refactor cannot start carrying an empty label.
  test('an empty sidebarTitle falls back to the title rather than blanking the row', () => {
    expect(pageTreeItems().get('/docs/workflows/worldbuilding')).toMatchObject({
      name: 'Worldbuilding',
    });
    expect(pageTreeItems().get('/docs/workflows/worldbuilding')).not.toHaveProperty('sidebarTitle');
  });

  // A whitespace-only value is truthy, so an untrimmed guard would name the
  // row with nothing, leaving a link with an empty accessible name. This is
  // the case the trim exists for.
  test('a whitespace-only sidebarTitle falls back to the title rather than blanking the row', () => {
    expect(pageTreeItems().get('/docs/workflows/plain-notes-spaced')).toMatchObject({
      name: 'Codebase wiki',
    });
    expect(pageTreeItems().get('/docs/workflows/plain-notes-spaced')).not.toHaveProperty(
      'sidebarTitle',
    );
  });

  test('a padded sidebarTitle is trimmed rather than rendered with its padding', () => {
    expect(pageTreeItems().get('/docs/workflows/padded')).toMatchObject({
      name: 'Software lifecycle',
      sidebarTitle: 'Lifecycle',
    });
  });

  test('a meta-file link without a backing page bypasses the page-only transform', () => {
    expect(pageTreeItems().get('https://example.com/guide')).toMatchObject({
      name: 'External guide',
      url: 'https://example.com/guide',
    });
    expect(pageTreeItems().get('https://example.com/guide')).not.toHaveProperty('sidebarTitle');
  });
});
