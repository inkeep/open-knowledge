/**
 * The wiring root for OKF schema materialization: a real booted server, a real request,
 * and the files actually on disk afterwards.
 *
 * `write-okf-schemas.test.ts` covers the writer itself, and covers it well — but every
 * assertion there calls the function directly. Deleting the single production call site
 * left the whole suite green while the feature was dead: advertisement would name
 * `.ok/okf/*.schema.json` and nothing would ever create one, so every agent following a
 * path would find nothing. That is the gap this file exists for, and only a test that
 * never mentions the writer can close it.
 *
 * The trigger is deliberate. The materializer hangs off the config funnel rather than
 * boot, because the plugin can be switched on while the server runs — so the request
 * below is the point, not an incidental way to reach the code.
 */

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
  // The write-once guard is module state; a previous test's project must not
  // make this one's write look like it already happened.
  resetOkfSchemaWriteState();
});

afterEach(async () => {
  await booted?.destroy();
  booted = null;
  await rm(tmpDir, { recursive: true, force: true });
});

/** A project whose committed config decides whether the OKF plugin is on. */
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

    // The request the Problems panel makes. Nothing here names the writer — if the
    // config funnel stops calling it, this is what notices.
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
    // The two halves have to agree at RUNTIME, not just in a unit test: an advertised
    // path that resolves to nothing is worse than the opaque identifier it replaced.
    // Read the advertisement the agent reads, then open every path it names.
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
    // Advertisement stops naming a disabled rule's schema, so the file must not
    // exist either — the two halves track the same toggle through the funnel.
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
