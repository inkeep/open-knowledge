/**
 * Curated lucide-icon → inline-SVG-string renderer for imperative (non-React)
 * DOM, used by the composer's `@`-mention node view (ProseMirror-managed plain
 * DOM, so it cannot render a React `<Icon />`). The string is injected via
 * `innerHTML` so the inline chip's leading glyph is pixel-identical to the
 * top-row chip's React-rendered lucide icon and inherits `currentColor`.
 *
 * Why a curated map and not `renderToStaticMarkup(<Icon />)`: `react-dom/server`
 * is absent from the production bundle, and the composer ships in the EAGER
 * bundle, which sits ~4 kB under the `size-limit` gate. Pulling in
 * `react-dom/server` (~30 kB gzipped) to render ≤6 tiny icons would blow that
 * gate. The geometry below is the inner body of each lucide icon, verbatim from
 * `lucide-react`; `lucide-svg.test.ts` renders each component with the test-only
 * `react-dom/server` and asserts this map still matches, so a lucide upgrade that
 * redraws a glyph fails loudly rather than silently drifting.
 *
 * Only the small set of icons the chips can show are curated: the five
 * `getFileIcon` can return (`FolderOpen`, `FileText`, `Image`, `Film`,
 * `Volume2`), the search/sidebar file-entry fallbacks (`File`, `ImageIcon`),
 * plus the `X` remove glyph. An unmapped icon falls back to `FileText`'s body
 * so the chip always renders something.
 */
import {
  File,
  FileText,
  Film,
  FolderOpen,
  Image,
  ImageIcon,
  type LucideIcon,
  Volume2,
  X,
} from 'lucide-react';

/**
 * Inner SVG geometry (the `<path>`/`<rect>`/`<circle>` children) of each lucide
 * icon, keyed by the component reference. Copied verbatim from each
 * `lucide-react` component's rendered output; the outer `<svg>` wrapper is
 * authored in {@link lucideIconToSvgString}. Drift-pinned by `lucide-svg.test.ts`.
 */
const ICON_BODIES = new Map<LucideIcon, string>([
  [
    FolderOpen,
    '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  ],
  [
    FileText,
    '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  ],
  [
    Image,
    '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  ],
  [
    ImageIcon,
    '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  ],
  [
    File,
    '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>',
  ],
  [
    Film,
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  ],
  [
    Volume2,
    '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>',
  ],
  [X, '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'],
]);

/** Per-icon cache of the assembled SVG string — each icon's markup is constant,
 *  so build it once per `LucideIcon` component. */
const SVG_CACHE = new Map<LucideIcon, string>();

/**
 * Render a (curated) lucide icon to a self-contained inline-SVG string sized to
 * match the top-row chip's `size-3` icon (0.75rem) and stroked with
 * `currentColor`, so the host's `color` (muted-foreground → foreground on hover)
 * drives the glyph. Result memoized per icon component.
 *
 * The wrapper mirrors lucide's own attributes (`viewBox="0 0 24 24"`,
 * `stroke-width="2"`, round caps/joins, `fill="none"`) so the rendered glyph is
 * identical to the React `<Icon className="size-3" />` the top-row chip paints;
 * `width`/`height` are pinned to `0.75rem` to match `size-3`. Unmapped icons fall
 * back to `FileText`'s body.
 */
export function lucideIconToSvgString(icon: LucideIcon): string {
  const cached = SVG_CACHE.get(icon);
  if (cached !== undefined) return cached;
  const body = ICON_BODIES.get(icon) ?? (ICON_BODIES.get(FileText) as string);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="0.75rem" height="0.75rem"' +
    ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
    ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  SVG_CACHE.set(icon, svg);
  return svg;
}
