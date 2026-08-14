import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getLogger } from '../logger.ts';
import {
  inspectGeneratedIndexGitAttributes,
  updateGeneratedIndexGitAttributes,
} from './generated-index-git-attributes.ts';

afterEach(() => vi.restoreAllMocks());

function makeProject(contentSubdir = '.'): { projectDir: string; contentDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-generated-index-attrs-'));
  execFileSync('git', ['init', '-q'], { cwd: projectDir });
  if (contentSubdir !== '.') mkdirSync(join(projectDir, contentSubdir), { recursive: true });
  return {
    projectDir,
    contentDir: contentSubdir === '.' ? projectDir : join(projectDir, contentSubdir),
  };
}

const generatedDocNames = ['index', 'guides/index'];

describe('generated-index git attributes', () => {
  test('is not applicable outside a Git working tree', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-generated-index-no-git-'));
    const result = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir: projectDir,
      generatedDocNames,
      enabled: true,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toEqual({ state: 'not-applicable' });
    expect(existsSync(join(projectDir, '.gitattributes'))).toBe(false);
  });

  test('adds a content-scoped union rule that covers root and nested indexes only', async () => {
    const { projectDir, contentDir } = makeProject('knowledge base');
    const result = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames,
      enabled: true,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toEqual({ state: 'ready', ownership: 'open-knowledge' });
    const attributes = readFileSync(join(projectDir, '.gitattributes'), 'utf-8');
    expect(attributes).toContain('"/knowledge base/index.md" merge=union');
    expect(attributes).toContain('"/knowledge base/**/index.md" merge=union');

    const values = ['knowledge base/index.md', 'knowledge base/guides/index.md', 'index.md'].map(
      (path) =>
        execFileSync('git', ['check-attr', 'merge', '--', path], {
          cwd: projectDir,
          encoding: 'utf-8',
        }).trim(),
    );
    expect(values).toEqual([
      'knowledge base/index.md: merge: union',
      'knowledge base/guides/index.md: merge: union',
      'index.md: merge: unspecified',
    ]);
  });

  test('the installed rule union-merges divergent generated index changes', async () => {
    const { projectDir, contentDir } = makeProject('knowledge base');
    const result = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames,
      enabled: true,
    });
    expect(result.ok).toBe(true);

    const indexPath = join(contentDir, 'index.md');
    const commit = (message: string): void => {
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Open Knowledge Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '-qm',
          message,
        ],
        { cwd: projectDir },
      );
    };

    writeFileSync(indexPath, '# Index\n\n## Notes\n', 'utf-8');
    execFileSync('git', ['add', '.gitattributes', 'knowledge base/index.md'], {
      cwd: projectDir,
    });
    commit('base');
    const baseBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: projectDir,
      encoding: 'utf-8',
    }).trim();

    execFileSync('git', ['switch', '-qc', 'generated-left'], { cwd: projectDir });
    writeFileSync(indexPath, '# Index\n\n## Notes\n\n* [Left](./left.md)\n', 'utf-8');
    execFileSync('git', ['add', 'knowledge base/index.md'], { cwd: projectDir });
    commit('left index');

    execFileSync('git', ['switch', '-q', baseBranch], { cwd: projectDir });
    writeFileSync(indexPath, '# Index\n\n## Notes\n\n* [Right](./right.md)\n', 'utf-8');
    execFileSync('git', ['add', 'knowledge base/index.md'], { cwd: projectDir });
    commit('right index');

    execFileSync(
      'git',
      [
        '-c',
        'user.name=Open Knowledge Test',
        '-c',
        'user.email=test@example.invalid',
        'merge',
        '--no-edit',
        'generated-left',
      ],
      { cwd: projectDir },
    );

    expect(readFileSync(indexPath, 'utf-8')).toContain('* [Left](./left.md)');
    expect(readFileSync(indexPath, 'utf-8')).toContain('* [Right](./right.md)');
    expect(
      execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
        cwd: projectDir,
        encoding: 'utf-8',
      }).trim(),
    ).toBe('');
  });

  test('accepts an existing effective union rule without claiming ownership', async () => {
    const { projectDir, contentDir } = makeProject();
    writeFileSync(join(projectDir, '.gitattributes'), 'index.md merge=union\n', 'utf-8');

    const result = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames,
      enabled: true,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toEqual({ state: 'ready', ownership: 'existing' });
    expect(result.changed).toBe(false);
    expect(readFileSync(join(projectDir, '.gitattributes'), 'utf-8')).toBe(
      'index.md merge=union\n',
    );
  });

  test('recreates a tracked union rule that is deleted from the working tree', async () => {
    const { projectDir, contentDir } = makeProject();
    const attributesPath = join(projectDir, '.gitattributes');
    writeFileSync(attributesPath, 'index.md merge=union\n', 'utf-8');
    execFileSync('git', ['add', '.gitattributes'], { cwd: projectDir });
    unlinkSync(attributesPath);

    expect(
      inspectGeneratedIndexGitAttributes({ projectDir, contentDir, generatedDocNames }),
    ).toEqual({ state: 'missing' });

    const result = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames,
      enabled: true,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toEqual({ state: 'ready', ownership: 'open-knowledge' });
    expect(result.changed).toBe(true);
    expect(readFileSync(attributesPath, 'utf-8')).toContain('/**/index.md merge=union');
  });

  test('does not override a conflicting merge attribute', async () => {
    const { projectDir, contentDir } = makeProject();
    writeFileSync(join(projectDir, '.gitattributes'), 'index.md merge=ours\n', 'utf-8');

    const result = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames,
      enabled: true,
    });

    expect(result).toEqual({ ok: false, status: { state: 'conflict' } });
    expect(readFileSync(join(projectDir, '.gitattributes'), 'utf-8')).toBe('index.md merge=ours\n');
  });

  test.skipIf(process.platform === 'win32')(
    'refuses to follow a .gitattributes symlink',
    async () => {
      const { projectDir, contentDir } = makeProject();
      const targetPath = join(projectDir, 'attributes-target');
      writeFileSync(targetPath, '*.png binary\n', 'utf-8');
      symlinkSync(targetPath, join(projectDir, '.gitattributes'));
      const warn = vi
        .spyOn(getLogger('generated-index-git-attributes'), 'warn')
        .mockImplementation(() => {});

      expect(
        inspectGeneratedIndexGitAttributes({ projectDir, contentDir, generatedDocNames }),
      ).toEqual({ state: 'unavailable' });

      const result = await updateGeneratedIndexGitAttributes({
        projectDir,
        contentDir,
        generatedDocNames,
        enabled: true,
      });

      expect(result).toEqual({ ok: false, status: { state: 'unavailable' } });
      expect(readFileSync(targetPath, 'utf-8')).toBe('*.png binary\n');
      expect(warn).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          err: expect.any(Error),
          path: expect.stringContaining('.gitattributes'),
        }),
        'failed to inspect generated-index Git attributes',
      );
      expect(warn).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          err: expect.any(Error),
          path: expect.stringContaining('.gitattributes'),
        }),
        'failed to read generated-index Git attributes',
      );
    },
  );

  test('rolls back its root rule when a nested attribute still overrides a generated index', async () => {
    const { projectDir, contentDir } = makeProject();
    mkdirSync(join(projectDir, 'guides'), { recursive: true });
    writeFileSync(join(projectDir, 'guides', '.gitattributes'), 'index.md merge=ours\n', 'utf-8');

    const result = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames,
      enabled: true,
    });

    expect(result).toEqual({ ok: false, status: { state: 'conflict' } });
    expect(existsSync(join(projectDir, '.gitattributes'))).toBe(false);
  });

  test('disable removes only the Open Knowledge block and rollback restores it', async () => {
    const { projectDir, contentDir } = makeProject();
    writeFileSync(join(projectDir, '.gitattributes'), '*.png binary\n', 'utf-8');
    await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames,
      enabled: true,
    });

    const disabled = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames,
      enabled: false,
    });

    expect(disabled.ok).toBe(true);
    if (!disabled.ok) throw new Error('expected successful disable');
    expect(readFileSync(join(projectDir, '.gitattributes'), 'utf-8')).toBe('*.png binary\n');

    await disabled.rollback();
    expect(
      inspectGeneratedIndexGitAttributes({ projectDir, contentDir, generatedDocNames }),
    ).toEqual({ state: 'ready', ownership: 'open-knowledge' });
  });

  test('accepts and removes an Open Knowledge block checked out with CRLF endings', async () => {
    const { projectDir, contentDir } = makeProject();
    const attributesPath = join(projectDir, '.gitattributes');
    const enabled = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames,
      enabled: true,
    });
    expect(enabled.ok).toBe(true);
    writeFileSync(
      attributesPath,
      readFileSync(attributesPath, 'utf-8').replace(/\n/g, '\r\n'),
      'utf-8',
    );

    expect(
      inspectGeneratedIndexGitAttributes({ projectDir, contentDir, generatedDocNames }),
    ).toEqual({ state: 'ready', ownership: 'open-knowledge' });

    const disabled = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames,
      enabled: false,
    });
    expect(disabled.ok).toBe(true);
    expect(existsSync(attributesPath)).toBe(false);
  });

  test('rollback refuses to overwrite a later project edit', async () => {
    const { projectDir, contentDir } = makeProject();
    const enabled = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames,
      enabled: true,
    });
    if (!enabled.ok) throw new Error('expected successful enable');

    const attributesPath = join(projectDir, '.gitattributes');
    const userEdit = `${readFileSync(attributesPath, 'utf-8')}*.png binary\n`;
    writeFileSync(attributesPath, userEdit, 'utf-8');

    await expect(enabled.rollback()).rejects.toThrow('changed after Open Knowledge updated it');
    expect(readFileSync(attributesPath, 'utf-8')).toBe(userEdit);
  });

  test('disable preserves an equivalent rule owned by the project', async () => {
    const { projectDir, contentDir } = makeProject();
    writeFileSync(join(projectDir, '.gitattributes'), 'index.md merge=union\n', 'utf-8');

    const result = await updateGeneratedIndexGitAttributes({
      projectDir,
      contentDir,
      generatedDocNames,
      enabled: false,
    });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(readFileSync(join(projectDir, '.gitattributes'), 'utf-8')).toBe(
      'index.md merge=union\n',
    );
  });
});
