import {
  hasUninstallFeedbackContent,
  UNINSTALL_FEEDBACK_REASONS,
  type UninstallFeedbackAnswers,
  type UninstallFeedbackResult,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test, vi } from 'vitest';
import {
  buildDesktopUninstallFeedbackHtml,
  confirmDesktopUninstall,
  type DesktopUninstallProjectCandidate,
  parseDesktopUninstallFeedbackUrl,
  runDesktopUninstallFeedbackStep,
  runDesktopUninstallOutcomeStep,
} from '../../src/main/desktop-uninstall.ts';

const html = buildDesktopUninstallFeedbackHtml();

describe('desktop uninstall feedback window', () => {
  test('offers every shared reason as one single-select radio group', () => {
    for (const reason of UNINSTALL_FEEDBACK_REASONS) {
      expect(html).toContain(`<input type="radio" name="reason" value="${reason.value}"`);
    }
    const radios = html.match(/<input type="radio"/g) ?? [];
    expect(radios).toHaveLength(UNINSTALL_FEEDBACK_REASONS.length);
    // One shared `name` is what makes the group single-select.
    const groupNames = new Set(
      [...html.matchAll(/<input type="radio" name="([^"]+)"/g)].map((match) => match[1]),
    );
    expect(groupNames).toEqual(new Set(['reason']));
  });

  test('renders the reason labels in taxonomy order, HTML-escaped', () => {
    const positions = UNINSTALL_FEEDBACK_REASONS.map((reason) =>
      html.indexOf(`value="${reason.value}"`),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain('It didn&#39;t fit into my workflow');
    expect(html).toContain('Bugs, crashes, or it felt unreliable');
  });

  test('pre-selects no reason so an untouched form stays empty', () => {
    expect(html).not.toMatch(/<input type="radio"[^>]*\schecked/);
  });

  test('offers an optional note and an email field revealed by an opt-in', () => {
    expect(html).toContain('<textarea');
    expect(html).toContain('id="note"');
    expect(html).toContain('id="email-optin"');
    expect(html).toContain('type="email"');
    // A real label plus a format-example placeholder (parity with the in-app
    // feedback form's example, without falling back to placeholder-as-label).
    expect(html).toContain('for="email"');
    expect(html).toMatch(/id="email"[^>]*placeholder="you@company\.com"/);
    // Hidden AND disabled until opted in: a hidden-but-validatable email input
    // makes the browser refuse to submit rather than reveal the field.
    expect(html).toMatch(/id="email-field"[^>]*\shidden/);
    expect(html).toMatch(/id="email"[^>]*\sdisabled/);
  });

  test('offers a skip and a send action, neither styled as the destructive button', () => {
    expect(html).toContain('>Skip<');
    expect(html).toContain('Send &amp; continue');
    expect(html).toContain('class="primary"');
    // `.danger` / the destructive red belong to the confirm screen that already ran.
    expect(html).not.toContain('danger');
    expect(html).not.toContain('#d70015');
  });

  test('states the data-egress disclosure under the heading, matching the CLI', () => {
    // The survey collects an optional note + email, so it names where that goes.
    // Wording is kept in parity with the CLI survey's disclosure line.
    expect(html).toContain('What you share is sent to the OpenKnowledge team.');
    expect(html).toContain('id="egress"');
    // The "content is kept" reassurance lives on the completion screen, not here.
    expect(html).not.toContain('markdown content');
    // Shares the one type scale with the sibling windows (from the base CSS).
    expect(html).toContain('font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;');
  });

  test('cannot be light-dismissed by Escape or a backdrop', () => {
    expect(html).not.toContain('keydown');
    expect(html).not.toContain('Escape');
    expect(html).not.toContain('backdrop');
    expect(html).not.toContain('window.close');
  });

  // `form-action` and `base-uri` do not fall back to `default-src`, so the only
  // page here holding an email address states them, rather than resting the
  // containment entirely on the inline script's preventDefault.
  test('bounds form submission and base URI in the policy, not just the script', () => {
    expect(html).toContain(
      `content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none';"`,
    );
  });

  test('opens focused on the exit that sends nothing, like its sibling windows', () => {
    expect(html).toContain('<button id="skip" type="button" autofocus>');
  });

  test('describes the dialog by its heading and the egress disclosure', () => {
    expect(html).toContain('aria-labelledby="title"');
    expect(html).toContain('aria-describedby="egress"');
  });

  test('matches the sibling uninstall windows native-dialog vocabulary', () => {
    expect(html).toContain(':root { color-scheme: light dark; }');
    expect(html).toContain('font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;');
    expect(html).toContain('color: CanvasText;');
    expect(html).toContain('background: Canvas;');
    expect(html).toContain(
      'button:focus-visible { outline: 3px solid Highlight; outline-offset: 2px; }',
    );
  });

  test('routes both actions through the intercepted private navigation scheme', () => {
    expect(html).toContain("'ok-desktop-uninstall://'");
    expect(html).toContain("finish('feedback-skip'");
    expect(html).toContain("finish('feedback-send'");
  });
});

describe('desktop uninstall feedback result channel', () => {
  test('reads a full submission back off the URL', () => {
    expect(
      parseDesktopUninstallFeedbackUrl(
        'ok-desktop-uninstall://feedback-send?reason=missing-feature&note=No%20outline%20view&email=leaver%40example.com',
      ),
    ).toEqual({
      reason: 'missing-feature',
      note: 'No outline view',
      email: 'leaver@example.com',
    });
  });

  test('round-trips note text containing URL and HTML metacharacters', () => {
    const note = 'a=1 & b=2 <script> "quoted" — 👋\nsecond line';
    const parsed = parseDesktopUninstallFeedbackUrl(
      `ok-desktop-uninstall://feedback-send?note=${encodeURIComponent(note)}`,
    );
    expect(parsed).toEqual({ note });
  });

  test('reads a skip as an empty, unpostable answer set', () => {
    const parsed = parseDesktopUninstallFeedbackUrl('ok-desktop-uninstall://feedback-skip');
    expect(parsed).toEqual({});
    expect(parsed && hasUninstallFeedbackContent(parsed)).toBe(false);
  });

  test('reads a send with nothing filled in as equally unpostable', () => {
    const parsed = parseDesktopUninstallFeedbackUrl(
      'ok-desktop-uninstall://feedback-send?note=%20%20&email=',
    );
    expect(parsed).toEqual({});
    expect(parsed && hasUninstallFeedbackContent(parsed)).toBe(false);
  });

  test('keeps the rest of the submission when the reason slug is not in the taxonomy', () => {
    expect(
      parseDesktopUninstallFeedbackUrl(
        'ok-desktop-uninstall://feedback-send?reason=too-expensive&note=cost',
      ),
    ).toEqual({ note: 'cost' });
  });

  test('clamps oversized answers to the intake field limits', () => {
    const parsed = parseDesktopUninstallFeedbackUrl(
      `ok-desktop-uninstall://feedback-send?note=${'n'.repeat(12_000)}&email=${'e'.repeat(400)}`,
    );
    expect(parsed?.note).toHaveLength(10_000);
    expect(parsed?.email).toHaveLength(320);
  });

  test('ignores every URL that is not a feedback result', () => {
    for (const url of [
      'ok-desktop-uninstall://confirm?indexes=0,1',
      'ok-desktop-uninstall://cancel',
      'ok-desktop-uninstall://notice-confirm',
      'https://openknowledge.ai/feedback-send',
      'data:text/html,<p>hi</p>',
      'not a url',
    ]) {
      expect(parseDesktopUninstallFeedbackUrl(url)).toBeNull();
    }
  });
});

/** Let every pending microtask run, so an abandoned promise shows up as done. */
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

describe('runDesktopUninstallOutcomeStep', () => {
  test('asks why then shows completion when cleanup succeeded', async () => {
    const order: string[] = [];
    await runDesktopUninstallOutcomeStep({
      cleanup: { ok: true },
      runFeedbackStep: async () => {
        order.push('feedback');
      },
      showCompletion: async () => {
        order.push('completion');
      },
      showFailure: async () => {
        order.push('failure');
      },
    });
    // Feedback runs AFTER the removal, and only before the finish screen.
    expect(order).toEqual(['feedback', 'completion']);
  });

  test('shows failure and never asks why when cleanup failed', async () => {
    const runFeedbackStep = vi.fn(async () => {});
    const showCompletion = vi.fn(async () => {});
    const showFailure = vi.fn(async () => {});
    await runDesktopUninstallOutcomeStep({
      cleanup: { ok: false, error: 'deinit refused /Users/me/notes' },
      runFeedbackStep,
      showCompletion,
      showFailure,
    });
    expect(showFailure).toHaveBeenCalledTimes(1);
    expect(runFeedbackStep).not.toHaveBeenCalled();
    expect(showCompletion).not.toHaveBeenCalled();
  });

  test('holds the completion screen until the awaited feedback send settles', async () => {
    let releaseFeedback: () => void = () => {};
    let completionShown = false;
    const done = runDesktopUninstallOutcomeStep({
      cleanup: { ok: true },
      runFeedbackStep: () =>
        new Promise<void>((resolve) => {
          releaseFeedback = resolve;
        }),
      showCompletion: async () => {
        completionShown = true;
      },
      showFailure: async () => {},
    });

    await settleQueue();
    expect(completionShown).toBe(false);

    releaseFeedback();
    await done;
    expect(completionShown).toBe(true);
  });
});
