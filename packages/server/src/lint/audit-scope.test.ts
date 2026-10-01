import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_LINTER_CONFIG, type LinterConfig } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { auditProject } from './audit.ts';
import { AuditCache } from './audit-cache.ts';
import {
  AUDIT_EMPTY_SCOPE_WARNING,
  auditScopeNotFoundTitle,
  resolveAuditScope,
} from './audit-scope.ts';

let root: string;
const baseConfig: LinterConfig = {
  ...DEFAULT_LINTER_CONFIG,
  plugins: {
    ...DEFAULT_LINTER_CONFIG.plugins,
    markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true },
  },
};
const TABBED = '# Title\n\n\tA hard tab.\n';

function write(path: string, body = TABBED): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-audit-scope-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveAuditScope', () => {
  test('resolves an extensionless document to the same cache identity as its explicit suffix', async () => {
    write('guide.mdx');
    const cache = new AuditCache();
    const results = [];
    for (const targetPath of ['guide', 'guide.mdx']) {
      const result = resolveAuditScope(targetPath, root);
      if (!result.ok) throw new Error(result.title);
      results.push(
        await auditProject({
          projectDir: root,
          contentDir: root,
          baseConfig,
          targetPath,
          resolvedScope: result.scope,
          cache,
        }),
      );
    }
    const direct = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig,
      targetPath: 'guide',
      cache,
    });
    expect(results[0]).toEqual(results[1]);
    expect(direct).toEqual(results[0]);
    expect(results[0]?.files[0]?.file).toBe('guide.mdx');
    expect(
      results[0]?.files[0]?.diagnostics.some((diagnostic) => diagnostic.code === 'MD010'),
    ).toBe(true);
    expect(cache.stats().entries).toBe(1);
    expect(cache.stats().hits).toBe(2);
  });

  test('existing regular files and directories win over document candidates', () => {
    write('guide');
    write('guide.mdx');
    mkdirSync(join(root, 'folder.md'));
    write('folder.md.mdx');
    expect(resolveAuditScope('guide', root)).toEqual({
      ok: true,
      scope: { kind: 'file', path: join(root, 'guide') },
    });
    expect(resolveAuditScope('folder.md', root)).toEqual({
      ok: true,
      scope: { kind: 'dir', path: join(root, 'folder.md') },
    });
  });

  test('prefers mdx only for an absent extensionless path', () => {
    write('guide.md');
    write('guide.mdx');
    write('only-mdx.mdx');
    expect(resolveAuditScope('guide', root)).toEqual({
      ok: true,
      scope: { kind: 'file', path: join(root, 'guide.mdx') },
    });
    expect(resolveAuditScope('guide.md', root)).toEqual({
      ok: true,
      scope: { kind: 'file', path: join(root, 'guide.md') },
    });
    expect(resolveAuditScope('only-mdx.md', root)).toEqual({
      ok: false,
      path: join(root, 'only-mdx.md'),
      title: auditScopeNotFoundTitle('only-mdx.md'),
    });
    expect(resolveAuditScope('missing', root)).toEqual({
      ok: false,
      path: join(root, 'missing'),
      title: auditScopeNotFoundTitle('missing'),
    });
  });

  test('resolves an absent dotted document stem before reporting it missing', () => {
    write('notes/v1.2.md');
    write('notes/v1.2.mdx');
    expect(resolveAuditScope('notes/v1.2', root)).toEqual({
      ok: true,
      scope: { kind: 'file', path: join(root, 'notes/v1.2.mdx') },
    });
    expect(resolveAuditScope('notes/v1.2.md', root)).toEqual({
      ok: true,
      scope: { kind: 'file', path: join(root, 'notes/v1.2.md') },
    });
  });

  test('a missing content directory names content.dir and never resolves to a sibling document', () => {
    const missing = join(root, 'content');
    write('content.md');
    write('outside.md');
    const expected = {
      ok: false,
      path: missing,
      title: `Content directory ${JSON.stringify(missing)} was not found. Set content.dir to an existing directory.`,
    };
    expect(resolveAuditScope(undefined, missing)).toEqual(expected);
    expect(resolveAuditScope('.', missing)).toEqual(expected);
    expect(resolveAuditScope('../outside', missing)).toEqual(expected);
    expect(resolveAuditScope('../outside', join(root, 'inner'))).toMatchObject({ ok: false });
  });

  test('an existing content root retains explicit outer-file selection', () => {
    mkdirSync(join(root, 'content'));
    write('outside.md');
    expect(resolveAuditScope('../outside.md', join(root, 'content'))).toEqual({
      ok: true,
      scope: { kind: 'file', path: join(root, 'outside.md') },
    });
  });

  test('a child under a regular file is an unknown scope with its path and a fix', () => {
    write('parent');
    const result = resolveAuditScope('parent/child', root);
    expect(result).toEqual({
      ok: false,
      path: join(root, 'parent/child'),
      title: auditScopeNotFoundTitle('parent/child'),
    });
    if (result.ok) throw new Error('Expected an unknown scope');
    expect(result.title).toContain('"parent/child"');
    expect(result.title).toBe(
      'Scope "parent/child" was not found. Use an existing file or directory; a document stem without .md or .mdx resolves .mdx before .md. Explicit document extensions must exist as written.',
    );
  });

  test('falls back to md and accepts canonical relative or absolute spellings', () => {
    write('nested/guide.md');
    const expected = { ok: true, scope: { kind: 'file', path: join(root, 'nested/guide.md') } };
    expect(resolveAuditScope('nested/guide', root)).toEqual(expected);
    expect(resolveAuditScope('nested/./guide.md', root)).toEqual(expected);
    expect(resolveAuditScope(join(root, 'nested/guide.md'), root)).toEqual(expected);
  });

  test('does not replace a dangling supplied symlink with a sibling document', () => {
    symlinkSync(join(root, 'missing'), join(root, 'guide'));
    write('guide.mdx');
    expect(resolveAuditScope('guide', root)).toMatchObject({
      ok: false,
      title: auditScopeNotFoundTitle('guide'),
    });
  });

  test.each(['overlong segment', 'symlink loop'])(
    'returns the teaching not-found outcome for a %s',
    (kind) => {
      const target = kind === 'overlong segment' ? 'x'.repeat(300) : 'loop';
      if (kind === 'symlink loop') symlinkSync(join(root, target), join(root, target));
      expect(resolveAuditScope(target, root)).toEqual({
        ok: false,
        path: join(root, target),
        title: auditScopeNotFoundTitle(target),
      });
    },
  );

  test('leaves hidden and external scope admission to each entrypoint', () => {
    write('.hidden.md');
    expect(resolveAuditScope('.hidden', root)).toEqual({
      ok: true,
      scope: { kind: 'file', path: join(root, '.hidden.md') },
    });
    expect(resolveAuditScope(dirname(root), root)).toEqual({
      ok: true,
      scope: { kind: 'dir', path: dirname(root) },
    });
  });
});

describe('server scope admission and coverage', () => {
  test.each(['empty', 'ignored'])(
    'reports zero-document coverage for %s without diagnostic counts',
    async (targetPath) => {
      mkdirSync(join(root, 'empty'));
      write('ignored/document.md');
      write('.gitignore', 'ignored/\n');
      const result = resolveAuditScope(targetPath, root);
      if (!result.ok) throw new Error(result.title);
      const audit = await auditProject({
        projectDir: root,
        contentDir: root,
        baseConfig,
        targetPath,
        resolvedScope: result.scope,
      });
      expect(audit).toEqual({
        files: [],
        fileCount: 0,
        errorCount: 0,
        warningCount: 0,
        warnings: [AUDIT_EMPTY_SCOPE_WARNING],
        ran: ['markdownlint'],
      });
    },
  );

  test('does not classify an unreadable directory as an empty admitted scope', async () => {
    const missing = join(root, 'missing');
    const audit = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig,
      resolvedScope: { kind: 'dir', path: missing },
    });
    expect(audit.fileCount).toBe(0);
    expect(audit.warnings).toEqual([expect.stringContaining('could not read missing')]);
  });

  test('a removed content directory reports the unavailable scope', async () => {
    const missing = join(root, 'missing');
    const audit = await auditProject({ projectDir: root, contentDir: missing, baseConfig });
    expect(audit.fileCount).toBe(0);
    expect(audit.warnings).toEqual([expect.stringContaining('could not read')]);
  });

  test.each(['.gitignore', '.okignore'])(
    'lints explicitly requested files excluded by %s',
    async (ignoreFile) => {
      write(ignoreFile, 'ignored/\n');
      for (const targetPath of ['ignored/document.md', 'ignored/document.mdx', 'ignored/plain']) {
        write(targetPath);
        const resolution = resolveAuditScope(targetPath, root);
        if (!resolution.ok) throw new Error(resolution.title);
        const audit = await auditProject({
          projectDir: root,
          contentDir: root,
          baseConfig,
          targetPath,
          resolvedScope: resolution.scope,
        });
        expect(audit.fileCount).toBe(1);
        expect(audit.files.map((file) => file.file)).toEqual([targetPath]);
        expect(audit.files[0]?.diagnostics.some((diagnostic) => diagnostic.code === 'MD010')).toBe(
          true,
        );
        expect(audit.warnings).toEqual([]);
      }
    },
  );

  test('a resolved file scope never reports project-wide unmatched schema globs', async () => {
    write('notes/a.md', '# A\n');
    write(
      '.ok/schemas/doc.schema.json',
      JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' }),
    );
    const config: LinterConfig = {
      ...baseConfig,
      plugins: {
        ...baseConfig.plugins,
        frontmatter: {
          enabled: true,
          schemas: [{ file: '.ok/schemas/doc.schema.json', appliesTo: ['specs/**'] }],
        },
      },
    };
    const unmatched =
      'unmatched appliesTo glob "specs/**" — matches no docs in this project (frontmatter mapping for .ok/schemas/doc.schema.json)';
    const whole = await auditProject({ projectDir: root, contentDir: root, baseConfig: config });
    expect(whole.warnings).toContain(unmatched);
    const resolution = resolveAuditScope('notes/a.md', root);
    if (!resolution.ok) throw new Error(resolution.title);
    const scoped = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig: config,
      resolvedScope: resolution.scope,
    });
    expect(scoped.fileCount).toBe(1);
    expect(scoped.warnings).not.toContain(unmatched);
  });

  test('keeps non-document regular files and in-root symlink aliases admitted', async () => {
    write('plain');
    write('guide.md');
    symlinkSync(join(root, 'guide.md'), join(root, 'alias.md'));
    for (const targetPath of ['plain', 'alias.md']) {
      const result = resolveAuditScope(targetPath, root);
      if (!result.ok) throw new Error(result.title);
      const audit = await auditProject({
        projectDir: root,
        contentDir: root,
        baseConfig,
        targetPath,
        resolvedScope: result.scope,
      });
      expect(audit.fileCount).toBe(1);
      expect(audit.files[0]?.file).toBe(targetPath);
      expect(audit.warnings).toEqual([]);
    }
  });
});
