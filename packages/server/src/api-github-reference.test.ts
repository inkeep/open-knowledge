import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';
import { makeCaptureRes } from './composition-rig.test-helper.ts';
import { buildIngressPolicy } from './ingress-policy.ts';
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';

const PULL_NODE = {
  __typename: 'PullRequest',
  title: 'Add reference cards',
  createdAt: '2026-09-20T10:00:00Z',
  state: 'MERGED',
  isDraft: false,
  additions: 3,
  deletions: 1,
  author: { login: 'octocat' },
};

interface Rig {
  readonly baseURL: string;
  readonly githubCalls: string[];
  readonly authorizations: (string | null)[];
  readonly tokenHosts: string[];
}

function useRig(): {
  open: (opts?: { enabled?: boolean; respond?: (url: string) => Response | null }) => Promise<Rig>;
} {
  let tmpDir = '';
  let server: Server | null = null;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-github-reference-'));
    mkdirSync(join(tmpDir, 'content'), { recursive: true });
  });
  afterEach(async () => {
    if (server) {
      const closing = server;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
      server = null;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });
  return {
    open: async ({ enabled = true, respond = () => null } = {}) => {
      const githubCalls: string[] = [];
      const authorizations: (string | null)[] = [];
      const tokenHosts: string[] = [];
      const ext = createApiExtension({
        hocuspocus: {} as Parameters<typeof createApiExtension>[0]['hocuspocus'],
        sessionManager: {} as Parameters<typeof createApiExtension>[0]['sessionManager'],
        contentDir: join(tmpDir, 'content'),
        serverInstanceId: 'test-server',
        getFileIndex: () => new Map(),
        declaredGitHubHosts: new Set(['git.example.com']),
        getLinkPreviewsEnabled: () => enabled,
        resolveGitHubToken: async (host) => {
          tokenHosts.push(host);
          return 'tok';
        },
        githubReferenceFetch: (async (input: string | URL | Request, init?: RequestInit) => {
          githubCalls.push(String(input));
          authorizations.push(new Headers(init?.headers).get('authorization'));
          const answer = respond(String(input));
          if (answer !== null) return answer;
          return new Response(
            JSON.stringify({ data: { repository: { issueOrPullRequest: PULL_NODE } } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }) as typeof fetch,
      });
      server = createServer((req, res) => {
        void (
          ext as {
            onRequest: (ctx: {
              request: IncomingMessage;
              response: ServerResponse;
            }) => Promise<void>;
          }
        ).onRequest({ request: req, response: res });
      });
      const { baseUrl } = await listenOnLoopback(server);
      return { baseURL: baseUrl, githubCalls, authorizations, tokenHosts };
    },
  };
}

function post(
  rig: Rig,
  url: string,
  origin: string | null = rig.baseURL,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  if (origin !== null) headers.Origin = origin;
  return fetch(`${rig.baseURL}/api/github-reference`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url }),
  });
}

describe('POST /api/github-reference', () => {
  const rigs = useRig();

  test('refuses other origins before touching GitHub', async () => {
    const rig = await rigs.open();
    const res = await post(rig, 'https://github.com/inkeep/agents/pull/1', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(rig.githubCalls).toEqual([]);
  });

  test('answers disabled when link previews are off, without any egress', async () => {
    const rig = await rigs.open({ enabled: false });
    const res = await post(rig, 'https://github.com/inkeep/agents/pull/1');
    expect(await res.json()).toMatchObject({ ok: false, reason: 'disabled' });
    expect(rig.githubCalls).toEqual([]);
    expect(rig.tokenHosts).toEqual([]);
  });

  test('answers unsupported for hosts that are not GitHub', async () => {
    const rig = await rigs.open();
    const res = await post(rig, 'https://gitlab.example.com/inkeep/agents/pull/1');
    expect(await res.json()).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(rig.githubCalls).toEqual([]);
  });

  test('reads a reference with the host token and serves repeats from the cache', async () => {
    const rig = await rigs.open();
    const first = await post(rig, 'https://git.example.com/inkeep/agents/pull/1');
    expect(await first.json()).toMatchObject({
      ok: true,
      preview: { kind: 'pull', repo: 'inkeep/agents', number: 1, lifecycle: 'merged' },
    });
    await post(rig, 'https://git.example.com/inkeep/agents/issues/1');
    expect(rig.tokenHosts).toEqual(['git.example.com']);
    expect(rig.githubCalls).toEqual(['https://git.example.com/api/graphql']);
  });

  test('after GitHub rate-limits one card, the next reference on that host sends nothing', async () => {
    const rig = await rigs.open({
      respond: () => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }),
    });
    const first = await post(rig, 'https://git.example.com/inkeep/agents/pull/1');
    expect(await first.json()).toMatchObject({ ok: false, reason: 'unavailable' });
    const second = await post(rig, 'https://git.example.com/inkeep/agents/pull/2');
    expect(await second.json()).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(rig.githubCalls).toEqual(['https://git.example.com/api/graphql']);
  });

  test('an exposed server reads a remote caller anonymously even with a loopback Origin and Host', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-github-reference-remote-'));
    try {
      const tokenHosts: string[] = [];
      const authorizations: (string | null)[] = [];
      const ext = createApiExtension({
        hocuspocus: {} as Parameters<typeof createApiExtension>[0]['hocuspocus'],
        sessionManager: {} as Parameters<typeof createApiExtension>[0]['sessionManager'],
        contentDir: dir,
        serverInstanceId: 'test-server',
        getFileIndex: () => new Map(),
        declaredGitHubHosts: new Set(['git.example.com']),
        getLinkPreviewsEnabled: () => true,
        resolveGitHubToken: async (host) => {
          tokenHosts.push(host);
          return 'tok';
        },
        githubReferenceFetch: (async (_input: string | URL | Request, init?: RequestInit) => {
          authorizations.push(new Headers(init?.headers).get('authorization'));
          return new Response(
            JSON.stringify({ title: 't', created_at: '2026-09-20T10:00:00Z', state: 'open' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }) as typeof fetch,
        ingressPolicy: buildIngressPolicy({
          serverRuntime: {
            bind: ['127.0.0.1'],
            port: 0,
            externalUrl: 'https://ok.example.com',
            allowExternal: true,
            openBrowser: false,
            idleShutdown: 'off',
            loopbackOnly: false,
          },
        }),
      });
      const req = Readable.from(
        Buffer.from(JSON.stringify({ url: 'https://git.example.com/inkeep/agents/pull/1' })),
      ) as unknown as IncomingMessage;
      req.method = 'POST';
      req.url = '/api/github-reference';
      req.headers = {
        host: '127.0.0.1',
        origin: 'http://localhost',
        'content-type': 'application/json',
      };
      req.socket = { remoteAddress: '203.0.113.8' } as unknown as IncomingMessage['socket'];
      const { res, captured } = makeCaptureRes();
      expect(await ext.nativeApi.dispatch(req, res)).toBe(true);
      expect(captured.status, captured.body).toBe(200);
      expect(JSON.parse(captured.body)).toMatchObject({ ok: true, preview: { number: 1 } });
      expect(tokenHosts).toEqual([]);
      expect(authorizations).toEqual([null]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a forwarded caller is read anonymously and never gets the signed-in answer', async () => {
    const rig = await rigs.open();
    await post(rig, 'https://git.example.com/inkeep/agents/pull/1');
    await post(rig, 'https://git.example.com/inkeep/agents/pull/1', 'http://localhost:5173', {
      'X-Forwarded-For': '203.0.113.9',
    });
    expect(rig.tokenHosts).toEqual(['git.example.com']);
    expect(rig.githubCalls).toEqual([
      'https://git.example.com/api/graphql',
      'https://git.example.com/api/v3/repos/inkeep/agents/pulls/1',
    ]);
    expect(rig.authorizations).toEqual(['Bearer tok', null]);
  });
});
