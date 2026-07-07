/**
 * Regression tests for cross-platform path handling in the `.skill` ZIP
 * builder. Covers the Windows class of bug where `sourceDir.split('/').pop()`
 * leaked the entire absolute path into the ZIP root because Windows paths
 * use `\` separators.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { __testing, resolveBundledSkillDir } from './build-skill-zip.ts';

const { computeWrapperFolderName, extractMetadataVersion, toPosixZipPath } = __testing;

/** Build the `Contents/Resources/cli/dist/assets/skills/<which>` subpath that
 *  a co-installed OK Desktop ships, rooted at an arbitrary `appsRoot`. */
function desktopSkillDir(appsRoot: string, which: 'discovery' | 'project'): string {
  return join(
    appsRoot,
    'OpenKnowledge.app',
    'Contents',
    'Resources',
    'cli',
    'dist',
    'assets',
    'skills',
    which,
  );
}

describe('extractMetadataVersion', () => {
  const FM_BODY = 'name: open-knowledge\nmetadata:\n  version: "1.2.3"\n';

  test('reads metadata.version from a bare-fence SKILL.md', () => {
    expect(extractMetadataVersion(`---\n${FM_BODY}---\n\n# Skill\n`)).toBe('1.2.3');
  });

  test('tolerates trailing whitespace on the fence lines (core fence contract)', () => {
    expect(extractMetadataVersion(`--- \n${FM_BODY}--- \n\n# Skill\n`)).toBe('1.2.3');
    expect(extractMetadataVersion(`---\t\n${FM_BODY}---\n\n# Skill\n`)).toBe('1.2.3');
  });

  test('returns undefined when frontmatter or metadata.version is absent', () => {
    expect(extractMetadataVersion('# No frontmatter\n')).toBeUndefined();
    expect(extractMetadataVersion('---\nname: open-knowledge\n---\n')).toBeUndefined();
  });
});

describe('computeWrapperFolderName', () => {
  test('POSIX: returns last segment', () => {
    expect(computeWrapperFolderName('/usr/local/lib/skills/open-knowledge', posix.basename)).toBe(
      'open-knowledge',
    );
  });

  test('POSIX: handles trailing slash', () => {
    expect(computeWrapperFolderName('/usr/local/lib/skills/open-knowledge/', posix.basename)).toBe(
      'open-knowledge',
    );
  });

  test('Windows: backslash-separated absolute path returns last segment', () => {
    expect(
      computeWrapperFolderName(
        'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@inkeep\\open-knowledge\\dist\\assets\\skills\\open-knowledge',
        win32.basename,
      ),
    ).toBe('open-knowledge');
  });

  test('Windows: forward-slash absolute path returns last segment (UNC, mixed)', () => {
    expect(computeWrapperFolderName('C:/foo/bar/open-knowledge', win32.basename)).toBe(
      'open-knowledge',
    );
  });

  test('falls back to "open-knowledge" when basename is empty', () => {
    expect(computeWrapperFolderName('', posix.basename)).toBe('open-knowledge');
  });
});

describe('toPosixZipPath', () => {
  test('POSIX: passes through unchanged', () => {
    expect(toPosixZipPath('SKILL.md', '/')).toBe('SKILL.md');
    expect(toPosixZipPath('subdir/file.txt', '/')).toBe('subdir/file.txt');
  });

  test('Windows: rewrites backslashes to forward slashes', () => {
    expect(toPosixZipPath('subdir\\file.txt', '\\')).toBe('subdir/file.txt');
    expect(toPosixZipPath('a\\b\\c\\d.md', '\\')).toBe('a/b/c/d.md');
  });

  test('flat file name has no separators to rewrite', () => {
    expect(toPosixZipPath('SKILL.md', '\\')).toBe('SKILL.md');
  });
});

describe('resolveBundledSkillDir', () => {
  test('resolves the discovery bundle to an existing dir containing SKILL.md', () => {
    const dir = resolveBundledSkillDir('discovery', { checkDesktop: false });
    expect(dir.endsWith('discovery')).toBe(true);
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
  });

  test('resolves the project bundle to an existing dir containing SKILL.md', () => {
    const dir = resolveBundledSkillDir('project', { checkDesktop: false });
    expect(dir.endsWith('project')).toBe(true);
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
  });

  test('discovery and project resolve to siblings under one skills/ root (AC4)', () => {
    const d = resolveBundledSkillDir('discovery', { checkDesktop: false });
    const p = resolveBundledSkillDir('project', { checkDesktop: false });
    expect(dirname(d)).toBe(dirname(p));
  });

  test('a co-installed OK Desktop wins on macOS when checkDesktop is on (AC4)', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-resolver-'));
    try {
      const simulated = desktopSkillDir(join(home, 'Applications'), 'discovery');
      mkdirSync(simulated, { recursive: true });
      const dir = resolveBundledSkillDir('discovery', {
        home,
        platform: 'darwin',
        checkDesktop: true,
      });
      // The Desktop probe fired — the resolved path is inside an `.app` bundle.
      expect(dir).toContain('OpenKnowledge.app');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('the Desktop probe resolves the project bundle too', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-resolver-'));
    try {
      mkdirSync(desktopSkillDir(join(home, 'Applications'), 'project'), { recursive: true });
      const dir = resolveBundledSkillDir('project', {
        home,
        platform: 'darwin',
        checkDesktop: true,
      });
      expect(dir).toContain('OpenKnowledge.app');
      expect(dir.endsWith('project')).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('checkDesktop:false skips the Desktop probe', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-resolver-'));
    try {
      mkdirSync(desktopSkillDir(join(home, 'Applications'), 'project'), { recursive: true });
      const dir = resolveBundledSkillDir('project', {
        home,
        platform: 'darwin',
        checkDesktop: false,
      });
      expect(dir).not.toContain('OpenKnowledge.app');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('non-darwin platforms skip the Desktop probe even with checkDesktop on', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-resolver-'));
    try {
      mkdirSync(desktopSkillDir(join(home, 'Applications'), 'project'), { recursive: true });
      const dir = resolveBundledSkillDir('project', {
        home,
        platform: 'linux',
        checkDesktop: true,
      });
      expect(dir).not.toContain('OpenKnowledge.app');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Pins the load-bearing invariant: when
  // `checkDesktop` is OMITTED, the resolver must default to `false` and skip
  // the `/Applications/OpenKnowledge.app` probe — not silently fall back to
  // `true`. An accidental revert of `?? false` to `?? true`
  // would pass every other test on every platform;
  // this one fails.
  test('default (checkDesktop omitted) skips the Desktop probe on darwin', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-resolver-'));
    try {
      mkdirSync(desktopSkillDir(join(home, 'Applications'), 'project'), { recursive: true });
      const dir = resolveBundledSkillDir('project', {
        home,
        platform: 'darwin',
        // checkDesktop intentionally omitted — relying on the default.
      });
      expect(dir).not.toContain('OpenKnowledge.app');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
