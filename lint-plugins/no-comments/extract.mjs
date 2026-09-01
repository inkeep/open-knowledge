const KEYWORDS_BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const VALUE_KEYWORDS = new Set(['this', 'super', 'true', 'false', 'null']);

const PUNCT_BEFORE_JSX = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '{',
  ';',
  '?',
  '&',
  '|',
  '!',
  '+',
  '-',
  '*',
  '>',
  '<',
]);

const KEYWORDS_BEFORE_JSX = new Set([
  'return',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'default',
  'throw',
  'in',
  'of',
]);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

function buildLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function positionAt(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}

function precededByCodeOnLine(source, offset) {
  for (let i = offset - 1; i >= 0 && source.charCodeAt(i) !== 10; i -= 1) {
    if (!/\s/.test(source[i])) return true;
  }
  return false;
}

const TYPE_PARAM_SCAN_LIMIT = 300;
const NEVER_IN_TYPE_PARAMS = /[{};]/;

function looksLikeTypeParameterList(source, afterAngle) {
  let i = afterAngle;
  if (!IDENT_START.test(source[i] ?? '')) return false;
  while (i < source.length && IDENT_PART.test(source[i])) i += 1;
  let probe = i;
  while (probe < source.length && /[ \t]/.test(source[probe])) probe += 1;
  if (source[probe] === ',') return true;
  if (source.startsWith('extends', probe) && /\s/.test(source[probe + 7] ?? '')) return true;

  let depth = 1;
  const limit = Math.min(source.length, afterAngle + TYPE_PARAM_SCAN_LIMIT);
  for (let j = i; j < limit; j += 1) {
    const c = source[j];
    if (NEVER_IN_TYPE_PARAMS.test(c)) return false;
    if (c === '<') depth += 1;
    else if (c === '>') {
      depth -= 1;
      if (depth === 0) return source[j + 1] === '(';
    }
  }
  return false;
}

export function extractComments(source, { jsx = false } = {}) {
  const comments = [];
  const lineStarts = buildLineStarts(source);
  const stack = [{ kind: 'code', braceDepth: 0, closing: false }];
  let lastTok = '';
  let i = 0;

  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n');
    i = nl === -1 ? source.length : nl + 1;
  }

  const pushComment = (kind, start, end) => {
    const { line, column } = positionAt(lineStarts, start);
    comments.push({
      kind,
      text: source.slice(start, end),
      start,
      end,
      line,
      column,
      precededByCode: precededByCodeOnLine(source, start),
    });
  };

  const readLineComment = (start) => {
    let end = source.indexOf('\n', start);
    if (end === -1) end = source.length;
    pushComment('line', start, end);
    return end;
  };

  const readBlockComment = (start) => {
    const close = source.indexOf('*/', start + 2);
    const end = close === -1 ? source.length : close + 2;
    pushComment('block', start, end);
    return end;
  };

  const readQuoted = (start, quote, withEscapes) => {
    let j = start + 1;
    while (j < source.length) {
      const c = source[j];
      if (withEscapes && c === '\\') {
        j += 2;
        continue;
      }
      if (c === quote) return j + 1;
      if (withEscapes && c === '\n') return j;
      j += 1;
    }
    return source.length;
  };

  const tryReadRegex = (start) => {
    let j = start + 1;
    let inClass = false;
    while (j < source.length) {
      const c = source[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '\n') return -1;
      if (inClass) {
        if (c === ']') inClass = false;
      } else if (c === '[') {
        inClass = true;
      } else if (c === '/') {
        j += 1;
        while (j < source.length && IDENT_PART.test(source[j])) j += 1;
        return j;
      }
      j += 1;
    }
    return -1;
  };

  while (i < source.length) {
    const frame = stack[stack.length - 1];
    const c = source[i];

    if (frame.kind === 'template') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        lastTok = 'str';
        i += 1;
        continue;
      }
      if (c === '$' && source[i + 1] === '{') {
        stack.push({ kind: 'code', braceDepth: 0, closing: false });
        lastTok = '';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (frame.kind === 'jsxChildren') {
      if (c === '{') {
        stack.push({ kind: 'code', braceDepth: 0, closing: false });
        lastTok = '';
        i += 1;
        continue;
      }
      if (c === '<') {
        const closing = source[i + 1] === '/';
        stack.push({ kind: 'jsxTag', braceDepth: 0, closing });
        i += closing ? 2 : 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (frame.kind === 'jsxTag') {
      if (c === '/' && source[i + 1] === '/') {
        i = readLineComment(i);
        continue;
      }
      if (c === '/' && source[i + 1] === '*') {
        i = readBlockComment(i);
        continue;
      }
      if (c === '"' || c === "'") {
        i = readQuoted(i, c, false);
        continue;
      }
      if (c === '{') {
        stack.push({ kind: 'code', braceDepth: 0, closing: false });
        lastTok = '';
        i += 1;
        continue;
      }
      if (c === '/' && source[i + 1] === '>') {
        stack.pop();
        lastTok = 'str';
        i += 2;
        continue;
      }
      if (c === '>') {
        const wasClosing = frame.closing;
        stack.pop();
        i += 1;
        if (wasClosing) {
          if (stack[stack.length - 1]?.kind === 'jsxChildren') stack.pop();
          lastTok = 'str';
        } else {
          stack.push({ kind: 'jsxChildren', braceDepth: 0, closing: false });
        }
        continue;
      }
      i += 1;
      continue;
    }

    if (c === '/' && source[i + 1] === '/') {
      i = readLineComment(i);
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i = readBlockComment(i);
      continue;
    }
    if (c === '"' || c === "'") {
      i = readQuoted(i, c, true);
      lastTok = 'str';
      continue;
    }
    if (c === '`') {
      stack.push({ kind: 'template', braceDepth: 0, closing: false });
      i += 1;
      continue;
    }
    if (c === '/') {
      const isValuePosition =
        lastTok === ')' ||
        lastTok === ']' ||
        lastTok === '}' ||
        lastTok === 'num' ||
        lastTok === 'str' ||
        VALUE_KEYWORDS.has(lastTok) ||
        (IDENT_START.test(lastTok[0] ?? '') && !KEYWORDS_BEFORE_REGEX.has(lastTok));
      if (!isValuePosition) {
        const end = tryReadRegex(i);
        if (end !== -1) {
          i = end;
          lastTok = 'str';
          continue;
        }
      }
      lastTok = '/';
      i += 1;
      continue;
    }
    if (jsx && c === '<') {
      const jsxPosition =
        PUNCT_BEFORE_JSX.has(lastTok) ||
        (IDENT_START.test(lastTok[0] ?? '') && KEYWORDS_BEFORE_JSX.has(lastTok));
      const next = source[i + 1] ?? '';
      const opensElement = next === '>' || IDENT_START.test(next);
      if (jsxPosition && opensElement && !looksLikeTypeParameterList(source, i + 1)) {
        stack.push({ kind: 'jsxTag', braceDepth: 0, closing: false });
        i += 1;
        continue;
      }
    }
    if (c === '{') {
      frame.braceDepth += 1;
      lastTok = '{';
      i += 1;
      continue;
    }
    if (c === '}') {
      if (frame.braceDepth === 0 && stack.length > 1) {
        stack.pop();
        lastTok = stack[stack.length - 1].kind === 'template' ? '' : '}';
        i += 1;
        continue;
      }
      if (frame.braceDepth > 0) frame.braceDepth -= 1;
      lastTok = '}';
      i += 1;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i;
      while (j < source.length && IDENT_PART.test(source[j])) j += 1;
      lastTok = source.slice(i, j);
      i = j;
      continue;
    }
    if (DIGIT.test(c)) {
      let j = i;
      while (j < source.length && /[0-9a-fA-FxXoObBnE._]/.test(source[j])) j += 1;
      lastTok = 'num';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) lastTok = c;
    i += 1;
  }

  return comments;
}

export function jsxModeForPath(filePath) {
  return filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
}
