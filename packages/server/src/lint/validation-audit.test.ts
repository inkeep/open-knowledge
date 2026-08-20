/**
 * Unit tests for the unified validation audit: the validator registry fanning
 * out to the real lint walk (`auditProject`) and a real in-memory
 * `BacklinkIndex` and `LocalTargetIndex` over a temp content tree, merged into
 * one source-tagged diagnostic plane.
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
import { LocalTargetIndex } from '../local-target-index.ts';
import {
  createProjectValidators,
  runValidationAudit,
  toValidationCountsPlane,
  type ValidationAuditDeps,
} from './validation-audit.ts';

let root: string;
let index: BacklinkIndex;
let localTargets: LocalTargetIndex;
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
  localTargets = new LocalTargetIndex({ contentDir: root });
  admitted = new Set();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Write the doc to disk AND index it into both derived indexes — the three views
 * production keeps in sync (disk for the lint walk, the graph for wiki/inline-md
 * document dead-links, the local-target index for file/image/reference targets).
 */
function seedDoc(docName: string, markdown: string): void {
  const abs = join(root, `${docName}.md`);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, markdown, 'utf-8');
  index.updateDocumentFromMarkdown(docName, markdown);
  localTargets.setSource(docName, markdown);
  admitted.add(docName);
}

/**
 * Mark an ordinary-file target as present in the local-target inventory — what
 * the watcher's all-files snapshot does in production. Order-independent: the
 * index reassesses any source already pointing at this path.
 */
function seedFile(contentRootRelativePath: string): void {
  localTargets.setFileTarget(contentRootRelativePath, true);
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
    // The reader composes the two real derived indexes the way
    // DerivedDocumentIndex does — the graph for document dead-links, the
    // local-target index for file/image/reference targets — so the projection
    // is tested against real assessment data, not a stand-in.
    derivedDocumentIndex: {
      getDeadLinks: (a, s) => index.getDeadLinks(a, s),
      getLocalTargetAssessmentsForSources: (s) => localTargets.getAssessmentsForSources(s),
    },
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
    const fakeIndex = {
      getDeadLinks: () => [
        {
          target: 'ghost',
          sources: [{ source: 'unsaved', anchor: null, snippet: null, line: 3, column: 2 }],
        },
      ],
      getLocalTargetAssessmentsForSources: () => [],
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
    const fakeIndex = {
      getDeadLinks: () => [
        { target: 'ghost', sources: [{ source: 'legacy', anchor: null, snippet: null }] },
      ],
      getLocalTargetAssessmentsForSources: () => [],
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

  test('graph findings survive when the local-target index is unavailable', async () => {
    const fakeIndex = {
      getDeadLinks: () => [
        {
          target: 'ghost',
          sources: [{ source: 'source', anchor: null, snippet: null, line: 1, column: 2 }],
        },
      ],
      getLocalTargetAssessmentsForSources: () => {
        throw new Error('Local-target index is not ready');
      },
    };

    const result = await runValidationAudit(
      createProjectValidators(
        deps({
          derivedDocumentIndex: fakeIndex,
          admittedDocNames: () => ['source'],
          docFilePathFor: () => 'source.md',
        }),
      ),
    );

    expect(result.files[0]?.diagnostics).toEqual([
      expect.objectContaining({ code: 'dead-link', linkTarget: 'ghost' }),
    ]);
    expect(result.warnings).toContain(
      'local-target validation unavailable: Local-target index is not ready',
    );
  });
});

describe('local-target findings (files, images, reference-style)', () => {
  test('a missing ordinary-file link is a positioned finding with file evidence and no create affordance', async () => {
    seedDoc('doc', '# Doc\n\n[report](./report.pdf)\n');
    // report.pdf is never seeded — the file does not exist.

    const result = await runValidationAudit(createProjectValidators(deps()));

    expect(result.files.map((f) => f.file)).toEqual(['doc.md']);
    const diagnostics = result.files[0]?.diagnostics ?? [];
    expect(diagnostics).toHaveLength(1);
    const d = diagnostics[0];
    expect(d?.source).toBe('links');
    expect(d?.code).toBe('dead-link');
    expect(d?.severity).toBe('warning');
    expect(d?.message).toBe('Link target "report.pdf" does not resolve to an existing file.');
    // Files never offer Create page.
    expect(d?.linkTarget).toBeUndefined();
    expect(d?.localTarget).toEqual({
      href: './report.pdf',
      targetKind: 'file',
      role: 'link',
      sourceForm: 'markdown-inline',
      resolvedTarget: 'report.pdf',
      reason: 'no-such-file',
      resolutionMethod: 'source-relative',
    });
    expect(d?.range.start).toEqual({ line: 2, character: 0 });
    // New evidence survives the wire schema round trip untouched.
    expect(ValidationAuditResponseSchema.parse(result)).toEqual(result);
  });

  test('a missing markdown image reports the image with a not-found message', async () => {
    seedDoc('doc', '# Doc\n\n![logo](./logo.png)\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    const d = result.files[0]?.diagnostics[0];
    expect(d?.message).toBe('Image target "logo.png" does not resolve to an existing file.');
    expect(d?.linkTarget).toBeUndefined();
    expect(d?.localTarget?.role).toBe('image');
    expect(d?.localTarget?.targetKind).toBe('file');
    expect(d?.localTarget?.sourceForm).toBe('markdown-inline');
    expect(d?.localTarget?.reason).toBe('no-such-file');
  });

  test('a bare HTML img with a missing source reports as an html-img image finding', async () => {
    seedDoc('doc', '# Doc\n\n<img src="./banner.png">\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    const d = result.files[0]?.diagnostics[0];
    expect(d?.message).toBe('Image target "banner.png" does not resolve to an existing file.');
    expect(d?.localTarget?.role).toBe('image');
    expect(d?.localTarget?.sourceForm).toBe('html-img');
    expect(d?.localTarget?.reason).toBe('no-such-file');
    expect(ValidationAuditResponseSchema.parse(result)).toEqual(result);
  });

  test('an existing file target produces no finding', async () => {
    seedDoc('doc', '# Doc\n\n[report](./report.pdf)\n');
    seedFile('report.pdf');

    const result = await runValidationAudit(createProjectValidators(deps()));

    expect(result.files).toEqual([]);
    expect(result.warningCount).toBe(0);
  });

  test('an exact file link does not suppress a same-target missing wiki document', async () => {
    seedDoc('doc', '# Doc\n\n[file](assets/NOTICE) and [[assets/NOTICE]]\n');
    seedFile('assets/NOTICE');

    const result = await runValidationAudit(createProjectValidators(deps()));

    const diagnostics = result.files.find((file) => file.file === 'doc.md')?.diagnostics ?? [];
    expect(diagnostics).toEqual([
      expect.objectContaining({
        source: 'links',
        code: 'dead-link',
        message: 'Link target "assets/NOTICE" does not resolve to an existing document.',
        linkTarget: 'assets/NOTICE',
      }),
    ]);
    expect(diagnostics[0]?.localTarget).toBeUndefined();
  });

  test('a missing markdown document link does not suppress a same-target wiki occurrence', async () => {
    seedDoc('doc', '# Doc\n\n[markdown](ghost) and [[ghost]]\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    const diagnostics = result.files.find((file) => file.file === 'doc.md')?.diagnostics ?? [];
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.filter((diagnostic) => diagnostic.linkTarget === 'ghost')).toHaveLength(2);
    expect(diagnostics.filter((diagnostic) => diagnostic.localTarget !== undefined)).toHaveLength(
      1,
    );
  });

  test('every reference-style use is positioned and points at the shared definition', async () => {
    seedDoc('doc', '# Doc\n\n[one][r] and [two][r]\n\n[r]: ./missing.pdf\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    const diagnostics = result.files[0]?.diagnostics ?? [];
    expect(diagnostics).toHaveLength(2);
    for (const d of diagnostics) {
      expect(d.localTarget?.sourceForm).toBe('markdown-reference');
      expect(d.localTarget?.targetKind).toBe('file');
      expect(d.localTarget?.reason).toBe('no-such-file');
      // All uses of one label share one repair location: the definition line.
      expect(d.localTarget?.definition).toEqual({ line: 4, label: 'r' });
      expect(d.linkTarget).toBeUndefined();
    }
    // The two uses are positioned independently, not collapsed to one.
    expect(diagnostics.map((d) => d.range.start.character)).toEqual([0, 13]);
  });

  test('a reference-style link to a missing document keeps the Create-page affordance', async () => {
    seedDoc('doc', '# Doc\n\n[it][d]\n\n[d]: ./ghost-doc\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    const d = result.files[0]?.diagnostics[0];
    // The graph does not extract reference-style links, so this is the only
    // finding — and a missing document, unlike a file, is create-eligible.
    expect(result.files[0]?.diagnostics).toHaveLength(1);
    expect(d?.linkTarget).toBe('ghost-doc');
    expect(d?.localTarget?.targetKind).toBe('document');
    expect(d?.localTarget?.definition).toEqual({ line: 4, label: 'd' });
    expect(d?.message).toBe('Link target "ghost-doc" does not resolve to an existing document.');
  });

  test('a tolerant document fallback stays a finding but never offers Create page', async () => {
    seedDoc('Guide', '# Guide\n');
    seedDoc('doc', '# Doc\n\n[it][d]\n\n[d]: guide\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    const d = result.files.find((file) => file.file === 'doc.md')?.diagnostics[0];
    expect(d?.localTarget).toMatchObject({
      targetKind: 'document',
      resolvedTarget: 'guide',
      reason: 'no-such-doc',
      resolutionMethod: 'tolerant',
      fallbackTarget: 'Guide',
    });
    expect(d?.linkTarget).toBeUndefined();
  });

  test('an inline-markdown document link is reported once, by the canonical classifier', async () => {
    seedDoc('doc', '# Doc\n\n[other](./ghost-doc)\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    // Both planes see this occurrence, and exactly one finding reaches the
    // panel. The surviving row is the assessment plane's: it carries the same
    // create-page `linkTarget` the graph row did, plus the canonical evidence
    // the graph cannot produce.
    const diagnostics = result.files[0]?.diagnostics ?? [];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.linkTarget).toBe('ghost-doc');
    expect(diagnostics[0]?.localTarget).toMatchObject({
      targetKind: 'document',
      resolvedTarget: 'ghost-doc',
      reason: 'no-such-doc',
    });
  });

  test('a root-escaping file target is reported as unresolvable without a resolved target', async () => {
    seedDoc('doc', '# Doc\n\n[x](../../../secrets.pdf)\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    const d = result.files[0]?.diagnostics[0];
    expect(d?.localTarget?.reason).toBe('unresolvable');
    expect(d?.localTarget?.resolvedTarget).toBeNull();
    expect(d?.localTarget?.resolutionMethod).toBe('none');
    expect(d?.linkTarget).toBeUndefined();
    expect(d?.message).toBe(
      'Link target "../../../secrets.pdf" could not be resolved to a project-local target.',
    );
  });

  test('validation.links=off silences file findings; =error raises them uniformly with dead links', async () => {
    seedDoc('doc', '# Doc\n\n[report](./report.pdf)\n');

    const off = await runValidationAudit(createProjectValidators(deps({ linksValidation: 'off' })));
    expect(off.files).toEqual([]);
    expect(off.warnings).toEqual([]);

    const asError = await runValidationAudit(
      createProjectValidators(deps({ linksValidation: 'error' })),
    );
    expect(asError.files[0]?.diagnostics[0]?.severity).toBe('error');
    expect(asError.errorCount).toBe(1);
  });

  test('a folder scope restricts file findings to sources under it', async () => {
    seedDoc('top', '# Top\n\n[a](./top-file.pdf)\n');
    seedDoc('sub/inner', '# Inner\n\n[b](./inner-file.pdf)\n');

    const result = await runValidationAudit(createProjectValidators(deps()), { targetPath: 'sub' });

    expect(result.files.map((f) => f.file)).toEqual(['sub/inner.md']);
    expect(result.files[0]?.diagnostics[0]?.localTarget?.resolvedTarget).toBe('sub/inner-file.pdf');
  });

  test('a legacy validation payload with no localTarget field still parses', () => {
    // A finding written before this field existed must remain valid on the wire.
    const legacy = {
      files: [
        {
          file: 'doc.md',
          diagnostics: [
            {
              range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
              severity: 'warning',
              source: 'links',
              code: 'dead-link',
              message: 'Link target "ghost" does not resolve to an existing document.',
              linkTarget: 'ghost',
            },
          ],
        },
      ],
      fileCount: 1,
      errorCount: 0,
      warningCount: 1,
      warnings: [],
    };
    expect(ValidationAuditResponseSchema.parse(legacy)).toEqual(legacy);
  });
});

describe('the OKF project validator', () => {
  /** OKF on, everything else off, so the plane carries only project findings. */
  const okfOnly: LinterConfig = {
    ...DEFAULT_LINTER_CONFIG,
    plugins: {
      ...DEFAULT_LINTER_CONFIG.plugins,
      markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: false },
      okf: { enabled: true },
    },
  } as LinterConfig;

  /** Write a file without indexing it — these checks judge the tree, not link graph. */
  function writeFile(rel: string, body = '---\ntype: Note\n---\n\nBody.\n'): void {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
  }

  const auditOkf = async (overrides: Partial<ValidationAuditDeps> = {}) =>
    runValidationAudit(
      createProjectValidators(deps({ baseConfig: okfOnly, linksValidation: 'off', ...overrides })),
    );

  test('a mis-cased reserved file reaches the plane under the okf source', async () => {
    writeFile('Index.md', '# Index\n\n* [a](a.md) - a\n');
    const result = await auditOkf();
    const row = result.files.find((f) => f.file === 'Index.md');
    expect(row?.diagnostics.map((d) => d.code)).toContain('reserved-casing');
    expect(row?.diagnostics.every((d) => d.source === 'okf')).toBe(true);
  });

  test('a DOC-SCOPED audit still reports — the shape the Problems panel asks for', async () => {
    // The panel scopes to the open document, which resolves to a FILE path. Handing that
    // to the tree walk as a directory made `readdir` throw and the validator return
    // nothing, so every project finding was invisible in the panel while the
    // whole-project tests stayed green.
    writeFile('guide.md');
    writeFile('guide.mdx');
    const scoped = await runValidationAudit(
      createProjectValidators(deps({ baseConfig: okfOnly, linksValidation: 'off' })),
      { targetPath: 'guide.mdx' },
    );
    expect(scoped.files.flatMap((f) => f.diagnostics).map((d) => d.code)).toEqual([
      'project-no-mdx',
    ]);
    expect(scoped.warnings).toEqual([]);
  });

  test('a doc-scoped audit keeps its sibling context', async () => {
    // Scoping to one file still walks its directory, so a shadowed .mdx is still known
    // to be shadowed. Linting the file alone would silently downgrade the message.
    writeFile('guide.md');
    writeFile('guide.mdx');
    const scoped = await runValidationAudit(
      createProjectValidators(deps({ baseConfig: okfOnly, linksValidation: 'off' })),
      { targetPath: 'guide.mdx' },
    );
    const message = scoped.files.flatMap((f) => f.diagnostics)[0]?.message ?? '';
    expect(message).toContain("won't be picked up");
    expect(message).toContain('shadowed by');
  });

  test('a doc-scoped audit reports only that document', async () => {
    writeFile('one.mdx');
    writeFile('two.mdx');
    const scoped = await runValidationAudit(
      createProjectValidators(deps({ baseConfig: okfOnly, linksValidation: 'off' })),
      { targetPath: 'one.mdx' },
    );
    expect(scoped.files.map((f) => f.file)).toEqual(['one.mdx']);
  });

  test('an .mdx beside its .md is flagged, and the .md is not', async () => {
    writeFile('guide.md');
    writeFile('guide.mdx');
    const result = await auditOkf();
    expect(result.files.find((f) => f.file === 'guide.mdx')?.diagnostics[0]?.code).toBe(
      'project-no-mdx',
    );
    expect(result.files.find((f) => f.file === 'guide.md')).toBeUndefined();
  });

  test('a clean project produces no okf findings', async () => {
    writeFile('index.md', '# Index\n\n* [a](a.md) - a\n');
    writeFile('a.md');
    const result = await auditOkf();
    const okf = result.files.flatMap((f) => f.diagnostics).filter((d) => d.source === 'okf');
    expect(okf).toEqual([]);
  });

  test('the plugin switched off is a clean empty contribution, not a warning', async () => {
    writeFile('Index.md');
    const off = {
      ...okfOnly,
      plugins: { ...okfOnly.plugins, okf: { enabled: false } },
    } as LinterConfig;
    const result = await auditOkf({ baseConfig: off });
    expect(result.files.flatMap((f) => f.diagnostics)).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('a single rule can be switched off without silencing its siblings', async () => {
    // The two now run in different validators — casing per document, .mdx over the tree —
    // and one toggle map governs both.
    writeFile('Index.md');
    writeFile('guide.mdx');
    const oneOff = {
      ...okfOnly,
      plugins: {
        ...okfOnly.plugins,
        okf: { enabled: true, rules: { 'reserved-casing': false } },
      },
    } as LinterConfig;
    const result = await auditOkf({ baseConfig: oneOff });
    const codes = result.files.flatMap((f) => f.diagnostics).map((d) => d.code);
    expect(codes).toContain('project-no-mdx');
    expect(codes).not.toContain('reserved-casing');
  });

  test('a scoped audit sees only its subtree', async () => {
    // Honest limitation, pinned rather than papered over: scoping narrows the walk, so
    // a violation outside the scope reports nothing. A reader scoping an audit should
    // not read that silence as a clean project.
    writeFile('Index.md');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFile('sub/keeper.md');

    const whole = await auditOkf();
    expect(whole.files.flatMap((f) => f.diagnostics).map((d) => d.code)).toContain(
      'reserved-casing',
    );

    const scoped = await runValidationAudit(
      createProjectValidators(deps({ baseConfig: okfOnly, linksValidation: 'off' })),
      { targetPath: 'sub' },
    );
    expect(scoped.files.flatMap((f) => f.diagnostics)).toEqual([]);
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

describe('skill-bundle doc scoping', () => {
  // The gate's contract — what it covers and its recorded boundaries — is
  // `isProblemsPlaneExcludedDoc`'s JSDoc (`cc1-broadcast.ts`), with the closed
  // name table in `cc1-broadcast.test.ts`. These tests pin the shapes end to
  // end through the validator: bundles under a skills root (`scripts/**`
  // included) and the managed aliases, plus the boundaries — source-keyed only,
  // doc scope included, raw graph view un-gated, and both a visible-path skills
  // root and a dot-dir doc outside any skills root still reported.

  const LIVE_SKILL_MD =
    '# Live skill\n\nSee [[live-skill-ghost]] and [artifact](artifacts/output.md).\n';

  /**
   * Index a live skill doc (`__skill__/global/...` managed artifact or
   * `__extskill__/...` editable-unmanaged external): live-indexed, never on
   * disk at a content-root path.
   *
   * The markdown link in the seeded body is load-bearing, not redundant with
   * the wiki link: `BacklinkIndex` registers these docs node-only and never
   * ingests their body links, so the graph plane carries nothing for them and
   * the local-target plane is the only one that can produce a finding.
   */
  function seedLiveSkillDoc(docName: string): void {
    index.updateDocumentFromMarkdown(docName, LIVE_SKILL_MD);
    localTargets.setSource(docName, LIVE_SKILL_MD);
    admitted.add(docName);
  }

  test('project skill bundle docs project no findings into the plane', async () => {
    seedDoc('control', '# Control\n\nSee [[ghost]].\n');
    // Both link forms the validator projects: a wiki dead link (graph plane)
    // and a relative markdown link to an absent file (local-target plane).
    seedDoc(
      '.claude/skills/record-a-decision/SKILL',
      '# Record a decision\n\nSee [[skill-ghost]] and [artifact](decisions/0007-use-rest-api.md).\n',
    );
    seedDoc(
      '.claude/skills/record-a-decision/references/patterns',
      '# Patterns\n\nSee [[skill-ref-ghost]].\n',
    );

    const result = await runValidationAudit(createProjectValidators(deps()));

    // Control: the ordinary doc's dead link survives the gate. The exact file
    // set additionally catches an over-broad predicate reaching other docs.
    const control = result.files.find((f) => f.file === 'control.md');
    expect(control?.diagnostics.some((d) => d.code === 'dead-link')).toBe(true);

    expect(result.files.map((f) => f.file)).toEqual(['control.md']);
  });

  test('global skill bundle docs project no findings into the plane', async () => {
    seedDoc('control', '# Control\n\nSee [[ghost]].\n');
    seedLiveSkillDoc('__skill__/global/record-a-decision');
    seedLiveSkillDoc('__skill__/global/record-a-decision/references/patterns');

    // Positive control. The graph plane cannot carry these: `BacklinkIndex`
    // registers global skill bundle docs node-only and never ingests their body
    // links, so the wiki link contributes no edge and only the local-target
    // plane can produce a finding here. Prove it holds one, or the emptiness
    // assertion below would pass against a source that never had anything.
    const assessed = await localTargets.getAssessmentsForSources([
      '__skill__/global/record-a-decision',
    ]);
    expect(
      assessed.some(({ assessments }) => assessments.some((a) => a.status === 'missing')),
    ).toBe(true);

    const result = await runValidationAudit(createProjectValidators(deps()));

    const control = result.files.find((f) => f.file === 'control.md');
    expect(control?.diagnostics.some((d) => d.code === 'dead-link')).toBe(true);

    expect(result.files.map((f) => f.file)).toEqual(['control.md']);
  });

  test('project skill bundle scripts docs project no findings into the plane', async () => {
    seedDoc('control', '# Control\n\nSee [[ghost]].\n');
    // `scripts/**` members are not graph nodes, so a predicate keyed on the
    // SKILL/references doc shapes would miss them. The gate matches the whole
    // bundle dir under the skills root, so they are covered.
    seedDoc(
      '.claude/skills/record-a-decision/scripts/notes',
      '# Notes\n\nSee [[skill-script-ghost]] and [artifact](fixtures/sample-output.md).\n',
    );

    const result = await runValidationAudit(createProjectValidators(deps()));

    const control = result.files.find((f) => f.file === 'control.md');
    expect(control?.diagnostics.some((d) => d.code === 'dead-link')).toBe(true);

    expect(result.files.map((f) => f.file)).toEqual(['control.md']);
  });

  test('external skill live docs project no findings into the plane', async () => {
    seedDoc('control', '# Control\n\nSee [[ghost]].\n');
    seedLiveSkillDoc('__extskill__/record-a-decision');
    seedLiveSkillDoc('__extskill__/record-a-decision/references/patterns');

    // Positive control, as in the global-skill case above: prove the plane that
    // can carry a finding for this shape actually holds one.
    const assessed = await localTargets.getAssessmentsForSources([
      '__extskill__/record-a-decision',
    ]);
    expect(
      assessed.some(({ assessments }) => assessments.some((a) => a.status === 'missing')),
    ).toBe(true);

    const result = await runValidationAudit(createProjectValidators(deps()));

    const control = result.files.find((f) => f.file === 'control.md');
    expect(control?.diagnostics.some((d) => d.code === 'dead-link')).toBe(true);

    expect(result.files.map((f) => f.file)).toEqual(['control.md']);
  });

  test('doc-scoped audit of a skill bundle file also answers empty', async () => {
    seedDoc('control', '# Control\n\nSee [[ghost]].\n');
    seedDoc(
      '.claude/skills/record-a-decision/SKILL',
      '# Record a decision\n\nSee [[skill-ghost]] and [artifact](decisions/0007-use-rest-api.md).\n',
    );

    // The exclusion is total across scopes: the open doc's Problems tab and
    // the source-mode link diagnostics ride this same doc-scoped request, so
    // scoping to the file itself must not reintroduce what the project scope
    // withholds.
    const result = await runValidationAudit(createProjectValidators(deps()), {
      targetPath: '.claude/skills/record-a-decision/SKILL.md',
    });

    expect(result.files).toEqual([]);
  });

  test('folder templates keep their link findings', async () => {
    // Templates sit under `.ok/` but are not a skill bundle, so the gate never
    // reaches them. Pinned through the projection loops, not just the
    // predicate: an inverted `continue` guard would suppress them while the
    // name-level unit test stayed green. A broken link here is copied into
    // every doc created from the template.
    seedDoc('control', '# Control\n\nSee [[ghost]].\n');
    seedDoc('.ok/templates/daily', '# Daily\n\nSee [[template-ghost]].\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    const template = result.files.find((f) => f.file === '.ok/templates/daily.md');
    expect(template?.diagnostics.some((d) => d.code === 'dead-link')).toBe(true);
  });

  test('a dot-dir doc outside any skills root keeps its link findings', async () => {
    // The gate is scoped to the skills root, not the host dotdir. Prose like
    // `.github/CI_RUNBOOK` is admitted content whose broken links are real
    // defects, so it stays in the plane. Note the lint walk skips it on its own
    // axis, so this doc gets link findings but no markdownlint rows.
    seedDoc('control', '# Control\n\nSee [[ghost]].\n');
    seedDoc('.github/CI_RUNBOOK', '# Runbook\n\nSee [[runbook-ghost]].\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    const runbook = result.files.find((f) => f.file === '.github/CI_RUNBOOK.md');
    expect(runbook?.diagnostics.some((d) => d.code === 'dead-link')).toBe(true);
    const control = result.files.find((f) => f.file === 'control.md');
    expect(control?.diagnostics.some((d) => d.code === 'dead-link')).toBe(true);
  });

  test('a skill bundle at a visible custom root stays in the plane', async () => {
    // A custom skill root need not be dot-rooted. Such bundles are addressable
    // and read as ordinary content on every sibling axis (file-tree rows,
    // hidden-doc classification), so the plane keeps their findings — the rule
    // holding at its boundary, not an uncovered case.
    seedDoc('team/skills/record-a-decision/SKILL', '# Custom root\n\nSee [[custom-root-ghost]].\n');

    const result = await runValidationAudit(createProjectValidators(deps()));

    const skill = result.files.find((f) => f.file === 'team/skills/record-a-decision/SKILL.md');
    expect(skill?.diagnostics.some((d) => d.code === 'dead-link')).toBe(true);
  });

  test('dead links from an ordinary doc INTO a skill bundle are still reported', async () => {
    // The gate keys on the SOURCE doc. A user-authored doc whose broken link
    // NAMES a skill path is an ordinary finding and must survive — common
    // right after a skill is renamed or uninstalled.
    seedDoc(
      'control',
      '# Control\n\nWiki: [[.claude/skills/absent/SKILL]]\n\nMd: [skill](.claude/skills/absent/SKILL.md)\n',
    );

    const result = await runValidationAudit(createProjectValidators(deps()));

    const control = result.files.find((f) => f.file === 'control.md');
    expect(control?.diagnostics.filter((d) => d.code === 'dead-link').length).toBeGreaterThan(0);
  });

  test('the raw graph dead-links view keeps skill-bundle sources the plane suppresses', async () => {
    seedDoc(
      '.claude/skills/record-a-decision/SKILL',
      '# Record a decision\n\nSee [[skill-ghost]].\n',
    );

    // The gate lives at the validator's projection point, not in the index:
    // `GET /api/dead-links` / MCP `links({ kind: "dead" })` stay the raw graph
    // view over every indexed edge, hidden sources included.
    const raw = await index.getDeadLinks([...admitted]);
    expect(
      raw.some(({ sources }) =>
        sources.some((o) => o.source === '.claude/skills/record-a-decision/SKILL'),
      ),
    ).toBe(true);

    const plane = await runValidationAudit(createProjectValidators(deps()));
    expect(plane.files).toEqual([]);
  });
});
