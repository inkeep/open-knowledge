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

/**
 * A lucide icon as a CSS `mask-image` data URI, for places that style a row from
 * the tree's `unsafeCSS` rather than render into it — the sprite + `<use>` route
 * needs a DOM node to hang the `<svg>` on, and Pierre owns the label cell. The
 * stroke is baked in because a mask has no `currentColor`; the caller supplies
 * the colour through `background-color`.
 */
export function lucideMaskDataUri(iconNode: IconNode): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconNodeToSvg(iconNode)}</svg>`;
  // Percent-encoded rather than base64: it stays readable in devtools, and the
  // characters a CSS `url()` minds are exactly the ones this escapes.
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function createLucideSpriteSymbol(id: string, iconNode: IconNode): string {
  const symbolContent = iconNodeToSvg(iconNode);
  return `<symbol id="${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${symbolContent}</symbol>`;
}

/**
 * File and folder names are the user's own words, so each row's writing
 * direction has to come from the name rather than from the interface language.
 * `direction` inherits from `<html dir>` and crosses into Pierre's shadow root,
 * so an Arabic interface would otherwise re-order a Latin filename.
 *
 * CSS rather than `dir="auto"` because Pierre renders the rows: `plaintext` is
 * the CSS spelling of the same rule, resolving each row's base direction from
 * its own first strong character. Rows are separate blocks, so this stays
 * per-name — a folder of mixed-direction names does not adopt one direction.
 *
 * Both the label cell and the truncation nodes inside it are covered because
 * `unicode-bidi` does not inherit and the innermost of them is what actually
 * contains the text. Pierre's start-truncation variant sets `direction: rtl` on
 * `[data-truncate-content]` as a truncation trick; OK's trees use end and
 * middle truncation, so this never lands on top of it.
 */
export const FILE_TREE_USER_NAME_DIRECTION_CSS = `
  [data-item-section='content'],
  [data-item-section='content'] [data-truncate-content],
  [data-item-section='content'] [data-truncate-content] > span {
    unicode-bidi: plaintext;
  }
`;

/**
 * Guard against Pierre's truncation ellipsis false-firing at fractional page
 * zoom (Electron `setZoomLevel` / browser Cmd±).
 *
 * Pierre detects overflow purely in CSS: an aria-hidden copy of the row name
 * (`word-break: break-all`) wraps onto a second line when the name doesn't
 * fit, which grows the `container: measure / size` marker cell past one line,
 * and `@container measure (height > 1lh)` then reveals the `…` marker — an
 * opaque overlay painted over the tail of the name. At zoom factors below ~0.92
 * Blink's layout-unit snapping makes that cell measure a hair over `1lh` on
 * EVERY row (observed 26.03px vs 26px at factor 0.833), so every name gets an
 * ellipsis painted over its last characters even though it fully fits.
 *
 * Genuine overflow always wraps the hidden copy by whole line boxes, so the
 * cell lands at ≥ 2lh; rounding error is < 0.01lh. `1.5lh` cleanly separates
 * the two, at any tree density (the threshold scales with line-height). This
 * rule ships in Pierre's `unsafe` cascade layer, which wins over its `base`
 * layer, so it overrides the base reveal rule whenever both match.
 */
export const FILE_TREE_TRUNCATION_ZOOM_GUARD_CSS = `
  @container measure (height <= 1.5lh) {
    [data-truncate-marker] {
      opacity: 0;
    }
  }
`;

/**
 * The read-only-safe `unsafeCSS` base: colored-icon selected-fg rule + extension
 * badges + indent guides + sticky headers + per-name writing direction +
 * fractional-zoom truncation guard. This is everything a NON-editing tree
 * needs. The main tree extends this with its rename / drop / creation CSS.
 */
export const OK_FILE_TREE_READONLY_UNSAFE_CSS = `${FILE_TREE_EXT_BADGE_CSS}\n${FILE_TREE_INDENT_GUIDE_CSS}\n${FILE_TREE_STICKY_HEADER_CSS}\n${FILE_TREE_USER_NAME_DIRECTION_CSS}\n${FILE_TREE_TRUNCATION_ZOOM_GUARD_CSS}`;

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
