const MAX_TITLE = 200;
const MAX_DESCRIPTION = 500;
const MAX_SITE_NAME = 100;

export interface RawHtmlMetadata {
  title?: string;
  description?: string;
  siteName?: string;
  faviconHref?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function decodeCodePoint(code: number): string | null {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}

function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith('#')) {
        const isHex = body[1] === 'x' || body[1] === 'X';
        const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        return decodeCodePoint(code) ?? match;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

function isFormatControl(code: number): boolean {
  return (
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function stripUnsafeChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (isFormatControl(code)) continue;
    out += isControl(code) ? ' ' : ch;
  }
  return out;
}

function truncate(text: string, maxLen: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxLen) return text;
  return `${chars
    .slice(0, maxLen - 1)
    .join('')
    .trimEnd()}…`;
}

function sanitizeText(raw: string, maxLen: number): string {
  const decoded = decodeHtmlEntities(raw);
  const stripped = stripUnsafeChars(decoded);
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return truncate(collapsed, maxLen);
}

function relTokens(rel: string): string[] {
  return rel.trim().toLowerCase().split(/\s+/);
}

function asciiLowerCase(input: string): string {
  return input.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

function isWhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

const RAW_TEXT_TAGS = new Set([
  'script',
  'style',
  'template',
  'textarea',
  'iframe',
  'xmp',
  'noembed',
  'noframes',
  'plaintext',
]);

function readTagName(lower: string, start: number): { name: string; end: number } {
  let i = start;
  while (i < lower.length) {
    const c = lower.charCodeAt(i);
    const isNameChar = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2d;
    if (!isNameChar) break;
    i++;
  }
  return { name: lower.slice(start, i), end: i };
}

function scanAttributes(
  html: string,
  lower: string,
  start: number,
  attrs: Map<string, string> | null,
): number {
  const len = lower.length;
  let i = start;
  while (i < len) {
    let c = lower.charCodeAt(i);
    if (isWhitespaceCode(c) || c === 0x2f) {
      i++;
      continue;
    }
    if (c === 0x3e) return i + 1;
    const nameStart = i;
    while (i < len) {
      c = lower.charCodeAt(i);
      if (isWhitespaceCode(c) || c === 0x3d || c === 0x3e || c === 0x2f) break;
      i++;
    }
    const name = lower.slice(nameStart, i);
    while (i < len && isWhitespaceCode(lower.charCodeAt(i))) i++;
    let value = '';
    if (i < len && lower.charCodeAt(i) === 0x3d) {
      i++;
      while (i < len && isWhitespaceCode(lower.charCodeAt(i))) i++;
      if (i < len) {
        const quote = lower.charCodeAt(i);
        if (quote === 0x22 || quote === 0x27) {
          i++;
          const close = lower.indexOf(quote === 0x22 ? '"' : "'", i);
          value = html.slice(i, close === -1 ? len : close);
          i = close === -1 ? len : close + 1;
        } else {
          const valueStart = i;
          while (i < len) {
            c = lower.charCodeAt(i);
            if (isWhitespaceCode(c) || c === 0x3e) break;
            i++;
          }
          value = html.slice(valueStart, i);
        }
      }
    }
    if (attrs && name && !attrs.has(name)) attrs.set(name, value);
  }
  return len;
}

function findCloseTag(
  lower: string,
  tagName: string,
  from: number,
): { textEnd: number; end: number } | null {
  const needle = `</${tagName}`;
  let i = from;
  while (i < lower.length) {
    const at = lower.indexOf(needle, i);
    if (at === -1) return null;
    const afterIdx = at + needle.length;
    const after = afterIdx < lower.length ? lower.charCodeAt(afterIdx) : -1;
    if (after === 0x3e || after === 0x2f || after === -1 || isWhitespaceCode(after)) {
      const gt = lower.indexOf('>', afterIdx);
      return { textEnd: at, end: gt === -1 ? lower.length : gt + 1 };
    }
    i = at + 1;
  }
  return null;
}

interface HeadScan {
  rawTitle: string;
  metaContent: Map<string, string>;
  faviconHref: string | undefined;
  headEndOffset: number;
}

function scanHead(html: string): HeadScan {
  let rawTitle = '';
  const metaContent = new Map<string, string>();
  let faviconHref: string | undefined;
  let headEndOffset = -1;

  try {
    const lower = asciiLowerCase(html);
    const len = lower.length;
    let i = 0;
    while (i < len) {
      const lt = lower.indexOf('<', i);
      if (lt === -1) break;
      const next = lt + 1 < len ? lower.charCodeAt(lt + 1) : -1;

      if (next === 0x21) {
        if (lower.startsWith('<!--', lt)) {
          const close = lower.indexOf('-->', lt + 2);
          if (close === -1) break;
          i = close + 3;
        } else {
          const gt = lower.indexOf('>', lt + 2);
          if (gt === -1) break;
          i = gt + 1;
        }
        continue;
      }

      if (next === 0x3f) {
        const gt = lower.indexOf('>', lt + 2);
        if (gt === -1) break;
        i = gt + 1;
        continue;
      }

      if (next === 0x2f) {
        const { name, end } = readTagName(lower, lt + 2);
        if (name === 'head') {
          if (end < len) {
            const gt = lower.indexOf('>', end);
            if (gt !== -1) headEndOffset = gt + 1;
          }
          break;
        }
        const gt = lower.indexOf('>', end);
        if (gt === -1) break;
        i = gt + 1;
        continue;
      }

      if (!(next >= 0x61 && next <= 0x7a)) {
        i = lt + 1;
        continue;
      }

      const { name, end: nameEnd } = readTagName(lower, lt + 1);

      if (name === 'body') {
        if (nameEnd < len) {
          const term = lower.charCodeAt(nameEnd);
          if (term === 0x3e || term === 0x2f || isWhitespaceCode(term)) {
            headEndOffset = nameEnd + 1;
          }
        }
        break;
      }

      if (name === 'title') {
        const contentStart = scanAttributes(html, lower, nameEnd, null);
        const close = findCloseTag(lower, 'title', contentStart);
        if (close === null) {
          rawTitle += html.slice(contentStart);
          break;
        }
        rawTitle += html.slice(contentStart, close.textEnd);
        i = close.end;
        continue;
      }

      if (RAW_TEXT_TAGS.has(name)) {
        const contentStart = scanAttributes(html, lower, nameEnd, null);
        const close = findCloseTag(lower, name, contentStart);
        if (close === null) break;
        i = close.end;
        continue;
      }

      if (name === 'meta') {
        const attrs = new Map<string, string>();
        i = scanAttributes(html, lower, nameEnd, attrs);
        const content = attrs.get('content');
        if (content) {
          const property = attrs.get('property');
          const metaName = attrs.get('name');
          if (property) metaContent.set(property.toLowerCase(), content);
          else if (metaName) metaContent.set(metaName.toLowerCase(), content);
        }
        continue;
      }

      if (name === 'link') {
        const attrs = new Map<string, string>();
        i = scanAttributes(html, lower, nameEnd, attrs);
        if (faviconHref === undefined) {
          const href = attrs.get('href');
          const rel = attrs.get('rel');
          if (href && rel && relTokens(rel).includes('icon')) faviconHref = href;
        }
        continue;
      }

      i = scanAttributes(html, lower, nameEnd, null);
    }
  } catch {}

  return { rawTitle, metaContent, faviconHref, headEndOffset };
}

export function extractHtmlMetadata(html: string): RawHtmlMetadata {
  const { rawTitle, metaContent, faviconHref } = scanHead(html);

  const title = sanitizeText(metaContent.get('og:title') ?? rawTitle, MAX_TITLE);
  const description = sanitizeText(
    metaContent.get('og:description') ?? metaContent.get('description') ?? '',
    MAX_DESCRIPTION,
  );
  const siteName = sanitizeText(metaContent.get('og:site_name') ?? '', MAX_SITE_NAME);

  const result: RawHtmlMetadata = {};
  if (title) result.title = title;
  if (description) result.description = description;
  if (siteName) result.siteName = siteName;
  if (faviconHref) result.faviconHref = faviconHref;
  return result;
}

export function findHeadEndOffset(html: string): number {
  return scanHead(html).headEndOffset;
}

export function deriveDomain(requestUrl: string): string {
  let host: string;
  try {
    host = new URL(requestUrl).hostname;
  } catch {
    return requestUrl;
  }
  if (host.startsWith('www.') && host.slice(4).includes('.')) host = host.slice(4);
  return host;
}
