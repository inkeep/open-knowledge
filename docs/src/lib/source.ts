import { loader, type PageTreeTransformer, type Source } from 'fumadocs-core/source';
import { icons } from 'lucide-react';
import { createElement } from 'react';
import { type BrandIconName, brandIcons } from '@/components/icons/brand';
import { withSidebarTitle } from '@/lib/sidebar-title';
import { docs } from '../../.source/server';

const docsSource = docs.toFumadocsSource();

/** Keep transformer frontmatter access checked against the generated docs schema. */
type DocsSourceConfig = typeof docsSource extends Source<infer Config> ? Config : never;

/**
 * Carry a page's optional short label to the sidebar without replacing the
 * canonical page-tree name. The shared tree also feeds navigation UI such as
 * previous/next links and the responsive table-of-contents trigger.
 */
const sidebarTitleTransformer: PageTreeTransformer<DocsSourceConfig> = {
  file(node, filePath) {
    // A meta.json link entry (`[Text](url)`) has no backing file and reaches
    // this hook without a filePath. Only page storage records carry the
    // frontmatter data read below.
    if (!filePath) return node;
    const file = this.storage.read(filePath);
    if (file?.format !== 'page') return node;
    // Trim before the emptiness test: the schema admits a whitespace-only
    // value, which is truthy untrimmed and would name the row with nothing,
    // leaving a link with an empty accessible name.
    const sidebarTitle = file.data.sidebarTitle?.trim();
    return sidebarTitle ? withSidebarTitle(node, sidebarTitle) : node;
  },
};

export const source = loader({
  baseUrl: '/docs',
  source: docsSource,
  icon(iconName) {
    if (!iconName) return;

    // Brand logos (e.g. `custom/Claude`) resolve against the local registry.
    if (iconName.startsWith('custom/')) {
      const key = iconName.slice('custom/'.length) as BrandIconName;
      const Brand = brandIcons[key];
      if (Brand) return createElement(Brand);
      throw new Error(`Unknown brand icon "${iconName}"`);
    }

    if (iconName.startsWith('Lu')) {
      const key = iconName.slice(2) as keyof typeof icons;
      const Icon = icons[key];
      if (Icon) return createElement(Icon);
    }

    throw new Error(`Unknown icon "${iconName}"`);
  },
  pageTree: {
    transformers: [sidebarTitleTransformer],
  },
});
