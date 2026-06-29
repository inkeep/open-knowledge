
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ServerResponse } from 'node:http';
import { DocInConflictError, respondDocInConflict } from './conflict-errors.ts';

const originalWarn = console.warn;
let warnCalls: string[] = [];
beforeEach(() => {
  warnCalls = [];
  console.warn = (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg === 'string') warnCalls.push(arg);
    }
  };
});
afterEach(() => {
  console.warn = originalWarn;
});

interface MockResponse {
  writeHeadCalls: Array<{ status: number; headers: Record<string, string> }>;
  endCalls: string[];
  res: ServerResponse;
}

function makeMockRes(): MockResponse {
  const writeHeadCalls: MockResponse['writeHeadCalls'] = [];
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
  return { writeHeadCalls, endCalls, res: res as unknown as ServerResponse };
}

describe('respondDocInConflict — slim RFC 9457 envelope', () => {
  test('produces HTTP 409 with application/problem+json', () => {
    const { res, writeHeadCalls } = makeMockRes();
    const err = new DocInConflictError({ file: 'docs/notes.md' });

    respondDocInConflict(res, err, 'handleAgentWriteMd');

    expect(writeHeadCalls).toHaveLength(1);
    expect(writeHeadCalls[0].status).toBe(409);
    expect(writeHeadCalls[0].headers['Content-Type']).toBe('application/problem+json');
  });

  test('body carries the exact slim wire shape — type, title, status, detail, file, resolutionOptions', () => {
    const { res, endCalls } = makeMockRes();
    const err = new DocInConflictError({ file: 'docs/notes.md' });

    respondDocInConflict(res, err, 'handleAgentWriteMd');

    expect(endCalls).toHaveLength(1);
    const body = JSON.parse(endCalls[0]) as Record<string, unknown>;

    expect(body.type).toBe('urn:ok:error:doc-in-conflict');
    expect(body.title).toBe('Document is in conflict.');
    expect(body.status).toBe(409);
    expect(body.detail).toBe(
      'The document is in a merge-conflict state. Call conflicts({ kind: "content" }) + resolve_conflict before retrying.',
    );

    expect(body.file).toBe('docs/notes.md');
    expect(body.resolutionOptions).toEqual(['mine', 'theirs', 'content', 'delete']);
  });

  test('body does NOT embed merge stages (base / ours / theirs)', () => {
    const { res, endCalls } = makeMockRes();
    const err = new DocInConflictError({ file: 'docs/notes.md' });

    respondDocInConflict(res, err, 'handleAgentWriteMd');

    const body = JSON.parse(endCalls[0]) as Record<string, unknown>;

    expect(body.base).toBeUndefined();
    expect(body.ours).toBeUndefined();
    expect(body.theirs).toBeUndefined();

    expect(body.extensions).toBeUndefined();
  });

  test('emits structured `doc-in-conflict-write-refused` log event with handler + doc.name', () => {
    const { res } = makeMockRes();
    const err = new DocInConflictError({ file: 'docs/notes.md' });

    respondDocInConflict(res, err, 'handleAgentWriteMd');

    const events = warnCalls
      .map((s) => {
        try {
          return JSON.parse(s) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (v): v is Record<string, unknown> =>
          v !== null && v.event === 'doc-in-conflict-write-refused',
      );
    expect(events).toHaveLength(1);
    expect(events[0].handler).toBe('handleAgentWriteMd');
    expect(events[0]['doc.name']).toBe('docs/notes');
  });

  test('title is exactly "Document is in conflict." verbatim', () => {
    const { res, endCalls } = makeMockRes();
    const err = new DocInConflictError({ file: 'any/path.md' });

    respondDocInConflict(res, err, 'handleAgentWrite');

    const body = JSON.parse(endCalls[0]) as Record<string, unknown>;
    expect(body.title).toBe('Document is in conflict.');
  });
});

describe('DocInConflictError', () => {
  test('carries the file payload and a discriminating name', () => {
    const err = new DocInConflictError({ file: 'a/b.md' });
    expect(err.file).toBe('a/b.md');
    expect(err.name).toBe('DocInConflictError');
    expect(err instanceof Error).toBe(true);
  });

  test('instanceof discrimination survives a rethrow chain', () => {
    const original = new DocInConflictError({ file: 'x.md' });
    function inner(): never {
      throw original;
    }
    function outer(): void {
      inner();
    }
    let caught: unknown;
    try {
      outer();
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof DocInConflictError).toBe(true);
  });
});
