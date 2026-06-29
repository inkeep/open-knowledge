import { describe, expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import {
  EMPHASIS_STAR_INPUT_RE,
  EMPHASIS_UNDERSCORE_INPUT_RE,
  EmphasisFidelity,
  STRONG_STAR_INPUT_RE,
  STRONG_UNDERSCORE_INPUT_RE,
  StrongFidelity,
} from './emphasis-fidelity.ts';
import { sharedExtensions } from './shared.ts';

const schema = getSchema(sharedExtensions);

function buildState(text: string): { state: EditorState; from: number; to: number } {
  const para = schema.nodes.paragraph.createAndFill(null, schema.text(text));
  if (!para) throw new Error('failed to create paragraph node for test');
  const doc = schema.nodes.doc.createAndFill(null, para);
  if (!doc) throw new Error('failed to create doc node for test');
  const from = 1;
  const to = 1 + text.length;
  const state = EditorState.create({ schema, doc });
  return { state, from, to };
}

function fireRule(
  rule: {
    handler: (props: {
      state: EditorState;
      range: { from: number; to: number };
      match: RegExpExecArray;
    }) => unknown;
  },
  text: string,
  re: RegExp,
) {
  const { state, from, to } = buildState(text);
  const match = re.exec(text);
  if (!match) throw new Error(`regex ${re} did not match ${JSON.stringify(text)}`);
  const tr = state.tr;
  const wrappedState = new Proxy(state, {
    get(target, prop, recv) {
      if (prop === 'tr') return tr;
      return Reflect.get(target, prop, recv);
    },
  });
  rule.handler({ state: wrappedState as EditorState, range: { from, to }, match });
  return tr;
}

describe('emphasis input rule regexes (FR-25)', () => {
  test('EMPHASIS_STAR_INPUT_RE matches `*foo*`', () => {
    const m = ' *foo*'.match(EMPHASIS_STAR_INPUT_RE);
    expect(m).not.toBeNull();
    expect(m?.[2]).toBe('foo');
  });

  test('EMPHASIS_UNDERSCORE_INPUT_RE matches `_foo_`', () => {
    const m = ' _foo_'.match(EMPHASIS_UNDERSCORE_INPUT_RE);
    expect(m).not.toBeNull();
    expect(m?.[2]).toBe('foo');
  });

  test('EMPHASIS_STAR_INPUT_RE rejects `**foo**` (handled by strong rule)', () => {
    expect(' **foo**'.match(EMPHASIS_STAR_INPUT_RE)).toBeNull();
  });

  test('EMPHASIS_UNDERSCORE_INPUT_RE rejects `__foo__` (handled by strong rule)', () => {
    expect(' __foo__'.match(EMPHASIS_UNDERSCORE_INPUT_RE)).toBeNull();
  });
});

describe('strong input rule regexes (FR-25)', () => {
  test('STRONG_STAR_INPUT_RE matches `**foo**`', () => {
    const m = ' **foo**'.match(STRONG_STAR_INPUT_RE);
    expect(m).not.toBeNull();
    expect(m?.[2]).toBe('foo');
  });

  test('STRONG_UNDERSCORE_INPUT_RE matches `__foo__`', () => {
    const m = ' __foo__'.match(STRONG_UNDERSCORE_INPUT_RE);
    expect(m).not.toBeNull();
    expect(m?.[2]).toBe('foo');
  });
});

describe('EmphasisFidelity addInputRules wires getAttributes (FR-25)', () => {
  function getRules<T extends { config: { name: string; addInputRules?: () => unknown[] } }>(
    ext: T,
    markName: string,
  ) {
    const type = schema.marks[markName];
    expect(type).toBeDefined();
    const ctx = { type };
    return ((ext.config.addInputRules as undefined | ((this: typeof ctx) => unknown[]))?.call(
      ctx,
    ) ?? []) as Array<{
      find: RegExp;
      handler: (props: {
        state: EditorState;
        range: { from: number; to: number };
        match: RegExpExecArray;
      }) => unknown;
    }>;
  }

  test('EmphasisFidelity exposes 2 input rules (star + underscore)', () => {
    const rules = getRules(EmphasisFidelity, 'emphasis');
    expect(rules).toHaveLength(2);
    expect(rules[0].find).toBe(EMPHASIS_STAR_INPUT_RE);
    expect(rules[1].find).toBe(EMPHASIS_UNDERSCORE_INPUT_RE);
  });

  test('star rule applies sourceDelimiter="*" mark', () => {
    const rules = getRules(EmphasisFidelity, 'emphasis');
    const tr = fireRule(rules[0], '*foo*', EMPHASIS_STAR_INPUT_RE);
    const marks = tr.doc.nodeAt(1)?.marks ?? [];
    const emph = marks.find((m) => m.type.name === 'emphasis');
    expect(emph).toBeDefined();
    expect(emph?.attrs.sourceDelimiter).toBe('*');
  });

  test('underscore rule applies sourceDelimiter="_" mark', () => {
    const rules = getRules(EmphasisFidelity, 'emphasis');
    const tr = fireRule(rules[1], '_foo_', EMPHASIS_UNDERSCORE_INPUT_RE);
    const marks = tr.doc.nodeAt(1)?.marks ?? [];
    const emph = marks.find((m) => m.type.name === 'emphasis');
    expect(emph).toBeDefined();
    expect(emph?.attrs.sourceDelimiter).toBe('_');
  });

  test('StrongFidelity exposes 2 input rules (star + underscore)', () => {
    const rules = getRules(StrongFidelity, 'strong');
    expect(rules).toHaveLength(2);
    expect(rules[0].find).toBe(STRONG_STAR_INPUT_RE);
    expect(rules[1].find).toBe(STRONG_UNDERSCORE_INPUT_RE);
  });

  test('star rule applies sourceDelimiter="**" mark', () => {
    const rules = getRules(StrongFidelity, 'strong');
    const tr = fireRule(rules[0], '**foo**', STRONG_STAR_INPUT_RE);
    const marks = tr.doc.nodeAt(1)?.marks ?? [];
    const strong = marks.find((m) => m.type.name === 'strong');
    expect(strong).toBeDefined();
    expect(strong?.attrs.sourceDelimiter).toBe('**');
  });

  test('underscore rule applies sourceDelimiter="__" mark', () => {
    const rules = getRules(StrongFidelity, 'strong');
    const tr = fireRule(rules[1], '__foo__', STRONG_UNDERSCORE_INPUT_RE);
    const marks = tr.doc.nodeAt(1)?.marks ?? [];
    const strong = marks.find((m) => m.type.name === 'strong');
    expect(strong).toBeDefined();
    expect(strong?.attrs.sourceDelimiter).toBe('__');
  });
});

describe('schema defaults preserved when no input rule fires (FR-25)', () => {
  test('emphasis mark default sourceDelimiter is "*"', () => {
    const mark = schema.marks.emphasis.create();
    expect(mark.attrs.sourceDelimiter).toBe('*');
  });

  test('strong mark default sourceDelimiter is "**"', () => {
    const mark = schema.marks.strong.create();
    expect(mark.attrs.sourceDelimiter).toBe('**');
  });
});
