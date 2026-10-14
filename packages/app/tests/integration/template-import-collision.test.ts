import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProblemDetailsSchema, TemplateImportSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createTestServer,
  HARNESS_BOOT_TIMEOUT_MS,
  type TestServer,
  wait,
} from './test-harness.ts';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

async function writeSource(docName: string, markdown: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, position: 'replace', docName }),
  });
  expect(res.status).toBe(200);
  const filePath = join(server.contentDir, `${docName}.md`);
  for (let i = 0; i < 100; i++) {
    if (existsSync(filePath)) return;
    await wait(50);
  }
  throw new Error(`source ${docName}.md never flushed to disk`);
}

function importTemplate(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/template/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function importedPath(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  const parsed = TemplateImportSuccessSchema.parse(await res.json());
  expect(parsed.created).toBe(true);
  return parsed.path;
}

function templateBytes(folder: string, name: string): string {
  return readFileSync(join(server.contentDir, folder, '.ok', 'templates', `${name}.md`), 'utf-8');
}

async function waitForRemoval(docName: string): Promise<void> {
  const filePath = join(server.contentDir, `${docName}.md`);
  for (let i = 0; i < 100; i++) {
    if (!existsSync(filePath)) return;
    await wait(50);
  }
}

describe('template import never overwrites an existing template', () => {
  test('two pages with the same non-Latin name keep it and land as separate templates', async () => {
    const folder = `jp-${randomUUID().slice(0, 8)}`;
    const firstMarker = `minutes-${randomUUID().slice(0, 8)}`;
    const secondMarker = `minutes-${randomUUID().slice(0, 8)}`;
    await writeSource(`${folder}/sales/議事録`, `# 議事録\n\n${firstMarker}\n`);
    await writeSource(`${folder}/eng/議事録`, `# 議事録\n\n${secondMarker}\n`);

    const firstPath = await importedPath(
      await importTemplate({ sourcePath: `${folder}/sales/議事録`, targetFolder: folder }),
    );
    const secondPath = await importedPath(
      await importTemplate({
        sourcePath: `${folder}/eng/議事録`,
        targetFolder: folder,
        deleteSource: true,
      }),
    );

    expect(firstPath).toBe(`${folder}/.ok/templates/議事録.md`);
    expect(secondPath).toBe(`${folder}/.ok/templates/議事録-2.md`);
    expect(templateBytes(folder, '議事録')).toContain(firstMarker);
    expect(templateBytes(folder, '議事録')).not.toContain(secondMarker);
    expect(templateBytes(folder, '議事録-2')).toContain(secondMarker);

    await waitForRemoval(`${folder}/eng/議事録`);
    expect(existsSync(join(server.contentDir, folder, 'eng', '議事録.md'))).toBe(false);
    expect(existsSync(join(server.contentDir, folder, 'sales', '議事録.md'))).toBe(true);
  });

  test('pages named only in symbols fall back to a numbered default name', async () => {
    const folder = `sym-${randomUUID().slice(0, 8)}`;
    const markers = [0, 1].map((i) => `s${i}-${randomUUID().slice(0, 8)}`);
    await writeSource(`${folder}/★★★`, `# A\n\n${markers[0]}\n`);
    await writeSource(`${folder}/☆☆☆`, `# B\n\n${markers[1]}\n`);

    const paths = [
      await importedPath(
        await importTemplate({ sourcePath: `${folder}/★★★`, targetFolder: folder }),
      ),
      await importedPath(
        await importTemplate({ sourcePath: `${folder}/☆☆☆`, targetFolder: folder }),
      ),
    ];

    expect(paths).toEqual([
      `${folder}/.ok/templates/imported-template.md`,
      `${folder}/.ok/templates/imported-template-2.md`,
    ]);
    expect(templateBytes(folder, 'imported-template')).toContain(markers[0]);
    expect(templateBytes(folder, 'imported-template-2')).toContain(markers[1]);
  });

  test('ASCII names that derive the same slug walk to the next free suffix', async () => {
    const folder = `slug-${randomUUID().slice(0, 8)}`;
    const markers = [0, 1, 2].map((i) => `m${i}-${randomUUID().slice(0, 8)}`);
    await writeSource(`${folder}/Team Notes`, `# A\n\n${markers[0]}\n`);
    await writeSource(`${folder}/team-notes`, `# B\n\n${markers[1]}\n`);
    await writeSource(`${folder}/-team-notes-`, `# C\n\n${markers[2]}\n`);

    const paths = [
      await importedPath(
        await importTemplate({ sourcePath: `${folder}/Team Notes`, targetFolder: folder }),
      ),
      await importedPath(
        await importTemplate({ sourcePath: `${folder}/team-notes`, targetFolder: folder }),
      ),
      await importedPath(
        await importTemplate({ sourcePath: `${folder}/-team-notes-`, targetFolder: folder }),
      ),
    ];

    expect(paths).toEqual([
      `${folder}/.ok/templates/team-notes.md`,
      `${folder}/.ok/templates/team-notes-2.md`,
      `${folder}/.ok/templates/team-notes-3.md`,
    ]);
    expect(templateBytes(folder, 'team-notes')).toContain(markers[0]);
    expect(templateBytes(folder, 'team-notes-2')).toContain(markers[1]);
    expect(templateBytes(folder, 'team-notes-3')).toContain(markers[2]);
  });

  test('concurrent unnamed imports of colliding pages each get their own template', async () => {
    const folder = `race-${randomUUID().slice(0, 8)}`;
    const names = ['one', 'two', 'three'];
    for (const name of names) {
      await writeSource(`${folder}/${name}/Привет`, `# Привет\n\nbody-${name}\n`);
    }

    const paths = await Promise.all(
      names.map(async (name) =>
        importedPath(
          await importTemplate({ sourcePath: `${folder}/${name}/Привет`, targetFolder: folder }),
        ),
      ),
    );

    expect(new Set(paths).size).toBe(names.length);
    expect([...paths].sort()).toEqual([
      `${folder}/.ok/templates/привет-2.md`,
      `${folder}/.ok/templates/привет-3.md`,
      `${folder}/.ok/templates/привет.md`,
    ]);
    const contents = paths.map((p) => readFileSync(join(server.contentDir, p), 'utf-8'));
    for (const name of names) {
      expect(contents.filter((c) => c.includes(`body-${name}`))).toHaveLength(1);
    }
  });

  test('an explicit name that is already taken is refused and nothing is written or deleted', async () => {
    const folder = `named-${randomUUID().slice(0, 8)}`;
    const keepMarker = `keep-${randomUUID().slice(0, 8)}`;
    await writeSource(`${folder}/first`, `# First\n\n${keepMarker}\n`);
    await writeSource(`${folder}/second`, '# Second\n\nreplacement\n');

    await importedPath(
      await importTemplate({
        sourcePath: `${folder}/first`,
        targetFolder: folder,
        name: 'standup',
      }),
    );
    const before = templateBytes(folder, 'standup');

    const res = await importTemplate({
      sourcePath: `${folder}/second`,
      targetFolder: folder,
      name: 'standup',
      deleteSource: true,
    });
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const problem = ProblemDetailsSchema.parse(await res.json());
    expect(problem.type).toBe('urn:ok:error:doc-already-exists');

    expect(templateBytes(folder, 'standup')).toBe(before);
    expect(before).toContain(keepMarker);
    expect(existsSync(join(server.contentDir, folder, 'second.md'))).toBe(true);
  });
});
