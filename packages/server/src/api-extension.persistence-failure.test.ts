import type { ServerResponse } from 'node:http';
import { describe, expect, test } from 'vitest';
import { respondPersistenceFailure } from './api-extension.ts';
import { OK_STORE_REFUSED, type StoreFailure } from './document-durability-state.ts';

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
