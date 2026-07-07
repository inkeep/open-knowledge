import { describe, expect, test } from 'bun:test';
import { buildFolderOverviewData } from './folder-overview-data';

describe('buildFolderOverviewData', () => {
  test('produces a single sorted list with folders first, then files', () => {
    const data = buildFolderOverviewData('reports', {
      pages: new Set([
        'reports/index',
        'reports/weekly',
        'reports/monthly',
        'reports/q1/index',
        'reports/q1/summary',
        'reports/q2/details',
      ]),
      pageTitles: new Map([
        ['reports/index', 'Reports'],
        ['reports/weekly', 'Weekly Review'],
        ['reports/monthly', 'Monthly Review'],
        ['reports/q1/index', 'Quarter One'],
      ]),
      pageMeta: new Map([
        ['reports/index', { size: 100, modified: '2026-04-10T00:00:00Z' }],
        ['reports/weekly', { size: 200, modified: '2026-04-12T00:00:00Z' }],
        ['reports/monthly', { size: 150, modified: '2026-04-11T00:00:00Z' }],
      ]),
      folderPaths: new Set(['reports/q1', 'reports/q2', 'reports/q2/deep']),
    });

    expect(data.title).toBe('Reports');

    // Folders come first, then files — each group sorted by title (localeCompare)
    expect(data.children).toEqual([
      { kind: 'folder', path: 'reports/q2', name: 'q2', title: 'q2' },
      { kind: 'folder', path: 'reports/q1', name: 'q1', title: 'Quarter One' },
      {
        kind: 'file',
        path: 'reports/monthly',
        name: 'monthly',
        title: 'Monthly Review',
        size: 150,
        modified: '2026-04-11T00:00:00Z',
      },
      {
        kind: 'file',
        path: 'reports/index',
        name: 'index',
        title: 'Reports',
        size: 100,
        modified: '2026-04-10T00:00:00Z',
      },
      {
        kind: 'file',
        path: 'reports/weekly',
        name: 'weekly',
        title: 'Weekly Review',
        size: 200,
        modified: '2026-04-12T00:00:00Z',
      },
    ]);
  });

  test('title falls back to leaf name when pageTitles echoes full docName', () => {
    const data = buildFolderOverviewData('docs', {
      pages: new Set(['docs/readme']),
      pageTitles: new Map([['docs/readme', 'docs/readme']]),
      pageMeta: new Map(),
      folderPaths: new Set(),
    });

    expect(data.children[0]).toMatchObject({ kind: 'file', title: 'readme' });
  });

  test('content-root (empty folderPath) lists only top-level children', () => {
    // The empty prefix means every top-level docName / folderPath is a
    // direct child; nested entries (`docs/a`, `reports/q1`) are excluded.
    // Reached by in-app root nav and root-folder shares.
    const data = buildFolderOverviewData('', {
      pages: new Set(['intro', 'README', 'docs/a', 'docs/b', 'reports/q1/summary']),
      pageTitles: new Map([['intro', 'Intro']]),
      pageMeta: new Map([['intro', { size: 10, modified: '2026-05-01T00:00:00Z' }]]),
      folderPaths: new Set(['docs', 'reports', 'reports/q1']),
    });

    expect(data.children).toEqual([
      { kind: 'folder', path: 'docs', name: 'docs', title: 'docs' },
      { kind: 'folder', path: 'reports', name: 'reports', title: 'reports' },
      {
        kind: 'file',
        path: 'intro',
        name: 'intro',
        title: 'Intro',
        size: 10,
        modified: '2026-05-01T00:00:00Z',
      },
      {
        kind: 'file',
        path: 'README',
        name: 'README',
        title: 'README',
        size: 0,
        modified: '',
      },
    ]);
  });
});
