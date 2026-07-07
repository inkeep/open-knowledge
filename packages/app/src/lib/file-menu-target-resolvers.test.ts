/**
 * Pure unit coverage for the active-target → path / handoff-input
 * projections that drive the macOS File menu's state-aware items.
 *
 * These resolvers exist because the File menu doesn't have ambient row
 * context — they convert a `ResolvedNavigationTarget` snapshot into the
 * same path shapes the sidebar's per-row right-click menu derives from
 * the Pierre `ContextMenuItem`. Branching is the load-bearing logic worth
 * pinning so a refactor that changes the scope cascade (doc / folder /
 * project / asset) doesn't silently land the menu pick on the wrong path.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildSendToAiInputForActiveTarget,
  resolveActiveTargetAbsPath,
  resolveActiveTargetRelativePath,
} from './file-menu-target-resolvers';
import type { Workspace } from './workspace-paths';

const WORKSPACE: Workspace = {
  contentDir: '/Users/test/project',
  pathSeparator: '/',
};

describe('resolveActiveTargetAbsPath', () => {
  test('doc scope joins contentDir + .md-suffixed docName', () => {
    expect(
      resolveActiveTargetAbsPath(
        { kind: 'doc', target: 'specs/foo', docName: 'specs/foo' },
        'specs/foo',
        WORKSPACE,
      ),
    ).toBe('/Users/test/project/specs/foo.md');
  });

  test('folder-index scope routes through the doc path (folder note is a doc)', () => {
    expect(
      resolveActiveTargetAbsPath(
        {
          kind: 'folder-index',
          target: 'specs',
          folderPath: 'specs',
          docName: 'specs/index',
          noteKind: 'canonical-index',
        },
        'specs/index',
        WORKSPACE,
      ),
    ).toBe('/Users/test/project/specs/index.md');
  });

  test('folder scope joins contentDir + folderPath (no trailing slash)', () => {
    expect(
      resolveActiveTargetAbsPath(
        { kind: 'folder', target: 'reports', folderPath: 'reports' },
        null,
        WORKSPACE,
      ),
    ).toBe('/Users/test/project/reports');
  });

  test('null scope (project) returns contentDir verbatim', () => {
    expect(resolveActiveTargetAbsPath(null, null, WORKSPACE)).toBe('/Users/test/project');
  });

  test('asset scope joins contentDir + assetPath', () => {
    expect(
      resolveActiveTargetAbsPath(
        { kind: 'asset', target: 'media/foo.png', assetPath: 'media/foo.png', mediaKind: null },
        null,
        WORKSPACE,
      ),
    ).toBe('/Users/test/project/media/foo.png');
  });

  test('missing scope falls back to contentDir', () => {
    expect(resolveActiveTargetAbsPath({ kind: 'missing', target: 'gone' }, null, WORKSPACE)).toBe(
      '/Users/test/project',
    );
  });
});

describe('resolveActiveTargetRelativePath', () => {
  test('doc scope returns .md-suffixed relative path', () => {
    expect(
      resolveActiveTargetRelativePath(
        { kind: 'doc', target: 'specs/foo', docName: 'specs/foo' },
        'specs/foo',
      ),
    ).toBe('specs/foo.md');
  });

  test('folder-index scope returns the doc-relative path', () => {
    expect(
      resolveActiveTargetRelativePath(
        {
          kind: 'folder-index',
          target: 'specs',
          folderPath: 'specs',
          docName: 'specs/index',
          noteKind: 'canonical-index',
        },
        'specs/index',
      ),
    ).toBe('specs/index.md');
  });

  test('folder scope returns the folder path with no trailing slash', () => {
    expect(
      resolveActiveTargetRelativePath(
        { kind: 'folder', target: 'reports', folderPath: 'reports' },
        null,
      ),
    ).toBe('reports');
  });

  test('asset scope returns the asset-relative path', () => {
    expect(
      resolveActiveTargetRelativePath(
        { kind: 'asset', target: 'x.png', assetPath: 'x.png', mediaKind: null },
        null,
      ),
    ).toBe('x.png');
  });

  test('null / missing scopes return empty string (contentDir convention)', () => {
    expect(resolveActiveTargetRelativePath(null, null)).toBe('');
    expect(resolveActiveTargetRelativePath({ kind: 'missing', target: 'gone' }, null)).toBe('');
  });
});

describe('buildSendToAiInputForActiveTarget', () => {
  test('null scope (project) returns project-scoped handoff input', () => {
    const input = buildSendToAiInputForActiveTarget(null, null, WORKSPACE);
    expect(input).not.toBeNull();
    expect(input?.docContext).toBeNull();
    expect(input?.projectDir).toBe('/Users/test/project');
    expect(input?.docPath).toBe('');
  });

  test('folder scope returns folder-scoped handoff input with contentDir projectDir + relative path', () => {
    const input = buildSendToAiInputForActiveTarget(
      { kind: 'folder', target: 'reports', folderPath: 'reports' },
      null,
      WORKSPACE,
    );
    expect(input).not.toBeNull();
    expect(input?.docContext).toBeNull();
    expect(input?.folderRelativePath).toBe('reports');
    // Folder scope keeps cwd at contentDir (project root) so project-level
    // agent tooling resolves; the folder focus is conveyed via the directive
    // prompt's relative path, not via cwd. See `buildFolderHandoffInput`.
    expect(input?.projectDir).toBe('/Users/test/project');
  });

  test('doc + folder-index scopes return file-scoped handoff input', () => {
    const docInput = buildSendToAiInputForActiveTarget(
      { kind: 'doc', target: 'specs/foo', docName: 'specs/foo' },
      'specs/foo',
      WORKSPACE,
    );
    expect(docInput?.docContext?.relativePath).toBe('specs/foo.md');
    expect(docInput?.docPath).toBe('/Users/test/project/specs/foo.md');

    const folderIndexInput = buildSendToAiInputForActiveTarget(
      {
        kind: 'folder-index',
        target: 'specs',
        folderPath: 'specs',
        docName: 'specs/index',
        noteKind: 'canonical-index',
      },
      'specs/index',
      WORKSPACE,
    );
    expect(folderIndexInput?.docContext?.relativePath).toBe('specs/index.md');
  });

  test('asset / missing scopes return null (no meaningful dispatch)', () => {
    expect(
      buildSendToAiInputForActiveTarget(
        { kind: 'asset', target: 'x.png', assetPath: 'x.png', mediaKind: null },
        null,
        WORKSPACE,
      ),
    ).toBeNull();
    expect(
      buildSendToAiInputForActiveTarget({ kind: 'missing', target: 'gone' }, null, WORKSPACE),
    ).toBeNull();
  });

  test('returns null when workspace is unresolved on doc / folder scopes', () => {
    expect(
      buildSendToAiInputForActiveTarget(
        { kind: 'doc', target: 'foo', docName: 'foo' },
        'foo',
        null,
      ),
    ).toBeNull();
    expect(
      buildSendToAiInputForActiveTarget(
        { kind: 'folder', target: 'foo', folderPath: 'foo' },
        null,
        null,
      ),
    ).toBeNull();
  });
});
