import { describe, expect, test } from 'vitest';
import {
  answeredWithSuccessOnAppRoutes,
  outcomeOfSavedWrite,
  outcomeOfStoreFailure,
  REFUSAL_OUTCOMES,
} from './agent-write-outcome.ts';
import {
  OK_DOC_MOVED,
  OK_DOC_REMOVED,
  OK_PATH_UNRESOLVABLE,
  OK_SERVER_STOPPED,
  OK_STORE_DISCARDED,
  OK_STORE_HELD,
  OK_STORE_REFUSED,
  OK_WRITE_DROPPED,
  OK_WRITE_REPLACED,
  type StoreFailure,
} from './document-durability-state.ts';

const steps = (fields: { outcome: string; saved: boolean; nextStep: string }) =>
  `${fields.outcome}/${fields.saved ? 'saved' : 'unsaved'}/${fields.nextStep}`;

describe('the outcome of each refusal', () => {
  test('a mistake in the request is retried once corrected, and only the unchangeable ones say none', () => {
    expect(
      Object.fromEntries(Object.entries(REFUSAL_OUTCOMES).map(([type, f]) => [type, steps(f)])),
    ).toEqual({
      'urn:ok:error:concurrent-overwrite-refused': 'refused/unsaved/retry',
      'urn:ok:error:too-many-agent-sessions': 'refused/unsaved/retry',
      'urn:ok:error:doc-not-found': 'refused/unsaved/retry',
      'urn:ok:error:reserved-doc-name': 'refused/unsaved/retry',
      'urn:ok:error:frontmatter-malformed': 'refused/unsaved/retry',
      'urn:ok:error:frontmatter-edit-not-supported': 'refused/unsaved/retry',
      'urn:ok:error:invalid-frontmatter-patch': 'refused/unsaved/retry',
      'urn:ok:error:target-not-found': 'refused/unsaved/re-read',
      'urn:ok:error:stale-target': 'refused/unsaved/re-read',
      'urn:ok:error:doc-in-conflict': 'refused/unsaved/none',
      'urn:ok:error:stale-external-write': 'refused/unsaved/none',
    });
  });

  test.each<[string, StoreFailure, string]>([
    [
      'a held save',
      { code: OK_STORE_HELD, message: 'm', held: { reason: 'pending-unreadable' } },
      'projection-held/unsaved/re-read',
    ],
    [
      'a held save still running',
      { code: OK_STORE_HELD, message: 'm', held: { reason: 'pending-unsettled' } },
      'projection-held/unsaved/re-read',
    ],
    [
      'a file whose outside version could not go to history',
      { code: OK_STORE_HELD, message: 'm', held: { reason: 'pending-no-history-or-backup' } },
      'projection-held/unsaved/re-read',
    ],
    [
      'a file that holds bytes that are not text',
      { code: OK_STORE_HELD, message: 'm', held: { reason: 'pending-not-utf8' } },
      'refused/unsaved/none',
    ],
    ['a failed write with no errno', { message: 'm' }, 'refused/unsaved/re-read'],
    [
      'a write under a name with no file of its own',
      { code: OK_WRITE_DROPPED, message: 'm', dropped: 'legacy-name' },
      'refused/unsaved/retry',
    ],
    [
      'a write to a skill whose folder is gone',
      { code: OK_WRITE_DROPPED, message: 'm', dropped: 'container-gone' },
      'refused/unsaved/none',
    ],
    [
      'a no-base hold',
      { code: OK_STORE_HELD, message: 'm', held: { reason: 'pending-unreadable', noBase: true } },
      'refused/unsaved/none',
    ],
    [
      'a conflict hold',
      { code: OK_STORE_HELD, message: 'm', held: { reason: 'pending-conflict' } },
      'refused/unsaved/none',
    ],
    ['a carried move', { code: OK_DOC_MOVED, message: 'm' }, 'projection-held/unsaved/re-read'],
    [
      'a branch switch',
      { code: OK_STORE_DISCARDED, message: 'm' },
      'projection-held/unsaved/re-read',
    ],
    [
      'a delete',
      { code: OK_DOC_REMOVED, message: 'm', removal: { kind: 'deleted-outside' } },
      'refused/unsaved/none',
    ],
    [
      'a rename not carried',
      { code: OK_DOC_REMOVED, message: 'm', removal: { kind: 'renamed', renamedTo: 'b' } },
      'refused/unsaved/re-read',
    ],
    [
      'a shutdown with the file missing',
      { code: OK_SERVER_STOPPED, message: 'm' },
      'refused/unsaved/none',
    ],
    [
      'a shutdown during a move',
      { code: OK_SERVER_STOPPED, message: 'm', removal: { kind: 'renamed', renamedTo: 'b' } },
      'refused/unsaved/re-read',
    ],
    ['a path fault', { code: OK_PATH_UNRESOLVABLE, message: 'm' }, 'refused/unsaved/none'],
    ['a refused store', { code: OK_STORE_REFUSED, message: 'm' }, 'refused/unsaved/re-read'],
    ['a replaced write', { code: OK_WRITE_REPLACED, message: 'm' }, 'refused/unsaved/re-read'],
    ['an errno', { code: 'EACCES', message: 'm' }, 'refused/unsaved/re-read'],
  ])('%s maps to one outcome', (_name, failure, expected) => {
    expect(steps(outcomeOfStoreFailure(failure))).toBe(expected);
  });
});

describe('the routes the app also calls', () => {
  test('answer 200 only for a save still running at the end of the wait and a write the file replaced', () => {
    expect(
      answeredWithSuccessOnAppRoutes({
        code: OK_STORE_HELD,
        message: 'm',
        held: { reason: 'pending-unsettled' },
      }),
    ).toBe(true);
    expect(
      answeredWithSuccessOnAppRoutes({
        code: OK_STORE_HELD,
        message: 'm',
        held: { reason: 'pending-rename' },
      }),
    ).toBe(true);
    expect(answeredWithSuccessOnAppRoutes({ code: OK_WRITE_REPLACED, message: 'm' })).toBe(true);
    expect(
      answeredWithSuccessOnAppRoutes({
        code: OK_STORE_HELD,
        message: 'm',
        held: { reason: 'pending-unreadable' },
      }),
    ).toBe(false);
    expect(answeredWithSuccessOnAppRoutes({ code: OK_DOC_REMOVED, message: 'm' })).toBe(false);
  });
});

describe('a saved write', () => {
  test('reads both-kept over merged-first over applied, and a flush failure by its code', () => {
    expect(steps(outcomeOfSavedWrite(undefined, null))).toBe('applied/saved/none');
    expect(steps(outcomeOfSavedWrite({ reconciled: true, mergeOutcome: 'kept-live' }, null))).toBe(
      'merged-first/saved/re-read',
    );
    expect(
      steps(
        outcomeOfSavedWrite(
          { reconciled: true, mergeOutcome: 'clean' },
          { kind: 'taken-in', merge: 'both-kept' },
        ),
      ),
    ).toBe('both-kept/saved/re-read');
    expect(
      steps(
        outcomeOfSavedWrite(undefined, {
          kind: 'failure',
          failure: { code: OK_STORE_HELD, message: 'm', held: { reason: 'pending-unsettled' } },
        }),
      ),
    ).toBe('projection-held/unsaved/re-read');
  });
});
