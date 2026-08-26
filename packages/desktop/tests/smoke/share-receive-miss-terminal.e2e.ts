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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { PLATFORM_SKIP_REASON, PLATFORM_SUPPORTED } from './_helpers/platform-gate';
import { expect, type SmokeFixtures, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: 'pipe',
  });
}

const ROOT_OK_CONFIG = "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n";
const NESTED_OK_CONFIG = "content:\n  dir: wiki\n  include: ['**/*.md']\n  exclude: []\n";
const shareFixture: unknown = JSON.parse(
  readFileSync(
    new URL('../../../../test-support/fixtures/share-url-v1-v2.json', import.meta.url),
    'utf8',
  ),
);
const v2Share =
  typeof shareFixture === 'object' &&
  shareFixture !== null &&
  'validShares' in shareFixture &&
  Array.isArray(shareFixture.validShares)
    ? shareFixture.validShares.find(
        (share) =>
          typeof share === 'object' &&
          share !== null &&
          'id' in share &&
          share.id === 'v2-one-segment-document',
      )
    : undefined;
if (
  typeof v2Share !== 'object' ||
  v2Share === null ||
  !('version' in v2Share) ||
  v2Share.version !== 2 ||
  !('token' in v2Share) ||
  typeof v2Share.token !== 'string'
) {
  throw new Error('canonical v2 nested-document fixture is missing');
}
const V2_SHARE_TOKEN = v2Share.token;
const maxV2Share =
  typeof shareFixture === 'object' &&
  shareFixture !== null &&
  'bounds' in shareFixture &&
  typeof shareFixture.bounds === 'object' &&
  shareFixture.bounds !== null &&
  'maxCase' in shareFixture.bounds
    ? shareFixture.bounds.maxCase
    : undefined;
if (
  typeof maxV2Share !== 'object' ||
  maxV2Share === null ||
  !('token' in maxV2Share) ||
  typeof maxV2Share.token !== 'string' ||
  !('target' in maxV2Share) ||
  typeof maxV2Share.target !== 'object' ||
  maxV2Share.target === null ||
  !('docPath' in maxV2Share.target) ||
  typeof maxV2Share.target.docPath !== 'string'
) {
  throw new Error('canonical maximum v2 fixture is missing');
}
const MAX_V2_SHARE_TOKEN = maxV2Share.token;
const MAX_V2_SHARE_TARGET_PATH = maxV2Share.target.docPath;
const MAX_V2_CUSTOM_URI = `openknowledge://share?token=${MAX_V2_SHARE_TOKEN}`;

interface MissFixture {
  readonly root: string;
  readonly receiver: string;
  readonly docPath: string;
}

interface MissFixtureOptions {
  readonly docPath?: string;
  readonly okConfig?: string;
  readonly extraFiles?: Readonly<Record<string, string>>;
}

/**
 * Build origin (bare) + receiver (clone) where the shared doc was committed then
 * deleted on the branch, so the receiver's working tree lacks it and origin's
 * history proves the deletion. Returns realpath-collapsed paths so the receiver
 * matches the dispatched window's `projectPath` after the macOS `/var` ->
 * `/private/var` normalization the main process applies.
 */
function setupDeletedTargetFixture(options: MissFixtureOptions = {}): MissFixture {
  const uniq = randomUUID().slice(0, 8);
  const docPath = options.docPath ?? `docs/moved-${uniq}.md`;
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
  writeFileSync(join(seedDir, '.ok', 'config.yml'), options.okConfig ?? ROOT_OK_CONFIG);
  mkdirSync(dirname(join(seedDir, docPath)), { recursive: true });
  writeFileSync(join(seedDir, docPath), `# moved ${uniq}\n`);
  for (const [path, content] of Object.entries(options.extraFiles ?? {})) {
    mkdirSync(dirname(join(seedDir, path)), { recursive: true });
    writeFileSync(join(seedDir, path), content);
  }
  git(seedDir, 'add', '.');
  git(seedDir, 'commit', '-m', 'seed doc');
  git(seedDir, 'push', 'origin', 'main');
  git(seedDir, 'rm', docPath);
  git(seedDir, 'commit', '-m', 'delete doc');
  git(seedDir, 'push', 'origin', 'main');

  git(root, 'clone', originDir, receiverDir);
  return { root, receiver: realpathSync(receiverDir), docPath };
}

type MissState = {
  phase: string | null;
  verdict: string | null;
  hasEditor: boolean;
  hash: string;
  bodyText: string;
};

/**
 * Filename without its `.md` extension — the part of the share target that would
 * appear in the receiver's hash had it navigated there.
 */
function docStem(docPath: string): string {
  return basename(docPath, '.md');
}

async function expectDeletedTargetMiss(
  fixture: MissFixture,
  shareUrl: string,
  captureStderrFor: SmokeFixtures['captureStderrFor'],
): Promise<void> {
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

  const app = await electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${userData}`, shareUrl],
      timeout: 30_000,
    }),
  );
  captureStderrFor(app, { cleanupDirs: [fixture.root, tmpHome] });

  const firstWindow = await app.firstWindow({ timeout: 15_000 });
  expect(firstWindow).toBeDefined();

  // Poll every window until one resolves the miss DIALOG. A known-missing
  // target shows the honest verdict as a modal WITHOUT navigating to the dead
  // path, so the "never create-mode fork" proof is two-part: the hash never
  // reaches the shared target, and no DOCUMENT editor is mounted.
  //
  // A bare `.ProseMirror` query is NOT that second half. The Ask-AI composer
  // (`ComposerMentionInput`) is its own ProseMirror instance and mounts as part
  // of the ordinary shell — including the empty state a receiver whose branch
  // carries no docs lands on — so it matches whether or not a document was ever
  // opened, and whether it has mounted yet is a race against the verdict fetch.
  // `:not(.composer-prosemirror)` is what the sibling smokes use to mean "the
  // document editor, not a composer".
  let resolved: MissState | null = null;
  await expect(async () => {
    for (const page of app.windows()) {
      const info: MissState | null = await page
        .evaluate(() => {
          const dialog = document.querySelector('[data-testid="share-receive-miss-dialog"]');
          return {
            phase: dialog?.getAttribute('data-phase') ?? null,
            verdict: dialog?.getAttribute('data-verdict') ?? null,
            hasEditor: !!document.querySelector('.ProseMirror:not(.composer-prosemirror)'),
            hash: window.location.hash,
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
  // Decode first: the hash percent-encodes the whole path, so a stem holding a
  // space or non-ASCII would not appear in it verbatim. Decoding makes the check
  // independent of the encoding rather than of today's alphanumeric fixtures.
  expect(decodeURIComponent(outcome.hash)).not.toContain(docStem(fixture.docPath));
  expect(outcome.bodyText).toContain('removed from branch');
}

test.describe('share-receive miss terminal smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('a deleted share target lands the receiver on the miss dialog, never create-mode', async ({
    captureStderrFor,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    const fixture = setupDeletedTargetFixture();
    const githubBlobUrl = `https://github.com/inkeep/open-knowledge/blob/main/${fixture.docPath}`;
    await expectDeletedTargetMiss(
      fixture,
      `openknowledge://share?url=${encodeURIComponent(githubBlobUrl)}`,
      captureStderrFor,
    );
  });

  test('an exact canonical v2 nested-content argv handoff lands a deleted target on the miss dialog', async ({
    captureStderrFor,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    const fixture = setupDeletedTargetFixture({
      docPath: 'wiki/modules/backend-libraries.md',
      okConfig: NESTED_OK_CONFIG,
      extraFiles: { 'wiki/keep.md': '# keep content root present\n' },
    });
    await expectDeletedTargetMiss(
      fixture,
      `openknowledge://share?token=${V2_SHARE_TOKEN}`,
      captureStderrFor,
    );
  });

  test('the exact 4,012-character canonical v2 custom URI survives argv delivery unchanged', async ({
    captureStderrFor,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    expect(MAX_V2_SHARE_TOKEN).toHaveLength(3984);
    expect(MAX_V2_CUSTOM_URI).toHaveLength(4012);

    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-share-max-argv-home-'));
    const userData = join(tmpHome, 'electron-userdata');
    mkdirSync(userData, { recursive: true });
    writeFileSync(
      join(userData, 'state.json'),
      JSON.stringify({ recentProjects: [], projectSessions: {} }),
    );

    const app = await electron.launch(
      desktopLaunchOptions({
        target: TARGET,
        args: [`--user-data-dir=${userData}`, MAX_V2_CUSTOM_URI],
        timeout: 30_000,
      }),
    );
    captureStderrFor(app, { cleanupDirs: [tmpHome] });
    await app.firstWindow({ timeout: 15_000 });

    let dialogText = '';
    await expect(async () => {
      for (const page of app.windows()) {
        const text = await page
          .evaluate((expectedPath) => {
            const dialog = document.querySelector('[data-testid="share-receive-dialog"]');
            const content = dialog?.textContent ?? null;
            return content?.includes(expectedPath) ? content : null;
          }, MAX_V2_SHARE_TARGET_PATH)
          .catch(() => null);
        if (text !== null) {
          dialogText = text;
          return;
        }
      }
      throw new Error('maximum v2 argv share has not reached the receiver dialog');
    }).toPass({ timeout: 60_000 });

    expect(dialogText).toContain('o/r');
    expect(dialogText).toContain(MAX_V2_SHARE_TARGET_PATH);
  });
});
