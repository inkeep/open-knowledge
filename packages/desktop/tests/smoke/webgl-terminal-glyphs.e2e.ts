import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { sumOfDeclaredBoundsMs } from './_helpers/parse-timeouts';
import { homeEnv, userDataDirFor } from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();
const DARWIN = process.platform === 'darwin';
const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const appRequire = createRequire(new URL('../../../app/package.json', import.meta.url));

interface FontAssignment {
  requested: string;
  applied: string;
}

interface TerminalInstance {
  open(host: HTMLElement): void;
  loadAddon(addon: unknown): void;
  write(data: string, callback: () => void): void;
  dispose(): void;
}

interface XtermGlobals {
  Terminal: new (options: Record<string, unknown>) => TerminalInstance;
  WebglAddon: { WebglAddon: new () => unknown };
}

async function recordTerminalFonts(page: Page): Promise<FontAssignment[]> {
  await page.evaluate(readFileSync(appRequire.resolve('@xterm/xterm'), 'utf8'));
  await page.evaluate(readFileSync(appRequire.resolve('@xterm/addon-webgl'), 'utf8'));
  return page.evaluate(async () => {
    const { Terminal, WebglAddon } = globalThis as unknown as XtermGlobals;
    const prototype = CanvasRenderingContext2D.prototype;
    const font = Object.getOwnPropertyDescriptor(prototype, 'font');
    const readFont = font?.get;
    const writeFont = font?.set;
    if (font === undefined || readFont === undefined || writeFont === undefined) {
      throw new Error('the canvas font property has no accessor');
    }
    const assignments: FontAssignment[] = [];
    Object.defineProperty(prototype, 'font', {
      ...font,
      set(this: CanvasRenderingContext2D, value: string) {
        writeFont.call(this, value);
        assignments.push({ requested: value, applied: readFont.call(this) });
      },
    });
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:240px';
    document.body.append(host);
    const terminal = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13 });
    try {
      terminal.open(host);
      terminal.loadAddon(new WebglAddon.WebglAddon());
      await new Promise<void>((resolve) => {
        terminal.write('Regular \u001b[1mBold\u001b[0m \u001b[3mItalic\u001b[0m', resolve);
      });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      return assignments;
    } finally {
      terminal.dispose();
      host.remove();
      Object.defineProperty(prototype, 'font', font);
    }
  });
}

test.describe('Terminal WebGL glyphs — live Electron', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'This guard has passed only on the macOS smoke cells so far.');
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('regular and bold terminal glyphs keep the configured font in the Electron renderer', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(sumOfDeclaredBoundsMs(test.info()));
    const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'ok-terminal-glyphs-home-')));
    const userDataDir = userDataDirFor(tmpHome);
    mkdirSync(userDataDir, { recursive: true });

    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${userDataDir}`],
        timeout: 30_000,
        env: {
          ...process.env,
          ...homeEnv(tmpHome),
          OK_DESKTOP_E2E_SMOKE: '1',
          OPENKNOWLEDGE_RECLAIM_DISABLE: '1',
        },
      }),
    );
    captureStderrFor(app, { home: tmpHome, cleanupDirs: [tmpHome] });

    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const assignments = await recordTerminalFonts(page);
    const applied = assignments
      .filter(({ requested }) => /\b(?:normal|bold) \d+px Menlo/.test(requested))
      .map((assignment) => assignment.applied);

    expect(applied).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\d+px Menlo/),
        expect.stringMatching(/^bold \d+px Menlo/),
      ]),
    );
    expect(applied.filter((font) => !font.includes('Menlo'))).toEqual([]);
  });
});
