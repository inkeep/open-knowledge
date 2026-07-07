/**
 * Share-receive miss smoke — the cross-process proof that a share link whose
 * target vanished upstream lands the receiver on the honest verdict DIALOG and
 * NEVER the create-mode editor (where a receiver could silently fork the doc at
 * the shared path). Because main flags the target missing, the dialog shows
 * without navigating to the dead path — no phantom tab is opened.
 *
 * The journey: seed a receiver clone whose branch no longer carries the shared
 * doc (deleted on origin), fire the share URL, and assert the dispatched window
 * resolves the miss dialog with the `deleted` verdict — proving the whole chain
 * end-to-end (main share-resolution -> `ok:deep-link` IPC -> renderer miss
 * dispatch -> the real target-status fetch against the receiver's server).
 *
 * **Delivery: argv cold-start, not `open -g`.** The sibling smokes shell out to
 * `open -g "openknowledge://..."` for true Apple-Event delivery, and that is the
 * right channel on a CI runner where no app owns the scheme. But on any host with
 * OpenKnowledge.app installed (every dev machine, this one included), macOS Launch
 * Services binds `openknowledge://` to that signed bundle, so `open -g` routes the
 * event there and the Playwright-launched dev Electron never receives it — the
 * poll then times out. Passing the URL as an argv entry drives the app's
 * documented cold-start CLI-launch scan (`registerProtocolHandler`'s initial-argv
 * loop), which reaches `enqueueOrRoute` and runs the identical routing the Apple
 * Event would, deterministically on every host. The pure Apple-Event channel stays
 * covered by `deep-link.e2e.ts` on a clean runner.
 *
 * Candidate selection matches on the seeded Recents `gitRemoteUrl`, which is
 * intentionally decoupled from the receiver's real `origin` (a local bare repo):
 * the GitHub URL satisfies the share's owner/repo match while the local origin lets
 * the target-status fetch run for real and return a genuine `deleted` verdict.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: 'pipe',
  });
}

const OK_CONFIG = "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n";

interface MissFixture {
  readonly root: string;
  readonly receiver: string;
  readonly docPath: string;
}

/**
 * Build origin (bare) + receiver (clone) where the shared doc was committed then
 * deleted on the branch, so the receiver's working tree lacks it and origin's
 * history proves the deletion. Returns realpath-collapsed paths so the receiver
 * matches the dispatched window's `projectPath` after the macOS `/var` ->
 * `/private/var` normalization the main process applies.
 */
function setupDeletedTargetFixture(): MissFixture {
  const uniq = randomUUID().slice(0, 8);
  const docPath = `docs/moved-${uniq}.md`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-share-miss-')));
  const originDir = join(root, 'origin.git');
  const seedDir = join(root, 'seed');
  const receiverDir = join(root, 'receiver');

  mkdirSync(originDir);
  git(originDir, 'init', '--bare', '--initial-branch=main');

  mkdirSync(seedDir);
  git(seedDir, 'init', '--initial-branch=main');
  git(seedDir, 'config', 'user.email', 'test@example.com');
  git(seedDir, 'config', 'user.name', 'Test');
  git(seedDir, 'remote', 'add', 'origin', originDir);
  mkdirSync(join(seedDir, '.ok'), { recursive: true });
  writeFileSync(join(seedDir, '.ok', 'config.yml'), OK_CONFIG);
  mkdirSync(join(seedDir, 'docs'), { recursive: true });
  writeFileSync(join(seedDir, docPath), `# moved ${uniq}\n`);
  git(seedDir, 'add', '.');
  git(seedDir, 'commit', '-m', 'seed doc');
  git(seedDir, 'push', 'origin', 'main');
  git(seedDir, 'rm', docPath);
  git(seedDir, 'commit', '-m', 'delete doc');
  git(seedDir, 'push', 'origin', 'main');

  git(root, 'clone', originDir, receiverDir);
  return { root, receiver: realpathSync(receiverDir), docPath };
}

test.describe('share-receive miss terminal smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Deep-link URL scheme is macOS-only in v0.');
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop" first.`,
  );

  test('a deleted share target lands the receiver on the miss dialog, never create-mode', async ({
    captureStderrFor,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    const fixture = setupDeletedTargetFixture();

    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-share-miss-home-'));
    const userData = join(tmpHome, 'electron-userdata');
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, 'state.json'),
      JSON.stringify({
        recentProjects: [
          {
            path: fixture.receiver,
            name: 'receiver',
            lastOpenedAt: new Date().toISOString(),
            gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
          },
        ],
        projectSessions: {},
      }),
    );

    const githubBlobUrl = `https://github.com/inkeep/open-knowledge/blob/main/${fixture.docPath}`;
    const shareUrl = `openknowledge://share?url=${encodeURIComponent(githubBlobUrl)}`;

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userData}`, shareUrl],
      timeout: 30_000,
    });
    captureStderrFor(app, { cleanupDirs: [fixture.root, tmpHome] });

    const firstWindow = await app.firstWindow({ timeout: 15_000 });
    expect(firstWindow).toBeDefined();

    // Poll every window until one resolves the miss DIALOG. A known-missing
    // target shows the honest verdict as a modal WITHOUT navigating to the dead
    // path, so `hasEditor === false` alongside the resolved dialog is the "never
    // create-mode fork" proof — the receiver never landed in an editor at the
    // shared path.
    type MissState = {
      phase: string | null;
      verdict: string | null;
      hasEditor: boolean;
      bodyText: string;
    };
    let resolved: MissState | null = null;
    await expect(async () => {
      for (const page of app.windows()) {
        const info: MissState | null = await page
          .evaluate(() => {
            const dialog = document.querySelector('[data-testid="share-receive-miss-dialog"]');
            return {
              phase: dialog?.getAttribute('data-phase') ?? null,
              verdict: dialog?.getAttribute('data-verdict') ?? null,
              hasEditor: !!document.querySelector('.ProseMirror'),
              bodyText: document.body?.innerText ?? '',
            };
          })
          .catch(() => null);
        if (info?.phase === 'resolved') {
          resolved = info;
          return;
        }
      }
      throw new Error('no window has resolved the share-receive miss dialog yet');
    }).toPass({ timeout: 60_000 });

    if (resolved === null) throw new Error('share-receive miss dialog never resolved');
    const outcome: MissState = resolved;
    expect(outcome.verdict).toBe('deleted');
    expect(outcome.hasEditor).toBe(false);
    expect(outcome.bodyText).toContain('removed from branch');
  });
});
