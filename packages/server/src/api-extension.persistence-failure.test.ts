import type { ServerResponse } from 'node:http';
import { describe, expect, test } from 'vitest';
import { respondPersistenceFailure } from './api-extension.ts';
import {
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
  test('an OK_STORE_REFUSED failure renders a 503 with the store-refused URN and retry guidance', () => {
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
    expect(detail).toContain('Retry');
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
  test('an OK_STORE_HELD failure renders a 503 save-held problem with its reason, cause, retry rule and a re-read next step', () => {
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
      retryWhen: 'next-save',
      causeCode: 'EBUSY',
      nextStep: 're-read',
    });
    const detail = String(body.detail);
    expect(detail).toContain('kept in the document');
    expect(detail).toContain('once the file can be read again');
    expect(detail).toContain('the idle save within a few minutes');
    expect(detail).toContain('Do not repeat this write');
    expect(detail).not.toContain('will be lost');
  });

  test.each([
    { held: { reason: 'pending-intake-failed-no-base' as const } },
    { held: { reason: 'pending-unreadable' as const, causeCode: 'EBUSY', noBase: true as const } },
  ])(
    'a hold on a document with no agreed version ($held.reason) never says the edit is saved',
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
        nextStep: 're-read',
      });
      const detail = String(body.detail);
      expect(detail).toContain('This edit is not saved to the file');
      expect(detail).toContain('replaces the document with the file on disk');
      expect(detail).toContain('document history (timeline)');
      expect(detail).toContain('re-apply this edit');
      expect(detail).not.toContain('kept in the document');
      expect(detail).not.toMatch(/saves it|writes it|is saved after/);
    },
  );

  test.each([
    {
      reason: 'pending-conflict' as const,
      retryWhen: 'conflict-resolved',
      says: 'after the conflict on this document is resolved',
      neverSays: 'idle save',
    },
    {
      reason: 'pending-intake-failed' as const,
      retryWhen: 'next-save',
      says: 'the idle save within a few minutes',
      neverSays: 'conflict',
    },
  ])('a $reason hold states its own retry rule', ({ reason, retryWhen, says, neverSays }) => {
    const { res, endCalls } = makeMockRes();
    respondPersistenceFailure(
      res,
      { code: OK_STORE_HELD, message: 'notes was not saved', held: { reason } },
      'agent-write-md',
    );
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ reason, retryWhen, nextStep: 're-read' });
    expect(String(body.detail)).toContain(says);
    expect(String(body.detail)).not.toContain(neverSays);
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
  test('an OK_STORE_DISCARDED failure renders a 409 telling the agent the edit was not saved', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const failure: StoreFailure = {
      code: OK_STORE_DISCARDED,
      message: 'A Git branch switch discarded the pending save of notes',
    };

    respondPersistenceFailure(res, failure, 'agent-patch');

    expect(writeHeadCalls[0]?.status).toBe(409);
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:branch-switched');
    expect(String(body.title)).toContain('not saved');
    expect(String(body.detail)).toContain('Re-read');
  });
});
