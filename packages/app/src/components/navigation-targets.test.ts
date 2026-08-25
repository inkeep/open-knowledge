import { DOCUMENT_OPEN_BYTE_LIMIT } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  deriveKnownFolderPaths,
  docNameForNavigationTarget,
  downgradeFolderIndexForHashNav,
  largeFileNavigationTarget,
  okContentNavigationTarget,
  resolveNavigationTarget,
  withLargeFileOpenGuard,
} from './navigation-targets';

describe('deriveKnownFolderPaths', () => {
  test('derives ancestor folders from admitted doc names', () => {
    const folderPaths = deriveKnownFolderPaths(new Set(['docs/index', 'reports/q1/REPORT']));

    expect(folderPaths).toEqual(new Set(['docs', 'reports', 'reports/q1']));
  });
});

describe('resolveNavigationTarget', () => {
  test('resolves managed-artifact docs as real doc targets (never missing)', () => {
    // A global skill lives outside the page list, so the membership checks would
    // mark it 'missing' — but it's a real synthetic doc. Resolve directly so hash
    // nav opens it and graph/links aren't broken.
    const docName = '__skill__/global/foo';
    expect(resolveNavigationTarget(docName, { pages: new Set() })).toEqual({
      kind: 'doc',
      target: docName,
      docName,
    });
  });

  test('redirects a stale `__template__/…` deep-link to the content doc', () => {
    // Templates are content docs now; a stale synthetic bookmark must redirect to
    // the live content doc, not open a phantom empty tab. The legacy parser
    // percent-DECODES segments, so an encoded spaced folder lands on the raw name.
    expect(resolveNavigationTarget('__template__/notes/daily', { pages: new Set() })).toEqual({
      kind: 'doc',
      target: 'notes/.ok/templates/daily',
      docName: 'notes/.ok/templates/daily',
    });
    // Root-level legacy name (no folder segment).
    expect(resolveNavigationTarget('__template__/daily', { pages: new Set() })).toEqual({
      kind: 'doc',
      target: '.ok/templates/daily',
      docName: '.ok/templates/daily',
    });
    // Percent-encoded legacy name with a spaced folder.
    expect(resolveNavigationTarget('__template__/My%20Notes/daily', { pages: new Set() })).toEqual({
      kind: 'doc',
      target: 'My Notes/.ok/templates/daily',
      docName: 'My Notes/.ok/templates/daily',
    });
  });

  test('resolves a PROJECT skill content doc without page-index membership', () => {
    // A freshly created/imported project skill lags the page index by the async
    // files refetch; it must still resolve to the skill DOC rather than the
    // read-only asset viewer, which would strand the editor on a dead surface.
    const target = '.ok/skills/new-skill/SKILL';
    expect(resolveNavigationTarget(target, { pages: new Set() })).toEqual({
      kind: 'doc',
      target,
      docName: target,
    });
  });

  test('resolves a GLOBAL skill bundle .md reference to an EDITABLE doc target', () => {
    // Global skill `.md` references are now editable managed-artifact live docs
    // (per-file skill editability), backed by `<home>/.ok/skills/<name>/<rel>.md`
    // via managedArtifactAbsPath — they open in the editor, not the read-only
    // skill-file viewer. The synthetic name is passed straight through as the doc.
    expect(
      resolveNavigationTarget('__skill__/global/demo/references/notes', { pages: new Set() }),
    ).toEqual({
      kind: 'doc',
      target: '__skill__/global/demo/references/notes',
      docName: '__skill__/global/demo/references/notes',
    });
    // Nested reference.
    expect(
      resolveNavigationTarget('__skill__/global/demo/references/sub/deep', { pages: new Set() }),
    ).toEqual({
      kind: 'doc',
      target: '__skill__/global/demo/references/sub/deep',
      docName: '__skill__/global/demo/references/sub/deep',
    });
  });

  test('the GLOBAL SKILL doc itself stays a normal editor doc target (not skill-file)', () => {
    // Only references route to the viewer — the SKILL doc opens in the editor.
    expect(resolveNavigationTarget('__skill__/global/demo', { pages: new Set() })).toEqual({
      kind: 'doc',
      target: '__skill__/global/demo',
      docName: '__skill__/global/demo',
    });
  });

  test('redirects a stale `__skill__/project/<name>` deep-link to the content doc', () => {
    // A project skill is a CONTENT doc (`.ok/skills/<name>/SKILL`), never the
    // synthetic `__skill__/project/<name>`. A stale bookmark/deep-link in the
    // dead form must redirect to the live content doc, not open a phantom tab.
    expect(resolveNavigationTarget('__skill__/project/foo', { pages: new Set() })).toEqual({
      kind: 'doc',
      target: '.ok/skills/foo/SKILL',
      docName: '.ok/skills/foo/SKILL',
    });
  });

  test('resolves skill and template file-path links as content docs', () => {
    // Project skills are content docs now: a link to a skill file resolves
    // through the normal page index, NOT to a synthetic __skill__ artifact doc.
    const skillDoc = '.ok/skills/open-knowledge-pack-knowledge-base/SKILL';
    expect(resolveNavigationTarget(skillDoc, { pages: new Set([skillDoc]) })).toEqual({
      kind: 'doc',
      target: skillDoc,
      docName: skillDoc,
    });
    // Templates are content docs too: a link resolves to the content doc name,
    // not the dead `__template__/…` synthetic.
    expect(resolveNavigationTarget('notes/.ok/templates/daily', { pages: new Set() })).toEqual({
      kind: 'doc',
      target: 'notes/.ok/templates/daily',
      docName: 'notes/.ok/templates/daily',
    });
  });

  test('resolves a template content doc structurally, normalizing a .md link to ext-less', () => {
    // A freshly-created template lags the page index; it must still resolve to the
    // template DOC (structural early-resolve), not the read-only asset viewer. A
    // doc-body link carrying `.md` normalizes to the same ext-less content name.
    expect(resolveNavigationTarget('projects/.ok/templates/plan', { pages: new Set() })).toEqual({
      kind: 'doc',
      target: 'projects/.ok/templates/plan',
      docName: 'projects/.ok/templates/plan',
    });
    expect(resolveNavigationTarget('projects/.ok/templates/plan.md', { pages: new Set() })).toEqual(
      {
        kind: 'doc',
        target: 'projects/.ok/templates/plan',
        docName: 'projects/.ok/templates/plan',
      },
    );
  });

  test('prefers an exact document over folder landing notes', () => {
    const resolved = resolveNavigationTarget('reports', {
      pages: new Set(['reports', 'reports/index', 'reports/reports']),
      folderPaths: new Set(['reports']),
    });

    expect(resolved).toEqual({
      kind: 'doc',
      target: 'reports',
      docName: 'reports',
    });
  });

  test('two double-extension files under one stem keep their qualified names', () => {
    // `docs/guide.md.md` and `docs/guide.mdx.md` on disk: each indexes as a page
    // whose own name still ends in a markdown extension, and nothing owns the
    // bare `docs/guide`, so a strip would merge the two onto a name for neither.
    const resolved = resolveNavigationTarget('docs/guide.md', {
      pages: new Set(['docs/guide.md', 'docs/guide.mdx']),
      folderPaths: new Set(['docs']),
    });

    expect(resolved).toEqual({
      kind: 'doc',
      target: 'docs/guide.md',
      docName: 'docs/guide.md',
    });
  });

  test('an extension-less page outranks a qualified entry for the same stem', () => {
    const resolved = resolveNavigationTarget('docs/guide.md', {
      pages: new Set(['docs/guide.md', 'docs/guide.mdx', 'docs/guide']),
      folderPaths: new Set(['docs']),
    });

    expect(resolved).toEqual({
      kind: 'doc',
      target: 'docs/guide',
      docName: 'docs/guide',
    });
  });

  test('falls back to extensionless document targets when no exact extension page exists', () => {
    const resolved = resolveNavigationTarget('docs/guide.md', {
      pages: new Set(['docs/guide']),
      folderPaths: new Set(['docs']),
    });

    expect(resolved).toEqual({
      kind: 'doc',
      target: 'docs/guide',
      docName: 'docs/guide',
    });
  });

  test('prefers an exact document over a folder with the same basename', () => {
    const resolved = resolveNavigationTarget('hello', {
      pages: new Set(['hello']),
      folderPaths: new Set(['hello']),
    });

    expect(resolved).toEqual({
      kind: 'doc',
      target: 'hello',
      docName: 'hello',
    });
  });

  test('uses trailing slash intent to open a folder with the same basename as a document', () => {
    const resolved = resolveNavigationTarget('hello/', {
      pages: new Set(['hello']),
      folderPaths: new Set(['hello']),
    });

    expect(resolved).toEqual({
      kind: 'folder',
      target: 'hello',
      folderPath: 'hello',
    });
  });

  test('resolves a canonical index note before a bare folder', () => {
    const resolved = resolveNavigationTarget('./reports/', {
      pages: new Set(['reports/index']),
    });

    expect(resolved).toEqual({
      kind: 'folder-index',
      target: 'reports',
      folderPath: 'reports',
      docName: 'reports/index',
      noteKind: 'canonical-index',
    });
  });

  test('falls back to the legacy folder note when no canonical index exists', () => {
    const resolved = resolveNavigationTarget('reports', {
      pages: new Set(['reports/reports']),
    });

    expect(resolved).toEqual({
      kind: 'folder-index',
      target: 'reports',
      folderPath: 'reports',
      docName: 'reports/reports',
      noteKind: 'legacy-folder-note',
    });
  });

  test('returns folder for a known folder with no landing note', () => {
    const resolved = resolveNavigationTarget('reports/', {
      pages: new Set(),
      folderPaths: new Set(['reports']),
    });

    expect(resolved).toEqual({
      kind: 'folder',
      target: 'reports',
      folderPath: 'reports',
    });
  });

  test('returns missing when neither a doc nor folder exists', () => {
    const resolved = resolveNavigationTarget('reports', {
      pages: new Set(['docs/index']),
    });

    expect(resolved).toEqual({
      kind: 'missing',
      target: 'reports',
    });
  });

  test('resolves a bare-name target to a same-basename file in a subfolder', () => {
    const resolved = resolveNavigationTarget('analysis', {
      pages: new Set(['andrew-data/project-x/analysis']),
      pagesByBasename: new Map([['analysis', 'andrew-data/project-x/analysis']]),
    });

    expect(resolved).toEqual({
      kind: 'doc',
      target: 'andrew-data/project-x/analysis',
      docName: 'andrew-data/project-x/analysis',
    });
  });

  test('basename match is slug-normalized so [[Project X]] resolves to subfolder/project-x', () => {
    const resolved = resolveNavigationTarget('Project X', {
      pages: new Set(['subfolder/project-x']),
      pagesByBasename: new Map([['project-x', 'subfolder/project-x']]),
    });

    expect(resolved).toEqual({
      kind: 'doc',
      target: 'subfolder/project-x',
      docName: 'subfolder/project-x',
    });
  });

  test('exact root match wins over a same-basename subfolder file', () => {
    const resolved = resolveNavigationTarget('analysis', {
      pages: new Set(['analysis', 'sub/analysis']),
      pagesByBasename: new Map([['analysis', 'sub/analysis']]),
    });

    expect(resolved).toEqual({
      kind: 'doc',
      target: 'analysis',
      docName: 'analysis',
    });
  });

  test('full-path slug match wins over basename', () => {
    const resolved = resolveNavigationTarget('sub-analysis', {
      pages: new Set(['Sub-Analysis', 'other/analysis']),
      pagesBySlug: new Map([
        ['sub-analysis', 'Sub-Analysis'],
        ['other-analysis', 'other/analysis'],
      ]),
      pagesByBasename: new Map([
        ['sub-analysis', 'Sub-Analysis'],
        ['analysis', 'other/analysis'],
      ]),
    });

    expect(resolved).toEqual({
      kind: 'doc',
      target: 'Sub-Analysis',
      docName: 'Sub-Analysis',
    });
  });

  test('canonical folder-index wins over basename', () => {
    const resolved = resolveNavigationTarget('reports', {
      pages: new Set(['reports/index', 'docs/reports']),
      pagesByBasename: new Map([
        ['index', 'reports/index'],
        ['reports', 'docs/reports'],
      ]),
    });

    expect(resolved).toEqual({
      kind: 'folder-index',
      target: 'reports',
      folderPath: 'reports',
      docName: 'reports/index',
      noteKind: 'canonical-index',
    });
  });

  test('legacy folder note wins over basename', () => {
    const resolved = resolveNavigationTarget('reports', {
      pages: new Set(['reports/reports', 'docs/reports']),
      pagesByBasename: new Map([['reports', 'docs/reports']]),
    });

    expect(resolved).toEqual({
      kind: 'folder-index',
      target: 'reports',
      folderPath: 'reports',
      docName: 'reports/reports',
      noteKind: 'legacy-folder-note',
    });
  });

  test('basename branch ignores path-shaped targets so [[sub/foo]] does not rewrite', () => {
    const resolved = resolveNavigationTarget('sub/foo', {
      pages: new Set(['other/foo']),
      pagesByBasename: new Map([['foo', 'other/foo']]),
    });

    expect(resolved).toEqual({
      kind: 'missing',
      target: 'sub/foo',
    });
  });

  test('basename wins over a bare-folder fallback so a file beats an empty container', () => {
    const resolved = resolveNavigationTarget('analysis', {
      pages: new Set(['analysis/sub', 'other/analysis']),
      folderPaths: new Set(['analysis', 'other']),
      pagesByBasename: new Map([
        ['sub', 'analysis/sub'],
        ['analysis', 'other/analysis'],
      ]),
    });

    expect(resolved).toEqual({
      kind: 'doc',
      target: 'other/analysis',
      docName: 'other/analysis',
    });
  });

  test('without pagesByBasename, bare-name target in subfolder remains missing (backward compat)', () => {
    const resolved = resolveNavigationTarget('analysis', {
      pages: new Set(['sub/analysis']),
    });

    expect(resolved).toEqual({
      kind: 'missing',
      target: 'analysis',
    });
  });
});

describe('okContentNavigationTarget (read-only .ok routing)', () => {
  const pages = new Set(['notes/real', '.ok/skills/writer/SKILL']);

  test('targets without a .ok path segment are not governed', () => {
    expect(okContentNavigationTarget('notes/real', { pages })).toBeNull();
    expect(okContentNavigationTarget('brand-new/idea', { pages })).toBeNull();
    // A plain `ok` segment is a user folder, not the managed directory.
    expect(okContentNavigationTarget('docs/ok/guide', { pages })).toBeNull();
  });

  test('a template content doc keeps the normal doc flow even when it lags the page index', () => {
    // Templates ARE content docs in `/api/pages`, but a freshly-created one lags
    // the page index. This `pages` set omits the template to simulate that
    // index-lag window: the structural SHAPE match must still route a revealed
    // template row to the editable template editor, not the read-only asset
    // viewer. The skills carve-out below leans on membership because skills ship
    // in the page list.
    expect(okContentNavigationTarget('.ok/templates/meeting', { pages })).toBeNull();
    expect(okContentNavigationTarget('team/.ok/templates/spec', { pages })).toBeNull();
  });

  test('page-list members stay normal content docs (skills carve-out)', () => {
    expect(okContentNavigationTarget('.ok/skills/writer/SKILL', { pages })).toBeNull();
  });

  test('doc-shaped .ok targets resolve to the read-only text viewer on their .md path', () => {
    expect(okContentNavigationTarget('.ok/raw-probe', { pages })).toEqual({
      kind: 'asset',
      target: '.ok/raw-probe.md',
      assetPath: '.ok/raw-probe.md',
      mediaKind: 'text',
    });
    expect(okContentNavigationTarget('notes/.ok/frontmatter', { pages })).toEqual({
      kind: 'asset',
      target: 'notes/.ok/frontmatter.md',
      assetPath: 'notes/.ok/frontmatter.md',
      mediaKind: 'text',
    });
  });

  test('a known on-disk extension overrides the .md default', () => {
    expect(okContentNavigationTarget('.ok/templates/a/b', { pages, docExt: '.mdx' })).toEqual({
      kind: 'asset',
      target: '.ok/templates/a/b.mdx',
      assetPath: '.ok/templates/a/b.mdx',
      mediaKind: 'text',
    });
  });

  test('nested template paths are not template files — they land on the viewer', () => {
    // A template is a single-segment leaf under `.ok/templates/`; a nested path is
    // not one, so it gets no structural template resolution and falls to the
    // read-only viewer like any other unindexed `.ok` file.
    expect(okContentNavigationTarget('.ok/templates/a/b', { pages })).toMatchObject({
      kind: 'asset',
      assetPath: '.ok/templates/a/b.md',
    });
  });

  test('extension-carrying .ok leaves resolve as their own asset path', () => {
    expect(okContentNavigationTarget('.ok/config.yml', { pages })).toEqual({
      kind: 'asset',
      target: '.ok/config.yml',
      assetPath: '.ok/config.yml',
      mediaKind: 'text',
    });
    expect(okContentNavigationTarget('.ok/assets/logo.png', { pages })).toMatchObject({
      kind: 'asset',
      assetPath: '.ok/assets/logo.png',
      mediaKind: 'image',
    });
  });

  test('worktrees and local paths land read-only even though listings exclude them', () => {
    for (const target of ['.ok/worktrees/checkout/README', '.ok/local/config.yml']) {
      expect(okContentNavigationTarget(target, { pages })?.kind).toBe('asset');
    }
  });

  test('the docName contract is file-shaped: a leaf still gains its .md extension', () => {
    // The mapping has no concept of a directory, so callers that can distinguish
    // a folder path from a docName must not route folder paths here — the shape
    // gate lives in resolveNavigationTarget, exercised below.
    expect(okContentNavigationTarget('articles/.ok', { pages })).toMatchObject({
      kind: 'asset',
      assetPath: 'articles/.ok.md',
    });
  });
});

describe('resolveNavigationTarget — folder-shaped .ok targets', () => {
  // A revealed `.ok` directory holds no indexed markdown, so it never enters the
  // page-derived folder index — the shape that used to reach the `.ok` file
  // fallback and come back as a phantom `<dir>.md` asset.
  const options = {
    pages: new Set(['articles/intro']),
    folderPaths: new Set(['articles']),
  };

  test('a revealed .ok directory does not resolve to a phantom .md asset', () => {
    for (const target of ['articles/.ok/', 'articles/.ok/templates/', '.ok/']) {
      expect(resolveNavigationTarget(target, options).kind).not.toBe('asset');
    }
  });

  test('folder-shaped misses resolve the same inside and outside .ok', () => {
    expect(resolveNavigationTarget('articles/nope/', options)).toEqual({
      kind: 'missing',
      target: 'articles/nope',
    });
    expect(resolveNavigationTarget('articles/.ok/', options)).toEqual({
      kind: 'missing',
      target: 'articles/.ok',
    });
    expect(resolveNavigationTarget('articles/.ok/templates/', options)).toEqual({
      kind: 'missing',
      target: 'articles/.ok/templates',
    });
    expect(resolveNavigationTarget('.ok/', options)).toEqual({
      kind: 'missing',
      target: '.ok',
    });
  });

  test('.ok folders backed by indexed skill docs still resolve as folders', () => {
    // Project skill docs ARE page-list members, so `.ok` and `.ok/skills`
    // register as real folder paths and resolve before the fallback.
    const skillOptions = { pages: new Set(['.ok/skills/writer/SKILL']) };
    for (const folderPath of ['.ok', '.ok/skills', '.ok/skills/writer']) {
      expect(resolveNavigationTarget(`${folderPath}/`, skillOptions)).toEqual({
        kind: 'folder',
        target: folderPath,
        folderPath,
      });
    }
  });

  test('doc-shaped .ok targets keep their read-only routing', () => {
    // A template content doc resolves structurally to itself even before the page
    // index catches up (it is not in `options.pages` here).
    expect(resolveNavigationTarget('articles/.ok/templates/meeting', options)).toEqual({
      kind: 'doc',
      target: 'articles/.ok/templates/meeting',
      docName: 'articles/.ok/templates/meeting',
    });
    expect(
      resolveNavigationTarget('.ok/skills/writer/SKILL', {
        pages: new Set(['.ok/skills/writer/SKILL']),
      }),
    ).toEqual({
      kind: 'doc',
      target: '.ok/skills/writer/SKILL',
      docName: '.ok/skills/writer/SKILL',
    });
    expect(resolveNavigationTarget('articles/.ok', options)).toMatchObject({
      kind: 'asset',
      assetPath: 'articles/.ok.md',
    });
  });

  test('a trailing-slash template path returns missing (folder-shaped, not a doc)', () => {
    // The template shape parser rejects the slashed form, so a trailing-slash
    // template path is treated as a folder, not a template doc. Pinned so a caller
    // that later emits trailing-slash template hashes cannot silently flip this
    // into a doc resolution.
    expect(resolveNavigationTarget('articles/.ok/templates/meeting/', options)).toEqual({
      kind: 'missing',
      target: 'articles/.ok/templates/meeting',
    });
  });
});

describe('resolveNavigationTarget .ok guard', () => {
  const options = { pages: new Set(['notes/real', '.ok/skills/writer/SKILL']) };

  test('doc-shaped .ok targets never resolve to missing — the viewer replaces create-mode', () => {
    // Existing file and nonexistent name are unknowable at resolve time; both
    // shapes must land on the read-only viewer (its error pane is the
    // non-create missing surface), never on the create-mode editor.
    expect(resolveNavigationTarget('.ok/raw-probe', options)).toEqual({
      kind: 'asset',
      target: '.ok/raw-probe.md',
      assetPath: '.ok/raw-probe.md',
      mediaKind: 'text',
    });
    expect(resolveNavigationTarget('notes/.ok/frontmatter', options)).toMatchObject({
      kind: 'asset',
      assetPath: 'notes/.ok/frontmatter.md',
    });
    expect(resolveNavigationTarget('.ok/worktrees/checkout/README', options)).toMatchObject({
      kind: 'asset',
    });
  });

  test('sanctioned .ok resolutions: skills and templates both stay content docs', () => {
    expect(resolveNavigationTarget('.ok/skills/writer/SKILL', options)).toEqual({
      kind: 'doc',
      target: '.ok/skills/writer/SKILL',
      docName: '.ok/skills/writer/SKILL',
    });
    expect(resolveNavigationTarget('.ok/templates/meeting', options)).toEqual({
      kind: 'doc',
      target: '.ok/templates/meeting',
      docName: '.ok/templates/meeting',
    });
  });

  test('.ok folder targets keep resolving to the folder overview', () => {
    expect(resolveNavigationTarget('.ok', options)).toEqual({
      kind: 'folder',
      target: '.ok',
      folderPath: '.ok',
    });
  });

  test('non-.ok misses keep the create-mode missing resolution', () => {
    expect(resolveNavigationTarget('brand-new/idea', options)).toEqual({
      kind: 'missing',
      target: 'brand-new/idea',
    });
  });
});

describe('docNameForNavigationTarget', () => {
  test('returns null for folder targets so folder navigation stays doc-free', () => {
    expect(
      docNameForNavigationTarget({
        kind: 'folder',
        target: 'reports',
        folderPath: 'reports',
      }),
    ).toBeNull();
  });

  test('returns the editable doc name for live and missing targets', () => {
    expect(
      docNameForNavigationTarget({
        kind: 'folder-index',
        target: 'reports',
        folderPath: 'reports',
        docName: 'reports/index',
        noteKind: 'canonical-index',
      }),
    ).toBe('reports/index');

    expect(
      docNameForNavigationTarget({
        kind: 'missing',
        target: 'reports/new-note',
      }),
    ).toBe('reports/new-note');
  });

  test('returns the represented doc name for large-file targets', () => {
    expect(
      docNameForNavigationTarget({
        kind: 'large-file',
        target: 'big',
        docName: 'big',
        size: 101,
        limit: 100,
      }),
    ).toBe('big');
  });
});

describe('large-file open guard', () => {
  test('rewrites an oversized document target to a non-opening large-file target', () => {
    expect(
      withLargeFileOpenGuard(
        {
          kind: 'doc',
          target: 'big',
          docName: 'big',
        },
        new Map([['big', { size: 101 }]]),
        100,
      ),
    ).toEqual({
      kind: 'large-file',
      target: 'big',
      docName: 'big',
      size: 101,
      limit: 100,
    });
  });

  test('passes through documents at the exact byte limit', () => {
    const target = {
      kind: 'doc',
      target: 'exact',
      docName: 'exact',
    } as const;

    expect(withLargeFileOpenGuard(target, new Map([['exact', { size: 100 }]]), 100)).toBe(target);
  });

  test('rewrites an oversized folder-index target to a large-file target', () => {
    expect(
      withLargeFileOpenGuard(
        {
          kind: 'folder-index',
          target: 'reports',
          folderPath: 'reports',
          docName: 'reports/index',
          noteKind: 'canonical-index',
        },
        new Map([['reports/index', { size: 101 }]]),
        100,
      ),
    ).toEqual({
      kind: 'large-file',
      target: 'reports/index',
      docName: 'reports/index',
      size: 101,
      limit: 100,
    });
  });

  test('blocks documents over the default cap', () => {
    const oversizedBytes = DOCUMENT_OPEN_BYTE_LIMIT + 1;

    expect(
      withLargeFileOpenGuard(
        {
          kind: 'doc',
          target: 'oversized',
          docName: 'oversized',
        },
        new Map([['oversized', { size: oversizedBytes }]]),
      ),
    ).toEqual({
      kind: 'large-file',
      target: 'oversized',
      docName: 'oversized',
      size: oversizedBytes,
      limit: DOCUMENT_OPEN_BYTE_LIMIT,
    });
  });

  test('largeFileNavigationTarget ignores missing metadata', () => {
    expect(largeFileNavigationTarget('unknown', undefined, 100)).toBeNull();
  });
});

describe('downgradeFolderIndexForHashNav', () => {
  test('rewrites a canonical-index target to its folder overview', () => {
    expect(
      downgradeFolderIndexForHashNav({
        kind: 'folder-index',
        target: 'reports',
        folderPath: 'reports',
        docName: 'reports/index',
        noteKind: 'canonical-index',
      }),
    ).toEqual({
      kind: 'folder',
      target: 'reports',
      folderPath: 'reports',
    });
  });

  test('rewrites a legacy-folder-note target to its folder overview', () => {
    expect(
      downgradeFolderIndexForHashNav({
        kind: 'folder-index',
        target: 'reports',
        folderPath: 'reports',
        docName: 'reports/reports',
        noteKind: 'legacy-folder-note',
      }),
    ).toEqual({
      kind: 'folder',
      target: 'reports',
      folderPath: 'reports',
    });
  });

  test('passes through non-folder-index targets unchanged', () => {
    const doc = { kind: 'doc', target: 'foo', docName: 'foo' } as const;
    expect(downgradeFolderIndexForHashNav(doc)).toBe(doc);

    const folder = { kind: 'folder', target: 'reports', folderPath: 'reports' } as const;
    expect(downgradeFolderIndexForHashNav(folder)).toBe(folder);

    const missing = { kind: 'missing', target: 'gone' } as const;
    expect(downgradeFolderIndexForHashNav(missing)).toBe(missing);
  });
});

describe('resolveNavigationTarget — Mermaid docs', () => {
  test('resolves a .mmd / .mermaid path to a doc target even when absent from pages', () => {
    // Mermaid docs are served as assets (never in the markdown page set) but
    // open as editable CRDT docs — the docName retains its extension.
    const pages = new Set<string>();
    expect(resolveNavigationTarget('assets/flow.mmd', { pages })).toEqual({
      kind: 'doc',
      target: 'assets/flow.mmd',
      docName: 'assets/flow.mmd',
    });
    expect(resolveNavigationTarget('diagrams/seq.mermaid', { pages })).toEqual({
      kind: 'doc',
      target: 'diagrams/seq.mermaid',
      docName: 'diagrams/seq.mermaid',
    });
  });

  test('a trailing-slash (folder) form is not treated as a Mermaid doc', () => {
    expect(resolveNavigationTarget('assets/flow.mmd/', { pages: new Set() }).kind).not.toBe('doc');
  });
});

describe('editable text docs resolve as doc targets', () => {
  test('a .ts target opens the editable doc, not the asset viewer', () => {
    const target = resolveNavigationTarget('src/util.ts', {
      pages: new Set<string>(),
      pageMeta: new Map(),
      folderPaths: new Set<string>(),
      assetPaths: new Set<string>(['src/util.ts']),
    } as never);
    expect(target).toMatchObject({ kind: 'doc', docName: 'src/util.ts' });
  });
});

describe('markdown-extension normalization keeps one room per file', () => {
  test('a managed-artifact skill reference normalizes before the early return', () => {
    expect(
      resolveNavigationTarget('__skill__/global/my-skill/references/guide.md', {
        pages: new Set<string>(),
      }),
    ).toEqual({
      kind: 'doc',
      target: '__skill__/global/my-skill/references/guide',
      docName: '__skill__/global/my-skill/references/guide',
    });
  });

  test('an external-skill bundle reference normalizes too', () => {
    expect(
      resolveNavigationTarget('__extskill__/my-skill/references/guide.mdx', {
        pages: new Set<string>(),
      }),
    ).toMatchObject({
      kind: 'doc',
      docName: '__extskill__/my-skill/references/guide',
    });
  });

  test('the stripped twin wins over an extension-qualified index entry', () => {
    const pages = new Set(['specs/demo/SPEC', 'specs/demo/SPEC.md']);
    expect(resolveNavigationTarget('specs/demo/SPEC.md', { pages })).toEqual({
      kind: 'doc',
      target: 'specs/demo/SPEC',
      docName: 'specs/demo/SPEC',
    });
  });

  test('repeated extensions collapse to the stem', () => {
    const pages = new Set(['notes/idea']);
    expect(resolveNavigationTarget('notes/idea.md.md', { pages })).toMatchObject({
      kind: 'doc',
      docName: 'notes/idea',
    });
  });

  test('a file whose own name ends in .md keeps that extension', () => {
    // `specs/demo/NOTE.md.md` on disk indexes as the page `specs/demo/NOTE.md`.
    // No page owns `specs/demo/NOTE`, so stripping addresses nothing.
    const pages = new Set(['specs/demo/NOTE.md']);
    expect(resolveNavigationTarget('specs/demo/NOTE.md', { pages })).toEqual({
      kind: 'doc',
      target: 'specs/demo/NOTE.md',
      docName: 'specs/demo/NOTE.md',
    });
  });

  test('system and config doc names pass through untouched', () => {
    const synthetic = [
      '__system__',
      '__config__/project',
      '__local__/project',
      '__user__/config.yml',
    ];
    for (const docName of synthetic) {
      expect(resolveNavigationTarget(docName, { pages: new Set([docName]) })).toEqual({
        kind: 'doc',
        target: docName,
        docName,
      });
      expect(resolveNavigationTarget(docName, { pages: new Set<string>() }).target).toBe(docName);
    }
  });

  test('non-markdown doc names keep their extension', () => {
    expect(resolveNavigationTarget('assets/flow.mmd', { pages: new Set<string>() })).toMatchObject({
      kind: 'doc',
      docName: 'assets/flow.mmd',
    });
  });
});
