/**
 * `methodRouter(...)` dispatch + the preserved 405 wire shape (RFC 9457
 * problem+json, `Allow` header in declaration order, handler tag).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, test } from 'vitest';
import { methodRouter } from './method-router.ts';

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
  };
  return { res: res as unknown as ServerResponse, writeHeadCalls, endCalls };
}

function makeReq(method: string | undefined): IncomingMessage {
  return { method } as IncomingMessage;
}

describe('methodRouter', () => {
  test('dispatches to the matching verb handler and awaits it', async () => {
    const calls: string[] = [];
    const router = methodRouter(
      {
        GET: async () => {
          calls.push('GET');
        },
        PUT: async () => {
          calls.push('PUT');
        },
      },
      { handler: 'test-route' },
    );
    const { res } = makeMockRes();
    await router(makeReq('PUT'), res);
    expect(calls).toEqual(['PUT']);
  });

  test('unknown verb emits the historical 405 problem+json with Allow in declaration order', async () => {
    const router = methodRouter(
      { GET: async () => {}, PUT: async () => {}, POST: async () => {}, DELETE: async () => {} },
      { handler: 'test-route' },
    );
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    await router(makeReq('PATCH'), res);
    expect(writeHeadCalls).toHaveLength(1);
    expect(writeHeadCalls[0]?.status).toBe(405);
    expect(writeHeadCalls[0]?.headers.Allow).toBe('GET, PUT, POST, DELETE');
    expect(writeHeadCalls[0]?.headers['Content-Type']).toBe('application/problem+json');
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:method-not-allowed');
    expect(body.title).toBe('Method not allowed.');
    expect(body.status).toBe(405);
  });

  test('missing req.method falls through to the 405', async () => {
    const router = methodRouter({ GET: async () => {} }, { handler: 'test-route' });
    const { res, writeHeadCalls } = makeMockRes();
    await router(makeReq(undefined), res);
    expect(writeHeadCalls[0]?.status).toBe(405);
    expect(writeHeadCalls[0]?.headers.Allow).toBe('GET');
  });

  test('HEAD is not implicitly mapped to GET (historical dispatcher behavior)', async () => {
    const router = methodRouter({ GET: async () => {} }, { handler: 'test-route' });
    const { res, writeHeadCalls } = makeMockRes();
    await router(makeReq('HEAD'), res);
    expect(writeHeadCalls[0]?.status).toBe(405);
  });
});
