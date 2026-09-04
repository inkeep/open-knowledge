import { extname } from 'node:path';
import { SANDBOXED_HTML_CSP, SANDBOXED_HTML_EXTENSIONS } from '@inkeep/open-knowledge-core';
import { mimes } from 'mrmime';

export interface AssetDisposition {
  disposition: 'inline' | 'attachment';
  csp: string | null;
  sandboxedHtml: boolean;
}

export function classifyAssetDisposition(
  ext: string,
  inlineExtensions: ReadonlySet<string>,
): AssetDisposition {
  const sandboxedHtml = SANDBOXED_HTML_EXTENSIONS.has(ext);
  const disposition = inlineExtensions.has(ext) || sandboxedHtml ? 'inline' : 'attachment';
  const csp =
    ext === 'svg'
      ? "sandbox; default-src 'none'; style-src 'unsafe-inline'"
      : sandboxedHtml
        ? SANDBOXED_HTML_CSP
        : null;
  return { disposition, csp, sandboxedHtml };
}

Object.assign(mimes, {
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  flac: 'audio/flac',
  toml: 'application/toml',
  lock: 'text/plain',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  rar: 'application/vnd.rar',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  pages: 'application/vnd.apple.pages',
  numbers: 'application/vnd.apple.numbers',
  key: 'application/vnd.apple.keynote',
  mobi: 'application/x-mobipocket-ebook',
});

export function assetContentTypeForPath(path: string): string | null {
  return mimes[extname(path).slice(1).toLowerCase()] ?? null;
}
