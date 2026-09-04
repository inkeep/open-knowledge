import { loader, type PageTreeTransformer, type Source } from 'fumadocs-core/source';
import { icons } from 'lucide-react';
import { createElement } from 'react';
import { type BrandIconName, brandIcons } from '@/components/icons/brand';
import { withSidebarTitle } from '@/lib/sidebar-title';
import { docs } from '../../.source/server';

const docsSource = docs.toFumadocsSource();

type DocsSourceConfig = typeof docsSource extends Source<infer Config> ? Config : never;

const sidebarTitleTransformer: PageTreeTransformer<DocsSourceConfig> = {
  file(node, filePath) {
    if (!filePath) return node;
    const file = this.storage.read(filePath);
    if (file?.format !== 'page') return node;
    const sidebarTitle = file.data.sidebarTitle?.trim();
    return sidebarTitle ? withSidebarTitle(node, sidebarTitle) : node;
  },
};

export const source = loader({
  baseUrl: '/docs',
  source: docsSource,
  icon(iconName) {
    if (!iconName) return;

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
