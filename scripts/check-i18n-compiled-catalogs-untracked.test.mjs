import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { configureTestGitRepository } from '../test-support/configure-git-fixture.test-helper.ts';
import { gitCleanEnv } from './git-clean-env.mjs';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUARD = 'scripts/check-i18n-compiled-catalogs-untracked.mjs';
const GUARD_IMPORTS = ['scripts/git-clean-env.mjs'];
const LOCALES = 'packages/app/src/locales';
const APP_GITIGNORE = 'packages/app/.gitignore';
const REAL_APP_GITIGNORE = readFileSync(join(OK_ROOT, APP_GITIGNORE), 'utf8');
const SCRATCH_PREFIX_WITH_A_QUOTE = "i18n-compiled-untracked-quote'd-";

const scratch = [];

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true });
});

function isolatedEnv(extra = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    ...extra,
  };
}

function git(root, ...args) {
  return spawnSync('git', args, { cwd: root, env: isolatedEnv(), encoding: 'utf8' });
}

function gitOk(root, ...args) {
  const result = git(root, ...args);
  expect(result.status, `git ${args.join(' ')}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

function write(root, files) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
}

function scratchDir(okDir = '.') {
  const root = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX_WITH_A_QUOTE));
  scratch.push(root);
  for (const script of [GUARD, ...GUARD_IMPORTS]) {
    mkdirSync(dirname(join(root, okDir, script)), { recursive: true });
    copyFileSync(join(OK_ROOT, script), join(root, okDir, script));
  }
  return root;
}

function repo(files, okDir = '.') {
  const root = scratchDir(okDir);
  write(root, files);
  gitOk(root, 'init', '-q', '-b', 'main');
  configureTestGitRepository(root, (args) => gitOk(root, ...args));
  gitOk(root, 'add', '-A');
  gitOk(root, 'commit', '-q', '-m', 'base');
  return root;
}

function runGuard(root, extraEnv = {}, okDir = '.') {
  return spawnSync(process.execPath, [join(root, okDir, GUARD)], {
    cwd: root,
    env: isolatedEnv(extraEnv),
    encoding: 'utf8',
  });
}

function named(result) {
  return result.stderr
    .split('\n')
    .filter((line) => /^ {4}packages\/\S+$/.test(line))
    .map((line) => line.trim())
    .sort();
}

function printedFix(result) {
  return result.stderr
    .split('\n')
    .filter((line) => /^ {4}git /.test(line))
    .map((line) => line.trim());
}

function trackedUnder(root, dir) {
  return gitOk(root, 'ls-files', '-z', '--', dir).split('\0').filter(Boolean);
}

const PO = 'msgid "Save"\nmsgstr "Save"\n';
const JSON_CATALOG = '{"messages":{}}\n';

function mergeMainThatStoppedTrackingGeneratedCatalogs() {
  const root = repo({
    [`${LOCALES}/en/messages.po`]: PO,
    [`${LOCALES}/en/messages.json`]: JSON_CATALOG,
    [`${LOCALES}/pseudo/messages.po`]: PO,
    [`${LOCALES}/pseudo/messages.json`]: JSON_CATALOG,
  });
  gitOk(root, 'checkout', '-q', '-b', 'side');
  write(root, {
    [`${LOCALES}/en/messages.json`]: '{"messages":{"a":"b"}}\n',
    [`${LOCALES}/pseudo/messages.po`]: `${PO}msgid "New"\nmsgstr "New"\n`,
  });
  gitOk(root, 'commit', '-q', '-am', 'side edits generated catalogs');
  gitOk(root, 'checkout', '-q', 'main');
  gitOk(
    root,
    'rm',
    '-q',
    '--',
    `${LOCALES}/en/messages.json`,
    `${LOCALES}/pseudo/messages.json`,
    `${LOCALES}/pseudo/messages.po`,
  );
  write(root, { [APP_GITIGNORE]: REAL_APP_GITIGNORE });
  gitOk(root, 'add', '-A');
  gitOk(root, 'commit', '-q', '-m', 'main stops tracking generated catalogs');
  gitOk(root, 'checkout', '-q', 'side');

  const merge = git(root, 'merge', '--no-edit', 'main');
  expect(merge.status).toBe(1);
  expect(
    gitOk(root, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean).sort(),
  ).toEqual([`${LOCALES}/en/messages.json`, `${LOCALES}/pseudo/messages.po`]);
  return root;
}

describe('check-i18n-compiled-catalogs-untracked fails when git tracks a generated catalog', () => {
  test('a messages.json and the pseudo messages.po added with git add -f fail the check, and the fix it prints un-tracks both from an unrelated directory and keeps them on disk, with Open Knowledge below the repository root in a path holding a quote', () => {
    const ok = 'public/open-knowledge';
    const compiled = [`${LOCALES}/fr/messages.json`, `${LOCALES}/pseudo/messages.po`];
    const root = repo(
      {
        [`${ok}/${APP_GITIGNORE}`]: REAL_APP_GITIGNORE,
        [`${ok}/${LOCALES}/en/messages.po`]: PO,
        [`${ok}/${LOCALES}/fr/messages.po`]: PO,
        [`${ok}/${LOCALES}/GLOSSARY.md`]: '# Glossary\n',
      },
      ok,
    );
    expect(root).toContain("'");
    write(root, Object.fromEntries(compiled.map((path) => [`${ok}/${path}`, JSON_CATALOG])));
    gitOk(root, 'add', '-f', '--', ...compiled.map((path) => `${ok}/${path}`));
    gitOk(root, 'commit', '-q', '-m', 'track compiled catalogs');
    const unrelated = mkdtempSync(join(tmpdir(), 'i18n-compiled-untracked-unrelated-'));
    scratch.push(unrelated);

    const result = runGuard(root, {}, ok);

    expect(result.status, result.stderr).toBe(1);
    expect(named(result)).toEqual(compiled);
    const fix = printedFix(result);
    expect(fix).toHaveLength(1);
    const removed = spawnSync('bash', ['-c', fix[0]], {
      cwd: unrelated,
      env: isolatedEnv(),
      encoding: 'utf8',
    });
    expect(removed.status, removed.stderr).toBe(0);
    expect(trackedUnder(root, `${ok}/${LOCALES}`).sort()).toEqual([
      `${ok}/${LOCALES}/GLOSSARY.md`,
      `${ok}/${LOCALES}/en/messages.po`,
      `${ok}/${LOCALES}/fr/messages.po`,
    ]);
    expect(compiled.every((path) => existsSync(join(root, ok, path)))).toBe(true);
    expect(runGuard(root, {}, ok).status).toBe(0);
  });

  test('a staged pseudo-locale messages.po fails the check before it is committed', () => {
    const root = repo({
      [APP_GITIGNORE]: REAL_APP_GITIGNORE,
      [`${LOCALES}/en/messages.po`]: PO,
    });
    write(root, { [`${LOCALES}/pseudo/messages.po`]: PO });
    gitOk(root, 'add', '-f', `${LOCALES}/pseudo/messages.po`);

    const result = runGuard(root);

    expect(result.status, result.stderr).toBe(1);
    expect(named(result)).toEqual([`${LOCALES}/pseudo/messages.po`]);
  });

  test('a merge that conflicts on catalogs main stopped tracking, resolved with git add -A, fails the check naming each re-tracked catalog', () => {
    const root = mergeMainThatStoppedTrackingGeneratedCatalogs();
    gitOk(root, 'add', '-A');
    gitOk(root, 'commit', '-q', '--no-edit');

    const result = runGuard(root);

    expect(result.status, result.stderr).toBe(1);
    expect(named(result)).toEqual([`${LOCALES}/en/messages.json`, `${LOCALES}/pseudo/messages.po`]);
  });
});

describe('check-i18n-compiled-catalogs-untracked passes a tree that tracks only source catalogs', () => {
  test('tracked messages.po catalogs pass while compiled catalogs sit untracked on disk, and the pass line counts every tracked path it examined', () => {
    const tracked = [
      `${LOCALES}/GLOSSARY.md`,
      `${LOCALES}/en/messages.po`,
      `${LOCALES}/fr/messages.po`,
      `${LOCALES}/zh-Hans/messages.po`,
    ];
    const root = repo({
      [APP_GITIGNORE]: REAL_APP_GITIGNORE,
      'packages/app/src/messages.json': JSON_CATALOG,
      ...Object.fromEntries(tracked.map((path) => [path, PO])),
    });
    const untracked = [
      `${LOCALES}/en/messages.json`,
      `${LOCALES}/fr/messages.json`,
      `${LOCALES}/pseudo/messages.json`,
    ];
    write(root, Object.fromEntries(untracked.map((path) => [path, JSON_CATALOG])));
    expect(untracked.every((path) => existsSync(join(root, path)))).toBe(true);
    expect(trackedUnder(root, LOCALES).sort()).toEqual(tracked);

    const result = runGuard(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`among ${tracked.length} tracked path(s) under ${LOCALES}`);
  });

  test('a GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE inherited from a hook is scrubbed rather than redirecting the listing', () => {
    const root = repo({ [APP_GITIGNORE]: REAL_APP_GITIGNORE, [`${LOCALES}/en/messages.po`]: PO });

    const result = runGuard(root, {
      GIT_DIR: '/nonexistent/.git',
      GIT_WORK_TREE: '/nonexistent',
      GIT_INDEX_FILE: '/nonexistent/index',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`among 1 tracked path(s) under ${LOCALES}`);
  });
});

describe('check-i18n-compiled-catalogs-untracked fails rather than passing when it cannot examine the catalogs', () => {
  test('a tree that tracks nothing under the locales directory fails with 2 instead of passing an empty listing', () => {
    const root = repo({ 'README.md': '# fixture\n' });
    write(root, { [`${LOCALES}/en/messages.json`]: JSON_CATALOG });

    const result = runGuard(root);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`git lists no tracked path under ${LOCALES}`);
  });

  test('a checkout git cannot open fails with 2 and says the listing could not be read', () => {
    const root = scratchDir();
    write(root, {
      '.git': `gitdir: ${join(root, 'missing-gitdir')}\n`,
      [`${LOCALES}/en/messages.json`]: JSON_CATALOG,
    });

    const result = runGuard(root);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`could not list the tracked paths under ${LOCALES}`);
  });
});

describe('the paths the check rejects are exactly the ones packages/app/.gitignore ignores', () => {
  test('replaying the real ignore file through git agrees with the check on every locale path, both ways', () => {
    const realTracked = spawnSync('git', ['ls-files', '-z', '--', LOCALES], {
      cwd: OK_ROOT,
      env: gitCleanEnv(),
      encoding: 'utf8',
    })
      .stdout.split('\0')
      .filter(Boolean);
    const localeDirs = [
      ...new Set(
        [...realTracked, `${LOCALES}/pseudo/messages.po`]
          .map((path) => /^packages\/app\/src\/locales\/([^/]+)\/[^/]+$/.exec(path)?.[1])
          .filter(Boolean),
      ),
    ];
    expect(localeDirs).toContain('en');
    expect(localeDirs).toContain('pseudo');
    const ignoreLines = REAL_APP_GITIGNORE.split('\n').filter((line) =>
      line.startsWith('src/locales/'),
    );
    expect(ignoreLines.length).toBeGreaterThan(0);
    const candidates = new Set([
      ...realTracked,
      ...localeDirs.flatMap((dir) => [
        `${LOCALES}/${dir}/messages.json`,
        `${LOCALES}/${dir}/messages.po`,
      ]),
      ...ignoreLines.flatMap((line) =>
        localeDirs.map((dir) => `packages/app/${line.replaceAll(/\*+/g, dir)}`),
      ),
      `${LOCALES}/messages.json`,
      `${LOCALES}/messages.po`,
      `${LOCALES}/en/nested/messages.json`,
      `${LOCALES}/pseudo/messages.po.orig`,
      'packages/app/src/messages.json',
    ]);
    const root = repo({ [APP_GITIGNORE]: REAL_APP_GITIGNORE, 'README.md': '# fixture\n' });
    write(root, Object.fromEntries([...candidates].map((path) => [path, PO])));
    gitOk(root, 'add', '-f', '--', ...candidates);
    expect(
      trackedUnder(root, '.')
        .filter((path) => candidates.has(path))
        .sort(),
    ).toEqual([...candidates].sort());

    const ignored = git(root, 'check-ignore', '--no-index', '--', ...candidates)
      .stdout.split('\n')
      .filter(Boolean)
      .sort();
    expect(ignored.length).toBeGreaterThan(0);
    const result = runGuard(root);

    expect(result.status, result.stderr).toBe(1);
    expect(named(result)).toEqual(ignored);
  });
});

describe('this tree', () => {
  test('tracks no generated catalog, and the check examines every tracked path under the locales directory', () => {
    const tracked = spawnSync('git', ['ls-files', '-z', '--', LOCALES], {
      cwd: OK_ROOT,
      env: gitCleanEnv(),
      encoding: 'utf8',
    })
      .stdout.split('\0')
      .filter(Boolean);
    expect(tracked).toContain(`${LOCALES}/en/messages.po`);

    const result = spawnSync(process.execPath, [join(OK_ROOT, GUARD)], {
      cwd: OK_ROOT,
      env: gitCleanEnv(),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`among ${tracked.length} tracked path(s) under ${LOCALES}`);
  });
});
