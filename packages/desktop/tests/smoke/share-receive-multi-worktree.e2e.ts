
import { execSync } from 'node:child_process';
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

function userDataDirFor(tmpHome: string): string {
  return join(tmpHome, 'electron-userdata');
}

function gitSync(cwd: string, ...args: string[]): void {
  execSync(`git ${args.map((a) => JSON.stringify(a)).join(' ')}`, {
    cwd,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: 'pipe',
  });
}

interface MultiWorktreeFixture {
  readonly root: string;
  readonly mainRepo: string;
  readonly featBarWorktree: string;
  readonly cleanup: () => void;
}

function setupMultiWorktree(): MultiWorktreeFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'share-receive-multi-wt-')));
  const mainRepo = join(root, 'main');
  mkdirSync(mainRepo);
  gitSync(mainRepo, 'init', '--initial-branch=main', '.');
  gitSync(mainRepo, 'config', 'user.email', 'test@example.com');
  gitSync(mainRepo, 'config', 'user.name', 'Test');
  gitSync(mainRepo, 'remote', 'add', 'origin', 'https://github.com/inkeep/open-knowledge.git');
  writeFileSync(join(mainRepo, 'README.md'), '# main\n');
  gitSync(mainRepo, 'add', 'README.md');
  gitSync(mainRepo, 'commit', '-m', 'initial');
  mkdirSync(join(mainRepo, '.ok'), { recursive: true });
  writeFileSync(
    join(mainRepo, '.ok', 'config.yml'),
    "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
  );

  const featBarWorktree = join(root, 'wt', 'feat-bar');
  mkdirSync(join(root, 'wt'), { recursive: true });
  gitSync(mainRepo, 'worktree', 'add', '-b', 'feat-bar', featBarWorktree);
  mkdirSync(join(featBarWorktree, 'docs'), { recursive: true });
  writeFileSync(join(featBarWorktree, 'docs', 'x.md'), '# feat-bar/docs/x\n');
  gitSync(featBarWorktree, 'add', 'docs/x.md');
  gitSync(featBarWorktree, 'commit', '-m', 'add feat-bar/docs/x.md');
  mkdirSync(join(featBarWorktree, '.ok'), { recursive: true });
  writeFileSync(
    join(featBarWorktree, '.ok', 'config.yml'),
    "content:\n  dir: '.'\n  include: ['**/*.md']\n  exclude: []\n",
  );

  return {
    root,
    mainRepo,
    featBarWorktree,
    cleanup: () => {
      execSync(`rm -rf ${JSON.stringify(root)}`, { stdio: 'pipe' });
    },
  };
}

test.describe('share-receive multi-worktree smoke (US-014 / J1 silent dispatch)', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Deep-link URL scheme is macOS-only in v0.');
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop" first.`,
  );

  test.fixme('J1: share for non-most-recent worktree branch dispatches to the matching worktree', async ({
    captureStderrFor,
  }) => {
    const fixture = setupMultiWorktree();
    const tmpHome = mkdtempSync(join(tmpdir(), 'share-receive-home-'));

    const userData = userDataDirFor(tmpHome);
    mkdirSync(join(userData, 'Electron'), { recursive: true });
    const recentsState = {
      recentProjects: [
        {
          path: fixture.mainRepo,
          name: 'main',
          lastOpenedAt: new Date().toISOString(),
          gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
        },
        {
          path: fixture.featBarWorktree,
          name: 'feat-bar',
          lastOpenedAt: new Date(Date.now() - 1000).toISOString(),
          gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
        },
      ],
      projectSessions: {},
    };
    writeFileSync(join(userData, 'Electron', 'state.json'), JSON.stringify(recentsState, null, 2));

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userData}`],
      timeout: 30_000,
    });
    captureStderrFor(app, {
      cleanupDirs: [fixture.root, tmpHome],
    });

    const firstWindow = await app.firstWindow({ timeout: 15_000 });
    expect(firstWindow).toBeDefined();

    const githubBlobUrl = 'https://github.com/inkeep/open-knowledge/blob/feat-bar/docs/x.md';
    const shareUrl = `openknowledge://share?url=${encodeURIComponent(githubBlobUrl)}`;
    execSync(`open -g "${shareUrl}"`, { stdio: 'pipe' });

    await expect(async () => {
      for (const page of app.windows()) {
        const projectPath = await page
          .evaluate(() => {
            const win = window as unknown as {
              okDesktop?: { config: { projectPath: string } };
            };
            return win.okDesktop?.config.projectPath ?? '';
          })
          .catch(() => '');
        if (projectPath === fixture.featBarWorktree) return;
      }
      throw new Error(
        `no window dispatched to feat-bar worktree yet (expected ${fixture.featBarWorktree})`,
      );
    }).toPass({ timeout: 20_000 });

  });

  test.skip('J2 consent dialog dispatch — deferred until E2E harness boots a per-test OK server', () => {});

  test.skip('J5 in-place pivot dispatch — deferred until E2E harness boots a per-test OK server', () => {});
});
