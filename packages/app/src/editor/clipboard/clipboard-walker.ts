import { normalizeNullableString, wikiLinkHref } from '@inkeep/open-knowledge-core';
import type { Node as PmNode, Slice } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import {
  classifyUrlPortability,
  convertCssColors,
  isDangerousEventHandlerAttr,
  isSafeWalkerUrl,
  isSrcsetSafe,
  OPT_OUT_ATTR,
  sanitizeEmbeddedUrlValue,
  sanitizeStyleAttrValue,
  URL_BEARING_TEXT_ATTRS,
  URL_SCHEME_ATTRS,
  type UrlPortabilityReason,
} from './clipboard-sanitize.ts';
import { paletteFor } from './clipboard-walker-fallback-palette.ts';
import {
  classifyError,
  logNonPortableRenderSourceEmitted,
  logUnmappedLucideIcon,
  logWalkerFallback,
  logWalkerUrlBlocked,
  logWalkerUrlClassifierFailed,
  logWalkerUrlSourceEmitted,
  type WalkerUrlSourceClass,
  type WalkerUrlSourceTag,
} from './instrument.ts';
import { nonPortableRenderSourceFallback } from './non-portable-render-source-fallback.ts';

export const STYLE_ALLOWLIST = [
  'color',
  'background-color',
  'background-image',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-width',
  'border-style',
  'border-radius',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-align',
  'line-height',
  'list-style',
  'list-style-type',
  'list-style-position',
  'vertical-align',
  'white-space',
] as const;

export const CLASS_BLOCKLIST: ReadonlySet<string> = new Set([
  'jsx-component-wrapper',
  'selectedCell',
  'is-empty',
  'ProseMirror-selectednode',
  'ProseMirror-trailingBreak',
]);

export const ATTR_BLOCKLIST: ReadonlySet<string> = new Set([
  'data-selected',
  'data-has-child-selected',
  'data-dragging',
  'data-range-selected',
  'contenteditable',
  'data-pm-slice',
]);

export interface ComputedStyleLike {
  getPropertyValue(prop: string): string;
}

export type SerializeResult =
  | { kind: 'ok'; markdown: string }
  | { kind: 'no-correspondence' }
  | { kind: 'failed'; errorClass: string | undefined };

export interface WalkerEnv {
  getComputedStyle: (el: Element) => ComputedStyleLike;
  serializeElementMarkdown?: (live: Element) => SerializeResult;
}

const DEFAULT_ENV: WalkerEnv = {
  getComputedStyle: (el) => window.getComputedStyle(el),
};

export function buildInlineStyleFrom(
  computed: ComputedStyleLike,
  allowlist: readonly string[] = STYLE_ALLOWLIST,
): string {
  let style = '';
  for (const prop of allowlist) {
    const value = computed.getPropertyValue(prop);
    if (!value) continue;
    if (value === 'initial' || value === 'normal') continue;
    style += `${prop}: ${convertCssColors(value)}; `;
  }
  return style.trim();
}

export function stripBlocklistedClasses(
  className: string,
  blocklist: ReadonlySet<string> = CLASS_BLOCKLIST,
): string | null {
  const kept = className
    .split(/\s+/)
    .filter((c) => c.length > 0 && !blocklist.has(c))
    .join(' ');
  return kept || null;
}

export function selectionPartiallyCoversTopLevelNode(
  doc: PmNode,
  from: number,
  to: number,
): boolean {
  let partial = false;
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (parent !== doc) return false;
    if (from > pos || to < pos + node.nodeSize) partial = true;
    return false;
  });
  return partial;
}

export function walkLiveDomToInlineStyledFragment(
  _slice: Slice,
  view: EditorView,
  env: WalkerEnv = DEFAULT_ENV,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const { from, to } = view.state.selection;
  if (from === to) return fragment;

  if (selectionPartiallyCoversTopLevelNode(view.state.doc, from, to)) return fragment;

  view.state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (parent !== view.state.doc) return false;

    const liveDom = view.nodeDOM(pos);
    if (liveDom == null) {
      logWalkerFallback({ descriptor: node.type.name, view: 'wysiwyg' });
      const fallback = paletteFor(node);
      if (fallback) fragment.appendChild(fallback);
      return false;
    }
    if (!(liveDom instanceof Element)) return false;
    if (liveDom.getAttribute(OPT_OUT_ATTR) === 'true') return false;

    const sourceFallback = nonPortableRenderSourceFallback(node, document);
    if (sourceFallback !== null) {
      fragment.appendChild(sourceFallback);
      logNonPortableRenderSourceEmitted({
        view: 'wysiwyg',
        descriptor: (node.attrs.componentName as string | undefined) ?? node.type.name,
      });
      return false;
    }

    fragment.appendChild(cloneAndStyle(liveDom, env));
    return false;
  });

  return fragment;
}

function cloneAndStyle(live: Element, env: WalkerEnv): Element {
  const clone = live.cloneNode(true) as Element;
  walkPair(live, clone, env);
  applyWikiLinkTransform(clone);
  applyNonPortableInlineAtomReplacement(clone);
  applyUrlClassifierPostPass(live, clone, env);
  replaceLucideIconsWithGlyphs(clone);
  return clone;
}

function applyNonPortableInlineAtomReplacement(clone: Element): void {
  const mathMatches = Array.from(clone.querySelectorAll('[data-component-type="math-inline"]'));
  for (const el of mathMatches) {
    if (!el.parentNode) continue;
    const formula = el.getAttribute('data-formula') ?? '';
    const span = clone.ownerDocument.createElement('span');
    span.className = 'mdx-inline';
    span.textContent = `$$${formula}$$`;
    el.replaceWith(span);
    logNonPortableRenderSourceEmitted({ view: 'wysiwyg', descriptor: 'mathInline' });
  }

  const embedMatches = Array.from(clone.querySelectorAll('a[data-wiki-embed]'));
  for (const el of embedMatches) {
    if (!el.parentNode) continue;
    const target = el.getAttribute('data-target') ?? '';
    if (!target) continue; // sanity guard — wiki-link parser rejects empty targets upstream
    const alias = el.getAttribute('data-alias') || null;
    const anchor = el.getAttribute('data-anchor') || null;
    const span = clone.ownerDocument.createElement('span');
    span.className = 'mdx-inline';
    span.textContent = buildWikiEmbedMarkdownSource(target, anchor, alias);
    el.replaceWith(span);
    logNonPortableRenderSourceEmitted({ view: 'wysiwyg', descriptor: 'wikiLinkEmbed' });
  }
}

export function buildWikiEmbedMarkdownSource(
  target: string,
  anchor: string | null,
  alias: string | null,
): string {
  let body = target;
  if (anchor) body += `#${anchor}`;
  if (alias) body += `|${alias}`;
  return `![[${body}]]`;
}

export const LUCIDE_GLYPH_MAP: Record<string, string> = {
  'lucide-chevron-right': '›', // SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
  'lucide-chevron-down': '⌄', // DOWN ARROWHEAD — collapsible-open Callout (Callout.tsx switched ChevronRight → ChevronDown for the open state)
  'lucide-info': 'ℹ', // INFORMATION SOURCE
  'lucide-lightbulb': '\u{1F4A1}', // ELECTRIC LIGHT BULB (renders monochrome on legacy)
  'lucide-message-square-warning': '❗', // HEAVY EXCLAMATION MARK SYMBOL
  'lucide-alert-triangle': '⚠', // WARNING SIGN
  'lucide-alert-octagon': '⛔', // NO ENTRY (octagonal stop semantics)
};

const LUCIDE_CLASS_RE = /(?:^|\s)(lucide-[a-z0-9-]+)(?:\s|$)/;

export function glyphForLucide(className: string): string | null {
  const match = className.match(LUCIDE_CLASS_RE);
  if (!match) return null;
  return LUCIDE_GLYPH_MAP[match[1]] ?? null;
}

function replaceLucideIconsWithGlyphs(root: Element): void {
  const svgs = root.querySelectorAll('svg');
  for (const svg of Array.from(svgs)) {
    const className = svg.getAttribute('class') ?? '';
    const lucideMatch = className.match(LUCIDE_CLASS_RE);
    if (!lucideMatch) continue;
    const lucideClass = lucideMatch[1];
    const glyph = LUCIDE_GLYPH_MAP[lucideClass];
    if (!glyph) {
      logUnmappedLucideIcon({ lucideClass, view: 'wysiwyg' });
      continue;
    }
    const span = svg.ownerDocument.createElement('span');
    span.setAttribute('aria-hidden', 'true');
    span.textContent = glyph;
    svg.replaceWith(span);
  }
}

function walkPair(live: Element, clone: Element, env: WalkerEnv): void {
  const styleStr = buildInlineStyleFrom(env.getComputedStyle(live));
  if (styleStr) {
    const existing = clone.getAttribute('style');
    clone.setAttribute('style', existing ? `${existing}; ${styleStr}` : styleStr);
  }

  const className = clone.getAttribute('class');
  if (className !== null) {
    const filtered = stripBlocklistedClasses(className);
    if (filtered) clone.setAttribute('class', filtered);
    else clone.removeAttribute('class');
  }

  for (const attr of Array.from(clone.attributes)) {
    if (ATTR_BLOCKLIST.has(attr.name)) {
      clone.removeAttribute(attr.name);
      continue;
    }
    if (isDangerousEventHandlerAttr(attr.name)) {
      clone.removeAttribute(attr.name);
      logWalkerUrlBlocked({ attr: 'on*', reason: 'event-handler', view: 'wysiwyg' });
      continue;
    }
    if (attr.name === 'style') {
      const safeStyle = sanitizeStyleAttrValue(attr.value);
      if (safeStyle === '') {
        clone.removeAttribute('style');
        logWalkerUrlBlocked({
          attr: 'style',
          reason: 'unsafe-url-or-expression',
          view: 'wysiwyg',
        });
      } else if (safeStyle !== attr.value) {
        clone.setAttribute('style', safeStyle);
      }
      continue;
    }
    if (URL_SCHEME_ATTRS.has(attr.name)) {
      const valueIsSafe =
        attr.name === 'srcset' ? isSrcsetSafe(attr.value) : isSafeWalkerUrl(attr.value);
      if (!valueIsSafe) {
        clone.removeAttribute(attr.name);
        logWalkerUrlBlocked({
          attr: attr.name,
          reason: attr.name === 'srcset' ? 'srcset-candidate' : 'scheme',
          view: 'wysiwyg',
        });
      }
      continue;
    }
    if (URL_BEARING_TEXT_ATTRS.has(attr.name)) {
      const sanitized = sanitizeEmbeddedUrlValue(attr.value, { reportNoChange: true });
      if (sanitized !== null) {
        clone.setAttribute(attr.name, sanitized);
        logWalkerUrlBlocked({ attr: attr.name, reason: 'embedded-url', view: 'wysiwyg' });
      }
    }
  }

  const liveKids = Array.from(live.children);
  const cloneKids = Array.from(clone.children);
  const len = Math.min(liveKids.length, cloneKids.length);
  for (let i = 0; i < len; i++) {
    const liveKid = liveKids[i];
    const cloneKid = cloneKids[i];
    if (liveKid.getAttribute(OPT_OUT_ATTR) === 'true') {
      cloneKid.remove();
      continue;
    }
    walkPair(liveKid, cloneKid, env);
  }
}

export function applyWikiLinkTransform(root: Element): void {
  const spans = root.querySelectorAll('span[data-wiki-link]');
  for (const span of Array.from(spans)) {
    const target = span.getAttribute('data-target') ?? '';
    if (!target) continue;
    const anchor = normalizeNullableString(span.getAttribute('data-anchor'));
    const alias = normalizeNullableString(span.getAttribute('data-alias'));
    const href = wikiLinkHref(target, anchor);
    const a = span.ownerDocument.createElement('a');
    a.setAttribute('class', 'wiki-link');
    a.setAttribute('href', href);
    a.setAttribute('data-target', target);
    a.setAttribute('data-anchor', anchor ?? '');
    a.setAttribute('data-alias', alias ?? '');
    a.textContent = span.textContent ?? '';
    span.replaceWith(a);
  }
}

type WalkerUrlLeafTag = Exclude<WalkerUrlSourceTag, 'picture'>;

const URL_LEAF_TAGS: ReadonlySet<WalkerUrlLeafTag> = new Set<WalkerUrlLeafTag>([
  'img',
  'video',
  'audio',
  'source',
  'a',
]);

function isUrlLeafTag(tag: string): tag is WalkerUrlLeafTag {
  return (URL_LEAF_TAGS as ReadonlySet<string>).has(tag);
}

export function chooseEmissionClass(clone: Element): WalkerUrlSourceClass {
  return clone.closest('p') !== null ? 'mdx-inline' : 'mdx-component';
}

function createSourceFallbackElement(
  doc: Document,
  klass: WalkerUrlSourceClass,
  markdown: string,
): Element {
  if (klass === 'mdx-component') {
    const pre = doc.createElement('pre');
    pre.className = 'mdx-component';
    const code = doc.createElement('code');
    code.textContent = markdown;
    pre.appendChild(code);
    return pre;
  }
  const span = doc.createElement('span');
  span.className = 'mdx-inline';
  span.textContent = markdown;
  return span;
}

function classifyUrlAttr(rawUrl: string): UrlPortabilityReason | null {
  const result = classifyUrlPortability(rawUrl);
  return result.portable ? null : result.reason;
}

function classifySrcset(srcset: string): UrlPortabilityReason | null {
  for (const raw of srcset.split(',')) {
    const candidate = raw.trim();
    if (candidate === '') continue;
    const url = candidate.split(/\s+/)[0] ?? '';
    const reason = classifyUrlAttr(url);
    if (reason !== null) return reason;
  }
  return null;
}

function classifyLeafElement(clone: Element, tag: WalkerUrlLeafTag): UrlPortabilityReason | null {
  switch (tag) {
    case 'img':
    case 'source': {
      const src = clone.getAttribute('src');
      if (src !== null) {
        const reason = classifyUrlAttr(src);
        if (reason !== null) return reason;
      }
      const srcset = clone.getAttribute('srcset');
      if (srcset !== null) {
        const reason = classifySrcset(srcset);
        if (reason !== null) return reason;
      }
      return null;
    }
    case 'video':
    case 'audio': {
      const src = clone.getAttribute('src');
      if (src !== null) return classifyUrlAttr(src);
      return null;
    }
    case 'a': {
      const href = clone.getAttribute('href');
      if (href !== null) return classifyUrlAttr(href);
      return null;
    }
    default: {
      const _exhaust: never = tag;
      void _exhaust;
      return null;
    }
  }
}

function classifyPictureDescendants(clone: Element): UrlPortabilityReason | null {
  const candidates = clone.querySelectorAll('source, img');
  for (const c of Array.from(candidates)) {
    const tag = c.tagName.toLowerCase();
    if (!isUrlLeafTag(tag)) continue;
    const reason = classifyLeafElement(c, tag);
    if (reason !== null) return reason;
  }
  return null;
}

function maybeSwapLeaf(
  env: WalkerEnv,
  live: Element,
  clone: Element,
  tag: WalkerUrlLeafTag,
): boolean {
  let reason: UrlPortabilityReason | null;
  try {
    reason = classifyLeafElement(clone, tag);
  } catch (err) {
    const errorClass = classifyError(err);
    logWalkerUrlClassifierFailed({
      view: 'wysiwyg',
      tag,
      phase: 'classifier-throw',
      ...(errorClass !== undefined ? { errorClass } : {}),
    });
    return false;
  }
  if (reason === null) return false;
  return performSwap(env, live, clone, tag, reason);
}

function maybeSwapPicture(env: WalkerEnv, live: Element, clone: Element): boolean {
  let reason: UrlPortabilityReason | null;
  try {
    reason = classifyPictureDescendants(clone);
  } catch (err) {
    const errorClass = classifyError(err);
    logWalkerUrlClassifierFailed({
      view: 'wysiwyg',
      tag: 'picture',
      phase: 'classifier-throw',
      ...(errorClass !== undefined ? { errorClass } : {}),
    });
    return false;
  }
  if (reason === null) return false;
  return performSwap(env, live, clone, 'picture', reason);
}

function performSwap(
  env: WalkerEnv,
  live: Element,
  clone: Element,
  tag: WalkerUrlSourceTag,
  reason: UrlPortabilityReason,
): boolean {
  const result: SerializeResult = env.serializeElementMarkdown
    ? env.serializeElementMarkdown(live)
    : { kind: 'no-correspondence' };
  switch (result.kind) {
    case 'no-correspondence': {
      logWalkerUrlClassifierFailed({ view: 'wysiwyg', tag, phase: 'serializer-null' });
      return false;
    }
    case 'failed': {
      const errorClass = result.errorClass;
      logWalkerUrlClassifierFailed({
        view: 'wysiwyg',
        tag,
        phase: 'serializer-throw',
        ...(errorClass !== undefined ? { errorClass } : {}),
      });
      return false;
    }
    case 'ok': {
      const klass = chooseEmissionClass(clone);
      const replacement = createSourceFallbackElement(clone.ownerDocument, klass, result.markdown);
      clone.replaceWith(replacement);
      logWalkerUrlSourceEmitted({ view: 'wysiwyg', tag, class: klass, reason });
      return true;
    }
    default: {
      const _exhaust: never = result;
      void _exhaust;
      return false;
    }
  }
}

export function applyUrlClassifierPostPass(live: Element, clone: Element, env: WalkerEnv): void {
  if (!env.serializeElementMarkdown) return;
  const tag = clone.tagName.toLowerCase();

  if (tag === 'picture') {
    if (maybeSwapPicture(env, live, clone)) return;
  }

  if (isUrlLeafTag(tag)) {
    if (maybeSwapLeaf(env, live, clone, tag)) return;
  }

  const liveKidsAll = Array.from(live.children);
  const cloneKids = Array.from(clone.children);
  const liveKids: Element[] = [];
  for (const k of liveKidsAll) {
    if (k.getAttribute(OPT_OUT_ATTR) === 'true') continue;
    liveKids.push(k);
  }
  const len = Math.min(liveKids.length, cloneKids.length);
  for (let i = 0; i < len; i++) {
    applyUrlClassifierPostPass(liveKids[i], cloneKids[i], env);
  }
}
