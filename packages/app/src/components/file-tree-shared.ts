import type {
  FileTreeInitialExpansion,
  FileTreeOptions,
  FileTreeRowDecorationRenderer,
} from '@pierre/trees';
import {
  MARKDOWN_FILE_ICON_PATH_D,
  MARKDOWN_FILE_ICON_VIEWBOX,
} from '@/components/file-entry-icon';
import {
  FILE_TREE_DENSITY_OPTIONS,
  FILE_TREE_INDENT_GUIDE_CSS,
  FILE_TREE_STICKY_HEADER_CSS,
} from '@/components/file-tree-density';
import { FILE_TREE_EXT_BADGE_CSS } from '@/components/file-tree-extension-badge';

export const MARKDOWN_FILE_ICON_ID = 'ok-file-tree-markdown';

export const MARKDOWN_FILE_ICON_SYMBOL = `<symbol id="${MARKDOWN_FILE_ICON_ID}" viewBox="${MARKDOWN_FILE_ICON_VIEWBOX}" fill="currentColor"><path d="${MARKDOWN_FILE_ICON_PATH_D}"/></symbol>`;

type IconNode = [string, Record<string, string>][];

function iconNodeToSvg(iconNode: IconNode): string {
  return iconNode
    .map(([tag, { key: _, ...attrs }]) => {
      const attrString = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `<${tag} ${attrString} />`;
    })
    .join('');
}

export function lucideMaskDataUri(iconNode: IconNode): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconNodeToSvg(iconNode)}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function createLucideSpriteSymbol(id: string, iconNode: IconNode): string {
  const symbolContent = iconNodeToSvg(iconNode);
  return `<symbol id="${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${symbolContent}</symbol>`;
}

export const FILE_TREE_USER_NAME_DIRECTION_CSS = `
  [data-item-section='content'],
  [data-item-section='content'] [data-truncate-content],
  [data-item-section='content'] [data-truncate-content] > span {
    unicode-bidi: plaintext;
  }
`;

export const FILE_TREE_FRACTIONAL_ZOOM_TRUNCATION_GUARD_CSS = `
  @container measure (height <= 1.5lh) {
    [data-truncate-marker] {
      opacity: 0;
    }
  }
`;

export const OK_FILE_TREE_READONLY_UNSAFE_CSS = [
  FILE_TREE_EXT_BADGE_CSS,
  FILE_TREE_INDENT_GUIDE_CSS,
  FILE_TREE_STICKY_HEADER_CSS,
  FILE_TREE_USER_NAME_DIRECTION_CSS,
  FILE_TREE_FRACTIONAL_ZOOM_TRUNCATION_GUARD_CSS,
].join('\n');

export interface OkFileTreeOptionsInput {
  readonly paths: readonly string[];
  readonly initialExpansion?: FileTreeInitialExpansion;
  readonly initialVisibleRowCount?: number;
  readonly stickyFolders?: boolean;
  readonly initialExpandedPaths?: readonly string[];
  readonly initialSelectedPaths?: readonly string[];
  readonly onSelectionChange?: (paths: readonly string[]) => void;
  readonly renderRowDecoration?: FileTreeRowDecorationRenderer;
  readonly extraSpriteSymbols?: string;
  readonly enableContextMenu?: boolean;
  readonly unsafeCSS?: string;
}

export function buildOkFileTreeOptions(input: OkFileTreeOptionsInput): FileTreeOptions {
  const spriteSheet = `<svg data-icon-sprite aria-hidden="true" width="0" height="0">${input.extraSpriteSymbols ?? ''}${MARKDOWN_FILE_ICON_SYMBOL}</svg>`;
  const markdownIcon = { name: MARKDOWN_FILE_ICON_ID, viewBox: MARKDOWN_FILE_ICON_VIEWBOX };
  return {
    paths: input.paths,
    initialExpansion: input.initialExpansion ?? 'closed',
    fileTreeSearchMode: 'hide-non-matches',
    initialVisibleRowCount: input.initialVisibleRowCount,
    stickyFolders: input.stickyFolders ?? false,
    ...FILE_TREE_DENSITY_OPTIONS,
    icons: {
      set: 'complete',
      spriteSheet,
      byFileExtension: { md: markdownIcon, mdx: markdownIcon },
    },
    unsafeCSS: input.unsafeCSS ?? OK_FILE_TREE_READONLY_UNSAFE_CSS,
    composition: input.enableContextMenu
      ? { contextMenu: { enabled: true, triggerMode: 'both', buttonVisibility: 'when-needed' } }
      : undefined,
    onSelectionChange: input.onSelectionChange,
    initialSelectedPaths: input.initialSelectedPaths,
    initialExpandedPaths: input.initialExpandedPaths,
    renderRowDecoration: input.renderRowDecoration,
  };
}
