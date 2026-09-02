import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type Config,
  ConfigSchema,
  okfAdvertisedSchemaMappings,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type BootedServer, bootServer } from '../boot.ts';
import { resetOkfSchemaWriteState } from './write-okf-schemas.ts';

let tmpDir: string;
let booted: BootedServer | null = null;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-okf-wiring-'));
  resetOkfSchemaWriteState();
});

afterEach(async () => {
  await booted?.destroy();
  booted = null;
  await rm(tmpDir, { recursive: true, force: true });
});

function seedProject(okfEnabled: boolean, okfExtraYaml = ''): string {
  const project = resolve(tmpDir, 'project');
  mkdirSync(join(project, '.ok'), { recursive: true });
  writeFileSync(
    join(project, '.ok', 'config.yml'),
    okfEnabled ? `contentRules:\n  okf:\n    enabled: true\n${okfExtraYaml}` : 'contentRules: {}\n',
    'utf8',
  );
  writeFileSync(resolve(project, 'note.md'), '---\ntype: Note\n---\n\nBody.\n', 'utf8');
  return project;
}

const TEST_CONFIG: Config = ConfigSchema.parse({});

async function boot(project: string): Promise<BootedServer> {
  booted = await bootServer({
    host: '127.0.0.1',
    config: TEST_CONFIG,
    contentDir: project,
    projectDir: project,
    port: 0,
    quiet: true,
    gitEnabled: false,
    idleShutdownMs: null,
  });
  await booted.ready;
  return booted;
}

describe('OKF schemas reach disk through a real server', () => {
  test('an audit request materializes them under .ok/okf/', async () => {
    const project = seedProject(true);
    const server = await boot(project);

    const res = await fetch(`http://127.0.0.1:${server.port}/api/audit`);
    expect(res.ok).toBe(true);

    for (const name of [
      'required',
      'recommended',
      'provenance',
      'computation',
      'reserved-index',
      'root-index',
    ]) {
      const path = join(project, '.ok', 'okf', `${name}.schema.json`);
      expect(existsSync(path), path).toBe(true);
    }
  });

  test('every advertised path is one an agent could actually open', async () => {
    const project = seedProject(true);
    const server = await boot(project);
    await fetch(`http://127.0.0.1:${server.port}/api/audit`);

    const advertised = okfAdvertisedSchemaMappings(undefined).map((m) => m.file);
    expect(advertised.length).toBeGreaterThan(0);
    for (const path of advertised) {
      expect(existsSync(join(project, path)), path).toBe(true);
    }
  });

  test('a rule disabled in config never materializes its schema', async () => {
    const project = seedProject(true, '    rules:\n      frontmatter-provenance: false\n');
    const server = await boot(project);
    await fetch(`http://127.0.0.1:${server.port}/api/audit`);

    expect(existsSync(join(project, '.ok', 'okf', 'provenance.schema.json'))).toBe(false);
    expect(existsSync(join(project, '.ok', 'okf', 'required.schema.json'))).toBe(true);
  });

  test('with the plugin off, nothing is written', async () => {
    const project = seedProject(false);
    const server = await boot(project);

    await fetch(`http://127.0.0.1:${server.port}/api/audit`);

    expect(existsSync(join(project, '.ok', 'okf'))).toBe(false);
  });
});
