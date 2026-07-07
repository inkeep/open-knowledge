import { describe, expect, test } from 'bun:test';
import {
  CreateFolderRequestSchema,
  CreateFolderSuccessSchema,
  CreatePageRequestSchema,
  CreatePageSuccessSchema,
  DeletePathRequestSchema,
  DeletePathSuccessSchema,
  DuplicatePathRequestSchema,
  DuplicatePathSuccessSchema,
  EmptyRequestSchema,
  HeadingEntrySchema,
  PageEntrySchema,
  PageHeadingsSuccessSchema,
  PagesSuccessSchema,
  ProblemTypeSchema,
  RenamedDocMappingSchema,
  RenamePathRequestSchema,
  RenamePathSuccessSchema,
  RenameRewrittenDocSchema,
  RollbackRequestSchema,
  RollbackSuccessSchema,
  TrashCleanupRequestSchema,
} from './index.ts';

describe('Cluster B URN tokens (US-007)', () => {
  test('accepts the four new cluster B URNs', () => {
    for (const token of [
      'urn:ok:error:doc-not-found',
      'urn:ok:error:doc-already-exists',
      'urn:ok:error:doc-not-open',
      'urn:ok:error:rollback-not-configured',
    ]) {
      expect(ProblemTypeSchema.safeParse(token).success).toBe(true);
    }
  });
});

describe('RenamedDocMappingSchema', () => {
  test('parses a valid mapping', () => {
    const result = RenamedDocMappingSchema.safeParse({ fromDocName: 'a', toDocName: 'b' });
    expect(result.success).toBe(true);
  });
  test('rejects empty fromDocName', () => {
    expect(RenamedDocMappingSchema.safeParse({ fromDocName: '', toDocName: 'b' }).success).toBe(
      false,
    );
  });
  test('rejects missing toDocName', () => {
    expect(RenamedDocMappingSchema.safeParse({ fromDocName: 'a' }).success).toBe(false);
  });
});

describe('EmptyRequestSchema', () => {
  test('accepts empty object', () => {
    expect(EmptyRequestSchema.safeParse({}).success).toBe(true);
  });
  test('accepts unknown fields (loose)', () => {
    expect(EmptyRequestSchema.safeParse({ foo: 1 }).success).toBe(true);
  });
});

describe('CreatePageRequestSchema', () => {
  test('parses a valid path', () => {
    const result = CreatePageRequestSchema.safeParse({ path: 'foo/bar.md' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.path).toBe('foo/bar.md');
  });
  test('rejects empty path', () => {
    expect(CreatePageRequestSchema.safeParse({ path: '' }).success).toBe(false);
  });
  test('rejects missing path', () => {
    expect(CreatePageRequestSchema.safeParse({}).success).toBe(false);
  });
  test('accepts agentId pass-through', () => {
    const result = CreatePageRequestSchema.safeParse({
      path: 'a.md',
      agentId: 'claude-1',
      agentName: 'Claude',
    });
    expect(result.success).toBe(true);
  });
});

describe('CreatePageSuccessSchema', () => {
  test('parses a valid response', () => {
    expect(CreatePageSuccessSchema.safeParse({ docName: 'foo' }).success).toBe(true);
  });
  test('rejects missing docName', () => {
    expect(CreatePageSuccessSchema.safeParse({}).success).toBe(false);
  });
});

describe('CreateFolderRequestSchema', () => {
  test('parses a valid folder path', () => {
    const result = CreateFolderRequestSchema.safeParse({ path: 'notes/projects' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.path).toBe('notes/projects');
  });
  test('rejects empty path', () => {
    expect(CreateFolderRequestSchema.safeParse({ path: '' }).success).toBe(false);
  });
  test('rejects missing path', () => {
    expect(CreateFolderRequestSchema.safeParse({}).success).toBe(false);
  });
  test('accepts agentId + summary pass-through', () => {
    const result = CreateFolderRequestSchema.safeParse({
      path: 'notes',
      agentId: 'claude-1',
      agentName: 'Claude',
      summary: 'Create notes folder',
    });
    expect(result.success).toBe(true);
  });
});

describe('CreateFolderSuccessSchema', () => {
  test('parses a valid response', () => {
    expect(CreateFolderSuccessSchema.safeParse({ path: 'notes/projects' }).success).toBe(true);
  });
  test('rejects missing path', () => {
    expect(CreateFolderSuccessSchema.safeParse({}).success).toBe(false);
  });
});

describe('DuplicatePathRequestSchema', () => {
  test('accepts file and folder duplicate requests', () => {
    expect(DuplicatePathRequestSchema.safeParse({ kind: 'file', path: 'notes/a' }).success).toBe(
      true,
    );
    expect(DuplicatePathRequestSchema.safeParse({ kind: 'folder', path: 'notes' }).success).toBe(
      true,
    );
  });
  test('rejects unsupported kind and empty path', () => {
    expect(DuplicatePathRequestSchema.safeParse({ kind: 'asset', path: 'a.png' }).success).toBe(
      false,
    );
    expect(DuplicatePathRequestSchema.safeParse({ kind: 'file', path: '' }).success).toBe(false);
  });
});

describe('DuplicatePathSuccessSchema', () => {
  test('parses a valid response', () => {
    expect(
      DuplicatePathSuccessSchema.safeParse({
        kind: 'folder',
        path: 'notes copy',
        duplicatedDocNames: ['notes copy/a'],
      }).success,
    ).toBe(true);
  });
  test('rejects missing duplicatedDocNames', () => {
    expect(DuplicatePathSuccessSchema.safeParse({ kind: 'file', path: 'a copy' }).success).toBe(
      false,
    );
  });
});

describe('PageEntrySchema and PagesSuccessSchema', () => {
  const validPage = {
    docName: 'foo',
    title: 'Foo',
    docExt: '.md',
    size: 100,
    modified: '2026-04-30T00:00:00.000Z',
  };
  test('parses a valid page entry', () => {
    expect(PageEntrySchema.safeParse(validPage).success).toBe(true);
  });
  test('accepts empty title', () => {
    // title may be empty when extractPageTitle finds no headings; the
    // schema should not reject — the docName is the user-visible fallback.
    expect(PageEntrySchema.safeParse({ ...validPage, title: '' }).success).toBe(true);
  });
  test('rejects negative size', () => {
    expect(PageEntrySchema.safeParse({ ...validPage, size: -1 }).success).toBe(false);
  });
  test('PagesSuccessSchema parses a list', () => {
    expect(PagesSuccessSchema.safeParse({ pages: [validPage] }).success).toBe(true);
  });
  test('PagesSuccessSchema accepts empty list', () => {
    expect(PagesSuccessSchema.safeParse({ pages: [] }).success).toBe(true);
  });
  test('parses a page entry with an icon', () => {
    expect(PageEntrySchema.safeParse({ ...validPage, icon: '📝' }).success).toBe(true);
    expect(PageEntrySchema.safeParse({ ...validPage, icon: 'assets/banner.png' }).success).toBe(
      true,
    );
  });
  test('accepts a missing icon (optional)', () => {
    const { icon: _icon, ...withoutIcon } = { ...validPage, icon: '📝' };
    expect(PageEntrySchema.safeParse(withoutIcon).success).toBe(true);
  });
  test('rejects a non-string icon', () => {
    expect(PageEntrySchema.safeParse({ ...validPage, icon: 42 }).success).toBe(false);
  });
});

describe('HeadingEntrySchema and PageHeadingsSuccessSchema', () => {
  test('parses a valid heading entry', () => {
    expect(HeadingEntrySchema.safeParse({ level: 2, text: 'A', slug: 'a' }).success).toBe(true);
  });
  test('rejects level 0', () => {
    expect(HeadingEntrySchema.safeParse({ level: 0, text: 'A', slug: 'a' }).success).toBe(false);
  });
  test('rejects level 7', () => {
    expect(HeadingEntrySchema.safeParse({ level: 7, text: 'A', slug: 'a' }).success).toBe(false);
  });
  test('PageHeadingsSuccessSchema parses success', () => {
    const result = PageHeadingsSuccessSchema.safeParse({
      docName: 'foo',
      headings: [{ level: 1, text: 'Title', slug: 'title' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('RenameRewrittenDocSchema', () => {
  test('parses a valid entry', () => {
    expect(RenameRewrittenDocSchema.safeParse({ docName: 'a', rewrites: 5 }).success).toBe(true);
  });
  test('rejects negative rewrites', () => {
    expect(RenameRewrittenDocSchema.safeParse({ docName: 'a', rewrites: -1 }).success).toBe(false);
  });
});

describe('RenamePathRequestSchema', () => {
  test('parses a valid file rename', () => {
    expect(
      RenamePathRequestSchema.safeParse({ kind: 'file', fromPath: 'a.md', toPath: 'b.md' }).success,
    ).toBe(true);
  });
  test('parses a valid folder rename', () => {
    expect(
      RenamePathRequestSchema.safeParse({ kind: 'folder', fromPath: 'a', toPath: 'b' }).success,
    ).toBe(true);
  });
  test('parses a valid asset rename', () => {
    expect(
      RenamePathRequestSchema.safeParse({
        kind: 'asset',
        fromPath: 'images/a.png',
        toPath: 'assets/a.png',
      }).success,
    ).toBe(true);
  });
  test('rejects unknown kind', () => {
    expect(
      RenamePathRequestSchema.safeParse({ kind: 'symlink', fromPath: 'a', toPath: 'b' }).success,
    ).toBe(false);
  });
  test('rejects empty fromPath', () => {
    expect(
      RenamePathRequestSchema.safeParse({ kind: 'file', fromPath: '', toPath: 'b' }).success,
    ).toBe(false);
  });
});

describe('RenamePathSuccessSchema', () => {
  test('parses an empty renamed list', () => {
    expect(RenamePathSuccessSchema.safeParse({ renamed: [], renamedAssets: [] }).success).toBe(
      true,
    );
  });
  test('requires renamedAssets for response contract clarity', () => {
    expect(RenamePathSuccessSchema.safeParse({ renamed: [] }).success).toBe(false);
  });
  test('parses a populated list', () => {
    expect(
      RenamePathSuccessSchema.safeParse({
        renamed: [{ fromDocName: 'a', toDocName: 'b' }],
        renamedAssets: [],
      }).success,
    ).toBe(true);
  });
  test('parses renamed asset mappings', () => {
    expect(
      RenamePathSuccessSchema.safeParse({
        renamed: [],
        renamedAssets: [{ fromPath: 'images/a.png', toPath: 'assets/a.png' }],
        rewrittenDocs: [{ docName: 'guide', rewrites: 2 }],
      }).success,
    ).toBe(true);
  });
});

describe('DeletePathRequestSchema', () => {
  test('parses a valid file delete', () => {
    expect(DeletePathRequestSchema.safeParse({ kind: 'file', path: 'a.md' }).success).toBe(true);
  });
  test('parses a valid folder delete', () => {
    expect(DeletePathRequestSchema.safeParse({ kind: 'folder', path: 'a' }).success).toBe(true);
  });
  test('parses a valid asset delete', () => {
    expect(DeletePathRequestSchema.safeParse({ kind: 'asset', path: 'images/a.png' }).success).toBe(
      true,
    );
  });
  test('rejects unknown kind', () => {
    expect(DeletePathRequestSchema.safeParse({ kind: 'symlink', path: 'a' }).success).toBe(false);
  });
});

describe('DeletePathSuccessSchema', () => {
  test('parses success with deleted names', () => {
    expect(DeletePathSuccessSchema.safeParse({ deletedDocNames: ['a', 'b'] }).success).toBe(true);
  });
  test('parses success with empty list', () => {
    expect(DeletePathSuccessSchema.safeParse({ deletedDocNames: [] }).success).toBe(true);
  });
});

describe('TrashCleanupRequestSchema', () => {
  test('parses a valid asset cleanup', () => {
    expect(
      TrashCleanupRequestSchema.safeParse({ kind: 'asset', path: 'images/a.png' }).success,
    ).toBe(true);
  });
});

describe('RollbackRequestSchema', () => {
  const validSha = 'a'.repeat(40);
  test('parses a valid rollback', () => {
    expect(RollbackRequestSchema.safeParse({ docName: 'a', commitSha: validSha }).success).toBe(
      true,
    );
  });
  test('rejects invalid SHA', () => {
    expect(RollbackRequestSchema.safeParse({ docName: 'a', commitSha: 'not-a-sha' }).success).toBe(
      false,
    );
  });
  test('rejects short SHA', () => {
    expect(RollbackRequestSchema.safeParse({ docName: 'a', commitSha: 'abc1234' }).success).toBe(
      false,
    );
  });
  test('rejects non-string summary', () => {
    expect(
      RollbackRequestSchema.safeParse({
        docName: 'a',
        commitSha: validSha,
        summary: 42,
      }).success,
    ).toBe(false);
  });
});

describe('RollbackSuccessSchema', () => {
  test('parses a valid rollback success', () => {
    expect(
      RollbackSuccessSchema.safeParse({
        restoredFrom: 'abcdef0123456789',
        timestamp: '2026-04-30T00:00:00Z',
      }).success,
    ).toBe(true);
  });
  test('parses with optional summary', () => {
    expect(
      RollbackSuccessSchema.safeParse({
        restoredFrom: 'abc',
        timestamp: '2026-04-30T00:00:00Z',
        summary: { value: 'Restored to abc' },
      }).success,
    ).toBe(true);
  });
});

// ─── Cluster C URN tokens ───────────────────────────────────────
