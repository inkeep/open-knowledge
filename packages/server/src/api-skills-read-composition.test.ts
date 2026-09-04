import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import {
  bootCompositionRig,
  makeCaptureRes,
  makeSyntheticReq,
} from './composition-rig.test-helper.ts';
import { createSkillsReadRoutes, type SkillsReadRouteDeps } from './http/skills-read-routes.ts';
import { checkLocalOpSecurity } from './local-op-security.ts';

function buildSkillsReadRoutes(overrides: Partial<SkillsReadRouteDeps> = {}) {
  return createSkillsReadRoutes({
    contentDir: '/tmp/ok-skills-read-unit',
    projectDir: undefined,
    homeDirOverride: '/tmp/ok-skills-read-unit-home',
    skillsHome: '/tmp/ok-skills-read-unit-home',
    isSafeDocName: () => true,
    commentService: { countThreads: async () => new Map<string, number>() },
    enumerateInstalledSkillsCached: (() => ({
      skills: [],
      packs: [],
    })) as unknown as SkillsReadRouteDeps['enumerateInstalledSkillsCached'],
    checkLocalOpSecurity,
    ...overrides,
  });
}

async function dispatch(
  group: ReturnType<typeof createSkillsReadRoutes>,
  path: string,
  reqOpts: Parameters<typeof makeSyntheticReq>[0],
): Promise<{ status: number; body: { type?: string; title?: string } }> {
  const resolved = group.table.resolve(path);
  if (!resolved?.dispatch) throw new Error(`no dispatch for ${path}`);
  const req = makeSyntheticReq({ url: path, ...reqOpts });
  const { res, captured } = makeCaptureRes();
  await resolved.dispatch(req, res);
  return {
    status: captured.status,
    body: captured.body ? (JSON.parse(captured.body) as { type?: string; title?: string }) : {},
  };
}

const READ_200 = ['/api/comment-counts?docNames=alpha', '/api/skills/installed', '/api/templates'];

const ALL_ROUTES = [
  '/api/comment-counts',
  '/api/skills/installed',
  '/api/templates',
  '/api/skill/install-state',
];

let tmpRoot: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-skills-read-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('skills-read group over the composed listener — served natively', () => {
  test('every route in the group is registered natively (POST → 405 + Allow: GET)', async () => {
    for (const path of ALL_ROUTES) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST' });
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toContain('GET');
    }
  });

  test('every read serves a 200 body natively (application/json + x-request-id)', async () => {
    for (const path of READ_200) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe('application/json');
      expect(res.headers.get('x-request-id'), path).not.toBeNull();
    }
  });

  test('both chained groups answer on one server (multi-group dispatch)', async () => {
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const templates = await fetch(`http://127.0.0.1:${server.port}/api/templates`);
    expect(templates.status).toBe(200);
  });
});

describe('skills-read inline gate — observable only at the handler layer', () => {
  test('skill/install-state short-circuits on checkLocalOpSecurity (foreign Origin → its own invalid-origin)', async () => {
    const out = await dispatch(buildSkillsReadRoutes(), '/api/skill/install-state', {
      remoteAddress: '127.0.0.1',
      origin: 'https://evil.example.com',
    });
    expect(out.status).toBe(403);
    expect(out.body.type).toBe('urn:ok:error:invalid-origin');
    expect(out.body.title).toBe('Origin header is not a permitted loopback origin.');
  });
});
