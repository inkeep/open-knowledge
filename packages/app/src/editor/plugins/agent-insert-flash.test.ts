import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, test } from 'vitest';
import {
  AGENT_INSERT_FLASH_MS,
  agentInsertFlashKey,
  blockRangeToPositions,
  computeChangedRange,
  createAgentInsertFlashPlugin,
} from './agent-insert-flash';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] },
    text: {},
  },
});

const para = (text: string) => schema.node('paragraph', null, text ? [schema.text(text)] : []);
const doc = (...texts: string[]) => schema.node('doc', null, texts.map(para));

function makeState() {
  return EditorState.create({
    schema,
    doc: doc('alpha', 'omega'),
    plugins: [createAgentInsertFlashPlugin()],
  });
}

describe('computeChangedRange', () => {
  test('identical docs → null', () => {
    expect(computeChangedRange(doc('alpha', 'omega'), doc('alpha', 'omega'))).toBeNull();
  });

  test('an appended paragraph is the only changed range (not the whole doc)', () => {
    const before = doc('alpha', 'omega');
    const after = doc('alpha', 'omega', 'appended');
    const range = computeChangedRange(before, after);
    expect(range).not.toBeNull();
    expect(range?.from).toBeGreaterThanOrEqual(before.content.size - 1);
    expect(range?.to).toBeGreaterThan(range?.from ?? 0);
    expect(range?.to).toBeLessThanOrEqual(after.content.size);
  });

  test('an edited middle paragraph is bounded to that paragraph', () => {
    const before = doc('alpha', 'middle', 'omega');
    const after = doc('alpha', 'MIDDLE-edited', 'omega');
    const range = computeChangedRange(before, after);
    expect(range).not.toBeNull();
    expect(range?.from).toBeGreaterThan(0);
    expect(range?.to).toBeLessThan(after.content.size);
  });

  test('a prepended paragraph starts at the top', () => {
    const range = computeChangedRange(doc('omega'), doc('alpha', 'omega'));
    expect(range?.from).toBeLessThanOrEqual(1);
  });

  test('pure deletion yields no positive range', () => {
    const range = computeChangedRange(doc('alpha', 'omega'), doc('alpha'));
    expect(range === null || range.to <= range.from).toBe(true);
  });
});

describe('blockRangeToPositions', () => {
  test('maps an appended block index to its tail PM range', () => {
    const range = blockRangeToPositions(doc('alpha', 'omega', 'appended'), 2, 3);
    expect(range).toEqual({ from: 14, to: 24 });
  });

  test('maps the first block from the top', () => {
    expect(blockRangeToPositions(doc('alpha', 'omega'), 0, 1)).toEqual({ from: 0, to: 7 });
  });

  test('spans multiple blocks', () => {
    expect(blockRangeToPositions(doc('alpha', 'omega', 'appended'), 0, 2)).toEqual({
      from: 0,
      to: 14,
    });
  });

  test('empty range → null', () => {
    expect(blockRangeToPositions(doc('alpha'), 1, 1)).toBeNull();
  });

  test('out-of-bounds `to` clamps to the tail; fully-past range → null', () => {
    expect(blockRangeToPositions(doc('alpha', 'omega'), 1, 9)).toEqual({ from: 7, to: 14 });
    expect(blockRangeToPositions(doc('alpha', 'omega'), 5, 9)).toBeNull();
  });
});

describe('agent-insert-flash plugin', () => {
  test('add meta decorates; sweep removes only expired decorations', () => {
    let state = makeState();
    const t0 = 1_000_000;

    state = state.apply(
      state.tr.setMeta(agentInsertFlashKey, { add: { from: 1, to: 6 }, now: t0 }),
    );
    expect(agentInsertFlashKey.getState(state)?.find()).toHaveLength(1);

    const t1 = t0 + AGENT_INSERT_FLASH_MS / 2;
    state = state.apply(
      state.tr.setMeta(agentInsertFlashKey, { add: { from: 8, to: 13 }, now: t1 }),
    );
    expect(agentInsertFlashKey.getState(state)?.find()).toHaveLength(2);

    const t2 = t0 + AGENT_INSERT_FLASH_MS + 1;
    state = state.apply(state.tr.setMeta(agentInsertFlashKey, { now: t2, sweep: true }));
    const remaining = agentInsertFlashKey.getState(state)?.find() ?? [];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.from).toBe(8);

    const t3 = t1 + AGENT_INSERT_FLASH_MS + 1;
    state = state.apply(state.tr.setMeta(agentInsertFlashKey, { now: t3, sweep: true }));
    expect(agentInsertFlashKey.getState(state)?.find()).toHaveLength(0);
  });

  test('decorations map through unrelated document changes', () => {
    let state = makeState();
    state = state.apply(
      state.tr.setMeta(agentInsertFlashKey, { add: { from: 8, to: 13 }, now: 1 }),
    );
    state = state.apply(state.tr.insertText('shift', 2));
    const decos = agentInsertFlashKey.getState(state)?.find() ?? [];
    expect(decos).toHaveLength(1);
    expect(decos[0]?.from).toBe(13);
  });
});
