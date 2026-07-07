import { loader } from 'fumadocs-core/source';
import { icons } from 'lucide-react';
import { createElement } from 'react';
import { type BrandIconName, brandIcons } from '@/components/icons/brand';
import { docs } from '../../.source/server';

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
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
});
