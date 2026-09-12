import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withFsCopyCompletionObserver } from '../../../server/src/fs-copy-observer.test-helper.ts';
import { moveSkillCrossScope } from '../../../server/src/mcp/tools/skill-target.ts';
import { createTestServer, HARNESS_BOOT_TIMEOUT_MS, type TestServer } from './test-harness.ts';

let server: TestServer;
let fixtureRoot: string;
const post = (path: string, body: Record<string, unknown>) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

function retentionLedger(): Record<string, Record<string, unknown>> {
  const path = join(fixtureRoot, 'home', '.ok', 'local', 'skill-move-retained.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')).retained;
}

function seedSkill(root: string, name: string): string {
  const dir = join(root, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  const text = `---\nname: ${name}\ndescription: Bundle\nmetadata:\n  pack: sample-pack\n  custom: keep-me\n---\n\nBody stays byte-identical.\n`;
  writeFileSync(join(dir, 'SKILL.md'), text);
  return text;
}

beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'ok-mcp-move-'));
  const home = join(fixtureRoot, 'home');
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  server = await createTestServer({ configHomedirOverride: home });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('MCP cross-scope move', () => {
  test('preserves binary bundles, provenance and installed editors', async () => {
    const name = 'complete-bundle';
    const source = join(fixtureRoot, 'source', name);
    mkdirSync(join(source, 'references'), { recursive: true });
    writeFileSync(
      join(source, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Bundle\n---\n\nBody.\n`,
    );
    const binary = Buffer.from([0, 255, 128, 13, 10, 0, 24]);
    writeFileSync(join(source, 'references', 'data.bin'), binary);
    expect((await post('/api/skill/import', { source, scope: 'project' })).status).toBe(200);
    expect((await post('/api/skill/install', { name, add: ['claude', 'cursor'] })).status).toBe(
      200,
    );

    const result = await moveSkillCrossScope(`http://127.0.0.1:${server.port}`, {
      fromScope: 'project',
      toScope: 'global',
      fromName: name,
      toName: name,
    });

    expect(result.isError).toBeUndefined();
    for (const host of ['claude', 'cursor']) {
      const dest = join(fixtureRoot, 'home', `.${host}`, 'skills', name);
      expect(readFileSync(join(dest, 'references', 'data.bin'))).toEqual(binary);
      expect(existsSync(join(server.contentDir, `.${host}`, 'skills', name))).toBe(false);
    }
    const globalLock = JSON.parse(
      readFileSync(join(fixtureRoot, 'home', '.ok', 'skills-lock.json'), 'utf8'),
    );
    expect(globalLock.skills[name].source).toBe(source);
    const projectLock = JSON.parse(
      readFileSync(join(server.contentDir, '.ok', 'skills-lock.json'), 'utf8'),
    );
    expect(projectLock.skills[name]).toBeUndefined();
  });

  test('a renaming move re-keys provenance, install records and editor placements under the new name', async () => {
    const home = join(fixtureRoot, 'home');
    const fromName = 'rekey-original';
    const toName = 'rekey-renamed';
    const source = join(fixtureRoot, 'source', fromName);
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'SKILL.md'),
      `---\nname: ${fromName}\ndescription: Bundle\n---\n\nBody.\n`,
    );
    expect((await post('/api/skill/import', { source, scope: 'project' })).status).toBe(200);
    expect(
      (await post('/api/skill/install', { name: fromName, add: ['claude', 'cursor'] })).status,
    ).toBe(200);
    const importedLocalHash = JSON.parse(
      readFileSync(join(server.contentDir, '.ok', 'skills-lock.json'), 'utf8'),
    ).skills[fromName].localHash;
    expect(importedLocalHash).toEqual(expect.any(String));

    const result = await moveSkillCrossScope(server.baseUrl, {
      fromScope: 'project',
      toScope: 'global',
      fromName,
      toName,
    });

    expect(result.isError).toBeUndefined();
    const globalLock = JSON.parse(readFileSync(join(home, '.ok', 'skills-lock.json'), 'utf8'));
    expect(globalLock.skills[toName]?.source).toBe(source);
    expect(globalLock.skills[fromName]).toBeUndefined();
    expect(globalLock.skills[toName]?.localHash).toEqual(expect.any(String));
    expect(globalLock.skills[toName]?.localHash).not.toBe(importedLocalHash);
    const installed = JSON.parse(
      readFileSync(join(home, '.ok', 'local', 'installed-skills.json'), 'utf8'),
    );
    expect(installed.skills[toName]?.hosts).toEqual(expect.arrayContaining(['claude', 'cursor']));
    expect(installed.skills[fromName]).toBeUndefined();
    for (const host of ['claude', 'cursor']) {
      expect(existsSync(join(home, `.${host}`, 'skills', toName, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(home, `.${host}`, 'skills', fromName))).toBe(false);
      expect(existsSync(join(server.contentDir, `.${host}`, 'skills', fromName))).toBe(false);
    }
  });

  test('renames directly across scopes without colliding with unrelated intermediate names', async () => {
    const home = join(fixtureRoot, 'home');
    const fromName = 'direct-original';
    const toName = 'direct-renamed';
    const original = seedSkill(server.contentDir, fromName);
    const unrelatedGlobal = seedSkill(home, fromName);
    const unrelatedProject = seedSkill(server.contentDir, toName);

    const result = await moveSkillCrossScope(`http://127.0.0.1:${server.port}`, {
      fromScope: 'project',
      toScope: 'global',
      fromName,
      toName,
    });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(join(home, '.claude', 'skills', toName, 'SKILL.md'), 'utf8')).toBe(
      original.replace(`name: ${fromName}`, `name: ${toName}`),
    );
    expect(readFileSync(join(home, '.claude', 'skills', fromName, 'SKILL.md'), 'utf8')).toBe(
      unrelatedGlobal,
    );
    expect(
      readFileSync(join(server.contentDir, '.claude', 'skills', toName, 'SKILL.md'), 'utf8'),
    ).toBe(unrelatedProject);
    expect(existsSync(join(server.contentDir, '.claude', 'skills', fromName))).toBe(false);
  });

  test('refuses the final destination collision before moving or deleting the source', async () => {
    const home = join(fixtureRoot, 'home');
    const fromName = 'collision-original';
    const toName = 'collision-renamed';
    const original = seedSkill(server.contentDir, fromName);
    const destination = seedSkill(home, toName);

    const result = await moveSkillCrossScope(`http://127.0.0.1:${server.port}`, {
      fromScope: 'project',
      toScope: 'global',
      fromName,
      toName,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.moveState).toBe('nothing-written');
    expect(result.content[0]?.text).toContain('Delete or rename it first');
    expect(
      readFileSync(join(server.contentDir, '.claude', 'skills', fromName, 'SKILL.md'), 'utf8'),
    ).toBe(original);
    expect(readFileSync(join(home, '.claude', 'skills', toName, 'SKILL.md'), 'utf8')).toBe(
      destination,
    );
    expect(existsSync(join(home, '.claude', 'skills', fromName))).toBe(false);
  });

  test('partial source-removal failure retains the complete renamed destination for recovery', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce directory write permissions.');
    }
    const home = join(fixtureRoot, 'home');
    const fromName = 'rollback-original';
    const toName = 'rollback-renamed';
    const original = seedSkill(server.contentDir, fromName);
    const unrelated = seedSkill(home, fromName);
    const source = join(server.contentDir, '.claude', 'skills', fromName);
    const destination = join(home, '.claude', 'skills', toName);
    chmodSync(dirname(source), 0o555);
    try {
      const response = await post('/api/skill/move-scope', {
        name: fromName,
        toName,
        fromScope: 'project',
        toScope: 'global',
      });
      const result = await response.json();
      expect(response.status).toBe(500);
      expect(result.detail).toContain('UNLINK_FAILED');
      expect(existsSync(join(home, '.claude', 'skills', fromName, 'SKILL.md'))).toBe(true);
      expect(readFileSync(join(home, '.claude', 'skills', fromName, 'SKILL.md'), 'utf8')).toBe(
        unrelated,
      );
      expect(existsSync(destination)).toBe(true);
      expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(
        original.replace(`name: ${fromName}`, `name: ${toName}`),
      );
      expect(existsSync(source)).toBe(true);
      expect(existsSync(join(source, 'SKILL.md'))).toBe(false);
      expect(result.moveState).toBe('destination-retained');
      expect(result.sourceState).toBe('lossy');
      expect(result.detail).toContain('recover missing source files from the retained copy');
      expect(result.detail).not.toContain('no files were lost');
      expect(retentionLedger()[`global:${toName}`]).toMatchObject({ sourceState: 'lossy' });
      expect(result.detail).toContain('Inspect both locations before retrying');
      expect(result.detail).toContain(toName);
      expect(JSON.stringify(result)).not.toContain('rolled back');
    } finally {
      chmodSync(dirname(source), 0o755);
    }
  });

  test('rename write and cleanup failures retain the source and report the stray destination', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce directory write permissions.');
    }
    const home = join(fixtureRoot, 'home');
    const fromName = 'cleanup-original';
    const toName = 'cleanup-renamed';
    const original = seedSkill(server.contentDir, fromName);
    const unrelated = seedSkill(home, fromName);
    const source = join(server.contentDir, '.claude', 'skills', fromName);
    const destination = join(home, '.claude', 'skills', toName);
    try {
      const response = await withFsCopyCompletionObserver(
        (path) => path.endsWith(join('skills', toName)),
        () => {
          chmodSync(join(destination, 'SKILL.md'), 0o444);
          chmodSync(destination, 0o555);
        },
        () =>
          post('/api/skill/move-scope', {
            name: fromName,
            toName,
            fromScope: 'project',
            toScope: 'global',
          }),
      );
      const result = await response.json();
      expect(response.status).toBe(500);
      expect(result.moveState).toBe('destination-stray');
      expect(result.detail).toContain('UNLINK_FAILED');
      expect(result.detail).toContain(toName);
      expect(result.detail).toContain('Inspect the destination before retrying');
      expect(JSON.stringify(result)).not.toContain('rolled back');
      expect(existsSync(join(home, '.claude', 'skills', fromName, 'SKILL.md'))).toBe(true);
      expect(readFileSync(join(home, '.claude', 'skills', fromName, 'SKILL.md'), 'utf8')).toBe(
        unrelated,
      );
      expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toBe(original);
      expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(original);
    } finally {
      if (existsSync(destination)) chmodSync(destination, 0o755);
    }
  });

  test('a copied SKILL.md the rename cannot rewrite is cleaned up while the intact source remains retryable', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce file permissions.');
    }
    const home = join(fixtureRoot, 'home');
    const fromName = 'write-failed-original';
    const toName = 'write-failed-renamed';
    const original = seedSkill(server.contentDir, fromName);
    const unrelated = seedSkill(home, fromName);
    const destination = join(home, '.claude', 'skills', toName);
    const input = { name: fromName, toName, fromScope: 'project', toScope: 'global' };
    try {
      const response = await withFsCopyCompletionObserver(
        (path) => path.endsWith(join('skills', toName)),
        () => {
          const copied = join(destination, 'SKILL.md');
          rmSync(copied);
          mkdirSync(copied);
          writeFileSync(join(copied, 'occupant.txt'), 'Not a skill file.');
        },
        () => post('/api/skill/move-scope', input),
      );
      const result = await response.json();
      expect(response.status).toBe(500);
      expect(result.moveState).toBe('destination-removed');
      expect(result.detail).toContain('RENAME_FAILED');
      expect(result.detail).toContain('was not removed');
      expect(existsSync(destination)).toBe(false);
      expect(
        readFileSync(join(server.contentDir, '.claude', 'skills', fromName, 'SKILL.md'), 'utf8'),
      ).toBe(original);
      expect(readFileSync(join(home, '.claude', 'skills', fromName, 'SKILL.md'), 'utf8')).toBe(
        unrelated,
      );
      expect((await post('/api/skill/move-scope', input)).status).toBe(200);
      expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(
        original.replace(`name: ${fromName}`, `name: ${toName}`),
      );
    } finally {
      if (existsSync(join(destination, 'SKILL.md', 'occupant.txt'))) {
        rmSync(destination, { recursive: true, force: true });
      }
    }
  });

  test('an unreadable copied frontmatter reports failed cleanup without touching its source', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce directory write permissions.');
    }
    const fromName = 'invalid-copy-original';
    const toName = 'invalid-copy-renamed';
    const original = seedSkill(server.contentDir, fromName);
    writeFileSync(join(server.contentDir, '.claude', 'skills', fromName, 'note.txt'), 'Keep me.');
    const destination = join(fixtureRoot, 'home', '.claude', 'skills', toName);
    try {
      const response = await withFsCopyCompletionObserver(
        (path) => path.endsWith(join('skills', toName)),
        () => {
          rmSync(join(destination, 'SKILL.md'));
          chmodSync(destination, 0o555);
        },
        () =>
          post('/api/skill/move-scope', {
            name: fromName,
            toName,
            fromScope: 'project',
            toScope: 'global',
          }),
      );
      const result = await response.json();
      expect(response.status).toBe(500);
      expect(result.moveState).toBe('destination-stray');
      expect(result.detail).toContain('UNREADABLE_SKILL');
      expect(result.detail).toContain('UNLINK_FAILED');
      expect(
        readFileSync(join(server.contentDir, '.claude', 'skills', fromName, 'SKILL.md'), 'utf8'),
      ).toBe(original);
      expect(readFileSync(join(destination, 'note.txt'), 'utf8')).toBe('Keep me.');
    } finally {
      if (existsSync(destination)) chmodSync(destination, 0o755);
    }
  });

  test('only editor placements transfer across scopes, not the agents hub or custom roots', async () => {
    const name = 'placement-boundaries';
    const home = join(fixtureRoot, 'home');
    const original = seedSkill(server.contentDir, name);
    expect(
      (
        await post('/api/skill/install', {
          name,
          add: ['agents', '.team/skills'],
          mode: 'copy',
        })
      ).status,
    ).toBe(200);
    for (const root of ['.agents/skills', '.team/skills']) {
      expect(readFileSync(join(server.contentDir, root, name, 'SKILL.md'), 'utf8')).toBe(original);
    }
    const result = await moveSkillCrossScope(server.baseUrl, {
      fromName: name,
      toName: name,
      fromScope: 'project',
      toScope: 'global',
    });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(join(home, '.claude', 'skills', name, 'SKILL.md'), 'utf8')).toBe(original);
    for (const root of ['.agents/skills', '.team/skills']) {
      expect(existsSync(join(home, root, name))).toBe(false);
      expect(existsSync(join(server.contentDir, root, name))).toBe(false);
    }
    expect(result.structuredContent?.droppedLocations).toEqual(['.team/skills', 'agents']);
    expect(result.content[0]?.text).toContain('.team/skills');
    expect(result.content[0]?.text).toContain(
      `install({ name: "${name}", scope: "global", add: [".team/skills", "agents"] })`,
    );

    const replayed = result.structuredContent?.droppedLocations as string[];
    const replay = await post('/api/skill/install', {
      name,
      scope: 'global',
      add: replayed,
      mode: 'copy',
    });
    expect(replay.status).toBe(200);
    try {
      for (const root of ['.agents/skills', '.team/skills']) {
        expect(readFileSync(join(home, root, name, 'SKILL.md'), 'utf8')).toBe(original);
        expect(existsSync(join(home, root, name, name))).toBe(false);
      }
    } finally {
      await post('/api/skill/install', { name, scope: 'global', remove: replayed });
      rmSync(join(home, '.team'), { recursive: true, force: true });
      rmSync(join(home, '.agents'), { recursive: true, force: true });
    }
  });

  test('a destination lost after source removal reports the committed state and recovery guidance', async (ctx) => {
    if (process.platform === 'win32') ctx.skip('Requires unprivileged file symlinks.');
    const name = 'destination-disappears';
    seedSkill(server.contentDir, name);
    const source = join(server.contentDir, '.claude', 'skills', name);
    const swept = join(server.contentDir, '.cursor', 'skills', name);
    const destination = join(fixtureRoot, 'home', '.claude', 'skills', name);
    expect((await post('/api/skill/install', { name, add: ['cursor'], mode: 'copy' })).status).toBe(
      200,
    );
    expect(existsSync(join(swept, 'SKILL.md'))).toBe(true);
    const response = await withFsCopyCompletionObserver(
      (path) => path.endsWith(join('skills', name)),
      () => {
        rmSync(join(destination, 'SKILL.md'));
        symlinkSync(join(source, 'SKILL.md'), join(destination, 'SKILL.md'), 'file');
      },
      () =>
        post('/api/skill/move-scope', {
          name,
          fromScope: 'project',
          toScope: 'global',
        }),
    );
    const result = await response.json();
    expect(response.status).toBe(500);
    expect(existsSync(source)).toBe(false);
    expect(existsSync(join(destination, 'SKILL.md'))).toBe(false);
    expect(result.moveState).toBe('destination-unreadable');
    expect(result.detail).toContain('shadow-repo history');
    expect(result.detail).toContain('before retrying');
    expect(JSON.stringify(result)).not.toContain('nothing was reported as moved');
    expect(existsSync(swept)).toBe(false);
    expect(result.droppedLocations).toEqual(['cursor']);

    rmSync(join(server.contentDir, '.cursor'), { recursive: true, force: true });
    rmSync(join(fixtureRoot, 'home', '.cursor'), { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  });

  test('a built-in destination name is refused by naming the destination, not the source', async () => {
    const fromName = 'builtin-dest-original';
    seedSkill(server.contentDir, fromName);

    const response = await post('/api/skill/move-scope', {
      name: fromName,
      toName: 'open-knowledge',
      fromScope: 'project',
      toScope: 'global',
    });
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.moveState).toBe('nothing-written');
    expect(result.title).toContain('"open-knowledge" is a built-in skill name');
    expect(result.title).not.toContain(fromName);
    expect(existsSync(join(server.contentDir, '.claude', 'skills', fromName, 'SKILL.md'))).toBe(
      true,
    );
  });

  test('a destination directory with no readable SKILL.md is not reported as a skill to delete', async () => {
    const fromName = 'stray-occupant-original';
    const toName = 'stray-occupant-renamed';
    seedSkill(server.contentDir, fromName);
    const occupant = join(fixtureRoot, 'home', '.claude', 'skills', toName);
    mkdirSync(join(occupant, 'references'), { recursive: true });
    writeFileSync(join(occupant, 'references', 'kept.txt'), 'Left behind by hand.');

    const response = await post('/api/skill/move-scope', {
      name: fromName,
      toName,
      fromScope: 'project',
      toScope: 'global',
    });
    const result = await response.json();

    expect(response.status).toBe(409);
    expect(result.moveState).toBe('nothing-written');
    expect(result.retentionLedger).toBeUndefined();
    expect(result.detail).toContain('no readable SKILL.md');
    expect(result.detail).not.toContain('Delete or rename it first');
    expect(readFileSync(join(occupant, 'references', 'kept.txt'), 'utf8')).toBe(
      'Left behind by hand.',
    );
  });

  test('a retained intact source blocks the retry with the same verdict the failure gave', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce directory write permissions.');
    }
    const name = 'intact-source';
    const original = seedSkill(server.contentDir, name);
    const source = join(server.contentDir, '.claude', 'skills', name);
    const destination = join(fixtureRoot, 'home', '.claude', 'skills', name);
    chmodSync(source, 0o555);
    try {
      const response = await post('/api/skill/move-scope', {
        name,
        fromScope: 'project',
        toScope: 'global',
      });
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.moveState).toBe('destination-retained');
      expect(result.sourceState).toBe('intact');
      expect(result.detail).toContain('UNLINK_FAILED');
      expect(result.detail).toContain('is unchanged at its original scope');
      expect(result.detail).not.toContain('recover missing source files');
      expect(result.detail).not.toContain('may be partially removed');
      expect(result.detail).not.toContain('could not record the retention');
      expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toBe(original);
      expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(original);

      expect(readdirSync(destination)).toEqual(['SKILL.md']);
      expect(retentionLedger()['global:intact-source']).toMatchObject({
        from: 'project:intact-source',
        to: 'global:intact-source',
        sourceState: 'intact',
        reason: 'UNLINK_FAILED',
      });

      const retry = await post('/api/skill/move-scope', {
        name,
        fromScope: 'project',
        toScope: 'global',
      });
      const retried = await retry.json();

      expect(retry.status).toBe(409);
      expect(retried.moveState).toBe('destination-retained-blocking');
      expect(retried.sourceState).toBe('intact');
      expect(retried.detail).toContain('a move of "project:intact-source"');
      expect(retried.detail).toContain('redundant duplicate');
      expect(retried.detail).toContain('remove it, then retry');
      expect(retried.detail).not.toContain('Do NOT delete it');
      expect(retried.detail).not.toContain('only copy');
      expect(retried.detail).not.toContain('Delete or rename it first');
      expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(original);
    } finally {
      chmodSync(source, 0o755);
      rmSync(destination, { recursive: true, force: true });
    }
  });

  test('a retention the server cannot write is disclosed, not silently swallowed', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce directory write permissions.');
    }
    const name = 'retention-write-refused';
    const home = join(fixtureRoot, 'home');
    const localDir = join(home, '.ok', 'local');
    const ledgerPath = join(localDir, 'skill-move-retained.json');
    const original = seedSkill(server.contentDir, name);
    const source = join(server.contentDir, '.claude', 'skills', name);
    const destination = join(home, '.claude', 'skills', name);
    mkdirSync(localDir, { recursive: true });
    if (!existsSync(ledgerPath)) {
      writeFileSync(ledgerPath, `${JSON.stringify({ schema: 1, retained: {} }, null, 2)}\n`);
    }
    const ledgerBefore = readFileSync(ledgerPath, 'utf8');
    chmodSync(source, 0o555);
    chmodSync(localDir, 0o555);
    try {
      const response = await post('/api/skill/move-scope', {
        name,
        fromScope: 'project',
        toScope: 'global',
      });
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.moveState).toBe('destination-retained');
      expect(result.sourceState).toBe('intact');
      expect(result.detail).toContain('could not record the retention');
      expect(result.detail).toContain('ordinary name collision');
      expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toBe(original);
      expect(readdirSync(destination)).toEqual(['SKILL.md']);
      expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toBe(original);
      expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore);
      expect(JSON.parse(ledgerBefore).retained[`global:${name}`]).toBeUndefined();
    } finally {
      chmodSync(localDir, 0o755);
      chmodSync(source, 0o755);
      writeFileSync(ledgerPath, ledgerBefore);
      rmSync(destination, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test('a resolved retention is cleared, so a later collision on the name is reported as one', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce directory write permissions.');
    }
    const name = 'retention-lifecycle';
    seedSkill(server.contentDir, name);
    const source = join(server.contentDir, '.claude', 'skills', name);
    const destination = join(fixtureRoot, 'home', '.claude', 'skills', name);
    const move = () =>
      post('/api/skill/move-scope', { name, fromScope: 'project', toScope: 'global' });

    chmodSync(source, 0o555);
    try {
      expect((await move()).status).toBe(500);
      expect(retentionLedger()[`global:${name}`]).toBeDefined();
    } finally {
      chmodSync(source, 0o755);
    }

    rmSync(destination, { recursive: true, force: true });
    expect((await move()).status).toBe(200);
    expect(retentionLedger()[`global:${name}`]).toBeUndefined();

    seedSkill(server.contentDir, name);
    const collision = await move();
    const refused = await collision.json();

    expect(collision.status).toBe(409);
    expect(refused.moveState).toBe('nothing-written');
    expect(refused.sourceState).toBeUndefined();
    expect(refused.detail).toContain('Delete or rename it first');
    expect(refused.detail).not.toContain('retained');
    expect(refused.detail).not.toContain('only copy');
  });

  test('a record whose retained copy is gone does not warn about a copy that is not there', async () => {
    const name = 'retention-stale';
    seedSkill(server.contentDir, name);
    const elsewhere = join(fixtureRoot, 'home', '.cursor', 'skills', name);
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(
      join(elsewhere, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Occupant\n---\n\nElsewhere.\n`,
    );
    const ledger = join(fixtureRoot, 'home', '.ok', 'local', 'skill-move-retained.json');
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(
      ledger,
      JSON.stringify({
        schema: 1,
        retained: {
          [`global:${name}`]: {
            retainedAt: '2026-01-01T00:00:00.000Z',
            from: `project:${name}`,
            to: `global:${name}`,
            sourceState: 'lossy',
            reason: 'UNLINK_FAILED',
          },
        },
      }),
    );

    const response = await post('/api/skill/move-scope', {
      name,
      fromScope: 'project',
      toScope: 'global',
    });
    const refused = await response.json();

    expect(existsSync(join(fixtureRoot, 'home', '.claude', 'skills', name))).toBe(false);
    expect(response.status).toBe(409);
    expect(refused.moveState).toBe('nothing-written');
    expect(refused.detail).not.toContain('Do NOT delete it');
    expect(refused.detail).not.toContain('only copy');
    rmSync(elsewhere, { recursive: true, force: true });
    rmSync(ledger, { force: true });
  });

  test('a record whose retained copy was replaced does not vouch for the replacement', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce directory write permissions.');
    }
    const name = 'retention-superseded';
    seedSkill(server.contentDir, name);
    const source = join(server.contentDir, '.claude', 'skills', name);
    const destination = join(fixtureRoot, 'home', '.claude', 'skills', name);
    chmodSync(source, 0o555);
    try {
      expect(
        (await post('/api/skill/move-scope', { name, fromScope: 'project', toScope: 'global' }))
          .status,
      ).toBe(500);
      expect(retentionLedger()[`global:${name}`]).toBeDefined();
    } finally {
      chmodSync(source, 0o755);
    }

    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(
      join(destination, 'SKILL.md'),
      `---\nname: ${name}\ndescription: An unrelated skill that happens to own the name\n---\n\nNot the retained copy.\n`,
    );

    const response = await post('/api/skill/move-scope', {
      name,
      fromScope: 'project',
      toScope: 'global',
    });
    const refused = await response.json();

    expect(response.status).toBe(409);
    expect(refused.moveState).toBe('nothing-written');
    expect(refused.sourceState).toBeUndefined();
    expect(refused.detail).toContain('Delete or rename it first');
    expect(refused.detail).not.toContain('retained');
    expect(refused.detail).not.toContain('remove it, then retry');
    expect(retentionLedger()[`global:${name}`]).toBeUndefined();

    rmSync(destination, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });

  test('an unreadable ledger refuses without telling the operator to delete the occupant', async () => {
    const name = 'retention-unreadable-ledger';
    seedSkill(server.contentDir, name);
    const destination = join(fixtureRoot, 'home', '.claude', 'skills', name);
    mkdirSync(destination, { recursive: true });
    writeFileSync(
      join(destination, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Occupant\n---\n\nOccupant body.\n`,
    );
    const ledger = join(fixtureRoot, 'home', '.ok', 'local', 'skill-move-retained.json');
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, '{"schema":1,"retained":{"global:');

    try {
      const response = await post('/api/skill/move-scope', {
        name,
        fromScope: 'project',
        toScope: 'global',
      });
      const refused = await response.json();

      expect(response.status).toBe(409);
      expect(refused.moveState).toBe('nothing-written');
      expect(refused.retentionLedger).toBe('unreadable');
      expect(refused.detail).toContain('could not read its retained-destination ledger');
      expect(refused.detail).toContain('Do NOT delete it before comparing it against the source');
      expect(refused.detail).not.toContain('Delete or rename it first');
      expect(readFileSync(ledger, 'utf8')).toBe('{"schema":1,"retained":{"global:');
    } finally {
      rmSync(destination, { recursive: true, force: true });
      rmSync(join(server.contentDir, '.claude', 'skills', name), { recursive: true, force: true });
      rmSync(ledger, { force: true });
    }
  });

  test('a retained copy the server cannot re-read is not reported as an ordinary collision', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce file read permissions.');
    }
    const name = 'retained-unreadable-copy';
    const source = join(server.contentDir, '.claude', 'skills', name);
    const destination = join(fixtureRoot, 'home', '.claude', 'skills', name);
    const destinationBundleFile = join(destination, 'references', 'data.md');
    mkdirSync(join(source, 'references'), { recursive: true });
    writeFileSync(
      join(source, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Bundle\n---\n\nBody.\n`,
    );
    writeFileSync(join(source, 'references', 'data.md'), 'Bundle body.\n');
    chmodSync(source, 0o555);
    try {
      const failed = await (
        await post('/api/skill/move-scope', { name, fromScope: 'project', toScope: 'global' })
      ).json();
      expect(failed.moveState).toBe('destination-retained');
      expect(retentionLedger()[`global:${name}`]).toBeDefined();

      chmodSync(destinationBundleFile, 0o000);
      const response = await post('/api/skill/move-scope', {
        name,
        fromScope: 'project',
        toScope: 'global',
      });
      const refused = await response.json();

      expect(response.status).toBe(409);
      expect(refused.moveState).toBe('nothing-written');
      expect(refused.retentionLedger).toBe('occupant-unverifiable');
      expect(refused.detail).toContain('has a record of retaining a copy under that name');
      expect(refused.detail).toContain(`from a move of "project:${name}"`);
      expect(refused.detail).toContain('Do NOT delete it before comparing it against the source');
      expect(refused.detail).not.toContain('Delete or rename it first');
      expect(refused.detail).toContain('(EACCES)');
      expect(refused.detail).not.toContain(fixtureRoot);
      expect(retentionLedger()[`global:${name}`]).toBeDefined();
    } finally {
      chmodSync(source, 0o755);
      if (existsSync(destinationBundleFile)) chmodSync(destinationBundleFile, 0o644);
      rmSync(destination, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test('a same-scope rename onto a retained copy carries the reconcile-first detail', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce directory permissions.');
    }
    const name = 'rename-onto-retained';
    const fromName = 'rename-onto-retained-source';
    const home = join(fixtureRoot, 'home');
    const source = join(server.contentDir, '.claude', 'skills', name);
    const bundle = join(source, 'references');
    const retainedCopy = join(home, '.claude', 'skills', name);
    const renameSource = join(home, '.claude', 'skills', fromName);
    seedSkill(server.contentDir, name);
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'data.md'), 'Bundle body.\n');
    try {
      const seeded = await (
        await withFsCopyCompletionObserver(
          (path) => path.endsWith(join('skills', name)),
          () => {
            chmodSync(bundle, 0o000);
            chmodSync(source, 0o555);
          },
          () => post('/api/skill/move-scope', { name, fromScope: 'project', toScope: 'global' }),
        )
      ).json();
      expect(seeded.moveState).toBe('destination-retained');
      expect(seeded.sourceState).toBe('unknown');
      expect(retentionLedger()[`global:${name}`]).toMatchObject({ sourceState: 'unknown' });
      chmodSync(bundle, 0o755);
      chmodSync(source, 0o755);
      rmSync(source, { recursive: true, force: true });

      mkdirSync(renameSource, { recursive: true });
      writeFileSync(
        join(renameSource, 'SKILL.md'),
        `---\nname: ${fromName}\ndescription: Bundle\n---\n\nBody.\n`,
      );
      const response = await post('/api/skill', { scope: 'global', fromName, toName: name });
      const refused = await response.json();

      expect(response.status).toBe(409);
      expect(refused.detail).toContain('Do NOT delete it before reconciling it against the source');
      expect(refused.detail).toContain(`a move of "project:${name}"`);
      expect(refused.detail).not.toContain('Delete or rename it first');
      expect(retentionLedger()[`global:${name}`]).toBeDefined();
      expect(existsSync(join(renameSource, 'SKILL.md'))).toBe(true);
    } finally {
      if (existsSync(bundle)) chmodSync(bundle, 0o755);
      if (existsSync(source)) chmodSync(source, 0o755);
      rmSync(source, { recursive: true, force: true });
      rmSync(retainedCopy, { recursive: true, force: true });
      rmSync(renameSource, { recursive: true, force: true });
    }
  });

  test('a collision at a non-default host root stays an ordinary delete-or-rename refusal', async () => {
    const name = 'collision-off-default-root';
    const home = join(fixtureRoot, 'home');
    const source = join(server.contentDir, '.claude', 'skills', name);
    const occupant = join(home, '.cursor', 'skills', name);
    const defaultDestination = join(home, '.claude', 'skills', name);
    seedSkill(server.contentDir, name);
    mkdirSync(occupant, { recursive: true });
    writeFileSync(
      join(occupant, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Occupant\n---\n\nOccupant body.\n`,
    );
    try {
      expect(existsSync(defaultDestination)).toBe(false);
      const response = await post('/api/skill/move-scope', {
        name,
        fromScope: 'project',
        toScope: 'global',
      });
      const refused = await response.json();

      expect(response.status).toBe(409);
      expect(refused.moveState).toBe('nothing-written');
      expect(refused.retentionLedger).toBeUndefined();
      expect(refused.detail).toBe('Delete or rename it first; this move will not overwrite it.');
    } finally {
      rmSync(join(home, '.cursor'), { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test('an unreadable first-time occupant is never reported as delete-or-rename', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce file read permissions.');
    }
    const name = 'unreadable-first-collision';
    const source = join(server.contentDir, '.claude', 'skills', name);
    const destination = join(fixtureRoot, 'home', '.claude', 'skills', name);
    const destinationBundleFile = join(destination, 'references', 'data.md');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Bundle\n---\n\nBody.\n`,
    );
    mkdirSync(join(destination, 'references'), { recursive: true });
    writeFileSync(
      join(destination, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Occupant\n---\n\nOccupant body.\n`,
    );
    writeFileSync(destinationBundleFile, 'Occupant bundle.\n');
    chmodSync(destinationBundleFile, 0o000);
    try {
      expect(retentionLedger()[`global:${name}`]).toBeUndefined();
      const response = await post('/api/skill/move-scope', {
        name,
        fromScope: 'project',
        toScope: 'global',
      });
      const refused = await response.json();

      expect(response.status).toBe(409);
      expect(refused.moveState).toBe('nothing-written');
      expect(refused.retentionLedger).toBe('occupant-unverifiable');
      expect(refused.detail).toContain('could not read it to determine whether it is a skill');
      expect(refused.detail).toContain('Verify it against the source before removing it');
      expect(refused.detail).not.toContain('Delete or rename it first');
      expect(refused.detail).toContain('(EACCES)');
      expect(refused.detail).not.toContain(fixtureRoot);
      expect(existsSync(join(source, 'SKILL.md'))).toBe(true);
    } finally {
      chmodSync(destinationBundleFile, 0o644);
      rmSync(destination, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test('a source that cannot be verified reports sourceState unknown, not a claim of no loss', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce directory read permissions.');
    }
    const name = 'unverifiable-source';
    seedSkill(server.contentDir, name);
    const source = join(server.contentDir, '.claude', 'skills', name);
    const bundle = join(source, 'references');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'data.md'), 'Bundle body.\n');

    try {
      const response = await withFsCopyCompletionObserver(
        (path) => path.endsWith(join('skills', name)),
        () => {
          chmodSync(bundle, 0o000);
          chmodSync(source, 0o555);
        },
        () => post('/api/skill/move-scope', { name, fromScope: 'project', toScope: 'global' }),
      );
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.moveState).toBe('destination-retained');
      expect(result.sourceState).toBe('unknown');
      expect(result.detail).toContain('whether any files were lost is unknown');
      expect(result.detail).not.toContain('no files were lost');
      expect(result.detail).not.toContain('may be partially removed');

      chmodSync(source, 0o755);
      chmodSync(bundle, 0o755);
      const retry = await post('/api/skill/move-scope', {
        name,
        fromScope: 'project',
        toScope: 'global',
      });
      const retried = await retry.json();

      expect(retry.status).toBe(409);
      expect(retried.moveState).toBe('destination-retained-blocking');
      expect(retried.sourceState).toBe('unknown');
      expect(retried.detail).toContain(`a move of "project:${name}"`);
      expect(retried.detail).toContain('Do NOT delete it');
      expect(retried.detail).not.toContain('redundant duplicate');
      expect(retried.detail).not.toContain('Delete or rename it first');
    } finally {
      chmodSync(source, 0o755);
      chmodSync(bundle, 0o755);
      rmSync(source, { recursive: true, force: true });
    }
  });

  test('an unreadable destination copy is cleaned up before the source is touched', async () => {
    const name = 'precommit-unreadable';
    const original = seedSkill(server.contentDir, name);
    const source = join(server.contentDir, '.claude', 'skills', name);
    const destination = join(fixtureRoot, 'home', '.claude', 'skills', name);

    const response = await withFsCopyCompletionObserver(
      (path) => path.endsWith(join('skills', name)),
      () => {
        rmSync(join(destination, 'SKILL.md'));
      },
      () => post('/api/skill/move-scope', { name, fromScope: 'project', toScope: 'global' }),
    );
    const result = await response.json();

    expect(response.status).toBe(500);
    expect(result.moveState).toBe('destination-removed');
    expect(result.detail).toContain('was not touched and is unchanged');
    expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toBe(original);
    expect(existsSync(destination)).toBe(false);
  });

  test('an unreadable destination copy whose cleanup fails is reported as stray, source untouched', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce directory write permissions.');
    }
    const name = 'precommit-stray';
    const original = seedSkill(server.contentDir, name);
    const source = join(server.contentDir, '.claude', 'skills', name);
    writeFileSync(join(source, 'note.txt'), 'Keep me.');
    const destination = join(fixtureRoot, 'home', '.claude', 'skills', name);

    try {
      const response = await withFsCopyCompletionObserver(
        (path) => path.endsWith(join('skills', name)),
        () => {
          rmSync(join(destination, 'SKILL.md'));
          chmodSync(destination, 0o555);
        },
        () => post('/api/skill/move-scope', { name, fromScope: 'project', toScope: 'global' }),
      );
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.moveState).toBe('destination-stray');
      expect(result.detail).toContain('UNLINK_FAILED');
      expect(result.detail).toContain('Inspect the destination before retrying');
      expect(result.detail).toContain('was not touched and is unchanged');
      expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toBe(original);
      expect(readFileSync(join(source, 'note.txt'), 'utf8')).toBe('Keep me.');
      expect(readFileSync(join(destination, 'note.txt'), 'utf8')).toBe('Keep me.');
    } finally {
      if (existsSync(destination)) chmodSync(destination, 0o755);
      rmSync(destination, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test('an unparseable copied frontmatter reports the parse reason, not just the error kind', async () => {
    const fromName = 'fm-parse-original';
    const toName = 'fm-parse-renamed';
    const original = seedSkill(server.contentDir, fromName);
    const destination = join(fixtureRoot, 'home', '.claude', 'skills', toName);

    const response = await withFsCopyCompletionObserver(
      (path) => path.endsWith(join('skills', toName)),
      () => {
        writeFileSync(join(destination, 'SKILL.md'), '---\nname: [unclosed\n---\n\nBody.\n');
      },
      () =>
        post('/api/skill/move-scope', {
          name: fromName,
          toName,
          fromScope: 'project',
          toScope: 'global',
        }),
    );
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.moveState).toBe('destination-removed');
    expect(result.detail).toMatch(/parse_failed \(frontmatter region unparseable: .+\)/);
    expect(existsSync(destination)).toBe(false);
    expect(
      readFileSync(join(server.contentDir, '.claude', 'skills', fromName, 'SKILL.md'), 'utf8'),
    ).toBe(original);
  });

  test('a frontmatter region too large to re-key reports both its size and the limit', async () => {
    const fromName = 'oversized-fm-original';
    const toName = 'oversized-fm-renamed';
    const source = join(server.contentDir, '.claude', 'skills', fromName);
    const destination = join(fixtureRoot, 'home', '.claude', 'skills', toName);
    const filler = Array.from(
      { length: 1600 },
      (_, index) => `filler${String(index).padStart(4, '0')}: ${'x'.repeat(48)}`,
    ).join('\n');
    const oversized = `---\nname: ${fromName}\ndescription: Bundle\n${filler}\n---\n\nBody.\n`;
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), oversized);

    try {
      const response = await post('/api/skill/move-scope', {
        name: fromName,
        toName,
        fromScope: 'project',
        toScope: 'global',
      });
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.moveState).toBe('destination-removed');
      const sized = /region_too_large \(frontmatter region too large: (\d+) > (\d+) bytes\)/.exec(
        result.detail,
      );
      expect(sized).not.toBeNull();
      expect(Number(sized?.[1])).toBeGreaterThan(65536);
      expect(sized?.[2]).toBe('65536');
      expect(result.detail).toContain(`project:${fromName}`);
      expect(result.detail).toContain('was not removed');
      expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toBe(oversized);
      expect(existsSync(destination)).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  });

  test('an unexpected copy failure directs callers to inspect both locations without claiming rollback', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce directory write permissions.');
    }
    const fromName = 'copy-failed-original';
    const toName = 'copy-failed-renamed';
    const original = seedSkill(server.contentDir, fromName);
    const destinationRoot = join(fixtureRoot, 'home', '.claude', 'skills');
    chmodSync(destinationRoot, 0o555);
    try {
      const response = await post('/api/skill/move-scope', {
        name: fromName,
        toName,
        fromScope: 'project',
        toScope: 'global',
      });
      const result = await response.json();
      expect(response.status).toBe(500);
      expect(result.moveState).toBe('partially-applied');
      expect(result.detail).toContain(`project:${fromName}`);
      expect(result.detail).toContain(`global:${toName}`);
      expect(result.detail).toContain('before retrying');
      expect(
        readFileSync(join(server.contentDir, '.claude', 'skills', fromName, 'SKILL.md'), 'utf8'),
      ).toBe(original);
      expect(existsSync(join(destinationRoot, toName))).toBe(false);
    } finally {
      chmodSync(destinationRoot, 0o755);
    }
  });

  test('a source-removal failure reports every in-place copy the sweep deleted', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce directory write permissions.');
    }
    const name = 'retained-placements';
    const home = join(fixtureRoot, 'home');
    const source = join(home, '.claude', 'skills', name);
    const swept = join(home, '.lmstudio', 'skills', name);
    const hostable = join(home, '.cursor', 'skills', name);
    const body = `---\nname: ${name}\ndescription: Bundle\n---\n\nBody.\n`;
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), body);
    expect(
      (
        await post('/api/skill/install', {
          name,
          scope: 'global',
          add: ['lm-studio', 'cursor'],
          mode: 'copy',
        })
      ).status,
    ).toBe(200);
    expect(readFileSync(join(swept, 'SKILL.md'), 'utf8')).toBe(body);
    expect(readFileSync(join(hostable, 'SKILL.md'), 'utf8')).toBe(body);
    const destination = join(server.contentDir, '.claude', 'skills', name);
    chmodSync(source, 0o555);
    try {
      const response = await post('/api/skill/move-scope', {
        name,
        fromScope: 'global',
        toScope: 'project',
      });
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.moveState).toBe('destination-retained');
      expect(existsSync(swept)).toBe(false);
      expect(existsSync(hostable)).toBe(false);
      expect(result.droppedLocations).toEqual(['cursor', 'lm-studio']);
    } finally {
      chmodSync(source, 0o755);
      rmSync(destination, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
      rmSync(hostable, { recursive: true, force: true });
      rmSync(join(home, '.lmstudio'), { recursive: true, force: true });
    }
  });

  test('a global-to-project move drops hosts the destination scope cannot host', async () => {
    const name = 'lmstudio-only';
    const home = join(fixtureRoot, 'home');
    const source = join(home, '.lmstudio', 'skills', name);
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Bundle\n---\n\nBody.\n`,
    );

    let movedRel: string | undefined;
    try {
      const response = await post('/api/skill/move-scope', {
        name,
        fromScope: 'global',
        toScope: 'project',
      });
      const result = await response.json();
      movedRel = result.path;

      expect(response.status).toBe(200);
      expect(result.droppedLocations).toContain('lm-studio');
      expect(existsSync(source)).toBe(false);
      expect(existsSync(join(server.contentDir, '.lmstudio', 'skills', name))).toBe(false);
    } finally {
      if (movedRel !== undefined) {
        rmSync(join(server.contentDir, movedRel), { recursive: true, force: true });
      }
      rmSync(join(home, '.lmstudio'), { recursive: true, force: true });
    }
  });

  test('a duplicate that fails before creating the destination does not claim a started copy', async (ctx) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      ctx.skip('Requires a non-root POSIX user to enforce directory write permissions.');
    }
    const name = 'duplicate-mkdir-blocked';
    const home = join(fixtureRoot, 'home');
    const source = join(home, '.claude', 'skills', name);
    const agentsRoot = join(home, '.agents');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Bundle\n---\n\nBody.\n`,
    );
    mkdirSync(agentsRoot, { recursive: true });
    chmodSync(agentsRoot, 0o555);
    try {
      const response = await post('/api/skill/duplicate', {
        name,
        toName: `${name}-copy`,
        scope: 'global',
      });
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(existsSync(join(agentsRoot, 'skills'))).toBe(false);
      expect(result.detail ?? '').not.toContain('was started at');
      expect(result.detail ?? '').not.toContain('was created at');
    } finally {
      chmodSync(agentsRoot, 0o755);
      rmSync(agentsRoot, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  });

  test('an invalid source name is refused with a machine-readable nothing-written state', async () => {
    const response = await post('/api/skill/move-scope', {
      name: 'Invalid Name',
      fromScope: 'project',
      toScope: 'global',
    });
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.moveState).toBe('nothing-written');
    expect(result.droppedLocations).toEqual([]);
  });

  test('an invalid destination name is refused without touching the source', async () => {
    const name = 'invalid-toname-source';
    const original = seedSkill(server.contentDir, name);

    const response = await post('/api/skill/move-scope', {
      name,
      toName: 'Invalid Name',
      fromScope: 'project',
      toScope: 'global',
    });
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.moveState).toBe('nothing-written');
    expect(result.droppedLocations).toEqual([]);
    expect(
      readFileSync(join(server.contentDir, '.claude', 'skills', name, 'SKILL.md'), 'utf8'),
    ).toBe(original);
  });
});
