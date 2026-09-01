import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type WindowGlobals = { MutationObserver?: typeof MutationObserver; NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.MutationObserver === undefined &&
  globalWithDomShims.window?.MutationObserver !== undefined
) {
  globalWithDomShims.MutationObserver = globalWithDomShims.window.MutationObserver;
}
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}
if (typeof HTMLElement.prototype.scrollIntoView !== 'function') {
  HTMLElement.prototype.scrollIntoView = () => {};
}

vi.doMock('@inkeep/open-knowledge-core', () => ({
  SHOW_INSTALL_SKILL: false,
  MARKDOWNLINT_RULE_CATALOG: [],
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      if (typeof strings === 'string') return strings;
      return strings.reduce(
        (text, chunk, index) =>
          `${text}${chunk}${index < values.length ? String(values[index]) : ''}`,
        '',
      );
    },
  }),
}));

const probeActiveIds: string[] = [];
vi.doMock('@/components/settings/SettingsDialogBodyLazy', () => ({
  SettingsDialogBodyLazy: ({ activeId }: { activeId: string }) => {
    probeActiveIds.push(activeId);
    return (
      <div data-testid="settings-body-probe">
        <div data-field="section:terminal" data-testid="probe-terminal-block" />
        <div data-field="section:content-rules" data-testid="probe-content-rules-block" />
        <div data-field="section:sharing" data-testid="probe-sharing-block" />
      </div>
    );
  },
}));

vi.doMock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <div {...props}>{children}</div>
  ),
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogTitle: ({ children, id }: { children?: ReactNode; id?: string }) => (
    <h2 id={id}>{children}</h2>
  ),
}));

vi.doMock('@/components/ui/skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) => <div className={className} />,
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ collabUrl: 'ws://test.invalid' }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    userBinding: null,
    userSynced: false,
    okignoreBinding: null,
    okignoreSynced: false,
  }),
}));

vi.doMock('@/lib/handoff/use-claude-desktop-integration', () => ({
  useClaudeDesktopIntegration: () => ({ desktopPresent: false }),
}));

const { SettingsDialogShell } = await import('./SettingsDialogShell');

function setDesktopHost(present: boolean, opts: { ptyAvailable?: boolean } = {}) {
  const w = window as unknown as { okDesktop?: unknown };
  if (present) {
    w.okDesktop = { config: { ptyAvailable: opts.ptyAvailable ?? true } };
  } else {
    w.okDesktop = undefined;
  }
}

const SUBSECTION_RESULT_ID = 'settings-search-result-subsection:project-preferences:terminal';

async function searchTerminal(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId('settings-search-input'), 'Terminal');
}

describe('SettingsDialogShell terminal subsection (desktop-only)', () => {
  beforeEach(() => {
    setDesktopHost(false);
    probeActiveIds.length = 0;
  });
  afterEach(() => {
    cleanup();
    setDesktopHost(false);
  });

  test('indexes the Terminal subsection under the Electron host and navigates to project Preferences', async () => {
    setDesktopHost(true);
    const user = userEvent.setup();
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    expect(screen.queryByTestId('settings-sidebar-item-terminal')).toBeNull();

    await searchTerminal(user);
    const result = await screen.findByTestId(SUBSECTION_RESULT_ID);

    await user.click(result);
    expect(probeActiveIds.at(-1)).toBe('project-preferences');
  });

  test('a legacy terminal deep link anchors the block, not just the page', async () => {
    setDesktopHost(true);
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} initialSection="terminal" />);

    expect(probeActiveIds.at(-1)).toBe('project-preferences');
    await waitFor(() => {
      expect(
        screen.getByTestId('probe-terminal-block').classList.contains('animate-settings-nav-flash'),
      ).toBe(true);
    });
  });

  test.each([
    ['content-rules', 'project-preferences', 'probe-content-rules-block'],
    ['sharing', 'sync', 'probe-sharing-block'],
  ])('a legacy %s deep link resolves to %s and anchors its block', async (alias, page, probe) => {
    setDesktopHost(true);
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} initialSection={alias} />);

    expect(probeActiveIds.at(-1)).toBe(page);
    await waitFor(() => {
      expect(screen.getByTestId(probe).classList.contains('animate-settings-nav-flash')).toBe(true);
    });
  });

  test('drops the Terminal search entry on the web host (no okDesktop bridge)', async () => {
    setDesktopHost(false);
    const user = userEvent.setup();
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    await searchTerminal(user);
    await waitFor(() => {
      expect(screen.getByTestId('settings-search-empty')).toBeDefined();
    });
    expect(screen.queryByTestId(SUBSECTION_RESULT_ID)).toBeNull();
  });

  test('drops the Terminal search entry on a PTY-less Electron host', async () => {
    setDesktopHost(true, { ptyAvailable: false });
    const user = userEvent.setup();
    render(<SettingsDialogShell open={true} onOpenChange={() => {}} />);

    await searchTerminal(user);
    await waitFor(() => {
      expect(screen.getByTestId('settings-search-empty')).toBeDefined();
    });
    expect(screen.queryByTestId(SUBSECTION_RESULT_ID)).toBeNull();
  });
});
