import type { ThreadEvent } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { describe, expect, test } from 'vitest';
import {
  buildThreadRenderModel,
  type RenderedItem,
  resolvePermissionOutcome,
} from './thread-event-model';

function ev(event: ThreadEvent): ThreadEvent {
  return event;
}

describe('buildThreadRenderModel', () => {
  test('coalesces streamed agent chunks by messageId into one message', () => {
    const events: ThreadEvent[] = [
      ev({ kind: 'user_message', content: 'hi', ts: 1 }),
      ev({ kind: 'turn_started', ts: 2 }),
      ev({
        kind: 'session_update',
        ts: 3,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm1',
          content: { type: 'text', text: 'Hello' },
        } as never,
      }),
      ev({
        kind: 'session_update',
        ts: 4,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm1',
          content: { type: 'text', text: ' world' },
        } as never,
      }),
    ];
    const model = buildThreadRenderModel(events);
    const messages = model.items.filter((i) => i.kind === 'message');
    expect(messages).toHaveLength(2); // user + one coalesced agent message
    expect(messages[1]).toMatchObject({ role: 'agent', text: 'Hello world' });
    expect(model.turnActive).toBe(true);
  });

  test('a tool call between chunks starts a new message block (chronological transcript)', () => {
    const chunk = (ts: number, text: string): ThreadEvent =>
      ev({
        kind: 'session_update',
        ts,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        } as never,
      });
    const events: ThreadEvent[] = [
      ev({ kind: 'user_message', content: 'go', ts: 1 }),
      chunk(2, 'Creating the file'),
      chunk(3, ' now.'),
      ev({
        kind: 'session_update',
        ts: 4,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'Write hello.md',
          kind: 'edit',
          status: 'completed',
        } as never,
      }),
      chunk(5, 'Done. Editing next'),
      chunk(6, ' file.'),
      ev({
        kind: 'session_update',
        ts: 7,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'c2',
          title: 'Edit other.md',
          kind: 'edit',
          status: 'completed',
        } as never,
      }),
      chunk(8, 'All finished.'),
    ];
    const model = buildThreadRenderModel(events);
    // Chronological: user, text, tool, text, tool, text — chunks coalesce only
    // while their message is still the tail, never across a tool call.
    expect(model.items.map((i) => (i.kind === 'message' ? `${i.kind}:${i.text}` : i.kind))).toEqual(
      [
        'message:go',
        'message:Creating the file now.',
        'tool_call',
        'message:Done. Editing next file.',
        'tool_call',
        'message:All finished.',
      ],
    );
  });

  test('tracks a tool call through status transitions and captures its diff', () => {
    const events: ThreadEvent[] = [
      ev({
        kind: 'session_update',
        ts: 1,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'Edit config',
          kind: 'edit',
          status: 'pending',
        } as never,
      }),
      ev({
        kind: 'session_update',
        ts: 2,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c1',
          status: 'completed',
          content: [{ type: 'diff', path: 'a.md', oldText: 'x', newText: 'y' }],
        } as never,
      }),
    ];
    const model = buildThreadRenderModel(events);
    const call = model.items.find((i) => i.kind === 'tool_call');
    expect(call).toMatchObject({ toolCallId: 'c1', status: 'completed', toolKind: 'edit' });
    if (call?.kind !== 'tool_call') throw new Error('unreachable');
    expect(call.diffs).toEqual([{ path: 'a.md', oldText: 'x', newText: 'y' }]);
  });

  test('marks a permission as resolved when the resolution event follows', () => {
    const events: ThreadEvent[] = [
      ev({
        kind: 'permission_request',
        requestId: 'p1',
        toolCall: { toolCallId: 'c1', title: 'Write file', kind: 'edit' } as never,
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        ts: 1,
      }),
      ev({ kind: 'permission_resolved', requestId: 'p1', optionId: 'allow', auto: false, ts: 2 }),
    ];
    const model = buildThreadRenderModel(events);
    const perm = model.items.find((i) => i.kind === 'permission');
    if (perm?.kind !== 'permission') throw new Error('unreachable');
    expect(perm.resolved).toEqual({ optionId: 'allow', auto: false });
  });

  test('links a permission to the call it gates, whichever event lands first', () => {
    const request = ev({
      kind: 'permission_request',
      requestId: 'p1',
      toolCall: { toolCallId: 'c1', title: 'Write file', kind: 'edit' } as never,
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      ts: 1,
    });
    const call = ev({
      kind: 'session_update',
      update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Write file' } as never,
      ts: 2,
    });
    const resolve = ev({
      kind: 'permission_resolved',
      requestId: 'p1',
      optionId: 'allow',
      auto: false,
      ts: 3,
    });

    // Agents ask first and stream the call after; some do the reverse. Either
    // order has to end up merged, or the outcome shows twice or not at all.
    for (const events of [
      [request, call, resolve],
      [call, request, resolve],
    ] satisfies ThreadEvent[][]) {
      const model = buildThreadRenderModel(events);
      const perm = model.items.find((i) => i.kind === 'permission');
      if (perm?.kind !== 'permission') throw new Error('unreachable');
      expect(perm.toolCallId).toBe('c1');
      expect(perm.mergedIntoToolCall).toBe(true);
      expect(model.permissionsByToolCall.c1?.resolved).toEqual({ optionId: 'allow', auto: false });
    }
  });

  test('leaves a permission unmerged when its call never appears', () => {
    const events: ThreadEvent[] = [
      ev({
        kind: 'permission_request',
        requestId: 'p1',
        toolCall: { toolCallId: 'c-missing', title: 'Write file', kind: 'edit' } as never,
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        ts: 1,
      }),
    ];
    const perm = buildThreadRenderModel(events).items.find((i) => i.kind === 'permission');
    if (perm?.kind !== 'permission') throw new Error('unreachable');
    expect(perm.mergedIntoToolCall).toBe(false);
  });

  test('keeps the latest plan as a checklist', () => {
    const events: ThreadEvent[] = [
      ev({
        kind: 'session_update',
        ts: 1,
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: 'Step 1', status: 'completed' },
            { content: 'Step 2', status: 'pending' },
          ],
        } as never,
      }),
    ];
    const model = buildThreadRenderModel(events);
    expect(model.plan).toHaveLength(2);
    expect(model.plan[0]).toMatchObject({ content: 'Step 1', status: 'completed' });
  });

  test('surfaces error and auth notices from status events', () => {
    const events: ThreadEvent[] = [
      ev({ kind: 'status', status: 'error', detail: 'boom', ts: 1 }),
      ev({ kind: 'status', status: 'auth_required', detail: 'sign in', ts: 2 }),
    ];
    const model = buildThreadRenderModel(events);
    const notices = model.items.filter((i) => i.kind === 'notice');
    expect(notices).toEqual([
      { kind: 'notice', text: 'boom', tone: 'error' },
      { kind: 'notice', text: 'sign in', tone: 'info' },
    ]);
  });

  test('a terminal exit ends a dangling turn (crash-mid-stream transcript)', () => {
    // The agent process exited after the turn opened but before the prompt
    // settled, so the persisted log has `turn_started` and no `turn_ended`.
    // On replay the turn must read as ended, not a perpetual "working" spinner.
    const events: ThreadEvent[] = [
      ev({ kind: 'user_message', content: 'ping', ts: 1 }),
      ev({ kind: 'turn_started', ts: 2 }),
      ev({ kind: 'status', status: 'running', ts: 3 }),
      ev({ kind: 'status', status: 'exited', detail: 'agent exited (SIGTERM)', ts: 4 }),
    ];
    expect(buildThreadRenderModel(events).turnActive).toBe(false);
  });

  test('a resume after an exit re-arms the turn', () => {
    const events: ThreadEvent[] = [
      ev({ kind: 'turn_started', ts: 1 }),
      ev({ kind: 'status', status: 'exited', ts: 2 }),
      // Resume respawns the agent and opens a fresh turn.
      ev({ kind: 'turn_started', ts: 3 }),
      ev({ kind: 'status', status: 'running', ts: 4 }),
    ];
    expect(buildThreadRenderModel(events).turnActive).toBe(true);
  });

  const consentRequest = (): ThreadEvent =>
    ev({
      kind: 'runtime_consent_request',
      requestId: 'r1',
      runtime: 'node',
      displayName: 'Node.js',
      provides: 'npx',
      version: 'v24.18.0',
      approxSizeMB: 45,
      sourceHost: 'nodejs.org',
      agentName: 'Gemini CLI',
      ts: 1,
    });

  test('renders a pending runtime-consent card from the request event', () => {
    const model = buildThreadRenderModel([consentRequest()]);
    const card = model.items.find((i) => i.kind === 'runtime_consent');
    if (card?.kind !== 'runtime_consent') throw new Error('unreachable');
    expect(card).toMatchObject({
      runtime: 'node',
      provides: 'npx',
      agentName: 'Gemini CLI',
      resolved: null,
      install: null,
      progress: null,
    });
  });

  test('grant → progress → spawning drives the card through running to done', () => {
    const model = buildThreadRenderModel([
      consentRequest(),
      ev({ kind: 'runtime_consent_resolved', requestId: 'r1', decision: 'granted', ts: 2 }),
      ev({
        kind: 'runtime_install_progress',
        runtime: 'node',
        phase: 'downloading',
        receivedBytes: 20,
        totalBytes: 40,
        ts: 3,
      }),
      ev({ kind: 'status', status: 'spawning', ts: 4 }),
    ]);
    const card = model.items.find((i) => i.kind === 'runtime_consent');
    if (card?.kind !== 'runtime_consent') throw new Error('unreachable');
    // Progress captured, and the follow-on spawning status marks it done.
    expect(card.resolved).toBe('granted');
    expect(card.install).toBe('done');
    expect(card.progress).toEqual({ receivedBytes: 20, totalBytes: 40 });
  });

  test('a decline resolves the card without an install lifecycle', () => {
    const model = buildThreadRenderModel([
      consentRequest(),
      ev({ kind: 'runtime_consent_resolved', requestId: 'r1', decision: 'declined', ts: 2 }),
    ]);
    const card = model.items.find((i) => i.kind === 'runtime_consent');
    if (card?.kind !== 'runtime_consent') throw new Error('unreachable');
    expect(card.resolved).toBe('declined');
    expect(card.install).toBeNull();
  });

  test('a failed launch after a grant marks the install failed', () => {
    const model = buildThreadRenderModel([
      consentRequest(),
      ev({ kind: 'runtime_consent_resolved', requestId: 'r1', decision: 'granted', ts: 2 }),
      ev({ kind: 'status', status: 'error', detail: 'checksum mismatch', ts: 3 }),
    ]);
    const card = model.items.find((i) => i.kind === 'runtime_consent');
    if (card?.kind !== 'runtime_consent') throw new Error('unreachable');
    expect(card.install).toBe('failed');
    // The error detail still surfaces as its own notice.
    expect(model.items.some((i) => i.kind === 'notice' && i.text === 'checksum mismatch')).toBe(
      true,
    );
  });
});

describe('terminal folding', () => {
  const created = (id: string, ts = 1): ThreadEvent =>
    ev({ kind: 'terminal_created', terminalId: id, command: 'npm', args: ['test'], ts });

  test('folds created → output chunks → exit into one terminal record', () => {
    const model = buildThreadRenderModel([
      created('t1'),
      ev({ kind: 'terminal_output', terminalId: 't1', chunk: 'compiling…\n', ts: 2 }),
      ev({ kind: 'terminal_output', terminalId: 't1', chunk: 'ok 12 tests\n', ts: 3 }),
      ev({ kind: 'terminal_exit', terminalId: 't1', exitCode: 0, signal: null, ts: 4 }),
    ]);
    expect(model.terminals.t1).toMatchObject({
      command: 'npm',
      args: ['test'],
      output: 'compiling…\nok 12 tests\n',
      truncated: false,
      exit: { exitCode: 0, signal: null },
    });
  });

  test('a running terminal has a null exit; output for unknown ids is dropped', () => {
    const model = buildThreadRenderModel([
      created('t1'),
      ev({ kind: 'terminal_output', terminalId: 't1', chunk: 'partial', ts: 2 }),
      ev({ kind: 'terminal_output', terminalId: 'ghost', chunk: 'nope', ts: 3 }),
    ]);
    expect(model.terminals.t1?.exit).toBeNull();
    expect(model.terminals.t1?.output).toBe('partial');
    expect(model.terminals.ghost).toBeUndefined();
  });

  test('caps rendered output, keeping the tail', () => {
    const events: ThreadEvent[] = [created('t1')];
    for (let i = 0; i < 80; i++) {
      events.push({
        kind: 'terminal_output',
        terminalId: 't1',
        chunk: 'x'.repeat(1000),
        ts: 2 + i,
      });
    }
    events.push({ kind: 'terminal_output', terminalId: 't1', chunk: 'TAIL', ts: 99 });
    const model = buildThreadRenderModel(events);
    const terminal = model.terminals.t1;
    if (terminal === undefined) throw new Error('unreachable');
    expect(terminal.output.length).toBeLessThanOrEqual(64_000);
    expect(terminal.truncated).toBe(true);
    expect(terminal.output.endsWith('TAIL')).toBe(true);
  });

  test('signal exits carry the signal through', () => {
    const model = buildThreadRenderModel([
      created('t1'),
      ev({ kind: 'terminal_exit', terminalId: 't1', exitCode: null, signal: 'SIGTERM', ts: 2 }),
    ]);
    expect(model.terminals.t1?.exit).toEqual({ exitCode: null, signal: 'SIGTERM' });
  });
});

describe('token usage', () => {
  test('folds a spec usage_update (top-level used/size)', () => {
    const model = buildThreadRenderModel([
      ev({
        kind: 'session_update',
        ts: 1,
        update: { sessionUpdate: 'usage_update', used: 12_345, size: 200_000 } as never,
      }),
    ]);
    expect(model.tokenUsage).toEqual({ used: 12_345, size: 200_000 });
  });

  test('still accepts the nested `usage` key shape from pre-spec adapters', () => {
    const model = buildThreadRenderModel([
      ev({
        kind: 'session_update',
        ts: 1,
        update: { sessionUpdate: 'something_else', usage: { used: 7, size: 100 } } as never,
      }),
    ]);
    expect(model.tokenUsage).toEqual({ used: 7, size: 100 });
  });

  test('latest usage wins', () => {
    const usage = (used: number, ts: number): ThreadEvent =>
      ev({
        kind: 'session_update',
        ts,
        update: { sessionUpdate: 'usage_update', used, size: 200_000 } as never,
      });
    const model = buildThreadRenderModel([usage(10, 1), usage(50, 2)]);
    expect(model.tokenUsage?.used).toBe(50);
  });
});

describe('resolvePermissionOutcome', () => {
  const permission = (
    resolved: { optionId: string | null; auto: boolean } | null,
  ): Extract<RenderedItem, { kind: 'permission' }> => ({
    kind: 'permission',
    requestId: 'r1',
    title: 'Run npm test?',
    toolKind: 'execute',
    options: [
      { optionId: 'yes', name: 'Yes, run it', kind: 'allow_once' },
      { optionId: 'no', name: 'No, reject', kind: 'reject_once' },
    ],
    resolved,
  });

  test('pending request has no outcome yet', () => {
    expect(resolvePermissionOutcome(permission(null))).toBeNull();
  });

  test('an option whose kind is neither allow nor reject is dismissed, not approved', () => {
    // Runtime defense-in-depth behind `PinPermissionOptionKind`: if a later ACP
    // release adds a kind and the pin is updated without revisiting this, the
    // label must not read "Approved" for an answer we can't classify. `as never`
    // is the only way past the union the typelock guards.
    const item = permission({ optionId: 'escalate', auto: false });
    item.options = [{ optionId: 'escalate', name: 'Escalate', kind: 'escalate_once' as never }];
    expect(resolvePermissionOutcome(item)).toEqual({ kind: 'dismissed' });
  });

  test('an allow option approves (auto and manual)', () => {
    expect(resolvePermissionOutcome(permission({ optionId: 'yes', auto: false }))).toEqual({
      kind: 'approved',
      auto: false,
      optionName: 'Yes, run it',
    });
    expect(resolvePermissionOutcome(permission({ optionId: 'yes', auto: true }))).toMatchObject({
      kind: 'approved',
      auto: true,
    });
  });

  test("choosing the agent's own reject option is a denial, not an approval", () => {
    expect(resolvePermissionOutcome(permission({ optionId: 'no', auto: false }))).toEqual({
      kind: 'denied',
      auto: false,
      optionName: 'No, reject',
    });
  });

  test('an explicit user deny (no optionId, not auto) is a denial', () => {
    expect(resolvePermissionOutcome(permission({ optionId: null, auto: false }))).toEqual({
      kind: 'denied',
      auto: false,
      optionName: null,
    });
  });

  test('an automatic no-answer resolution (timeout, turn cancel) is dismissed', () => {
    expect(resolvePermissionOutcome(permission({ optionId: null, auto: true }))).toEqual({
      kind: 'dismissed',
    });
  });

  test('an optionId matching none of the offered options is dismissed, never approved', () => {
    expect(resolvePermissionOutcome(permission({ optionId: 'ghost', auto: false }))).toEqual({
      kind: 'dismissed',
    });
  });
});
