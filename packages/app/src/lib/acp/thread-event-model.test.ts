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
    const model = buildThreadRenderModel(events, null);
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
    const model = buildThreadRenderModel(events, null);
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
    const model = buildThreadRenderModel(events, null);
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
    const model = buildThreadRenderModel(events, null);
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
      const model = buildThreadRenderModel(events, null);
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
    const perm = buildThreadRenderModel(events, null).items.find((i) => i.kind === 'permission');
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
    const model = buildThreadRenderModel(events, null);
    expect(model.plan).toHaveLength(2);
    expect(model.plan[0]).toMatchObject({ content: 'Step 1', status: 'completed' });
  });

  test('surfaces error and auth notices from status events', () => {
    const events: ThreadEvent[] = [
      ev({ kind: 'status', status: 'error', detail: 'boom', ts: 1 }),
      ev({ kind: 'status', status: 'auth_required', detail: 'sign in', ts: 2 }),
    ];
    const model = buildThreadRenderModel(events, null);
    const notices = model.items.filter((i) => i.kind === 'notice');
    // A transcript recorded before the server classified failures carries only
    // the headline string — it still renders, with nothing structured to show.
    expect(notices).toEqual([
      { kind: 'notice', text: 'boom', tone: 'error', failure: null, attempts: 1 },
      { kind: 'notice', text: 'sign in', tone: 'info', failure: null, attempts: 1 },
    ]);
  });

  test('coalesces identical adjacent error notices into one card with bumped attempt count', () => {
    // A retried launch fires the same status:error event per attempt. Without
    // dedup the transcript stacks three visually-identical cards for one
    // failure — the reader has to click through each to find the retry
    // button on the last. Same reason + agentMessage + machineDetail + tone
    // + text is the "same failure again" heuristic.
    const failure = {
      reason: 'connect' as const,
      agentMessage: 'initialize failed: ACP connection closed',
      machineDetail: 'npm error Override without name: @modelcontextprotocol/sdk>zod',
    };
    const events: ThreadEvent[] = [
      ev({ kind: 'status', status: 'error', detail: 'connect failed', failure, ts: 1 }),
      ev({ kind: 'status', status: 'error', detail: 'connect failed', failure, ts: 2 }),
      ev({ kind: 'status', status: 'error', detail: 'connect failed', failure, ts: 3 }),
    ];
    const notices = buildThreadRenderModel(events, null).items.filter((i) => i.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ attempts: 3, failure });
  });

  test('a live failure after `ready` does NOT merge into the retired notice', () => {
    // Regression guard for the coalesce/superseded interaction: without the
    // `last.superseded !== true` guard, an identical failure arriving after
    // `ready` retired the previous notice would coalesce into that retired
    // notice (the spread carries `superseded: true` forward), and the view
    // would filter the merged card out entirely — the live failure would
    // render nowhere, with no Retry button.
    const failure = { reason: 'connect' as const, agentMessage: 'boom' };
    const model = buildThreadRenderModel(
      [
        ev({ kind: 'status', status: 'error', detail: 'boom', failure, ts: 1 }),
        ev({ kind: 'status', status: 'ready', ts: 2 }),
        ev({ kind: 'status', status: 'error', detail: 'boom', failure, ts: 3 }),
      ],
      null,
    );
    const notices = model.items.filter((i) => i.kind === 'notice');
    expect(notices).toHaveLength(2);
    expect(notices[0]?.kind === 'notice' && notices[0].superseded).toBe(true);
    expect(notices[1]?.kind === 'notice' && notices[1].superseded).not.toBe(true);
    expect(notices[1]?.kind === 'notice' && notices[1].attempts).toBe(1);
  });

  test('a genuinely different failure between two attempts gets its own card', () => {
    // If the machineDetail changes between attempts (different stderr, e.g.
    // attempt 1 fails on missing node, attempt 2 on install error), the two
    // failures are genuinely distinct — reader needs to see both.
    const first = { reason: 'connect' as const, machineDetail: 'boom-A' };
    const second = { reason: 'connect' as const, machineDetail: 'boom-B' };
    const events: ThreadEvent[] = [
      ev({ kind: 'status', status: 'error', detail: 'x', failure: first, ts: 1 }),
      ev({ kind: 'status', status: 'error', detail: 'x', failure: second, ts: 2 }),
    ];
    const notices = buildThreadRenderModel(events, null).items.filter((i) => i.kind === 'notice');
    expect(notices).toHaveLength(2);
    expect(notices.every((n) => n.kind === 'notice' && n.attempts === 1)).toBe(true);
  });

  test('carries a structured failure onto the notice it produces', () => {
    const failure = {
      reason: 'auth-required' as const,
      agentMessage: 'Authentication required',
      machineDetail: '{"detail":"x"}',
      authMethods: [{ id: 'test_login', name: 'Test Login', description: 'Sign in via test' }],
    };
    const model = buildThreadRenderModel(
      [ev({ kind: 'status', status: 'auth_required', detail: 'sign in required', failure, ts: 1 })],
      null,
    );
    const notice = model.items.find((i) => i.kind === 'notice');
    if (notice?.kind !== 'notice') throw new Error('unreachable');
    expect(notice.tone).toBe('info');
    expect(notice.failure).toEqual(failure);
  });

  test('a failure with no detail string still produces a notice', () => {
    const model = buildThreadRenderModel(
      [
        ev({
          kind: 'status',
          status: 'error',
          failure: { reason: 'session-setup', agentMessage: 'no session for you' },
          ts: 1,
        }),
      ],
      null,
    );
    const notice = model.items.find((i) => i.kind === 'notice');
    if (notice?.kind !== 'notice') throw new Error('unreachable');
    expect(notice.text).toBe('');
    expect(notice.tone).toBe('error');
    expect(notice.failure).toMatchObject({ reason: 'session-setup' });
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
    expect(buildThreadRenderModel(events, null).turnActive).toBe(false);
  });

  test('a resume after an exit re-arms the turn', () => {
    const events: ThreadEvent[] = [
      ev({ kind: 'turn_started', ts: 1 }),
      ev({ kind: 'status', status: 'exited', ts: 2 }),
      // Resume respawns the agent and opens a fresh turn.
      ev({ kind: 'turn_started', ts: 3 }),
      ev({ kind: 'status', status: 'running', ts: 4 }),
    ];
    expect(buildThreadRenderModel(events, null).turnActive).toBe(true);
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
    const model = buildThreadRenderModel([consentRequest()], null);
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

  test('a request with no reason reads as missing — what pre-field events were', () => {
    const model = buildThreadRenderModel([consentRequest()], null);
    const card = model.items.find((i) => i.kind === 'runtime_consent');
    if (card?.kind !== 'runtime_consent') throw new Error('unreachable');
    // The card picks its sentence off this; defaulting the other way would tell
    // every replayed thread its interpreter is broken.
    expect(card.reason).toBe('missing');
  });

  test('a broken-interpreter request carries that through to the card', () => {
    const model = buildThreadRenderModel(
      [{ ...consentRequest(), reason: 'broken' } as ThreadEvent],
      null,
    );
    const card = model.items.find((i) => i.kind === 'runtime_consent');
    if (card?.kind !== 'runtime_consent') throw new Error('unreachable');
    expect(card.reason).toBe('broken');
  });

  // The repair offer. Its copy is about OK's own copy being damaged, so the
  // card must not fall back to either interpreter sentence — both describe
  // something the user installed.
  test('a damaged-runtime request carries that through to the card', () => {
    const model = buildThreadRenderModel(
      [{ ...consentRequest(), reason: 'damaged' } as ThreadEvent],
      null,
    );
    const card = model.items.find((i) => i.kind === 'runtime_consent');
    if (card?.kind !== 'runtime_consent') throw new Error('unreachable');
    expect(card.reason).toBe('damaged');
  });

  test('grant → progress → spawning drives the card through running to done', () => {
    const model = buildThreadRenderModel(
      [
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
      ],
      null,
    );
    const card = model.items.find((i) => i.kind === 'runtime_consent');
    if (card?.kind !== 'runtime_consent') throw new Error('unreachable');
    // Progress captured, and the follow-on spawning status marks it done.
    expect(card.resolved).toBe('granted');
    expect(card.install).toBe('done');
    expect(card.progress).toEqual({ receivedBytes: 20, totalBytes: 40 });
  });

  test('a decline resolves the card without an install lifecycle', () => {
    const model = buildThreadRenderModel(
      [
        consentRequest(),
        ev({ kind: 'runtime_consent_resolved', requestId: 'r1', decision: 'declined', ts: 2 }),
      ],
      null,
    );
    const card = model.items.find((i) => i.kind === 'runtime_consent');
    if (card?.kind !== 'runtime_consent') throw new Error('unreachable');
    expect(card.resolved).toBe('declined');
    expect(card.install).toBeNull();
  });

  test('a failed launch after a grant marks the install failed', () => {
    const model = buildThreadRenderModel(
      [
        consentRequest(),
        ev({ kind: 'runtime_consent_resolved', requestId: 'r1', decision: 'granted', ts: 2 }),
        ev({ kind: 'status', status: 'error', detail: 'checksum mismatch', ts: 3 }),
      ],
      null,
    );
    const card = model.items.find((i) => i.kind === 'runtime_consent');
    if (card?.kind !== 'runtime_consent') throw new Error('unreachable');
    expect(card.install).toBe('failed');
    // The error detail still surfaces as its own notice.
    expect(model.items.some((i) => i.kind === 'notice' && i.text === 'checksum mismatch')).toBe(
      true,
    );
  });

  const piBridgeRequest = (): ThreadEvent =>
    ev({
      kind: 'pi_bridge_consent_request',
      requestId: 'p1',
      agentName: 'Pi',
      bridgePath: '/proj/.pi/extensions/open-knowledge.ts',
      cwd: '/proj',
      ts: 1,
    });

  const piCard = (events: ThreadEvent[]): Extract<RenderedItem, { kind: 'pi_bridge' }> => {
    const card = buildThreadRenderModel(events, null).items.find((i) => i.kind === 'pi_bridge');
    if (card?.kind !== 'pi_bridge') throw new Error('no pi_bridge card');
    return card;
  };

  test('renders a pending pi-bridge card from the request event', () => {
    expect(piCard([piBridgeRequest()])).toMatchObject({
      prompt: { requestId: 'p1', agentName: 'Pi', cwd: '/proj' },
      bridgePath: '/proj/.pi/extensions/open-knowledge.ts',
      decision: null,
      outcome: null,
    });
  });

  test('approve → the outcome folds onto the same card, one row for both halves', () => {
    const card = piCard([
      piBridgeRequest(),
      ev({ kind: 'pi_bridge_consent_resolved', requestId: 'p1', decision: 'granted', ts: 2 }),
      ev({
        kind: 'pi_bridge_status',
        requestId: 'p1',
        state: 'ready',
        bridgePath: '/proj/.pi/extensions/open-knowledge.ts',
        bridge: 'written',
        trust: 'added',
        ts: 3,
      }),
    ]);
    expect(card.decision).toBe('granted');
    expect(card.outcome).toEqual({ state: 'ready', detail: null });
  });

  test('a refusal settles the card and never grows an outcome', () => {
    const card = piCard([
      piBridgeRequest(),
      ev({ kind: 'pi_bridge_consent_resolved', requestId: 'p1', decision: 'declined', ts: 2 }),
    ]);
    expect(card.decision).toBe('declined');
    expect(card.outcome).toBeNull();
  });

  test('a timeout settles the card the same way a refusal does', () => {
    expect(
      piCard([
        piBridgeRequest(),
        ev({ kind: 'pi_bridge_consent_resolved', requestId: 'p1', decision: 'timeout', ts: 2 }),
      ]).decision,
    ).toBe('timeout');
  });

  test('a half-landed provisioning keeps its machine detail on the card', () => {
    const card = piCard([
      piBridgeRequest(),
      ev({ kind: 'pi_bridge_consent_resolved', requestId: 'p1', decision: 'granted', ts: 2 }),
      ev({
        kind: 'pi_bridge_status',
        requestId: 'p1',
        state: 'trust-failed',
        bridgePath: '/proj/.pi/extensions/open-knowledge.ts',
        bridge: 'written',
        trust: 'failed',
        detail: 'EACCES',
        ts: 3,
      }),
    ]);
    expect(card.outcome).toEqual({ state: 'trust-failed', detail: 'EACCES' });
  });

  // A status with nothing to fold onto — the foreign-file case, where nobody
  // was asked anything — still has to reach the transcript as its own row.
  test('a prompt-less status stands alone as a limitation row', () => {
    const model = buildThreadRenderModel(
      [
        ev({
          kind: 'pi_bridge_status',
          state: 'foreign-file',
          bridgePath: '/proj/.pi/extensions/open-knowledge.ts',
          ts: 1,
        }),
      ],
      null,
    );
    const rows = model.items.filter((i) => i.kind === 'pi_bridge');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      prompt: null,
      decision: null,
      outcome: { state: 'foreign-file', detail: null },
    });
  });

  // Same defense as the resolved-permission path: an answer whose question
  // fell off the retained log must not retarget some other row.
  test('an outcome for an unknown requestId becomes its own row', () => {
    const model = buildThreadRenderModel(
      [
        piBridgeRequest(),
        ev({
          kind: 'pi_bridge_status',
          requestId: 'gone',
          state: 'ready',
          bridgePath: '/other',
          ts: 2,
        }),
      ],
      null,
    );
    const rows = model.items.filter((i) => i.kind === 'pi_bridge');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ prompt: { requestId: 'p1' }, outcome: null });
    expect(rows[1]).toMatchObject({ prompt: null, bridgePath: '/other' });
  });

  // Forward compatibility for the reverse skew: a transcript written by a
  // NEWER server replays on this client without losing the events it does
  // understand. `as never` is the only way past the union.
  test('an event kind this client has never heard of is skipped, not fatal', () => {
    const model = buildThreadRenderModel(
      [
        ev({ kind: 'user_message', content: 'hi', ts: 1 }),
        { kind: 'pi_bridge_teleported', ts: 2 } as never,
        piBridgeRequest(),
      ],
      null,
    );
    expect(model.items.map((i) => i.kind)).toEqual(['message', 'pi_bridge']);
  });
});

describe('terminal folding', () => {
  const created = (id: string, ts = 1): ThreadEvent =>
    ev({ kind: 'terminal_created', terminalId: id, command: 'npm', args: ['test'], ts });

  test('folds created → output chunks → exit into one terminal record', () => {
    const model = buildThreadRenderModel(
      [
        created('t1'),
        ev({ kind: 'terminal_output', terminalId: 't1', chunk: 'compiling…\n', ts: 2 }),
        ev({ kind: 'terminal_output', terminalId: 't1', chunk: 'ok 12 tests\n', ts: 3 }),
        ev({ kind: 'terminal_exit', terminalId: 't1', exitCode: 0, signal: null, ts: 4 }),
      ],
      null,
    );
    expect(model.terminals.t1).toMatchObject({
      command: 'npm',
      args: ['test'],
      output: 'compiling…\nok 12 tests\n',
      truncated: false,
      exit: { exitCode: 0, signal: null },
    });
  });

  test('a running terminal has a null exit; output for unknown ids is dropped', () => {
    const model = buildThreadRenderModel(
      [
        created('t1'),
        ev({ kind: 'terminal_output', terminalId: 't1', chunk: 'partial', ts: 2 }),
        ev({ kind: 'terminal_output', terminalId: 'ghost', chunk: 'nope', ts: 3 }),
      ],
      null,
    );
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
    const model = buildThreadRenderModel(events, null);
    const terminal = model.terminals.t1;
    if (terminal === undefined) throw new Error('unreachable');
    expect(terminal.output.length).toBeLessThanOrEqual(64_000);
    expect(terminal.truncated).toBe(true);
    expect(terminal.output.endsWith('TAIL')).toBe(true);
  });

  test('signal exits carry the signal through', () => {
    const model = buildThreadRenderModel(
      [
        created('t1'),
        ev({ kind: 'terminal_exit', terminalId: 't1', exitCode: null, signal: 'SIGTERM', ts: 2 }),
      ],
      null,
    );
    expect(model.terminals.t1?.exit).toEqual({ exitCode: null, signal: 'SIGTERM' });
  });
});

describe('token usage', () => {
  test('folds a spec usage_update (top-level used/size)', () => {
    const model = buildThreadRenderModel(
      [
        ev({
          kind: 'session_update',
          ts: 1,
          update: { sessionUpdate: 'usage_update', used: 12_345, size: 200_000 } as never,
        }),
      ],
      null,
    );
    expect(model.tokenUsage).toEqual({ used: 12_345, size: 200_000 });
  });

  test('still accepts the nested `usage` key shape from pre-spec adapters', () => {
    const model = buildThreadRenderModel(
      [
        ev({
          kind: 'session_update',
          ts: 1,
          update: { sessionUpdate: 'something_else', usage: { used: 7, size: 100 } } as never,
        }),
      ],
      null,
    );
    expect(model.tokenUsage).toEqual({ used: 7, size: 100 });
  });

  test('latest usage wins', () => {
    const usage = (used: number, ts: number): ThreadEvent =>
      ev({
        kind: 'session_update',
        ts,
        update: { sessionUpdate: 'usage_update', used, size: 200_000 } as never,
      });
    const model = buildThreadRenderModel([usage(10, 1), usage(50, 2)], null);
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

describe('startup failures a later ready retires', () => {
  const statusEvent = (
    status: 'auth_required' | 'ready' | 'error',
    reason?: 'auth-required' | 'connect' | 'prompt',
  ) => ({
    kind: 'status' as const,
    status,
    ts: 1,
    ...(reason === undefined ? {} : { failure: { reason, agentMessage: 'x' } }),
  });

  // A thread that eventually started should not open on a stack of amber
  // cards about the sign-in the user already completed.
  test('a launch that eventually worked retires the failures it took to get there', () => {
    const model = buildThreadRenderModel(
      [
        statusEvent('auth_required', 'auth-required'),
        statusEvent('auth_required', 'auth-required'),
        statusEvent('ready'),
      ],
      null,
    );

    expect(model.items.filter((i) => i.kind === 'notice' && i.superseded !== true)).toHaveLength(0);
    // Two identical `auth_required` events coalesce into ONE notice with
    // `attempts: 2` before `ready` retires it — see the coalesce test in
    // `buildThreadRenderModel`. Positions still load-bearing: the fold
    // replaced-in-place instead of pushing, so index maps stayed valid.
    expect(model.items).toHaveLength(1);
    const notice = model.items[0];
    if (notice?.kind !== 'notice') throw new Error('unreachable');
    expect(notice.attempts).toBe(2);
    expect(notice.superseded).toBe(true);
  });

  // A prompt failure happened inside a live session, so a later `ready` says
  // nothing about it — the user still needs to see it.
  test('a prompt failure survives a later ready', () => {
    const model = buildThreadRenderModel(
      [statusEvent('error', 'prompt'), statusEvent('ready')],
      null,
    );

    expect(model.items.filter((i) => i.kind === 'notice' && i.superseded !== true)).toHaveLength(1);
  });

  // Still parked: nothing has been answered yet, so nothing is retired.
  test('failures stand while the thread has not started', () => {
    const model = buildThreadRenderModel([statusEvent('auth_required', 'auth-required')], null);

    expect(model.items.filter((i) => i.kind === 'notice' && i.superseded !== true)).toHaveLength(1);
  });
});

describe('sent-message timestamps', () => {
  test('a user turn keeps the instant its event was logged', () => {
    const model = buildThreadRenderModel([
      ev({ kind: 'user_message', content: 'hi', ts: 1_700_000_000_000 }),
    ]);

    const message = model.items[0];
    if (message?.kind !== 'message') throw new Error('unreachable');
    expect(message.sentAt).toBe(1_700_000_000_000);
  });

  test('agent text carries no instant — it arrives as chunks, not a moment', () => {
    const model = buildThreadRenderModel([
      ev({
        kind: 'session_update',
        ts: 3,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm1',
          content: { type: 'text', text: 'Hello' },
        } as never,
      }),
    ]);

    const message = model.items[0];
    if (message?.kind !== 'message') throw new Error('unreachable');
    expect(message.sentAt).toBeUndefined();
  });
});
