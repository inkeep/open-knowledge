import { describe, expect, test } from 'vitest';
import { contextWindowChangeFor } from './context-window-change.ts';

const base = { agentId: 'codex-acp', archived: false, turnActive: false, hasStartedWork: false };

describe('when a context-window change can take effect', () => {
  test('a fresh Codex thread applies it by restarting', () => {
    expect(contextWindowChangeFor(base)).toEqual({ kind: 'apply' });
  });

  test('a thread that already carries a message needs a new chat', () => {
    expect(contextWindowChangeFor({ ...base, hasStartedWork: true })).toEqual({
      kind: 'needs-new-chat',
    });
  });

  test('a thread mid-turn needs a new chat, even with no message recorded yet', () => {
    expect(contextWindowChangeFor({ ...base, turnActive: true })).toEqual({
      kind: 'needs-new-chat',
    });
  });

  test('an archived thread needs a new chat rather than a silent restart', () => {
    expect(contextWindowChangeFor({ ...base, archived: true })).toEqual({ kind: 'needs-new-chat' });
  });

  test('Claude is unsupported, because its window rides in the model id', () => {
    expect(contextWindowChangeFor({ ...base, agentId: 'claude-acp' })).toEqual({
      kind: 'unsupported',
    });
  });

  test('an agent we know nothing about is unsupported rather than restarted', () => {
    expect(contextWindowChangeFor({ ...base, agentId: 'opencode' })).toEqual({
      kind: 'unsupported',
    });
  });
});
