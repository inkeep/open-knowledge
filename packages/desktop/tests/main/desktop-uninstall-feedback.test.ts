import type {
  UninstallFeedbackAnswers,
  UninstallFeedbackResult,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test, vi } from 'vitest';
import {
  confirmDesktopUninstall,
  type DesktopUninstallProjectCandidate,
  runDesktopUninstallFeedbackStep,
} from '../../src/main/desktop-uninstall.ts';

const settleQueue = () => new Promise((resolve) => setTimeout(resolve, 0));

const answered: UninstallFeedbackAnswers = { reason: 'unreliable', note: 'crashed on open' };

describe('desktop uninstall feedback step', () => {
  test('sends what the user left, tagged with the desktop surface', async () => {
    const submit = vi.fn(
      async (): Promise<UninstallFeedbackResult> => ({ ok: true, reference: 'FB-12' }),
    );
    const outcome = await runDesktopUninstallFeedbackStep({
      collect: async () => answered,
      appVersion: '1.4.0',
      platform: 'darwin',
      submit,
    });
    expect(submit).toHaveBeenCalledWith({
      reason: 'unreliable',
      note: 'crashed on open',
      source: 'desktop_uninstall',
      appVersion: '1.4.0',
      platform: 'darwin',
    });
    expect(outcome).toEqual({ status: 'submitted', result: { ok: true, reference: 'FB-12' } });
  });

  test('posts nothing when the user leaves without answering', async () => {
    const submit = vi.fn();
    const outcome = await runDesktopUninstallFeedbackStep({
      collect: async () => ({}),
      appVersion: '1.4.0',
      submit,
    });
    expect(outcome).toEqual({ status: 'skipped' });
    expect(submit).not.toHaveBeenCalled();
  });

  test('waits for the submit to settle instead of abandoning it', async () => {
    let releaseSubmit: (result: UninstallFeedbackResult) => void = () => {};
    let stepDone = false;
    const step = runDesktopUninstallFeedbackStep({
      collect: async () => answered,
      appVersion: '1.4.0',
      submit: () =>
        new Promise<UninstallFeedbackResult>((resolve) => {
          releaseSubmit = resolve;
        }),
    }).then((outcome) => {
      stepDone = true;
      return outcome;
    });

    await settleQueue();
    expect(stepDone).toBe(false);

    releaseSubmit({ ok: true, reference: 'FB-13' });
    expect(await step).toEqual({ status: 'submitted', result: { ok: true, reference: 'FB-13' } });
  });

  test('moves on when the submit gives up at its timeout ceiling', async () => {
    const outcome = await runDesktopUninstallFeedbackStep({
      collect: async () => answered,
      appVersion: '1.4.0',
      submit: async () => ({ ok: false, reason: 'timeout' }),
    });
    expect(outcome).toEqual({ status: 'submitted', result: { ok: false, reason: 'timeout' } });
  });

  test('never throws when the window or the transport breaks', async () => {
    const brokenWindow = await runDesktopUninstallFeedbackStep({
      collect: async () => {
        throw new Error('window gone');
      },
      appVersion: '1.4.0',
      submit: async () => ({ ok: true, reference: 'unreachable' }),
    });
    expect(brokenWindow.status).toBe('failed');

    const brokenTransport = await runDesktopUninstallFeedbackStep({
      collect: async () => answered,
      appVersion: '1.4.0',
      submit: async () => {
        throw new Error('transport gone');
      },
    });
    expect(brokenTransport.status).toBe('failed');
  });
});

describe('desktop uninstall confirm step', () => {
  const candidate = (path: string): DesktopUninstallProjectCandidate => ({
    path,
    open: false,
    recent: true,
    running: false,
  });

  test('carries the picked projects through when confirmed via the picker', async () => {
    const picked = [candidate('/Users/me/notes'), candidate('/Users/me/specs')];
    const outcome = await confirmDesktopUninstall({
      candidates: picked,
      showProjectPicker: async () => picked,
      showConfirmNotice: async () => true,
    });
    expect(outcome).toEqual({
      proceed: true,
      projectPaths: ['/Users/me/notes', '/Users/me/specs'],
    });
  });

  test('proceeds after the plain confirm notice when no projects were found', async () => {
    const outcome = await confirmDesktopUninstall({
      candidates: [],
      showProjectPicker: async () => [],
      showConfirmNotice: async () => true,
    });
    expect(outcome).toEqual({ proceed: true, projectPaths: [] });
  });

  test('does not proceed when either confirm surface is called off', async () => {
    expect(
      await confirmDesktopUninstall({
        candidates: [candidate('/Users/me/notes')],
        showProjectPicker: async () => null,
        showConfirmNotice: async () => true,
      }),
    ).toEqual({ proceed: false });

    expect(
      await confirmDesktopUninstall({
        candidates: [],
        showProjectPicker: async () => [],
        showConfirmNotice: async () => false,
      }),
    ).toEqual({ proceed: false });
  });
});
