import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { OkDesktopBridge, OkV1UpgradeSnapshot } from '@/lib/desktop-bridge-types';
import { applyV1UpgradeSnapshot, resetV1UpgradeStoreForTests } from '@/lib/v1-upgrade-store';
import { renderWithI18n } from '../../tests/foundation/render-with-i18n.test-helper';
import {
  V1UpgradeAboutCard,
  V1UpgradeCornerToast,
  V1UpgradeDialogHost,
  V1UpgradeHeaderPill,
  V1UpgradeNavigatorCard,
} from './V1UpgradeNotice';

function makeSnapshot(overrides: Partial<OkV1UpgradeSnapshot> = {}): OkV1UpgradeSnapshot {
  return {
    availableVersion: '1.0.0',
    proactiveAllowed: true,
    toastDismissed: false,
    canInstallInApp: true,
    autoInstallOnAppQuit: true,
    phase: 'idle',
    progressPercent: null,
    errorCode: null,
    okignoreProjects: [],
    hasGitProjects: false,
    manualDownloadUrl: 'https://openknowledge.ai/download',
    migrationGuideUrl: 'https://openknowledge.ai/updates/v1-guide',
    releaseNotesUrl: 'https://openknowledge.ai/updates/v1-notes',
    ...overrides,
  };
}

function installMockBridge() {
  const openExternal = vi.fn(async (_url: string) => {});
  const dismissV1Toast = vi.fn(async () => {});
  const optInV1Upgrade = vi.fn(async () => ({ ok: true as const }));
  const relaunchNow = vi.fn(async () => {});
  const bridge = {
    shell: { openExternal },
    update: { dismissV1Toast, optInV1Upgrade, relaunchNow },
  } as unknown as OkDesktopBridge;
  Object.defineProperty(window, 'okDesktop', {
    value: bridge,
    configurable: true,
    writable: true,
  });
  return { openExternal, dismissV1Toast, optInV1Upgrade, relaunchNow };
}

afterEach(() => {
  cleanup();
  resetV1UpgradeStoreForTests();
  (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
});

describe('V1UpgradeNotice Option D flow', () => {
  test('collapses Stage 1 corner toast into Stage 2 quiet titlebar pill when Not now is clicked', async () => {
    const { dismissV1Toast } = installMockBridge();
    applyV1UpgradeSnapshot(makeSnapshot({ okignoreProjects: ['engineering-handbook'] }));

    renderWithI18n(
      <div>
        <V1UpgradeHeaderPill />
        <V1UpgradeCornerToast />
        <V1UpgradeDialogHost />
      </div>,
    );

    expect(screen.getByTestId('v1-upgrade-corner-toast')).not.toBeNull();
    expect(screen.getByTestId('v1-upgrade-toast-okignore')).not.toBeNull();
    expect(screen.queryByTestId('v1-upgrade-header-pill')).toBeNull();

    await userEvent.click(screen.getByTestId('v1-upgrade-toast-not-now'));

    expect(dismissV1Toast).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('v1-upgrade-corner-toast')).toBeNull();
    const pill = screen.getByTestId('v1-upgrade-header-pill');
    expect(pill.textContent).toContain('1.0 available');
  });

  test('gates Download & Upgrade behind .okignore acknowledgment, links a11y metadata, and recovers from relaunch-failed', async () => {
    const { openExternal, optInV1Upgrade, relaunchNow } = installMockBridge();
    applyV1UpgradeSnapshot(
      makeSnapshot({
        okignoreProjects: ['engineering-handbook'],
        hasGitProjects: true,
      }),
    );

    renderWithI18n(
      <div>
        <V1UpgradeHeaderPill />
        <V1UpgradeCornerToast />
        <V1UpgradeDialogHost />
      </div>,
    );

    const toastReviewButton = screen.getByTestId('v1-upgrade-toast-review');
    toastReviewButton.focus();
    await userEvent.click(toastReviewButton);
    expect(await screen.findByTestId('v1-upgrade-dialog')).not.toBeNull();
    expect(screen.getByTestId('v1-upgrade-okignore-callout').textContent).toContain(
      'engineering-handbook',
    );

    await userEvent.click(screen.getByTestId('v1-upgrade-release-notes'));
    await userEvent.click(screen.getByTestId('v1-upgrade-migration-guide'));
    expect(openExternal).toHaveBeenCalledWith('https://openknowledge.ai/updates/v1-notes');
    expect(openExternal).toHaveBeenCalledWith('https://openknowledge.ai/updates/v1-guide');

    const primary = screen.getByTestId('v1-upgrade-primary') as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    expect(primary.getAttribute('aria-describedby')).toBe('v1-upgrade-okignore-requirement');

    await userEvent.click(screen.getByTestId('v1-upgrade-okignore-checkbox'));
    expect(primary.disabled).toBe(false);
    expect(primary.getAttribute('aria-describedby')).toBeNull();

    await userEvent.click(primary);
    expect(optInV1Upgrade).toHaveBeenCalledTimes(1);

    act(() => {
      applyV1UpgradeSnapshot(
        makeSnapshot({
          okignoreProjects: ['engineering-handbook'],
          phase: 'downloading',
          progressPercent: 64,
        }),
      );
    });
    expect(screen.getByTestId('v1-upgrade-progress').textContent).toContain('64%');
    expect(screen.getByRole('progressbar').getAttribute('aria-labelledby')).toBe(
      'v1-upgrade-progress-label',
    );
    expect(screen.getByTestId('v1-upgrade-live-status').textContent).toContain(
      'Downloading OpenKnowledge 1.0',
    );

    act(() => {
      applyV1UpgradeSnapshot(
        makeSnapshot({
          okignoreProjects: ['engineering-handbook'],
          phase: 'ready',
          progressPercent: 100,
        }),
      );
    });
    expect(screen.getByTestId('v1-upgrade-ready').textContent).toContain('next time you quit');
    expect(screen.getByTestId('v1-upgrade-header-pill').textContent).toContain(
      'Restart to finish 1.0',
    );

    await userEvent.click(screen.getByTestId('v1-upgrade-primary'));
    expect(relaunchNow).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('v1-upgrade-primary') as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      applyV1UpgradeSnapshot(
        makeSnapshot({
          okignoreProjects: ['engineering-handbook'],
          proactiveAllowed: false,
          phase: 'ready',
          progressPercent: 100,
        }),
      );
    });
    expect((screen.getByTestId('v1-upgrade-primary') as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      applyV1UpgradeSnapshot(
        makeSnapshot({
          okignoreProjects: ['engineering-handbook'],
          phase: 'error',
          errorCode: 'relaunch-failed',
        }),
      );
    });
    expect(screen.getByTestId('v1-upgrade-error').textContent).toContain(
      "Couldn't restart to install OpenKnowledge 1.0",
    );
    expect((screen.getByTestId('v1-upgrade-primary') as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(screen.getByTestId('v1-upgrade-primary'));
    expect(relaunchNow).toHaveBeenCalledTimes(2);
    expect(optInV1Upgrade).toHaveBeenCalledTimes(1);

    act(() => {
      applyV1UpgradeSnapshot(
        makeSnapshot({
          okignoreProjects: ['engineering-handbook'],
          phase: 'error',
          errorCode: 'already-staged',
        }),
      );
    });
    expect(screen.queryByTestId('v1-upgrade-primary')).toBeNull();

    await userEvent.click(screen.getByTestId('v1-upgrade-cancel'));
    await vi.waitFor(() => expect(screen.queryByTestId('v1-upgrade-dialog')).toBeNull());
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('v1-upgrade-toast-review')),
    );
  });

  test('restores focus to surviving header pill when opener unmounts while dialog is open', async () => {
    installMockBridge();
    applyV1UpgradeSnapshot(makeSnapshot());

    renderWithI18n(
      <div>
        <V1UpgradeHeaderPill />
        <V1UpgradeCornerToast />
        <V1UpgradeDialogHost />
      </div>,
    );

    const toastReviewButton = screen.getByTestId('v1-upgrade-toast-review');
    toastReviewButton.focus();
    await userEvent.click(toastReviewButton);
    expect(await screen.findByTestId('v1-upgrade-dialog')).not.toBeNull();

    act(() => {
      applyV1UpgradeSnapshot(makeSnapshot({ toastDismissed: true }));
    });
    expect(screen.queryByTestId('v1-upgrade-corner-toast')).toBeNull();

    await userEvent.click(screen.getByTestId('v1-upgrade-cancel'));
    await vi.waitFor(() => expect(screen.queryByTestId('v1-upgrade-dialog')).toBeNull());
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('v1-upgrade-header-pill')),
    );
  });

  test('hides proactive surfaces when proactiveAllowed is false while keeping About card visible', () => {
    installMockBridge();
    applyV1UpgradeSnapshot(makeSnapshot({ proactiveAllowed: false }));

    renderWithI18n(
      <div>
        <V1UpgradeCornerToast />
        <V1UpgradeHeaderPill />
        <V1UpgradeNavigatorCard />
        <V1UpgradeAboutCard />
      </div>,
    );

    expect(screen.queryByTestId('v1-upgrade-corner-toast')).toBeNull();
    expect(screen.queryByTestId('v1-upgrade-header-pill')).toBeNull();
    expect(screen.queryByTestId('v1-upgrade-navigator-card')).toBeNull();
    expect(screen.getByTestId('v1-upgrade-about-card')).not.toBeNull();
  });
});
