import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { inspectPiTrustResources } from './pi-trust-resources.ts';

describe('Pi trust dependent resources', () => {
  let root: string;
  let home: string;
  let cwd: string;
  let bridgePath: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pi-resources-')));
    home = join(root, 'home');
    cwd = join(root, 'project');
    bridgePath = join(cwd, '.pi', 'extensions', 'open-knowledge.ts');
    mkdirSync(home);
    mkdirSync(dirname(bridgePath), { recursive: true });
    writeFileSync(bridgePath, 'owned bridge');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('ignores only the bridge and owned skill namespaces in the current project', () => {
    for (const skillRoot of [join(cwd, '.pi', 'skills'), join(cwd, '.agents', 'skills')]) {
      for (const name of ['open-knowledge', 'open-knowledge-discovery', 'open-knowledge-custom']) {
        mkdirSync(join(skillRoot, name), { recursive: true });
        writeFileSync(join(skillRoot, name, 'keep.txt'), 'owned namespace');
      }
    }
    expect(inspectPiTrustResources(cwd, home, bridgePath)).toEqual({ kind: 'none' });
    expect(readFileSync(bridgePath, 'utf8')).toBe('owned bridge');
  });

  test('empty extension and skill directories need no shared trust', () => {
    mkdirSync(join(cwd, '.pi', 'skills'));
    mkdirSync(join(cwd, '.agents', 'skills'), { recursive: true });
    expect(inspectPiTrustResources(cwd, home, bridgePath)).toEqual({ kind: 'none' });
  });

  test.each(['settings.json', 'prompts', 'themes', 'SYSTEM.md', 'APPEND_SYSTEM.md'])(
    'preserves trust for the existing %s resource, including empty files and directories',
    (name) => {
      const path = join(cwd, '.pi', name);
      if (name === 'prompts' || name === 'themes') mkdirSync(path);
      else writeFileSync(path, '');
      expect(inspectPiTrustResources(cwd, home, bridgePath)).toEqual({
        kind: 'shared',
        paths: [path],
      });
    },
  );

  test.each(['other.ts', 'other.js', 'package-extension', '.extension-state'])(
    'preserves trust for every other extension entry: %s',
    (name) => {
      const path = join(dirname(bridgePath), name);
      if (name === 'package-extension') mkdirSync(path);
      else writeFileSync(path, '');
      expect(inspectPiTrustResources(cwd, home, bridgePath)).toEqual({
        kind: 'shared',
        paths: [path],
      });
    },
  );

  test.each(['.pi', '.agents'])(
    'preserves unrelated %s skills without claiming a similar name',
    (dir) => {
      const path = join(cwd, dir, 'skills', 'open-knowledgeable');
      mkdirSync(path, { recursive: true });
      expect(inspectPiTrustResources(cwd, home, bridgePath)).toEqual({
        kind: 'shared',
        paths: [path],
      });
    },
  );

  test('ancestor skill roots remain shared even when empty or entirely OpenKnowledge-named', () => {
    const shared = join(root, '.agents', 'skills');
    mkdirSync(shared, { recursive: true });
    expect(inspectPiTrustResources(cwd, home, bridgePath)).toEqual({
      kind: 'shared',
      paths: [shared],
    });
    mkdirSync(join(shared, 'open-knowledge-discovery'));
    expect(inspectPiTrustResources(cwd, home, bridgePath)).toEqual({
      kind: 'shared',
      paths: [shared],
    });
  });

  test('ignores user-global agents skills when home is the project or an ancestor', () => {
    mkdirSync(join(home, '.agents', 'skills', 'personal-skill'), { recursive: true });
    const nested = join(home, 'project');
    mkdirSync(nested);
    expect(
      inspectPiTrustResources(nested, home, join(nested, '.pi', 'extensions', 'open-knowledge.ts')),
    ).toEqual({ kind: 'none' });
    expect(
      inspectPiTrustResources(home, home, join(home, '.pi', 'extensions', 'open-knowledge.ts')),
    ).toEqual({ kind: 'none' });
  });

  test.skipIf(process.platform === 'win32')(
    'inspects a symlinked skill root and preserves foreign resources',
    () => {
      const target = join(root, 'user-skills');
      mkdirSync(join(target, 'foreign'), { recursive: true });
      symlinkSync(target, join(cwd, '.pi', 'skills'));
      expect(inspectPiTrustResources(cwd, home, bridgePath)).toEqual({
        kind: 'shared',
        paths: [join(cwd, '.pi', 'skills', 'foreign')],
      });
    },
  );

  test.skipIf(process.platform === 'win32')('refuses an unresolved resource symlink', () => {
    const path = join(cwd, '.pi', 'prompts');
    symlinkSync(join(root, 'missing-prompts'), path);
    const outcome = inspectPiTrustResources(cwd, home, bridgePath);
    expect(outcome).toMatchObject({ kind: 'unreadable' });
    if (outcome.kind === 'unreadable') {
      expect(outcome.error).toContain(path);
      expect(outcome.error).toContain('symlink target is missing');
      expect(outcome.error).toContain('restore the target or correct the symlink');
      expect(outcome.error).not.toContain('permissions');
    }
  });

  test.skipIf(process.platform === 'win32')(
    'escapes terminal controls in an unreadable resource path',
    () => {
      const project = join(root, 'project\u001b[2K\r\n\u202e');
      mkdirSync(join(project, '.pi'), { recursive: true });
      symlinkSync(join(root, 'missing-prompts'), join(project, '.pi', 'prompts'));
      const outcome = inspectPiTrustResources(
        project,
        home,
        join(project, '.pi', 'extensions', 'open-knowledge.ts'),
      );
      expect(outcome).toMatchObject({ kind: 'unreadable' });
      if (outcome.kind === 'unreadable') {
        expect(outcome.error).toContain('project\\u001b[2K\\u000d\\u000a\\u202e');
        expect(outcome.error).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
        expect(outcome.error).not.toContain('\u202e');
        expect(outcome.error).toContain('restore the target or correct the symlink');
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'reports a resource symlink cycle with its repair',
    () => {
      const path = join(cwd, '.pi', 'prompts');
      symlinkSync(path, path);
      const outcome = inspectPiTrustResources(cwd, home, bridgePath);
      expect(outcome).toMatchObject({ kind: 'unreadable' });
      if (outcome.kind === 'unreadable') {
        expect(outcome.error).toContain(path);
        expect(outcome.error).toContain('repair any symlink cycle');
      }
    },
  );

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses an unreadable skill root rather than treating it as empty',
    () => {
      const path = join(cwd, '.pi', 'skills');
      mkdirSync(path);
      chmodSync(path, 0o000);
      try {
        const outcome = inspectPiTrustResources(cwd, home, bridgePath);
        expect(outcome).toMatchObject({ kind: 'unreadable' });
        if (outcome.kind === 'unreadable') {
          expect(outcome.error).toContain(path);
          expect(outcome.error).toContain('permission denied');
          expect(outcome.error).toContain('check file and parent-directory permissions');
        }
      } finally {
        chmodSync(path, 0o700);
      }
    },
  );
});
