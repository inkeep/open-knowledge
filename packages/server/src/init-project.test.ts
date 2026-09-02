import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  OK_DIR,
  PROJECT_SKILL_PROJECTION_IGNORE_PATHS,
  RESERVED_PROJECT_SKILL_NAME,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildConfigYmlContent,
  ensureProjectSkillGitignore,
  initContent,
  OK_OKIGNORE_TEMPLATE,
  packageVersionMajorMinor,
  ROOT_GITIGNORE_TEMPLATE,
  writeRootGitignoreForNewRepo,
} from './init-project.ts';

describe('initContent', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `content-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates config-only .ok/ scaffold from scratch', () => {
    const result = initContent(testDir);

    const okDir = join(testDir, OK_DIR);
    expect(existsSync(okDir)).toBe(true);
    expect(existsSync(join(okDir, 'local'))).toBe(false);
    expect(existsSync(join(okDir, 'cache'))).toBe(false);
    expect(existsSync(join(okDir, '.gitignore'))).toBe(true);
    expect(existsSync(join(okDir, 'config.yml'))).toBe(true);

    expect(existsSync(join(okDir, 'AGENTS.md'))).toBe(false);

    expect(existsSync(join(okDir, 'articles'))).toBe(false);
    expect(existsSync(join(okDir, 'external-sources'))).toBe(false);
    expect(existsSync(join(okDir, 'research'))).toBe(false);

    expect(result.created.length).toBeGreaterThan(0);
    expect(result.skipped.length).toBe(0);
  });

  it('is idempotent — does not clobber existing files', () => {
    initContent(testDir);

    const configPath = join(testDir, OK_DIR, 'config.yml');
    writeFileSync(configPath, 'custom content');

    const result = initContent(testDir);

    expect(readFileSync(configPath, 'utf-8')).toBe('custom content');
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('generates files with expected content', () => {
    initContent(testDir);

    const okDir = join(testDir, OK_DIR);

    const gitignore = readFileSync(join(okDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('local/');
    expect(gitignore).toContain('worktrees/');

    const configYml = readFileSync(join(okDir, 'config.yml'), 'utf-8');
    expect(configYml).toContain('OpenKnowledge — project configuration');
    expect(configYml).toContain('# content:');
    expect(configYml).toContain('# appearance:');
    const activeLines = configYml
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(activeLines).toEqual([]);
  });

  it('config.yml first line is the schema-version-pinned $schema magic comment', () => {
    initContent(testDir);
    const configYml = readFileSync(join(testDir, OK_DIR, 'config.yml'), 'utf-8');
    const firstLine = configYml.split('\n')[0];
    expect(firstLine).toMatch(
      /^# yaml-language-server: \$schema=https:\/\/unpkg\.com\/@inkeep\/open-knowledge@latest\/dist\/schemas\/v\d+\/config\.project\.schema\.json$/,
    );
    expect(configYml.split('\n')[1]).toBe('# OpenKnowledge — project configuration');
    expect(configYml).toContain('# Schema reference: packages/core/src/config/schema.ts');
  });

  it('config.yml scaffold does not teach the removed folders: key or a folder-metadata block', () => {
    initContent(testDir);
    const configYml = readFileSync(join(testDir, OK_DIR, 'config.yml'), 'utf-8');
    expect(configYml).not.toContain('# folders:');
    expect(configYml).not.toContain("#   - match: 'external-sources/**'");
    expect(configYml).not.toContain('Picomatch glob cheatsheet');
    expect(configYml).not.toContain('exact structure');
    expect(configYml).not.toContain('Folders: metadata & templates');
  });

  it('config.yml scaffold describes the suggested three-tier lifecycle', () => {
    initContent(testDir);
    const configYml = readFileSync(join(testDir, OK_DIR, 'config.yml'), 'utf-8');
    expect(configYml).toContain('Suggested lifecycle');
    expect(configYml).toContain('external-sources');
    expect(configYml).toContain('research');
    expect(configYml).toContain('articles');
  });

  it('appends missing scaffold entries to a stale legacy .gitignore (upgrade path)', () => {
    const okDir = join(testDir, OK_DIR);
    mkdirSync(okDir, { recursive: true });
    const stale = `cache/\nserver.lock\nui.lock\nsync-state.json\n`;
    writeFileSync(join(okDir, '.gitignore'), stale, 'utf-8');

    const result = initContent(testDir);

    const after = readFileSync(join(okDir, '.gitignore'), 'utf-8');
    expect(after).toBe(
      `cache/\nserver.lock\nui.lock\nsync-state.json\nlocal/\nworktrees/\nprincipal.json\nstate.json\nlast-spawn-error.log\n`,
    );
    expect(result.updated).toContain('.gitignore');
    expect(result.created).not.toContain('.gitignore');
  });

  it('preserves user-added .gitignore entries during scaffold merge', () => {
    const okDir = join(testDir, OK_DIR);
    mkdirSync(okDir, { recursive: true });
    const userCustomized = `cache/\nserver.lock\nmy-custom-ignore.tmp\n`;
    writeFileSync(join(okDir, '.gitignore'), userCustomized, 'utf-8');

    initContent(testDir);

    const after = readFileSync(join(okDir, '.gitignore'), 'utf-8');
    expect(after).toContain('my-custom-ignore.tmp');
    expect(after).toContain('local/');
  });

  describe('symlink-guard against malicious upstream scaffold paths', () => {
    it('refuses to follow .ok/.gitignore symlink with existing target (read-modify-write)', () => {
      const okDir = join(testDir, OK_DIR);
      mkdirSync(okDir, { recursive: true });
      const victim = resolve(testDir, 'victim-rc');
      const victimContent = '#!/bin/sh\nexec /usr/local/bin/realprog\n';
      writeFileSync(victim, victimContent, 'utf-8');
      symlinkSync(victim, join(okDir, '.gitignore'));

      expect(() => initContent(testDir)).toThrow(/symlink/i);
      expect(readFileSync(victim, 'utf-8')).toBe(victimContent);
      expect(lstatSync(join(okDir, '.gitignore')).isSymbolicLink()).toBe(true);
    });

    it('refuses to follow .ok/.gitignore symlink with non-existent target (write-creates-file)', () => {
      const okDir = join(testDir, OK_DIR);
      mkdirSync(okDir, { recursive: true });
      const phantomTarget = resolve(testDir, 'phantom-victim');
      symlinkSync(phantomTarget, join(okDir, '.gitignore'));

      expect(() => initContent(testDir)).toThrow(/symlink/i);
      expect(existsSync(phantomTarget)).toBe(false);
    });

    it('refuses to follow .ok/config.yml symlink (writeIfMissing path)', () => {
      const okDir = join(testDir, OK_DIR);
      mkdirSync(okDir, { recursive: true });
      const phantomTarget = resolve(testDir, 'phantom-config');
      symlinkSync(phantomTarget, join(okDir, 'config.yml'));

      expect(() => initContent(testDir)).toThrow(/symlink/i);
      expect(existsSync(phantomTarget)).toBe(false);
    });

    it('refuses to follow project-root .okignore symlink (writeIfMissing path)', () => {
      const phantomTarget = resolve(testDir, 'phantom-okignore-target');
      symlinkSync(phantomTarget, join(testDir, '.okignore'));

      expect(() => initContent(testDir)).toThrow(/symlink/i);
      expect(existsSync(phantomTarget)).toBe(false);
    });

    it('refuses to operate when .ok/ itself is a symlink (would redirect every scaffold write)', () => {
      const decoy = resolve(testDir, 'decoy-dir');
      mkdirSync(decoy, { recursive: true });
      symlinkSync(decoy, join(testDir, OK_DIR));

      expect(() => initContent(testDir)).toThrow(/symlink/i);
      expect(existsSync(join(decoy, '.gitignore'))).toBe(false);
      expect(existsSync(join(decoy, 'config.yml'))).toBe(false);
    });
  });

  it('does not duplicate .gitignore entries on repeated initContent calls', () => {
    initContent(testDir);
    initContent(testDir);
    initContent(testDir);

    const gitignore = readFileSync(join(testDir, OK_DIR, '.gitignore'), 'utf-8');
    const matches = gitignore.split('\n').filter((l) => l.trim() === 'local/').length;
    expect(matches).toBe(1);
  });

  it('writes config.yml with content.dir override when contentDir option is set', () => {
    const result = initContent(testDir, { contentDir: 'docs' });
    expect(result.created).toContain('config.yml');
    const configYml = readFileSync(join(testDir, OK_DIR, 'config.yml'), 'utf-8');
    expect(configYml).toContain('content:\n  dir: docs');
  });

  it('writes config.yml with default commented content.dir when contentDir is "."', () => {
    initContent(testDir, { contentDir: '.' });
    const configYml = readFileSync(join(testDir, OK_DIR, 'config.yml'), 'utf-8');
    expect(configYml).toContain('# content:\n#   dir: .');
  });
});

function findCommittedDogfoodFile(relativePath: string): string | null {
  let dir = import.meta.dirname;
  while (dir !== '/' && !existsSync(join(dir, relativePath))) {
    dir = dirname(dir);
  }
  return dir === '/' ? null : join(dir, relativePath);
}

const COMMITTED_OK_GITIGNORE = findCommittedDogfoodFile(join('.ok', '.gitignore'));
const COMMITTED_OKIGNORE = findCommittedDogfoodFile('.okignore');

describe.runIf(COMMITTED_OK_GITIGNORE !== null)(
  'committed .ok/.gitignore matches scaffold output',
  () => {
    it('matches OK_GITIGNORE_CONTENT byte-for-byte', () => {
      const tmp = resolve(
        tmpdir(),
        `gitignore-mirror-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(tmp, { recursive: true });
      try {
        initContent(tmp);
        const scaffolded = readFileSync(join(tmp, OK_DIR, '.gitignore'), 'utf-8');
        const committed = readFileSync(COMMITTED_OK_GITIGNORE as string, 'utf-8');
        expect(committed).toBe(scaffolded);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  },
);

describe.runIf(COMMITTED_OKIGNORE !== null)('committed .okignore matches scaffold output', () => {
  it('starts with OK_OKIGNORE_TEMPLATE byte-for-byte', () => {
    const tmp = resolve(
      tmpdir(),
      `okignore-mirror-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    try {
      initContent(tmp);
      const scaffolded = readFileSync(join(tmp, '.okignore'), 'utf-8');
      expect(scaffolded).toBe(OK_OKIGNORE_TEMPLATE);
      const committed = readFileSync(COMMITTED_OKIGNORE as string, 'utf-8');
      expect(
        committed.startsWith(OK_OKIGNORE_TEMPLATE),
        `committed .okignore (${COMMITTED_OKIGNORE}) must start with OK_OKIGNORE_TEMPLATE ` +
          'byte-for-byte; repo-local exclusions may only be appended below the scaffold block',
      ).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('writeRootGitignoreForNewRepo', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `root-gitignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates a project-root .gitignore from the template when absent', () => {
    const action = writeRootGitignoreForNewRepo(testDir);
    expect(action).toBe('created');
    const written = readFileSync(join(testDir, '.gitignore'), 'utf-8');
    expect(written).toBe(ROOT_GITIGNORE_TEMPLATE);
    expect(written).toContain('.DS_Store\n');
    expect(written).toContain('.localized\n');
    expect(written).toContain('Thumbs.db\n');
    expect(written).toContain('thumbs.db\n');
    expect(written).toContain('desktop.ini\n');
    expect(written).toContain('Desktop.ini\n');
    expect(written).toContain('.directory\n');
  });

  it('skips when a project-root .gitignore already exists (writeIfMissing — user wins)', () => {
    const original = 'node_modules/\n*.log\n';
    writeFileSync(join(testDir, '.gitignore'), original, 'utf-8');
    const action = writeRootGitignoreForNewRepo(testDir);
    expect(action).toBe('skipped');
    const after = readFileSync(join(testDir, '.gitignore'), 'utf-8');
    expect(after).toBe(original);
  });

  it('refuses to follow a symlink at the .gitignore path (threat model: untrusted upstream)', () => {
    const sentinel = join(testDir, 'sentinel.txt');
    writeFileSync(sentinel, 'do-not-clobber', 'utf-8');
    symlinkSync(sentinel, join(testDir, '.gitignore'));
    expect(() => writeRootGitignoreForNewRepo(testDir)).toThrow(/Refusing to follow symlink/);
    expect(readFileSync(sentinel, 'utf-8')).toBe('do-not-clobber');
    expect(lstatSync(join(testDir, '.gitignore')).isSymbolicLink()).toBe(true);
  });
});

describe('packageVersionMajorMinor', () => {
  it('extracts MAJOR.MINOR from a 3-part semver', () => {
    expect(packageVersionMajorMinor('1.2.3')).toBe('1.2');
    expect(packageVersionMajorMinor('0.2.0')).toBe('0.2');
    expect(packageVersionMajorMinor('10.20.30')).toBe('10.20');
  });

  it('drops prerelease suffixes from the minor segment (split-on-dot only consumes the first two)', () => {
    expect(packageVersionMajorMinor('1.2.0-rc.1')).toBe('1.2');
  });

  it('falls back to 0.0 when the input is malformed', () => {
    expect(packageVersionMajorMinor('')).toBe('0.0');
  });
});

describe('buildConfigYmlContent', () => {
  it('templates the magic comment with @latest + schema-major path', () => {
    const out = buildConfigYmlContent('3.5.0');
    expect(out.split('\n')[0]).toMatch(
      /^# yaml-language-server: \$schema=https:\/\/unpkg\.com\/@inkeep\/open-knowledge@latest\/dist\/schemas\/v\d+\/config\.project\.schema\.json$/,
    );
  });

  it('produces a file with NO uncommented top-level keys (idempotent at parse) — default options', () => {
    const out = buildConfigYmlContent('1.0.0');
    const activeLines = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(activeLines).toEqual([]);
  });

  it('produces a file with NO uncommented top-level keys when contentDir is "."', () => {
    const out = buildConfigYmlContent('1.0.0', { contentDir: '.' });
    const activeLines = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(activeLines).toEqual([]);
  });

  it('emits an active content.dir block when contentDir is a sub-path', () => {
    const out = buildConfigYmlContent('1.0.0', { contentDir: 'docs' });
    expect(out).toContain('content:\n  dir: docs');
    expect(out).not.toContain('# content:\n#   dir: .');
    const activeLines = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(activeLines).toEqual(['content:', 'dir: docs']);
  });

  it('quotes contentDir with whitespace so emitted YAML parses', () => {
    const out = buildConfigYmlContent('1.0.0', { contentDir: 'with spaces/sub' });
    expect(out).toContain('content:\n  dir: "with spaces/sub"');
  });

  it('precedence header points to user-global `~/.ok/global.yml`, not `config.yml`', () => {
    const out = buildConfigYmlContent('1.0.0');
    expect(out).toContain('~/.ok/global.yml');
    expect(out).toContain('./.ok/config.yml');
    expect(out).not.toContain('~/.ok/config.yml');
  });
});

describe('ensureProjectSkillGitignore', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `skill-gitignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates a `.gitignore` with every editor-host projection path when absent', () => {
    expect(ensureProjectSkillGitignore(testDir)).toBe('created');
    const body = readFileSync(join(testDir, '.gitignore'), 'utf-8');
    for (const p of PROJECT_SKILL_PROJECTION_IGNORE_PATHS) {
      expect(body).toContain(p);
    }
    expect(body).toContain('.claude/skills/open-knowledge/');
    expect(body).toContain('.cursor/skills/open-knowledge/');
    expect(body).toContain('.codex/skills/open-knowledge/');
    expect(body).toContain('.github/skills/open-knowledge/');
    expect(body).toContain('.opencode/skills/open-knowledge/');
    expect(body).toContain('.pi/skills/open-knowledge/');
  });

  it('appends only the missing projection lines to an existing `.gitignore`, preserving user lines', () => {
    writeFileSync(join(testDir, '.gitignore'), '# user rules\nnode_modules/\n.DS_Store\n', 'utf-8');
    expect(ensureProjectSkillGitignore(testDir)).toBe('updated');
    const body = readFileSync(join(testDir, '.gitignore'), 'utf-8');
    expect(body).toContain('# user rules');
    expect(body).toContain('node_modules/');
    expect(body).toContain('.DS_Store');
    expect(body).toContain('.claude/skills/open-knowledge/');
  });

  it('is idempotent — a second call reports `unchanged` and does not duplicate lines', () => {
    ensureProjectSkillGitignore(testDir);
    expect(ensureProjectSkillGitignore(testDir)).toBe('unchanged');
    const body = readFileSync(join(testDir, '.gitignore'), 'utf-8');
    const occurrences = body.split('.claude/skills/open-knowledge/').length - 1;
    expect(occurrences).toBe(1);
  });

  it('is skill-name-scoped — it never blanket-excludes `.{host}/skills/`', () => {
    ensureProjectSkillGitignore(testDir);
    const body = readFileSync(join(testDir, '.gitignore'), 'utf-8');
    for (const line of body.split('\n').filter((l) => l.trim() && !l.startsWith('#'))) {
      expect(line).toContain(`/${RESERVED_PROJECT_SKILL_NAME}/`);
    }
    expect(body).not.toContain('.claude/skills/\n');
    expect(body).not.toContain('.cursor/skills/\n');
  });
});
