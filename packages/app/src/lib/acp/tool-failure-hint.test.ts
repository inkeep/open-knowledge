import { describe, expect, test } from 'vitest';
import type { RenderedPermission, RenderedToolCall } from './thread-event-model';
import { classifyToolFailure, toolFailureHint } from './tool-failure-hint';

const okTool = (text: string, status: RenderedToolCall['status'] = 'failed') => ({
  status,
  title: 'mcp__open-knowledge__write',
  rawInput: {},
  content: [text],
});

const otherTool = (text: string, status: RenderedToolCall['status'] = 'failed') => ({
  status,
  title: 'Run tests',
  rawInput: {},
  content: [text],
});

function permission(resolved: RenderedPermission['resolved']): RenderedPermission {
  return {
    kind: 'permission',
    requestId: 'r1',
    title: 'Run npm test?',
    toolKind: 'execute',
    options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
    resolved,
    toolCallId: 'c1',
    mergedIntoToolCall: true,
  };
}

describe('classifyToolFailure', () => {
  test('recognises the failure the report was filed about', () => {
    expect(classifyToolFailure(okTool('Error: Server unreachable: fetch failed'))).toBe(
      'server-unreachable',
    );
  });

  test('tells a request that timed out apart from a server that is not there', () => {
    for (const text of [
      'Error: Server timed out: The operation was aborted due to timeout',
      'Error: Server unreachable: The operation was aborted due to timeout',
    ]) {
      expect({ text, got: classifyToolFailure(okTool(text)) }).toEqual({
        text,
        got: 'server-timeout',
      });
    }
  });

  test('does not blame the server for a timeout the tool hit somewhere else', () => {
    expect(
      classifyToolFailure(okTool('exec failed: The operation was aborted due to timeout')),
    ).toBe(null);
  });

  test('gives another tool no OpenKnowledge advice, even for a lookalike error', () => {
    for (const text of [
      'Error: Server unreachable: fetch failed',
      'TypeError: fetch failed',
      'connect ECONNREFUSED 127.0.0.1:3000',
      "EACCES: permission denied, open '/etc/hosts'",
      'EPERM: operation not permitted',
      'Exceeded timeout of 5000 ms',
    ]) {
      expect({ text, got: classifyToolFailure(otherTool(text)) }).toEqual({ text, got: null });
    }
  });

  test('says nothing rather than guessing at an OpenKnowledge error it does not know', () => {
    for (const text of ['', 'Error: Document not found', 'exit code 2']) {
      expect({ text, got: classifyToolFailure(okTool(text)) }).toEqual({ text, got: null });
    }
  });

  test('reads a denial from what you chose on the permission card, whatever the tool', () => {
    for (const optionId of ['no', null]) {
      expect(
        classifyToolFailure(otherTool('Error: exit code 1'), permission({ optionId, auto: false })),
      ).toBe('permission-denied');
    }
  });

  test('does not put a denial on you for a prompt you approved or nobody answered', () => {
    for (const resolved of [
      { optionId: 'yes', auto: false },
      { optionId: 'yes', auto: true },
      { optionId: null, auto: true },
    ]) {
      expect({
        resolved,
        got: classifyToolFailure(otherTool('Error: exit code 1'), permission(resolved)),
      }).toEqual({ resolved, got: null });
    }
  });

  test('only speaks for a call that failed', () => {
    for (const status of ['pending', 'in_progress', 'completed'] as const) {
      expect({
        status,
        got: classifyToolFailure(
          otherTool('', status),
          permission({ optionId: 'no', auto: false }),
        ),
      }).toEqual({ status, got: null });
    }
  });
});

describe('toolFailureHint', () => {
  test('every recognised failure carries a hint, and unknown ones carry none', () => {
    expect(toolFailureHint(okTool('Error: Server unreachable: fetch failed'))).not.toBe(null);
    expect(
      toolFailureHint(okTool('Error: Server timed out: The operation was aborted due to timeout')),
    ).not.toBe(null);
    expect(
      toolFailureHint(otherTool('Error: exit code 1'), permission({ optionId: 'no', auto: false })),
    ).toContain('approve');
    expect(toolFailureHint(otherTool('Error: exit code 1'))).toBe(null);
  });

  test('an unreachable server seen from a running chat points at the connection, not ok start', () => {
    const hint = toolFailureHint(okTool('Error: Server unreachable: fetch failed'));
    expect(hint).toContain('start a new chat');
    expect(hint).not.toContain('ok start');
  });

  test('a timeout warns that the tool may have finished before anyone retries it', () => {
    expect(
      toolFailureHint(okTool('Error: Server timed out: The operation was aborted due to timeout')),
    ).toContain('check before trying again');
  });
});
