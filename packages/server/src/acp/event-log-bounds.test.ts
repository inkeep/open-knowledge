import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { ThreadEvent } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { describe, expect, test } from 'vitest';
import { boundSessionUpdateForLog, coalesceChunkInto } from './event-log-bounds.ts';

const big = 'x'.repeat(50_000);

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
    expect(coalesceChunkInto(prev, chunk('agent_message_chunk', ', '))).toBe(true);
    expect(coalesceChunkInto(prev, chunk('agent_message_chunk', 'world'))).toBe(true);
    expect(textOf(prev)).toBe('Hello, world');
  });

  test('folds thought and user chunks too (both coalesce client-side)', () => {
    const thought = chunk('agent_thought_chunk', 'think');
    expect(coalesceChunkInto(thought, chunk('agent_thought_chunk', 'ing'))).toBe(true);
    expect(textOf(thought)).toBe('thinking');
    const user = chunk('user_message_chunk', 'a');
    expect(coalesceChunkInto(user, chunk('user_message_chunk', 'b'))).toBe(true);
    expect(textOf(user)).toBe('ab');
  });

  test('does not fold across differing chunk kinds', () => {
    const message = chunk('agent_message_chunk', 'answer');
    expect(coalesceChunkInto(message, chunk('agent_thought_chunk', 'thought'))).toBe(false);
    expect(textOf(message)).toBe('answer');
  });

  test('does not fold non-streaming session updates', () => {
    const toolCall = chunk('tool_call', 'x');
    expect(coalesceChunkInto(toolCall, chunk('tool_call', 'y'))).toBe(false);
  });

  test('does not fold across differing messageId (separate bubbles client-side)', () => {
    const a = chunk('agent_message_chunk', 'a', { messageId: 'm1' });
    expect(coalesceChunkInto(a, chunk('agent_message_chunk', 'b', { messageId: 'm2' }))).toBe(
      false,
    );
    // Same explicit messageId still folds.
    const c = chunk('agent_message_chunk', 'c', { messageId: 'm1' });
    expect(coalesceChunkInto(c, chunk('agent_message_chunk', 'd', { messageId: 'm1' }))).toBe(true);
    expect(textOf(c)).toBe('cd');
  });

  test('missing messageId matches missing messageId (both default)', () => {
    const a = chunk('agent_message_chunk', 'a');
    expect(coalesceChunkInto(a, chunk('agent_message_chunk', 'b'))).toBe(true);
    expect(textOf(a)).toBe('ab');
  });

  test('does not fold when either side is non-text content (image chunk)', () => {
    const image = chunk('agent_message_chunk', '', { type: 'image' });
    expect(coalesceChunkInto(image, chunk('agent_message_chunk', 'text'))).toBe(false);
    const text = chunk('agent_message_chunk', 'text');
    expect(coalesceChunkInto(text, chunk('agent_message_chunk', '', { type: 'image' }))).toBe(
      false,
    );
  });

  test('does not fold non-session_update events', () => {
    const userMsg: ThreadEvent = { kind: 'user_message', content: 'hi', ts: 1 };
    expect(coalesceChunkInto(userMsg, chunk('agent_message_chunk', 'x'))).toBe(false);
    expect(coalesceChunkInto(chunk('agent_message_chunk', 'x'), userMsg)).toBe(false);
  });

  test('stops folding once the tail hits the size cap (bounds one line)', () => {
    const prev = chunk('agent_message_chunk', 'x'.repeat(16_000));
    // At the cap: refuses further folds so no single line grows unbounded.
    expect(coalesceChunkInto(prev, chunk('agent_message_chunk', 'more'))).toBe(false);
    expect(textOf(prev)).toBe('x'.repeat(16_000));
    // Just under the cap still folds once (may exceed the cap by the added
    // chunk — the cap gates the NEXT fold, it doesn't truncate).
    const under = chunk('agent_message_chunk', 'y'.repeat(15_999));
    expect(coalesceChunkInto(under, chunk('agent_message_chunk', 'zz'))).toBe(true);
    expect(coalesceChunkInto(under, chunk('agent_message_chunk', 'no'))).toBe(false);
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
    expect(coalesceChunkInto(prev, terminalChunk('t1', 'line two\n'))).toBe(true);
    if (prev.kind !== 'terminal_output') throw new Error('unreachable');
    expect(prev.chunk).toBe('line one\nline two\n');
  });

  test('does not fold across terminals or event kinds', () => {
    const prev = terminalChunk('t1', 'a');
    expect(coalesceChunkInto(prev, terminalChunk('t2', 'b'))).toBe(false);
    expect(
      coalesceChunkInto(prev, {
        kind: 'terminal_exit',
        terminalId: 't1',
        exitCode: 0,
        signal: null,
        ts: 2,
      }),
    ).toBe(false);
  });

  test('stops folding once the tail chunk hits the size cap', () => {
    const prev = terminalChunk('t1', 'x'.repeat(16_000));
    expect(coalesceChunkInto(prev, terminalChunk('t1', 'more'))).toBe(false);
  });
});
