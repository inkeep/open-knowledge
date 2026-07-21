/**
 * `catchErrors(...)` boundary behavior: typed 500 emission with `cause`,
 * variadic pass-through composition with `withValidation`, and the STOP-rule
 * guarantee that `BridgeMergeContentLossError` is NEVER swallowed (its single
 * sanctioned catch site is Observer A Path B in `server-observers.ts`).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { BridgeMergeContentLossError } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { catchErrors } from './catch-errors.ts';

function makeMockRes(opts: { headersSent?: boolean } = {}) {
  const writeHeadCalls: Array<{ status: number; headers: Record<string, string> }> = [];
  const endCalls: string[] = [];
  const res = {
    headersSent: opts.headersSent ?? false,
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

const req = {} as IncomingMessage;

function makeContentLossError(): BridgeMergeContentLossError {
  return new BridgeMergeContentLossError({
    baseline: 'a',
    userText: 'b',
    agentText: 'c',
    result: 'd',
    lostSubstrings: ['b'],
    which: 'substring',
    side: 'user',
  });
}

describe('catchErrors', () => {
  test('success path passes through without touching the response', async () => {
    const { res, writeHeadCalls } = makeMockRes();
    let sawBody: unknown;
    const wrapped = catchErrors(
      async (_req, _res, body: { x: number }) => {
        sawBody = body;
      },
      { handler: 'test-handler' },
    );
    await wrapped(req, res, { x: 42 });
    expect(sawBody).toEqual({ x: 42 });
    expect(writeHeadCalls).toHaveLength(0);
  });

  test('generic throw emits an RFC 9457 500 with the handler title', async () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const wrapped = catchErrors(
      async () => {
        throw new Error('disk exploded');
      },
      { handler: 'test-handler', title: 'Failed to list widgets.' },
    );
    await wrapped(req, res);
    expect(writeHeadCalls).toHaveLength(1);
    expect(writeHeadCalls[0]?.status).toBe(500);
    expect(writeHeadCalls[0]?.headers['Content-Type']).toBe('application/problem+json');
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:internal-server-error');
    expect(body.title).toBe('Failed to list widgets.');
    expect(body.status).toBe(500);
    expect(String(body.instance)).toMatch(/^urn:uuid:/);
  });

  test('title defaults to the generic internal-server-error copy', async () => {
    const { res, endCalls } = makeMockRes();
    const wrapped = catchErrors(
      () => {
        throw new Error('boom');
      },
      { handler: 'test-handler' },
    );
    await wrapped(req, res);
    const body = JSON.parse(endCalls[0] ?? '{}') as Record<string, unknown>;
    expect(body.title).toBe('Internal server error.');
  });

  test('non-Error throw values still produce the typed 500', async () => {
    const { res, writeHeadCalls } = makeMockRes();
    const stringFailure: unknown = 'string failure';
    const wrapped = catchErrors(
      () => {
        throw stringFailure;
      },
      { handler: 'test-handler' },
    );
    await wrapped(req, res);
    expect(writeHeadCalls[0]?.status).toBe(500);
  });

  test('STOP rule: BridgeMergeContentLossError passes through uncaught, response untouched', async () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const loss = makeContentLossError();
    const wrapped = catchErrors(
      async () => {
        throw loss;
      },
      { handler: 'test-handler' },
    );
    await expect(wrapped(req, res)).rejects.toBe(loss);
    expect(writeHeadCalls).toHaveLength(0);
    expect(endCalls).toHaveLength(0);
  });

  test('STOP rule: name-matched content-loss error from a foreign class identity also passes through', async () => {
    // Two loaded copies of core would break `instanceof`; the wrapper's
    // name-based companion check must keep the pass-through guarantee.
    const { res, writeHeadCalls } = makeMockRes();
    const foreign = new Error('bridge loss (foreign identity)');
    foreign.name = 'BridgeMergeContentLossError';
    const wrapped = catchErrors(
      () => {
        throw foreign;
      },
      { handler: 'test-handler' },
    );
    await expect(wrapped(req, res)).rejects.toBe(foreign);
    expect(writeHeadCalls).toHaveLength(0);
  });

  test('throw after the response is committed suppresses the double-write', async () => {
    const { res, writeHeadCalls } = makeMockRes({ headersSent: true });
    const wrapped = catchErrors(
      () => {
        throw new Error('late failure');
      },
      { handler: 'test-handler' },
    );
    await wrapped(req, res);
    // errorResponse's internal triple-guard owns this case: no second head.
    expect(writeHeadCalls).toHaveLength(0);
  });
});
