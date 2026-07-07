/**
 * Source-fallback shape for top-level `jsxComponent` nodes whose live
 * React render is non-portable across destinations. Block KaTeX (Math)
 * and mermaid SVG (MermaidFence) paste as garbage in plain-text apps and
 * as broken styling in some rich apps; their markdown source bytes do
 * not. The walker swaps the live-DOM clone path entirely and emits a
 * `<pre class="mdx-component"><code>{markdown source}</code></pre>` block
 * carrying readable LaTeX / mermaid source instead.
 *
 * Constrained to top-level block nodes by the walker's `parent !==
 * view.state.doc` gate. Inline atoms (`mathInline` inside paragraphs)
 * use a separate `applyNonPortableInlineAtomReplacement` post-clone
 * pass in `clipboard-walker.ts` — this helper is not reachable for
 * them.
 *
 * Independent from the URL-portability source-fallback (img/video/audio
 * with non-portable URLs), the Activity-hidden palette (mounted-DOM-
 * unavailable case), and the markdown-tier fallback (walker not
 * available at all). Those paths exist for orthogonal reasons; this one
 * fires when the walker IS available and the live DOM IS mounted, but
 * the rendered shape itself doesn't survive cross-app paste.
 */

import type { Node as PmNode } from '@tiptap/pm/model';

type SourceFallbackForm = { source: string };

/**
 * Build the markdown-source string for a node whose live render is
 * non-portable. Returns `null` when the node isn't a recognised
 * non-portable type — caller falls through to the live-DOM clone path.
 * Exported so the structural-classification logic can be tested
 * without a DOM (bun-test has no `document`); DOM-shape behaviour is
 * covered by Playwright E2E.
 */
export function sourceFallbackFormFor(node: PmNode): SourceFallbackForm | null {
  // Top-level jsxComponent dispatch by componentName. Mirrors the gate
  // in `clipboard-walker-fallback-palette.ts:paletteFor` so the two
  // paths stay aligned.
  if (node.type.name !== 'jsxComponent') return null;
  const componentName = node.attrs.componentName as string | undefined;
  const props = (node.attrs.props as Record<string, unknown> | undefined) ?? {};

  switch (componentName) {
    case 'Math': {
      // `$$\nformula\n$$` newlines are load-bearing: a single-line
      // `$$x$$` mid-paragraph parses as inline math, breaking the
      // block-vs-inline distinction we want to preserve through the
      // round-trip.
      const formula = typeof props.formula === 'string' ? props.formula : '';
      return { source: `$$\n${formula}\n$$` };
    }
    case 'MermaidFence': {
      // Fenced-code form with `mermaid` info string — paste-back-
      // compatible with GitHub / GitLab / Obsidian markdown that
      // recognises the language tag.
      const chart = typeof props.chart === 'string' ? props.chart : '';
      return { source: `\`\`\`mermaid\n${chart}\n\`\`\`` };
    }
    default:
      return null;
  }
}

/**
 * Build the source-fallback DOM Element for a node whose live render is
 * non-portable. Returns `null` when the node isn't recognised — caller
 * falls through to the live-DOM clone path.
 *
 * `doc` is threaded so the caller controls which Document the elements
 * are bound to (the walker uses `document` from the host page; tests
 * use a fresh `Document` instance).
 */
export function nonPortableRenderSourceFallback(node: PmNode, doc: Document): Element | null {
  const form = sourceFallbackFormFor(node);
  if (!form) return null;

  const pre = doc.createElement('pre');
  pre.className = 'mdx-component';
  const code = doc.createElement('code');
  code.textContent = form.source;
  pre.appendChild(code);
  return pre;
}
