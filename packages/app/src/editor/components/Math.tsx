/**
 * Math — DIY renderer for the canonical `<Math>` block descriptor.
 *
 * Renders the descriptor's prop surface: `formula` (LaTeX source string,
 * required), `id` (deep-link anchor), `language` (forward-compat hint,
 * default `'latex'`). Block-only at ship — every existing canonical
 * descriptor is block / `mdxJsxFlowElement`-shaped, and `jsxInline` is
 * intentionally render-less, so a live-rendered inline math variant
 * would set a new precedent rather than follow one.
 *
 * KaTeX JS is lazy-imported on first mount via React's `lazy()` + `Suspense`.
 * KaTeX CSS is eagerly imported from `main.tsx` (~20 KB gzipped) — keeping
 * the CSS dynamic interacts poorly with Bun's test runtime (no CSS loader)
 * and the cost is small relative to the ~270 KB JS that stays lazy. Lazy
 * KaTeX holds for the dominant cost.
 *
 * On parse error: KaTeX runs with `throwOnError: false`, so invalid LaTeX
 * renders as the source string in a tagged error span (red underline). The
 * component never crashes — co-editor DoS would otherwise be a single
 * malformed `\foo` away.
 *
 * Storage-layer fidelity contract — no sanitization at the storage layer. KaTeX HTML output is
 * render-time and uses `dangerouslySetInnerHTML`. KaTeX's renderToString
 * sanitizes its own output (strict HTML allowlist, no script execution);
 * formula source bytes round-trip through the descriptor unchanged.
 */

import { lazy, Suspense } from 'react';

interface MathProps {
  formula?: string;
  id?: string;
  language?: string;
}

/**
 * Lazy-loaded KaTeX renderer. Suspends on first mount; subsequent mounts
 * resolve synchronously from the module cache. Wrapped in a top-level
 * `lazy()` so the import only fires when a `<Math>` actually mounts —
 * documents without math pay nothing.
 */
const KatexRender = lazy(async () => {
  const { default: katex } = await import('katex');

  function KatexRenderInner(props: { formula: string; id?: string }) {
    const html = katex.renderToString(props.formula, {
      displayMode: true,
      throwOnError: false,
      // Suppress KaTeX's own console warnings for unknown commands —
      // `throwOnError: false` already routes them to inline error markup.
      strict: 'ignore',
      // Defense-in-depth: blocks HTML-injecting LaTeX commands like
      // `\href{javascript:...}`, `\htmlClass`, `\htmlStyle`. KaTeX's
      // documented default is also `false` — declaring it explicitly
      // documents the security posture and guards against future config
      // mutations that might silently flip the default.
      trust: false,
    });
    return (
      <div
        className="math math-display"
        data-component-type="math"
        id={props.id}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX renderToString returns a strict HTML-allowlist string with no script execution; this is the documented integration path.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return { default: KatexRenderInner };
});

/**
 * Renders the formula source verbatim while KaTeX loads, and as the
 * fallback for descriptors with an empty `formula` prop. Empty formulas
 * are valid (just-inserted descriptor before the author types) — show a
 * zero-width placeholder rather than crashing the lazy loader on `''`.
 */
function MathPlaceholder(props: { formula: string; id?: string }) {
  return (
    <div className="math math-placeholder" data-component-type="math" id={props.id}>
      {props.formula || ' '}
    </div>
  );
}

/**
 * DIY math view. Descriptor-dispatched via `componentMap['Math']`.
 *
 * Function name diverges from the descriptor name `Math` — biome's
 * `noShadowRestrictedNames` flags `Math` as shadowing the JS global, which
 * doesn't apply to `Image` / `Audio` / `Video` (DOM-only globals). The map
 * key stays `Math`; the implementation just gets a non-shadowing name.
 *
 * `language` is read for forward-compat but ignored at ship — KaTeX-only.
 * A future MathJax / Typst renderer would branch here.
 */
export function MathView(props: MathProps) {
  const formula = props.formula ?? '';
  if (!formula) {
    return <MathPlaceholder formula={formula} id={props.id} />;
  }
  return (
    <Suspense fallback={<MathPlaceholder formula={formula} id={props.id} />}>
      <KatexRender formula={formula} id={props.id} />
    </Suspense>
  );
}
