import type { ServerResponse } from 'node:http';
import { describe, expect, test } from 'vitest';
import { respondPersistenceFailure } from './api-extension.ts';
import {
  OK_DOC_MOVED,
  OK_DOC_REMOVED,
  OK_SERVER_STOPPED,
  OK_STORE_DISCARDED,
  OK_STORE_HELD,
  OK_STORE_REFUSED,
  type StoreFailure,
} from './document-durability-state.ts';

function makeMockRes() {
  const writeHeadCalls: Array<{ status: number; headers: Record<string, string> }> = [];
  const endCalls: string[] = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status: number, headers: Record<string, string>) {
      writeHeadCalls.push({ status, headers });
      return res;
    },
    end(body: string) {
      endCalls.push(body);
      return res;
    },
    write() {
      return true;
    },
  };
  return { res: res as unknown as ServerResponse, writeHeadCalls, endCalls };
}

describe('respondPersistenceFailure — store-refused', () => {
  test('an OK_STORE_REFUSED failure renders a 503 with the store-refused URN and re-read guidance', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const failure: StoreFailure = {
      code: OK_STORE_REFUSED,
      message: 'duplication tripwire baseline unavailable for notes; store refused (fail-closed)',
    };

    respondPersistenceFailure(res, failure, 'agent-write-md');

    expect(writeHeadCalls).toHaveLength(1);
    expect(writeHeadCalls[0]?.status).toBe(503);
    expect(endCalls).toHaveLength(1);
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:store-refused');
    expect(body.title).toBe(
      'Edit applied in memory; disk write refused because the duplication baseline could not be read.',
    );
    const detail = String(body.detail);
    expect(detail).toContain('recovery buffer');
    expect(detail).toContain('filesystem fault');
    expect(detail).toContain('repeat the edit only if it is missing');
    expect(detail).not.toContain('Retry the write');
    expect(body).toMatchObject({ outcome: 'refused', saved: false, nextStep: 're-read' });
  });

  test('a non-refusal failure keeps the generic upload rendering instead of the 503', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const failure: StoreFailure = { code: 'EACCES', message: 'permission denied' };

    respondPersistenceFailure(res, failure, 'agent-write-md');

    expect(writeHeadCalls[0]?.status).not.toBe(503);
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body.type).not.toBe('urn:ok:error:store-refused');
  });
});

describe('respondPersistenceFailure: a held save', () => {
  test('an OK_STORE_HELD failure renders a 503 save-held problem with its reason, cause and the projection-held outcome', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const failure: StoreFailure = {
      code: OK_STORE_HELD,
      message: 'notes was not saved: its file could not be read for the compare before the write',
      held: { reason: 'pending-unreadable', causeCode: 'EBUSY' },
    };

    respondPersistenceFailure(res, failure, 'agent-write-md');

    expect(writeHeadCalls[0]?.status).toBe(503);
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      type: 'urn:ok:error:save-held',
      title: 'Edit applied in memory; its save to disk is held.',
      reason: 'pending-unreadable',
      causeCode: 'EBUSY',
      outcome: 'projection-held',
      saved: false,
      nextStep: 're-read',
    });
    expect(body).toMatchObject({ retryWhen: 'next-save' });
    const detail = String(body.detail);
    expect(detail).toContain('kept in the document');
    expect(detail).toContain('once the file can be read again');
    expect(detail).toContain('the idle save within a few minutes');
    expect(detail).toContain('Do not repeat this write');
    expect(detail).not.toContain('will be lost');
  });

  test.each([
    { held: { reason: 'pending-intake-failed-no-base' as const, noBase: true as const } },
    { held: { reason: 'pending-unreadable' as const, causeCode: 'EBUSY', noBase: true as const } },
  ])(
    'a hold on a file with no agreed version ($held.reason) is refused and says any further write replaces it',
    ({ held }) => {
      const { res, endCalls } = makeMockRes();
      respondPersistenceFailure(
        res,
        { code: OK_STORE_HELD, message: 'notes was not saved', held },
        'agent-write-md',
      );
      const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
      expect(body).toMatchObject({
        type: 'urn:ok:error:save-held',
        reason: held.reason,
        retryWhen: 'replaced-on-next-edit',
        outcome: 'refused',
        saved: false,
        nextStep: 'none',
      });
      const detail = String(body.detail);
      expect(detail).toContain('is not saved to the file');
      expect(detail).toContain('yours included');
      expect(detail).toContain('replaces the document with the file on disk');
      expect(detail).toContain('document history (timeline)');
      expect(detail).toContain('tell the user');
      expect(detail).not.toContain('re-read the document before editing it further');
      expect(detail).not.toMatch(/saves it|writes it|is saved after/);
    },
  );

  test.each([
    {
      reason: 'pending-conflict' as const,
      outcome: {
        outcome: 'refused',
        saved: false,
        nextStep: 'none',
        retryWhen: 'conflict-resolved',
      },
      says: 'tell the user which file it is',
      neverSays: 'idle save',
    },
    {
      reason: 'pending-intake-failed' as const,
      outcome: {
        outcome: 'projection-held',
        saved: false,
        nextStep: 're-read',
        retryWhen: 'next-save',
      },
      says: 'the idle save within a few minutes',
      neverSays: 'conflict',
    },
    {
      reason: 'pending-unsettled' as const,
      outcome: {
        outcome: 'projection-held',
        saved: false,
        nextStep: 're-read',
        retryWhen: 'next-save',
      },
      says: 'finishes on its own',
      neverSays: 'idle save',
    },
  ])('a $reason hold states its own rule and outcome', ({ reason, outcome, says, neverSays }) => {
    const { res, endCalls } = makeMockRes();
    respondPersistenceFailure(
      res,
      { code: OK_STORE_HELD, message: 'notes was not saved', held: { reason } },
      'agent-write-md',
    );
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ reason, ...outcome });
    expect(String(body.detail)).toContain(says);
    expect(String(body.detail)).not.toContain(neverSays);
  });

  test('a not-UTF-8 hold says only a person ends it, in every field, and carries no retryWhen', () => {
    const { res, endCalls } = makeMockRes();
    respondPersistenceFailure(
      res,
      { code: OK_STORE_HELD, message: 'chart was not saved', held: { reason: 'pending-not-utf8' } },
      'agent-write-md',
    );
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      reason: 'pending-not-utf8',
      outcome: 'refused',
      saved: false,
      nextStep: 'none',
    });
    expect(body).not.toHaveProperty('retryWhen');
    expect(String(body.detail)).toContain(
      'no save runs until someone saves the file as text again',
    );
    expect(String(body.detail)).not.toContain('re-read the document before editing it further');
  });

  test('a held save with no errno names its reason and carries no cause code', () => {
    const { res, endCalls } = makeMockRes();
    const failure: StoreFailure = {
      code: OK_STORE_HELD,
      message: 'notes was not saved: its file kept changing while it was being saved',
      held: { reason: 'pending-exhausted' },
    };

    respondPersistenceFailure(res, failure, 'agent-patch');

    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:save-held');
    expect(body.reason).toBe('pending-exhausted');
    expect(body).not.toHaveProperty('causeCode');
    expect(String(body.detail)).toContain('once the file stops changing');
  });
});

describe('respondPersistenceFailure: store discarded by a branch switch', () => {
  test('an OK_STORE_DISCARDED failure renders a 409 telling the agent the edit stays in the open document', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const failure: StoreFailure = {
      code: OK_STORE_DISCARDED,
      message: 'A Git branch switch discarded the pending save of notes',
    };

    respondPersistenceFailure(res, failure, 'agent-patch');

    expect(writeHeadCalls[0]?.status).toBe(409);
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:branch-switched');
    expect(String(body.title)).toContain('kept in the open document');
    expect(String(body.detail)).toContain('do not repeat the edit');
  });
});

describe('respondPersistenceFailure: the save of a document whose file went missing', () => {
  test('a move followed outside the app renders a 409 doc-moved that names the new name', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const failure: StoreFailure = {
      code: OK_DOC_MOVED,
      message: 'notes was moved outside the app to archive/notes, and its open document followed',
      removal: { kind: 'renamed', renamedTo: 'archive/notes' },
    };

    respondPersistenceFailure(res, failure, 'agent-write-md');

    expect(writeHeadCalls[0]?.status).toBe(409);
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:doc-moved');
    expect(String(body.detail)).toContain('archive/notes');
    expect(String(body.detail)).toContain('Do not repeat the edit');
  });

  test('a delete that stood renders a 409 doc-removed saying the edit is in the history', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const failure: StoreFailure = {
      code: OK_DOC_REMOVED,
      message: 'notes was deleted outside the app before the edit reached disk',
      removal: { kind: 'deleted-outside' },
    };

    respondPersistenceFailure(res, failure, 'agent-write-md');

    expect(writeHeadCalls[0]?.status).toBe(409);
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:doc-removed');
    expect(String(body.title)).toContain('deleted outside the app');
    expect(String(body.detail)).toContain('history');
  });

  test('a shutdown while a move was being carried names the new path and says re-read there', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    respondPersistenceFailure(
      res,
      {
        code: OK_SERVER_STOPPED,
        message: 'The server stopped while notes was being moved outside the app to archive/notes',
        removal: { kind: 'renamed', renamedTo: 'archive/notes' },
      },
      'agent-write-md',
    );

    expect(writeHeadCalls[0]?.status).toBe(503);
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      type: 'urn:ok:error:server-stopped',
      outcome: 'refused',
      saved: false,
      nextStep: 're-read',
    });
    expect(String(body.detail)).toContain('re-read the document at archive/notes');
    expect(String(body.detail)).toContain('Do not re-create the document under its old name');
    expect(String(body.detail)).not.toContain('re-create the document with write');
  });

  test('a rename carry still running when the write stops waiting names the new path', () => {
    const { res, endCalls } = makeMockRes();
    respondPersistenceFailure(
      res,
      {
        code: OK_STORE_HELD,
        message:
          'notes was still being moved outside the app to archive/notes when the write stopped waiting',
        held: { reason: 'pending-rename' },
      },
      'agent-write-md',
    );
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ reason: 'pending-rename', outcome: 'projection-held' });
    expect(String(body.detail)).toContain('archive/notes');
    expect(String(body.detail)).toContain('re-read it at its new name');
    expect(String(body.detail)).toContain('do not re-create the document under its old name');
  });

  test('a shutdown while the file was missing renders a 503 server-stopped', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const failure: StoreFailure = {
      code: OK_SERVER_STOPPED,
      message: 'The server stopped while the file of notes was missing',
    };

    respondPersistenceFailure(res, failure, 'agent-write-md');

    expect(writeHeadCalls[0]?.status).toBe(503);
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:server-stopped');
    expect(String(body.detail)).toContain('history');
  });
});

describe('respondPersistenceFailure: a document renamed outside the app', () => {
  test('an OK_DOC_MOVED failure renders doc-moved without the re-apply instruction', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    respondPersistenceFailure(
      res,
      {
        code: OK_DOC_MOVED,
        message: 'notes was renamed to archive/notes on disk',
        removal: { kind: 'renamed', renamedTo: 'archive/notes' },
      },
      'agent-write-md',
    );

    expect(writeHeadCalls[0]?.status).toBe(409);
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:doc-moved');
    expect(String(body.detail)).toContain('Do not repeat the edit');
    expect(String(body.detail)).not.toContain('re-apply');
  });

  test('an OK_DOC_REMOVED renamed failure renders doc-removed asking to re-apply at the new name', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    respondPersistenceFailure(
      res,
      {
        code: OK_DOC_REMOVED,
        message: 'notes was renamed to archive/notes on disk',
        removal: { kind: 'renamed', renamedTo: 'archive/notes' },
      },
      'agent-write-md',
    );

    expect(writeHeadCalls[0]?.status).toBe(409);
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:doc-removed');
    expect(String(body.detail)).toContain('re-apply your change there');
  });
});
