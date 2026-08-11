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
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

/**
 * A skill the sidebar LISTS but the editor cannot open is the same bug twice:
 * the doc name the list hands the client is not one the document index holds,
 * so the tab it opens has nothing behind it, the next page-list sync prunes it,
 * and the surface falls back to Files. Two independent ways in, both covered
 * here against a real booted server:
 *
 *   1. the skill dir is a SYMLINK, so its docs are indexed once per inode under
 *      the canonical dir they link to, never under the alias;
 *   2. the skill dir landed on disk AFTER boot without a handler that rebuilds
 *      the content filter's in-place allow-list, so it is not admitted at all.
 *
 * The tab-level half of (1) — alias name pruned, canonical name kept, canonical
 * still classified as a Skills tab — is pinned in the app's
 * `managed-artifact-doc-name.test.ts`.
 */

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

/** The doc name a client opens for an entry — what the app's builder mints. */
function liveDocName(entry: SkillRow): string {
  return (entry.canonicalPath ?? entry.path).replace(/\.mdx?$/i, '');
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-skills-admission-'));
  contentDir = mkdtempSync(resolve(tmpRoot, 'proj-'));
  // A repo that keeps its bundles in `plugins/<x>/skills/` and symlinks them
  // into the editor dir agents actually read from.
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
  // `destroy()` stops accepting work but does not join every background flush:
  // the server keeps writing under `.ok/local/cache/**`, so a plain recursive
  // delete can walk a directory that is repopulated under it and die on
  // ENOTEMPTY. Seen on CI (twice, including the retry) while passing locally —
  // a slower, more contended filesystem widens the window. Retry the unlink,
  // and never let cleanup of a tmpdir fail the suite: the assertions have
  // already run, and the OS reaps /tmp regardless.
  try {
    await rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Best-effort.
  }
});

test('a symlinked skill dir is reported at BOTH its mount path and its canonical doc', async () => {
  const linked = (await listSkills()).find((s) => s.name === 'linked');
  expect(linked).toBeDefined();
  // `path` still answers "where is this bundle mounted" — install targets,
  // reveal-in-Finder and host wiring all reason about the editor dir.
  expect(linked?.path).toBe('.agents/skills/linked/SKILL.md');
  expect(linked?.canonicalPath).toBe('plugins/ok/skills/linked/SKILL.md');
});

test('the doc name that mints from the entry is the one the index holds', async () => {
  const docs = await indexedDocs();
  const linked = (await listSkills()).find((s) => s.name === 'linked');
  expect(linked && docs.has(liveDocName(linked))).toBe(true);
  // The alias name resolves to the SAME inode, which is why it must not be
  // opened as its own doc: two Y.Docs would fight over one file.
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
  // Written straight to disk — the shape any writer that skips the allow-list
  // rebuild leaves behind, and what an older build did on every import.
  writeSkill(contentDir, '.claude/skills/late', '# Late');
  const docName = '.claude/skills/late/SKILL';

  // It lists immediately (the scan reads disk) but is not admitted as content:
  // exactly the state a user sees as "the skill is right there and won't open".
  expect((await indexedDocs()).has(docName)).toBe(false);
  expect((await listSkills()).some((s) => s.name === 'late')).toBe(true);

  // The heal rides that list call; the rebuild's re-scan lands asynchronously,
  // so the doc shows up on a later refresh rather than in that response.
  const deadline = Date.now() + 20_000;
  let docs = await indexedDocs();
  while (!docs.has(docName) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    docs = await indexedDocs();
  }
  expect(docs.has(docName)).toBe(true);
  // Admitting a doc must never touch the bytes on disk. The rebuild fans out to
  // an index prune + re-scan and a derived-scope refresh; a list read is not a
  // licence for any of them to reach the working tree.
  expect(existsSync(join(contentDir, '.claude/skills/late/SKILL.md'))).toBe(true);
  expect(readFileSync(join(contentDir, '.claude/skills/late/SKILL.md'), 'utf-8')).toContain(
    '# Late',
  );
}, 40_000);

test('the skills a list call reports are all still on disk afterwards', async () => {
  // Blast-radius check for the read-side heal: every listed project bundle must
  // survive being listed, including one mounted through a symlink.
  const before = (await listSkills()).filter((s) => s.scope === 'project');
  await listSkills();
  await listSkills();
  for (const s of before) {
    expect(existsSync(join(contentDir, s.path))).toBe(true);
  }
  const after = (await listSkills()).filter((s) => s.scope === 'project').map((s) => s.name);
  expect(after.sort()).toEqual(before.map((s) => s.name).sort());
});

/**
 * A gitignored bundle is listed but deliberately NOT admitted as content (OK
 * will not index a doc the sync engine could never commit). That is correct,
 * and it is also the single cause behind "the skill is right there and won't
 * open": `.claude/*` is a very common rule, so every skill installed into
 * `.claude/skills/` in such a repo is unopenable. The list has to SAY so, and
 * the offered fix has to be one git actually honours.
 */
test('a gitignored bundle lists as ignored and is not indexed', async () => {
  writeFileSync(join(contentDir, '.gitignore'), '.claude/*\n');
  writeSkill(contentDir, '.claude/skills/hidden', '# Hidden');
  // Both halves of the disagreement, in one place: it lists...
  const entry = (await listSkills()).find((s) => s.name === 'hidden');
  expect(entry?.ignored).toBe(true);
  // ...and it has no doc to open.
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
  // The whole skills DIRECTORY: git cannot re-include a file whose parent dir
  // is excluded, so a per-skill negation would look right and do nothing.
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
  // `.claude/` excludes the DIRECTORY, so nothing under it can be re-included
  // from below — the negation is powerless. Writing it anyway would leave the
  // user with a rule that looks like a fix and a skill that still won't open.
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
