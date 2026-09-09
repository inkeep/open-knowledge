import { createHash } from 'node:crypto';
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
import { join } from 'node:path';
import { InstallSkillSuccessSchema, SkillInstallSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { type Entry, fromBuffer } from 'yauzl';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';
import { readSkillStateFile } from './skill-state.ts';

const isolated = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => isolated.home,
}));
let root: string;
let server: BootedServer;
beforeAll(async () => {
  isolated.home = mkdtempSync(join(tmpdir(), 'ok-install-home-'));
  root = mkdtempSync(join(tmpdir(), 'ok-install-contract-'));
  mkdirSync(join(root, '.claude'));
  mkdirSync(join(root, '.cursor'));
  server = await bootCompositionRig(root, { configHomedirOverride: isolated.home });
  await server.ready;
}, 60_000);
afterAll(async () => {
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
  rmSync(isolated.home, { recursive: true, force: true });
});
async function post(path: string, body: object) {
  return rawRequest(server.port, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'install-contract' },
    body: JSON.stringify(body),
  });
}
test('handoff builds a real archive without opening and ignores force on a current installation', async () => {
  const out = join(isolated.home, 'bundle.skill');
  const first = await post('/api/install-skill', { noOpen: true, out });
  expect(first.status, first.body).toBe(200);
  const built = InstallSkillSuccessSchema.parse(JSON.parse(first.body));
  expect(built).toMatchObject({ status: 'built', outputPath: out });
  const bytes = readFileSync(out);
  expect(built).toMatchObject({
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  const entries = await readArchive(bytes);
  const skill = entries.get('open-knowledge/SKILL.md');
  expect(skill).toMatch(/^name: open-knowledge$/m);
  expect(skill).toContain('OpenKnowledge');
  expect((await readSkillStateFile(isolated.home)).targets['claude-cowork']?.version).toBe(
    built.skillVersion,
  );
  const another = join(isolated.home, 'another.skill');
  const second = await post('/api/install-skill', { noOpen: true, out: another, force: true });
  expect(second.status, second.body).toBe(200);
  expect(InstallSkillSuccessSchema.parse(JSON.parse(second.body))).toMatchObject({
    status: 'skip-current',
  });
  expect(existsSync(another)).toBe(false);
  expect(SkillInstallSuccessSchema.safeParse(JSON.parse(first.body)).success).toBe(false);
  expect(first.headers['x-request-id']).toBe('install-contract');
});

const markdown = (name: string) =>
  `---\nname: ${name}\ndescription: Install contract\n---\n\nLiteral \\* and <custom>raw</custom>.  \n`;
function seed(name: string) {
  const dir = join(root, '.claude/skills', name);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), markdown(name));
  writeFileSync(join(dir, 'assets/data.bin'), Buffer.from([0, 255, 10]));
  return dir;
}

test('catalog installation projects exact bytes and preserves placement, conversion and source outcomes', async () => {
  const name = 'catalog-contract';
  seed(name);
  const install = async (extra: object) => {
    const response = await post('/api/skill/install', { scope: 'project', name, ...extra });
    expect(response.status, response.body).toBe(200);
    return SkillInstallSuccessSchema.parse(JSON.parse(response.body));
  };
  const result = await install({ targets: ['claude', 'cursor'], mode: 'copy' });
  expect(result.hosts).toContain('cursor');
  expect(InstallSkillSuccessSchema.safeParse(result).success).toBe(false);
  expect(readFileSync(join(root, '.cursor/skills', name, 'SKILL.md'), 'utf8')).toBe(markdown(name));
  expect(readFileSync(join(root, '.cursor/skills', name, 'assets/data.bin'))).toEqual(
    Buffer.from([0, 255, 10]),
  );
  await install({ convert: { target: 'cursor', mode: 'link' } });
  expect(lstatSync(join(root, '.cursor/skills', name)).isSymbolicLink()).toBe(true);
  expect(await install({ place: { dir: 'bundles', mode: 'copy' } })).toMatchObject({
    placedAt: `bundles/${name}`,
  });
  expect(readFileSync(join(root, 'bundles', name, 'SKILL.md'), 'utf8')).toBe(markdown(name));
  await install({ unplace: { path: `bundles/${name}` } });
  expect(existsSync(join(root, 'bundles', name))).toBe(false);
  expect(await install({ source: 'cursor' })).toMatchObject({
    sourceMovedTo: `.cursor/skills/${name}`,
  });
  expect(readFileSync(join(root, '.cursor/skills', name, 'SKILL.md'), 'utf8')).toBe(markdown(name));
});

test('install contracts reject unsafe output, invalid source and conflicting operations independently', async () => {
  const name = 'negative-contract';
  seed(name);
  for (const [path, body, status, detail] of [
    ['/api/install-skill', { noOpen: true, out: join(root, 'outside.skill') }, 400, undefined],
    ['/api/skill/install', { noOpen: true }, 400, undefined],
    ['/api/skill/install', { scope: 'project', name: 'missing' }, 404, undefined],
    [
      '/api/skill/install',
      { scope: 'project', name, place: { dir: '../escape', mode: 'copy' } },
      400,
      'PLACE_PATH_INVALID',
    ],
    ['/api/skill/install', { scope: 'project', name, remove: ['claude'] }, 400, 'REMOVE_SOURCE'],
    [
      '/api/skill/install',
      { scope: 'project', name, convert: { target: 'cursor', mode: 'link' } },
      404,
      'cursor',
    ],
  ] as const) {
    const result = await post(path, body);
    expect(result.status, result.body).toBe(status);
    expect(result.headers['content-type']).toContain('application/problem+json');
    expect(result.headers['x-request-id']).toBe('install-contract');
    if (detail !== undefined) expect(JSON.parse(result.body).detail).toBe(detail);
  }
  expect(existsSync(join(root, 'outside.skill'))).toBe(false);
  const malformed = await rawRequest(server.port, '/api/install-skill', {
    method: 'POST',
    headers: { Origin: 'https://untrusted.example.com' },
    body: '{broken',
  });
  expect(malformed.status, malformed.body).toBe(403);
});

async function readArchive(bytes: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error) {
        reject(error);
        return;
      }
      const contents = new Map<string, string>();
      zip.on('error', reject);
      zip.on('end', () => resolve(contents));
      zip.on('entry', (entry: Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            zip.close();
            reject(streamError);
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('error', reject);
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            contents.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
