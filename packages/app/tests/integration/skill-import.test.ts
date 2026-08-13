import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EDITOR_USER_SKILL_ROOT } from '@inkeep/open-knowledge-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  createTestServer,
  HARNESS_BOOT_TIMEOUT_MS,
  pollUntil,
  type TestServer,
} from './test-harness.ts';

/**
 * End-to-end proof of `POST /api/skill/import` (slice 3): a fetched skill-dir
 * lands in `.ok/skills/<name>` as content via the sanctioned writers, its
 * scripts are written but NEVER executed, upstream is recorded in
 * `.ok/skills-lock.json`, collisions get an `-imported` name, and an identical
 * re-import is a no-op (contentHash dedupe).
 */

let srcRoot: string;

function writeSkillDir(dir: string, name: string, description: string, body = 'Body.'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
}

beforeAll(() => {
  srcRoot = mkdtempSync(join(tmpdir(), 'ok-import-src-'));
}, HARNESS_BOOT_TIMEOUT_MS);
afterAll(() => {
  rmSync(srcRoot, { recursive: true, force: true });
});

describe('POST /api/skill/import', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await createTestServer();
    mkdirSync(join(server.contentDir, '.claude'), { recursive: true });
  });
  afterEach(async () => {
    await server.cleanup();
  });

  const base = () => `http://127.0.0.1:${server.port}`;
  const importSkill = (payload: Record<string, unknown>) =>
    fetch(`${base()}/api/skill/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  test('project import reports no usable target without creating a host root', async () => {
    rmSync(join(server.contentDir, '.claude'), { recursive: true, force: true });
    rmSync(join(server.contentDir, '.agents'), { recursive: true, force: true });
    const dir = join(srcRoot, 'project-no-host');
    writeSkillDir(dir, 'project-no-host', 'No implicit host');

    const res = await importSkill({ source: dir });
    const body = (await res.json()) as { detail?: string; title?: string };

    expect({
      status: res.status,
      detail: body.detail,
      claudeRootExists: existsSync(join(server.contentDir, '.claude')),
      agentsRootExists: existsSync(join(server.contentDir, '.agents')),
    }).toEqual({
      status: 400,
      detail: 'NO_USABLE_SKILL_HOME',
      claudeRootExists: false,
      agentsRootExists: false,
    });
    // The refusal has to be actionable, not merely correct: name the folders
    // OK would accept and what to do, since it never creates one itself.
    expect(body.title).toContain('.claude/');
    expect(body.title).toContain('Create the folder your agent uses');
  });

  test('imports a local skill-dir as content + records provenance; scripts not executed', async () => {
    const dir = join(srcRoot, 'single');
    writeSkillDir(dir, 'cool-skill', 'Does cool things', '# Cool\n');
    // A script that WOULD create a marker file if executed.
    const marker = join(srcRoot, 'PWNED');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'run.sh'), `#!/bin/sh\ntouch '${marker}'\n`);
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'references', 'api.md'), '# API\n');

    const res = await importSkill({ source: dir });
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      name: string;
      created: boolean;
      alreadyImported: boolean;
      provenance: { contentHash: string; source: string };
    };
    expect(out.name).toBe('cool-skill');
    expect(out.created).toBe(true);
    expect(out.alreadyImported).toBe(false);
    expect(out.provenance.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // Content landed on disk.
    const skillMd = resolve(server.contentDir, '.claude', 'skills', 'cool-skill', 'SKILL.md');
    await pollUntil(() => existsSync(skillMd));
    expect(readFileSync(skillMd, 'utf-8')).toContain('name: cool-skill');
    expect(
      existsSync(
        resolve(server.contentDir, '.claude', 'skills', 'cool-skill', 'scripts', 'run.sh'),
      ),
    ).toBe(true);
    // The script was imported as content, NOT executed.
    expect(existsSync(marker)).toBe(false);

    // Provenance recorded in the lockfile.
    const lock = JSON.parse(
      readFileSync(resolve(server.contentDir, '.ok', 'skills-lock.json'), 'utf-8'),
    );
    expect(lock.skills['cool-skill'].contentHash).toBe(out.provenance.contentHash);
    expect(lock.skills['cool-skill'].source).toBe(dir);
  });

  test('identical re-import is a no-op (contentHash dedupe)', async () => {
    const dir = join(srcRoot, 'dup');
    writeSkillDir(dir, 'dup-skill', 'd');
    expect((await importSkill({ source: dir })).status).toBe(200);
    const second = (await importSkill({ source: dir }).then((r) => r.json())) as {
      alreadyImported: boolean;
      name: string;
    };
    expect(second.alreadyImported).toBe(true);
    expect(second.name).toBe('dup-skill');
  });

  test('duplicate copies the complete bundle, including binary files', async () => {
    const dir = join(srcRoot, 'duplicate-source');
    writeSkillDir(dir, 'duplicate-source', 'source', '# Original\n');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    writeFileSync(join(dir, 'assets', 'logo.png'), binary);
    expect((await importSkill({ source: dir, install: false })).status).toBe(200);
    const sourceHome = existsSync(join(server.contentDir, '.agents')) ? '.agents' : '.claude';
    const installedSourceDir = resolve(server.contentDir, sourceHome, 'skills', 'duplicate-source');
    writeFileSync(
      join(installedSourceDir, 'SKILL.md'),
      [
        '---',
        '# keep this comment',
        'name: duplicate-source',
        'description: source',
        'tags: [audit, reusable]',
        'metadata:',
        '  owner: platform',
        '---',
        '# Original',
        '',
      ].join('\n'),
    );

    const duplicate = await fetch(`${base()}/api/skill/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        name: 'duplicate-source',
        toName: 'duplicate-source-copy',
      }),
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ name: 'duplicate-source-copy' });

    const copiedDir = resolve(server.contentDir, sourceHome, 'skills', 'duplicate-source-copy');
    expect(readFileSync(join(copiedDir, 'assets', 'logo.png')).equals(binary)).toBe(true);
    const copiedSkillMd = readFileSync(join(copiedDir, 'SKILL.md'), 'utf-8');
    expect(copiedSkillMd).toContain('name: duplicate-source-copy');
    expect(copiedSkillMd).toContain('# keep this comment');
    expect(copiedSkillMd).toMatch(/tags: \[\s*audit,\s*reusable\s*\]/);
    expect(copiedSkillMd).toContain('owner: platform');

    const conflict = await fetch(`${base()}/api/skill/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        name: 'duplicate-source',
        toName: 'duplicate-source-copy',
      }),
    });
    expect(conflict.status).toBe(409);

    const missing = await fetch(`${base()}/api/skill/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        name: 'does-not-exist',
        toName: 'does-not-exist-copy',
      }),
    });
    expect(missing.status).toBe(404);
  });

  test('name collision with different content lands under -imported', async () => {
    const a = join(srcRoot, 'collide-a');
    const b = join(srcRoot, 'collide-b');
    writeSkillDir(a, 'twin', 'first', 'Original.');
    writeSkillDir(b, 'twin', 'second', 'Different body.');
    expect((await importSkill({ source: a })).status).toBe(200);
    const out = (await importSkill({ source: b }).then((r) => r.json())) as {
      name: string;
      collisionRenamedFrom?: string;
    };
    expect(out.name).toBe('twin-imported');
    expect(out.collisionRenamedFrom).toBe('twin');
  });

  test('multi-skill source requires --skill and imports the chosen one', async () => {
    const repo = join(srcRoot, 'multi');
    writeSkillDir(join(repo, 'skills', 'alpha'), 'alpha', 'a');
    writeSkillDir(join(repo, 'skills', 'beta'), 'beta', 'b');

    const ambiguous = await importSkill({ source: repo });
    expect(ambiguous.status).toBe(400);

    const picked = (await importSkill({ source: repo, skill: 'beta' }).then((r) => r.json())) as {
      name: string;
    };
    expect(picked.name).toBe('beta');
  });

  /**
   * The `skill` selector matches the SKILL.md frontmatter `name`, not only the
   * on-disk folder — the skills.sh case where the folder (`react-native-skills`)
   * and the frontmatter name (`vercel-react-native-skills`) diverge.
   *
   */
  test('picks a skill by frontmatter name when it differs from the folder', async () => {
    const repo = join(srcRoot, 'fm-name');
    writeSkillDir(join(repo, 'skills', 'react-native-skills'), 'vercel-react-native-skills', 'rn');
    writeSkillDir(join(repo, 'skills', 'other'), 'other', 'o');

    const picked = (await importSkill({
      source: repo,
      skill: 'vercel-react-native-skills',
    }).then((r) => r.json())) as { name: string };
    expect(picked.name).toBe('vercel-react-native-skills');
  });

  test('rejects a request with no source', async () => {
    expect((await importSkill({})).status).toBe(400);
  });
});

describe('POST /api/skill/import at global scope', () => {
  let server: TestServer;
  let homeDir: string;
  let sourceDir: string;

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'ok-global-import-home-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'ok-global-import-source-'));
    writeSkillDir(sourceDir, 'global-copy', 'Global plugin copy');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    server = await createTestServer({ configHomedirOverride: homeDir });
  });

  afterEach(async () => {
    await server.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  test('records provenance in the global lock and surfaces it on the copied skill', async () => {
    const importResponse = await fetch(`${server.baseUrl}/api/skill/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: sourceDir,
        scope: 'global',
        install: false,
      }),
    });
    expect(importResponse.status).toBe(200);

    const globalLockPath = join(homeDir, '.ok', 'skills-lock.json');
    const globalLock = JSON.parse(readFileSync(globalLockPath, 'utf-8')) as {
      skills: Record<string, { source: string }>;
    };
    expect(globalLock.skills['global-copy']?.source).toBe(sourceDir);

    const projectLockPath = join(server.contentDir, '.ok', 'skills-lock.json');
    const projectLock = existsSync(projectLockPath)
      ? (JSON.parse(readFileSync(projectLockPath, 'utf-8')) as {
          skills: Record<string, { source: string }>;
        })
      : null;
    expect(projectLock?.skills['global-copy']).toBeUndefined();

    const list = (await fetch(`${server.baseUrl}/api/skills`).then((res) => res.json())) as {
      skills: Array<{ name: string; scope: string; origin?: { source: string } }>;
    };
    expect(
      list.skills.find((skill) => skill.scope === 'global' && skill.name === 'global-copy')?.origin
        ?.source,
    ).toBe(sourceDir);
  });

  test('global import reports no usable target without creating a host root', async () => {
    for (const root of Object.values(EDITOR_USER_SKILL_ROOT)) {
      const hostRoot = root?.split('/')[0];
      if (hostRoot !== undefined) rmSync(join(homeDir, hostRoot), { recursive: true, force: true });
    }
    rmSync(join(homeDir, '.agents'), { recursive: true, force: true });

    const res = await fetch(`${server.baseUrl}/api/skill/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: sourceDir, scope: 'global' }),
    });
    const body = (await res.json()) as { detail?: string };

    expect({
      status: res.status,
      detail: body.detail,
      claudeRootExists: existsSync(join(homeDir, '.claude')),
      agentsRootExists: existsSync(join(homeDir, '.agents')),
    }).toEqual({
      status: 400,
      detail: 'NO_USABLE_SKILL_HOME',
      claudeRootExists: false,
      agentsRootExists: false,
    });
  });
});

describe('POST /api/skill/reimport', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await createTestServer();
    mkdirSync(join(server.contentDir, '.claude'), { recursive: true });
  });
  afterEach(async () => {
    await server.cleanup();
  });

  const base = () => `http://127.0.0.1:${server.port}`;
  const importSkill = (payload: Record<string, unknown>) =>
    fetch(`${base()}/api/skill/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const reimport = (payload: Record<string, unknown>) =>
    fetch(`${base()}/api/skill/reimport`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  test('reimport overwrites in place when the source changed, no-ops when unchanged', async () => {
    const dir = join(srcRoot, 'reimport-src');
    writeSkillDir(dir, 'evolving', 'v1', '# One\n');
    expect((await importSkill({ source: dir })).status).toBe(200);

    // Unchanged source → up to date, nothing rewritten.
    const same = (await reimport({ name: 'evolving' }).then((r) => r.json())) as {
      updated: boolean;
    };
    expect(same.updated).toBe(false);

    // Change the upstream, then reimport → overwrite in place (same name).
    writeSkillDir(dir, 'evolving', 'v2', '# Two\n');
    const changed = (await reimport({ name: 'evolving' }).then((r) => r.json())) as {
      updated: boolean;
      name: string;
    };
    expect(changed.updated).toBe(true);
    expect(changed.name).toBe('evolving');

    const skillMd = resolve(server.contentDir, '.claude', 'skills', 'evolving', 'SKILL.md');
    await pollUntil(() => readFileSync(skillMd, 'utf-8').includes('# Two'));
    expect(readFileSync(skillMd, 'utf-8')).toContain('description: v2');
  });

  test('reimport prunes bundle files removed upstream before advancing the lock', async () => {
    const dir = join(srcRoot, 'reimport-prune-src');
    writeSkillDir(dir, 'shrinking', 'v1', '# One\n');
    mkdirSync(join(dir, 'references'), { recursive: true });
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'references', 'keep.md'), '# Keep\n');
    writeFileSync(join(dir, 'references', 'removed.md'), '# Remove\n');
    writeFileSync(join(dir, 'assets', 'removed.bin'), Buffer.from([0x00, 0xff]));
    expect((await importSkill({ source: dir, install: false })).status).toBe(200);

    const skillRoot = existsSync(join(server.contentDir, '.agents'))
      ? resolve(server.contentDir, '.agents', 'skills', 'shrinking')
      : resolve(server.contentDir, '.claude', 'skills', 'shrinking');
    expect(existsSync(join(skillRoot, 'references', 'removed.md'))).toBe(true);
    expect(existsSync(join(skillRoot, 'assets', 'removed.bin'))).toBe(true);

    rmSync(join(dir, 'references', 'removed.md'));
    rmSync(join(dir, 'assets', 'removed.bin'));
    writeSkillDir(dir, 'shrinking', 'v2', '# Two\n');
    const updated = (await reimport({ name: 'shrinking' }).then((r) => r.json())) as {
      updated: boolean;
    };
    expect(updated.updated).toBe(true);
    expect(existsSync(join(skillRoot, 'references', 'keep.md'))).toBe(true);
    expect(existsSync(join(skillRoot, 'references', 'removed.md'))).toBe(false);
    expect(existsSync(join(skillRoot, 'assets', 'removed.bin'))).toBe(false);

    const second = (await reimport({ name: 'shrinking' }).then((r) => r.json())) as {
      updated: boolean;
    };
    expect(second.updated).toBe(false);

    // A legacy lock has no upstream-file manifest. Once local bytes diverge,
    // ownership is ambiguous, so a user-authored file must survive reimport.
    const lockPath = resolve(server.contentDir, '.ok', 'skills-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    delete lock.skills.shrinking.files;
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    writeFileSync(join(skillRoot, 'references', 'user-notes.md'), '# Local notes\n');
    writeSkillDir(dir, 'shrinking', 'v3', '# Three\n');

    const legacyUpdated = (await reimport({ name: 'shrinking' }).then((r) => r.json())) as {
      updated: boolean;
    };
    expect(legacyUpdated.updated).toBe(true);
    expect(readFileSync(join(skillRoot, 'references', 'user-notes.md'), 'utf-8')).toBe(
      '# Local notes\n',
    );
  });

  test('setAutoUpdate persists the per-skill opt-out without fetching upstream', async () => {
    const dir = join(srcRoot, 'auto-update-src');
    writeSkillDir(dir, 'auto-toggled', 'v1', '# One\n');
    expect((await importSkill({ source: dir })).status).toBe(200);

    const lockPath = resolve(server.contentDir, '.ok', 'skills-lock.json');
    // An absent field delegates to the source-kind default (this local source is ON).
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).skills['auto-toggled'].autoUpdate).toBe(
      undefined,
    );

    const off = (await reimport({ name: 'auto-toggled', setAutoUpdate: false }).then((r) =>
      r.json(),
    )) as { updated: boolean };
    expect(off.updated).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).skills['auto-toggled'].autoUpdate).toBe(
      false,
    );

    // The list surfaces the flag through `origin` for the toolbar toggle.
    const list = (await fetch(`${base()}/api/skills?scope=project`).then((r) => r.json())) as {
      skills: { name: string; origin?: { autoUpdate?: boolean } }[];
    };
    expect(list.skills.find((sk) => sk.name === 'auto-toggled')?.origin?.autoUpdate).toBe(false);

    // Back on persists the explicit choice (remote sources default OFF, so
    // deleting the field here would lose a user's opt-in).
    expect((await reimport({ name: 'auto-toggled', setAutoUpdate: true })).status).toBe(200);
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).skills['auto-toggled'].autoUpdate).toBe(
      true,
    );
  });

  test('reimport of a non-imported (authored) skill is rejected', async () => {
    // No lockfile entry → nothing to update from.
    expect((await reimport({ name: 'never-imported' })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('GET /api/skills/preview', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await createTestServer();
  });
  afterEach(async () => {
    await server.cleanup();
  });

  const preview = (params: Record<string, string>) =>
    fetch(`http://127.0.0.1:${server.port}/api/skills/preview?${new URLSearchParams(params)}`);

  test('returns the un-imported skill SKILL.md text (verbatim, frontmatter included)', async () => {
    const dir = join(srcRoot, 'preview-single');
    writeSkillDir(dir, 'previewable', 'Preview me', '# Heading\n\nProse.\n');
    const res = await preview({ source: dir, name: 'previewable' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; skillMd: string };
    expect(body.name).toBe('previewable');
    expect(body.skillMd).toContain('name: previewable');
    expect(body.skillMd).toContain('# Heading');
  });

  test('normalizes provider-owned plugin metadata without leaking cache paths to the UI', async () => {
    const pluginsRoot = join(srcRoot, 'preview-plugin', 'plugins');
    const pluginRoot = join(pluginsRoot, 'cache', 'market', 'toolkit', '1.2.3');
    const skillDir = join(pluginRoot, 'skills', 'previewable-plugin');
    writeSkillDir(skillDir, 'previewable-plugin', 'Plugin preview');
    mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'toolkit', version: '1.2.3' }),
    );
    writeFileSync(
      join(pluginsRoot, 'known_marketplaces.json'),
      JSON.stringify({ market: { source: { source: 'github', repo: 'acme/toolkit' } } }),
    );

    const res = await preview({ source: skillDir, name: 'previewable-plugin' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plugin?: Record<string, string>;
      marketplaceUrl?: string;
    };
    expect(body.plugin).toEqual({
      provider: 'claude',
      plugin: 'toolkit',
      version: '1.2.3',
      marketplace: 'market',
      repositoryUrl: 'https://github.com/acme/toolkit',
    });
    expect(body.marketplaceUrl).toBeUndefined();
  });

  test('404s when the name does not match a source skill, exactly as import does', async () => {
    // Preview is the consent surface. Rendering the first skill on a name miss
    // showed one skill's prose under another's name and then import refused the
    // same miss, so the user could only install something they had not read.
    const repo = join(srcRoot, 'preview-multi');
    writeSkillDir(join(repo, 'alpha'), 'alpha', 'A');
    writeSkillDir(join(repo, 'beta'), 'beta', 'B');
    const res = await preview({ source: repo, name: 'does-not-exist' });
    expect(res.status).toBe(404);
  });

  test('matches on the frontmatter name when it differs from the folder', async () => {
    const repo = join(srcRoot, 'preview-fm-name');
    writeSkillDir(join(repo, 'react-native-skills'), 'vercel-react-native', 'A');
    writeSkillDir(join(repo, 'beta'), 'beta', 'B');
    const res = await preview({ source: repo, name: 'vercel-react-native' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe('vercel-react-native');
  });

  test('with no name, still renders the first skill so a source can be browsed', async () => {
    const repo = join(srcRoot, 'preview-browse');
    writeSkillDir(join(repo, 'alpha'), 'alpha', 'A');
    writeSkillDir(join(repo, 'beta'), 'beta', 'B');
    const res = await preview({ source: repo });
    expect(res.status).toBe(200);
    expect(['alpha', 'beta']).toContain(((await res.json()) as { name: string }).name);
  });

  test('rejects a source with no SKILL.md', async () => {
    const empty = join(srcRoot, 'preview-empty');
    mkdirSync(empty, { recursive: true });
    expect((await preview({ source: empty, name: 'x' })).status).toBe(404);
  });

  test('rejects a missing source', async () => {
    expect((await preview({ name: 'x' })).status).toBe(400);
  });
});

describe('GET /api/skills/discover', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await createTestServer();
  });
  afterEach(async () => {
    await server.cleanup();
  });

  const discover = (source: string) =>
    fetch(`http://127.0.0.1:${server.port}/api/skills/discover?${new URLSearchParams({ source })}`);

  test('lists every skill (frontmatter name + description) in a multi-skill source', async () => {
    const repo = join(srcRoot, 'discover-multi');
    writeSkillDir(join(repo, 'skills', 'a'), 'alpha', 'A skill');
    writeSkillDir(join(repo, 'skills', 'b'), 'beta', 'B skill');
    const res = await discover(repo);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: { name: string; description: string | null }[] };
    const byName = Object.fromEntries(body.skills.map((s) => [s.name, s.description]));
    expect(byName.alpha).toBe('A skill');
    expect(byName.beta).toBe('B skill');
  });

  test('returns the single skill for a one-skill source', async () => {
    const dir = join(srcRoot, 'discover-single');
    writeSkillDir(dir, 'solo', 'only one');
    const body = (await discover(dir).then((r) => r.json())) as { skills: { name: string }[] };
    expect(body.skills.map((s) => s.name)).toEqual(['solo']);
  });

  /**
   * A source with no SKILL.md is not an error here — it just yields no picker
   * (the import path is what 404s when the user commits).
   *
   */
  test('returns an empty list (200) for a source with no SKILL.md', async () => {
    const empty = join(srcRoot, 'discover-empty');
    mkdirSync(empty, { recursive: true });
    const res = await discover(empty);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { skills: unknown[] }).skills).toEqual([]);
  });

  test('rejects a missing source', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/skills/discover`);
    expect(res.status).toBe(400);
  });
});
