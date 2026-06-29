import { describe, expect, mock, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  type HandleSpawnCursorDeps,
  handleSpawnCursor,
  isPathWithinDir,
  type SpawnCursorOutcome,
} from './spawn-cursor-api.ts';

const CONTENT_DIR = '/Users/who/dragons';
const VALID_PATH = '/Users/who/dragons';
const NESTED_PATH = '/Users/who/dragons/specs/foo';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function makeReq(
  method: string,
  body?: string | object,
  opts: { contentLengthOverride?: number } = {},
): IncomingMessage {
  const text =
    typeof body === 'string' ? body : body !== undefined ? JSON.stringify(body) : undefined;
  const stream = Readable.from(text !== undefined ? [Buffer.from(text)] : []);
  const req = stream as unknown as IncomingMessage;
  (req as unknown as { method: string }).method = method;
  if (opts.contentLengthOverride !== undefined) {
    (req as unknown as { headers: Record<string, string> }).headers = {
      'content-length': String(opts.contentLengthOverride),
    };
  } else {
    (req as unknown as { headers: Record<string, string> }).headers = {};
  }
  return req;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: undefined };
  let chunks = '';
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead: (status: number, headers?: Record<string, string>) => {
      captured.status = status;
      captured.headers = { ...headers };
    },
    end: (chunk?: string) => {
      if (chunk) chunks += chunk;
      try {
        captured.body = JSON.parse(chunks);
      } catch {
        captured.body = chunks;
      }
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function makeDeps(overrides: Partial<HandleSpawnCursorDeps> = {}): HandleSpawnCursorDeps {
  return {
    contentDir: CONTENT_DIR,
    platform: 'darwin',
    resolveCursorBinary: async () => '/usr/local/bin/cursor',
    spawnDetached: async () => ({ ok: true }) as SpawnCursorOutcome,
    ...overrides,
  };
}

function expectProblem(captured: CapturedResponse, status: number, type: string): void {
  expect(captured.status).toBe(status);
  expect(captured.headers['Content-Type']).toBe('application/problem+json');
  expect(captured.body).toMatchObject({ type, title: expect.any(String), status });
}

describe('handleSpawnCursor — method gate', () => {
  test('rejects non-POST methods with 405 method-not-allowed problem+json + Allow: POST', async () => {
    const { res, captured } = makeRes();
    await handleSpawnCursor(makeReq('GET'), res, makeDeps());
    expectProblem(captured, 405, 'urn:ok:error:method-not-allowed');
    expect(captured.headers.Allow).toBe('POST');
  });
});

describe('handleSpawnCursor — body validation', () => {
  test('malformed JSON → 400 invalid-request', async () => {
    const { res, captured } = makeRes();
    await handleSpawnCursor(makeReq('POST', 'not-json{{'), res, makeDeps());
    expectProblem(captured, 400, 'urn:ok:error:invalid-request');
  });

  test('missing path field → 400 invalid-request', async () => {
    const { res, captured } = makeRes();
    await handleSpawnCursor(makeReq('POST', {}), res, makeDeps());
    expectProblem(captured, 400, 'urn:ok:error:invalid-request');
  });

  test('empty path string → 400 invalid-request', async () => {
    const { res, captured } = makeRes();
    await handleSpawnCursor(makeReq('POST', { path: '' }), res, makeDeps());
    expectProblem(captured, 400, 'urn:ok:error:invalid-request');
  });

  test('non-string path → 400 invalid-request', async () => {
    const { res, captured } = makeRes();
    await handleSpawnCursor(makeReq('POST', { path: 42 }), res, makeDeps());
    expectProblem(captured, 400, 'urn:ok:error:invalid-request');
  });
});

describe('handleSpawnCursor — path containment', () => {
  test('rejects paths outside contentDir → 403 path-escape', async () => {
    const spawnDetached = mock(async () => ({ ok: true }) as SpawnCursorOutcome);
    const { res, captured } = makeRes();
    await handleSpawnCursor(
      makeReq('POST', { path: '/etc/passwd' }),
      res,
      makeDeps({ spawnDetached }),
    );
    expectProblem(captured, 403, 'urn:ok:error:path-escape');
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  test('rejects parent traversal → 403 path-escape', async () => {
    const spawnDetached = mock(async () => ({ ok: true }) as SpawnCursorOutcome);
    const { res, captured } = makeRes();
    await handleSpawnCursor(
      makeReq('POST', { path: '/Users/who/dragons/../../etc' }),
      res,
      makeDeps({ spawnDetached }),
    );
    expectProblem(captured, 403, 'urn:ok:error:path-escape');
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  test('rejects null bytes in path → 403 path-escape', async () => {
    const { res, captured } = makeRes();
    await handleSpawnCursor(
      makeReq('POST', { path: '/Users/who/dragons/\0evil' }),
      res,
      makeDeps(),
    );
    expectProblem(captured, 403, 'urn:ok:error:path-escape');
  });

  test('accepts contentDir itself → 200 success body', async () => {
    const { res, captured } = makeRes();
    await handleSpawnCursor(makeReq('POST', { path: VALID_PATH }), res, makeDeps());
    expect(captured.status).toBe(200);
    expect(captured.headers['Content-Type']).toBe('application/json');
    expect(captured.body).toEqual({});
  });

  test('accepts nested path inside contentDir → 200 success body', async () => {
    const { res, captured } = makeRes();
    await handleSpawnCursor(makeReq('POST', { path: NESTED_PATH }), res, makeDeps());
    expect(captured.status).toBe(200);
    expect(captured.headers['Content-Type']).toBe('application/json');
    expect(captured.body).toEqual({});
  });
});

describe('handleSpawnCursor — binary resolution', () => {
  test('resolveCursorBinary returns null → 422 cursor-not-installed', async () => {
    const spawnDetached = mock(async () => ({ ok: true }) as SpawnCursorOutcome);
    const { res, captured } = makeRes();
    await handleSpawnCursor(
      makeReq('POST', { path: VALID_PATH }),
      res,
      makeDeps({ resolveCursorBinary: async () => null, spawnDetached }),
    );
    expectProblem(captured, 422, 'urn:ok:error:cursor-not-installed');
    expect(spawnDetached).not.toHaveBeenCalled();
  });
});

describe('handleSpawnCursor — spawn dispatch', () => {
  test('macOS .app bundle path routes through /usr/bin/open -a', async () => {
    const spawnDetached = mock(
      async (_exec: string, _args: ReadonlyArray<string>) => ({ ok: true }) as SpawnCursorOutcome,
    );
    const { res, captured } = makeRes();
    await handleSpawnCursor(
      makeReq('POST', { path: VALID_PATH }),
      res,
      makeDeps({
        resolveCursorBinary: async () => '/Applications/Cursor.app',
        spawnDetached,
      }),
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({});
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(spawnDetached.mock.calls[0]?.[0]).toBe('/usr/bin/open');
    expect(spawnDetached.mock.calls[0]?.[1]).toEqual([
      '-a',
      '/Applications/Cursor.app',
      VALID_PATH,
    ]);
  });

  test('non-bundle exec path is invoked directly with [path] argv', async () => {
    const spawnDetached = mock(
      async (_exec: string, _args: ReadonlyArray<string>) => ({ ok: true }) as SpawnCursorOutcome,
    );
    const { res, captured } = makeRes();
    await handleSpawnCursor(
      makeReq('POST', { path: VALID_PATH }),
      res,
      makeDeps({
        resolveCursorBinary: async () => '/usr/local/bin/cursor',
        spawnDetached,
      }),
    );
    expect(captured.status).toBe(200);
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(spawnDetached.mock.calls[0]?.[0]).toBe('/usr/local/bin/cursor');
    expect(spawnDetached.mock.calls[0]?.[1]).toEqual([VALID_PATH]);
  });

  test('spawn-error reason → 502 cursor-spawn-failed problem+json', async () => {
    const { res, captured } = makeRes();
    await handleSpawnCursor(
      makeReq('POST', { path: VALID_PATH }),
      res,
      makeDeps({
        spawnDetached: async () => ({ ok: false, reason: 'spawn-error' }) as SpawnCursorOutcome,
      }),
    );
    expectProblem(captured, 502, 'urn:ok:error:cursor-spawn-failed');
  });

  test('timeout reason → 504 cursor-spawn-timeout problem+json', async () => {
    const { res, captured } = makeRes();
    await handleSpawnCursor(
      makeReq('POST', { path: VALID_PATH }),
      res,
      makeDeps({
        spawnDetached: async () => ({ ok: false, reason: 'timeout' }) as SpawnCursorOutcome,
      }),
    );
    expectProblem(captured, 504, 'urn:ok:error:cursor-spawn-timeout');
  });

  test('spawn returns not-installed reason → 422 cursor-not-installed problem+json', async () => {
    const { res, captured } = makeRes();
    await handleSpawnCursor(
      makeReq('POST', { path: VALID_PATH }),
      res,
      makeDeps({
        spawnDetached: async () => ({ ok: false, reason: 'not-installed' }) as SpawnCursorOutcome,
      }),
    );
    expectProblem(captured, 422, 'urn:ok:error:cursor-not-installed');
  });

  test('spawn returns invalid-path reason → 403 path-escape problem+json', async () => {
    const { res, captured } = makeRes();
    await handleSpawnCursor(
      makeReq('POST', { path: VALID_PATH }),
      res,
      makeDeps({
        spawnDetached: async () => ({ ok: false, reason: 'invalid-path' }) as SpawnCursorOutcome,
      }),
    );
    expectProblem(captured, 403, 'urn:ok:error:path-escape');
  });
});

describe('handleSpawnCursor — Cursor binary discovery (per-platform)', () => {
  test('macOS: bundle-path probe finds the shim without `which`', async () => {
    let whichCalled = false;
    const spawnDetached = mock(async (exec: string, _args: ReadonlyArray<string>) => {
      expect(exec).toBe('/usr/bin/open');
      return { ok: true } as SpawnCursorOutcome;
    });
    const { res, captured } = makeRes();
    await handleSpawnCursor(
      makeReq('POST', { path: VALID_PATH }),
      res,
      makeDeps({
        platform: 'darwin',
        resolveCursorBinary: async () => {
          whichCalled = true;
          return '/Applications/Cursor.app';
        },
        spawnDetached,
      }),
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({});
    expect(whichCalled).toBe(true);
  });

  test('windows: .cmd shim is routed through cmd.exe (shell:false cannot exec .cmd — CVE-2024-27980)', async () => {
    const cmdPath =
      'C:\\Users\\who\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd';
    let capturedExec = '';
    let capturedArgs: ReadonlyArray<string> = [];
    const spawnDetached = mock(async (exec: string, args: ReadonlyArray<string>) => {
      capturedExec = exec;
      capturedArgs = [...args];
      return { ok: true } as SpawnCursorOutcome;
    });
    const { res, captured } = makeRes();
    await handleSpawnCursor(
      makeReq('POST', { path: 'C:\\Users\\who\\dragons' }),
      res,
      makeDeps({
        platform: 'win32',
        contentDir: 'C:\\Users\\who\\dragons',
        resolveCursorBinary: async () => cmdPath,
        spawnDetached,
      }),
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({});
    expect(capturedExec.toLowerCase().endsWith('cmd.exe')).toBe(true);
    expect(capturedArgs).toEqual(['/d', '/c', cmdPath, 'C:\\Users\\who\\dragons']);
  });

  test('linux: PATH lookup is the only viable strategy (no bundle paths registered)', async () => {
    const spawnDetached = mock(
      async (_exec: string, _args: ReadonlyArray<string>) => ({ ok: true }) as SpawnCursorOutcome,
    );
    const { res, captured } = makeRes();
    await handleSpawnCursor(
      makeReq('POST', { path: '/home/who/dragons' }),
      res,
      makeDeps({
        platform: 'linux',
        contentDir: '/home/who/dragons',
        resolveCursorBinary: async () => '/snap/bin/cursor',
        spawnDetached,
      }),
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({});
    expect(spawnDetached.mock.calls[0]?.[0]).toBe('/snap/bin/cursor');
  });
});

describe('isPathWithinDir', () => {
  test('rejects empty inputs', () => {
    expect(isPathWithinDir('', CONTENT_DIR, 'darwin')).toBe(false);
    expect(isPathWithinDir(VALID_PATH, '', 'darwin')).toBe(false);
  });

  test('rejects relative paths', () => {
    expect(isPathWithinDir('dragons/foo', CONTENT_DIR, 'darwin')).toBe(false);
  });

  test('accepts exact match and descendants on POSIX', () => {
    expect(isPathWithinDir(VALID_PATH, CONTENT_DIR, 'darwin')).toBe(true);
    expect(isPathWithinDir(NESTED_PATH, CONTENT_DIR, 'darwin')).toBe(true);
  });

  test('rejects parent traversal', () => {
    expect(isPathWithinDir('/Users/who/dragons/../../etc', CONTENT_DIR, 'darwin')).toBe(false);
  });

  test('rejects null bytes', () => {
    expect(isPathWithinDir('/Users/who/dragons/\0', CONTENT_DIR, 'darwin')).toBe(false);
  });

  test('rejects cross-drive paths on Windows', () => {
    expect(isPathWithinDir('D:\\foo', 'C:\\Users\\who\\dragons', 'win32')).toBe(false);
  });

  test('accepts same-drive descendants on Windows', () => {
    expect(
      isPathWithinDir('C:\\Users\\who\\dragons\\specs', 'C:\\Users\\who\\dragons', 'win32'),
    ).toBe(true);
  });
});
