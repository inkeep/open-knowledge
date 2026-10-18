import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  describeStopFailure,
  failedOpenHolder,
  type HolderStopPromptDeps,
  type HolderStopPromptInput,
  promptHolderStop,
} from './holder-stop-prompt.ts';
import type { ForceStopOutcome, OtherChannelHolderError } from './window-manager.ts';

const stableHolder: OtherChannelHolderError = Object.assign(new Error('held'), {
  kind: 'other-channel-holder' as const,
  holderPid: 65792,
  holderChannel: 'stable',
  holderKind: 'interactive' as const,
  selfChannel: 'beta',
});

function baseInput(overrides: Partial<HolderStopPromptInput> = {}): HolderStopPromptInput {
  return {
    projectPath: '/tmp/dragon',
    kind: 'other-channel-holder',
    errorMessage: 'held',
    dialogTitle: 'This project is open in another OpenKnowledge app',
    dialogBody: '/tmp/dragon\n\nheld',
    otherChannelHolder: stableHolder,
    warnsHolderMayBeLive: false,
    holderIsOwnChild: false,
    ...overrides,
  };
}

async function run(
  input: HolderStopPromptInput,
  response: number,
  stopOutcome: ForceStopOutcome = { ok: true },
) {
  const calls: string[] = [];
  let shown: Parameters<HolderStopPromptDeps['showMessageBox']>[0] | null = null;
  let stopTarget: unknown = 'not-called';
  const result = await promptHolderStop(input, {
    showMessageBox: async (options) => {
      shown = options;
      calls.push('dialog');
      return { response };
    },
    forceStop: async (expectedHolder) => {
      stopTarget = expectedHolder;
      calls.push('stop');
      return stopOutcome;
    },
    retryOpen: async () => {
      calls.push('retry');
      return true;
    },
    reopen: async () => {
      calls.push('reopen');
      return true;
    },
  });
  const dialog = shown as Parameters<HolderStopPromptDeps['showMessageBox']>[0] | null;
  return {
    result,
    calls,
    stopTarget,
    title: dialog?.title,
    detail: dialog?.detail,
    buttons: dialog?.buttons,
    defaultId: dialog?.defaultId,
    cancelId: dialog?.cancelId,
  };
}

describe('promptHolderStop', () => {
  test('another channel holding the project gets a handoff button that defaults to Cancel', async () => {
    expect(await run(baseInput(), 1)).toEqual({
      result: { kind: 'declined' },
      calls: ['dialog'],
      stopTarget: 'not-called',
      title: 'This project is open in another OpenKnowledge app',
      detail:
        '/tmp/dragon\n\nheld\n\nThis OpenKnowledge (Stable) server keeps running after any window showing the project closes, so the project stays busy until the server stops. OpenKnowledge Beta can stop it now and open the project here. Every window, editor, or agent connected to it loses its connection to this project.',
      buttons: ['Stop OpenKnowledge (Stable) Server & Open Here', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
  });

  test('accepting the handoff stops exactly the named holder, then opens the project again', async () => {
    expect(await run(baseInput(), 0)).toMatchObject({
      result: { kind: 'retried', opened: true },
      calls: ['dialog', 'stop', 'retry'],
      stopTarget: { pid: 65792, channel: 'stable' },
    });
  });

  test.each([true, false])(
    'an unverified holder reports whether SIGTERM was sent (%s) instead of retrying',
    async (sigtermSent) => {
      expect(
        await run(baseInput(), 0, { ok: false, reason: 'unverified', sigtermSent }),
      ).toMatchObject({
        result: { kind: 'stop-failed', reason: 'unverified', sigtermSent },
        calls: ['dialog', 'stop'],
      });
    },
  );

  test('a holder that changed while the dialog was open is re-prompted from a fresh open, not retried as if it stopped', async () => {
    expect(await run(baseInput(), 0, { ok: false, reason: 'holder-changed' })).toMatchObject({
      result: { kind: 'reopened', opened: true },
      calls: ['dialog', 'stop', 'reopen'],
    });
  });

  test('a same-channel lock collision keeps the plain stop-and-retry default', async () => {
    expect(
      await run(baseInput({ kind: 'lock-collision', otherChannelHolder: null }), 0),
    ).toMatchObject({
      result: { kind: 'retried', opened: true },
      stopTarget: undefined,
      buttons: ['Stop Server & Retry', 'Cancel'],
      defaultId: 0,
    });
  });

  for (const kind of ['lock-collision', 'stale-lock-holder', 'spawn-lock-timeout'] as const) {
    test(`a ${kind} dialog over another channel's lock is the named, bound, Cancel-default handoff`, async () => {
      expect(
        await run(
          baseInput({
            kind,
            errorMessage: 'OpenKnowledge server already running at port 0',
            dialogTitle: 'A stopped server is still holding this project',
            dialogBody: '/tmp/dragon\n\nheld (pid 65792)',
            otherChannelHolder: {
              holderPid: 65792,
              holderChannel: 'stable',
              holderKind: 'interactive',
              selfChannel: 'beta',
            },
          }),
          0,
        ),
      ).toMatchObject({
        result: { kind: 'retried', opened: true },
        stopTarget: { pid: 65792, channel: 'stable' },
        title: 'This project is open in another OpenKnowledge app',
        detail:
          "/tmp/dragon\n\nOpenKnowledge (Stable) holds this project's server lock (pid 65792) and may still be serving it.\n\nThis OpenKnowledge (Stable) server keeps running after any window showing the project closes, so the project stays busy until the server stops. OpenKnowledge Beta can stop it now and open the project here. Every window, editor, or agent connected to it loses its connection to this project.",
        buttons: ['Stop OpenKnowledge (Stable) Server & Open Here', 'Cancel'],
        defaultId: 1,
      });
    });
  }

  test('a failure with no holder in the way shows no stop offer', async () => {
    expect(
      await run(baseInput({ kind: 'spawn-failed', otherChannelHolder: null }), 0),
    ).toMatchObject({ result: { kind: 'not-offered' }, calls: [] });
  });

  test('the failed-open holder never builds a window manager and takes the lock holder only from an existing one', () => {
    const lockHolder = {
      holderPid: 70001,
      holderChannel: 'stable',
      holderKind: 'interactive' as const,
      selfChannel: 'beta',
    };
    const lookups: string[] = [];
    const wm = {
      otherChannelLockHolder: (projectPath: string) => {
        lookups.push(projectPath);
        return lockHolder;
      },
    };
    expect(failedOpenHolder(new Error('spawn timed out'), '/tmp/dragon', undefined)).toBeNull();
    expect(failedOpenHolder(stableHolder, '/tmp/dragon', wm)).toBe(stableHolder);
    expect(failedOpenHolder(new Error('spawn timed out'), '/tmp/dragon', wm)).toBe(lockHolder);
    expect(
      failedOpenHolder(new Error('spawn timed out'), '/tmp/dragon', {
        otherChannelLockHolder: () => null,
      }),
    ).toBeNull();
    expect(lookups).toEqual(['/tmp/dragon']);
  });
});

describe('describeStopFailure', () => {
  test('tells the user a holder that was asked to stop may still exit', () => {
    expect(
      describeStopFailure(
        { kind: 'stop-failed', reason: 'unverified', sigtermSent: true },
        '/tmp/dragon',
        'darwin',
      ),
    ).toBe(
      "OpenKnowledge asked the process holding this project's server lock to stop, but could not confirm that it is this project's server, so it did not force it to quit. Wait a moment and try again. If the project is still locked, stop the server where it was started, or restart your computer.",
    );
  });

  test('says an unverified holder that was never signalled was not stopped', () => {
    expect(
      describeStopFailure(
        { kind: 'stop-failed', reason: 'unverified', sigtermSent: false },
        '/tmp/dragon',
        'darwin',
      ),
    ).toBe(
      "Could not confirm that the process holding this project's server lock is still its server, so it was not stopped. Stop the server where it was started, or restart your computer, then try again.",
    );
  });

  test('offers ok stop only for a failure the identity check did not cause', () => {
    expect(
      describeStopFailure({ kind: 'stop-failed', reason: 'other' }, '/tmp/dragon', 'darwin'),
    ).toBe(
      "Could not stop the conflicting server. Quit it manually (`ok stop --force '/tmp/dragon'`) and try again.",
    );
  });

  describe('on Beta', () => {
    afterEach(() => vi.unstubAllEnvs());

    test('names the Beta CLI in the manual stop command', () => {
      vi.stubEnv('OK_CHANNEL', 'beta');
      expect(
        describeStopFailure({ kind: 'stop-failed', reason: 'other' }, '/tmp/dragon', 'darwin'),
      ).toBe(
        "Could not stop the conflicting server. Quit it manually (`ok-beta stop --force '/tmp/dragon'`) and try again.",
      );
    });
  });
});
