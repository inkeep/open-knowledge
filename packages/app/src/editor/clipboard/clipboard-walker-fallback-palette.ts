/**
 * Per-descriptor static palette for the live-DOM clipboard walker.
 *
 * Used only when `view.nodeDOM(pos)` returns `null` — the slice originates
 * inside an `<Activity mode="hidden">` subtree whose live DOM was unmounted.
 * The walker's primary path captures whatever React rendered + whatever CSS
 * resolved; this fallback emits a hand-built palette for each canonical /
 * compat descriptor so the Activity-hidden case isn't silently empty.
 *
 * Output shape per descriptor mirrors what the React render produces (post
 * walker filter), so cross-app destinations see the same shape regardless of
 * whether the live DOM was available.
 */

import type { Node as PmNode } from '@tiptap/pm/model';
import {
  classifyUrlPortability,
  isSafeWalkerUrl,
  type UrlPortabilityReason,
} from './clipboard-sanitize.ts';
import {
  classifyError,
  logWalkerUrlClassifierFailed,
  logWalkerUrlSourceEmitted,
  type WalkerUrlSourceTag,
} from './instrument.ts';
import { nonPortableRenderSourceFallback } from './non-portable-render-source-fallback.ts';

/**
 * Callout type → cross-app tone mapping. Exported so the registry-coverage
 * test in `clipboard-walker-fallback-palette.test.ts` can pin the supported
 * type set without invoking the DOM-creating palette functions (bun-test
 * has no DOM; full palette DOM behavior is covered in Playwright E2E).
 */
export const TYPE_TO_TONE: Record<string, { color: string; bg: string }> = {
  note: { color: '#0969da', bg: '#dbeafe' },
  tip: { color: '#1f883d', bg: '#dcfce7' },
  important: { color: '#8250df', bg: '#f3e8ff' },
  warning: { color: '#9a6700', bg: '#fef3c7' },
  caution: { color: '#cf222e', bg: '#fee2e2' },
};

/**
 * Lookup the tone for a callout `type` value, with prototype-pollution
 * guard via `Object.hasOwn`. Falls back to the `note` tone when the type
 * is unknown OR when it resolves to an Object.prototype method via the
 * prototype chain (`__proto__`, `constructor`, `toString`, `hasOwnProperty`).
 *
 * Mirrors the same guard pattern used in `Callout.tsx` and `Accordion.tsx`
 * (co-editor DoS vector — without the guard, an adversarial document with
 * `type="__proto__"` would yield `border-left: 3px solid undefined`).
 */
export function toneForType(type: string): { color: string; bg: string } {
  return Object.hasOwn(TYPE_TO_TONE, type) ? TYPE_TO_TONE[type] : TYPE_TO_TONE.note;
}

/**
 * The descriptor names the palette switch covers. Exported so the
 * registry-coverage test can mechanically assert that every v1 canonical /
 * compat descriptor has a palette entry — adding a descriptor to the
 * registry without adding a case here would make the test fail loudly
 * rather than silently produce `null` in Activity-hidden cross-app paste.
 */
export const PALETTE_DESCRIPTOR_NAMES = [
  // Canonical 5-pack
  'Callout',
  'img',
  'video',
  'audio',
  'Accordion',
  // Compat 3-pack
  'GFMCallout',
  'CommonMarkImage',
  'HtmlDetailsAccordion',
  // Non-portable-render descriptors — palette shape MUST match the
  // walker's primary-path source-fallback (see
  // `non-portable-render-source-fallback.ts`) so destinations see the
  // same `<pre class="mdx-component">` shape regardless of whether the
  // slice was Activity-mounted or not.
  'Math',
  'MermaidFence',
] as const;

function calloutPalette(props: Record<string, unknown>): Element {
  const type = typeof props.type === 'string' ? props.type : 'note';
  const tone = toneForType(type);
  const aside = document.createElement('aside');
  aside.setAttribute('class', `callout callout-${type}`);
  aside.setAttribute('data-callout-type', type);
  aside.setAttribute(
    'style',
    `border-left: 3px solid ${tone.color}; background-color: ${tone.bg}; padding: 0.5rem 0.75rem; border-radius: 0.25rem;`,
  );
  if (typeof props.title === 'string' && props.title) {
    const title = document.createElement('strong');
    title.textContent = props.title;
    aside.appendChild(title);
  }
  return aside;
}

function accordionPalette(props: Record<string, unknown>): Element {
  const details = document.createElement('details');
  if (props.defaultOpen === true) details.setAttribute('open', '');
  details.setAttribute('class', 'accordion');
  const summary = document.createElement('summary');
  summary.textContent = typeof props.title === 'string' ? props.title : 'Accordion';
  details.appendChild(summary);
  return details;
}

/**
 * Classify a URL for a palette emission decision: returns `null` when the
 * URL is portable (palette emits its native HTML primitive — pre-classifier
 * behavior) and the bounded reason bucket when non-portable (palette swaps
 * to a `<pre class="mdx-component"><code>` source-fallback shape).
 *
 * Single source of truth via `classifyUrlPortability` — palette and walker
 * consume the same classifier so they emit byte-identical `reason` values
 * for the same URL.
 *
 * May throw on inputs that survive the relative-URL short-circuit but
 * fail `new URL()` parsing (`':::'`, `'http://'`); palette callers wrap
 * this in try/catch and emit `clipboard-walker-url-classifier-failed`
 * telemetry on throw, falling through to today's native-primitive
 * emission.
 */
export function paletteUrlReason(rawUrl: string): UrlPortabilityReason | null {
  const result = classifyUrlPortability(rawUrl);
  return result.portable ? null : result.reason;
}

/**
 * Build a `<pre class="mdx-component"><code>{markdown}</code></pre>`
 * source-fallback element. DOM-construction with `code.textContent =
 * markdown` produces a textNode child rather than parsed HTML, so the
 * bytes that matter for HTML injection (`<` / `>` / `&`) are auto-escaped
 * on serialization, and quote characters (`"` / `'`) survive verbatim
 * because they're not special inside textNode content. The markdown
 * source lands in the destination clipboard without HTML-injection risk.
 * Mirrors the same safety pattern at
 * `clipboard-walker.ts:createSourceFallbackElement` (no manual escapeHtml
 * required on either path).
 *
 * Palette is invoked at top-level slice nodes only (the live walker
 * defers via `paletteFor(node)` when `view.nodeDOM(pos) === null` — pos
 * iterates top-level children of the slice fragment), so block emission
 * is always safe; the paragraph-content shape rule does not apply here.
 */
function buildPaletteSourceFallback(sourceText: string): Element {
  const pre = document.createElement('pre');
  pre.className = 'mdx-component';
  const code = document.createElement('code');
  code.textContent = sourceText;
  pre.appendChild(code);
  return pre;
}

/**
 * Single swap-or-passthrough decision shared by image / video / audio
 * palettes. Encapsulates the full failure contract:
 *   - portable URL → return null (caller emits native primitive)
 *   - non-portable URL → emit `clipboard-walker-url-source-emitted` and
 *     return the source-fallback element (caller returns it directly)
 *   - classifier throws → emit `clipboard-walker-url-classifier-failed`
 *     with `phase: 'classifier-throw'` and return null (caller falls
 *     through to today's native primitive with the unverified URL still
 *     gated by `isSafeWalkerUrl`)
 *   - empty `src` → return null (no URL to classify)
 *
 * `tag` segments the telemetry along the URL-classifier scope so palette
 * and walker emissions land in the same dashboard buckets. `src` is
 * narrowed to `string` at the call site (typeof guard before invocation),
 * so the swap helper trusts the type rather than re-narrowing. `sourceText`
 * is the bytes that land inside the `<pre><code>` source-fallback element
 * — markdown for `<img>` (`![alt](src)`), HTML stubs for `<video>` /
 * `<audio>` (no native CommonMark form, so the source-shape that
 * destinations re-parse most-faithfully is the HTML).
 */
function maybeSwapPaletteUrl(
  src: string,
  tag: WalkerUrlSourceTag,
  sourceText: string,
): Element | null {
  if (src === '') return null;
  let reason: UrlPortabilityReason | null;
  try {
    reason = paletteUrlReason(src);
  } catch (err) {
    const errorClass = classifyError(err);
    logWalkerUrlClassifierFailed({
      view: 'wysiwyg',
      tag,
      phase: 'classifier-throw',
      ...(errorClass !== undefined ? { errorClass } : {}),
    });
    return null;
  }
  if (reason === null) return null;
  logWalkerUrlSourceEmitted({
    view: 'wysiwyg',
    tag,
    class: 'mdx-component',
    reason,
  });
  return buildPaletteSourceFallback(sourceText);
}

// PM node attrs carry unsanitized storage-layer values per the storage
// contract ("storage never sanitizes; render-time layers do"). The live
// walker path runs URL-scheme sanitization in `walkPair`, but the palette
// path is appended directly without going through `walkPair` — so the
// allowlist filter must run here too. An adversarial document containing
// `<img src="data:text/html,..." />` MDX would otherwise emit that
// dangerous scheme verbatim into the cross-app clipboard payload when the
// source slice is Activity-hidden.
function imagePalette(props: Record<string, unknown>): Element {
  const alt = typeof props.alt === 'string' ? props.alt : '';
  const src = typeof props.src === 'string' ? props.src : '';
  const swap = maybeSwapPaletteUrl(src, 'img', `![${alt}](${src})`);
  if (swap !== null) return swap;
  const img = document.createElement('img');
  if (src && isSafeWalkerUrl(src)) img.setAttribute('src', src);
  if (typeof props.alt === 'string') img.setAttribute('alt', props.alt);
  return img;
}

/**
 * Build the source-fallback display text for a media element with `src`.
 * Uses DOM `setAttribute` + `outerHTML` so a `src` containing `"` is
 * attribute-escaped correctly — string interpolation would garble the
 * source-fallback display (the bytes go through `textContent` in the
 * pre/span wrapper so this is fidelity, not security).
 */
function buildMediaSourceText(tag: 'video' | 'audio', src: string): string {
  const el = document.createElement(tag);
  el.setAttribute('src', src);
  return el.outerHTML;
}

function videoPalette(props: Record<string, unknown>): Element {
  const src = typeof props.src === 'string' ? props.src : '';
  const swap = maybeSwapPaletteUrl(src, 'video', buildMediaSourceText('video', src));
  if (swap !== null) return swap;
  const video = document.createElement('video');
  if (src && isSafeWalkerUrl(src)) video.setAttribute('src', src);
  // Mirror the descriptor's `controls.defaultValue: true` so cross-app
  // destinations preserving the element verbatim render a usable player.
  // The live walker captures `controls` automatically via cloneNode; this
  // path fires only for Activity-hidden subtrees.
  if (props.controls !== false) video.setAttribute('controls', '');
  return video;
}

function audioPalette(props: Record<string, unknown>): Element {
  const src = typeof props.src === 'string' ? props.src : '';
  const swap = maybeSwapPaletteUrl(src, 'audio', buildMediaSourceText('audio', src));
  if (swap !== null) return swap;
  const audio = document.createElement('audio');
  if (src && isSafeWalkerUrl(src)) audio.setAttribute('src', src);
  if (props.controls !== false) audio.setAttribute('controls', '');
  return audio;
}

/**
 * Return a palette element for a PM node, or `null` when the node type isn't
 * a registered descriptor we have a palette for. The walker appends `null`
 * results as no-ops.
 */
export function paletteFor(node: PmNode): Element | null {
  if (node.type.name !== 'jsxComponent') return null;
  const componentName = node.attrs.componentName as string | undefined;
  const props = (node.attrs.props as Record<string, unknown>) ?? {};
  switch (componentName) {
    case 'Callout':
    case 'GFMCallout':
      return calloutPalette(props);
    case 'Accordion':
    case 'HtmlDetailsAccordion':
      return accordionPalette(props);
    case 'img':
    case 'CommonMarkImage':
      return imagePalette(props);
    case 'video':
      return videoPalette(props);
    case 'audio':
      return audioPalette(props);
    case 'Math':
    case 'MermaidFence':
      return nonPortableRenderSourceFallback(node, document);
    default:
      return null;
  }
}
