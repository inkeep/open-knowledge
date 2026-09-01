import {
  isExternalHref,
  JSX_SRC_REF_TAGS,
  type JsxSrcRefTagSpec,
  normalizeDocRelativeAssetUrl,
} from '@inkeep/open-knowledge-core';

const JSX_SRC_REF_TAG_AT_RE = new RegExp(
  `<(${JSX_SRC_REF_TAGS.map((tag) => tag.tagName).join('|')})\\b([^>]*)\\/>`,
  'y',
);

export interface JsxSrcRefTagMatch {
  readonly spec: JsxSrcRefTagSpec;
  readonly attrs: string;
  readonly matchLength: number;
}

export function readJsxSrcRefTagAt(line: string, idx: number): JsxSrcRefTagMatch | null {
  const close = line.indexOf('>', idx);
  if (close === -1 || line[close - 1] !== '/') return null;
  JSX_SRC_REF_TAG_AT_RE.lastIndex = idx;
  const match = JSX_SRC_REF_TAG_AT_RE.exec(line);
  if (!match) return null;
  const spec = JSX_SRC_REF_TAGS.find((tag) => tag.tagName === match[1]);
  if (!spec) return null;
  return { spec, attrs: match[2] ?? '', matchLength: match[0].length };
}

export function createJsxSrcAttrRe(attrName: string): RegExp {
  return new RegExp(`(?<=\\s)(${attrName}=)(["'])([^"']*)\\2`, 'g');
}

export function resolveJsxSrcRefTarget(
  spec: JsxSrcRefTagSpec,
  value: string,
  sourceDocName: string,
): string | null {
  if (value === '') return null;
  if (spec.resolution === 'bare-doc-name') return value;
  if (isExternalHref(value)) return null;
  const normalized = normalizeDocRelativeAssetUrl(value, sourceDocName);
  if (!normalized.startsWith('/')) return null;
  const docName = normalized.slice(1);
  return docName === '' ? null : docName;
}
