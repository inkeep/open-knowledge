// @vitest-environment jsdom

import { FrameworkProvider } from 'fumadocs-core/framework';
import type * as PageTree from 'fumadocs-core/page-tree';
import { flattenTree } from 'fumadocs-core/page-tree';
import {
  Sidebar,
  type SidebarComponents,
  SidebarPageTree,
} from 'fumadocs-ui/components/layout/sidebar';
import { TreeContextProvider } from 'fumadocs-ui/contexts/tree';
import { act, createElement, type FC, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DocsPageTreeItem } from '../lib/sidebar-title.ts';
import { DocsSidebarItem } from './docs-sidebar-item.tsx';
import { DocsSidebarSeparator } from './docs-sidebar-separator.tsx';

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
            icon: 'LuBoxes',
          },
        },
        {
          type: 'page',
          path: 'workflows/plain-notes.mdx',
          slugs: ['workflows', 'plain-notes'],
          data: {
            title: 'Plain notes',
          },
        },
      ],
    }),
  },
}));

vi.doMock('@inkeep/open-knowledge-core', () => ({
  getGitHubStars: async () => 0,
}));

const { source } = await import('../lib/source.ts');
const { default: Layout } = await import('../app/docs/layout.tsx');

const layout = (await Layout({ children: null } as never)) as ReactElement<{
  sidebar?: { components?: Partial<SidebarComponents> };
}>;
const sidebarComponents = layout.props.sidebar?.components;
const LayoutItem = sidebarComponents?.Item;
const LayoutSeparator = sidebarComponents?.Separator;

const items = flattenTree(source.pageTree.children);
const overrideItem = items.find((item) => item.url === '/docs/workflows/entity-vault');
const fallbackItem = items.find((item) => item.url === '/docs/workflows/plain-notes');

const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe('docs sidebar item', () => {
  let container: HTMLDivElement;
  let root: Root;
  let priorMatchMedia: PropertyDescriptor | undefined;

  beforeEach(() => {
    actEnv.IS_REACT_ACT_ENVIRONMENT = true;
    // Sidebar branches on `matchMedia` for its mobile variant; pin it to the
    // desktop branch, keeping whatever descriptor was there for restoration.
    priorMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (priorMatchMedia) {
      Object.defineProperty(window, 'matchMedia', priorMatchMedia);
    } else {
      Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  const render = (children: ReactNode, pathname: string) =>
    act(() => {
      root.render(
        createElement(
          FrameworkProvider,
          {
            usePathname: () => pathname,
            useParams: () => ({}),
            useRouter: () => ({ push() {}, refresh() {} }),
          },
          children,
        ),
      );
    });

  /**
   * Render the whole page tree the way production does: Fumadocs' own
   * SidebarPageTree walks `source.pageTree` and hands each page node to the
   * layout's registered Item slot, so these tests also cover the slot name,
   * the `item` prop, and the tree walk passing the sidebar label through.
   *
   * Precondition: rows under a folder mount only when `pathname` points inside
   * that folder. Fumadocs opens a folder when the active path includes it, and
   * a closed folder's rows are unmounted entirely, not hidden.
   */
  const renderTree = (pathname: string) =>
    render(
      createElement(
        TreeContextProvider,
        { tree: source.pageTree },
        createElement(Sidebar, {
          Content: createElement(SidebarPageTree, { components: sidebarComponents }),
        }),
      ),
      pathname,
    );

  const renderItem = (item: PageTree.Item, pathname = item.url) =>
    render(
      createElement(Sidebar, {
        Content: createElement(LayoutItem as FC<{ item: PageTree.Item }>, { item }),
      }),
      pathname,
    );

  /**
   * The rendered row for a URL, failing loudly when it never mounted: an
   * icon-only assertion against a missing anchor would otherwise pass
   * vacuously, since `undefined?.querySelector('svg')` is not null.
   */
  const anchorByHref = (href: string) => {
    const anchor = [...container.querySelectorAll('a')].find(
      (a) => a.getAttribute('href') === href,
    );
    if (!anchor) throw new Error(`No sidebar row rendered for ${href}`);
    return anchor;
  };

  test('the docs layout registers its custom sidebar slots', () => {
    expect(LayoutItem).toBe(DocsSidebarItem);
    expect(LayoutSeparator).toBe(DocsSidebarSeparator);
  });

  test('a page with sidebarTitle renders the short label without renaming the tree node', () => {
    expect(overrideItem?.name).toBe('Entity vault (GBrain-compatible) workflow');
    renderTree('/docs/workflows/entity-vault');
    const anchor = anchorByHref('/docs/workflows/entity-vault');
    expect(anchor.textContent).toBe('Entity vault (GBrain)');
  });

  test('an active page forwards its configured icon', () => {
    const item = overrideItem as PageTree.Item;
    renderItem({ ...item, icon: undefined });
    expect(anchorByHref(item.url).querySelector('svg')).toBeNull();
    renderItem(item);
    expect(anchorByHref(item.url).querySelector('svg')).not.toBeNull();
  });

  test('a page without sidebarTitle renders its title', () => {
    renderTree('/docs/workflows/entity-vault');
    const anchor = anchorByHref('/docs/workflows/plain-notes');
    expect(anchor.textContent).toBe('Plain notes');
    expect(anchor.querySelector('svg')).toBeNull();
  });

  test('an empty sidebarTitle falls back to the title at render', () => {
    const blank: DocsPageTreeItem = { ...(fallbackItem as PageTree.Item), sidebarTitle: '' };
    renderItem(blank);
    expect(anchorByHref('/docs/workflows/plain-notes').textContent).toBe('Plain notes');
  });

  test('a whitespace-only sidebarTitle falls back to the title at render', () => {
    const blank: DocsPageTreeItem = { ...(fallbackItem as PageTree.Item), sidebarTitle: '   ' };
    renderItem(blank);
    expect(anchorByHref('/docs/workflows/plain-notes').textContent).toBe('Plain notes');
  });

  test('an external item keeps its href and the default external-link icon', () => {
    const base = {
      ...(fallbackItem as PageTree.Item),
      icon: undefined,
      name: 'External guide',
      url: 'https://example.com/guide',
    };
    renderItem({ ...base, external: false });
    expect(anchorByHref(base.url).querySelector('svg')).toBeNull();
    renderItem({ ...base, external: true });
    expect(anchorByHref(base.url).querySelector('svg')).not.toBeNull();
  });
});
