import { commentFactory } from './text-position.mjs';

export class UnknownHashDialectError extends Error {
  constructor(subject) {
    super(
      `no hash-family dialect is registered for ${subject}. The hash lexer reads one grammar per ` +
        'file class and each class needs its own comment-position reference before it can be ' +
        'trusted; register the dialect with its reference rather than falling through to another.',
    );
    this.name = 'UnknownHashDialectError';
    this.subject = subject;
  }
}

const DIALECT_BY_EXTENSION = new Map([
  ['.sh', 'shell'],
  ['.bash', 'shell'],
  ['.yml', 'yaml'],
  ['.yaml', 'yaml'],
  ['.py', 'python'],
]);

export function hashDialectsFor(extensions) {
  return [...new Set(extensions.map((extension) => DIALECT_BY_EXTENSION.get(extension)))];
}

function extensionOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

export function hashDialectFor(path, { extensions = [] } = {}) {
  const own = DIALECT_BY_EXTENSION.get(extensionOf(path));
  if (own !== undefined) return own;
  const declared = [...new Set(extensions.map((ext) => DIALECT_BY_EXTENSION.get(ext)))];
  if (declared.length === 1 && declared[0] !== undefined) return declared[0];
  throw new UnknownHashDialectError(path);
}

const CODING_COOKIE_RE = /^[ \t\f]*#.*?coding[:=][ \t]*[-_.a-zA-Z0-9]+/;
const COMMENT_LINE_RE = /^[ \t\f]*(?:#|$)/;

function lineEndAt(source, start) {
  const nl = source.indexOf('\n', start);
  return nl === -1 ? source.length : nl;
}

function backtickCloserBefore(source, start, limit) {
  let i = start;
  while (i < limit) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === '`') return i;
    i += 1;
  }
  return limit;
}

function readStructuralPrefix(source, kinds, emit) {
  const tokens = [];
  let offset = 0;
  if (kinds.includes('shebang') && source.startsWith('#!')) {
    const end = lineEndAt(source, 0);
    tokens.push(emit('shebang', 0, end));
    offset = Math.min(end + 1, source.length);
  }
  if (kinds.includes('coding-cookie')) {
    let cursor = offset;
    for (let line = tokens.length + 1; line <= 2 && cursor < source.length; line += 1) {
      const end = lineEndAt(source, cursor);
      const text = source.slice(cursor, end);
      if (CODING_COOKIE_RE.test(text)) {
        tokens.push(emit('coding-cookie', cursor, end));
        offset = Math.min(end + 1, source.length);
        break;
      }
      if (!COMMENT_LINE_RE.test(text)) break;
      cursor = end + 1;
    }
  }
  return { tokens, offset };
}

const SHELL_METACHARACTERS = new Set([' ', '\t', '\n', '|', '&', ';', '(', ')', '<', '>']);

const CODE_FRAMES = new Set(['code', 'cmdsub', 'backtick']);

function lexShell(source, from, emit) {
  const comments = [];
  const stack = [{ kind: 'code', atWordStart: true, parens: 0, braces: 0 }];
  const heredocs = [];
  let i = from;

  const top = () => stack[stack.length - 1];
  const push = (kind) => stack.push({ kind, atWordStart: true, parens: 0, braces: 0 });
  const popInto = () => {
    stack.pop();
    if (stack.length === 0) stack.push({ kind: 'code', atWordStart: true, parens: 0, braces: 0 });
    top().atWordStart = false;
  };

  const consumeHeredocBodies = () => {
    while (heredocs.length > 0 && i < source.length) {
      const { delimiter, stripTabs } = heredocs.shift();
      while (i < source.length) {
        const end = lineEndAt(source, i);
        const raw = source.slice(i, end);
        const candidate = stripTabs ? raw.replace(/^\t+/, '') : raw;
        i = Math.min(end + 1, source.length);
        if (candidate === delimiter) break;
      }
    }
  };

  const readHeredocOpener = () => {
    i += 2;
    const stripTabs = source[i] === '-';
    if (stripTabs) i += 1;
    while (i < source.length && (source[i] === ' ' || source[i] === '\t')) i += 1;
    let delimiter = '';
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') {
        delimiter += source[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        i += 1;
        while (i < source.length && source[i] !== c) {
          if (c === '"' && source[i] === '\\') {
            delimiter += source[i + 1] ?? '';
            i += 2;
            continue;
          }
          delimiter += source[i];
          i += 1;
        }
        i += 1;
        continue;
      }
      if (SHELL_METACHARACTERS.has(c)) break;
      delimiter += c;
      i += 1;
    }
    heredocs.push({ delimiter, stripTabs });
    top().atWordStart = false;
  };

  while (i < source.length) {
    const frame = top();
    const c = source[i];

    if (frame.kind === 'single') {
      if (c === "'") popInto();
      i += 1;
      continue;
    }

    if (frame.kind === 'ansi') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === "'") popInto();
      i += 1;
      continue;
    }

    if (frame.kind === 'dquote' || frame.kind === 'paramexp' || frame.kind === 'arith') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (frame.kind === 'dquote' && c === '"') {
        popInto();
        i += 1;
        continue;
      }
      if (frame.kind === 'paramexp') {
        if (c === '{') {
          frame.braces += 1;
          i += 1;
          continue;
        }
        if (c === '}') {
          if (frame.braces === 0) popInto();
          else frame.braces -= 1;
          i += 1;
          continue;
        }
      }
      if (frame.kind === 'arith') {
        if (c === '(') {
          frame.parens += 1;
          i += 1;
          continue;
        }
        if (c === ')') {
          if (frame.parens > 0) {
            frame.parens -= 1;
            i += 1;
            continue;
          }
          popInto();
          i += source[i + 1] === ')' ? 2 : 1;
          continue;
        }
      }
      if (frame.kind !== 'dquote' && (c === "'" || c === '"')) {
        push(c === "'" ? 'single' : 'dquote');
        i += 1;
        continue;
      }
      if (c === '`') {
        push('backtick');
        i += 1;
        continue;
      }
      if (c === '$') {
        if (source[i + 1] === '(' && source[i + 2] === '(') {
          push('arith');
          i += 3;
          continue;
        }
        if (source[i + 1] === '(') {
          push('cmdsub');
          i += 2;
          continue;
        }
        if (source[i + 1] === '{') {
          push('paramexp');
          i += 2;
          continue;
        }
        if (frame.kind !== 'dquote' && source[i + 1] === "'") {
          push('ansi');
          i += 2;
          continue;
        }
      }
      i += 1;
      continue;
    }

    if (!CODE_FRAMES.has(frame.kind)) {
      i += 1;
      continue;
    }

    if (c === '\\') {
      if (source[i + 1] !== '\n') frame.atWordStart = false;
      i += 2;
      continue;
    }
    if (c === '\n') {
      i += 1;
      consumeHeredocBodies();
      top().atWordStart = true;
      continue;
    }
    if (c === '#' && frame.atWordStart) {
      const lineEnd = lineEndAt(source, i);
      const end =
        frame.kind === 'backtick' ? backtickCloserBefore(source, i, lineEnd) : lineEnd;
      comments.push(emit('line', i, end));
      i = end;
      continue;
    }
    if (c === "'") {
      push('single');
      i += 1;
      continue;
    }
    if (c === '"') {
      push('dquote');
      i += 1;
      continue;
    }
    if (c === '`') {
      if (frame.kind === 'backtick') popInto();
      else push('backtick');
      i += 1;
      continue;
    }
    if (c === '$') {
      if (source[i + 1] === '(' && source[i + 2] === '(') {
        push('arith');
        i += 3;
        continue;
      }
      if (source[i + 1] === '(') {
        push('cmdsub');
        i += 2;
        continue;
      }
      if (source[i + 1] === '{') {
        push('paramexp');
        i += 2;
        continue;
      }
      if (source[i + 1] === "'") {
        push('ansi');
        i += 2;
        continue;
      }
      if (source[i + 1] === '"') {
        push('dquote');
        i += 2;
        continue;
      }
      frame.atWordStart = false;
      i += 1;
      continue;
    }
    if (c === '(') {
      if (source[i + 1] === '(' && frame.atWordStart) {
        push('arith');
        i += 2;
        continue;
      }
      if (frame.kind === 'cmdsub') frame.parens += 1;
      frame.atWordStart = true;
      i += 1;
      continue;
    }
    if (c === ')') {
      if (frame.kind === 'cmdsub') {
        if (frame.parens === 0) {
          popInto();
          i += 1;
          continue;
        }
        frame.parens -= 1;
      }
      frame.atWordStart = true;
      i += 1;
      continue;
    }
    if (c === '<' && source[i + 1] === '<') {
      if (source[i + 2] === '<') {
        frame.atWordStart = true;
        i += 3;
        continue;
      }
      readHeredocOpener();
      continue;
    }
    frame.atWordStart = SHELL_METACHARACTERS.has(c);
    i += 1;
  }

  return comments;
}

function lexPython(source, from, emit) {
  const comments = [];
  let i = from;
  while (i < source.length) {
    const c = source[i];
    if (c === '#') {
      const end = lineEndAt(source, i);
      comments.push(emit('line', i, end));
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = source.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      i += quote.length;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source.startsWith(quote, i)) {
          i += quote.length;
          break;
        }
        if (!triple && source[i] === '\n') break;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return comments;
}

const YAML_BLOCK_HEADER_RE = /^[|>][0-9]*[-+]?[0-9]*[ \t]*(?:#.*)?$/;

function indentOf(source, lineStart) {
  let width = 0;
  while (source[lineStart + width] === ' ') width += 1;
  return width;
}

function lexYaml(source, from, emit) {
  const comments = [];
  let i = from;
  let quote = null;
  let lineStart = from;
  let blockParentIndent = null;
  let atNodeStart = true;
  let flowDepth = 0;

  const skipBlockBody = () => {
    while (blockParentIndent !== null && i < source.length) {
      const end = lineEndAt(source, i);
      const raw = source.slice(i, end);
      if (raw.trim() !== '' && indentOf(source, i) <= blockParentIndent) {
        blockParentIndent = null;
        return;
      }
      i = Math.min(end + 1, source.length);
      lineStart = i;
    }
  };

  while (i < source.length) {
    const c = source[i];
    if (quote !== null) {
      if (quote === "'" && c === "'" && source[i + 1] === "'") {
        i += 2;
        continue;
      }
      if (quote === '"' && c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        atNodeStart = false;
      }
      if (c === '\n') lineStart = i + 1;
      i += 1;
      continue;
    }
    if (c === '\n') {
      i += 1;
      lineStart = i;
      atNodeStart = true;
      flowDepth = 0;
      skipBlockBody();
      continue;
    }
    if (c === ' ' || c === '\t') {
      i += 1;
      continue;
    }
    if (atNodeStart && (c === "'" || c === '"')) {
      quote = c;
      i += 1;
      continue;
    }
    if (c === '#' && (i === lineStart || source[i - 1] === ' ' || source[i - 1] === '\t')) {
      const end = lineEndAt(source, i);
      comments.push(emit('line', i, end));
      i = end;
      continue;
    }
    if (
      (c === '|' || c === '>') &&
      (source[i - 1] === ' ' || source[i - 1] === '\t') &&
      YAML_BLOCK_HEADER_RE.test(source.slice(i, lineEndAt(source, i)))
    ) {
      blockParentIndent = indentOf(source, lineStart);
    }
    if (c === '[' || c === '{') {
      flowDepth += 1;
      atNodeStart = true;
      i += 1;
      continue;
    }
    if (c === ']' || c === '}') {
      if (flowDepth > 0) flowDepth -= 1;
      atNodeStart = false;
      i += 1;
      continue;
    }
    if (c === ',' && flowDepth > 0) {
      atNodeStart = true;
      i += 1;
      continue;
    }
    if (
      (c === '-' || c === '?') &&
      atNodeStart &&
      (source[i + 1] === ' ' || source[i + 1] === '\t' || source[i + 1] === '\n')
    ) {
      i += 1;
      continue;
    }
    if (c === ':' && (flowDepth > 0 || source[i + 1] === ' ' || source[i + 1] === '\t' || source[i + 1] === '\n' || i + 1 >= source.length)) {
      atNodeStart = true;
      i += 1;
      continue;
    }
    atNodeStart = false;
    i += 1;
  }
  return comments;
}

const DIALECTS = {
  shell: { structural: ['shebang'], lex: lexShell, reference: 'the pinned shfmt differential' },
  python: { structural: ['shebang', 'coding-cookie'], lex: lexPython, reference: null },
  yaml: { structural: [], lex: lexYaml, reference: "the yaml package's CST" },
};

export const HASH_DIALECT_REGISTRY = Object.entries(DIALECTS).map(([dialect, entry]) => ({
  dialect,
  declaresReference: Object.hasOwn(entry, 'reference'),
  reference: entry.reference ?? null,
}));

export function hashDialectsWithoutReference(extensions, { dialects = DIALECTS } = {}) {
  return hashDialectsFor(extensions).filter(
    (dialect) => (dialects[dialect]?.reference ?? null) === null,
  );
}

export function extractHashComments(source, { dialect } = {}) {
  const entry = DIALECTS[dialect];
  if (entry === undefined) throw new UnknownHashDialectError(`dialect ${JSON.stringify(dialect)}`);
  const emit = commentFactory(source);
  const { tokens, offset } = readStructuralPrefix(source, entry.structural, emit);
  return [...tokens, ...entry.lex(source, offset, emit)];
}
