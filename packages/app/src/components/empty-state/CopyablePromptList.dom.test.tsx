/**
 * RTL behavioral tests for `CopyablePromptList` — the embedded-host
 * (Cursor/Codex/Claude) copy-to-clipboard counterpart to the composer.
 *
 * Load-bearing regression: the list used to call `navigator.clipboard.writeText`
 * directly with a silent `.catch()`. Inside Claude's embedded iframe the parent
 * frame's Permissions-Policy denies `clipboard-write`, so the async write
 * rejects — and the swallowed rejection meant the click did NOTHING (no copy, no
 * "Copied" feedback). The fix routes through `scheduleClipboardWrite`, whose
 * `execCommand('copy')` fallback still fires under the click's transient
 * activation where the policy-gated async API is refused.
 *
 * These tests pin both halves of that contract:
 *   - happy path     → adapter resolves, row flips to "Copied"
 *   - embedded iframe → navigator.clipboard rejects, execCommand copies anyway,
 *                       row still flips to "Copied"
 *
 * Substrate: jsdom via `bun run test:dom`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

const { CopyablePromptList } = await import('./CopyablePromptList');

describe('CopyablePromptList', () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, 'okDesktop');
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
  });
  afterEach(() => {
    cleanup();
    // Restore any document.execCommand stub an individual test installed —
    // mirrors the save/restore discipline in clipboard-adapter.test.ts so a
    // later test can't silently inherit a prior test's fallback behavior.
    Reflect.deleteProperty(globalThis.document, 'execCommand');
  });

  test('flips a row to "Copied" when the clipboard write resolves', async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<CopyablePromptList scenario="new-project" />);

    const button = screen.getByTestId('copy-prompt-button-competitor-research');
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByTestId('copy-prompt-button-competitor-research').textContent).toContain(
        'Copied',
      );
    });
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  test('falls back to execCommand and still copies when embedded-iframe policy refuses the async write', async () => {
    // Reproduce Claude's embedded iframe: navigator.clipboard exists but the
    // Permissions-Policy refusal surfaces as a rejected writeText.
    const writeText = mock(() =>
      Promise.reject(
        Object.assign(new Error('blocked because of a permissions policy'), {
          name: 'NotAllowedError',
        }),
      ),
    );
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const execCommand = mock(() => true);
    Object.defineProperty(globalThis.document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    render(<CopyablePromptList scenario="new-project" />);

    fireEvent.click(screen.getByTestId('copy-prompt-button-competitor-research'));

    await waitFor(() => {
      expect(screen.getByTestId('copy-prompt-button-competitor-research').textContent).toContain(
        'Copied',
      );
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });

  test('does not flip to "Copied" when every clipboard path is refused', async () => {
    // Graceful-degradation contract: when the async write rejects AND the
    // execCommand fallback returns false (no Electron bridge either), the row
    // must stay on "Copy" — never show a false success. Guards the trivial
    // `.catch()` in handleCopy against silent removal.
    const writeText = mock(() =>
      Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })),
    );
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const execCommand = mock(() => false);
    Object.defineProperty(globalThis.document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    render(<CopyablePromptList scenario="new-project" />);
    fireEvent.click(screen.getByTestId('copy-prompt-button-competitor-research'));

    // Await both refusals so the assertion lands after the catch settles, not
    // on a bare timeout: writeText rejects, then execCommand is attempted.
    await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('copy-prompt-button-competitor-research').textContent).not.toContain(
      'Copied',
    );
  });
});
