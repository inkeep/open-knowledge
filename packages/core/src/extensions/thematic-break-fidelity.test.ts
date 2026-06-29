import { describe, expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { sharedExtensions } from './shared.ts';
import {
  THEMATIC_BREAK_INPUT_RE,
  ThematicBreakFidelity,
  thematicBreakSourceRawFromMatch,
} from './thematic-break-fidelity.ts';

const schema = getSchema(sharedExtensions);

function buildState(text: string): { state: EditorState; from: number; to: number } {
  const para =
    text.length > 0
      ? schema.nodes.paragraph.createAndFill(null, schema.text(text))
      : schema.nodes.paragraph.createAndFill(null);
  if (!para) throw new Error('failed to create paragraph node for test');
  const doc = schema.nodes.doc.createAndFill(null, para);
  if (!doc) throw new Error('failed to create doc node for test');
  const from = 1;
  const to = 1 + text.length;
  const state = EditorState.create({ schema, doc });
  return { state, from, to };
}

function getRules<T extends { config: { name: string; addInputRules?: () => unknown[] } }>(
  ext: T,
  nodeName: string,
) {
  const type = schema.nodes[nodeName];
  expect(type).toBeDefined();
  const ctx = { type };
  return ((ext.config.addInputRules as undefined | ((this: typeof ctx) => unknown[]))?.call(ctx) ??
    []) as Array<{
    find: RegExp;
    handler: (props: {
      state: EditorState;
      range: { from: number; to: number };
      match: RegExpExecArray;
    }) => unknown;
  }>;
}

function fireRule(rule: ReturnType<typeof getRules>[number], text: string) {
  const { state, from, to } = buildState(text);
  const match = THEMATIC_BREAK_INPUT_RE.exec(text);
  if (!match) throw new Error(`regex did not match ${JSON.stringify(text)}`);
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

describe('thematic break input rule regex (FR-25)', () => {
  test('matches `---`', () => {
    expect(THEMATIC_BREAK_INPUT_RE.test('---')).toBe(true);
  });

  test('matches `___ ` (with trailing space)', () => {
    expect(THEMATIC_BREAK_INPUT_RE.test('___ ')).toBe(true);
  });

  test('matches `*** ` (with trailing space)', () => {
    expect(THEMATIC_BREAK_INPUT_RE.test('*** ')).toBe(true);
  });

  test('matches `—-` em-dash quirk', () => {
    expect(THEMATIC_BREAK_INPUT_RE.test('—-')).toBe(true);
  });

  test('does NOT match `--` (only 2 dashes)', () => {
    expect(THEMATIC_BREAK_INPUT_RE.test('--')).toBe(false);
  });

  test('does NOT match `___` without trailing space', () => {
    expect(THEMATIC_BREAK_INPUT_RE.test('___')).toBe(false);
  });

  test('does NOT match `***` without trailing space', () => {
    expect(THEMATIC_BREAK_INPUT_RE.test('***')).toBe(false);
  });
});

describe('thematicBreakSourceRawFromMatch helper (FR-25)', () => {
  test('preserves `---` verbatim', () => {
    expect(thematicBreakSourceRawFromMatch(['---'])).toBe('---');
  });

  test('strips trailing whitespace from `___ `', () => {
    expect(thematicBreakSourceRawFromMatch(['___ '])).toBe('___');
  });

  test('strips trailing whitespace from `*** `', () => {
    expect(thematicBreakSourceRawFromMatch(['*** '])).toBe('***');
  });

  test('canonicalizes `—-` to `---` (em-dash is not valid CommonMark)', () => {
    expect(thematicBreakSourceRawFromMatch(['—-'])).toBe('---');
  });

  test('preserves `***` (no trailing space)', () => {
    expect(thematicBreakSourceRawFromMatch(['***'])).toBe('***');
  });
});

describe('ThematicBreakFidelity addInputRules wires getAttributes (FR-25)', () => {
  test('exposes a single input rule', () => {
    const rules = getRules(ThematicBreakFidelity, 'thematicBreak');
    expect(rules).toHaveLength(1);
    expect(rules[0].find).toBe(THEMATIC_BREAK_INPUT_RE);
  });

  test('`---` rule applies sourceRaw="---"', () => {
    const rules = getRules(ThematicBreakFidelity, 'thematicBreak');
    const tr = fireRule(rules[0], '---');
    let found: unknown;
    tr.doc.descendants((n) => {
      if (n.type.name === 'thematicBreak') found = n.attrs;
    });
    expect(found).toBeDefined();
    expect((found as { sourceRaw: string }).sourceRaw).toBe('---');
  });

  test('`*** ` rule applies sourceRaw="***" (trailing space stripped)', () => {
    const rules = getRules(ThematicBreakFidelity, 'thematicBreak');
    const tr = fireRule(rules[0], '*** ');
    let found: unknown;
    tr.doc.descendants((n) => {
      if (n.type.name === 'thematicBreak') found = n.attrs;
    });
    expect(found).toBeDefined();
    expect((found as { sourceRaw: string }).sourceRaw).toBe('***');
  });

  test('`___ ` rule applies sourceRaw="___" (trailing space stripped)', () => {
    const rules = getRules(ThematicBreakFidelity, 'thematicBreak');
    const tr = fireRule(rules[0], '___ ');
    let found: unknown;
    tr.doc.descendants((n) => {
      if (n.type.name === 'thematicBreak') found = n.attrs;
    });
    expect(found).toBeDefined();
    expect((found as { sourceRaw: string }).sourceRaw).toBe('___');
  });

  test('em-dash `—-` rule canonicalizes to sourceRaw="---"', () => {
    const rules = getRules(ThematicBreakFidelity, 'thematicBreak');
    const tr = fireRule(rules[0], '—-');
    let found: unknown;
    tr.doc.descendants((n) => {
      if (n.type.name === 'thematicBreak') found = n.attrs;
    });
    expect(found).toBeDefined();
    expect((found as { sourceRaw: string }).sourceRaw).toBe('---');
  });
});

describe('schema default preserved when no input rule fires (FR-25)', () => {
  test('thematicBreak default sourceRaw is "---"', () => {
    const node = schema.nodes.thematicBreak.create();
    expect(node.attrs.sourceRaw).toBe('---');
  });
});
