import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  requestTerminalCommandLaunch,
  requestTerminalLaunch,
  subscribeToTerminalLaunchRequests,
  type TerminalLaunchRequest,
} from './terminal-launch-events';

describe('terminal-launch-events', () => {
  test('delivers the composed prompt + chosen CLI from request to subscriber', () => {
    const target = new EventTarget();
    const received: Array<{ prompt: string; cli: TerminalCli }> = [];
    const unsub = subscribeToTerminalLaunchRequests((request) => {
      if (request.kind === 'cli') received.push({ prompt: request.prompt, cli: request.cli });
    }, target);

    requestTerminalLaunch(
      "Let's work on `foo.md` using OpenKnowledge.",
      'codex',
      undefined,
      target,
    );
    expect(received).toEqual([
      { prompt: "Let's work on `foo.md` using OpenKnowledge.", cli: 'codex' },
    ]);

    unsub();
    requestTerminalLaunch('after unsubscribe', 'cursor', undefined, target);
    expect(received).toHaveLength(1);
  });

  test.each([
    { options: undefined, expected: false, label: 'defaults to running the prompt' },
    { options: { stage: false }, expected: false, label: 'explicit stage:false runs' },
    { options: { stage: true }, expected: true, label: 'stage:true defers to the input' },
  ])('$label', ({ options, expected }) => {
    const target = new EventTarget();
    const received: boolean[] = [];
    const unsub = subscribeToTerminalLaunchRequests((request) => {
      if (request.kind === 'cli') received.push(request.stage);
    }, target);

    requestTerminalLaunch('some text', 'claude', options, target);
    expect(received).toEqual([expected]);
    unsub();
  });

  test('a CLI launch names the chat that opened it for sign-in', () => {
    const target = new EventTarget();
    const received: TerminalLaunchRequest[] = [];
    subscribeToTerminalLaunchRequests((request) => received.push(request), target);
    requestTerminalLaunch('', 'claude', { signInThreadId: 't1' }, target);
    expect(received).toEqual([
      { kind: 'cli', prompt: '', cli: 'claude', stage: false, signInThreadId: 't1' },
    ]);
  });

  test('a command launch carries the command, its label and the signing-in chat', () => {
    const target = new EventTarget();
    const received: TerminalLaunchRequest[] = [];
    subscribeToTerminalLaunchRequests((request) => received.push(request), target);
    requestTerminalCommandLaunch(
      {
        label: 'Log in with Auggie',
        command: { executable: 'auggie', args: ['--acp', 'login'], env: {}, pathPrepend: [] },
        signInThreadId: 't1',
      },
      target,
    );
    expect(received).toEqual([
      {
        kind: 'command',
        label: 'Log in with Auggie',
        command: { executable: 'auggie', args: ['--acp', 'login'], env: {}, pathPrepend: [] },
        signInThreadId: 't1',
      },
    ]);
  });

  test('an untagged prompt-and-cli detail, the shape the desktop smoke harness dispatches, is a CLI launch', () => {
    const target = new EventTarget();
    const received: TerminalLaunchRequest[] = [];
    subscribeToTerminalLaunchRequests((request) => received.push(request), target);
    target.dispatchEvent(
      new CustomEvent('open-knowledge:terminal-launch', {
        detail: { prompt: '', cli: 'claude', stage: false },
      }),
    );
    target.dispatchEvent(
      new CustomEvent('open-knowledge:terminal-launch', {
        detail: { prompt: 'fix this', cli: 'codex', stage: true },
      }),
    );
    expect(received).toEqual([
      { kind: 'cli', prompt: '', cli: 'claude', stage: false },
      { kind: 'cli', prompt: 'fix this', cli: 'codex', stage: true },
    ]);
  });

  test('an unknown tag never launches, even with a valid prompt and CLI', () => {
    const target = new EventTarget();
    const received: TerminalLaunchRequest[] = [];
    subscribeToTerminalLaunchRequests((request) => received.push(request), target);
    target.dispatchEvent(
      new CustomEvent('open-knowledge:terminal-launch', {
        detail: { kind: 'script', prompt: 'p', cli: 'claude', stage: false },
      }),
    );
    expect(received).toEqual([]);
  });

  test('a malformed command or an untagged detail without a CLI is ignored', () => {
    const target = new EventTarget();
    const received: TerminalLaunchRequest[] = [];
    subscribeToTerminalLaunchRequests((request) => received.push(request), target);
    for (const detail of [
      { kind: 'command', label: 'x', command: { executable: 7, args: [] } },
      { kind: 'command', label: 'x', command: { executable: 'auggie', args: 'login' } },
      { kind: 'command', label: 'x', command: null },
      { kind: 'command', command: { executable: 'auggie', args: [] } },
      { prompt: 'p', stage: false },
      { prompt: 7, cli: 'claude' },
    ]) {
      target.dispatchEvent(new CustomEvent('open-knowledge:terminal-launch', { detail }));
    }
    expect(received).toEqual([]);
  });

  test('a malformed event is ignored', () => {
    const target = new EventTarget();
    const received: TerminalLaunchRequest[] = [];
    subscribeToTerminalLaunchRequests((request) => received.push(request), target);
    target.dispatchEvent(
      new CustomEvent('open-knowledge:terminal-launch', { detail: { kind: 'command' } }),
    );
    target.dispatchEvent(new Event('open-knowledge:terminal-launch'));
    expect(received).toEqual([]);
  });
});
