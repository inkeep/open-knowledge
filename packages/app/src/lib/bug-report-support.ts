import {
  clampToCodeUnits,
  mapControlCharactersToSpace,
  stripInvisibleCharacters,
} from '@inkeep/open-knowledge-core';

const SUPPORT_EMAIL = 'support@inkeep.com';

export function supportMailtoUrl(subject: string): string {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

export function zipBasename(zipPath: string): string {
  return zipPath.split(/[\\/]/).pop() ?? zipPath;
}

export function formatBundleSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} B`;
}

const MAX_TITLE_LENGTH = 200;

const BLOCK_MARKER = /^(?:#{1,6}|>)(?:[ \t]+|$)/;

export function bugReportNoteTitle(note: string | undefined): string | undefined {
  if (typeof note !== 'string') return undefined;
  for (const line of note.split(/\r\n|\r|\n/)) {
    let normalized = mapControlCharactersToSpace(line);
    normalized = stripInvisibleCharacters(normalized).replace(/\s+/g, ' ').trim();
    while (BLOCK_MARKER.test(normalized)) {
      normalized = normalized.replace(BLOCK_MARKER, '').trim();
    }
    if (normalized !== '') return clampToCodeUnits(normalized, MAX_TITLE_LENGTH).trimEnd();
  }
  return undefined;
}
