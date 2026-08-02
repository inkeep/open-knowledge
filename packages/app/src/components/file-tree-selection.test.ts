import { describe, expect, test } from 'vitest';
import { resolveFileTreeSelection, resolveFileTreeSelectionAction } from './file-tree-selection';

describe('resolveFileTreeSelection', () => {
  test('keeps a document row active for doc targets', () => {
    expect(
      resolveFileTreeSelection(
        {
          kind: 'doc',
          target: 'reports/index',
          docName: 'reports/index',
        },
        'reports/index',
      ),
    ).toEqual({
      selectedFilePath: 'reports/index',
      selectedFolderPath: null,
      navigationPath: 'reports/index',
    });
  });

  test('uses the active document when a doc target lags a tab switch', () => {
    expect(
      resolveFileTreeSelection(
        {
          kind: 'doc',
          target: 'AGENTS',
          docName: 'AGENTS',
        },
        'CLAUDE',
      ),
    ).toEqual({
      selectedFilePath: 'CLAUDE',
      selectedFolderPath: null,
      navigationPath: 'CLAUDE',
    });
  });

  test('uses the active document when a folder target lags a tab switch', () => {
    expect(
      resolveFileTreeSelection(
        {
          kind: 'folder-index',
          target: 'reports',
          folderPath: 'reports',
          docName: 'reports/index',
          noteKind: 'canonical-index',
        },
        'CLAUDE',
      ),
    ).toEqual({
      selectedFilePath: 'CLAUDE',
      selectedFolderPath: null,
      navigationPath: 'CLAUDE',
    });
  });

  test('keeps the folder row active when a folder click resolves to an index note', () => {
    expect(
      resolveFileTreeSelection(
        {
          kind: 'folder-index',
          target: 'reports',
          folderPath: 'reports',
          docName: 'reports/index',
          noteKind: 'canonical-index',
        },
        'reports/index',
      ),
    ).toEqual({
      selectedFilePath: null,
      selectedFolderPath: 'reports',
      navigationPath: 'reports',
    });
  });

  test('keeps the folder row active for folder overview targets', () => {
    expect(
      resolveFileTreeSelection(
        {
          kind: 'folder',
          target: 'reports',
          folderPath: 'reports',
        },
        null,
      ),
    ).toEqual({
      selectedFilePath: null,
      selectedFolderPath: 'reports',
      navigationPath: 'reports',
    });
  });

  test('clears sidebar selection for missing targets', () => {
    expect(
      resolveFileTreeSelection(
        {
          kind: 'missing',
          target: 'reports',
        },
        'reports',
      ),
    ).toEqual({
      selectedFilePath: null,
      selectedFolderPath: null,
      navigationPath: null,
    });
  });

  test('keeps a known document selected when route metadata temporarily says missing', () => {
    expect(
      resolveFileTreeSelection(
        {
          kind: 'missing',
          target: 'CLAUDE',
        },
        'CLAUDE',
        {
          isKnownDocument: (docName) => docName === 'CLAUDE',
        },
      ),
    ).toEqual({
      selectedFilePath: 'CLAUDE',
      selectedFolderPath: null,
      navigationPath: 'CLAUDE',
    });
  });
});

describe('resolveFileTreeSelectionAction', () => {
  test('routes asset rows to the standalone asset hash', () => {
    expect(
      resolveFileTreeSelectionAction('docs/photo.png', [
        {
          kind: 'asset',
          path: 'docs/photo.png',
          assetExt: '.png',
          mediaKind: 'image',
          size: 0,
          modified: '',
        },
      ]),
    ).toEqual({
      kind: 'asset',
      path: 'docs/photo.png',
      hash: '#/__asset__/docs/photo.png',
      mediaKind: 'image',
    });
  });

  test('routes known document rows to document navigation', () => {
    expect(
      resolveFileTreeSelectionAction('docs/guide.md', [
        {
          kind: 'document',
          docName: 'docs/guide',
          size: 0,
          modified: '',
        },
      ]),
    ).toEqual({
      kind: 'document',
      path: 'docs/guide',
    });
  });

  test('opens the base file from its own row when a doubled extension is listed first', () => {
    // The `name.md` row and the `name.md.md` row are both visible now, and both
    // entries map RAW to `name.md`. Picking whichever entry the server happened
    // to list first would open `name.md.md` from the `name.md` row, which is
    // the wrong file and invisible to the user. Directory order is not
    // guaranteed, so assert the order that used to resolve incorrectly.
    const doubled: FileEntry = {
      kind: 'document',
      docName: 'name.md',
      docExt: '.md',
      size: 20,
      modified: '',
    };
    const base: FileEntry = {
      kind: 'document',
      docName: 'name',
      docExt: '.md',
      size: 10,
      modified: '',
    };
    expect(resolveFileTreeSelectionAction('name.md', [doubled, base])).toEqual({
      kind: 'document',
      path: 'name',
    });
    expect(resolveFileTreeSelectionAction('name.md.md', [doubled, base])).toEqual({
      kind: 'document',
      path: 'name.md',
    });
    // Same answers with the entries the other way round.
    expect(resolveFileTreeSelectionAction('name.md', [base, doubled])).toEqual({
      kind: 'document',
      path: 'name',
    });
    expect(resolveFileTreeSelectionAction('name.md.md', [base, doubled])).toEqual({
      kind: 'document',
      path: 'name.md',
    });
  });

  test('routes extension-qualified document rows to their exact document identity', () => {
    expect(
      resolveFileTreeSelectionAction('docs/guide.mdx', [
        {
          kind: 'document',
          docName: 'docs/guide.mdx',
          docExt: '.mdx',
          size: 0,
          modified: '',
        },
      ]),
    ).toEqual({
      kind: 'document',
      path: 'docs/guide.mdx',
    });
  });

  test('routes an extension row beside the opposite document extension as an exact document', () => {
    expect(
      resolveFileTreeSelectionAction('docs/guide.md', [
        {
          kind: 'document',
          docName: 'docs/guide',
          docExt: '.mdx',
          size: 0,
          modified: '',
        },
        {
          kind: 'asset',
          path: 'docs/guide.md',
          assetExt: 'md',
          mediaKind: null,
          size: 0,
          modified: '',
        },
      ]),
    ).toEqual({
      kind: 'document',
      path: 'docs/guide.md',
    });
  });

  test('routes same-stem markdown generic rows as exact document identities', () => {
    expect(
      resolveFileTreeSelectionAction('docs/guide.md', [
        {
          kind: 'asset',
          path: 'docs/guide.md',
          assetExt: 'md',
          mediaKind: null,
          size: 0,
          modified: '',
        },
        {
          kind: 'asset',
          path: 'docs/guide.mdx',
          assetExt: 'mdx',
          mediaKind: null,
          size: 0,
          modified: '',
        },
      ]),
    ).toEqual({
      kind: 'document',
      path: 'docs/guide.md',
    });
  });

  test('drops transient unknown document and folder selections', () => {
    expect(resolveFileTreeSelectionAction('docs/missing.md', [])).toEqual({ kind: 'none' });
    expect(resolveFileTreeSelectionAction('docs/', [])).toEqual({ kind: 'none' });
  });

  test('routes known folder rows to folder navigation', () => {
    expect(
      resolveFileTreeSelectionAction('docs/', [
        {
          kind: 'folder',
          path: 'docs',
          size: 0,
          modified: '',
        },
      ]),
    ).toEqual({
      kind: 'folder',
      path: 'docs',
    });
  });
});

describe('resolveFileTreeSelectionAction — Mermaid assets', () => {
  test('routes a mermaid asset row to document navigation (not the asset hash)', () => {
    expect(
      resolveFileTreeSelectionAction('assets/flow.mmd', [
        {
          kind: 'asset',
          path: 'assets/flow.mmd',
          assetExt: '.mmd',
          mediaKind: 'mermaid',
          size: 0,
          modified: '',
        },
      ]),
    ).toEqual({ kind: 'document', path: 'assets/flow.mmd' });
  });
});

describe('resolveFileTreeSelectionAction — editable text assets', () => {
  test('routes a code-file asset row to document navigation (not the asset hash)', () => {
    expect(
      resolveFileTreeSelectionAction('src/util.ts', [
        {
          kind: 'asset',
          path: 'src/util.ts',
          assetExt: '.ts',
          mediaKind: 'text',
          size: 0,
          modified: '',
        },
      ]),
    ).toEqual({ kind: 'document', path: 'src/util.ts' });
  });

  test('an everyday-large lockfile still opens as an editable doc', () => {
    expect(
      resolveFileTreeSelectionAction('pnpm-lock.yaml', [
        {
          kind: 'asset',
          path: 'pnpm-lock.yaml',
          assetExt: '.yaml',
          mediaKind: 'text',
          size: 900 * 1024,
          modified: '',
        },
      ]),
    ).toEqual({ kind: 'document', path: 'pnpm-lock.yaml' });
  });

  test('a pathologically large text asset stays on the read-only asset viewer', () => {
    expect(
      resolveFileTreeSelectionAction('big/data.json', [
        {
          kind: 'asset',
          path: 'big/data.json',
          assetExt: '.json',
          mediaKind: 'text',
          size: 20 * 1024 * 1024,
          modified: '',
        },
      ]),
    ).toMatchObject({ kind: 'asset', path: 'big/data.json' });
  });
});
