import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge, OkV1UpgradeSnapshot } from '@/lib/desktop-bridge-types';
import {
  applyV1UpgradeSnapshot,
  dismissV1UpgradeToast,
  getV1UpgradeState,
  installV1UpgradeBridge,
  openV1UpgradeDialog,
  resetV1UpgradeStoreForTests,
  setV1UpgradeDialogOpen,
  shouldShowV1AboutCard,
  shouldShowV1CornerToast,
  shouldShowV1HeaderPill,
  shouldShowV1NavigatorCard,
  startV1UpgradeOptIn,
} from './v1-upgrade-store';

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

afterEach(() => {
  resetV1UpgradeStoreForTests();
});

describe('v1 upgrade visibility predicates', () => {
  test('all surfaces stay hidden when dormant', () => {
    const dormant = makeSnapshot({ availableVersion: null });
    expect(shouldShowV1CornerToast(null)).toBe(false);
    expect(shouldShowV1CornerToast(dormant)).toBe(false);
    expect(shouldShowV1HeaderPill(dormant)).toBe(false);
    expect(shouldShowV1NavigatorCard(dormant)).toBe(false);
    expect(shouldShowV1AboutCard(dormant)).toBe(false);
  });

  test('Stage 1 shows Corner Toast + Navigator + About, hiding Header Pill until dismissed', () => {
    const s = makeSnapshot();
    expect(shouldShowV1CornerToast(s)).toBe(true);
    expect(shouldShowV1HeaderPill(s)).toBe(false);
    expect(shouldShowV1NavigatorCard(s)).toBe(true);
    expect(shouldShowV1AboutCard(s)).toBe(true);
  });

  test('Stage 2 collapses Corner Toast to quiet Header Pill after dismissal', () => {
    const s = makeSnapshot({ toastDismissed: true });
    expect(shouldShowV1CornerToast(s)).toBe(false);
    expect(shouldShowV1HeaderPill(s)).toBe(true);
    expect(shouldShowV1NavigatorCard(s)).toBe(true);
    expect(shouldShowV1AboutCard(s)).toBe(true);
  });

  test('updateMode=off suppresses all proactive surfaces while keeping About card visible', () => {
    const s = makeSnapshot({ proactiveAllowed: false, toastDismissed: false });
    expect(shouldShowV1CornerToast(s)).toBe(false);
    expect(shouldShowV1HeaderPill(s)).toBe(false);
    expect(shouldShowV1NavigatorCard(s)).toBe(false);
    expect(shouldShowV1AboutCard(s)).toBe(true);
  });

  test('ready phase shows Restart pill, Navigator card, and About card even when proactiveAllowed is false', () => {
    const s = makeSnapshot({ proactiveAllowed: false, toastDismissed: false, phase: 'ready' });
    expect(shouldShowV1CornerToast(s)).toBe(false);
    expect(shouldShowV1HeaderPill(s)).toBe(true);
    expect(shouldShowV1NavigatorCard(s)).toBe(true);
    expect(shouldShowV1AboutCard(s)).toBe(true);
  });
});

describe('v1 upgrade store bridge wiring', () => {
  test('hydrates from state.query, updates on live push, and forwards dismiss + opt-in actions', async () => {
    const initial = makeSnapshot({ availableVersion: null });
    const live = makeSnapshot({ availableVersion: '1.0.0', okignoreProjects: ['handbook'] });
    let onChanged: ((next: OkV1UpgradeSnapshot) => void) | null = null;
    const dismissV1Toast = vi.fn(async () => {});
    const optInV1Upgrade = vi.fn(async () => ({ ok: true as const }));

    const bridge = {
      state: {
        query: vi.fn(async () => ({
          channel: 'latest' as const,
          schemaIncompatibility: null,
          v1Upgrade: initial,
        })),
      },
      onV1UpgradeChanged: (cb: (next: OkV1UpgradeSnapshot) => void) => {
        onChanged = cb;
        return () => {
          onChanged = null;
        };
      },
      onUpdateManualCheck: () => () => {},
      update: {
        dismissV1Toast,
        optInV1Upgrade,
      },
    } as unknown as OkDesktopBridge;

    const dispose = installV1UpgradeBridge(bridge);
    await Promise.resolve();
    expect(getV1UpgradeState().snapshot).toEqual(initial);

    onChanged?.(live);
    expect(getV1UpgradeState().snapshot).toEqual(live);

    openV1UpgradeDialog();
    expect(getV1UpgradeState().dialogOpen).toBe(true);
    expect(getV1UpgradeState().dialogEverOpened).toBe(true);
    setV1UpgradeDialogOpen(false);
    expect(getV1UpgradeState().dialogOpen).toBe(false);
    expect(getV1UpgradeState().dialogEverOpened).toBe(true);

    dismissV1UpgradeToast(bridge);
    expect(getV1UpgradeState().snapshot?.toastDismissed).toBe(true);
    expect(dismissV1Toast).toHaveBeenCalledTimes(1);

    await expect(startV1UpgradeOptIn(bridge)).resolves.toEqual({ ok: true });
    expect(optInV1Upgrade).toHaveBeenCalledTimes(1);

    applyV1UpgradeSnapshot(null);
    expect(getV1UpgradeState().snapshot).toBeNull();
    dispose();
  });
});
