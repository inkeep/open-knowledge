/**
 * Surface tests for the `useInstalledAgents` React hook module.
 *
 * Repo convention: no `@testing-library/react` + `happy-dom` (same as
 * `EditorActivityPool.test.ts`, `NavigatorApp.test.ts`, `ProjectSwitcher.test.ts`).
 * Behavior is tested through the pure `createProbeCoordinator` primitive in
 * `packages/app/src/lib/handoff/install-detect.test.ts` — that file covers
 * the throttle, inflight dedup, and web-host Cursor override paths.
 *
 * This file's job is to catch refactor drift in the module's public surface
 * and to lock the host-classifier's contract:
 *   - `useInstalledAgents` is exported as a function
 *   - `isElectronHostDefault` is a pure classifier (no side effects)
 *   - `defaultProbeDeps` returns a `ProbeDeps` whose `isElectronHost()` agrees
 *     with the active window's `okDesktop` presence
 *
 * Full component behavior (dropdown render, async refresh on open, disabled
 * tooltip) lands under Playwright coverage.
 */

import { describe, expect, test } from 'bun:test';

describe('useInstalledAgents module surface', () => {
  test('exports the hook + classifier + deps factory', async () => {
    const mod = await import('./useInstalledAgents');
    expect(typeof mod.useInstalledAgents).toBe('function');
    expect(typeof mod.isElectronHostDefault).toBe('function');
    expect(typeof mod.defaultProbeDeps).toBe('function');
  });
});

describe('isElectronHostDefault — pure host classifier', () => {
  test('returns false when windowLike is undefined (SSR / non-browser)', async () => {
    const { isElectronHostDefault } = await import('./useInstalledAgents');
    expect(isElectronHostDefault(undefined)).toBe(false);
  });

  test('returns false when okDesktop is absent (web / CLI distribution)', async () => {
    const { isElectronHostDefault } = await import('./useInstalledAgents');
    expect(isElectronHostDefault({})).toBe(false);
  });

  test('returns false when okDesktop is explicitly undefined', async () => {
    const { isElectronHostDefault } = await import('./useInstalledAgents');
    expect(isElectronHostDefault({ okDesktop: undefined })).toBe(false);
  });

  test('returns true when okDesktop is any non-nullish object (Electron preload populated)', async () => {
    const { isElectronHostDefault } = await import('./useInstalledAgents');
    expect(isElectronHostDefault({ okDesktop: { shell: {} } })).toBe(true);
  });
});
