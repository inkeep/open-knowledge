/**
 * Source-fallback shape for top-level nodes whose live render is
 * non-portable across destinations. Block KaTeX (Math) and mermaid SVG
 * (MermaidFence) jsxComponents paste as garbage in plain-text apps and
 * as broken styling in some rich apps; a preview-active `html`/`xml`
 * code block renders its body inside a sandboxed `<iframe srcdoc>`
 * (several KB of security-policy, theme, and bootstrap markup plus
 * resize-handle chrome) that pastes as bloated, non-rendering junk.
 * Their markdown source bytes do not. The walker swaps the live-DOM
 * clone path entirely and emits a
 * `<pre class="mdx-component"><code>{markdown source}</code></pre>` block
 * carrying readable LaTeX / mermaid / fenced-code source instead.
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

import { selectFenceChar, widenFenceLength } from '@inkeep/open-knowledge-core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { normalizeCodeLanguage } from '../extensions/code-block-languages.ts';
import { shouldShowPreview } from '../extensions/code-block-meta.ts';

type SourceFallbackForm = { source: string };

/**
 * Build the markdown-source string for a node whose live render is
 * non-portable. Returns `null` when the node isn't a recognised
 * non-portable type — caller falls through to the live-DOM clone path.
 * Exported so the structural-classification logic can be unit-tested
 * without a DOM. The emitted-DOM shape is exercised through the real
 * walker in a jsdom integration test (covering the preview-active code
 * block); the block Math / Mermaid renders are additionally covered by
 * Playwright E2E.
 */
export function sourceFallbackFormFor(node: PmNode): SourceFallbackForm | null {
  // A preview-active `html`/`xml` code block renders a live iframe that
  // is non-portable; only such blocks need the swap. The gate reuses the
  // same `shouldShowPreview(normalizeCodeLanguage(...), meta)` predicate
  // the NodeView renders on, so the fallback fires on exactly the set of
  // blocks that mounted the iframe — no duplicated preview logic. Plain
  // code blocks return null and keep the portable clean-clone path.
  if (node.type.name === 'codeBlock') {
    const language = typeof node.attrs.language === 'string' ? node.attrs.language : '';
    const meta = typeof node.attrs.meta === 'string' ? node.attrs.meta : '';
    if (!shouldShowPreview(normalizeCodeLanguage(language), meta)) return null;
    const body = node.textContent;
    // The info-string carries the raw authored language + meta so a
    // markdown-aware destination (OK's own parser included) re-parses it
    // back to a preview-active code block. A `title="…"` meta token can
    // carry a backtick, so fence-char selection and the widen-past-closer
    // recompute route through the same core helpers the canonical code
    // serializer uses, keeping the two byte-identical.
    const info = meta ? `${language} ${meta}` : language;
    const fenceChar = selectFenceChar(info);
    const fence = fenceChar.repeat(widenFenceLength(fenceChar, body));
    return { source: `${fence}${info}\n${body}\n${fence}` };
  }

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
