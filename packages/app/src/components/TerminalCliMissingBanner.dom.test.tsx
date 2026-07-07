/**
 * Behavioral tests for the docked-terminal missing-CLI banner — the codex/cursor
 * equivalent of ClaudeReadinessBanner's `not-found` branch. Asserts the
 * actionable "Get <Brand>" affordance opens the CLI's install docs and that the
 * dismiss control fires `onDismiss`. Symmetric with the Claude readiness banner,
 * which already tests its "Get Claude Code" action.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { TERMINAL_CLIS } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

const { TerminalCliMissingBanner } = await import('./TerminalCliMissingBanner');

function makeBridge() {
  const openExternal = mock(async (_url: string) => {});
  return {
    bridge: { shell: { openExternal } } as unknown as OkDesktopBridge,
    openExternal,
  };
}

describe('TerminalCliMissingBanner', () => {
  afterEach(() => {
    cleanup();
  });

  test('"Get Codex" opens the Codex CLI docs URL', async () => {
    const { bridge, openExternal } = makeBridge();
    render(<TerminalCliMissingBanner cli="codex" bridge={bridge} onDismiss={() => {}} />);

    // Message names the brand + the actual binary so triage knows what's missing.
    expect(screen.getByText(/Codex \(codex\) isn't installed/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Get Codex' }));
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(TERMINAL_CLIS.codex.docsUrl);
  });

  test('"Get Cursor" opens the Cursor CLI docs URL (binary is cursor-agent)', async () => {
    const { bridge, openExternal } = makeBridge();
    render(<TerminalCliMissingBanner cli="cursor" bridge={bridge} onDismiss={() => {}} />);

    expect(screen.getByText(/Cursor \(cursor-agent\) isn't installed/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Get Cursor' }));
    expect(openExternal).toHaveBeenCalledWith(TERMINAL_CLIS.cursor.docsUrl);
  });

  test('the dismiss control fires onDismiss without opening docs', async () => {
    const { bridge, openExternal } = makeBridge();
    const onDismiss = mock(() => {});
    render(<TerminalCliMissingBanner cli="codex" bridge={bridge} onDismiss={onDismiss} />);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
