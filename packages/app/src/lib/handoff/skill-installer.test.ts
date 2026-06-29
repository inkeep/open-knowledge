
import { describe, expect, mock, test } from 'bun:test';
import {
  type ElectronSkillBridge,
  electronSkillInstaller,
  httpSkillInstaller,
} from './skill-installer';

describe('electronSkillInstaller', () => {
  test('bridge ok: returns ok with path', async () => {
    const bridge: ElectronSkillBridge = {
      buildAndOpen: mock(async () => ({ ok: true, path: '/tmp/skill' })),
    };
    const installer = electronSkillInstaller(bridge);

    expect(await installer.install()).toEqual({ ok: true, path: '/tmp/skill' });
    expect(bridge.buildAndOpen).toHaveBeenCalledTimes(1);
  });

  test('bridge fails: returns ok-false with reason + message', async () => {
    const bridge: ElectronSkillBridge = {
      buildAndOpen: mock(async () => ({
        ok: false,
        reason: 'build-failed',
        message: 'no SKILL.md',
      })),
    };
    const installer = electronSkillInstaller(bridge);

    expect(await installer.install()).toEqual({
      ok: false,
      reason: 'build-failed',
      message: 'no SKILL.md',
    });
  });

  test('bridge throws: ok-false with bridge-error reason (IPC channel broken)', async () => {
    const bridge: ElectronSkillBridge = {
      buildAndOpen: mock(async () => {
        throw new Error('IPC channel closed');
      }),
    };
    const installer = electronSkillInstaller(bridge);

    expect(await installer.install()).toEqual({
      ok: false,
      reason: 'bridge-error',
      message: 'IPC channel closed',
    });
  });
});

describe('httpSkillInstaller', () => {
  function fakeFetch(response: {
    ok?: boolean;
    status?: number;
    body?: unknown;
    throwError?: Error;
  }): typeof fetch {
    return mock(async () => {
      if (response.throwError) throw response.throwError;
      return {
        ok: response.ok ?? true,
        status: response.status ?? 200,
        json: async () => response.body,
      } as Response;
    }) as unknown as typeof fetch;
  }

  test("posts to '/api/install-skill' with empty JSON body and Content-Type", async () => {
    const fetchSpy = fakeFetch({ body: { status: 'installed', outputPath: '/tmp/skill' } });
    const installer = httpSkillInstaller({ fetch: fetchSpy });

    await installer.install();

    const [url, init] = (fetchSpy as unknown as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/install-skill');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  test('respects apiOrigin for cross-origin POSTs', async () => {
    const fetchSpy = fakeFetch({ body: { status: 'installed', outputPath: '/tmp/skill' } });
    const installer = httpSkillInstaller({ fetch: fetchSpy, apiOrigin: 'http://localhost:5173' });

    await installer.install();

    const [url] = (fetchSpy as unknown as ReturnType<typeof mock>).mock.calls[0] as [string];
    expect(url).toBe('http://localhost:5173/api/install-skill');
  });

  test("status 'installed': ok-true with path, no warning", async () => {
    const installer = httpSkillInstaller({
      fetch: fakeFetch({ body: { status: 'installed', outputPath: '/tmp/skill' } }),
    });

    expect(await installer.install()).toEqual({
      ok: true,
      path: '/tmp/skill',
      handoffWarning: undefined,
    });
  });

  test("status 'built' with handoffError: ok-true with warning (file is on disk)", async () => {
    const installer = httpSkillInstaller({
      fetch: fakeFetch({
        body: {
          status: 'built',
          outputPath: '/tmp/skill',
          handoffError: { reason: 'spawn-error', message: 'EACCES' },
        },
      }),
    });

    expect(await installer.install()).toEqual({
      ok: true,
      path: '/tmp/skill',
      handoffWarning: 'EACCES',
    });
  });

  test("status 'failed': ok-false with build-failed reason", async () => {
    const installer = httpSkillInstaller({
      fetch: fakeFetch({ body: { status: 'failed', buildError: 'no SKILL.md' } }),
    });

    expect(await installer.install()).toEqual({
      ok: false,
      reason: 'build-failed',
      message: 'no SKILL.md',
    });
  });

  test('non-2xx HTTP response with no body: ok-false falls back to HTTP <status>', async () => {
    const installer = httpSkillInstaller({
      fetch: mock(
        async () =>
          ({
            ok: false,
            status: 503,
            json: async () => {
              throw new SyntaxError('Unexpected end of JSON input');
            },
          }) as unknown as Response,
      ) as unknown as typeof fetch,
    });

    expect(await installer.install()).toEqual({
      ok: false,
      reason: 'http-error',
      message: 'HTTP 503',
    });
  });

  test('400 with RFC 9457 problem+json: surfaces title (e.g., path confinement)', async () => {
    const installer = httpSkillInstaller({
      fetch: fakeFetch({
        ok: false,
        status: 400,
        body: {
          type: 'urn:ok:error:invalid-request',
          title: 'Output path must be within home directory.',
          status: 400,
          instance: 'urn:uuid:00000000-0000-0000-0000-000000000000',
        },
      }),
    });

    expect(await installer.install()).toEqual({
      ok: false,
      reason: 'http-error',
      message: 'Output path must be within home directory.',
    });
  });

  test('500 with RFC 9457 problem+json: surfaces title', async () => {
    const installer = httpSkillInstaller({
      fetch: fakeFetch({
        ok: false,
        status: 500,
        body: {
          type: 'urn:ok:error:internal-server-error',
          title: 'Failed to install skill.',
          status: 500,
          instance: 'urn:uuid:00000000-0000-0000-0000-000000000001',
        },
      }),
    });

    expect(await installer.install()).toEqual({
      ok: false,
      reason: 'http-error',
      message: 'Failed to install skill.',
    });
  });

  test('non-contract error body (e.g., reverse-proxy 502): falls back to HTTP status', async () => {
    const installer = httpSkillInstaller({
      fetch: fakeFetch({
        ok: false,
        status: 502,
        body: { someUnexpectedField: 'no title' } as unknown as Record<string, unknown>,
      }),
    });

    expect(await installer.install()).toEqual({
      ok: false,
      reason: 'http-error',
      message: 'HTTP 502',
    });
  });

  test('fetch throws: ok-false with network-error reason', async () => {
    const installer = httpSkillInstaller({
      fetch: fakeFetch({ throwError: new Error('NetworkError: failed to connect') }),
    });

    expect(await installer.install()).toEqual({
      ok: false,
      reason: 'network-error',
      message: 'NetworkError: failed to connect',
    });
  });

  test('response.json() throws: ok-false with parse-error (malformed body)', async () => {
    const installer = httpSkillInstaller({
      fetch: mock(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token < in JSON at position 0');
            },
          }) as unknown as Response,
      ) as unknown as typeof fetch,
    });

    const result = await installer.install();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('parse-error');
    }
  });

  test('response.json() returns null/missing status: ok-false with parse-error', async () => {
    const installer = httpSkillInstaller({
      fetch: fakeFetch({ body: { unexpected: 'shape' } }),
    });

    const result = await installer.install();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('parse-error');
    }
  });
});
