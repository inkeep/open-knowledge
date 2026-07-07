import { describe, expect, test } from 'bun:test';
import {
  createWorkspaceSearchDocument,
  DEFAULT_FILE_RESULT_CAP,
  DEFAULT_FOLDER_RESULT_CAP,
  searchWorkspaceDocuments,
} from './workspace-search.ts';

describe('extension-tolerant filename matching', () => {
  // A markdown page whose title differs from its filename.
  const page = createWorkspaceSearchDocument({
    kind: 'page',
    path: 'stories/cloud-collaboration/STORY',
    title: 'Cloud & Collaborative Functionality — User Stories',
    content: 'real-time co-editing without leaving git',
    modifiedTs: 10,
  });
  const csv = createWorkspaceSearchDocument({
    kind: 'file',
    path: 'assets/data.csv',
    modifiedTs: 5,
  });
  const documents = [page, csv];

  test('STORY.md resolves to the page named STORY at the exact-name tier', () => {
    const results = searchWorkspaceDocuments(documents, 'STORY.md', { intent: 'omnibar' });
    const hit = results.find((r) => r.document.path === 'stories/cloud-collaboration/STORY');
    expect(hit).toBeDefined();
    expect(hit?.signals.lexical).toBe(700);
  });

  test('STORY.md and STORY rank the page identically (extension parity)', () => {
    const withExt = searchWorkspaceDocuments(documents, 'STORY.md', { intent: 'omnibar' });
    const withoutExt = searchWorkspaceDocuments(documents, 'STORY', { intent: 'omnibar' });
    expect(withExt[0]?.document.path).toBe('stories/cloud-collaboration/STORY');
    expect(withoutExt[0]?.document.path).toBe('stories/cloud-collaboration/STORY');
    expect(withExt[0]?.signals.lexical).toBe(withoutExt[0]?.signals.lexical);
  });

  test('non-markdown files are findable by their full name', () => {
    const csvQuery = searchWorkspaceDocuments(documents, 'data.csv', { intent: 'omnibar' });
    expect(csvQuery.some((r) => r.document.path === 'assets/data.csv')).toBe(true);
  });

  test('only .md/.mdx is stripped — a .csv suffix is not treated as the page name', () => {
    // `.csv` is not a doc extension, so `STORY.csv` must NOT earn the page an
    // exact-name (700) bracket (it may still surface via body/token matching at
    // a lower tier — that is fine; the point is the strip is .md/.mdx-only).
    const results = searchWorkspaceDocuments(documents, 'STORY.csv', { intent: 'omnibar' });
    const hit = results.find((r) => r.document.path === 'stories/cloud-collaboration/STORY');
    expect(hit?.signals.lexical ?? 0).not.toBe(700);
  });

  test('a bare ".md" query does not match every page', () => {
    const results = searchWorkspaceDocuments(documents, '.md', { intent: 'omnibar' });
    expect(results.some((r) => r.document.path === 'stories/cloud-collaboration/STORY')).toBe(
      false,
    );
  });
});

describe('per-kind result quota (content-first composition)', () => {
  // Five same-named folders (`reports`) + pages whose body matches — mirrors the
  // `evidence`/`meta` mode where one kind would otherwise fill the whole list.
  const folders = ['a', 'b', 'c', 'd', 'e'].map((p) =>
    createWorkspaceSearchDocument({ kind: 'folder', path: `${p}/reports`, modifiedTs: 0 }),
  );
  // Pages match the query via their name/path (omnibar searches name/path, not
  // body) so they are legitimate candidates that the quota lets through.
  const pages = [1, 2, 3, 4].map((n) =>
    createWorkspaceSearchDocument({
      kind: 'page',
      path: `team${n}/reports-notes`,
      title: `Reports Notes ${n}`,
      content: 'quarterly summary',
      modifiedTs: n,
    }),
  );
  const folderDocs = [...folders, ...pages];

  test('omnibar caps folders and lets content fill the rest', () => {
    const results = searchWorkspaceDocuments(folderDocs, 'reports', { intent: 'omnibar' });
    const folderCount = results.filter((r) => r.document.kind === 'folder').length;
    const pageCount = results.filter((r) => r.document.kind === 'page').length;
    expect(folderCount).toBe(DEFAULT_FOLDER_RESULT_CAP);
    expect(pageCount).toBe(4); // every content page survives — only folders are capped
  });

  // Five same-named files (`data.csv`) — files appear in BOTH omnibar (capped)
  // and full_text (uncapped), so they exercise the intent gating cleanly.
  const fileDocs = ['a', 'b', 'c', 'd', 'e'].map((p) =>
    createWorkspaceSearchDocument({ kind: 'file', path: `${p}/data.csv`, modifiedTs: 0 }),
  );

  test('omnibar caps files', () => {
    const results = searchWorkspaceDocuments(fileDocs, 'data.csv', { intent: 'omnibar' });
    expect(results.filter((r) => r.document.kind === 'file').length).toBe(DEFAULT_FILE_RESULT_CAP);
  });

  test('full_text is NOT capped (content search wants every match)', () => {
    const results = searchWorkspaceDocuments(fileDocs, 'data.csv', { intent: 'full_text' });
    expect(results.filter((r) => r.document.kind === 'file').length).toBe(5);
  });

  test('the cap keeps the highest-ranked folder of its kind', () => {
    // One folder whose name is an exact match outranks partial-name folders;
    // it must survive the cap (capping keeps top-N by rank, not arbitrary ones).
    const mixed = [
      createWorkspaceSearchDocument({ kind: 'folder', path: 'x/reports', modifiedTs: 0 }),
      createWorkspaceSearchDocument({ kind: 'folder', path: 'y/reports-archive', modifiedTs: 0 }),
      createWorkspaceSearchDocument({ kind: 'folder', path: 'z/reports-old', modifiedTs: 0 }),
      createWorkspaceSearchDocument({ kind: 'folder', path: 'w/reports-draft', modifiedTs: 0 }),
    ];
    const results = searchWorkspaceDocuments(mixed, 'reports', { intent: 'omnibar' });
    const folderPaths = results
      .filter((r) => r.document.kind === 'folder')
      .map((r) => r.document.path);
    expect(folderPaths.length).toBe(DEFAULT_FOLDER_RESULT_CAP);
    expect(folderPaths).toContain('x/reports'); // the exact-name folder is retained
  });
});
