/**
 * VS Code-density tuning for the file-tree sidebar.
 *
 * Pierre stacks per-level horizontal cost as:
 *   (level-gap - 1px) + (item-row-gap + icon-width / 2 - 0.5px)
 * — the dominant knobs are `level-gap` and `item-row-gap`, with a fixed
 * -1.5px correction baked into Pierre's spacer margins. At Pierre defaults
 * that lands ~20px/level; VS Code uses a flat ~8px gutter. Reaching
 * VS Code-density needs the `compact` density preset (factor 0.8) with the row
 * height pinned to 26px (an explicit `itemHeight` override of the preset's 24,
 * matching the rendered row height — see FILE_TREE_DENSITY_OPTIONS) AND
 * explicit overrides on `--trees-level-gap-override` /
 * `--trees-item-row-gap-override` since `icon-width` is not factor-scaled.
 *
 * Always-on indent guide lines (`FILE_TREE_INDENT_GUIDE_CSS`) ship from the
 * same module because they are co-dependent: Pierre's base rule sets the
 * `spacing-item` border to `opacity: 0` (visible only on host hover), and the
 * tight indent above is unreadable without a visible parent-trace line at
 * rest. The CSS string lands in Pierre's `@layer unsafe` via `unsafeCSS`,
 * which trumps the base-layer rule.
 *
 * Lives in its own module so the runtime-effect test (`file-tree-density.test.ts`)
 * can import it without pulling in the `@lingui/core/macro` build-time macro
 * that FileTree.tsx depends on at module-load.
 */
import { themeToTreeStyles } from '@pierre/trees';
import type { CSSProperties } from 'react';

export const FILE_TREE_DENSITY_OPTIONS = {
  density: 'compact',
  // Single source of truth for the file-tree row height. @pierre/trees
  // positions every row on this itemHeight grid; the rendered row height
  // (`--trees-item-height`) is DERIVED from this value below, so the two cannot
  // drift apart. They MUST stay equal — if rows render taller than the grid
  // step, the per-row gap accumulates across the virtualized window and
  // silently steals that many pixels off the bottom of the scroll range, making
  // the last rows unreachable (worse the taller/deeper the tree). The `compact`
  // preset's own itemHeight is 24; we override to 26 for the VS Code type scale.
  itemHeight: 26,
  // `@pierre/trees` beta.4 flipped the `flattenEmptyDirectories` default from
  // false to true (`options.flattenEmptyDirectories !== false`), so OMITTING
  // it silently turns compact folders ON. Compact folders is deferred — it
  // does not flatten under the lazy-per-dir-fetch listing
  // (a chain's children aren't loaded until expand, so Pierre can't collapse
  // it) and turning it on regresses the drag-to-root suite. Pin it off until
  // the follow-up makes single-child chains eager-load.
  flattenEmptyDirectories: false,
} as const;

const FILE_TREE_DENSITY_STYLE = {
  '--trees-level-gap-override': '4px',
  '--trees-item-row-gap-override': '4px',
  // Pierre's default icon width (16px) is NOT factor-scaled by `--trees-density`,
  // so it dominates the per-level step. Shrinking to 14px both gives the
  // filename ~2px of horizontal headroom and tightens the per-level indent
  // (the level-N margin-left adds `icon-width / 2 - 0.5px`). The row layout
  // uses `gap: var(--trees-item-row-gap)` for icon-to-name, already tightened
  // to 2px above, so no separate icon-to-name override is needed.
  '--trees-icon-width-override': '14px',
  // DERIVED from FILE_TREE_DENSITY_OPTIONS.itemHeight (the single source of
  // truth) so the rendered row height can never drift from the virtualizer's
  // grid step — a mismatch makes the bottom of the scroll range unreachable
  // (see the note there). Set here on the React style prop because Pierre's
  // #applyDensityHostStyle writes the var from JS only when it's empty;
  // pre-empting that exposes the value to CSS-only paths (unit tests, pre-mount
  // SSR) without changing the live render.
  '--trees-item-height': `${FILE_TREE_DENSITY_OPTIONS.itemHeight}px`,
  // Lift Pierre's default guide-bg alpha from 25% to 30% so the rendered
  // border still reads against the sidebar after the per-element opacity
  // multiplies it down (see FILE_TREE_INDENT_GUIDE_CSS). Mixed in `oklab`
  // (Pierre's default is `lab`) to match the rest of packages/app/src/.
  '--trees-indent-guide-bg-override': 'color-mix(in oklab, var(--trees-fg-muted) 30%, transparent)',
} as const;

// Pierre's `[data-item-section='spacing-item']` rule sets `opacity: 0` and
// raises it to 0.75 only under `:host(:hover)`. With density tightened to
// ~10px per level, the rows lose their parent-trace at rest. Republishing
// both rules in `@layer unsafe` (per `cssWrappers.ts`, unsafe wins over base)
// gives a faint resting guide and a slightly stronger hover state.
export const FILE_TREE_INDENT_GUIDE_CSS = `
  [data-item-section='spacing-item'] {
    opacity: 0.5;
  }
  :host(:hover) [data-item-section='spacing-item'] {
    opacity: 0.85;
  }
`;

// Pierre paints pinned ancestors and the scrolling tree on the same
// `--trees-bg`, so a sticky row reads as just another row. Redefining
// `--trees-bg` only inside the sticky overlay scope tints just the pinned
// rows (their resting `background-color: var(--trees-bg)` re-resolves to the
// tinted value); hover (`--trees-bg-muted`) and selected (`--trees-selected-bg`)
// use different vars and still paint normally on top. A `box-shadow` below
// the overlay-content draws a hairline divider that sits beneath the row
// backgrounds, so it remains visible regardless of which row is on top.
// Two upstream gates keep this treatment from appearing when nothing is
// actively pinned: (a) Pierre conditionally renders the overlay element
// only when `stickyRows.length > 0` (no pinnable ancestors → the targeted
// element is absent from the DOM), and (b) when stickyRows is populated
// but the user is still at scrollTop=0, Pierre sets `visibility: hidden`
// on the OUTER overlay wrapper `[data-file-tree-sticky-overlay='true']`
// via a rule keyed on its `[data-file-tree-virtualized-root='true']`
// ancestor carrying `[data-scroll-at-top='true']:not([data-overlay-reveal])`
// — the inner `-content` element styled below inherits the hidden state,
// so debugging this rule means looking at the parent, not the styled node.
// The overlay DOM is kept pre-populated so the compositor has rows on hand
// the moment scrolling starts.
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
    '--truncate-marker-fade-in-duration': '0s', // render ellipsis without delay
    '--trees-file-icon-color-markdown': 'light-dark(var(--color-gray-400), var(--color-gray-500))',
    '--trees-fg-muted': 'light-dark(var(--color-gray-400), var(--color-gray-500))',
    ...FILE_TREE_DENSITY_STYLE,
  } as CSSProperties;
}
