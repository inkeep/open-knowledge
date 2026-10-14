const GRAPHEME_SEGMENTER = (() => {
  const Ctor = (globalThis as { Intl: { Segmenter?: typeof Intl.Segmenter } }).Intl.Segmenter;
  return Ctor ? new Ctor(undefined, { granularity: 'grapheme' }) : null;
})();

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function boundaryAtOrBefore(text: string, index: number): number {
  if (GRAPHEME_SEGMENTER) {
    const segment = GRAPHEME_SEGMENTER.segment(text).containing(index);
    return segment === undefined ? index : segment.index;
  }
  return isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1))
    ? index - 1
    : index;
}

function boundaryAtOrAfter(text: string, index: number): number {
  if (GRAPHEME_SEGMENTER) {
    const segment = GRAPHEME_SEGMENTER.segment(text).containing(index);
    if (segment === undefined || segment.index === index) return index;
    return segment.index + segment.segment.length;
  }
  return isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1))
    ? index + 1
    : index;
}

export function graphemePrefix(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 0) return '';
  return text.slice(0, boundaryAtOrBefore(text, maxLength));
}

export function graphemeSuffix(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 0) return '';
  return text.slice(boundaryAtOrAfter(text, text.length - maxLength));
}
