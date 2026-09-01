import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { requestTerminalLaunch, subscribeToTerminalLaunchRequests } from './terminal-launch-events';

describe('terminal-launch-events', () => {
  test('delivers the composed prompt + chosen CLI from request to subscriber', () => {
    const target = new EventTarget();
    const received: Array<{ prompt: string; cli: TerminalCli }> = [];
    const unsub = subscribeToTerminalLaunchRequests(
      (prompt, cli) => received.push({ prompt, cli }),
      target,
    );

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
    const unsub = subscribeToTerminalLaunchRequests(
      (_p, _c, opts) => received.push(opts.stage),
      target,
    );

    requestTerminalLaunch('some text', 'claude', options, target);
    expect(received).toEqual([expected]);
    unsub();
  });
});
