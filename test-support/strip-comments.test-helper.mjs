import { extractComments, jsxModeForPath } from '../lint-plugins/no-comments/index.mjs';

const WORD_RE = /[\w$]/;

export function stripComments(source, { path = 'source.ts' } = {}) {
  const comments = extractComments(source, { jsx: jsxModeForPath(path) });
  if (comments.length === 0) return source;

  const touched = new Set();
  let out = source;
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const { start, end } = comments[i];
    const before = out[start - 1] ?? '';
    const after = out[end] ?? '';
    const filler = WORD_RE.test(before) && WORD_RE.test(after) ? ' ' : '';
    out = out.slice(0, start) + filler + out.slice(end);
    for (let line = comments[i].line; line <= lineOf(source, end); line += 1) touched.add(line);
  }

  const originalLines = source.split('\n');
  const kept = [];
  let cursor = 1;
  for (const line of out.split('\n')) {
    const wasTouched = touched.has(cursor);
    const originalLine = originalLines[cursor - 1] ?? '';
    cursor += 1;
    if (wasTouched && line.trim() === '' && originalLine.trim() !== '') continue;
    kept.push(line);
  }
  return kept.join('\n');
}

function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

export const COMMENT_STATES = ['as authored', 'comments stripped', 'comment injected'];

function injectComment(source, { anchorTokens = [] } = {}) {
  const payload = ['guard-anchor probe', ...anchorTokens].join(' ');
  return `/* ${payload} */\n${source}`;
}

export function commentStates(source, options) {
  return [
    [COMMENT_STATES[0], source],
    [COMMENT_STATES[1], stripComments(source, options)],
    [COMMENT_STATES[2], injectComment(source, options)],
  ];
}
