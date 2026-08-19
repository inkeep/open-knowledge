import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { PTY_PLATFORM_SKIP_REASON, PTY_PLATFORM_SUPPORTED } from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();
const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';

test.describe('terminal dock-state IPC', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PTY_PLATFORM_SUPPORTED, PTY_PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('terminal tab snapshot survives renderer reload together', async ({ captureStderrFor }) => {
    const testRoot = mkdtempSync(join(tmpdir(), 'ok-terminal-dock-state-'));
    const projectDir = join(testRoot, 'project');
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
    writeFileSync(join(projectDir, 'start.md'), '# Start\n');
    const userDataDir = join(testRoot, 'user-data');
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      join(userDataDir, 'state.json'),
      JSON.stringify({
        recentProjects: [
          { path: projectDir, name: 'Dock State Smoke', lastOpenedAt: new Date().toISOString() },
        ],
        lastOpenedProject: projectDir,
        versionPendingInstall: null,
        lastSeenVersion: null,
        lastSuccessfulCheckAt: null,
        stuckHintShown: false,
      }),
    );
    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${userDataDir}`],
        timeout: 30_000,
        env: { ...process.env, OK_RECLAIM_DISABLE: '1' },
      }),
    );
    captureStderrFor(app, { cleanupDirs: [testRoot] });
    let page: Page | undefined;
    await expect(async () => {
      for (const candidate of app.windows()) {
        const mode = await candidate
          .evaluate(() => window.okDesktop?.config?.mode)
          .catch(() => undefined);
        if (mode === 'editor') {
          page = candidate;
          return;
        }
      }
      throw new Error('no editor window yet');
    }).toPass({ timeout: 25_000 });
    const editorPage = page;
    if (editorPage == null) throw new Error('editor window vanished after readiness poll');

    // The agents panel persists its own order, and on load with no threads that
    // push is `{ order: [], activeKey: null }` — the very value this test asserts
    // after the reload below. So the synthetic order here is racing the panel:
    // write it first and the panel's push overwrites it moments later, which is
    // the empty `agents` seen in CI.
    //
    // Wait for that push to land before writing. With no threads to change, the
    // panel does not push again, so the write then stands. Verifying the read
    // rather than the `{ ok: true }` is still worth it — the ack says main
    // accepted the write, not that it survived.
    await expect
      .poll(() => editorPage.evaluate(() => window.okDesktop?.terminal.getDockState()))
      .toMatchObject({ agents: { order: [], activeKey: null } });

    await expect
      .poll(async () => {
        await editorPage.evaluate(() =>
          window.okDesktop?.terminal.setDockState({
            surface: 'agents',
            order: ['thread-a', 'thread-b'],
            activeKey: 'thread-a',
          }),
        );
        return editorPage.evaluate(() => window.okDesktop?.terminal.getDockState());
      })
      .toMatchObject({ agents: { order: ['thread-a', 'thread-b'], activeKey: 'thread-a' } });
    await expect
      .poll(() =>
        editorPage.evaluate(() =>
          window.okDesktop?.terminal.setDockState({
            surface: 'terminal',
            order: ['pty-a', 'pty-b'],
            activeKey: 'pty-b',
            terminalSnapshot: {
              tabs: [
                { ordinal: 1, customLabel: null },
                { ordinal: 2, customLabel: 'Build' },
              ],
              activeOrdinal: 2,
            },
          }),
        ),
      )
      .toEqual({ ok: true });

    const expectedBeforeReload = {
      terminal: { order: ['pty-a', 'pty-b'], activeKey: 'pty-b' },
      terminalSnapshot: {
        tabs: [
          { ordinal: 1, customLabel: null },
          { ordinal: 2, customLabel: 'Build' },
        ],
        activeOrdinal: 2,
      },
      agents: { order: ['thread-a', 'thread-b'], activeKey: 'thread-a' },
    };
    await expect
      .poll(() => editorPage.evaluate(() => window.okDesktop?.terminal.getDockState()))
      .toMatchObject(expectedBeforeReload);
    const dockState = await editorPage.evaluate(() => window.okDesktop?.terminal.getDockState());
    expect(dockState).not.toHaveProperty('placement');
    expect(dockState).not.toHaveProperty('rightWidth');

    await editorPage.reload({ waitUntil: 'domcontentloaded' });
    await expect
      .poll(() =>
        editorPage.evaluate(async () => {
          const state = await window.okDesktop?.terminal.getDockState();
          return {
            agents: state?.agents,
            terminalCount: state?.terminal?.order.length,
            activeIndex: state?.terminal?.order.indexOf(state.terminal.activeKey ?? ''),
            terminalSnapshot: state?.terminalSnapshot,
          };
        }),
      )
      .toEqual({
        agents: { order: [], activeKey: null },
        terminalCount: 2,
        activeIndex: 1,
        terminalSnapshot: expectedBeforeReload.terminalSnapshot,
      });
  });
});
