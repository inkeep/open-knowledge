
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

export const TYPE_TO_TONE: Record<string, { color: string; bg: string }> = {
  note: { color: '#0969da', bg: '#dbeafe' },
  tip: { color: '#1f883d', bg: '#dcfce7' },
  important: { color: '#8250df', bg: '#f3e8ff' },
  warning: { color: '#9a6700', bg: '#fef3c7' },
  caution: { color: '#cf222e', bg: '#fee2e2' },
};

export function toneForType(type: string): { color: string; bg: string } {
  return Object.hasOwn(TYPE_TO_TONE, type) ? TYPE_TO_TONE[type] : TYPE_TO_TONE.note;
}

export const PALETTE_DESCRIPTOR_NAMES = [
  'Callout',
  'img',
  'video',
  'audio',
  'Accordion',
  'GFMCallout',
  'CommonMarkImage',
  'HtmlDetailsAccordion',
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

export function paletteUrlReason(rawUrl: string): UrlPortabilityReason | null {
  const result = classifyUrlPortability(rawUrl);
  return result.portable ? null : result.reason;
}

function buildPaletteSourceFallback(sourceText: string): Element {
  const pre = document.createElement('pre');
  pre.className = 'mdx-component';
  const code = document.createElement('code');
  code.textContent = sourceText;
  pre.appendChild(code);
  return pre;
}

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
