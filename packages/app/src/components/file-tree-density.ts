import { themeToTreeStyles } from '@pierre/trees';
import type { CSSProperties } from 'react';

export const FILE_TREE_DENSITY_OPTIONS = {
  density: 'compact',
  itemHeight: 26,
  flattenEmptyDirectories: false,
} as const;

const FILE_TREE_DENSITY_STYLE = {
  '--trees-level-gap-override': '4px',
  '--trees-item-row-gap-override': '4px',
  '--trees-icon-width-override': '14px',
  '--trees-item-height': `${FILE_TREE_DENSITY_OPTIONS.itemHeight}px`,
  '--trees-indent-guide-bg-override': 'color-mix(in oklab, var(--trees-fg-muted) 30%, transparent)',
} as const;

export const FILE_TREE_INDENT_GUIDE_CSS = `
  [data-item-section='spacing-item'] {
    opacity: 0.5;
  }
  :host(:hover) [data-item-section='spacing-item'] {
    opacity: 0.85;
  }
`;

export const FILE_TREE_STICKY_HEADER_CSS = `
  [data-file-tree-sticky-overlay-content='true'] {
    --trees-bg: color-mix(in oklab, var(--sidebar) 92%, var(--sidebar-foreground) 8%);
    box-shadow: 0 1px 0 0 var(--sidebar-border);
  }
  /* Forced-colors mode suppresses box-shadow and overrides color-mix tints,
     so the divider above would vanish and the pinned region would read as
     part of scrolling content. Borders survive forced-colors — mirror the
     fallback pattern used by FILE_TREE_ROOT_DROP_CSS. */
  @media (forced-colors: active) {
    [data-file-tree-sticky-overlay-content='true'] {
      border-bottom: 1px solid CanvasText;
    }
  }
`;

export function createFileTreeStyle(resolvedTheme: string | undefined): CSSProperties {
  return {
    ...themeToTreeStyles({
      type: resolvedTheme === 'dark' ? 'dark' : 'light',
      colors: {
        'sideBar.background': 'var(--sidebar)',
        'sideBar.foreground': 'var(--sidebar-foreground)',
        'sideBar.border': 'var(--sidebar-border)',
        'list.activeSelectionBackground': 'var(--sidebar-accent)',
        'list.activeSelectionForeground': 'var(--sidebar-accent-foreground)',
        'list.hoverBackground': 'var(--sidebar-hover)',
        focusBorder: 'var(--color-primary)',
        'input.background': 'var(--input)',
        'input.border': 'var(--border)',
      },
    }),
    '--trees-font-family-override': 'var(--font-sans)',
    '--trees-font-size-override': '0.875rem',
    '--trees-item-padding-x-override': '0.5rem',
    '--trees-padding-inline-override': '0.5rem',
    '--trees-border-radius-override': '0.375rem',
    '--trees-selected-fg': 'var(--color-primary)',
    '--truncate-marker-fade-in-duration': '0s',
    '--trees-file-icon-color-markdown': 'light-dark(var(--color-gray-400), var(--color-gray-500))',
    '--trees-fg-muted': 'var(--color-tree-muted)',
    ...FILE_TREE_DENSITY_STYLE,
  } as CSSProperties;
}
