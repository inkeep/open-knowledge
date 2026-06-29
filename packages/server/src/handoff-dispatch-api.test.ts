import { describe, expect, mock, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  type HandleHandoffDispatchDeps,
  handleHandoffDispatch,
  resolveUrlOpenInvocation,
  type SpawnOutcome,
} from './handoff-dispatch-api.ts';

const CONTENT_DIR = '/Users/who/dragons';
const VALID_PATH = '/Users/who/dragons/specs';

const CLAUDE_URL = 'claude://cowork/new?folder=%2FUsers%2Fwho%2Fdragons';
const CODEX_URL = 'codex://new?path=%2FUsers%2Fwho%2Fdragons';
const CURSOR_URL = 'cursor://anysphere.cursor-deeplink/prompt?text=hi';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function makeReq(method: string, body?: string | object): IncomingMessage {
  const text =
    typeof body === 'string' ? body : body !== undefined ? JSON.stringify(body) : undefined;
  const stream = Readable.from(text !== undefined ? [Buffer.from(text)] : []);
  const req = stream as unknown as IncomingMessage;
  (req as unknown as { method: string }).method = method;
  (req as unknown as { headers: Record<string, string> }).headers = {};
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

function makeDeps(overrides: Partial<HandleHandoffDispatchDeps> = {}): HandleHandoffDispatchDeps {
  return {
    contentDir: CONTENT_DIR,
    platform: 'darwin',
    sleep: async () => undefined,
    spawnDetached: async () => ({ ok: true }) as SpawnOutcome,
    resolveCursorBinary: async () => '/usr/local/bin/cursor',
    ...overrides,
  };
}

function expectProblem(captured: CapturedResponse, status: number, type: string): void {
  expect(captured.status).toBe(status);
  expect(captured.headers['Content-Type']).toBe('application/problem+json');
  expect(captured.body).toMatchObject({ type, title: expect.any(String), status });
}

describe('handleHandoffDispatch — method gate', () => {
  test('rejects non-POST methods with 405 method-not-allowed problem+json + Allow: POST', async () => {
    const { res, captured } = makeRes();
    await handleHandoffDispatch(makeReq('GET'), res, makeDeps());
    expectProblem(captured, 405, 'urn:ok:error:method-not-allowed');
    expect(captured.headers.Allow).toBe('POST');
  });
});

describe('resolveUrlOpenInvocation — per-platform protocol-URL opener', () => {
  test('macOS → /usr/bin/open <url>', () => {
    expect(resolveUrlOpenInvocation(CLAUDE_URL, 'darwin')).toEqual({
      exec: '/usr/bin/open',
      args: [CLAUDE_URL],
    });
  });

  test('Windows → rundll32.exe url.dll,FileProtocolHandler <url> (no cmd, no shell parse)', () => {
    expect(resolveUrlOpenInvocation(CLAUDE_URL, 'win32')).toEqual({
      exec: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', CLAUDE_URL],
    });
  });

  test('Linux → xdg-open <url>', () => {
    expect(resolveUrlOpenInvocation(CLAUDE_URL, 'linux')).toEqual({
      exec: 'xdg-open',
      args: [CLAUDE_URL],
    });
  });

  test('unknown platform falls through to xdg-open (matches createOsProbe convention)', () => {
    expect(resolveUrlOpenInvocation(CLAUDE_URL, 'freebsd' as NodeJS.Platform)).toEqual({
      exec: 'xdg-open',
      args: [CLAUDE_URL],
    });
  });

  test('a literal & in the URL stays a single inert argv element on Windows', () => {
    const urlWithAmp = 'claude://cowork/new?folder=%2Fx&q=hi';
    expect(resolveUrlOpenInvocation(urlWithAmp, 'win32')).toEqual({
      exec: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', urlWithAmp],
    });
  });
});

describe('handleHandoffDispatch — app-bundle cross-platform (Windows / Linux)', () => {
  test('Windows claude-cowork, scheme registered → single rundll32 URL fire; no osascript/open -a', async () => {
    const calls: Array<{ exec: string; args: ReadonlyArray<string> }> = [];
    const spawnDetached = mock(async (exec: string, args: ReadonlyArray<string>) => {
      calls.push({ exec, args: [...args] });
      return { ok: true } as SpawnOutcome;
    });
    const isSchemeRegistered = mock(async () => true);
    const sleep = mock(async (_ms: number) => undefined);
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'claude-cowork', url: CLAUDE_URL }),
      res,
      makeDeps({ platform: 'win32', spawnDetached, isSchemeRegistered, sleep }),
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({});
    expect(isSchemeRegistered).toHaveBeenCalledWith('claude');
    expect(calls).toEqual([
      { exec: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', CLAUDE_URL] },
    ]);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('Windows codex, scheme registered → rundll32 URL fire; quitFirst does NOT spawn osascript off-darwin', async () => {
    const calls: Array<{ exec: string; args: ReadonlyArray<string> }> = [];
    const spawnDetached = mock(async (exec: string, args: ReadonlyArray<string>) => {
      calls.push({ exec, args: [...args] });
      return { ok: true } as SpawnOutcome;
    });
    const isSchemeRegistered = mock(async () => true);
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'codex', url: CODEX_URL }),
      res,
      makeDeps({ platform: 'win32', spawnDetached, isSchemeRegistered }),
    );
    expect(captured.status).toBe(200);
    expect(isSchemeRegistered).toHaveBeenCalledWith('codex');
    expect(calls).toEqual([
      { exec: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', CODEX_URL] },
    ]);
  });

  test('Linux claude-code, scheme registered → single xdg-open URL fire', async () => {
    const calls: Array<{ exec: string; args: ReadonlyArray<string> }> = [];
    const spawnDetached = mock(async (exec: string, args: ReadonlyArray<string>) => {
      calls.push({ exec, args: [...args] });
      return { ok: true } as SpawnOutcome;
    });
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'claude-code', url: CLAUDE_URL }),
      res,
      makeDeps({ platform: 'linux', spawnDetached, isSchemeRegistered: async () => true }),
    );
    expect(captured.status).toBe(200);
    expect(calls).toEqual([{ exec: 'xdg-open', args: [CLAUDE_URL] }]);
  });

  test('Windows claude-cowork, scheme NOT registered → 422 handoff-target-not-installed; no spawn', async () => {
    const spawnDetached = mock(async () => ({ ok: true }) as SpawnOutcome);
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'claude-cowork', url: CLAUDE_URL }),
      res,
      makeDeps({ platform: 'win32', spawnDetached, isSchemeRegistered: async () => false }),
    );
    expectProblem(captured, 422, 'urn:ok:error:handoff-target-not-installed');
    expect(captured.body).toMatchObject({ target: 'claude-cowork' });
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  test('Linux codex, scheme NOT registered → 422 handoff-target-not-installed; no spawn', async () => {
    const spawnDetached = mock(async () => ({ ok: true }) as SpawnOutcome);
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'codex', url: CODEX_URL }),
      res,
      makeDeps({ platform: 'linux', spawnDetached, isSchemeRegistered: async () => false }),
    );
    expectProblem(captured, 422, 'urn:ok:error:handoff-target-not-installed');
    expect(captured.body).toMatchObject({ target: 'codex' });
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  test('Windows app-bundle URL-spawn failure (spawn-error) → 502 handoff-spawn-failed', async () => {
    const spawnDetached = mock(async () => ({ ok: false, reason: 'spawn-error' }) as SpawnOutcome);
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'claude-cowork', url: CLAUDE_URL }),
      res,
      makeDeps({ platform: 'win32', spawnDetached, isSchemeRegistered: async () => true }),
    );
    expectProblem(captured, 502, 'urn:ok:error:handoff-spawn-failed');
    expect(captured.body).toMatchObject({ target: 'claude-cowork' });
  });
});

describe('handleHandoffDispatch — cursor cross-platform (cli-binary)', () => {
  test('Windows cursor: .cmd shim via cmd.exe /d /c → sleep → rundll32 URL fire', async () => {
    const winContentDir = 'C:\\Users\\who\\dragons';
    const winWorkspace = 'C:\\Users\\who\\dragons\\specs';
    const cmdPath =
      'C:\\Users\\who\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd';
    const calls: Array<{ exec: string; args: ReadonlyArray<string> }> = [];
    const spawnDetached = mock(async (exec: string, args: ReadonlyArray<string>) => {
      calls.push({ exec, args: [...args] });
      return { ok: true } as SpawnOutcome;
    });
    const sleep = mock(async (_ms: number) => undefined);
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'cursor', url: CURSOR_URL, workspacePath: winWorkspace }),
      res,
      makeDeps({
        platform: 'win32',
        contentDir: winContentDir,
        spawnDetached,
        sleep,
        resolveCursorBinary: async () => cmdPath,
      }),
    );
    expect(captured.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(calls[0]?.exec.toLowerCase().endsWith('cmd.exe')).toBe(true);
    expect(calls[0]?.args).toEqual(['/d', '/c', cmdPath, winWorkspace]);
    expect(calls[1]).toEqual({
      exec: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', CURSOR_URL],
    });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test('Linux cursor: cursor <path> → sleep → xdg-open URL fire', async () => {
    const linuxContentDir = '/home/who/dragons';
    const linuxWorkspace = '/home/who/dragons/specs';
    const calls: Array<{ exec: string; args: ReadonlyArray<string> }> = [];
    const spawnDetached = mock(async (exec: string, args: ReadonlyArray<string>) => {
      calls.push({ exec, args: [...args] });
      return { ok: true } as SpawnOutcome;
    });
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'cursor', url: CURSOR_URL, workspacePath: linuxWorkspace }),
      res,
      makeDeps({
        platform: 'linux',
        contentDir: linuxContentDir,
        spawnDetached,
        resolveCursorBinary: async () => '/usr/bin/cursor',
      }),
    );
    expect(captured.status).toBe(200);
    expect(calls).toEqual([
      { exec: '/usr/bin/cursor', args: [linuxWorkspace] },
      { exec: 'xdg-open', args: [CURSOR_URL] },
    ]);
  });
});

describe('handleHandoffDispatch — body validation', () => {
  test('malformed JSON → 400 invalid-request', async () => {
    const { res, captured } = makeRes();
    await handleHandoffDispatch(makeReq('POST', 'not-json{{'), res, makeDeps());
    expectProblem(captured, 400, 'urn:ok:error:invalid-request');
  });

  test('missing target → 400 invalid-request', async () => {
    const { res, captured } = makeRes();
    await handleHandoffDispatch(makeReq('POST', { url: CLAUDE_URL }), res, makeDeps());
    expectProblem(captured, 400, 'urn:ok:error:invalid-request');
  });

  test('unknown target → 400 invalid-request', async () => {
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'lovable', url: 'lovable://x' }),
      res,
      makeDeps(),
    );
    expectProblem(captured, 400, 'urn:ok:error:invalid-request');
  });

  test('missing url → 400 invalid-request', async () => {
    const { res, captured } = makeRes();
    await handleHandoffDispatch(makeReq('POST', { target: 'claude-cowork' }), res, makeDeps());
    expectProblem(captured, 400, 'urn:ok:error:invalid-request');
  });

  test('empty url → 400 invalid-request', async () => {
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'claude-cowork', url: '' }),
      res,
      makeDeps(),
    );
    expectProblem(captured, 400, 'urn:ok:error:invalid-request');
  });

  test('url scheme mismatch (claude://) on codex target → 400 invalid-request', async () => {
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'codex', url: CLAUDE_URL }),
      res,
      makeDeps(),
    );
    expectProblem(captured, 400, 'urn:ok:error:invalid-request');
  });

  test('url scheme mismatch (https://) on claude-cowork target → 400 invalid-request', async () => {
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'claude-cowork', url: 'https://claude.ai/' }),
      res,
      makeDeps(),
    );
    expectProblem(captured, 400, 'urn:ok:error:invalid-request');
  });
});

describe('handleHandoffDispatch — claude-cowork recipe (app-bundle, quitFirst=false)', () => {
  test('happy path: open -a Claude → sleep → open URL; no osascript quit', async () => {
    const calls: Array<{ exec: string; args: ReadonlyArray<string> }> = [];
    const spawnDetached = mock(async (exec: string, args: ReadonlyArray<string>) => {
      calls.push({ exec, args: [...args] });
      return { ok: true } as SpawnOutcome;
    });
    const sleep = mock(async (_ms: number) => undefined);
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'claude-cowork', url: CLAUDE_URL }),
      res,
      makeDeps({ spawnDetached, sleep }),
    );
    expect(captured.status).toBe(200);
    expect(captured.headers['Content-Type']).toBe('application/json');
    expect(captured.body).toEqual({});
    expect(calls).toEqual([
      { exec: '/usr/bin/open', args: ['-a', 'Claude'] },
      { exec: '/usr/bin/open', args: [CLAUDE_URL] },
    ]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test('claude-code uses the same recipe as claude-cowork', async () => {
    const calls: Array<{ exec: string; args: ReadonlyArray<string> }> = [];
    const spawnDetached = mock(async (exec: string, args: ReadonlyArray<string>) => {
      calls.push({ exec, args: [...args] });
      return { ok: true } as SpawnOutcome;
    });
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'claude-code', url: CLAUDE_URL }),
      res,
      makeDeps({ spawnDetached }),
    );
    expect(captured.status).toBe(200);
    expect(calls).toEqual([
      { exec: '/usr/bin/open', args: ['-a', 'Claude'] },
      { exec: '/usr/bin/open', args: [CLAUDE_URL] },
    ]);
  });

  test('activate failure (not-installed) → 422 handoff-target-not-installed; URL spawn skipped', async () => {
    let firstCall = true;
    const spawnDetached = mock(async () => {
      if (firstCall) {
        firstCall = false;
        return { ok: false, reason: 'not-installed' } as SpawnOutcome;
      }
      return { ok: true } as SpawnOutcome;
    });
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'claude-cowork', url: CLAUDE_URL }),
      res,
      makeDeps({ spawnDetached }),
    );
    expectProblem(captured, 422, 'urn:ok:error:handoff-target-not-installed');
    expect(captured.body).toMatchObject({ target: 'claude-cowork' });
    expect(spawnDetached).toHaveBeenCalledTimes(1);
  });

  test('URL spawn failure (timeout) → 504 handoff-spawn-timeout', async () => {
    let callCount = 0;
    const spawnDetached = mock(async () => {
      callCount += 1;
      if (callCount === 1) return { ok: true } as SpawnOutcome;
      return { ok: false, reason: 'timeout' } as SpawnOutcome;
    });
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'claude-cowork', url: CLAUDE_URL }),
      res,
      makeDeps({ spawnDetached }),
    );
    expectProblem(captured, 504, 'urn:ok:error:handoff-spawn-timeout');
    expect(captured.body).toMatchObject({ target: 'claude-cowork' });
    expect(spawnDetached).toHaveBeenCalledTimes(2);
  });

  test('URL spawn failure (spawn-error) → 502 handoff-spawn-failed', async () => {
    let callCount = 0;
    const spawnDetached = mock(async () => {
      callCount += 1;
      if (callCount === 1) return { ok: true } as SpawnOutcome;
      return { ok: false, reason: 'spawn-error' } as SpawnOutcome;
    });
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'claude-cowork', url: CLAUDE_URL }),
      res,
      makeDeps({ spawnDetached }),
    );
    expectProblem(captured, 502, 'urn:ok:error:handoff-spawn-failed');
    expect(captured.body).toMatchObject({ target: 'claude-cowork' });
  });
});

describe('handleHandoffDispatch — codex recipe (app-bundle, quitFirst=true)', () => {
  test('happy path: osascript quit → sleep → open -a Codex → sleep → open URL', async () => {
    const calls: Array<{ exec: string; args: ReadonlyArray<string> }> = [];
    const spawnDetached = mock(async (exec: string, args: ReadonlyArray<string>) => {
      calls.push({ exec, args: [...args] });
      return { ok: true } as SpawnOutcome;
    });
    const sleep = mock(async (_ms: number) => undefined);
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'codex', url: CODEX_URL }),
      res,
      makeDeps({ spawnDetached, sleep }),
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({});
    expect(calls).toEqual([
      {
        exec: '/usr/bin/osascript',
        args: ['-e', 'tell application "Codex" to quit'],
      },
      { exec: '/usr/bin/open', args: ['-a', 'Codex'] },
      { exec: '/usr/bin/open', args: [CODEX_URL] },
    ]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test('quit-step failure is swallowed; recipe still proceeds with activate + URL', async () => {
    let callCount = 0;
    const calls: Array<{ exec: string; args: ReadonlyArray<string> }> = [];
    const spawnDetached = mock(async (exec: string, args: ReadonlyArray<string>) => {
      callCount += 1;
      calls.push({ exec, args: [...args] });
      if (callCount === 1) return { ok: false, reason: 'spawn-error' } as SpawnOutcome;
      return { ok: true } as SpawnOutcome;
    });
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'codex', url: CODEX_URL }),
      res,
      makeDeps({ spawnDetached }),
    );
    expect(captured.status).toBe(200);
    expect(calls.map((c) => c.exec)).toEqual([
      '/usr/bin/osascript',
      '/usr/bin/open',
      '/usr/bin/open',
    ]);
  });

  test('activate failure on codex → 422 handoff-target-not-installed with target=codex', async () => {
    let callCount = 0;
    const spawnDetached = mock(async () => {
      callCount += 1;
      if (callCount === 1) return { ok: true } as SpawnOutcome;
      return { ok: false, reason: 'not-installed' } as SpawnOutcome;
    });
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'codex', url: CODEX_URL }),
      res,
      makeDeps({ spawnDetached }),
    );
    expectProblem(captured, 422, 'urn:ok:error:handoff-target-not-installed');
    expect(captured.body).toMatchObject({ target: 'codex' });
  });
});

describe('handleHandoffDispatch — cursor recipe (cli-binary)', () => {
  test('happy path: cursor <path> → sleep → open URL', async () => {
    const calls: Array<{ exec: string; args: ReadonlyArray<string> }> = [];
    const spawnDetached = mock(async (exec: string, args: ReadonlyArray<string>) => {
      calls.push({ exec, args: [...args] });
      return { ok: true } as SpawnOutcome;
    });
    const sleep = mock(async (_ms: number) => undefined);
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', {
        target: 'cursor',
        url: CURSOR_URL,
        workspacePath: VALID_PATH,
      }),
      res,
      makeDeps({
        spawnDetached,
        sleep,
        resolveCursorBinary: async () => '/usr/local/bin/cursor',
      }),
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({});
    expect(calls).toEqual([
      { exec: '/usr/local/bin/cursor', args: [VALID_PATH] },
      { exec: '/usr/bin/open', args: [CURSOR_URL] },
    ]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test('missing workspacePath → 400 invalid-request; no spawn', async () => {
    const spawnDetached = mock(async () => ({ ok: true }) as SpawnOutcome);
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'cursor', url: CURSOR_URL }),
      res,
      makeDeps({ spawnDetached }),
    );
    expectProblem(captured, 400, 'urn:ok:error:invalid-request');
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  test('workspacePath outside contentDir → 403 path-escape; no spawn', async () => {
    const spawnDetached = mock(async () => ({ ok: true }) as SpawnOutcome);
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', { target: 'cursor', url: CURSOR_URL, workspacePath: '/etc/passwd' }),
      res,
      makeDeps({ spawnDetached }),
    );
    expectProblem(captured, 403, 'urn:ok:error:path-escape');
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  test('cursor binary not found → 422 handoff-target-not-installed; no spawn', async () => {
    const spawnDetached = mock(async () => ({ ok: true }) as SpawnOutcome);
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', {
        target: 'cursor',
        url: CURSOR_URL,
        workspacePath: VALID_PATH,
      }),
      res,
      makeDeps({ resolveCursorBinary: async () => null, spawnDetached }),
    );
    expectProblem(captured, 422, 'urn:ok:error:handoff-target-not-installed');
    expect(captured.body).toMatchObject({ target: 'cursor' });
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  test('cursor spawn failure (timeout) → 504 handoff-spawn-timeout; URL spawn skipped', async () => {
    const spawnDetached = mock(async () => ({ ok: false, reason: 'timeout' }) as SpawnOutcome);
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', {
        target: 'cursor',
        url: CURSOR_URL,
        workspacePath: VALID_PATH,
      }),
      res,
      makeDeps({ spawnDetached }),
    );
    expectProblem(captured, 504, 'urn:ok:error:handoff-spawn-timeout');
    expect(captured.body).toMatchObject({ target: 'cursor' });
    expect(spawnDetached).toHaveBeenCalledTimes(1);
  });

  test('URL spawn failure after cursor → 502 handoff-spawn-failed', async () => {
    let callCount = 0;
    const spawnDetached = mock(async () => {
      callCount += 1;
      if (callCount === 1) return { ok: true } as SpawnOutcome;
      return { ok: false, reason: 'spawn-error' } as SpawnOutcome;
    });
    const { res, captured } = makeRes();
    await handleHandoffDispatch(
      makeReq('POST', {
        target: 'cursor',
        url: CURSOR_URL,
        workspacePath: VALID_PATH,
      }),
      res,
      makeDeps({ spawnDetached }),
    );
    expectProblem(captured, 502, 'urn:ok:error:handoff-spawn-failed');
    expect(captured.body).toMatchObject({ target: 'cursor' });
  });
});
