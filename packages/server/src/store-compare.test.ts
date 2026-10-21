import {
  type BigIntStats,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ObservedFileRead } from './fs-traced.ts';
import {
  classifyIntakeAgainstReceipt,
  compareDiskBeforeReplace,
  isTransientReadError,
  observationOf,
  readObservedText,
  receiptIntakeSkipOf,
  restatFile,
} from './store-compare.ts';
import { contentHash } from './version-hash.ts';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ok-store-compare-'));
  path = join(dir, 'doc.md');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BASE = '# Doc\n\nagreed\n';
const CANDIDATE = '# Doc\n\nagreed\n\ntyped here\n';

function compare(overrides: Partial<Parameters<typeof compareDiskBeforeReplace>[0]> = {}) {
  return compareDiskBeforeReplace({
    path,
    receiptHash: contentHash(BASE),
    baseHash: contentHash(BASE),
    candidateHash: contentHash(CANDIDATE),
    ...overrides,
  });
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('compareDiskBeforeReplace', () => {
  test('a file equal to the receipt matches and reports the identity it was read with', () => {
    writeFileSync(path, BASE);
    const outcome = compare();
    expect(outcome.kind).toBe('match');
    if (outcome.kind !== 'match') return;
    expect(outcome.observation).toEqual(observationOf(statSync(path, { bigint: true })));
  });

  test('a file that already holds the candidate matches', () => {
    writeFileSync(path, CANDIDATE);
    expect(compare().kind).toBe('match');
  });

  test('a whitespace-only outside change the bridge normalizer tolerates is still a change', () => {
    writeFileSync(path, '# Doc\n\nagreed   \n');
    expect(compare()).toEqual({
      kind: 'changed',
      text: '# Doc\n\nagreed   \n',
      lossless: true,
      observation: observationOf(statSync(path, { bigint: true })),
    });
  });

  test('an outside change that is not valid UTF-8 is reported as not lossless', () => {
    writeFileSync(path, Buffer.from('\ufeffoutside\r\n', 'utf16le'));
    const outcome = compare();
    expect(outcome.kind).toBe('changed');
    if (outcome.kind !== 'changed') return;
    expect(outcome.lossless).toBe(false);
  });

  test('a line-ending-only outside change is a change', () => {
    writeFileSync(path, BASE.replaceAll('\n', '\r\n'));
    expect(compare().kind).toBe('changed');
  });

  test('without a receipt the in-memory base is the agreed state', () => {
    writeFileSync(path, BASE);
    expect(compare({ receiptHash: undefined }).kind).toBe('match');
    writeFileSync(path, 'outside\n');
    expect(compare({ receiptHash: undefined }).kind).toBe('changed');
  });

  test('without a receipt or a base any other file is a change', () => {
    writeFileSync(path, BASE);
    expect(compare({ receiptHash: undefined, baseHash: undefined }).kind).toBe('changed');
  });

  test('a file equal to the base but not the receipt is drift, not a change', () => {
    writeFileSync(path, BASE);
    expect(compare({ receiptHash: contentHash('something else') }).kind).toBe('drift');
  });

  test('a missing file is absent', () => {
    expect(compare()).toEqual({ kind: 'absent' });
  });

  test('a directory in the way is unreadable and not transient', () => {
    const outcome = compareDiskBeforeReplace(
      {
        path: dir,
        receiptHash: undefined,
        baseHash: undefined,
        candidateHash: contentHash(CANDIDATE),
      },
      undefined,
      'linux',
    );
    expect(outcome).toMatchObject({ kind: 'unreadable', transient: false });
  });

  test('a busy file is unreadable and transient', () => {
    const outcome = compareDiskBeforeReplace(
      {
        path,
        receiptHash: undefined,
        baseHash: undefined,
        candidateHash: '',
      },
      () => {
        throw errno('EBUSY');
      },
    );
    expect(outcome).toMatchObject({ kind: 'unreadable', transient: true });
  });

  test('a file that changes during the read is unreadable and transient', () => {
    writeFileSync(path, BASE);
    const before = statSync(path, { bigint: true });
    const changing: ObservedFileRead = {
      bytes: Buffer.from(BASE),
      before,
      after: { ...before, size: before.size + 1n } as BigIntStats,
    };
    const outcome = compareDiskBeforeReplace(
      { path, receiptHash: contentHash(BASE), baseHash: undefined, candidateHash: '' },
      () => changing,
    );
    expect(outcome).toMatchObject({ kind: 'unreadable', transient: true });
  });
});

describe('readObservedText', () => {
  test('reads the text with its observation, and says whether the bytes survive a UTF-8 round trip', () => {
    writeFileSync(path, 'caf\u00e9\n', 'utf-8');
    expect(readObservedText(path)).toEqual({
      kind: 'read',
      text: 'caf\u00e9\n',
      lossless: true,
      observation: observationOf(statSync(path, { bigint: true })),
    });

    writeFileSync(path, Buffer.from('caf\u00e9\n', 'latin1'));
    expect(readObservedText(path)).toMatchObject({ kind: 'read', lossless: false });
  });

  test('a missing file is absent and any other read error is a failure', () => {
    expect(readObservedText(join(dir, 'missing.md'))).toEqual({ kind: 'absent' });
    const failure = errno('EACCES');
    expect(
      readObservedText(path, () => {
        throw failure;
      }),
    ).toEqual({ kind: 'failed', error: failure });
  });
});

describe('isTransientReadError', () => {
  test.each([
    ['EBUSY', 'linux', true],
    ['EAGAIN', 'darwin', true],
    ['EMFILE', 'linux', true],
    ['EPERM', 'win32', true],
    ['EACCES', 'win32', true],
    ['EPERM', 'linux', false],
    ['EACCES', 'darwin', false],
    ['EISDIR', 'win32', false],
  ] as const)('%s on %s is transient: %s', (code, platform, expected) => {
    expect(isTransientReadError(errno(code), platform)).toBe(expected);
  });

  test('an error without a code is not transient', () => {
    expect(isTransientReadError(new Error('boom'), 'win32')).toBe(false);
  });
});

describe('restatFile', () => {
  test('an untouched file is the same file', () => {
    writeFileSync(path, BASE);
    expect(restatFile(path, observationOf(statSync(path, { bigint: true })))).toEqual({
      kind: 'same',
    });
  });

  test('a rewrite with a different size moved', () => {
    writeFileSync(path, BASE);
    const observed = observationOf(statSync(path, { bigint: true }));
    writeFileSync(path, `${BASE}more\n`);
    expect(restatFile(path, observed)).toEqual({ kind: 'moved' });
  });

  test('a same-size rewrite with a new modification time moved', () => {
    writeFileSync(path, BASE);
    const observed = observationOf(statSync(path, { bigint: true }));
    writeFileSync(path, BASE.toUpperCase());
    utimesSync(path, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    expect(restatFile(path, observed)).toEqual({ kind: 'moved' });
  });

  test('a file replaced by another file with the same bytes moved', () => {
    writeFileSync(path, BASE);
    const observed = observationOf(statSync(path, { bigint: true }));
    const other = join(dir, 'other.md');
    writeFileSync(other, BASE);
    renameSync(other, path);
    expect(restatFile(path, observed)).toEqual({ kind: 'moved' });
  });

  test('a file created where none was observed moved, and an absent path is the same absence', () => {
    expect(restatFile(path, null)).toEqual({ kind: 'same' });
    expect(restatFile(join(path, 'below-a-file'), null)).toEqual({ kind: 'same' });
    writeFileSync(path, BASE);
    expect(restatFile(join(path, 'below-a-file'), null)).toEqual({ kind: 'same' });
    expect(restatFile(path, null)).toEqual({ kind: 'moved' });
  });

  test('a stat error that is not an absence is reported as a failure with its errno, not as a race', () => {
    const outcome = restatFile(`${dir}/${'x'.repeat(5000)}`, null);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect((outcome.error as NodeJS.ErrnoException).code).toBe('ENAMETOOLONG');
  });
});

describe('receiptIntakeSkipOf', () => {
  test('maps every decision to its counter key or to no skip', () => {
    expect(receiptIntakeSkipOf('own-write')).toBe('echo');
    expect(receiptIntakeSkipOf('superseded')).toBe('superseded');
    expect(receiptIntakeSkipOf('outside')).toBeNull();
  });
});

describe('classifyIntakeAgainstReceipt', () => {
  const receiptHash = contentHash('newest own write\n');

  test('an event carrying the receipt bytes is our own write', () => {
    expect(
      classifyIntakeAgainstReceipt({
        receiptHash,
        eventHash: receiptHash,
        isRecentOwnWrite: true,
        readDiskHash: () => {
          throw new Error('no read needed');
        },
      }),
    ).toBe('own-write');
  });

  test('an older own write delivered after a newer one is superseded when disk holds the newer one', () => {
    expect(
      classifyIntakeAgainstReceipt({
        receiptHash,
        eventHash: contentHash('older own write\n'),
        isRecentOwnWrite: true,
        readDiskHash: () => receiptHash,
      }),
    ).toBe('superseded');
  });

  test('an older own write that is on disk again is an outside change', () => {
    const older = contentHash('older own write\n');
    expect(
      classifyIntakeAgainstReceipt({
        receiptHash,
        eventHash: older,
        isRecentOwnWrite: true,
        readDiskHash: () => older,
      }),
    ).toBe('outside');
  });

  test('bytes we never wrote are an outside change', () => {
    expect(
      classifyIntakeAgainstReceipt({
        receiptHash,
        eventHash: contentHash('outside\n'),
        isRecentOwnWrite: false,
        readDiskHash: () => receiptHash,
      }),
    ).toBe('outside');
  });

  test('without a receipt every event is an outside change', () => {
    expect(
      classifyIntakeAgainstReceipt({
        receiptHash: undefined,
        eventHash: receiptHash,
        isRecentOwnWrite: true,
        readDiskHash: () => receiptHash,
      }),
    ).toBe('outside');
  });
});
