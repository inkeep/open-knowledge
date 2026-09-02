const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;
const FENCE = /^\s*(`{3,}|~{3,})/;
const CSV_TABLE_TARGET = /_all\.csv(?=$|[#?])/i;

function decodePath(url: string): string {
  const cut = Math.min(
    ...[url.indexOf('#'), url.indexOf('?')].filter((i) => i >= 0).concat(url.length),
  );
  const path = url.slice(0, cut);
  const suffix = url.slice(cut);
  try {
    return decodeURIComponent(path) + suffix;
  } catch {
    return url;
  }
}

function rewriteTarget(raw: string, redirectCsv: boolean): string {
  if (raw.startsWith('<') && raw.endsWith('>')) {
    const inner = raw.slice(1, -1);
    if (EXTERNAL.test(inner) || inner.startsWith('//') || inner.startsWith('#')) return raw;
    let decoded = decodePath(inner);
    if (redirectCsv) decoded = decoded.replace(CSV_TABLE_TARGET, '.md');
    return `<${decoded}>`;
  }
  if (EXTERNAL.test(raw) || raw.startsWith('//') || raw.startsWith('#')) return raw;

  let decoded = decodePath(raw);
  if (redirectCsv) decoded = decoded.replace(CSV_TABLE_TARGET, '.md');
  return /\s/.test(decoded) ? `<${decoded}>` : decoded;
}

function rewriteTargets(text: string, redirectCsv: boolean): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('](', i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open + 2);
    const j = open + 2;

    if (text[j] === '<') {
      const close = text.indexOf('>', j);
      if (close === -1 || text[close + 1] !== ')') {
        i = j;
        continue;
      }
      out += `${rewriteTarget(text.slice(j, close + 1), redirectCsv)})`;
      i = close + 2;
      continue;
    }

    let depth = 1;
    let k = j;
    for (; k < text.length; k++) {
      const c = text[k];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (k >= text.length) {
      out += text.slice(j);
      break;
    }
    out += `${rewriteTarget(text.slice(j, k), redirectCsv)})`;
    i = k + 1;
  }
  return out;
}

function rewriteLineOutsideCode(line: string, redirectCsv: boolean): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      let ticks = 0;
      while (line[i + ticks] === '`') ticks++;
      const open = line.slice(i, i + ticks);
      const closeIdx = line.indexOf(open, i + ticks);
      if (closeIdx >= 0) {
        out += line.slice(i, closeIdx + ticks);
        i = closeIdx + ticks;
        continue;
      }
      out += line.slice(i);
      break;
    }
    const next = line.indexOf('`', i);
    const end = next === -1 ? line.length : next;
    out += rewriteTargets(line.slice(i, end), redirectCsv);
    i = end;
  }
  return out;
}

export interface DecodeLinksOptions {
  redirectCsv?: boolean;
}

export function decodeLinks(markdown: string, opts: DecodeLinksOptions = {}): string {
  const redirectCsv = opts.redirectCsv ?? false;
  const lines = markdown.split('\n');
  let fenceChar: '`' | '~' | null = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] as string;
    const match = line.match(FENCE);
    if (match) {
      const ch = (match[1] as string)[0] as '`' | '~';
      if (fenceChar === null) fenceChar = ch;
      else if (ch === fenceChar) fenceChar = null;
      continue;
    }
    if (fenceChar !== null) continue;
    lines[n] = rewriteLineOutsideCode(line, redirectCsv);
  }
  return lines.join('\n');
}
