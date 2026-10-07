import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import {
  type DiscoverProjectOptions,
  type DiscoverProjectResult,
  discoverProject,
  type FolderPickValidation,
  type GitState,
  isExactManagedProject,
  isSystemDirectory,
  REJECTION_REASON_COPY,
  type RejectionReason,
  type SensitivePathWarning,
  type ValidateFolderPickOptions,
  validateFolderPick,
} from './folder-admission.ts';

const execFileAsync = promisify(execFile);

const simulatedFilesystemRoots = vi.hoisted(() => new Set<string>());
vi.mock('@inkeep/open-knowledge-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inkeep/open-knowledge-server')>();
  return {
    ...actual,
    isFilesystemRoot: (dir: string, platform?: NodeJS.Platform) =>
      simulatedFilesystemRoots.has(dir) || actual.isFilesystemRoot(dir, platform),
  };
});

const HOME = '/Users/test';

describe('validateFolderPick — happy path (no warnings)', () => {
  test('typical user folder under home produces zero warnings', () => {
    const opts: ValidateFolderPickOptions = { homeDir: HOME };
    const result: FolderPickValidation = validateFolderPick(join(HOME, 'dev/myrepo'), opts);
    expect(result.warnings).toEqual([]);
    expect(result.blocked).toBe(false);
  });

  test('arbitrary deep absolute path produces zero warnings', () => {
    const result = validateFolderPick('/opt/projects/notes', { homeDir: HOME });
    expect(result.warnings).toEqual([]);
    expect(result.blocked).toBe(false);
  });

  test('blocked is always false even when warnings fire', () => {
    const result = validateFolderPick(join(HOME, 'Documents'), { homeDir: HOME });
    expect(result.warnings).not.toEqual([]);
    expect(result.blocked).toBe(false);
  });
});

describe('validateFolderPick — home warnings', () => {
  test('home/Documents returns home-documents warning', () => {
    const result = validateFolderPick(join(HOME, 'Documents'), { homeDir: HOME });
    expect(result.warnings).toEqual([{ kind: 'home-documents' }]);
  });

  test('home/Desktop returns home-desktop warning', () => {
    const result = validateFolderPick(join(HOME, 'Desktop'), { homeDir: HOME });
    expect(result.warnings).toEqual([{ kind: 'home-desktop' }]);
  });

  test('home/Downloads returns home-downloads warning', () => {
    const result = validateFolderPick(join(HOME, 'Downloads'), { homeDir: HOME });
    expect(result.warnings).toEqual([{ kind: 'home-downloads' }]);
  });

  test('home/Documents/sub does NOT trigger home-documents warning', () => {
    const result = validateFolderPick(join(HOME, 'Documents/notes'), { homeDir: HOME });
    expect(result.warnings).toEqual([]);
  });

  test('home/dev does NOT trigger any home warning', () => {
    const result = validateFolderPick(join(HOME, 'dev'), { homeDir: HOME });
    expect(result.warnings).toEqual([]);
  });
});

describe('validateFolderPick — /Volumes warnings', () => {
  test('mount root /Volumes/External returns volumes-mount warning', () => {
    const result = validateFolderPick('/Volumes/External', { homeDir: HOME });
    expect(result.warnings).toEqual([{ kind: 'volumes-mount' }]);
  });

  test('descendant of mount /Volumes/External/notes returns volumes-mount warning', () => {
    const result = validateFolderPick('/Volumes/External/notes', { homeDir: HOME });
    expect(result.warnings).toEqual([{ kind: 'volumes-mount' }]);
  });

  test('exact /Volumes carries no warning, since admission refuses it as a system folder', () => {
    const result = validateFolderPick('/Volumes', { homeDir: HOME });
    expect(result.warnings).toEqual([]);
  });

  test('/Volumes-likeprefix does NOT trigger (must be /Volumes/ separator)', () => {
    const result = validateFolderPick('/Volumes-typo', { homeDir: HOME });
    expect(result.warnings).toEqual([]);
  });
});

describe('validateFolderPick — purity + path normalization', () => {
  test('trailing slash normalized away (path.resolve canonicalizes)', () => {
    const result = validateFolderPick(`${HOME}/Documents/`, { homeDir: HOME });
    expect(result.warnings).toEqual([{ kind: 'home-documents' }]);
  });

  test('embedded ".." resolved before comparison', () => {
    const result = validateFolderPick('/Volumes/External/sub/../', { homeDir: HOME });
    expect(result.warnings).toEqual([{ kind: 'volumes-mount' }]);
  });

  test('default homeDir falls back to os.homedir() when option omitted', () => {
    const result = validateFolderPick('/opt/projects/x');
    expect(result.blocked).toBe(false);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  test('result is deterministic — same input twice yields equal output', () => {
    const a = validateFolderPick(join(HOME, 'Documents'), { homeDir: HOME });
    const b = validateFolderPick(join(HOME, 'Documents'), { homeDir: HOME });
    expect(a).toEqual(b);
  });

  test('warning kind type is exhaustively narrowed (compile-time + runtime)', () => {
    const allKinds: readonly SensitivePathWarning['kind'][] = [
      'home-documents',
      'home-desktop',
      'home-downloads',
      'volumes-mount',
    ];
    for (const kind of allKinds) {
      const w: SensitivePathWarning = { kind };
      expect(typeof w.kind).toBe('string');
    }
  });
});

let tmpRoot: string;
let tmpReal: string;
let fakeHome: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), 'ok-discover-project-'));
  tmpReal = realpathSync(tmpRoot);
  fakeHome = resolve(tmpReal, 'home');
  mkdirSync(fakeHome, { recursive: true });
});

afterEach(() => {
  simulatedFilesystemRoots.clear();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const stubGitTopLevel =
  (resultByCwd: Record<string, string | null> | ((cwd: string) => string | null)) =>
  async (cwd: string): Promise<string | null> => {
    if (typeof resultByCwd === 'function') return resultByCwd(cwd);
    return resultByCwd[cwd] ?? null;
  };

const writeOkConfig = (dir: string, contents = '$schema: x\n'): void => {
  mkdirSync(resolve(dir, '.ok'), { recursive: true });
  writeFileSync(resolve(dir, '.ok/config.yml'), contents);
};

describe('discoverProject — the home directory is never a project', () => {
  test('rejects a home pick instead of classifying it fresh', async () => {
    const result = await discoverProject(fakeHome, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.reason).toBe('home-directory');
  });

  test('rejects a home that already carries the pre-fix .ok/config.yml', async () => {
    writeOkConfig(fakeHome);

    const result = await discoverProject(fakeHome, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.reason).toBe('home-directory');
  });

  test('rejects a symlinked spelling of home', async () => {
    const link = resolve(tmpReal, 'home-link');
    symlinkSync(fakeHome, link);

    const result = await discoverProject(link, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.reason).toBe('home-directory');
  });

  test('a folder inside home is unaffected', async () => {
    const project = resolve(fakeHome, 'notes');
    mkdirSync(project, { recursive: true });

    const result = await discoverProject(project, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
  });
});

describe('discoverProject refuses filesystem roots and system folders', () => {
  test('rejects the filesystem root instead of classifying it fresh', async () => {
    const result = await discoverProject('/', {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result).toEqual({ kind: 'rejected', reason: 'filesystem-root' });
  });

  test('rejects the folder that holds every user profile', async () => {
    const result = await discoverProject(tmpReal, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result).toEqual({ kind: 'rejected', reason: 'system-directory' });
  });

  test.skipIf(process.platform === 'win32')(
    'rejects /bin whether it is a real folder or a merged-usr link into /usr',
    async () => {
      const result = await discoverProject('/bin', {
        homeDir: fakeHome,
        gitTopLevel: stubGitTopLevel({}),
        dirSizeProbe: null,
      });

      expect(result).toEqual({ kind: 'rejected', reason: 'system-directory' });
    },
  );

  test.skipIf(process.platform !== 'darwin')(
    'rejects a system folder spelled in a different letter case',
    async () => {
      const result = await discoverProject('/LIBRARY', {
        homeDir: fakeHome,
        gitTopLevel: stubGitTopLevel({}),
        dirSizeProbe: null,
      });

      expect(result).toEqual({ kind: 'rejected', reason: 'system-directory' });
    },
  );

  test('an existing project at the top of a drive never captures a pick below it', async () => {
    const drive = resolve(tmpReal, 'drive');
    const pick = resolve(drive, 'work', 'notes');
    mkdirSync(pick, { recursive: true });
    writeOkConfig(drive);
    simulatedFilesystemRoots.add(drive);

    for (const dirSizeProbe of [null, async () => ({ exceedsCap: true })]) {
      const result = await discoverProject(pick, {
        homeDir: fakeHome,
        gitTopLevel: stubGitTopLevel({}),
        dirSizeProbe,
      });

      expect(result).toMatchObject({ kind: 'fresh', projectDir: pick });
    }
  });

  test('an existing project in a system folder never captures a pick below it', async () => {
    const pick = resolve(tmpReal, 'shared', 'notes');
    mkdirSync(pick, { recursive: true });
    writeOkConfig(tmpReal);

    const result = await discoverProject(pick, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result).toMatchObject({ kind: 'fresh', projectDir: pick });
  });

  test('a sibling of the home folder is unaffected', async () => {
    const project = resolve(tmpReal, 'shared-notes');
    mkdirSync(project, { recursive: true });

    const result = await discoverProject(project, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
  });
});

describe('isSystemDirectory', () => {
  test.each([
    '/usr',
    '/etc',
    '/private/etc',
    '/var',
    '/System',
    '/Library',
    '/Applications',
    '/Volumes',
    '/usr/',
    '/usr/bin',
    '/usr/sbin',
    '/usr/lib',
    '/usr/lib64',
  ])('true for the OS-owned folder %s', (dir) => {
    expect(isSystemDirectory(dir, HOME, 'linux', {})).toBe(true);
  });

  test('true for the folder that holds every user profile', () => {
    expect(isSystemDirectory('/Users', HOME, 'darwin', {})).toBe(true);
    expect(isSystemDirectory('/home', '/home/test', 'linux', {})).toBe(true);
  });

  test.each([
    '/usr/local/notes',
    '/opt',
    '/opt/notes',
    '/srv',
    '/tmp',
    '/mnt',
    '/Volumes/SSD',
    '/Volumes/SSD/notes',
    '/Users/test/notes',
    '/usr-notes',
  ])('false for %s, matching folders exactly and never their contents', (dir) => {
    expect(isSystemDirectory(dir, HOME, 'linux', {})).toBe(false);
  });

  test.skipIf(process.platform === 'win32')(
    'true for a link that resolves to a system folder',
    () => {
      const link = resolve(tmpReal, 'usr-link');
      symlinkSync('/usr', link);
      expect(isSystemDirectory(link, HOME)).toBe(true);
    },
  );

  test('Windows system folders match case-insensitively from the environment', () => {
    const env = {
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramData: 'C:\\ProgramData',
    };
    const winHome = 'C:\\Users\\test';
    expect(isSystemDirectory('c:\\windows', winHome, 'win32', env)).toBe(true);
    expect(isSystemDirectory('C:\\Program Files\\', winHome, 'win32', env)).toBe(true);
    expect(isSystemDirectory('C:\\Program Files (x86)', winHome, 'win32', env)).toBe(true);
    expect(isSystemDirectory('C:\\ProgramData', winHome, 'win32', env)).toBe(true);
    expect(isSystemDirectory('C:\\Users', winHome, 'win32', env)).toBe(true);
    expect(isSystemDirectory('C:\\Windows\\notes', winHome, 'win32', env)).toBe(false);
    expect(isSystemDirectory('C:\\Users\\test\\notes', winHome, 'win32', env)).toBe(false);
    expect(isSystemDirectory('D:\\notes', winHome, 'win32', env)).toBe(false);
  });
});

describe('discoverProject — managed kind (ancestor walk)', () => {
  test('returns managed at picked path when .ok/config.yml is at picked', async () => {
    const project = resolve(fakeHome, 'project');
    mkdirSync(project, { recursive: true });
    writeOkConfig(project);

    const result = await discoverProject(project, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('managed');
    if (result.kind !== 'managed') return;
    expect(result.projectDir).toBe(project);
    expect(result.pickedPath).toBe(project);
    expect(result.ancestorPromoted).toBe(false);
    expect(isExactManagedProject(result)).toBe(true);
  });

  test('promotes to ancestor when .ok/ is one level up', async () => {
    const project = resolve(fakeHome, 'project');
    const sub = resolve(project, 'sub');
    mkdirSync(sub, { recursive: true });
    writeOkConfig(project);

    const result = await discoverProject(sub, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('managed');
    if (result.kind !== 'managed') return;
    expect(result.projectDir).toBe(project);
    expect(result.ancestorPromoted).toBe(true);
    expect(isExactManagedProject(result)).toBe(false);
  });

  test('exact-project admission rejects non-managed and rejected discoveries', () => {
    expect(
      isExactManagedProject({
        kind: 'fresh',
        pickedPath: '/repo/docs',
        projectDir: '/repo/docs',
        defaultContentDir: '.',
        gitState: 'present',
        gitRootPromoted: false,
      }),
    ).toBe(false);
    expect(isExactManagedProject({ kind: 'rejected', reason: 'unreadable' })).toBe(false);
  });

  test.each([1, 2, 3, 4, 5])(
    'promotes to ancestor at depth %i levels above picked',
    async (depth) => {
      const segments = Array.from({ length: depth }, (_, i) => `level${i + 1}`);
      const project = resolve(fakeHome, 'project');
      const sub = resolve(project, ...segments);
      mkdirSync(sub, { recursive: true });
      writeOkConfig(project);

      const result = await discoverProject(sub, {
        homeDir: fakeHome,
        gitTopLevel: stubGitTopLevel({}),
        dirSizeProbe: null,
      });

      expect(result.kind).toBe('managed');
      if (result.kind !== 'managed') return;
      expect(result.projectDir).toBe(project);
      expect(result.ancestorPromoted).toBe(true);
    },
  );

  test('walk excludes home itself — a home .ok/ never promotes a child', async () => {
    writeOkConfig(fakeHome);
    const sub = resolve(fakeHome, 'sub');
    mkdirSync(sub, { recursive: true });

    const result = await discoverProject(sub, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.projectDir).toBe(sub);
  });

  test('walk excludes home when home is given by a symlinked spelling', async () => {
    writeOkConfig(fakeHome);
    const sub = resolve(fakeHome, 'sub');
    mkdirSync(sub, { recursive: true });
    const homeLink = resolve(tmpReal, 'home-link');
    symlinkSync(fakeHome, homeLink);

    const result = await discoverProject(sub, {
      homeDir: homeLink,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.projectDir).toBe(sub);
  });

  test('legacy .ok/ below git root wins over git-root promotion', async () => {
    const repo = resolve(fakeHome, 'repo');
    const docs = resolve(repo, 'docs');
    const api = resolve(docs, 'api');
    mkdirSync(api, { recursive: true });
    mkdirSync(resolve(repo, '.git'));
    writeOkConfig(docs);

    const result = await discoverProject(api, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({ [api]: repo }),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('managed');
    if (result.kind !== 'managed') return;
    expect(result.projectDir).toBe(docs);
    expect(result.ancestorPromoted).toBe(true);
  });
});

describe('discoverProject — fresh kind, git-root promotion (FR-2a)', () => {
  test('promotes to gitRoot when picked is sub-folder of a git repo without .ok/', async () => {
    const repo = resolve(fakeHome, 'myrepo');
    const docs = resolve(repo, 'docs');
    mkdirSync(docs, { recursive: true });
    mkdirSync(resolve(repo, '.git'));
    writeFileSync(resolve(repo, '.git/HEAD'), 'ref: refs/heads/main\n');

    const result = await discoverProject(docs, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({ [docs]: repo }),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.projectDir).toBe(repo);
    expect(result.defaultContentDir).toBe('.');
    expect(result.gitRootPromoted).toBe(true);
    expect(result.gitState).toBe('present');
  });

  test('no promotion when gitRoot === pickedPath (gitRootPromoted=false, defaultContentDir=".")', async () => {
    const repo = resolve(fakeHome, 'myrepo');
    mkdirSync(repo, { recursive: true });
    mkdirSync(resolve(repo, '.git'));
    writeFileSync(resolve(repo, '.git/HEAD'), 'ref: refs/heads/main\n');

    const result = await discoverProject(repo, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({ [repo]: repo }),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.projectDir).toBe(repo);
    expect(result.defaultContentDir).toBe('.');
    expect(result.gitRootPromoted).toBe(false);
    expect(result.gitState).toBe('present');
  });

  test('does NOT promote when gitRoot === home (carve-out for ~/.git/)', async () => {
    const sub = resolve(fakeHome, 'work');
    mkdirSync(sub, { recursive: true });

    const result = await discoverProject(sub, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({ [sub]: fakeHome }),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.projectDir).toBe(sub);
    expect(result.gitRootPromoted).toBe(false);
    expect(result.defaultContentDir).toBe('.');
  });

  test('does NOT promote when gitRoot is above home', async () => {
    const sub = resolve(fakeHome, 'work');
    mkdirSync(sub, { recursive: true });
    const aboveHome = tmpReal;

    const result = await discoverProject(sub, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({ [sub]: aboveHome }),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.projectDir).toBe(sub);
    expect(result.gitRootPromoted).toBe(false);
  });

  test('returns fresh with gitState=absent when no git and no ancestor .ok/', async () => {
    const folder = resolve(fakeHome, 'no-git');
    mkdirSync(folder, { recursive: true });

    const result = await discoverProject(folder, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.gitState).toBe('absent');
    expect(result.gitRootPromoted).toBe(false);
    expect(result.defaultContentDir).toBe('.');
  });
});

describe('discoverProject — linked-worktree carveout scoping', () => {
  test('subfolder of a linked worktree promotes to the git root, not in-place Setup', async () => {
    const worktree = resolve(fakeHome, 'wt');
    const sub = resolve(worktree, 'public/open-knowledge');
    const gitDir = resolve(fakeHome, 'main/.git/worktrees/wt');
    mkdirSync(sub, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(resolve(worktree, '.git'), `gitdir: ${gitDir}\n`);

    const result = await discoverProject(sub, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({ [sub]: worktree }),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.projectDir).toBe(worktree);
    expect(result.gitRootPromoted).toBe(true);
  });

  test('the linked-worktree root itself still classifies standalone under an ancestor .ok/', async () => {
    const parent = resolve(fakeHome, 'parent');
    const worktree = resolve(parent, 'wt');
    const gitDir = resolve(fakeHome, 'main/.git/worktrees/wt');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeOkConfig(parent);
    writeFileSync(resolve(worktree, '.git'), `gitdir: ${gitDir}\n`);

    const result = await discoverProject(worktree, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({ [worktree]: worktree }),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.projectDir).toBe(worktree);
    expect(result.gitRootPromoted).toBe(false);
  });
});

describe('discoverProject — gitState detection', () => {
  test('shell-only: .git directory present but HEAD missing (the J5 case)', async () => {
    const folder = resolve(fakeHome, 'shell-git');
    mkdirSync(resolve(folder, '.git/ok'), { recursive: true });

    const result = await discoverProject(folder, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.gitState).toBe('shell-only');
  });

  test('present: .git is a regular file (worktree-pointer)', async () => {
    const folder = resolve(fakeHome, 'worktree-leaf');
    mkdirSync(folder, { recursive: true });
    writeFileSync(resolve(folder, '.git'), 'gitdir: /foo\n');

    const result = await discoverProject(folder, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.gitState).toBe('present');
  });

  test('present: .git directory with HEAD', async () => {
    const folder = resolve(fakeHome, 'real-git');
    mkdirSync(resolve(folder, '.git'), { recursive: true });
    writeFileSync(resolve(folder, '.git/HEAD'), 'ref: refs/heads/main\n');

    const result = await discoverProject(folder, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.gitState).toBe('present');
  });
});

describe('discoverProject — rejected kind', () => {
  test('returns rejected/unreadable when picked path does not exist (ENOENT)', async () => {
    const missing = resolve(fakeHome, 'no-such-dir');

    const result = await discoverProject(missing, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.reason).toBe('unreadable');
  });

  test('returns rejected/unreadable on symlink loop (ELOOP)', async () => {
    const a = resolve(fakeHome, 'loop-a');
    const b = resolve(fakeHome, 'loop-b');
    symlinkSync(b, a);
    symlinkSync(a, b);

    const result = await discoverProject(a, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.reason).toBe('unreadable');
  });

  test('returns rejected/symlink-escape when picked is a symlink to a sibling tree', async () => {
    const dirA = resolve(fakeHome, 'dirA');
    const dirB = resolve(fakeHome, 'dirB');
    const elsewhere = resolve(dirB, 'elsewhere');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    const sub = resolve(dirA, 'sub');
    symlinkSync(elsewhere, sub);

    const result = await discoverProject(sub, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.reason).toBe('symlink-escape');
  });
});

describe('discoverProject — depth + boundary safety', () => {
  test('walk respects ANCESTOR_WALK_DEPTH_LIMIT — .ok/ at depth 31 is NOT found', async () => {
    const chainRoot = resolve(tmpReal, 'deep');
    let cursor = chainRoot;
    for (let i = 0; i < 31; i += 1) cursor = resolve(cursor, `lvl${i}`);
    mkdirSync(cursor, { recursive: true });
    writeOkConfig(chainRoot);

    const result = await discoverProject(cursor, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
  });
});

describe('discoverProject — symlink resolution + canonical paths', () => {
  test('canonicalizes pickedPath via realpath before walking ancestors', async () => {
    const project = resolve(fakeHome, 'project');
    const link = resolve(fakeHome, 'project-link');
    mkdirSync(project, { recursive: true });
    writeOkConfig(project);
    symlinkSync(project, link);

    const result = await discoverProject(link, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('managed');
    if (result.kind !== 'managed') return;
    expect(result.projectDir).toBe(project);
    expect(result.pickedPath).toBe(project);
  });
});

describe('discoverProject — type surface', () => {
  test('GitState union is exhaustively enumerated', () => {
    const allStates: readonly GitState[] = ['present', 'absent', 'shell-only'];
    for (const s of allStates) expect(typeof s).toBe('string');
  });

  test('RejectionReason union is exhaustively enumerated', () => {
    const allReasons: readonly RejectionReason[] = [
      'symlink-escape',
      'unreadable',
      'home-directory',
      'filesystem-root',
      'system-directory',
    ];
    for (const r of allReasons) expect(typeof r).toBe('string');
    expect(Object.keys(REJECTION_REASON_COPY).sort()).toEqual([...allReasons].sort());
  });

  test('DiscoverProjectOptions and DiscoverProjectResult are import-able', () => {
    const opts: DiscoverProjectOptions = { homeDir: HOME, dirSizeProbe: null };
    const empty: ValidateFolderPickOptions = {};
    expect(opts.homeDir).toBe(HOME);
    expect(empty).toEqual({});
    const r: DiscoverProjectResult = { kind: 'rejected', reason: 'unreadable' };
    expect(r.kind).toBe('rejected');
  });

  test('FolderPickValidation is import-able', () => {
    const v: FolderPickValidation = { warnings: [], blocked: false };
    expect(v.blocked).toBe(false);
  });
});

describe('discoverProject — ancestor-promote bounded by boot budget (regression: utility init timeout)', () => {
  type DirSizeProbe = (dir: string) => Promise<{ readonly exceedsCap: boolean }>;

  test('ancestor with content tree EXCEEDING boot budget MUST surface user-confirmation requirement', async () => {
    const ancestor = resolve(fakeHome, 'ancestor');
    const sub = resolve(ancestor, 'sub');
    const picked = resolve(sub, 'picked');
    mkdirSync(picked, { recursive: true });
    writeOkConfig(ancestor);

    let probedDir: string | undefined;
    const dirSizeProbe: DirSizeProbe = async (dir) => {
      probedDir = dir;
      return { exceedsCap: true };
    };

    const opts: DiscoverProjectOptions = {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe,
    };
    const result = await discoverProject(picked, opts);

    expect(probedDir).toBe(ancestor);

    expect(result.kind).toBe('managed-requires-confirmation');
    if (result.kind !== 'managed-requires-confirmation') return;
    expect(result.projectDir).toBe(ancestor);
    expect(result.pickedPath).toBe(picked);
    expect(result.ancestorPromoted).toBe(true);
  });

  test('ancestor with content tree UNDER boot budget proceeds with silent managed-promote (no over-correction)', async () => {
    const ancestor = resolve(fakeHome, 'ancestor');
    const sub = resolve(ancestor, 'sub');
    const picked = resolve(sub, 'picked');
    mkdirSync(picked, { recursive: true });
    writeOkConfig(ancestor);

    const dirSizeProbe: DirSizeProbe = async () => ({ exceedsCap: false });

    const opts: DiscoverProjectOptions = {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe,
    };
    const result = await discoverProject(picked, opts);

    expect(result.kind).toBe('managed');
    if (result.kind !== 'managed') return;
    expect(result.projectDir).toBe(ancestor);
    expect(result.ancestorPromoted).toBe(true);
  });

  test('explicit null opt-out preserves legacy silent ancestor-promote (no probe = no gate)', async () => {
    const ancestor = resolve(fakeHome, 'ancestor');
    const sub = resolve(ancestor, 'sub');
    const picked = resolve(sub, 'picked');
    mkdirSync(picked, { recursive: true });
    writeOkConfig(ancestor);

    const result = await discoverProject(picked, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('managed');
    if (result.kind !== 'managed') return;
    expect(result.projectDir).toBe(ancestor);
    expect(result.ancestorPromoted).toBe(true);
  });

  test('direct-pick (no walk-up) does NOT invoke the probe', async () => {
    const projectRoot = resolve(fakeHome, 'projectRoot');
    mkdirSync(projectRoot, { recursive: true });
    writeOkConfig(projectRoot);

    let probeCalled = false;
    const dirSizeProbe: DirSizeProbe = async () => {
      probeCalled = true;
      return { exceedsCap: true };
    };

    const result = await discoverProject(projectRoot, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe,
    });

    expect(probeCalled).toBe(false);
    expect(result.kind).toBe('managed');
    if (result.kind !== 'managed') return;
    expect(result.projectDir).toBe(projectRoot);
    expect(result.ancestorPromoted).toBe(false);
  });
});

describe('discoverProject — integration with real git', () => {
  test('real git init + sub-folder pick → gitRootPromoted; content dir defaults to git root', async () => {
    const repo = resolve(fakeHome, 'integration-repo');
    const docs = resolve(repo, 'docs');
    mkdirSync(docs, { recursive: true });
    await execFileAsync('git', ['init', '--initial-branch=main', repo]);
    configureTestGitRepository(repo);

    const result = await discoverProject(docs, { homeDir: fakeHome, dirSizeProbe: null });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.projectDir).toBe(realpathSync(repo));
    expect(result.defaultContentDir).toBe('.');
    expect(result.gitRootPromoted).toBe(true);
    expect(result.gitState).toBe('present');
  });

  test('real git init at picked path → no promotion (gitRootPromoted=false)', async () => {
    const repo = resolve(fakeHome, 'integration-root');
    mkdirSync(repo, { recursive: true });
    await execFileAsync('git', ['init', '--initial-branch=main', repo]);
    configureTestGitRepository(repo);

    const result = await discoverProject(repo, { homeDir: fakeHome, dirSizeProbe: null });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.gitRootPromoted).toBe(false);
    expect(result.defaultContentDir).toBe('.');
  });

  test('default gitTopLevel returns null when not inside a git repo', async () => {
    const folder = resolve(fakeHome, 'no-git-folder');
    mkdirSync(folder, { recursive: true });

    const result = await discoverProject(folder, { homeDir: fakeHome, dirSizeProbe: null });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.gitRootPromoted).toBe(false);
    expect(result.gitState).toBe('absent');
  });
});

describe('discoverProject — D12 linked-worktree carveout', () => {
  test('linked-worktree root under an ancestor with .ok/ is treated as standalone', async () => {
    const parent = resolve(fakeHome, 'parent');
    mkdirSync(parent, { recursive: true });
    writeOkConfig(parent);
    await execFileAsync('git', ['init', '--initial-branch=main', parent]);
    configureTestGitRepository(parent);
    await execFileAsync('git', ['-C', parent, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', parent, 'config', 'user.name', 'Test']);
    writeFileSync(resolve(parent, 'README.md'), '# parent\n');
    await execFileAsync('git', ['-C', parent, 'add', 'README.md']);
    await execFileAsync('git', ['-C', parent, 'commit', '-m', 'initial']);

    const wt = resolve(parent, 'wt-feat');
    await execFileAsync('git', ['-C', parent, 'worktree', 'add', '-b', 'feat', wt]);
    configureTestGitRepository(wt);

    const result = await discoverProject(wt, {
      homeDir: fakeHome,
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.projectDir).toBe(wt);
    expect(result.pickedPath).toBe(wt);
    expect(result.gitRootPromoted).toBe(false);
  });

  test('main-checkout subfolder under an ancestor with .ok/ still gets promoted (D12 narrowly scoped)', async () => {
    const parent = resolve(fakeHome, 'parent2');
    mkdirSync(parent, { recursive: true });
    writeOkConfig(parent);
    const sub = resolve(parent, 'sub');
    mkdirSync(sub, { recursive: true });

    const result = await discoverProject(sub, {
      homeDir: fakeHome,
      gitTopLevel: stubGitTopLevel({}),
      dirSizeProbe: null,
    });

    expect(result.kind).toBe('managed');
    if (result.kind !== 'managed') return;
    expect(result.projectDir).toBe(parent);
    expect(result.ancestorPromoted).toBe(true);
  });

  test('linked-worktree root with NO ancestor .ok/ classifies as fresh standalone (no regression)', async () => {
    const repo = resolve(fakeHome, 'standalone-repo');
    mkdirSync(repo, { recursive: true });
    await execFileAsync('git', ['init', '--initial-branch=main', repo]);
    configureTestGitRepository(repo);
    await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    writeFileSync(resolve(repo, 'README.md'), '# r\n');
    await execFileAsync('git', ['-C', repo, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repo, 'commit', '-m', 'initial']);
    const wt = resolve(repo, 'wt-standalone');
    await execFileAsync('git', ['-C', repo, 'worktree', 'add', '-b', 'standalone', wt]);
    configureTestGitRepository(wt);

    const result = await discoverProject(wt, { homeDir: fakeHome, dirSizeProbe: null });

    expect(result.kind).toBe('fresh');
    if (result.kind !== 'fresh') return;
    expect(result.projectDir).toBe(wt);
    expect(result.gitRootPromoted).toBe(false);
  });

  test('linked-worktree root with its OWN .ok/config.yml classifies as managed (not fresh)', async () => {
    const parent = resolve(fakeHome, 'parent-init');
    mkdirSync(parent, { recursive: true });
    writeOkConfig(parent);
    await execFileAsync('git', ['init', '--initial-branch=main', parent]);
    configureTestGitRepository(parent);
    await execFileAsync('git', ['-C', parent, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', parent, 'config', 'user.name', 'Test']);
    writeFileSync(resolve(parent, 'README.md'), '# parent\n');
    await execFileAsync('git', ['-C', parent, 'add', 'README.md']);
    await execFileAsync('git', ['-C', parent, 'commit', '-m', 'initial']);

    const wt = resolve(parent, 'wt-initialized');
    await execFileAsync('git', ['-C', parent, 'worktree', 'add', '-b', 'init-feat', wt]);
    configureTestGitRepository(wt);
    writeOkConfig(wt);

    const result = await discoverProject(wt, { homeDir: fakeHome, dirSizeProbe: null });

    expect(result.kind).toBe('managed');
    if (result.kind !== 'managed') return;
    expect(result.projectDir).toBe(wt);
    expect(result.pickedPath).toBe(wt);
    expect(result.ancestorPromoted).toBe(false);
  });
});
