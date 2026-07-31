/**
 * Shared, workspace-agnostic slice of the `@pierre/trees` file-tree integration.
 *
 * The skills bundle-file tree (`SkillsSidebarSection.tsx`) renders through
 * `<OkFileTree>` (which mounts Pierre + the generic decoration observers). This
 * module holds the reusable pieces — the ones the main Files tree (`FileTree.tsx`,
 * still on its own inline Pierre mount) also needs when it migrates onto
 * `<OkFileTree>`: the custom markdown glyph sprite, the generic
 * lucide-sprite helpers, the read-only `unsafeCSS` base (colored-icon color
 * rule + indent guides + sticky headers + extension badges), and the
 * `useFileTree` options builder that produces the generic option slice.
 *
 * Kept free of React and Lingui macros (like `file-tree-density.ts`) so it stays
 * unit-testable without pulling in the editor build graph.
 */

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

/** Sprite symbol id for the custom markdown glyph (overrides Pierre's built-in). */
export const MARKDOWN_FILE_ICON_ID = 'ok-file-tree-markdown';

// Custom Markdown file glyph (document with an "MD" label) overriding Pierre's
// built-in `complete`-set markdown glyph. `fill="currentColor"` lets
// `--trees-file-icon-color-markdown` (set in createFileTreeStyle, see
// file-tree-density.ts) color it.
export const MARKDOWN_FILE_ICON_SYMBOL = `<symbol id="${MARKDOWN_FILE_ICON_ID}" viewBox="${MARKDOWN_FILE_ICON_VIEWBOX}" fill="currentColor"><path d="${MARKDOWN_FILE_ICON_PATH_D}"/></symbol>`;

type IconNode = [string, Record<string, string>][];

function iconNodeToSvg(iconNode: IconNode): string {
  return (
    iconNode
      // remove React key
      .map(([tag, { key: _, ...attrs }]) => {
        const attrString = Object.entries(attrs)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ');
        return `<${tag} ${attrString} />`;
      })
      .join('')
  );
}

export function createLucideSpriteSymbol(id: string, iconNode: IconNode): string {
  const symbolContent = iconNodeToSvg(iconNode);
  return `<symbol id="${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${symbolContent}</symbol>`;
}

/**
 * The read-only-safe `unsafeCSS` base: colored-icon selected-fg rule + extension
 * badges + indent guides + sticky headers. This is everything a NON-editing tree
 * needs. The main tree extends this with its rename / drop / creation CSS.
 */
export const OK_FILE_TREE_READONLY_UNSAFE_CSS = `${FILE_TREE_EXT_BADGE_CSS}\n${FILE_TREE_INDENT_GUIDE_CSS}\n${FILE_TREE_STICKY_HEADER_CSS}`;

export interface OkFileTreeOptionsInput {
  readonly paths: readonly string[];
  readonly initialExpansion?: FileTreeInitialExpansion;
  readonly initialVisibleRowCount?: number;
  readonly stickyFolders?: boolean;
  readonly initialExpandedPaths?: readonly string[];
  readonly initialSelectedPaths?: readonly string[];
  readonly onSelectionChange?: (paths: readonly string[]) => void;
  /** Main tree only — symlink/agent row badges. */
  readonly renderRowDecoration?: FileTreeRowDecorationRenderer;
  /** Extra `<symbol>` markup concatenated into the icon sprite (link/agent glyphs). */
  readonly extraSpriteSymbols?: string;
  readonly enableContextMenu?: boolean;
  /** Overrides the read-only base (the main tree passes its full composition). */
  readonly unsafeCSS?: string;
}

/**
 * Build the GENERIC slice of Pierre `FileTreeOptions` shared by every OK tree —
 * density, the `complete` colored icon set + markdown override, the read-only
 * `unsafeCSS` base, search mode, and any provided selection/expansion/decoration
 * config. Callers merge their own `dragAndDrop`/`renaming` on top before passing
 * the result to `useFileTree`.
 */
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
