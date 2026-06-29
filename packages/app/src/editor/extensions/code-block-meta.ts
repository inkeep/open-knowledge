
const TOKEN_RE = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g;

export function splitMetaTokens(meta: string | null | undefined): string[] {
  if (!meta) return [];
  return meta.match(TOKEN_RE) ?? [];
}

export function joinMetaTokens(tokens: readonly string[]): string | null {
  const filtered = tokens.filter((t) => t.length > 0);
  if (filtered.length === 0) return null;
  return filtered.join(' ');
}

export function metaHasToken(meta: string | null | undefined, token: string): boolean {
  return splitMetaTokens(meta).includes(token);
}

export function addMetaToken(meta: string | null | undefined, token: string): string | null {
  const tokens = splitMetaTokens(meta);
  if (tokens.includes(token)) return joinMetaTokens(tokens);
  tokens.push(token);
  return joinMetaTokens(tokens);
}

export function removeMetaToken(meta: string | null | undefined, token: string): string | null {
  const tokens = splitMetaTokens(meta).filter((t) => t !== token);
  return joinMetaTokens(tokens);
}

export const PREVIEWABLE_LANGUAGES = new Set(['html', 'htm', 'xml']);

export function shouldShowPreview(
  language: string | null | undefined,
  meta: string | null | undefined,
): boolean {
  if (!language) return false;
  if (!PREVIEWABLE_LANGUAGES.has(language.toLowerCase())) return false;
  return metaHasToken(meta, 'preview');
}

const KV_RE = /^([a-zA-Z][a-zA-Z0-9_-]*)=(.+)$/;
const HEIGHT_VALUE_RE = /^(\d+(?:\.\d+)?)(px|rem|em|vh|vw|%)?$/i;

export function getMetaKeyValue(meta: string | null | undefined, key: string): string | null {
  for (const token of splitMetaTokens(meta)) {
    const m = token.match(KV_RE);
    if (m && m[1] === key) return m[2] ?? null;
  }
  return null;
}

export function setMetaKeyValue(
  meta: string | null | undefined,
  key: string,
  value: string | null,
): string | null {
  const tokens = splitMetaTokens(meta);
  let replaced = false;
  const next: string[] = [];
  for (const token of tokens) {
    const m = token.match(KV_RE);
    if (m && m[1] === key) {
      if (replaced) {
        continue;
      }
      replaced = true;
      if (value !== null) next.push(`${key}=${value}`);
      continue;
    }
    next.push(token);
  }
  if (!replaced && value !== null) next.push(`${key}=${value}`);
  return joinMetaTokens(next);
}

export function parsePreviewHeight(meta: string | null | undefined): string | null {
  return parseLengthToken(meta, 'h');
}

export function parsePreviewWidth(meta: string | null | undefined): string | null {
  return parseLengthToken(meta, 'w');
}

const TITLE_RE = /\btitle=(?:"([^"]*)"|'([^']*)'|(\S+))/;

const TITLE_RE_GLOBAL = /\btitle=(?:"[^"]*"|'[^']*'|\S*)/g;

export function getMetaTitle(meta: string | null | undefined): string | null {
  if (!meta) return null;
  const m = meta.match(TITLE_RE);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

export function setMetaTitle(meta: string | null | undefined, value: string | null): string | null {
  const stripped = meta ? meta.replace(TITLE_RE_GLOBAL, '').trim() : '';
  const rest = stripped.length > 0 ? stripped.replace(/\s+/g, ' ') : '';
  if (value === null) {
    return rest.length > 0 ? rest : null;
  }
  const safe = value.replace(/["\r\n]/g, '');
  const titleToken = `title="${safe}"`;
  return rest.length > 0 ? `${titleToken} ${rest}` : titleToken;
}

function parseLengthToken(meta: string | null | undefined, key: 'h' | 'w'): string | null {
  const raw = getMetaKeyValue(meta, key);
  if (!raw) return null;
  const m = raw.match(HEIGHT_VALUE_RE);
  if (!m) return null;
  const num = m[1];
  if (!num || Number.parseFloat(num) <= 0) return null;
  const unit = m[2]?.toLowerCase() ?? 'px';
  return `${num}${unit}`;
}
