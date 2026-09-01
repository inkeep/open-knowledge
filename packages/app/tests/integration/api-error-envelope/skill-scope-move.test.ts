import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SkillsListSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, pollUntil, type TestServer } from '../test-harness';

let server: TestServer;
let tmpHome: string;
const base = () => `http://127.0.0.1:${server.port}`;
const skillsRootIn = (b: string) =>
  existsSync(join(b, '.agents')) ? join(b, '.agents', 'skills') : join(b, '.claude', 'skills');
const skillsRootRelIn = (b: string) =>
  existsSync(join(b, '.agents')) ? '.agents/skills' : '.claude/skills';
const NAME = 'trip-log';

const putSkill = (scope: 'global' | 'project', name = NAME) =>
  fetch(`${base()}/api/skill`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope,
      name,
      body: '## When\n\nLogging a trip.',
      frontmatter: { name, description: 'Use when logging a trip.' },
    }),
  });

const delSkill = (scope: 'global' | 'project', name = NAME) =>
  fetch(`${base()}/api/skill?name=${name}&scope=${scope}`, { method: 'DELETE' });

async function move(from: 'global' | 'project', to: 'global' | 'project') {
  expect((await putSkill(to)).status).toBe(200);
  expect((await delSkill(from)).status).toBe(200);
}

const putSkillFile = (scope: 'global' | 'project', name: string, path: string, content: string) =>
  fetch(`${base()}/api/skill-file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, name, path, content }),
  });

async function bundleFilePaths(scope: 'global' | 'project', name: string): Promise<string[]> {
  const res = await fetch(`${base()}/api/skill?name=${name}&scope=${scope}`);
  const detail = (await res.json().catch(() => null)) as {
    skill?: { files?: Array<{ path?: string }> };
  } | null;
  return (detail?.skill?.files ?? [])
    .map((f) => f.path)
    .filter((p): p is string => typeof p === 'string');
}

async function moveFullBundle(from: 'global' | 'project', to: 'global' | 'project', name: string) {
  expect((await putSkill(to, name)).status).toBe(200);
  for (const path of await bundleFilePaths(from, name)) {
    const read = await fetch(`${base()}/api/skill-file?name=${name}&scope=${from}&path=${path}`);
    expect(read.ok).toBe(true);
    const { text } = (await read.json()) as { text: string };
    expect((await putSkillFile(to, name, path, text)).status).toBe(200);
  }
  expect((await delSkill(from, name)).status).toBe(200);
}

async function backlinkSources(target: string): Promise<string[]> {
  const res = await fetch(`${base()}/api/backlinks?docName=${encodeURIComponent(target)}`);
  const data = (await res.json()) as { backlinks?: Array<{ source: string }> };
  return Array.isArray(data.backlinks) ? data.backlinks.map((b) => b.source) : [];
}

async function scopeOf(name: string): Promise<string | undefined> {
  const res = await fetch(`${base()}/api/skills`);
  const parsed = SkillsListSuccessSchema.safeParse(await res.json());
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data.skills.find((s) => s.name === name)?.scope : undefined;
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ok-scope-move-home-'));
  mkdirSync(join(tmpHome, '.claude', 'skills'), { recursive: true });
  server = await createTestServer({ configHomedirOverride: tmpHome });
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(async () => {
  await server.cleanup();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('E1: cross-scope move / global re-create', () => {
  test('re-create a global skill after deleting it (no project involved)', async () => {
    const N = 'recreate-probe';
    expect((await putSkill('global', N)).status).toBe(200);
    expect(existsSync(join(skillsRootIn(tmpHome), N, 'SKILL.md'))).toBe(true);
    expect((await delSkill('global', N)).status).toBe(200);
    expect(existsSync(join(skillsRootIn(tmpHome), N, 'SKILL.md'))).toBe(false);
    expect((await putSkill('global', N)).status).toBe(200);
    expect(existsSync(join(skillsRootIn(tmpHome), N, 'SKILL.md'))).toBe(true);
  });

  test('global → project → global: list shows it under global at each step', async () => {
    expect((await putSkill('global')).status).toBe(200);
    expect(await scopeOf(NAME)).toBe('global');
    await move('global', 'project');
    expect(await scopeOf(NAME)).toBe('project');
    await move('project', 'global');
    expect(await scopeOf(NAME)).toBe('global');
  });

  test('a cross-scope move carries references + scripts; the project .md ref rejoins the graph', async () => {
    const N = 'bundle-move-probe';
    expect((await putSkill('global', N)).status).toBe(200);
    expect(
      (await putSkillFile('global', N, 'references/notes.md', '# Notes\n\nSee [[xs-target]].\n'))
        .status,
    ).toBe(200);
    const script = '#!/usr/bin/env bash\necho hi\n';
    expect((await putSkillFile('global', N, 'scripts/run.sh', script)).status).toBe(200);

    await moveFullBundle('global', 'project', N);

    const projRef = join(skillsRootIn(server.contentDir), N, 'references', 'notes.md');
    const projScript = join(skillsRootIn(server.contentDir), N, 'scripts', 'run.sh');
    expect(existsSync(projRef)).toBe(true);
    expect(existsSync(projScript)).toBe(true);
    expect(readFileSync(projScript, 'utf-8')).toBe(script);
    expect(existsSync(join(skillsRootIn(tmpHome), N))).toBe(false);
    expect(await scopeOf(N)).toBe('project');

    const target = await fetch(`${base()}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName: 'xs-target', markdown: '# T\n', position: 'replace' }),
    });
    expect(target.ok).toBe(true);
    await pollUntil(async () =>
      (await backlinkSources('xs-target')).includes(
        `${skillsRootRelIn(server.contentDir)}/${N}/references/notes`,
      ),
    );
  }, 20000);
});

const moveScope = (name: string, fromScope: 'global' | 'project', toScope: 'global' | 'project') =>
  fetch(`${base()}/api/skill/move-scope`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, fromScope, toScope }),
  });

const readSkillBody = async (scope: 'global' | 'project', name: string): Promise<string> => {
  const res = await fetch(`${base()}/api/skill?name=${name}&scope=${scope}`);
  const detail = (await res.json().catch(() => null)) as { skill?: { body?: string } } | null;
  return detail?.skill?.body ?? '';
};

describe('E2: atomic /api/skill/move-scope', () => {
  test('global → project → global keeps SKILL.md body byte-identical (no doubling)', async () => {
    const N = 'atomic-trip';
    expect((await putSkill('global', N)).status).toBe(200);
    const before = await readSkillBody('global', N);

    expect((await moveScope(N, 'global', 'project')).status).toBe(200);
    expect(await scopeOf(N)).toBe('project');
    expect((await moveScope(N, 'project', 'global')).status).toBe(200);
    expect(await scopeOf(N)).toBe('global');

    expect(await readSkillBody('global', N)).toBe(before);
    const md = readFileSync(join(skillsRootIn(tmpHome), N, 'SKILL.md'), 'utf-8');
    expect(md.match(/^---$/gm)?.length).toBe(2);
  });

  test('carries a raw binary bundle file (the text-only copy silently dropped it)', async () => {
    const N = 'atomic-binary';
    expect((await putSkill('global', N)).status).toBe(200);
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe]);
    const srcAsset = join(skillsRootIn(tmpHome), N, 'references', 'logo.png');
    mkdirSync(dirname(srcAsset), { recursive: true });
    writeFileSync(srcAsset, bin);

    expect((await moveScope(N, 'global', 'project')).status).toBe(200);

    const destAsset = join(skillsRootIn(server.contentDir), N, 'references', 'logo.png');
    expect(existsSync(destAsset)).toBe(true);
    expect(readFileSync(destAsset).equals(bin)).toBe(true);
    expect(existsSync(join(skillsRootIn(tmpHome), N))).toBe(false);
  });

  test('transfers imported provenance and keeps copy projections across scopes', async () => {
    const N = 'atomic-provenance';
    expect((await putSkill('global', N)).status).toBe(200);

    const globalLockPath = join(tmpHome, '.ok', 'skills-lock.json');
    mkdirSync(dirname(globalLockPath), { recursive: true });
    writeFileSync(
      globalLockPath,
      `${JSON.stringify(
        {
          schema: 1,
          skills: {
            [N]: {
              source: 'https://github.com/acme/skills',
              contentHash: 'upstream-hash',
              localHash: 'pre-move-local-hash',
              importedAt: '2026-07-29T12:00:00.000Z',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const install = await fetch(`${base()}/api/skill/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'global',
        name: N,
        targets: ['claude', 'cursor'],
        linkMode: false,
      }),
    });
    expect(install.status).toBe(200);

    expect((await moveScope(N, 'global', 'project')).status).toBe(200);

    const globalLock = JSON.parse(readFileSync(globalLockPath, 'utf-8')) as {
      skills: Record<string, unknown>;
    };
    const projectLock = JSON.parse(
      readFileSync(join(server.contentDir, '.ok', 'skills-lock.json'), 'utf-8'),
    ) as { skills: Record<string, { source: string; localHash?: string }> };
    expect(globalLock.skills[N]).toBeUndefined();
    expect(projectLock.skills[N]?.source).toBe('https://github.com/acme/skills');
    expect(projectLock.skills[N]?.localHash).not.toBe('pre-move-local-hash');
    expect(lstatSync(join(server.contentDir, '.cursor', 'skills', N)).isSymbolicLink()).toBe(false);

    const listed = (await fetch(`${base()}/api/skills?scope=project`).then((r) => r.json())) as {
      skills: Array<{ name: string; origin?: { source: string } }>;
    };
    expect(listed.skills.find((skill) => skill.name === N)?.origin?.source).toBe(
      'https://github.com/acme/skills',
    );
  });

  test('refuses (409) when the destination scope already has that name; source untouched', async () => {
    const N = 'atomic-dup';
    expect((await putSkill('global', N)).status).toBe(200);
    expect((await putSkill('project', N)).status).toBe(200);
    expect((await moveScope(N, 'global', 'project')).status).toBe(409);
    expect(existsSync(join(skillsRootIn(tmpHome), N, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsRootIn(server.contentDir), N, 'SKILL.md'))).toBe(true);
  });
});
