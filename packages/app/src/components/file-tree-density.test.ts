/**
 * Runtime-effect test of the file-tree's VS Code-density configuration.
 *
 * jsdom does not compute Pierre's `calc()` cascade through the shadow root,
 * so per-level-step measurement belongs in a Playwright e2e. Here we pin the
 * upstream config: `density: 'compact'` plus the `--trees-*` overrides that
 * collapse Pierre's defaults from ~20px/level to a VS Code-style ~8-10px/level
 * step. If a future change drops the density preset, widens an override, or
 * skips the row-height clamp, this test fails before render-time regressions
 * show up in dogfood.
 */
import { describe, expect, test } from 'bun:test';
import {
  createFileTreeStyle,
  FILE_TREE_DENSITY_OPTIONS,
  FILE_TREE_INDENT_GUIDE_CSS,
  FILE_TREE_STICKY_HEADER_CSS,
} from './file-tree-density';

describe('FileTree density configuration', () => {
  test('uses the Pierre compact density preset', () => {
    expect(FILE_TREE_DENSITY_OPTIONS.density).toBe('compact');
  });

  test('pins compact-folders (flattenEmptyDirectories) OFF — beta.4 defaults it on; deferred pending lazy-load support', () => {
    // beta.4 flipped the default to true, so this must be an explicit false,
    // not an omission. Compact folders is deferred to a follow-up that makes
    // single-child chains eager-load under the show-all/lazy default.
    expect(FILE_TREE_DENSITY_OPTIONS.flattenEmptyDirectories).toBe(false);
  });

  test('overrides per-level and row-height vars in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const style = createFileTreeStyle(theme) as Record<string, string | number>;
      expect(style['--trees-level-gap-override']).toBe('4px');
      expect(style['--trees-item-row-gap-override']).toBe('4px');
      expect(style['--trees-item-height']).toBe('26px');
    }
  });

  test('overrides icon-width below the Pierre 16px default in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const style = createFileTreeStyle(theme) as Record<string, string>;
      const iconWidth = style['--trees-icon-width-override'];
      expect(iconWidth).toBe('14px');
      // Pierre's default is 16px and is NOT factor-scaled by density — shrinking it
      // is what drops the per-level step the rest of the way toward VS Code's ~8px.
      const px = Number.parseInt(iconWidth.slice(0, -2), 10);
      expect(px).toBeLessThan(16);
    }
  });

  test('row height clamp is at or below 26px to keep VS Code-style compactness', () => {
    const style = createFileTreeStyle('dark') as Record<string, string>;
    const itemHeight = style['--trees-item-height'];
    expect(itemHeight).toMatch(/^(\d+)px$/);
    const px = Number.parseInt(itemHeight.slice(0, -2), 10);
    expect(px).toBeLessThanOrEqual(26);
  });

  test('rendered --trees-item-height is derived from the virtualizer itemHeight (one source of truth, cannot drift)', () => {
    // Equality is guaranteed structurally — `--trees-item-height` is computed
    // from FILE_TREE_DENSITY_OPTIONS.itemHeight, not a second hand-kept literal.
    // This pins that the derived value still surfaces through createFileTreeStyle
    // (themeToTreeStyles must not clobber it). The invariant matters because
    // @pierre/trees positions rows on the itemHeight grid while they render at
    // --trees-item-height; any gap accumulates into an unreachable scroll bottom
    // (worse the taller the tree).
    for (const theme of ['light', 'dark'] as const) {
      const style = createFileTreeStyle(theme) as Record<string, string>;
      expect(style['--trees-item-height']).toBe(`${FILE_TREE_DENSITY_OPTIONS.itemHeight}px`);
    }
  });

  test('preserves existing typography + padding overrides alongside density', () => {
    const style = createFileTreeStyle('light') as Record<string, string | number>;
    expect(style['--trees-font-size-override']).toBe('0.875rem');
    expect(style['--trees-item-padding-x-override']).toBe('0.5rem');
    expect(style['--trees-padding-inline-override']).toBe('0.5rem');
    expect(style['--trees-border-radius-override']).toBe('0.375rem');
  });

  test('overrides indent-guide bg to lift its alpha out of Pierre defaults', () => {
    for (const theme of ['light', 'dark'] as const) {
      const style = createFileTreeStyle(theme) as Record<string, string>;
      const guideBg = style['--trees-indent-guide-bg-override'];
      // Pin `oklab` (Pierre's default is `lab`) — matches the rest of
      // packages/app/src/ and keeps perceptual blending consistent.
      expect(guideBg).toMatch(/color-mix\(in oklab,.*var\(--trees-fg-muted\)/);
      const alphaMatch = guideBg.match(/(\d+)%/);
      expect(alphaMatch).not.toBeNull();
      const alpha = Number.parseInt(alphaMatch?.[1] ?? '0', 10);
      expect(alpha).toBeGreaterThanOrEqual(25);
      expect(alpha).toBeLessThanOrEqual(35);
    }
  });
});

describe('FileTree indent-guide CSS', () => {
  // Helper: extract `opacity: <value>` declarations as paired (selector, value) tuples.
  function extractOpacityRules(): Array<{ selector: string; opacity: number }> {
    const matches = FILE_TREE_INDENT_GUIDE_CSS.matchAll(
      /([^{}]+)\{[^}]*opacity:\s*([\d.]+)\s*;?[^}]*\}/g,
    );
    return Array.from(matches, (m) => ({
      selector: m[1].trim(),
      opacity: Number.parseFloat(m[2]),
    }));
  }

  test('targets Pierre indent-guide spacing-item selector', () => {
    expect(FILE_TREE_INDENT_GUIDE_CSS).toContain(`[data-item-section='spacing-item']`);
  });

  test('resting opacity on the spacing-item is greater than zero (visible at rest)', () => {
    const rules = extractOpacityRules();
    const restingRule = rules.find((r) => r.selector === `[data-item-section='spacing-item']`);
    expect(restingRule).toBeDefined();
    expect(restingRule?.opacity).toBeGreaterThan(0);
  });

  test('hover state keeps a stronger contrast than rest', () => {
    const rules = extractOpacityRules();
    const restingRule = rules.find((r) => r.selector === `[data-item-section='spacing-item']`);
    const hoverRule = rules.find((r) => r.selector.includes(':host(:hover)'));
    expect(restingRule?.opacity).toBeDefined();
    expect(hoverRule?.opacity).toBeDefined();
    expect((hoverRule?.opacity ?? 0) > (restingRule?.opacity ?? 0)).toBe(true);
  });
});

describe('FileTree sticky-header CSS', () => {
  test('targets the Pierre sticky overlay-content scope', () => {
    expect(FILE_TREE_STICKY_HEADER_CSS).toContain(`[data-file-tree-sticky-overlay-content='true']`);
  });

  test('redefines --trees-bg inside the sticky scope so pinned rows pick up an elevation tint', () => {
    // Re-scoping `--trees-bg` is what makes the row backgrounds repaint; hover
    // (`--trees-bg-muted`) and selected (`--trees-selected-bg`) bind to other
    // vars and must remain untouched. Pin `oklab` (Pierre's default is `lab`)
    // — matches the rest of packages/app/src/.
    expect(FILE_TREE_STICKY_HEADER_CSS).toMatch(/--trees-bg:\s*color-mix\(in oklab,/);
    expect(FILE_TREE_STICKY_HEADER_CSS).not.toMatch(/--trees-bg-muted\s*:/);
    expect(FILE_TREE_STICKY_HEADER_CSS).not.toMatch(/--trees-selected-bg\s*:/);
  });

  test('paints a hairline divider via box-shadow keyed to --sidebar-border', () => {
    // box-shadow stays visible behind row backgrounds (border-bottom would be
    // hidden by the row's own paint); `--sidebar-border` exists in both light
    // and dark theme tokens so the hairline tracks the accessibility floor.
    expect(FILE_TREE_STICKY_HEADER_CSS).toMatch(/box-shadow:[^;]*var\(--sidebar-border\)/);
  });

  test('forced-colors fallback paints a CanvasText border-bottom (box-shadow + color-mix tints both suppressed in HCM)', () => {
    // Windows High Contrast / forced-colors mode strips box-shadow and
    // color-mix tints, so the divider above would vanish. Borders survive,
    // and `CanvasText` is the forced-colors-defined system foreground —
    // hard-coding a theme token would silently break the fallback.
    expect(FILE_TREE_STICKY_HEADER_CSS).toMatch(/@media \(forced-colors: active\)/);
    expect(FILE_TREE_STICKY_HEADER_CSS).toMatch(/border-bottom:[^;]*CanvasText/);
  });
});
