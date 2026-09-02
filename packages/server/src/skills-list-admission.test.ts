import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

function writeSkill(root: string, rel: string, body: string): void {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  const name = rel.split('/').pop();
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`);
}

interface SkillRow {
  name: string;
  scope: string;
  path: string;
  canonicalPath?: string;
}

interface DocRow {
  kind: string;
  path?: string;
  docName?: string;
  isSymlink?: boolean;
  canonicalDocName?: string | null;
}

let tmpRoot: string;
let contentDir: string;
let booted: BootedServer;

async function listSkills(): Promise<SkillRow[]> {
  const res = await fetch(`http://127.0.0.1:${booted.port}/api/skills`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { skills: SkillRow[] }).skills;
}

async function indexedDocs(): Promise<Map<string, DocRow>> {
  const res = await fetch(`http://127.0.0.1:${booted.port}/api/documents`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { documents: DocRow[] };
  return new Map(
    body.documents.filter((d) => d.kind === 'document').map((d) => [d.docName ?? '', d]),
  );
}

function liveDocName(entry: SkillRow): string {
  return (entry.canonicalPath ?? entry.path).replace(/\.mdx?$/i, '');
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-skills-admission-'));
  contentDir = mkdtempSync(resolve(tmpRoot, 'proj-'));
  writeSkill(contentDir, 'plugins/ok/skills/linked', '# Linked');
  mkdirSync(join(contentDir, '.agents/skills'), { recursive: true });
  symlinkSync(
    resolve(contentDir, 'plugins/ok/skills/linked'),
    join(contentDir, '.agents/skills/linked'),
    'dir',
  );
  writeSkill(contentDir, '.agents/skills/plain', '# Plain');
  booted = await bootCompositionRig(contentDir);
}, 60_000);

afterAll(async () => {
  await booted?.destroy();
  try {
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {}
});

test('a symlinked skill dir is reported at BOTH its mount path and its canonical doc', async () => {
  const linked = (await listSkills()).find((s) => s.name === 'linked');
  expect(linked).toBeDefined();
  expect(linked?.path).toBe('.agents/skills/linked/SKILL.md');
  expect(linked?.canonicalPath).toBe('plugins/ok/skills/linked/SKILL.md');
});

test('the doc name that mints from the entry is the one the index holds', async () => {
  const docs = await indexedDocs();
  const linked = (await listSkills()).find((s) => s.name === 'linked');
  expect(linked && docs.has(liveDocName(linked))).toBe(true);
  expect(docs.get('.agents/skills/linked/SKILL')?.canonicalDocName).toBe(
    'plugins/ok/skills/linked/SKILL',
  );
  expect(docs.get('plugins/ok/skills/linked/SKILL')?.canonicalDocName).toBeNull();
});

test('an ordinary in-place skill carries no canonicalPath and opens at its own path', async () => {
  const plain = (await listSkills()).find((s) => s.name === 'plain');
  expect(plain?.canonicalPath).toBeUndefined();
  expect(plain && liveDocName(plain)).toBe('.agents/skills/plain/SKILL');
  expect((await indexedDocs()).has('.agents/skills/plain/SKILL')).toBe(true);
});

test('a skill dir written after boot becomes servable via the list, with no restart', async () => {
  writeSkill(contentDir, '.claude/skills/late', '# Late');
  const docName = '.claude/skills/late/SKILL';

  expect((await indexedDocs()).has(docName)).toBe(false);
  expect((await listSkills()).some((s) => s.name === 'late')).toBe(true);

  const deadline = Date.now() + 20_000;
  let docs = await indexedDocs();
  while (!docs.has(docName) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    docs = await indexedDocs();
  }
  expect(docs.has(docName)).toBe(true);
  expect(existsSync(join(contentDir, '.claude/skills/late/SKILL.md'))).toBe(true);
  expect(readFileSync(join(contentDir, '.claude/skills/late/SKILL.md'), 'utf-8')).toContain(
    '# Late',
  );
}, 40_000);

test('the skills a list call reports are all still on disk afterwards', async () => {
  const before = (await listSkills()).filter((s) => s.scope === 'project');
  await listSkills();
  await listSkills();
  for (const s of before) {
    expect(existsSync(isAbsolute(s.path) ? s.path : join(contentDir, s.path))).toBe(true);
  }
  const after = (await listSkills()).filter((s) => s.scope === 'project').map((s) => s.name);
  expect(after.sort()).toEqual(before.map((s) => s.name).sort());
});

test('a gitignored bundle lists as ignored and is not indexed', async () => {
  writeFileSync(join(contentDir, '.gitignore'), '.claude/*\n');
  writeSkill(contentDir, '.claude/skills/hidden', '# Hidden');
  const entry = (await listSkills()).find((s) => s.name === 'hidden');
  expect(entry?.ignored).toBe(true);
  expect((await indexedDocs()).has('.claude/skills/hidden/SKILL')).toBe(false);
});

test('an ordinary bundle is not flagged ignored', async () => {
  const plain = (await listSkills()).find((s) => s.name === 'plain');
  expect(plain?.ignored).toBeUndefined();
});

test('track-in-git previews the exact line without touching .gitignore', async () => {
  const before = readFileSync(join(contentDir, '.gitignore'), 'utf-8');
  const res = await fetch(`http://127.0.0.1:${booted.port}/api/skill/track-in-git`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'hidden', scope: 'project' }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { line: string; gitignorePath: string; applied: boolean };
  expect(body.line).toBe('!/.claude/skills/');
  expect(body.gitignorePath).toBe('.gitignore');
  expect(body.applied).toBe(false);
  expect(readFileSync(join(contentDir, '.gitignore'), 'utf-8')).toBe(before);
});

test('applying it makes the skill indexed, with no restart', async () => {
  const res = await fetch(`http://127.0.0.1:${booted.port}/api/skill/track-in-git`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'hidden', scope: 'project', apply: true }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()) as { applied: boolean }).toMatchObject({ applied: true });
  expect(readFileSync(join(contentDir, '.gitignore'), 'utf-8')).toContain('!/.claude/skills/');

  const entry = (await listSkills()).find((s) => s.name === 'hidden');
  expect(entry?.ignored).toBeUndefined();

  const deadline = Date.now() + 20_000;
  let docs = await indexedDocs();
  while (!docs.has('.claude/skills/hidden/SKILL') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    docs = await indexedDocs();
  }
  expect(docs.has('.claude/skills/hidden/SKILL')).toBe(true);
}, 40_000);

test('a rule that cannot work is reverted, not left behind', async () => {
  writeFileSync(join(contentDir, '.gitignore'), '.codex/\n');
  writeSkill(contentDir, '.codex/skills/buried', '# Buried');
  const before = readFileSync(join(contentDir, '.gitignore'), 'utf-8');

  const res = await fetch(`http://127.0.0.1:${booted.port}/api/skill/track-in-git`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'buried', scope: 'project', apply: true }),
  });
  expect(res.status).toBe(409);
  expect(readFileSync(join(contentDir, '.gitignore'), 'utf-8')).toBe(before);
});

test('a global skill is refused — it lives outside any repo', async () => {
  const res = await fetch(`http://127.0.0.1:${booted.port}/api/skill/track-in-git`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'hidden', scope: 'global' }),
  });
  expect(res.status).toBe(400);
});
