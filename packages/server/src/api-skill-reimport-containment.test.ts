import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';

let fixture: string;
let root: string;
let source: string;
let server: BootedServer;

const markdown = (name: string, revision: string) =>
  `---\nname: ${name}\ndescription: Refresh containment fixture\n---\n\n${revision}\n`;

beforeAll(async () => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'ok-refresh-containment-')));
  root = join(fixture, 'project');
  source = join(fixture, 'upstream');
  mkdirSync(join(root, '.claude/skills'), { recursive: true });
  mkdirSync(source);
  server = await bootCompositionRig(root);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  rmSync(fixture, { recursive: true, force: true });
});

async function post(path: string, body: object) {
  return rawRequest(server.port, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function importSkill(name: string, withReference = false) {
  const upstream = join(source, name);
  mkdirSync(join(upstream, 'assets'), { recursive: true });
  writeFileSync(join(upstream, 'SKILL.md'), markdown(name, 'old'));
  writeFileSync(join(upstream, 'assets/sentinel.txt'), 'outside sentinel');
  if (withReference) {
    mkdirSync(join(upstream, 'references'));
    writeFileSync(join(upstream, 'references/gone.md'), 'Old reference.\n');
  }
  const imported = await post('/api/skill/import', { source: upstream, install: false });
  expect(imported.status, imported.body).toBe(200);
  return { upstream, installed: join(root, '.claude/skills', name) };
}

test.each([false, true])('refresh refuses an outside-linked skill (dryRun: %s)', async (dryRun) => {
  const name = `outside-linked-${dryRun}`;
  const { installed, upstream } = await importSkill(name);
  const outside = join(fixture, name);
  renameSync(installed, outside);
  symlinkSync(outside, installed, 'dir');
  writeFileSync(join(upstream, 'SKILL.md'), markdown(name, 'new'));
  rmSync(join(upstream, 'assets/sentinel.txt'));

  const refreshed = await post('/api/skill/reimport', { name, scope: 'project', dryRun });

  expect.soft(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toBe(markdown(name, 'old'));
  expect.soft(existsSync(join(outside, 'assets/sentinel.txt'))).toBe(true);
  expect(refreshed.status, refreshed.body).toBe(400);
});

test.each([false, true])('refresh refuses a nested directory link (dryRun: %s)', async (dryRun) => {
  const name = `nested-linked-${dryRun}`;
  const { installed, upstream } = await importSkill(name);
  const outside = join(fixture, name);
  renameSync(join(installed, 'assets'), outside);
  symlinkSync(outside, join(installed, 'assets'), 'dir');
  writeFileSync(join(upstream, 'assets/sentinel.txt'), 'upstream replacement');
  writeFileSync(join(upstream, 'SKILL.md'), markdown(name, 'new'));

  const refreshed = await post('/api/skill/reimport', { name, scope: 'project', dryRun });

  expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside sentinel');
  expect(refreshed.status, refreshed.body).toBe(400);
  expect(JSON.parse(refreshed.body).detail).toContain('SKILL_SYMLINK_REFUSED');
  expect(JSON.parse(refreshed.body).detail).toContain('assets/sentinel.txt');
  expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe(markdown(name, 'old'));
});

test('refresh preserves an explicitly in-project linked skill root', async () => {
  const name = 'inside-linked';
  const { installed, upstream } = await importSkill(name);
  const owned = join(root, 'team-skills', name);
  mkdirSync(join(root, 'team-skills'));
  renameSync(installed, owned);
  symlinkSync(owned, installed, 'dir');
  writeFileSync(join(upstream, 'SKILL.md'), markdown(name, 'new'));
  rmSync(join(upstream, 'assets/sentinel.txt'));

  const refreshed = await post('/api/skill/reimport', { name, scope: 'project' });

  expect(refreshed.status, refreshed.body).toBe(200);
  expect(readFileSync(join(owned, 'SKILL.md'), 'utf8')).toBe(markdown(name, 'new'));
  expect(existsSync(join(owned, 'assets/sentinel.txt'))).toBe(false);
});

test.each(['root', 'manifest'] as const)(
  'rename refuses an outside-linked %s before relocating the skill',
  async (linked) => {
    const name = `rename-linked-${linked}`;
    const { installed } = await importSkill(name);
    const outside = join(fixture, name);
    const sourcePath = linked === 'root' ? installed : join(installed, 'SKILL.md');
    renameSync(sourcePath, outside);
    symlinkSync(outside, sourcePath, linked === 'root' ? 'dir' : 'file');

    const renamed = await post('/api/skill', {
      fromName: name,
      toName: `${name}-renamed`,
      scope: 'project',
    });

    expect(renamed.status, renamed.body).toBe(400);
    expect(lstatSync(sourcePath).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, '.claude/skills', `${name}-renamed`))).toBe(false);
    expect(readFileSync(linked === 'root' ? join(outside, 'SKILL.md') : outside, 'utf8')).toBe(
      markdown(name, 'old'),
    );
  },
);

test.each(['delete', 'rename'] as const)(
  'bundle %s refuses an in-skill directory link before closing its document',
  async (operation) => {
    const name = `bundle-${operation}`;
    const { installed } = await importSkill(name);
    mkdirSync(join(installed, 'references'));
    writeFileSync(join(installed, 'references/notes.md'), 'Keep this document.\n');
    symlinkSync('references', join(installed, 'linked'), 'dir');
    const docName = `.claude/skills/${name}/linked/notes`;
    const session = await server.serverInstance.sessionManager.getSession(docName, 'agent-reader', {
      displayName: 'Reader',
      colorSeed: 'reader',
    });
    const document = session.dc.document;
    const statusBefore = document.getMap('lifecycle').get('status');

    const response =
      operation === 'delete'
        ? await rawRequest(
            server.port,
            `/api/skill-file?${new URLSearchParams({ name, scope: 'project', path: 'linked' })}`,
            { method: 'DELETE' },
          )
        : await post('/api/skill-file/rename', {
            name,
            scope: 'project',
            from: 'linked',
            to: 'renamed',
          });

    expect(response.status, response.body).toBe(400);
    expect(document.getMap('lifecycle').get('status')).toBe(statusBefore);
    expect(lstatSync(join(installed, 'linked')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(installed, 'references/notes.md'), 'utf8')).toBe(
      'Keep this document.\n',
    );
  },
);

test('bulk refresh reports the remedy together with the refused path and code', async () => {
  const name = 'bulk-refusal';
  const { installed, upstream } = await importSkill(name);
  const outside = join(fixture, name);
  renameSync(join(installed, 'assets'), outside);
  symlinkSync(outside, join(installed, 'assets'), 'dir');
  writeFileSync(join(upstream, 'SKILL.md'), markdown(name, 'new'));
  const response = await post('/api/skills/reimport-bulk', { scope: 'project', names: [name] });
  expect(response.status, response.body).toBe(200);
  const result = JSON.parse(response.body).results[0];
  expect(result.status).toBe('failed');
  expect(result.error).toContain('replace it with a real file or directory');
  expect(result.error).toContain('assets/sentinel.txt');
  expect(result.error).toContain('SKILL_SYMLINK_REFUSED');
  expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside sentinel');
});

test('skill creation reports a failed destination lookup as a server error', async () => {
  const name = 'unverifiable-destination';
  writeFileSync(join(root, '.claude/skills', name), 'not a directory');
  const response = await rawRequest(server.port, '/api/skill', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      scope: 'project',
      body: 'Replacement',
      frontmatter: { name, description: 'Fixture' },
    }),
  });
  expect(response.status, response.body).toBe(500);
  expect(JSON.parse(response.body).detail).toBe('SKILL_PATH_CHECK_FAILED');
  expect(readFileSync(join(root, '.claude/skills', name), 'utf8')).toBe('not a directory');
});

test('bulk import reports the refusal remedy and diagnostic code', async () => {
  const name = 'bulk-import-refusal';
  const upstream = join(source, name);
  const outside = join(fixture, name);
  mkdirSync(upstream);
  mkdirSync(outside);
  writeFileSync(join(upstream, 'SKILL.md'), markdown(name, 'new'));
  writeFileSync(join(outside, 'sentinel.txt'), 'outside sentinel');
  symlinkSync(outside, join(root, '.claude/skills', name), 'junction');
  const response = await post('/api/skills/import-bulk', {
    source,
    skills: [name],
    install: false,
  });
  expect(response.status, response.body).toBe(200);
  const result = JSON.parse(response.body).results[0];
  expect(result.status).toBe('failed');
  expect(result.error).toContain('replace the link');
  expect(result.error).toContain('SKILL_PATH_OUTSIDE_HOME');
  expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside sentinel');
});

test('a lookup failure after refresh preflight retains its server-error classification', async () => {
  const name = 'post-preflight-lookup';
  const { installed, upstream } = await importSkill(name, true);
  const session = await server.serverInstance.sessionManager.getSession(
    `.claude/skills/${name}/references/gone`,
    'agent-reader',
    { displayName: 'Reader', colorSeed: 'reader' },
  );
  const backup = join(fixture, `${name}-before`);
  session.dc.document.on('destroy', () => {
    renameSync(installed, backup);
    symlinkSync(name, installed, 'dir');
  });
  writeFileSync(join(upstream, 'SKILL.md'), markdown(name, 'new'));
  rmSync(join(upstream, 'references/gone.md'));
  const response = await post('/api/skill/reimport', { name, scope: 'project' });
  expect(response.status, response.body).toBe(500);
  expect(JSON.parse(response.body).detail).toBe('SKILL_PATH_CHECK_FAILED');
  expect(readFileSync(join(backup, 'SKILL.md'), 'utf8')).toBe(markdown(name, 'old'));
});
