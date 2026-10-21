import { describe, expect, test } from 'vitest';
import { usableFileIdentity } from './file-watcher.ts';
import {
  type CreateCandidate,
  RECENT_CREATE_WINDOW_MS,
  type RecentCreate,
  sharesMostLines,
  type VanishedDocument,
  VanishedDocuments,
} from './vanished-documents.ts';
import { contentHash } from './version-hash.ts';

const NOTES_TEXT = '# Notes\n\nFirst point.\n\nSecond point.\n';
const NOTES = contentHash(NOTES_TEXT);
const OTHER_TEXT = '# Shopping\n\nMilk.\n\nBread.\n';
const OTHER = contentHash(OTHER_TEXT);
const EMPTY = contentHash('');
const WRITTEN = '2026-10-20T10:00:00.000Z';
const LATER = '2026-10-20T10:05:00.000Z';

function vanished(docName: string, overrides: Partial<VanishedDocument> = {}): VanishedDocument {
  return {
    docName,
    path: `/content/${docName}.md`,
    identity: undefined,
    size: NOTES_TEXT.length,
    modified: WRITTEN,
    hashes: new Set([NOTES]),
    text: NOTES_TEXT,
    afterPass: 0,
    heldAt: 0,
    ...overrides,
  };
}

function created(docName: string, overrides: Partial<CreateCandidate> = {}): CreateCandidate {
  return {
    docName,
    identity: undefined,
    size: OTHER_TEXT.length,
    modified: LATER,
    hash: OTHER,
    content: OTHER_TEXT,
    ...overrides,
  };
}

function recent(docName: string, overrides: Partial<RecentCreate> = {}): RecentCreate {
  return {
    docName,
    path: `/content/${docName}.md`,
    identity: undefined,
    size: OTHER_TEXT.length,
    modified: LATER,
    hash: OTHER,
    at: 1_000,
    ...overrides,
  };
}

describe('pairing a create with a vanished document', () => {
  test('a create at the same name is the file coming back', () => {
    const pending = new VanishedDocuments();
    pending.hold(vanished('notes', { identity: '1:10' }));

    const match = pending.matchCreate(created('notes', { identity: '1:99' }));
    expect(match?.by).toBe('same-name');
    expect(match?.vanished.docName).toBe('notes');
  });

  test('a recycled inode on an unrelated new file does not pair', () => {
    const pending = new VanishedDocuments();
    pending.hold(vanished('removed', { identity: '1:10' }));

    expect(pending.matchCreate(created('external', { identity: '1:10' }))).toBe(undefined);
  });

  test('the same file, unchanged in size and modification time, pairs by identity', () => {
    const pending = new VanishedDocuments();
    pending.hold(vanished('moved', { identity: '1:10' }));

    const match = pending.matchCreate(
      created('elsewhere/moved', {
        identity: '1:10',
        size: NOTES_TEXT.length,
        modified: WRITTEN,
        hash: contentHash('different bytes of the same size'),
        content: 'different bytes of the same size',
      }),
    );
    expect(match).toEqual({
      vanished: expect.objectContaining({ docName: 'moved' }),
      by: 'identity',
    });
  });

  test('the same file moved and edited pairs by identity when it keeps most of its lines', () => {
    const pending = new VanishedDocuments();
    pending.hold(vanished('moved', { identity: '1:10' }));
    const edited = `${NOTES_TEXT}\nThird point, added outside.\n`;

    const match = pending.matchCreate(
      created('archive/moved', {
        identity: '1:10',
        size: edited.length,
        hash: contentHash(edited),
        content: edited,
      }),
    );
    expect(match?.by).toBe('identity');
  });

  test('content pairs only when exactly one vanished document has those non-empty bytes', () => {
    const pending = new VanishedDocuments();
    pending.hold(vanished('first'));
    expect(pending.matchCreate(created('renamed', { hash: NOTES, content: NOTES_TEXT }))?.by).toBe(
      'hash',
    );

    pending.hold(vanished('second'));
    expect(pending.matchCreate(created('renamed', { hash: NOTES, content: NOTES_TEXT }))).toBe(
      undefined,
    );

    pending.hold(vanished('blank', { hashes: new Set([EMPTY]) }));
    expect(pending.matchCreate(created('renamed', { hash: EMPTY, content: '' }))).toBe(undefined);
  });

  test('a vanished document is due once a pass that started after it has completed, and its hold age is known', () => {
    const pending = new VanishedDocuments();
    pending.hold(vanished('notes', { afterPass: 3, heldAt: 5_000 }));

    expect(pending.dueAfter(3)).toEqual([]);
    expect(pending.dueAfter(4).map((entry) => entry.docName)).toEqual(['notes']);
    expect(pending.heldBefore(4_999)).toEqual([]);
    expect(pending.heldBefore(5_000).map((entry) => entry.docName)).toEqual(['notes']);
    expect(pending.has('notes')).toBe(true);
    pending.release('notes');
    expect(pending.has('notes')).toBe(false);
    expect(pending.size).toBe(0);
  });
});

describe('pairing a delete with a create that arrived first', () => {
  test('a recent create of the same, unchanged file pairs by identity and is used once', () => {
    const pending = new VanishedDocuments();
    pending.rememberCreate(
      recent('renamed', { identity: '1:10', size: NOTES_TEXT.length, modified: WRITTEN }),
    );
    const read = () => {
      throw new Error('an unchanged file is not read');
    };

    const match = pending.matchRecentCreate(vanished('notes', { identity: '1:10' }), 2_000, read);
    expect(match?.by).toBe('identity');
    expect(match?.create.docName).toBe('renamed');
    expect(pending.matchRecentCreate(vanished('notes', { identity: '1:10' }), 2_000, read)).toBe(
      undefined,
    );
  });

  test('a recent create on a recycled inode with unrelated content does not pair', () => {
    const pending = new VanishedDocuments();
    pending.rememberCreate(recent('external', { identity: '1:10' }));

    expect(
      pending.matchRecentCreate(vanished('removed', { identity: '1:10' }), 2_000, () => OTHER_TEXT),
    ).toBe(undefined);
  });

  test('a recent create whose content cannot be read pairs only by identity with unchanged facts', () => {
    const pending = new VanishedDocuments();
    pending.rememberCreate(recent('renamed', { identity: '1:10' }));

    expect(
      pending.matchRecentCreate(vanished('notes', { identity: '1:10' }), 2_000, () => undefined),
    ).toBe(undefined);
  });

  test('a recent create pairs by content only when it is the one create with those bytes', () => {
    const pending = new VanishedDocuments();
    pending.rememberCreate(recent('copy-a', { hash: NOTES }));
    expect(
      pending.matchRecentCreate(vanished('notes'), 1_500, () => NOTES_TEXT)?.create.docName,
    ).toBe('copy-a');

    pending.rememberCreate(recent('copy-b', { hash: NOTES }));
    pending.rememberCreate(recent('copy-c', { hash: NOTES }));
    expect(pending.matchRecentCreate(vanished('notes'), 1_500, () => NOTES_TEXT)).toBe(undefined);
  });

  test('a create at the same name or older than the window does not pair', () => {
    const pending = new VanishedDocuments();
    const unchanged = { identity: '1:10', size: NOTES_TEXT.length, modified: WRITTEN, hash: NOTES };
    pending.rememberCreate(recent('notes', unchanged));
    expect(
      pending.matchRecentCreate(vanished('notes', { identity: '1:10' }), 1_500, () => NOTES_TEXT),
    ).toBe(undefined);

    pending.rememberCreate(recent('renamed', unchanged));
    expect(
      pending.matchRecentCreate(
        vanished('notes', { identity: '1:10' }),
        1_000 + RECENT_CREATE_WINDOW_MS + 1,
        () => NOTES_TEXT,
      ),
    ).toBe(undefined);
  });
});

describe('what counts as the same file', () => {
  test('an empty or zero inode number is no identity', () => {
    expect(usableFileIdentity('16777232:4512')).toBe('16777232:4512');
    expect(usableFileIdentity('16777232:0')).toBe(undefined);
    expect(usableFileIdentity('')).toBe(undefined);
    expect(usableFileIdentity(undefined)).toBe(undefined);
  });

  test('two texts share most lines when at least half of the longer one is shared', () => {
    expect(sharesMostLines(NOTES_TEXT, `${NOTES_TEXT}\nOne more line.\n`)).toBe(true);
    expect(sharesMostLines(NOTES_TEXT, OTHER_TEXT)).toBe(false);
    expect(sharesMostLines('', '')).toBe(false);
  });
});
