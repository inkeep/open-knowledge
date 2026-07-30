/**
 * Unit tests for the unified validation audit: the validator registry fanning
 * out to the real lint walk (`auditProject`) and a real in-memory
 * `BacklinkIndex` over a temp content tree, merged into one source-tagged
 * diagnostic plane.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LINTER_CONFIG,
  type LinterConfig,
  SUPPORTED_DOC_EXTENSIONS,
  ValidationAuditCountsResponseSchema,
  ValidationAuditResponseSchema,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BacklinkIndex } from '../backlink-index.ts';
import {
  createProjectValidators,
  runValidationAudit,
  toValidationCountsPlane,
  type ValidationAuditDeps,
} from './validation-audit.ts';

let root: string;
let index: BacklinkIndex;
let admitted: Set<string>;

const lintOn: LinterConfig = {
  ...DEFAULT_LINTER_CONFIG,
  plugins: {
    ...DEFAULT_LINTER_CONFIG.plugins,
    markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true },
  },
};

// MD010 (hard tabs) is on by default; a doc with a tab produces a diagnostic.
const DOC_WITH_TAB = '# Title\n\n\tindented with a tab\n';

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-validation-audit-')));
  index = new BacklinkIndex({ projectDir: root, contentDir: root });
  admitted = new Set();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write the doc to disk AND index it — the two views production keeps in sync. */
function seedDoc(docName: string, markdown: string): void {
  const abs = join(root, `${docName}.md`);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, markdown, 'utf-8');
  index.updateDocumentFromMarkdown(docName, markdown);
  admitted.add(docName);
}

function docFilePathFor(docName: string): string | null {
  for (const ext of SUPPORTED_DOC_EXTENSIONS) {
    if (existsSync(join(root, `${docName}${ext}`))) return `${docName}${ext}`;
  }
  return null;
}

function deps(overrides: Partial<ValidationAuditDeps> = {}): ValidationAuditDeps {
  return {
    projectDir: root,
    contentDir: root,
    baseConfig: lintOn,
    derivedDocumentIndex: index,
    admittedDocNames: () => admitted,
    docFilePathFor,
    ...overrides,
  };
}

describe('runValidationAudit', () => {
  test('merges lint and link findings into one source-tagged plane', async () => {
    seedDoc('dirty', DOC_WITH_TAB);
    seedDoc('linker', '# Linker\n\nSee [[ghost]].\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    expect(result.files.map((f) => f.file)).toEqual(['dirty.md', 'linker.md']);
    const lintDiagnostics = result.files[0]?.diagnostics ?? [];
    expect(lintDiagnostics.some((d) => d.source === 'markdownlint' && d.code === 'MD010')).toBe(
      true,
    );
    expect(result.files[1]?.diagnostics).toEqual([
      {
        range: { start: { line: 2, character: 4 }, end: { line: 2, character: 4 } },
        // Default posture: broken links are warnings (validation.links).
        severity: 'warning',
        source: 'links',
        code: 'dead-link',
        message: 'Link target "ghost" does not resolve to an existing document.',
        linkTarget: 'ghost',
      },
    ]);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBeGreaterThan(1);
    expect(result.fileCount).toBe(2);
    // The engine plane must survive the wire schema untouched — the audit
    // route serializes through it.
    expect(ValidationAuditResponseSchema.parse(result)).toEqual(result);
  });

  test('a target broken from two source docs is attributed to both files', async () => {
    seedDoc('a', '# A\n\nSee [[ghost]].\n');
    seedDoc('b', '# B\n\nAlso [[ghost]].\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    expect(result.files.map((f) => f.file)).toEqual(['a.md', 'b.md']);
    for (const entry of result.files) {
      expect(entry.diagnostics).toHaveLength(1);
      expect(entry.diagnostics[0]?.source).toBe('links');
      expect(entry.diagnostics[0]?.message).toContain('"ghost"');
      expect(entry.diagnostics[0]?.linkTarget).toBe('ghost');
    }
    expect(result.warningCount).toBe(2);
  });

  test('validation.links=error raises dead links to errors; off silences them cleanly', async () => {
    seedDoc('linker', '# Linker\n\nSee [[ghost]].\n');

    const asError = await runValidationAudit(
      createProjectValidators(deps({ linksValidation: 'error' })),
    );
    expect(asError.files[0]?.diagnostics[0]?.severity).toBe('error');
    expect(asError.errorCount).toBe(1);

    const off = await runValidationAudit(createProjectValidators(deps({ linksValidation: 'off' })));
    expect(off.files.every((f) => f.diagnostics.every((d) => d.source !== 'links'))).toBe(true);
    // A deliberate off is not a degradation — no warning in the plane.
    expect(off.warnings).toEqual([]);
  });

  test('returns link findings when the project has not enabled markdownlint', async () => {
    seedDoc('dirty', DOC_WITH_TAB);
    seedDoc('linker', '# Linker\n\nSee [[ghost]].\n');

    const result = await runValidationAudit(
      createProjectValidators(deps({ baseConfig: DEFAULT_LINTER_CONFIG })),
    );

    expect(result.files.map((f) => f.file)).toEqual(['linker.md']);
    expect(result.files[0]?.diagnostics.map((d) => d.source)).toEqual(['links']);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(1);
    expect(result.fileCount).toBe(2);
  });

  test('a doc with lint and link problems yields one file entry sorted by position', async () => {
    seedDoc('both', '# Both\n\n\tindented with a tab\n\nSee [[ghost]].\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    expect(result.files.map((f) => f.file)).toEqual(['both.md']);
    const diagnostics = result.files[0]?.diagnostics ?? [];
    const tabIndex = diagnostics.findIndex((d) => d.code === 'MD010');
    const linkIndex = diagnostics.findIndex((d) => d.code === 'dead-link');
    expect(tabIndex).toBeGreaterThanOrEqual(0);
    expect(linkIndex).toBeGreaterThanOrEqual(0);
    expect(diagnostics[tabIndex]?.range.start.line).toBe(2);
    expect(diagnostics[linkIndex]?.range.start.line).toBe(4);
    expect(tabIndex).toBeLessThan(linkIndex);
  });

  test('a folder scope restricts both validators to docs under it', async () => {
    seedDoc('top', '# Top\n\nSee [[ghost]].\n');
    seedDoc('sub/inner', '# Inner\n\n\tindented with a tab\n\nSee [[ghost2]].\n');

    const result = await runValidationAudit(createProjectValidators(deps()), {
      targetPath: 'sub',
    });

    expect(result.files.map((f) => f.file)).toEqual(['sub/inner.md']);
    const codes = result.files[0]?.diagnostics.map((d) => d.code) ?? [];
    expect(codes).toContain('MD010');
    expect(codes).toContain('dead-link');
    const messages = result.files.flatMap((f) => f.diagnostics.map((d) => d.message));
    expect(messages.some((m) => m.includes('"ghost"'))).toBe(false);
    expect(result.fileCount).toBe(1);
  });

  test('a doc-file scope returns exactly the whole-project findings for that doc', async () => {
    seedDoc('dirty', DOC_WITH_TAB);
    seedDoc('linker', '# Linker\n\nSee [[ghost]].\n');
    const validators = createProjectValidators(deps());

    const whole = await runValidationAudit(validators);
    const scoped = await runValidationAudit(validators, { targetPath: 'linker.md' });

    expect(scoped.files).toEqual([
      whole.files.find((f) => f.file === 'linker.md') ?? { file: 'missing', diagnostics: [] },
    ]);
    expect(scoped.fileCount).toBe(1);
    expect(scoped.warningCount).toBe(1);
  });

  test('a scope matching no docs returns no findings even when dead links exist elsewhere', async () => {
    seedDoc('linker', '# Linker\n\nSee [[ghost]].\n');

    const result = await runValidationAudit(createProjectValidators(deps()), {
      targetPath: 'empty',
    });

    expect(result.files).toEqual([]);
    expect(result.errorCount).toBe(0);
  });

  test('degrades to lint-only with a warning when no backlink index is configured', async () => {
    seedDoc('dirty', DOC_WITH_TAB);
    seedDoc('linker', '# Linker\n\nSee [[ghost]].\n');

    const result = await runValidationAudit(
      createProjectValidators(deps({ derivedDocumentIndex: null })),
    );

    expect(result.files.map((f) => f.file)).toEqual(['dirty.md']);
    expect(result.errorCount).toBe(0);
    expect(result.warnings).toContain(
      'links validation unavailable: backlink index is not configured',
    );
  });

  test('an additional registered validator merges into the plane', async () => {
    seedDoc('dirty', DOC_WITH_TAB);
    const extra = {
      id: 'extra',
      run: async () => ({
        files: [
          {
            file: 'dirty.md',
            diagnostics: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                severity: 'error' as const,
                source: 'links' as const,
                code: 'extra-rule',
                message: 'extra finding',
              },
            ],
          },
        ],
        fileCount: 0,
        warnings: ['extra warning'],
      }),
    };

    const result = await runValidationAudit([...createProjectValidators(deps()), extra]);

    expect(result.files.map((f) => f.file)).toEqual(['dirty.md']);
    const codes = result.files[0]?.diagnostics.map((d) => d.code) ?? [];
    expect(codes).toContain('MD010');
    expect(codes).toContain('extra-rule');
    expect(result.warnings).toContain('extra warning');
  });

  test('a clean, fully-linked project audits clean', async () => {
    seedDoc('a', '# A\n\nSee [[b]].\n');
    seedDoc('b', '# B\n\nBack to [[a]].\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    expect(result.files).toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.fileCount).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  test('a validator that throws degrades to a warning without discarding the others', async () => {
    seedDoc('dirty', DOC_WITH_TAB);
    const boom = {
      id: 'boom',
      run: async () => {
        throw new Error('kaboom');
      },
    };

    const result = await runValidationAudit([...createProjectValidators(deps()), boom]);

    // The lint validator's results survive the sibling validator's throw.
    expect(result.files.map((f) => f.file)).toEqual(['dirty.md']);
    expect(result.files[0]?.diagnostics.some((d) => d.code === 'MD010')).toBe(true);
    // The throw becomes a validator-tagged warning, not an unhandled rejection.
    expect(result.warnings).toContain('validator "boom" failed: kaboom');
  });

  test('a dead link from an admitted-but-unsaved source still names a file', async () => {
    // Admitted in the index but not on disk yet: docFilePathFor returns null, so
    // the finding falls back to the default extension rather than emitting null.
    const fakeIndex: Pick<BacklinkIndex, 'getDeadLinks'> = {
      getDeadLinks: () => [
        {
          target: 'ghost',
          sources: [{ source: 'unsaved', anchor: null, snippet: null, line: 3, column: 2 }],
        },
      ],
    };

    const result = await runValidationAudit(
      createProjectValidators(
        deps({
          derivedDocumentIndex: fakeIndex,
          admittedDocNames: () => ['unsaved'],
          docFilePathFor: () => null,
        }),
      ),
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.file).toBe('unsaved.md');
    expect(result.files[0]?.diagnostics[0]?.range.start).toEqual({ line: 3, character: 2 });
    // A malformed finding (file: null) would fail the wire schema and 500 the route.
    expect(ValidationAuditResponseSchema.parse(result)).toEqual(result);
  });

  test('a dead link from a pre-position cache degrades to the start of the doc', async () => {
    // Entries deserialized from a cache written before positions were indexed
    // carry no line/column; the finding degrades to the doc start, not undefined.
    const fakeIndex: Pick<BacklinkIndex, 'getDeadLinks'> = {
      getDeadLinks: () => [
        { target: 'ghost', sources: [{ source: 'legacy', anchor: null, snippet: null }] },
      ],
    };

    const result = await runValidationAudit(
      createProjectValidators(
        deps({
          derivedDocumentIndex: fakeIndex,
          admittedDocNames: () => ['legacy'],
          docFilePathFor: () => 'legacy.md',
        }),
      ),
    );

    expect(result.files[0]?.file).toBe('legacy.md');
    expect(result.files[0]?.diagnostics[0]?.range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });
    // An undefined position would fail the wire schema and 500 the route.
    expect(ValidationAuditResponseSchema.parse(result)).toEqual(result);
  });
});

describe('toValidationCountsPlane', () => {
  test('tallies the merged plane per file and per source, dropping the bodies', async () => {
    // One doc carrying BOTH a lint finding and a dead link, so the split is
    // observable rather than inferred.
    seedDoc('a', '# A\n\n\tTab line.\n\nSee [[ghost]].\n');
    seedDoc('b', '# B\n\n\tTab line.\n');
    const result = await runValidationAudit(createProjectValidators(deps()));
    const counts = toValidationCountsPlane(result);

    expect(ValidationAuditCountsResponseSchema.safeParse(counts).success).toBe(true);
    const a = counts.files.find((f) => f.file === 'a.md');
    expect(a?.links).toEqual({ errorCount: 0, warningCount: 1 });
    expect(a?.lint.warningCount).toBeGreaterThan(0);
    expect(a?.lint.errorCount).toBe(0);

    // Rollups and the file set carry over from the enumerated plane verbatim.
    expect(counts.files.map((f) => f.file)).toEqual(result.files.map((f) => f.file));
    expect(counts.fileCount).toBe(result.fileCount);
    expect(counts.errorCount).toBe(result.errorCount);
    expect(counts.warningCount).toBe(result.warningCount);
    expect(counts.warnings).toEqual(result.warnings);
  });

  test('per-file tallies sum to the plane rollups', async () => {
    seedDoc('a', '# A\n\n\tTab.\n\nSee [[ghost]] and [[phantom]].\n');
    seedDoc('b', '# B\n\n\tTab.\n');
    const result = await runValidationAudit(createProjectValidators(deps()));
    const counts = toValidationCountsPlane(result);

    const errors = counts.files.reduce((n, f) => n + f.lint.errorCount + f.links.errorCount, 0);
    const warnings = counts.files.reduce(
      (n, f) => n + f.lint.warningCount + f.links.warningCount,
      0,
    );
    expect(errors).toBe(result.errorCount);
    expect(warnings).toBe(result.warningCount);
  });

  test('an empty plane tallies to an empty plane', () => {
    expect(
      toValidationCountsPlane({
        files: [],
        fileCount: 7,
        errorCount: 0,
        warningCount: 0,
        warnings: ['a config warning'],
      }),
    ).toEqual({
      files: [],
      fileCount: 7,
      errorCount: 0,
      warningCount: 0,
      warnings: ['a config warning'],
    });
  });
});
