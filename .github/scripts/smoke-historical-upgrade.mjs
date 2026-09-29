import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withMountedDmg } from './dmg-mount.mjs';

export async function smokeHistoricalUpgrade(argv = process.argv.slice(2)) {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Invoked directly by GitHub Actions, outside Turbo.
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Historical upgrade verification requires an isolated GitHub macOS runner.');
  }

  const desktopRoot = resolve('packages/desktop');
  const require_ = createRequire(join(desktopRoot, 'package.json'));
  const { _electron, expect } = require_('@playwright/test');
  const { parse } = require_('yaml');
  const [oldDmg, channel] = argv;
  assert.ok(oldDmg && ['latest', 'beta'].includes(channel));
  const outputDir = join(desktopRoot, 'dist-desktop');
  const manifestName = `${channel}-mac.yml`;
  const manifest = parse(readFileSync(join(outputDir, manifestName), 'utf8'));
  const userData = join(homedir(), 'Library/Application Support/OpenKnowledge');
  assert.equal(existsSync(userData), false, 'The upgrade test must not touch existing app state.');
  const statePath = join(userData, 'state.json');
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
  let available = false;
  let manifestRequests = 0;
  const server = createServer((request, response) => {
    const filename = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(1));
    if (filename === manifestName) manifestRequests++;
    if (!available) {
      response.writeHead(503).end();
      return;
    }
    if (basename(filename) !== filename || !existsSync(join(outputDir, filename))) {
      response.writeHead(404).end();
      return;
    }
    const file = join(outputDir, filename);
    response.writeHead(200, { 'content-length': statSync(file).size });
    createReadStream(file).pipe(response);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const feedUrl = `http://127.0.0.1:${server.address().port}`;
  let application;

  try {
    await withMountedDmg(oldDmg, async (appPath) => {
      const executablePath = join(appPath, 'Contents/MacOS/OpenKnowledge');
      const launch = async () => {
        application = await _electron.launch({
          executablePath,
          env: { ...process.env, OK_UPDATER_FEED_URL: feedUrl },
          timeout: 90_000,
        });
        const page = await application.firstWindow();
        await page.waitForFunction(() => Boolean(window.okDesktop?.update?.checkNow));
        return page;
      };
      const firstPage = await launch();
      const fromVersion = await application.evaluate(({ app }) => app.getVersion());
      assert.notEqual(fromVersion, manifest.version);
      await firstPage.evaluate(() => window.okDesktop.update.checkNow());
      await expect.poll(() => manifestRequests, { timeout: 60_000 }).toBeGreaterThan(0);
      await application.close();
      application = undefined;
      writeFileSync(statePath, JSON.stringify({ ...state(), lastUsedProjectParent: appPath }));

      available = true;
      const page = await launch();
      await page.evaluate(() => window.okDesktop.update.checkNow());
      await expect
        .poll(() => state().versionPendingInstall, { timeout: 240_000 })
        .toBe(manifest.version);
      const closed = application.waitForEvent('close', { timeout: 90_000 });
      await page.evaluate(() => {
        void window.okDesktop.update.relaunchNow();
      });
      await closed;
      application = undefined;
      await expect
        .poll(
          () => {
            return execFileSync(
              '/usr/libexec/PlistBuddy',
              ['-c', 'Print :CFBundleShortVersionString', join(appPath, 'Contents/Info.plist')],
              { encoding: 'utf8' },
            ).trim();
          },
          { timeout: 120_000 },
        )
        .toBe(manifest.version);
      await expect.poll(() => state().lastSeenVersion, { timeout: 90_000 }).toBe(manifest.version);
      assert.equal(
        state().lastUsedProjectParent,
        appPath,
        'An upgrade must preserve existing app settings.',
      );
      execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
      execFileSync('/usr/bin/osascript', ['-e', `tell application "${appPath}" to quit`], {
        timeout: 30_000,
      });
      await expect
        .poll(
          () =>
            execFileSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8' })
              .split('\n')
              .some((line) => line.startsWith(executablePath)),
          { timeout: 30_000 },
        )
        .toBe(false);

      const upgraded = await launch();
      assert.equal(await application.evaluate(({ app }) => app.getVersion()), manifest.version);
      const before = manifestRequests;
      await upgraded.evaluate(() => window.okDesktop.update.checkNow());
      await expect.poll(() => manifestRequests, { timeout: 60_000 }).toBeGreaterThan(before);
      await expect.poll(() => state().versionPendingInstall, { timeout: 30_000 }).toBeNull();
      await application.close();
      application = undefined;
      console.log(
        JSON.stringify({
          fromVersion,
          toVersion: manifest.version,
          channel,
          offlineRetry: 'passed',
          install: 'passed',
          settings: 'preserved',
          nextCheck: 'passed',
        }),
      );
    });
  } finally {
    if (application) await application.close();
    await new Promise((done) => server.close(done));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await smokeHistoricalUpgrade();
}
