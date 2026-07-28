import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import {
  UNINSTALL_FEEDBACK_REASONS,
  type UninstallFeedbackAnswers,
  type UninstallFeedbackResult,
  type UninstallFeedbackSubmission,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test, vi } from 'vitest';
import { runUninstall } from './uninstall.ts';
import { collectUninstallFeedbackAnswers, promptUninstallFeedback } from './uninstall-feedback.ts';

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Records every submission so a test can assert the wire shape it was handed. */
function recordingSubmit(result: UninstallFeedbackResult = { ok: true, reference: 'FB-1' }): {
  submissions: UninstallFeedbackSubmission[];
  submit: (submission: UninstallFeedbackSubmission) => Promise<UninstallFeedbackResult>;
} {
  const submissions: UninstallFeedbackSubmission[] = [];
  return {
    submissions,
    submit: async (submission) => {
      submissions.push(submission);
      return result;
    },
  };
}

function interactive(answers: UninstallFeedbackAnswers) {
  const collected: string[] = [];
  return {
    collected,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    appVersion: '1.2.3',
    platform: 'darwin',
    collect: async (): Promise<UninstallFeedbackAnswers> => {
      collected.push('prompted');
      return answers;
    },
  };
}

const ARROW_UP = '[A';
const ENTER = '\r';

/**
 * Answers each prompt as it appears on the output stream, so the sequence is
 * driven by what the user would actually see rather than by timing.
 *
 * Two details make the fake faithful. `_isStdio` is what stops inquirer's
 * piped MuteStream from closing the output when the select resolves — Node's
 * legacy `pipe` skips end-propagation for stdio, which is why the real stderr
 * survives to serve the prompts that follow. And the reply is deferred a tick
 * because writing during a render races the keypress listener that same render
 * is still installing.
 */
function drive(steps: Array<{ when: string; send: string }>): {
  io: { input: PassThrough; output: PassThrough };
  transcript: () => string;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  (output as PassThrough & { _isStdio?: boolean })._isStdio = true;
  const pending = [...steps];
  let seen = '';
  output.on('data', (chunk) => {
    seen += String(chunk);
    const next = pending[0];
    if (next && seen.includes(next.when)) {
      pending.shift();
      setImmediate(() => input.write(next.send));
    }
  });
  return { io: { input, output }, transcript: () => seen };
}

describe('collectUninstallFeedbackAnswers', () => {
  test('offers every reason plus a skip choice, all on one screen', async () => {
    const driver = drive([{ when: 'mind sharing why', send: ENTER }]);
    await collectUninstallFeedbackAnswers(driver.io);
    const firstFrame = driver.transcript();
    for (const { label } of UNINSTALL_FEEDBACK_REASONS) {
      expect(firstFrame).toContain(label);
    }
    expect(firstFrame).toContain('Skip');
  });

  test('a bare Enter skips rather than picking a reason for the user', async () => {
    const driver = drive([{ when: 'mind sharing why', send: ENTER }]);
    expect(await collectUninstallFeedbackAnswers(driver.io)).toEqual({});
  });

  test('a chosen reason is followed by the optional note and email', async () => {
    const driver = drive([
      { when: 'mind sharing why', send: ARROW_UP + ENTER },
      { when: 'Anything else', send: 'the sync kept breaking\n' },
      { when: 'Email, if we may', send: 'me@example.com\n' },
    ]);
    expect(await collectUninstallFeedbackAnswers(driver.io)).toEqual({
      reason: 'other',
      note: 'the sync kept breaking',
      email: 'me@example.com',
    });
  });

  test('skipping the note and email leaves a reason-only answer', async () => {
    const driver = drive([
      { when: 'mind sharing why', send: ARROW_UP + ENTER },
      { when: 'Anything else', send: '\n' },
      { when: 'Email, if we may', send: '\n' },
    ]);
    expect(await collectUninstallFeedbackAnswers(driver.io)).toEqual({
      reason: 'other',
      note: undefined,
      email: undefined,
    });
  });
});

describe('promptUninstallFeedback gating', () => {
  const cases: Array<{ name: string; gate: Record<string, unknown> }> = [
    { name: 'stdin is not a TTY', gate: { stdinIsTTY: false, stdoutIsTTY: true } },
    { name: 'stdout is not a TTY', gate: { stdinIsTTY: true, stdoutIsTTY: false } },
    { name: '--yes (the desktop cleanup shell-out)', gate: { yes: true } },
    { name: '--json', gate: { json: true } },
  ];

  for (const { name, gate } of cases) {
    test(`does not prompt or post when ${name}`, async () => {
      const base = interactive({ reason: 'unreliable' });
      const { submissions, submit } = recordingSubmit();
      const outcome = await promptUninstallFeedback({ ...base, ...gate, submit });
      expect(outcome).toBe('not-prompted');
      expect(base.collected).toEqual([]);
      expect(submissions).toEqual([]);
    });
  }

  test('prompts when both streams are interactive and no flag suppresses it', async () => {
    const base = interactive({ reason: 'unreliable' });
    const { submit } = recordingSubmit();
    await promptUninstallFeedback({ ...base, submit });
    expect(base.collected).toEqual(['prompted']);
  });
});

describe('promptUninstallFeedback submission', () => {
  test('posts the chosen reason tagged as the CLI surface', async () => {
    const { submissions, submit } = recordingSubmit();
    const outcome = await promptUninstallFeedback({
      ...interactive({ reason: 'switched-tool', note: 'Moved to something else', email: 'a@b.co' }),
      submit,
    });
    expect(outcome).toBe('submitted');
    expect(submissions).toEqual([
      {
        reason: 'switched-tool',
        note: 'Moved to something else',
        email: 'a@b.co',
        source: 'cli_uninstall',
        appVersion: '1.2.3',
        platform: 'darwin',
      },
    ]);
  });

  test('posts nothing when the user skipped every question', async () => {
    const { submissions, submit } = recordingSubmit();
    const outcome = await promptUninstallFeedback({ ...interactive({}), submit });
    expect(outcome).toBe('skipped');
    expect(submissions).toEqual([]);
  });

  test('posts a note with no reason', async () => {
    const { submissions, submit } = recordingSubmit();
    const outcome = await promptUninstallFeedback({
      ...interactive({ note: 'the sync broke' }),
      submit,
    });
    expect(outcome).toBe('submitted');
    expect(submissions[0]?.note).toBe('the sync broke');
  });

  test('treats a whitespace-only note as nothing to file', async () => {
    const { submissions, submit } = recordingSubmit();
    const outcome = await promptUninstallFeedback({ ...interactive({ note: '   ' }), submit });
    expect(outcome).toBe('skipped');
    expect(submissions).toEqual([]);
  });

  // The caller proceeds either way, but the outcome must not call a POST that
  // never landed "submitted" — that is the signal a schema drift would show up in.
  test('reports a send that never landed as undelivered, not submitted', async () => {
    const { submit } = recordingSubmit({ ok: false, reason: 'timeout' });
    const outcome = await promptUninstallFeedback({
      ...interactive({ reason: 'one-off' }),
      submit,
    });
    expect(outcome).toBe('undelivered');
  });

  test('a prompt interrupted by SIGINT resolves instead of throwing', async () => {
    const { submissions, submit } = recordingSubmit();
    const outcome = await promptUninstallFeedback({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      appVersion: '1.2.3',
      platform: 'darwin',
      collect: async () => {
        throw new Error('User force closed the prompt with SIGINT');
      },
      submit,
    });
    expect(outcome).toBe('failed');
    expect(submissions).toEqual([]);
  });
});

describe('ok uninstall feedback step', () => {
  /** A temp home with the machine-touching removal primitives stubbed out. */
  function uninstallFixture(): { home: string; cleanup: () => void } {
    const home = mkdtempSync(join(tmpdir(), 'ok-uninst-fb-'));
    write(join(home, '.ok', 'auth.yml'), 'x\n');
    return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
  }

  const stubbedRemoval = {
    clearToken: async () => ({ touched: [] }),
    clearEmbeddingsKey: async () => ({ touched: [] }),
    stopServer: () => ({ stopped: 0, failed: [] }),
  };

  test('asks after the removal report and awaits the send', async () => {
    const { home, cleanup } = uninstallFixture();
    try {
      const order: string[] = [];
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        isTTY: true,
        isStdinTTY: true,
        confirmStream: Readable.from(['y\n']),
        deps: {
          discoverLockDirs: async () => [],
          detectInstallMethods: () => [],
          runRemovalDeps: stubbedRemoval,
          feedback: {
            collect: async () => {
              order.push('asked');
              return { reason: 'missing-feature' };
            },
            submit: async (submission) => {
              // Feedback is asked AFTER removal now, so by the time this settles
              // the credentials are already gone — and the send is still awaited,
              // so the fully-populated `order` after `runUninstall` proves the
              // POST flushed before the process would exit (an un-awaited POST
              // would resolve after teardown, i.e. after the process is gone).
              await new Promise((resolve) => setTimeout(resolve, 0));
              order.push(
                existsSync(join(home, '.ok', 'auth.yml'))
                  ? `posted-before-cleanup:${submission.source}`
                  : 'posted-after-cleanup',
              );
              return { ok: true, reference: 'FB-2' };
            },
          },
        },
      });
      // The survey is deferred to the caller now, so the removal report prints
      // before the prompt. Running it drives the survey and awaits the POST,
      // which by now lands after cleanup (auth.yml already gone).
      await result.runFeedbackAfterReport?.();
      expect(order).toEqual(['asked', 'posted-after-cleanup']);
      expect(result.status).toBe('done');
      expect(existsSync(join(home, '.ok', 'auth.yml'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('does not ask why when the removal itself failed', async () => {
    const { home, cleanup } = uninstallFixture();
    try {
      const collect = vi.fn(
        async (): Promise<UninstallFeedbackAnswers> => ({
          reason: 'missing-feature',
        }),
      );
      const submit = vi.fn(
        async (): Promise<UninstallFeedbackResult> => ({ ok: true, reference: 'X' }),
      );
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        isTTY: true,
        isStdinTTY: true,
        confirmStream: Readable.from(['y\n']),
        deps: {
          discoverLockDirs: async () => ['/some/proj/.ok/local'], // → a stop-server op
          detectInstallMethods: () => [],
          runRemovalDeps: {
            ...stubbedRemoval,
            // The SIGTERM fails → the removal outcome carries a failed op.
            stopServer: () => ({ stopped: 0, failed: [{ pid: 99, error: 'EPERM' }] }),
          },
          feedback: { collect, submit },
        },
      });
      expect(result.status).toBe('failed');
      // No survey closure is even created on a failed removal — the structural
      // contract, stronger than the mock-call-count assertions below.
      expect(result.runFeedbackAfterReport).toBeUndefined();
      expect(collect).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  test('an interrupted feedback prompt does not abort the confirmed removal', async () => {
    const { home, cleanup } = uninstallFixture();
    try {
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        isTTY: true,
        isStdinTTY: true,
        confirmStream: Readable.from(['y\n']),
        deps: {
          discoverLockDirs: async () => [],
          detectInstallMethods: () => [],
          runRemovalDeps: stubbedRemoval,
          feedback: {
            collect: async () => {
              throw new Error('User force closed the prompt with SIGINT');
            },
          },
        },
      });
      // The survey is deferred to the caller now, so run it here to actually
      // fire the SIGINT-throwing collect. promptUninstallFeedback absorbs the
      // throw (resolve-never-throw), leaving the completed removal undisturbed.
      await result.runFeedbackAfterReport?.();
      expect(result.status).toBe('done');
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(home, '.ok', 'auth.yml'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  // `echo y | ok uninstall` — stdout is a terminal but stdin is a pipe, so
  // inquirer would render a prompt that can never receive a keystroke. Pins that
  // the flow passes the stdin stream through, not stdout twice.
  test('a piped stdin on an interactive terminal is not surveyed', async () => {
    const { home, cleanup } = uninstallFixture();
    try {
      const { submissions, submit } = recordingSubmit();
      const collected: string[] = [];
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        isTTY: true,
        isStdinTTY: false,
        confirmStream: Readable.from(['y\n']),
        deps: {
          discoverLockDirs: async () => [],
          detectInstallMethods: () => [],
          runRemovalDeps: stubbedRemoval,
          feedback: {
            collect: async () => {
              collected.push('prompted');
              return { reason: 'other' };
            },
            submit,
          },
        },
      });
      expect(result.status).toBe('done');
      expect(collected).toEqual([]);
      expect(submissions).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('--yes removes without ever asking', async () => {
    const { home, cleanup } = uninstallFixture();
    try {
      const { submissions, submit } = recordingSubmit();
      const collected: string[] = [];
      const result = await runUninstall({
        home,
        platform: 'darwin',
        cwd: home,
        yes: true,
        deps: {
          discoverLockDirs: async () => [],
          detectInstallMethods: () => [],
          runRemovalDeps: stubbedRemoval,
          feedback: {
            collect: async () => {
              collected.push('prompted');
              return { reason: 'other' };
            },
            submit,
          },
        },
      });
      expect(result.status).toBe('done');
      expect(collected).toEqual([]);
      expect(submissions).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
