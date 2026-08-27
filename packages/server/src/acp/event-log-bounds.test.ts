import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { CodexLegacyAgentIdentity } from '@inkeep/open-knowledge-core/acp/codex-legacy-notice';
import type { ThreadEvent } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { describe, expect, test } from 'vitest';
import fixture from '../../../../test-support/fixtures/codex-legacy-warning-envelopes.json' with {
  type: 'json',
};
import { boundSessionUpdateForLog, coalesceChunkInto } from './event-log-bounds.ts';

const big = 'x'.repeat(50_000);

const CODEX: CodexLegacyAgentIdentity = fixture.agents.codexRegistry;
const CODEX_CUSTOM: CodexLegacyAgentIdentity = fixture.agents.codexCustom;
const OTHER_AGENT: CodexLegacyAgentIdentity = fixture.agents.claudeRegistry;

/** A `session_update` transcript event carrying a streamed text chunk. */
function chunk(
  sessionUpdate: string,
  text: string,
  extra: { messageId?: string; type?: string } = {},
): ThreadEvent {
  const content = extra.type === undefined ? { type: 'text', text } : { type: extra.type, text };
  const update = { sessionUpdate, content } as Record<string, unknown>;
  if (extra.messageId !== undefined) update.messageId = extra.messageId;
  return { kind: 'session_update', update: update as unknown as SessionUpdate, ts: 1 };
}

/** Read the folded text off a `session_update` chunk event. */
function textOf(event: ThreadEvent): string {
  if (event.kind !== 'session_update') throw new Error('not a session_update');
  return (event.update as unknown as { content: { text: string } }).content.text;
}

describe('boundSessionUpdateForLog', () => {
  test('oversized diff payloads are truncated with a marker', () => {
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      content: [{ type: 'diff', path: 'a.md', oldText: big, newText: big }],
    } as unknown as SessionUpdate;
    const bounded = boundSessionUpdateForLog(update) as unknown as {
      content: Array<{ oldText: string; newText: string }>;
    };
    expect(bounded).not.toBe(update);
    expect(bounded.content[0].oldText.length).toBeLessThan(17_000);
    expect(bounded.content[0].oldText).toContain('[truncated');
    expect(bounded.content[0].newText).toContain('[truncated');
  });

  test('oversized text content blocks are truncated', () => {
    const update = {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      content: [{ type: 'content', content: { type: 'text', text: big } }],
    } as unknown as SessionUpdate;
    const bounded = boundSessionUpdateForLog(update) as unknown as {
      content: Array<{ content: { text: string } }>;
    };
    expect(bounded.content[0].content.text.length).toBeLessThan(17_000);
  });

  test('within-cap updates pass through by reference (no allocation)', () => {
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      content: [{ type: 'diff', path: 'a.md', oldText: 'small', newText: 'tiny' }],
    } as unknown as SessionUpdate;
    expect(boundSessionUpdateForLog(update)).toBe(update);
  });

  test('non-tool updates pass through by reference', () => {
    const update = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: big },
    } as unknown as SessionUpdate;
    // Message chunks arrive pre-chunked by the agent; only tool payloads
    // carry whole-file text.
    expect(boundSessionUpdateForLog(update)).toBe(update);
  });
});

describe('coalesceChunkInto', () => {
  test('folds consecutive same-stream text chunks into the tail, in order', () => {
    const prev = chunk('agent_message_chunk', 'Hello');
    expect(coalesceChunkInto(prev, chunk('agent_message_chunk', ', '), CODEX)).toBe(true);
    expect(coalesceChunkInto(prev, chunk('agent_message_chunk', 'world'), CODEX)).toBe(true);
    expect(textOf(prev)).toBe('Hello, world');
  });

  test('folds thought and user chunks too (both coalesce client-side)', () => {
    const thought = chunk('agent_thought_chunk', 'think');
    expect(coalesceChunkInto(thought, chunk('agent_thought_chunk', 'ing'), CODEX)).toBe(true);
    expect(textOf(thought)).toBe('thinking');
    const user = chunk('user_message_chunk', 'a');
    expect(coalesceChunkInto(user, chunk('user_message_chunk', 'b'), CODEX)).toBe(true);
    expect(textOf(user)).toBe('ab');
  });

  test('does not fold across differing chunk kinds', () => {
    const message = chunk('agent_message_chunk', 'answer');
    expect(coalesceChunkInto(message, chunk('agent_thought_chunk', 'thought'), CODEX)).toBe(false);
    expect(textOf(message)).toBe('answer');
  });

  test('does not fold non-streaming session updates', () => {
    const toolCall = chunk('tool_call', 'x');
    expect(coalesceChunkInto(toolCall, chunk('tool_call', 'y'), CODEX)).toBe(false);
  });

  test('does not fold across differing messageId (separate bubbles client-side)', () => {
    const a = chunk('agent_message_chunk', 'a', { messageId: 'm1' });
    expect(
      coalesceChunkInto(a, chunk('agent_message_chunk', 'b', { messageId: 'm2' }), CODEX),
    ).toBe(false);
    // Same explicit messageId still folds.
    const c = chunk('agent_message_chunk', 'c', { messageId: 'm1' });
    expect(
      coalesceChunkInto(c, chunk('agent_message_chunk', 'd', { messageId: 'm1' }), CODEX),
    ).toBe(true);
    expect(textOf(c)).toBe('cd');
  });

  test('missing messageId matches missing messageId (both default)', () => {
    const a = chunk('agent_message_chunk', 'a');
    expect(coalesceChunkInto(a, chunk('agent_message_chunk', 'b'), CODEX)).toBe(true);
    expect(textOf(a)).toBe('ab');
  });

  test('does not fold when either side is non-text content (image chunk)', () => {
    const image = chunk('agent_message_chunk', '', { type: 'image' });
    expect(coalesceChunkInto(image, chunk('agent_message_chunk', 'text'), CODEX)).toBe(false);
    const text = chunk('agent_message_chunk', 'text');
    expect(
      coalesceChunkInto(text, chunk('agent_message_chunk', '', { type: 'image' }), CODEX),
    ).toBe(false);
  });

  test('does not fold non-session_update events', () => {
    const userMsg: ThreadEvent = { kind: 'user_message', content: 'hi', ts: 1 };
    expect(coalesceChunkInto(userMsg, chunk('agent_message_chunk', 'x'), CODEX)).toBe(false);
    expect(coalesceChunkInto(chunk('agent_message_chunk', 'x'), userMsg, CODEX)).toBe(false);
  });

  test('stops folding once the tail hits the size cap (bounds one line)', () => {
    const prev = chunk('agent_message_chunk', 'x'.repeat(16_000));
    // At the cap: refuses further folds so no single line grows unbounded.
    expect(coalesceChunkInto(prev, chunk('agent_message_chunk', 'more'), CODEX)).toBe(false);
    expect(textOf(prev)).toBe('x'.repeat(16_000));
    // Just under the cap still folds once (may exceed the cap by the added
    // chunk — the cap gates the NEXT fold, it doesn't truncate).
    const under = chunk('agent_message_chunk', 'y'.repeat(15_999));
    expect(coalesceChunkInto(under, chunk('agent_message_chunk', 'zz'), CODEX)).toBe(true);
    expect(coalesceChunkInto(under, chunk('agent_message_chunk', 'no'), CODEX)).toBe(false);
  });
});

describe('coalesceChunkInto — terminal output', () => {
  const terminalChunk = (terminalId: string, chunk: string): ThreadEvent => ({
    kind: 'terminal_output',
    terminalId,
    chunk,
    ts: 1,
  });

  test('folds consecutive chunks of the same terminal', () => {
    const prev = terminalChunk('t1', 'line one\n');
    expect(coalesceChunkInto(prev, terminalChunk('t1', 'line two\n'), CODEX)).toBe(true);
    if (prev.kind !== 'terminal_output') throw new Error('unreachable');
    expect(prev.chunk).toBe('line one\nline two\n');
  });

  test('does not fold across terminals or event kinds', () => {
    const prev = terminalChunk('t1', 'a');
    expect(coalesceChunkInto(prev, terminalChunk('t2', 'b'), CODEX)).toBe(false);
    expect(
      coalesceChunkInto(
        prev,
        {
          kind: 'terminal_exit',
          terminalId: 't1',
          exitCode: 0,
          signal: null,
          ts: 2,
        },
        CODEX,
      ),
    ).toBe(false);
  });

  test('stops folding once the tail chunk hits the size cap', () => {
    const prev = terminalChunk('t1', 'x'.repeat(16_000));
    expect(coalesceChunkInto(prev, terminalChunk('t1', 'more'), CODEX)).toBe(false);
  });
});

describe('coalesceChunkInto — Codex legacy warning boundaries', () => {
  /**
   * A retained event carrying one of the fixture's recorded producer envelopes.
   * Cloned because a fold mutates `prev` in place, and the fixture objects are
   * shared across every test in this file.
   */
  const recorded = (name: string): ThreadEvent => {
    const candidate = fixture.candidates.find((c) => c.name === name);
    if (candidate === undefined) throw new Error(`no recorded candidate '${name}'`);
    return {
      kind: 'session_update',
      update: structuredClone(candidate.update) as unknown as SessionUpdate,
      ts: 1,
    };
  };
  const neighbor = (name: 'contextCompacted' | 'turnError'): ThreadEvent => ({
    kind: 'session_update',
    update: structuredClone(fixture.neighbors[name].update) as unknown as SessionUpdate,
    ts: 1,
  });
  const nearMiss = (negative: { update: unknown }): ThreadEvent => ({
    kind: 'session_update',
    update: structuredClone(negative.update) as SessionUpdate,
    ts: 1,
  });

  test('a warning does not absorb the no-ID chrome that follows it', () => {
    const warning = recorded('warning-skills-budget');
    const before = textOf(warning);

    expect(coalesceChunkInto(warning, neighbor('contextCompacted'), CODEX)).toBe(false);
    expect(textOf(warning)).toBe(before);
  });

  test('no-ID chrome does not absorb the warning that follows it', () => {
    const chrome = neighbor('contextCompacted');
    const before = textOf(chrome);

    expect(coalesceChunkInto(chrome, recorded('warning-skills-budget'), CODEX)).toBe(false);
    expect(textOf(chrome)).toBe(before);
  });

  test('two adjacent warnings stay two events', () => {
    const first = recorded('warning-skills-budget');
    const before = textOf(first);

    expect(coalesceChunkInto(first, recorded('config-warning-summary-only'), CODEX)).toBe(false);
    expect(textOf(first)).toBe(before);
  });

  test('a config warning carrying internal blank lines is preserved whole', () => {
    const configWarning = recorded('config-warning-with-details');
    const before = textOf(configWarning);

    expect(before).toContain('\n\n-');
    expect(coalesceChunkInto(configWarning, neighbor('turnError'), CODEX)).toBe(false);
    expect(textOf(configWarning)).toBe(before);
  });

  test('ordinary no-ID Codex chrome still coalesces exactly as before', () => {
    const chrome = neighbor('contextCompacted');
    const joined = textOf(chrome) + textOf(neighbor('turnError'));

    expect(coalesceChunkInto(chrome, neighbor('turnError'), CODEX)).toBe(true);
    expect(textOf(chrome)).toBe(joined);
  });

  test('the same envelope from another registry agent coalesces unchanged', () => {
    const warning = recorded('warning-skills-budget');
    const joined = textOf(warning) + textOf(neighbor('contextCompacted'));

    expect(coalesceChunkInto(warning, neighbor('contextCompacted'), OTHER_AGENT)).toBe(true);
    expect(textOf(warning)).toBe(joined);
  });

  test('a custom agent reusing the Codex id coalesces unchanged', () => {
    const warning = recorded('warning-skills-budget');

    expect(coalesceChunkInto(warning, neighbor('contextCompacted'), CODEX_CUSTOM)).toBe(true);
  });

  test.each(
    fixture.negatives.map((n) => [n.name, n] as const),
  )('near miss %s folds as if the guard were not there', (_name, negative) => {
    // Whether a near miss folds at all is the ordinary predicate's business —
    // kind, messageId, and content shape. What must never happen is the guard
    // firing on one and inventing a boundary the producer never drew, so the
    // oracle is the verdict under an identity the guard can never match.
    // A few negatives are near misses only BECAUSE of their agent, which is
    // the identity the fixture records alongside them.
    const agentKey = (negative as { agent?: string }).agent;
    const declared =
      agentKey === undefined
        ? CODEX
        : (fixture.agents as Record<string, CodexLegacyAgentIdentity>)[agentKey];

    const asDeclared = coalesceChunkInto(
      nearMiss(negative),
      neighbor('contextCompacted'),
      declared,
    );
    const guardUnreachable = coalesceChunkInto(
      nearMiss(negative),
      neighbor('contextCompacted'),
      OTHER_AGENT,
    );

    expect(asDeclared).toBe(guardUnreachable);
  });

  test('a warning is preserved even when the neighbour would otherwise fold', () => {
    // The chrome pair folds (proved above), so refusing here isolates the
    // warning rather than reflecting a pair that was never mergeable.
    const chrome = neighbor('turnError');

    expect(coalesceChunkInto(chrome, recorded('config-warning-summary-only'), CODEX)).toBe(false);
  });

  test('terminal output is unaffected by the agent identity', () => {
    const prev: ThreadEvent = { kind: 'terminal_output', terminalId: 't1', chunk: 'a', ts: 1 };
    const next: ThreadEvent = { kind: 'terminal_output', terminalId: 't1', chunk: 'b', ts: 2 };

    expect(coalesceChunkInto(prev, next, CODEX)).toBe(true);
  });
});
