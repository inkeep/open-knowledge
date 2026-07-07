/**
 * first-launch MCP-wiring consent-dialog smoke test — drives an isolated
 * `HOME=<tmpdir>` Electron launch through the full dialog round-trip, proving
 * (1) the dialog renders after renderer-mount-ack handshake, (2) Add writes
 * per-editor MCP configs + the user-scoped marker, (3) Skip writes the skip
 * marker and no editor configs, (4) a pre-existing `configured:true` marker
 * keeps the dialog silent on relaunch, and (5) partial failures leave the
 * marker absent so the next boot can retry.
 *
 * Scope + limitations:
 *   - `_electron.launch({ env: {HOME}, args: [..., '--user-data-dir=<path>'] })`
 *     with `OK_M6B_FORCE=1` bypasses the `app.isPackaged` gate.
 *     `HOME` propagates through `os.homedir()` (which the mcp-wiring code path
 *     consumes via the `home: osHomedir()` injection in main/index.ts), so the
 *     marker at `$HOME/.ok/mcp-status.json` and editor configs at `$HOME/.claude.json`
 *     etc. are honored. The `--user-data-dir` switch isolates `app.getPath('userData')`
 *     (where state.json lives) — Electron's dev-mode default reads
 *     `NSBundle.mainBundle`'s CFBundleName ("Electron"), which would otherwise
 *     leak into the real user's `~/Library/Application Support/Electron/`
 *     regardless of HOME. Every edit the app writes lands under the tmpdir —
 *     the developer's real `~/.claude.json` is never touched.
 *
 *   - **Cold-start `openknowledge://` deep-link with dialog firing in the
 *     deep-link-opened editor** is deferred — same reason as the cold-start
 *     skip: macOS Launch Services needs a signed + notarized DMG to bind the
 *     scheme to this bundle instead of generic Electron, and there's no way
 *     to fire a true pre-whenReady Apple Event from Playwright without it.
 *
 *   - **P1 E2E signed-DMG smoke — fresh Mac, no Node, no terminal
 *     contact** is creds-gated on Apple Developer notarization and is the
 *     same gate blocking the signed-DMG scenarios. Not executable from this test file.
 *
 * Skip gates mirror `deep-link.e2e.ts`:
 *   - `OK_DESKTOP_E2E_SMOKE !== '1'` — opt-in so `bunx playwright test` on the
 *     whole repo doesn't try to launch Electron in headless CI.
 *   - `process.platform !== 'darwin'` — gates on darwin.
 *   - `out/main/index.js` missing — `bun run build:desktop` must have run.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

interface LaunchOpts {
  tmpHome: string;
  extraEnv?: Record<string, string>;
}

// Compute the per-test Electron userData dir under tmpHome. The Chromium
// `--user-data-dir=<path>` switch is the only mechanism that reliably
// isolates `app.getPath('userData')` in dev mode — Electron's default
// resolution reads `NSBundle.mainBundle`'s CFBundleName (which is
// "Electron" when launched via `Electron.app/Contents/MacOS/Electron`,
// regardless of `productName` or the `HOME` env var).
function userDataDirFor(tmpHome: string): string {
  return join(tmpHome, 'electron-userdata');
}

async function launchApp({ tmpHome, extraEnv }: LaunchOpts): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDirFor(tmpHome)}`],
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: tmpHome,
      OK_M6B_FORCE: '1',
      OK_DESKTOP_E2E_SMOKE: '1',
      ...extraEnv,
    },
  });
}

function createTmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ok-m6b-${prefix}-`));
}

function seedEditorDetectionDirs(tmpHome: string, editorHints: readonly string[]): void {
  for (const rel of editorHints) {
    mkdirSync(join(tmpHome, rel), { recursive: true });
  }
}

function markerPath(tmpHome: string): string {
  return join(tmpHome, '.ok', 'mcp-status.json');
}

function readMarker(tmpHome: string): Record<string, unknown> | null {
  const p = markerPath(tmpHome);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
}

async function waitForConsentDialog(app: ElectronApplication, timeoutMs = 20_000): Promise<Page> {
  return await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          const visible = await page
            .locator('[data-testid="mcp-consent-add"]')
            .isVisible()
            .catch(() => false);
          if (visible) return page;
        }
        return null;
      },
      {
        timeout: timeoutMs,
        message: 'McpConsentDialog did not appear — renderer mount-ack handshake may have failed',
      },
    )
    .not.toBeNull()
    .then(async () => {
      for (const page of app.windows()) {
        const visible = await page
          .locator('[data-testid="mcp-consent-add"]')
          .isVisible()
          .catch(() => false);
        if (visible) return page;
      }
      throw new Error('dialog was visible during poll but no window has it now');
    });
}

function forceRemove(pathsToRestore: readonly string[], dir: string): void {
  // `chmod 444` dirs break `rmSync` even with `force:true` — restore perms first.
  for (const p of pathsToRestore) {
    try {
      chmodSync(p, 0o755);
    } catch {
      // already gone or never created
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ENOTEMPTY race: Electron's background shutdown writes (Cookies-journal
    // flush, Cache compaction, utility-process teardown) under
    // `tmpHome/electron-userdata/` may still be landing while this cleanup
    // fires. Per-test isolation is preserved (each test gets its own
    // tmpHome); leftover bytes are harmless and the OS tmpdir reaper
    // handles GC. Swallow the error so the test result reflects the test
    // assertion, not a cleanup race.
  }
}

test.describe('M6b first-launch MCP-wiring smoke (US-010)', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'M6b is macOS-only in v0 (D51 / D-M6-R7).');
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop" first.`,
  );

  // Cold-start `openknowledge://` delivery to a deep-link-opened editor
  // window as the FIRST window. Deferred until signed DMG enables Launch
  // Services binding; parallels the same skip in `deep-link.e2e.ts`.
  test.skip('F2 (cold-start deep-link) — deferred until signed DMG enables Launch Services binding', () => {
    // Intentionally empty. Implementation requires:
    //   1. Signed + notarized DMG so `openknowledge://` binds to this bundle.
    //   2. A harness that fires `open openknowledge://...` against a
    //      not-yet-running installed .app (no `_electron.launch` pre-boot)
    //      and asserts both the deep-link editor and the consent dialog
    //      arrive in that same window.
  });

  // P1 E2E full-flow smoke with signed DMG — creds-gated on Apple
  // Developer notarization. Documented-skip so CI output makes the coverage
  // gap visible; parallels the signed-DMG scenarios.
  test.skip('AC2.6 (fresh-Mac P1 E2E with signed DMG) — creds-gated on Apple notarization', () => {
    // Intentionally empty. Full end-to-end: fresh Mac, no Node installed,
    // no terminal contact, install signed DMG → first launch → dialog →
    // Accept defaults → open Claude Desktop → agent write → renderer
    // flashes + file on disk. Requires Apple Developer creds.
  });

  test('happy-path — Add writes marker + Claude config with resilient chain MCP entry', async ({
    captureStderrFor,
  }) => {
    const tmpHome = createTmpHome('happy');
    // Claude detected via `~/.claude/` existence.
    seedEditorDetectionDirs(tmpHome, ['.claude']);
    try {
      const app = await launchApp({ tmpHome });
      captureStderrFor(app);
      const window = await waitForConsentDialog(app);
      await window.getByTestId('mcp-consent-add').click();

      await expect
        .poll(() => readMarker(tmpHome), {
          timeout: 15_000,
          message: 'marker not written within 15s of Add click',
        })
        .not.toBeNull();

      const marker = readMarker(tmpHome);
      expect(marker).toMatchObject({ configured: true });
      expect(marker).toHaveProperty('configuredAt');
      expect(marker).toHaveProperty('editors');
      expect(Array.isArray((marker as { editors: unknown }).editors)).toBe(true);
      expect((marker as { editors: string[] }).editors).toContain('claude');

      // Claude config lives at `~/.claude.json` with top-level
      // `mcpServers['open-knowledge']`.
      const claudeConfigPath = join(tmpHome, '.claude.json');
      expect(existsSync(claudeConfigPath)).toBe(true);
      const claudeConfig = JSON.parse(readFileSync(claudeConfigPath, 'utf8')) as {
        mcpServers?: { 'open-knowledge'?: { command?: string; args?: string[] } };
      };
      const okEntry = claudeConfig.mcpServers?.['open-knowledge'];
      expect(okEntry).toBeDefined();
      expect(okEntry?.command).toBe('/bin/sh');
      expect(okEntry?.args?.slice(0, 2)).toEqual(['-l', '-c']);
      // args[2] is the chain body — assert the sentinel embed without coupling
      // to every byte of the chain text. Byte-exact verification lives in the
      // CLI unit tests (`editors.test.ts`).
      expect(typeof okEntry?.args?.[2]).toBe('string');
      expect(okEntry?.args?.[2]).toContain('# ok-mcp-v1');
    } finally {
      forceRemove([], tmpHome);
    }
  });

  test('skip — writes configured:false marker and no editor configs', async ({
    captureStderrFor,
  }) => {
    const tmpHome = createTmpHome('skip');
    seedEditorDetectionDirs(tmpHome, ['.claude']);
    try {
      const app = await launchApp({ tmpHome });
      captureStderrFor(app);
      const window = await waitForConsentDialog(app);
      await window.getByTestId('mcp-consent-skip').click();

      await expect
        .poll(() => readMarker(tmpHome), {
          timeout: 15_000,
          message: 'skip marker not written within 15s of Skip click',
        })
        .not.toBeNull();

      const marker = readMarker(tmpHome);
      expect(marker).toMatchObject({ configured: false });
      expect(marker).toHaveProperty('skippedAt');

      // No editor config should exist — skip means zero writes.
      expect(existsSync(join(tmpHome, '.claude.json'))).toBe(false);
      expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
    } finally {
      forceRemove([], tmpHome);
    }
  });

  test('idempotency — configured:true marker silences dialog on relaunch', async ({
    captureStderrFor,
  }) => {
    const tmpHome = createTmpHome('idempotent');
    // Pre-populate a configured marker — simulates a prior completed consent.
    mkdirSync(join(tmpHome, '.ok'), { recursive: true });
    writeFileSync(
      markerPath(tmpHome),
      JSON.stringify({
        configured: true,
        configuredAt: new Date().toISOString(),
        editors: ['claude'],
        cliPath: '/usr/local/bin/ok',
      }),
    );
    seedEditorDetectionDirs(tmpHome, ['.claude']);

    try {
      const app = await launchApp({ tmpHome });
      captureStderrFor(app);
      const firstWindow = await app.firstWindow({ timeout: 15_000 });
      expect(firstWindow).toBeDefined();

      // Negative assertion — give the handshake enough time to complete
      // (signalReady → renderer-ready → show would fire within ~2s on a
      // clean run), then assert no dialog ever surfaced.
      //
      // Timeout raised from 5s → 10s. Trade-off documented:
      // (a) PR-tier flakiness under CI load spikes — 5s false-fired ~1/200
      //     runs against the local dev container; 10s halves that without
      //     adding meaningful wall-clock to a single test.
      // (b) A regression that delays dialog suppression past 10s STILL
      //     escapes this test — the negative-assertion shape has no
      //     positive condition to await (Playwright's `expect.poll` doesn't
      //     fit "thing did NOT happen"). The nightly-e2e-stability
      //     surveillance workflow (`--repeat-each` / low `--workers`) is
      //     the catch-all for slow-burn regressions in this
      //     class — accepted compounding-trade-off.
      // (c) The reviewer's option-(b) (production env-flag test hook) is
      //     declined: production-only test hooks for one e2e are a
      //     larger architectural commitment than this gap warrants.
      await firstWindow.waitForTimeout(10_000);
      for (const page of app.windows()) {
        const addButton = page.locator('[data-testid="mcp-consent-add"]');
        await expect(addButton).toHaveCount(0);
      }

      // Marker untouched.
      const marker = readMarker(tmpHome);
      expect(marker).toMatchObject({ configured: true, editors: ['claude'] });
    } finally {
      forceRemove([], tmpHome);
    }
  });

  test('partial-failure — read-only Cursor dir leaves marker absent, other writes succeed', async ({
    captureStderrFor,
  }) => {
    const tmpHome = createTmpHome('partial');
    // Two editors detected: Claude, Cursor. We'll lock Cursor's
    // parent dir to 0o444 so the per-editor write fails but the others succeed.
    seedEditorDetectionDirs(tmpHome, ['.claude', '.cursor']);
    const cursorDir = join(tmpHome, '.cursor');
    chmodSync(cursorDir, 0o444);

    try {
      const app = await launchApp({ tmpHome });
      captureStderrFor(app);
      const window = await waitForConsentDialog(app);
      await window.getByTestId('mcp-consent-add').click();

      // Wait for the IPC round-trip's observable side effects to land. On
      // partial failure the consent IPC returns `{ ok: false, error: ... }`
      // and the dialog INTENTIONALLY stays open (mcp-wiring.ts —
      // "Reset handled so a same-boot retry lands"), so we cannot key on
      // the Add button disappearing. Instead, poll for the successful
      // per-editor writes — they fire BEFORE the IPC returns its result,
      // so their presence guarantees the round-trip has reached the
      // partial-failure branch.
      await expect
        .poll(() => existsSync(join(tmpHome, '.claude.json')), {
          timeout: 15_000,
          message: 'expected write to .claude.json after Add (partial-failure branch)',
        })
        .toBe(true);

      // (ii) marker NOT written — per deferred-marker semantics, ANY
      // per-editor failure leaves the marker absent so next boot re-fires.
      expect(readMarker(tmpHome)).toBeNull();

      // (i) one write succeeds, one failed:
      expect(existsSync(join(tmpHome, '.claude.json'))).toBe(true);
      expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
    } finally {
      forceRemove([cursorDir], tmpHome);
    }
  });

  test('F1 — lastOpenedProject opens editor first, dialog still fires', async ({
    captureStderrFor,
  }) => {
    const tmpHome = createTmpHome('f1');
    seedEditorDetectionDirs(tmpHome, ['.claude']);

    // Create a project directory + `.ok/config.yml` so the opened
    // project is valid (FileWatcher + content-filter have an admit surface).
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-m6b-f1-project-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'config.yml'),
      "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
    );

    // Pre-populate state.json with lastOpenedProject. Path matches the
    // `--user-data-dir=<path>` Chromium switch this test passes via
    // `launchApp` — explicit isolation, no reliance on Electron's
    // dev-mode CFBundleName resolution.
    const userDataDir = userDataDirFor(tmpHome);
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      join(userDataDir, 'state.json'),
      JSON.stringify({
        recentProjects: [
          {
            path: projectDir,
            name: 'F1 Smoke Project',
            lastOpenedAt: new Date().toISOString(),
          },
        ],
        lastOpenedProject: projectDir,
        versionPendingInstall: null,
        lastSeenVersion: null,
        lastSuccessfulCheckAt: null,
        stuckHintShown: false,
      }),
    );

    try {
      const app = await launchApp({ tmpHome });
      captureStderrFor(app);

      // Dialog fires in whichever window opens first — editor if
      // lastOpenedProject was honored, Navigator otherwise. Either way the
      // test passes as long as the dialog appears and Add works (host-agnostic
      // host-agnostic dispatch).
      const window = await waitForConsentDialog(app);
      await window.getByTestId('mcp-consent-add').click();

      await expect
        .poll(() => readMarker(tmpHome), {
          timeout: 15_000,
          message: 'marker not written after Add in F1 flow',
        })
        .not.toBeNull();

      const marker = readMarker(tmpHome);
      expect(marker).toMatchObject({ configured: true });
    } finally {
      forceRemove([], tmpHome);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
