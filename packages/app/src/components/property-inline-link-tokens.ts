
import { parseWikiLink } from '@inkeep/open-knowledge-core';

export type PropertyInlineSegment =
  | { type: 'text'; value: string }
  | {
      type: 'wikilink';
      raw: string;
      target: string;
      alias: string | null;
      anchor: string | null;
    }
  | { type: 'link'; raw: string; text: string; url: string }
  | { type: 'autolink'; raw: string; url: string };

function parseMarkdownLink(src: string): { raw: string; text: string; url: string } | null {
  if (src[0] !== '[') return null;
  let i = 1;
  let textEnd = -1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ']') {
      textEnd = i;
      break;
    }
    if (ch === '[') return null;
    i++;
  }
  if (textEnd < 0) return null;
  if (src[textEnd + 1] !== '(') return null;
  const urlStart = textEnd + 2;
  const urlEnd = src.indexOf(')', urlStart);
  if (urlEnd < 0) return null;
  const text = src.slice(1, textEnd);
  const url = src.slice(urlStart, urlEnd).trim();
  if (!url) return null;
  return { raw: src.slice(0, urlEnd + 1), text, url };
}

const AUTOLINK_RE = /^https?:\/\/[^\s<>"'`]+/i;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

function parseAutolink(src: string): { raw: string; url: string } | null {
  const match = AUTOLINK_RE.exec(src);
  if (!match) return null;
  let url = match[0];
  if (url.endsWith(')') && !url.slice(0, -1).includes('(')) {
    url = url.slice(0, -1);
  }
  url = url.replace(TRAILING_PUNCT_RE, '');
  if (!url) return null;
  return { raw: url, url };
}

export function tokenizePropertyInlineLinks(text: string): PropertyInlineSegment[] {
  const out: PropertyInlineSegment[] = [];
  let i = 0;
  let plainStart = 0;

  function flushPlain(end: number): void {
    if (end > plainStart) out.push({ type: 'text', value: text.slice(plainStart, end) });
  }

  while (i < text.length) {
    if (text[i] === '[' && text[i + 1] === '[') {
      const wiki = parseWikiLink(text.slice(i));
      if (wiki) {
        flushPlain(i);
        out.push({
          type: 'wikilink',
          raw: wiki.raw,
          target: wiki.target,
          alias: wiki.alias,
          anchor: wiki.anchor,
        });
        i += wiki.raw.length;
        plainStart = i;
        continue;
      }
    }
    if (text[i] === '[') {
      const md = parseMarkdownLink(text.slice(i));
      if (md) {
        flushPlain(i);
        out.push({ type: 'link', raw: md.raw, text: md.text, url: md.url });
        i += md.raw.length;
        plainStart = i;
        continue;
      }
    }
    if ((text[i] === 'h' || text[i] === 'H') && /^https?:\/\//i.test(text.slice(i, i + 8))) {
      const auto = parseAutolink(text.slice(i));
      if (auto) {
        flushPlain(i);
        out.push({ type: 'autolink', raw: auto.raw, url: auto.url });
        i += auto.raw.length;
        plainStart = i;
        continue;
      }
    }
    i++;
  }
  flushPlain(text.length);
  return out;
}

export function hasInlineLinks(text: string): boolean {
  if (!text) return false;
  if (!text.includes('[[') && !text.includes('](') && !/https?:\/\//i.test(text)) return false;
  return tokenizePropertyInlineLinks(text).some((seg) => seg.type !== 'text');
}
