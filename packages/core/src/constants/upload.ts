export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
] as const;

export const ALLOWED_VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/ogg'] as const;

export const ALLOWED_AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg'] as const;

export const ALLOWED_PDF_MIME_TYPES = ['application/pdf'] as const;

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
]);

export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv']);

export const PDF_EXTENSIONS: ReadonlySet<string> = new Set(['pdf']);

export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'flac',
  'aac',
  'opus',
]);

export const FILE_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'doc',
  'xls',
  'ppt',
  'zip',
  '7z',
  'tar',
  'gz',
  'rar',
  'csv',
  'tsv',
  'rtf',
  'json',
  'yaml',
  'yml',
  'xml',
  'txt',
  'pages',
  'numbers',
  'key',
  'odt',
  'ods',
  'odp',
  'epub',
  'mobi',
]);

export const EXECUTABLE_BLOCKLIST_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe',
  'bat',
  'cmd',
  'ps1',
  'com',
  'msi',
  'vbs',
  'js',
  'jse',
  'wsf',
  'wsh',
  'hta',
  'sh',
  'command',
  'csh',
  'ksh',
  'bash',
  'zsh',
  'fish',
  'desktop',
  'action',
  'workflow',
  'html',
  'htm',
  'svg',
  'xml',
  'mhtml',
  'svgz',
  'dmg',
  'pkg',
  'mpkg',
  'scpt',
  'applescript',
  'terminal',
  'prefpane',
  'webloc',
  'inetloc',
  'fileloc',
  'jar',
  'appimage',
  'deb',
  'rpm',
  'msix',
  'appx',
  'ipa',
  'apk',
  'pif',
  'scr',
  'lnk',
  'url',
]);

export const ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'apng',
  'heic',
  'heif',
  'tiff',
  'bmp',
  'ico',
  'pdf',
  'mp4',
  'webm',
  'mov',
  'm4v',
  'mkv',
  'avi',
  'flv',
  'wmv',
  'mpeg',
  'mpg',
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'flac',
  'aac',
  'opus',
  'zip',
  '7z',
  'tar',
  'gz',
  'rar',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'docx',
  'xlsx',
  'pptx',
  'doc',
  'xls',
  'ppt',
  'odt',
  'ods',
  'odp',
  'pages',
  'numbers',
  'key',
  'epub',
  'mobi',
  'csv',
  'tsv',
  'txt',
  'rtf',
  'json',
  'yaml',
  'yml',
  'xml',
  'toml',
  'lock',
  'gpx',
  'html',
  'htm',
]);

export const SANDBOXED_HTML_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm']);

export const SANDBOXED_HTML_CSP = "sandbox allow-scripts; connect-src 'none'";

export const INLINE_RENDERABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'apng',
  'heic',
  'heif',
  'tiff',
  'bmp',
  'ico',
  'svg',
  'pdf',
  'mp4',
  'webm',
  'mov',
  'm4v',
  'mkv',
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'flac',
  'aac',
  'opus',
  'json',
  'toml',
  'lock',
]);

export type EmitFormat = 'wikiembed' | 'markdown-image';
export type DedupMode = 'off' | 'same-dir';
export type DedupUIMode = 'silent' | 'toast' | 'confirm';


export const DEFAULT_ATTACHMENT_FOLDER_PATH = './';

export const DEFAULT_EMIT_FORMAT: EmitFormat = 'wikiembed';

export const DEFAULT_DEDUP_MODE: DedupMode = 'same-dir';

export const DEFAULT_DEDUP_UI: DedupUIMode = 'toast';

export const WIKI_EMBED_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'pdf',
  'mp4',
  'webm',
  'mov',
  'm4v',
  'mkv',
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'flac',
  'aac',
  'opus',
  'docx',
  'xlsx',
  'pptx',
  'doc',
  'xls',
  'ppt',
  'zip',
  '7z',
  'tar',
  'gz',
  'rar',
  'csv',
  'tsv',
  'rtf',
  'json',
  'yaml',
  'yml',
  'xml',
  'txt',
  'pages',
  'numbers',
  'key',
  'odt',
  'ods',
  'odp',
  'epub',
  'mobi',
]);

export type InlineAssetMediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'text';

const SIDEBAR_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'] as const;
const SIDEBAR_VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v'] as const;
const SIDEBAR_AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus'] as const;
const SIDEBAR_PDF_EXTENSIONS = ['pdf'] as const;
const SIDEBAR_TEXT_EXTENSIONS = ['json', 'toml', 'lock'] as const;

function assertSubset(
  name: string,
  extensions: readonly string[],
  canonical: ReadonlySet<string>,
): void {
  for (const ext of extensions) {
    if (!canonical.has(ext)) {
      throw new Error(`${name}: ${ext} is not present in canonical upload constants`);
    }
  }
}

assertSubset('SIDEBAR_IMAGE_ASSET_EXTENSIONS', SIDEBAR_IMAGE_EXTENSIONS, IMAGE_EXTENSIONS);
assertSubset('SIDEBAR_VIDEO_ASSET_EXTENSIONS', SIDEBAR_VIDEO_EXTENSIONS, VIDEO_EXTENSIONS);
assertSubset('SIDEBAR_AUDIO_ASSET_EXTENSIONS', SIDEBAR_AUDIO_EXTENSIONS, AUDIO_EXTENSIONS);
assertSubset('SIDEBAR_PDF_ASSET_EXTENSIONS', SIDEBAR_PDF_EXTENSIONS, PDF_EXTENSIONS);
assertSubset('FILE_ATTACHMENT_EXTENSIONS', [...FILE_ATTACHMENT_EXTENSIONS], WIKI_EMBED_EXTENSIONS);
assertSubset('WIKI_EMBED_EXTENSIONS', [...WIKI_EMBED_EXTENSIONS], ASSET_EXTENSIONS);

export const SIDEBAR_IMAGE_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(
  SIDEBAR_IMAGE_EXTENSIONS,
);
export const SIDEBAR_VIDEO_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(
  SIDEBAR_VIDEO_EXTENSIONS,
);
export const SIDEBAR_AUDIO_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(
  SIDEBAR_AUDIO_EXTENSIONS,
);
export const SIDEBAR_PDF_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(SIDEBAR_PDF_EXTENSIONS);
export const SIDEBAR_TEXT_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(SIDEBAR_TEXT_EXTENSIONS);
export const SIDEBAR_RENDERABLE_ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  ...SIDEBAR_IMAGE_EXTENSIONS,
  ...SIDEBAR_VIDEO_EXTENSIONS,
  ...SIDEBAR_AUDIO_EXTENSIONS,
  ...SIDEBAR_PDF_EXTENSIONS,
  ...SIDEBAR_TEXT_EXTENSIONS,
]);

assertSubset(
  'SIDEBAR_RENDERABLE_ASSET_EXTENSIONS',
  [...SIDEBAR_RENDERABLE_ASSET_EXTENSIONS],
  INLINE_RENDERABLE_EXTENSIONS,
);

export const TEXT_VIEWER_FALLBACK_EXTENSIONS: ReadonlySet<string> = new Set(['base', 'canvas']);

import { CODE_FILE_EXTENSIONS } from './code-languages';

export { CODE_FILE_EXTENSIONS };

export const LINKABLE_ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  ...ASSET_EXTENSIONS,
  ...TEXT_VIEWER_FALLBACK_EXTENSIONS,
]);

export function mediaKindForSidebarAssetExtension(ext: string): InlineAssetMediaKind | null {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  if (SIDEBAR_IMAGE_ASSET_EXTENSIONS.has(normalized)) return 'image';
  if (SIDEBAR_VIDEO_ASSET_EXTENSIONS.has(normalized)) return 'video';
  if (SIDEBAR_AUDIO_ASSET_EXTENSIONS.has(normalized)) return 'audio';
  if (SIDEBAR_PDF_ASSET_EXTENSIONS.has(normalized)) return 'pdf';
  if (SIDEBAR_TEXT_ASSET_EXTENSIONS.has(normalized)) return 'text';
  if (TEXT_VIEWER_FALLBACK_EXTENSIONS.has(normalized)) return 'text';
  if (CODE_FILE_EXTENSIONS.has(normalized)) return 'text';
  return null;
}
