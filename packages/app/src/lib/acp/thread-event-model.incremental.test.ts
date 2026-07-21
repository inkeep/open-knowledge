/**
 * Property: incrementally sync()ing an event log in arbitrary batch splits
 * yields exactly the same model as one-shot folding the whole log. This is
 * the correctness contract that lets the store fold O(new events) per update
 * instead of re-folding the transcript on every streamed chunk.
 */

import type { SessionUpdate, ThreadEvent } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { describe, expect, test } from 'vitest';
import { buildThreadRenderModel, ThreadRenderModelBuilder } from './thread-event-model';

/** Deterministic LCG so failures reproduce. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function generateEvents(rng: () => number, count: number): ThreadEvent[] {
  const events: ThreadEvent[] = [];
  const toolCallIds: string[] = [];
  const permissionIds: string[] = [];
  let ts = 1;
  const su = (update: SessionUpdate): ThreadEvent => ({
    kind: 'session_update',
    update,
    ts: ts++,
  });
  for (let i = 0; i < count; i++) {
    const roll = rng();
    if (roll < 0.35) {
      // Streamed message chunk — the hot path. Vary role and messageId
      // presence to exercise tail-coalescing vs fresh-block starts.
      const role = rng() < 0.7 ? 'agent' : rng() < 0.5 ? 'thought' : 'user';
      const update = {
        sessionUpdate: `${role}_message_chunk`,
        content: { type: 'text', text: `chunk${i} ` },
        ...(rng() < 0.3 ? { messageId: `m${Math.floor(rng() * 3)}` } : {}),
      } as unknown as SessionUpdate;
      events.push(su(update));
    } else if (roll < 0.5) {
      const id = `tool-${toolCallIds.length}`;
      toolCallIds.push(id);
      events.push(
        su({
          sessionUpdate: 'tool_call',
          toolCallId: id,
          title: `Tool ${id}`,
          kind: 'edit',
          status: 'pending',
          content: [{ type: 'content', content: { type: 'text', text: `start ${id}` } }],
          locations: [{ path: `docs/${id}.md` }],
        } as unknown as SessionUpdate),
      );
    } else if (roll < 0.65 && toolCallIds.length > 0) {
      const id = toolCallIds[Math.floor(rng() * toolCallIds.length)];
      events.push(
        su({
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          status: rng() < 0.5 ? 'in_progress' : 'completed',
          ...(rng() < 0.4
            ? {
                content: [{ type: 'diff', path: `docs/${id}.md`, oldText: 'a', newText: `b${i}` }],
              }
            : {}),
          ...(rng() < 0.3 ? { rawInput: { arguments: { doc: `d${i}` } } } : {}),
        } as unknown as SessionUpdate),
      );
    } else if (roll < 0.72) {
      const id = `perm-${permissionIds.length}`;
      permissionIds.push(id);
      events.push({
        kind: 'permission_request',
        requestId: id,
        toolCall: { toolCallId: `tool-x${i}`, title: `Allow ${i}?`, kind: 'edit' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        ts: ts++,
      } as unknown as ThreadEvent);
    } else if (roll < 0.78 && permissionIds.length > 0) {
      const id = permissionIds[Math.floor(rng() * permissionIds.length)];
      events.push({
        kind: 'permission_resolved',
        requestId: id,
        optionId: rng() < 0.5 ? 'allow' : null,
        auto: rng() < 0.5,
        ts: ts++,
      });
    } else if (roll < 0.85) {
      events.push({ kind: 'user_message', content: `ask ${i}`, ts: ts++ });
      events.push({ kind: 'turn_started', ts: ts++ });
    } else if (roll < 0.9) {
      events.push({ kind: 'turn_ended', stopReason: 'end_turn', ts: ts++ } as ThreadEvent);
    } else if (roll < 0.95) {
      events.push(
        su({
          sessionUpdate: 'plan',
          entries: [
            { content: `step ${i}`, status: 'pending' },
            { content: `step ${i + 1}`, status: 'completed' },
          ],
        } as unknown as SessionUpdate),
      );
    } else {
      events.push({
        kind: 'status',
        status: rng() < 0.5 ? 'error' : 'running',
        detail: `detail ${i}`,
        ts: ts++,
      });
    }
  }
  return events;
}

describe('incremental fold equivalence', () => {
  test('arbitrary batch splits produce the one-shot fold result', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rng = makeRng(seed * 7919);
      const events = generateEvents(rng, 120);
      const expected = buildThreadRenderModel(events);

      const builder = new ThreadRenderModelBuilder();
      let applied = 0;
      let model = builder.sync([]);
      while (applied < events.length) {
        const step = 1 + Math.floor(rng() * 7);
        applied = Math.min(applied + step, events.length);
        model = builder.sync(events.slice(0, applied));
      }
      expect(model).toEqual(expected);
    }
  });

  test('snapshot is referentially stable when no new events arrive', () => {
    const events = generateEvents(makeRng(42), 50);
    const builder = new ThreadRenderModelBuilder();
    const first = builder.sync(events);
    expect(builder.sync(events)).toBe(first);
    expect(builder.sync(events)).toBe(first);
  });

  test('untouched rows keep object identity across snapshots (copy-on-write)', () => {
    const builder = new ThreadRenderModelBuilder();
    const base: ThreadEvent[] = [
      { kind: 'user_message', content: 'hi', ts: 1 },
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'Read',
          kind: 'read',
          status: 'pending',
        } as unknown as SessionUpdate,
        ts: 2,
      },
    ];
    const before = builder.sync(base);
    const after = builder.sync([
      ...base,
      {
        kind: 'session_update',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
        } as unknown as SessionUpdate,
        ts: 3,
      },
    ]);
    // New snapshot object, but the two untouched rows are the same objects.
    expect(after).not.toBe(before);
    expect(after.items[0]).toBe(before.items[0]);
    expect(after.items[1]).toBe(before.items[1]);
    expect(after.items).toHaveLength(3);
  });

  test('a shorter log than previously seen resets the builder', () => {
    const events = generateEvents(makeRng(7), 40);
    const builder = new ThreadRenderModelBuilder();
    builder.sync(events);
    const shorter = events.slice(0, 5);
    expect(builder.sync(shorter)).toEqual(buildThreadRenderModel(shorter));
  });
});
