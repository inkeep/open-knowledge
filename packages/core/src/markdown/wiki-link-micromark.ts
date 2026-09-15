import type { CompileContext, Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Handle as ToMarkdownHandle } from 'mdast-util-to-markdown';
import type { Construct, Extension, State, Token, Tokenizer } from 'micromark-util-types';
import type { Processor } from 'unified';
import type { WikiLinkEmbedMdast, WikiLinkMdast } from './mdast-augmentation.ts';
import {
  escapeTableCellPipes,
  normalizeWikiSeparatorEscapes,
  rawSegmentOr,
  separatorEscapeLeavesEmpty,
} from './wiki-escape.ts';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    wikiLink: 'wikiLink';
    wikiLinkMarker: 'wikiLinkMarker';
    wikiLinkTarget: 'wikiLinkTarget';
    wikiLinkAnchor: 'wikiLinkAnchor';
    wikiLinkAlias: 'wikiLinkAlias';
    wikiLinkSeparator: 'wikiLinkSeparator';
    wikiLinkEmbed: 'wikiLinkEmbed';
    wikiLinkEmbedBang: 'wikiLinkEmbedBang';
  }
}

const CODE_BANG = 33;
const CODE_LBRACKET = 91;
const CODE_RBRACKET = 93;
const CODE_PIPE = 124;
const CODE_HASH = 35;
const CODE_VIRTUAL_SPACE = -1;
const CODE_HORIZONTAL_TAB = -2;

function characterForCode(code: number): string {
  if (code === CODE_HORIZONTAL_TAB) return '\t';
  if (code === CODE_VIRTUAL_SPACE) return ' ';
  return String.fromCharCode(code);
}

const tokenizeWikiLink: Tokenizer = (effects, ok, nok) => {
  let anchorSize = 0;
  let aliasSize = 0;
  let targetRaw = '';

  return start;

  function start(code: number | null): State | undefined {
    if (code !== CODE_LBRACKET) return nok(code);
    effects.enter('wikiLink');
    effects.enter('wikiLinkMarker');
    effects.consume(code);
    return open2 as State;
  }

  function open2(code: number | null): State | undefined {
    if (code !== CODE_LBRACKET) return nok(code);
    effects.consume(code);
    effects.exit('wikiLinkMarker');
    effects.enter('wikiLinkTarget');
    return target as State;
  }

  function target(code: number | null): State | undefined {
    if (code === null || code === -5 || code === -4 || code === -3) return nok(code);
    if (code === CODE_LBRACKET) return nok(code);
    if (code === CODE_RBRACKET) {
      if (targetRaw.trim() === '') return nok(code);
      effects.exit('wikiLinkTarget');
      return close1(code);
    }
    if (code === CODE_HASH) {
      if (targetRaw.trim() === '') return nok(code);
      effects.exit('wikiLinkTarget');
      effects.enter('wikiLinkSeparator');
      effects.consume(code);
      effects.exit('wikiLinkSeparator');
      effects.enter('wikiLinkAnchor');
      return anchor as State;
    }
    if (code === CODE_PIPE) {
      if (separatorEscapeLeavesEmpty(targetRaw)) return nok(code);
      effects.exit('wikiLinkTarget');
      effects.enter('wikiLinkSeparator');
      effects.consume(code);
      effects.exit('wikiLinkSeparator');
      effects.enter('wikiLinkAlias');
      return alias as State;
    }
    effects.consume(code);
    targetRaw += characterForCode(code);
    return target as State;
  }

  function anchor(code: number | null): State | undefined {
    if (code === null || code === -5 || code === -4 || code === -3) return nok(code);
    if (code === CODE_LBRACKET) return nok(code);
    if (code === CODE_RBRACKET) {
      if (anchorSize === 0) return nok(code);
      effects.exit('wikiLinkAnchor');
      return close1(code);
    }
    if (code === CODE_PIPE) {
      if (anchorSize === 0) return nok(code);
      effects.exit('wikiLinkAnchor');
      effects.enter('wikiLinkSeparator');
      effects.consume(code);
      effects.exit('wikiLinkSeparator');
      effects.enter('wikiLinkAlias');
      return alias as State;
    }
    effects.consume(code);
    anchorSize++;
    return anchor as State;
  }

  function alias(code: number | null): State | undefined {
    if (code === null || code === -5 || code === -4 || code === -3) return nok(code);
    if (code === CODE_LBRACKET) return nok(code);
    if (code === CODE_RBRACKET) {
      if (aliasSize === 0) return nok(code);
      effects.exit('wikiLinkAlias');
      return close1(code);
    }
    effects.consume(code);
    aliasSize++;
    return alias as State;
  }

  function close1(code: number | null): State | undefined {
    if (code !== CODE_RBRACKET) return nok(code);
    effects.enter('wikiLinkMarker');
    effects.consume(code);
    return close2 as State;
  }

  function close2(code: number | null): State | undefined {
    if (code !== CODE_RBRACKET) return nok(code);
    effects.consume(code);
    effects.exit('wikiLinkMarker');
    effects.exit('wikiLink');
    return ok;
  }
};

const wikiLinkConstruct: Construct = {
  name: 'wikiLink',
  tokenize: tokenizeWikiLink,
};

const tokenizeWikiLinkEmbed: Tokenizer = (effects, ok, nok) => {
  let anchorSize = 0;
  let aliasSize = 0;
  let targetRaw = '';

  return start;

  function start(code: number | null): State | undefined {
    if (code !== CODE_BANG) return nok(code);
    effects.enter('wikiLinkEmbed');
    effects.enter('wikiLinkEmbedBang');
    effects.consume(code);
    effects.exit('wikiLinkEmbedBang');
    return open1 as State;
  }

  function open1(code: number | null): State | undefined {
    if (code !== CODE_LBRACKET) return nok(code);
    effects.enter('wikiLinkMarker');
    effects.consume(code);
    return open2 as State;
  }

  function open2(code: number | null): State | undefined {
    if (code !== CODE_LBRACKET) return nok(code);
    effects.consume(code);
    effects.exit('wikiLinkMarker');
    effects.enter('wikiLinkTarget');
    return target as State;
  }

  function target(code: number | null): State | undefined {
    if (code === null || code === -5 || code === -4 || code === -3) return nok(code);
    if (code === CODE_LBRACKET) return nok(code);
    if (code === CODE_RBRACKET) {
      if (targetRaw.trim() === '') return nok(code);
      effects.exit('wikiLinkTarget');
      return close1(code);
    }
    if (code === CODE_HASH) {
      if (targetRaw.trim() === '') return nok(code);
      effects.exit('wikiLinkTarget');
      effects.enter('wikiLinkSeparator');
      effects.consume(code);
      effects.exit('wikiLinkSeparator');
      effects.enter('wikiLinkAnchor');
      return anchor as State;
    }
    if (code === CODE_PIPE) {
      if (separatorEscapeLeavesEmpty(targetRaw)) return nok(code);
      effects.exit('wikiLinkTarget');
      effects.enter('wikiLinkSeparator');
      effects.consume(code);
      effects.exit('wikiLinkSeparator');
      effects.enter('wikiLinkAlias');
      return alias as State;
    }
    effects.consume(code);
    targetRaw += characterForCode(code);
    return target as State;
  }

  function anchor(code: number | null): State | undefined {
    if (code === null || code === -5 || code === -4 || code === -3) return nok(code);
    if (code === CODE_LBRACKET) return nok(code);
    if (code === CODE_RBRACKET) {
      if (anchorSize === 0) return nok(code);
      effects.exit('wikiLinkAnchor');
      return close1(code);
    }
    if (code === CODE_PIPE) {
      if (anchorSize === 0) return nok(code);
      effects.exit('wikiLinkAnchor');
      effects.enter('wikiLinkSeparator');
      effects.consume(code);
      effects.exit('wikiLinkSeparator');
      effects.enter('wikiLinkAlias');
      return alias as State;
    }
    effects.consume(code);
    anchorSize++;
    return anchor as State;
  }

  function alias(code: number | null): State | undefined {
    if (code === null || code === -5 || code === -4 || code === -3) return nok(code);
    if (code === CODE_LBRACKET) return nok(code);
    if (code === CODE_RBRACKET) {
      if (aliasSize === 0) return nok(code);
      effects.exit('wikiLinkAlias');
      return close1(code);
    }
    effects.consume(code);
    aliasSize++;
    return alias as State;
  }

  function close1(code: number | null): State | undefined {
    if (code !== CODE_RBRACKET) return nok(code);
    effects.enter('wikiLinkMarker');
    effects.consume(code);
    return close2 as State;
  }

  function close2(code: number | null): State | undefined {
    if (code !== CODE_RBRACKET) return nok(code);
    effects.consume(code);
    effects.exit('wikiLinkMarker');
    effects.exit('wikiLinkEmbed');
    return ok;
  }
};

const wikiLinkEmbedConstruct: Construct = {
  name: 'wikiLinkEmbed',
  tokenize: tokenizeWikiLinkEmbed,
};

export function wikiLinkSyntax(): Extension {
  return {
    text: {
      [CODE_LBRACKET]: wikiLinkConstruct,
      [CODE_BANG]: wikiLinkEmbedConstruct,
    },
  };
}

function enterWikiLink(this: CompileContext, token: Token) {
  this.enter(
    {
      type: 'wikiLink',
      value: '',
      data: { target: '', anchor: null, alias: null },
      children: [],
    } as unknown as Parameters<CompileContext['enter']>[0],
    token,
  );
}

function enterWikiLinkEmbed(this: CompileContext, token: Token) {
  this.enter(
    {
      type: 'wikiLinkEmbed',
      value: '',
      data: { target: '', anchor: null, alias: null },
      children: [],
    } as unknown as Parameters<CompileContext['enter']>[0],
    token,
  );
}

function topNode<T>(ctx: CompileContext): T {
  return ctx.stack[ctx.stack.length - 1] as unknown as T;
}

function exitTarget(this: CompileContext, token: Token) {
  const node = topNode<WikiLinkMdast | WikiLinkEmbedMdast>(this);
  const raw = this.sliceSerialize(token);
  node.data.target = raw.trim();
  if (raw !== node.data.target) {
    node.data.sourceTarget = raw;
  }
}

function exitAnchor(this: CompileContext, token: Token) {
  const node = topNode<WikiLinkMdast | WikiLinkEmbedMdast>(this);
  const raw = this.sliceSerialize(token);
  const trimmed = raw.trim();
  node.data.anchor = trimmed.length ? trimmed : null;
  if (node.data.anchor !== null && raw !== trimmed) {
    node.data.sourceAnchor = raw;
  }
}

function exitAlias(this: CompileContext, token: Token) {
  const node = topNode<WikiLinkMdast | WikiLinkEmbedMdast>(this);
  const raw = this.sliceSerialize(token);
  const trimmed = raw.trim();
  node.data.alias = trimmed.length ? trimmed : null;
  if (raw !== trimmed) {
    node.data.sourceAlias = raw;
  }
}

function normalizeSeparatorEscapes(node: WikiLinkMdast | WikiLinkEmbedMdast): void {
  const before = {
    target: node.data.target,
    anchor: node.data.anchor ?? null,
    alias: node.data.alias ?? null,
  };
  const after = normalizeWikiSeparatorEscapes(before, {
    separatorCrossed: before.alias !== null || node.data.sourceAlias != null,
  });

  if (after.target !== before.target) {
    node.data.sourceTarget ??= before.target;
    node.data.target = after.target;
  }
  if (after.anchor !== before.anchor) {
    node.data.sourceAnchor ??= before.anchor;
    node.data.anchor = after.anchor;
  }
  if (after.alias !== before.alias) {
    node.data.sourceAlias ??= before.alias;
    node.data.alias = after.alias;
  }
}

function finalizeLabel(node: WikiLinkMdast | WikiLinkEmbedMdast): void {
  normalizeSeparatorEscapes(node);
  const { target, anchor, alias } = node.data;
  const label = alias ? alias : anchor ? `${target}#${anchor}` : target;
  node.value = label;
  node.children = [{ type: 'text', value: label }];
}

function exitWikiLink(this: CompileContext, token: Token) {
  finalizeLabel(topNode<WikiLinkMdast>(this));
  this.exit(token);
}

function exitWikiLinkEmbed(this: CompileContext, token: Token) {
  finalizeLabel(topNode<WikiLinkEmbedMdast>(this));
  this.exit(token);
}

export const wikiLinkFromMarkdown: FromMarkdownExtension = {
  enter: {
    wikiLink: enterWikiLink,
    wikiLinkEmbed: enterWikiLinkEmbed,
  },
  exit: {
    wikiLinkTarget: exitTarget,
    wikiLinkAnchor: exitAnchor,
    wikiLinkAlias: exitAlias,
    wikiLink: exitWikiLink,
    wikiLinkEmbed: exitWikiLinkEmbed,
  },
};

function wikiLinkToMarkdownHandler(opener: string): ToMarkdownHandle {
  return (node: WikiLinkMdast | WikiLinkEmbedMdast, _parent, state, _info) => {
    const data = node.data;
    const inTableCell = state.stack.includes('tableCell');
    const safe = (bytes: string): string => (inTableCell ? escapeTableCellPipes(bytes) : bytes);
    const target = data?.target ?? '';
    const anchor = data?.anchor;
    const alias = data?.alias;
    let out = `${opener}${safe(rawSegmentOr(data?.sourceTarget, target, 'separatorAdjacent'))}`;
    if (anchor) {
      out += `#${safe(rawSegmentOr(data?.sourceAnchor, anchor, 'separatorAdjacent'))}`;
    } else {
      const emptyAnchorRaw = safe(rawSegmentOr(data?.sourceAnchor, '', 'separatorAdjacent'));
      if (emptyAnchorRaw.length > 0) out += `#${emptyAnchorRaw}`;
    }
    const aliasSegment = alias
      ? rawSegmentOr(data?.sourceAlias, alias, 'alias')
      : rawSegmentOr(data?.sourceAlias, '', 'alias');
    if (aliasSegment.length > 0) {
      const separator = inTableCell && !out.endsWith('\\') ? '\\|' : '|';
      out += `${separator}${safe(aliasSegment)}`;
    }
    return `${out}]]`;
  };
}

const wikiLinkHandler: ToMarkdownHandle = wikiLinkToMarkdownHandler('[[');

const wikiLinkEmbedHandler: ToMarkdownHandle = wikiLinkToMarkdownHandler('![[');

export const wikiLinkToMarkdown: {
  handlers: Record<string, ToMarkdownHandle>;
  unsafe: Array<{ character: string; inConstruct: string[] }>;
} = {
  handlers: {
    wikiLink: wikiLinkHandler,
    wikiLinkEmbed: wikiLinkEmbedHandler,
  },
  unsafe: [{ character: '[', inConstruct: ['phrasing'] }],
};

const MICROMARK_EXT = wikiLinkSyntax();

export function remarkWikiLink(this: Processor) {
  const data = this.data() as {
    micromarkExtensions?: unknown[];
    fromMarkdownExtensions?: unknown[];
    toMarkdownExtensions?: unknown[];
  };

  data.micromarkExtensions ||= [];
  if (!data.micromarkExtensions.some((e) => e === MICROMARK_EXT)) {
    data.micromarkExtensions.push(MICROMARK_EXT);
  }

  data.fromMarkdownExtensions ||= [];
  if (!data.fromMarkdownExtensions.some((e) => e === wikiLinkFromMarkdown)) {
    data.fromMarkdownExtensions.push(wikiLinkFromMarkdown);
  }

  data.toMarkdownExtensions ||= [];
  if (!data.toMarkdownExtensions.some((e) => e === wikiLinkToMarkdown)) {
    data.toMarkdownExtensions.push(wikiLinkToMarkdown);
  }
}
