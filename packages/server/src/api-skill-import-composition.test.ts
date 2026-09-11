import { fork } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import yazl from 'yazl';
import { createApiExtension } from './api-extension.test-helper.ts';
import type { BootedServer } from './boot.ts';
import {
  bootCompositionRig,
  makeCaptureRes,
  makeSyntheticReq,
  rawRequest,
} from './composition-rig.test-helper.ts';
import * as contributorTracker from './contributor-tracker.ts';

let root: string;
let source: string;
let server: BootedServer;
const markdown = (name: string) =>
  `---\nname: ${name}\ndescription: Import contract\n---\n\n## Bytes\n\nBackslash \\* and <custom>raw</custom>.  \n\n`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-import-contract-'));
  source = mkdtempSync(join(tmpdir(), 'ok-import-contract-source-'));
  mkdirSync(join(root, '.claude'));
  server = await bootCompositionRig(root);
  await server.ready;
}, 60_000);

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

async function post(path: string, body: object) {
  const result = await rawRequest(server.port, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(result.status, result.body).toBe(200);
  return JSON.parse(result.body);
}

function seed(name: string) {
  const dir = join(source, name);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), markdown(name));
  writeFileSync(join(dir, 'assets/data.bin'), Buffer.from([0, 255, 10]));
  return dir;
}

test('single import preserves bundle bytes, provenance and actor attribution', async () => {
  const attribution = vi.spyOn(contributorTracker, 'recordContributor');
  const name = 'single-contract';
  const dir = seed(name);
  const result = await post('/api/skill/import', {
    source: dir,
    agentId: 'import-writer',
    install: false,
  });
  expect(result).toMatchObject({
    name,
    created: true,
    alreadyImported: false,
    provenance: { source: dir },
  });
  expect(readFileSync(join(root, '.claude/skills', name, 'SKILL.md'), 'utf8')).toBe(markdown(name));
  expect(readFileSync(join(root, '.claude/skills', name, 'assets/data.bin'))).toEqual(
    Buffer.from([0, 255, 10]),
  );
  expect(attribution.mock.calls.map(([doc, writer]) => [doc, writer])).toContainEqual([
    `.claude/skills/${name}/SKILL`,
    'agent-import-writer',
  ]);
  expect(await post('/api/skill/import', { source: dir, install: false })).toMatchObject({
    name,
    alreadyImported: true,
  });
  expect(existsSync(join(root, '.ok/skills-lock.json'))).toBe(true);
});

test('bulk import retains request order, deduplication and partial results', async () => {
  const attribution = vi.spyOn(contributorTracker, 'recordContributor');
  seed('bulk-first');
  seed('bulk-second');
  const result = await post('/api/skills/import-bulk', {
    source,
    skills: ['bulk-second', 'missing', 'bulk-first', 'bulk-second'],
    install: false,
    agentId: 'bulk-writer',
  });
  expect(result).toMatchObject({
    imported: 2,
    alreadyImported: 0,
    failed: 1,
    results: [
      { requested: 'bulk-second', name: 'bulk-second', status: 'imported' },
      { requested: 'missing', status: 'not-found' },
      { requested: 'bulk-first', name: 'bulk-first', status: 'imported' },
    ],
  });
  for (const name of ['bulk-first', 'bulk-second']) {
    expect(readFileSync(join(root, '.claude/skills', name, 'SKILL.md'), 'utf8')).toBe(
      markdown(name),
    );
  }
  for (const name of ['bulk-first', 'bulk-second']) {
    expect(attribution.mock.calls.map(([doc, writer]) => [doc, writer])).toContainEqual([
      `.claude/skills/${name}/SKILL`,
      'agent-bulk-writer',
    ]);
  }
});

function multipart(files: Array<{ name: string; data: string | Buffer }>) {
  const boundary = 'ok-import-contract-boundary';
  const body = Buffer.concat([
    ...files.flatMap(({ name, data }) => [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(data),
      Buffer.from('\r\n'),
    ]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  return {
    body,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'X-Request-Id': 'upload-contract',
    },
  };
}

test('completed multipart import preserves raw bytes and query actor attribution', async () => {
  const attribution = vi.spyOn(contributorTracker, 'recordContributor');
  const name = 'upload-contract';
  const result = await rawRequest(server.port, '/api/skill-upload?agentId=upload-writer', {
    method: 'POST',
    ...multipart([
      { name: 'SKILL.md', data: markdown(name) },
      { name: 'assets/data.bin', data: Buffer.from([0, 255, 10]) },
    ]),
  });
  expect(result.status, result.body).toBe(200);
  expect(JSON.parse(result.body)).toMatchObject({ name, created: true });
  expect(readFileSync(join(root, '.claude/skills', name, 'SKILL.md'), 'utf8')).toBe(markdown(name));
  expect(existsSync(join(root, '.claude/skills', name, 'assets/data.bin'))).toBe(false);
  expect(attribution.mock.calls.map(([doc, writer]) => [doc, writer])).toContainEqual([
    `.claude/skills/${name}/SKILL`,
    'agent-upload-writer',
  ]);
  expect(result.headers['x-request-id']).toBe('upload-contract');
});

test('multipart failures preserve malformed, empty and archive envelopes', async () => {
  for (const [files, title, status] of [
    [[], 'No files uploaded.', 400],
    [[{ name: 'bundle.zip', data: 'invalid archive' }], 'Could not unpack the archive.', 400],
    [[{ name: 'notes.txt', data: 'No skill' }], 'No SKILL.md found in the upload.', 404],
    [
      [{ name: 'SKILL.md', data: Buffer.alloc(8 * 1024 * 1024 + 1, 65) }],
      'Could not read the upload.',
      400,
    ],
  ] as const) {
    const result = await rawRequest(server.port, '/api/skill-upload', {
      method: 'POST',
      ...multipart([...files]),
    });
    expect(result.status, result.body).toBe(status);
    expect(result.headers['content-type']).toContain('application/problem+json');
    expect(result.headers['x-request-id']).toBe('upload-contract');
    expect(JSON.parse(result.body)).toMatchObject({ title });
  }
  const malformed = await rawRequest(server.port, '/api/skill-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data' },
    body: 'broken',
  });
  expect(malformed.status).toBe(400);
  expect(JSON.parse(malformed.body).title).toBe('Could not read the upload.');
});

async function archive(files: Array<{ name: string; data: string | Buffer }>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
  for (const file of files) zip.addBuffer(Buffer.from(file.data), file.name);
  zip.end();
  return completed;
}

test('archive upload preserves nested bundle bytes and rejects expanded entry limits', async () => {
  const name = 'archive-contract';
  const data = await archive([
    { name: 'SKILL.md', data: markdown(name) },
    { name: 'assets/data.bin', data: Buffer.from([0, 255, 10]) },
  ]);
  const result = await rawRequest(server.port, '/api/skill-upload', {
    method: 'POST',
    ...multipart([{ name: 'bundle.skill', data }]),
  });
  expect(result.status, result.body).toBe(200);
  expect(readFileSync(join(root, '.claude/skills', name, 'SKILL.md'), 'utf8')).toBe(markdown(name));
  expect(readFileSync(join(root, '.claude/skills', name, 'assets/data.bin'))).toEqual(
    Buffer.from([0, 255, 10]),
  );
  for (const entries of [
    [{ name: 'large.bin', data: Buffer.alloc(8 * 1024 * 1024 + 1) }],
    Array.from({ length: 201 }, (_, i) => ({ name: `files/${i}.txt`, data: 'x' })),
    Array.from({ length: 5 }, (_, i) => ({
      name: `files/${i}.txt`,
      data: Buffer.alloc(7 * 1024 * 1024),
    })),
  ]) {
    const rejected = await rawRequest(server.port, '/api/skill-upload', {
      method: 'POST',
      ...multipart([{ name: 'large.zip', data: await archive(entries) }]),
    });
    expect(rejected.status, rejected.body).toBe(400);
    expect(JSON.parse(rejected.body).title).toBe('Could not unpack the archive.');
  }
});

test('aggregate multipart overflow retains the parser failure in an isolated server process', async () => {
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-overflow-contract-'));
  const home = mkdtempSync(join(tmpdir(), 'ok-overflow-home-'));
  const child = fork(
    fileURLToPath(new URL('./skill-upload-process.test-helper.ts', import.meta.url)),
    [contentDir, home],
    {
      execArgv: ['--import', 'tsx', '--conditions=@inkeep/source'],
      silent: true,
      env: { ...process.env, TMPDIR: home, TMP: home, TEMP: home },
    },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdout?.resume();
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.once('message', (message) => {
        if (
          typeof message !== 'object' ||
          message === null ||
          !('port' in message) ||
          typeof message.port !== 'number'
        ) {
          reject(new Error('Upload fixture sent no port.'));
          return;
        }
        resolve(message.port);
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Upload fixture exited ${code}: ${stderr}`)));
    });
    await expect(
      rawRequest(port, '/api/skill-upload', {
        method: 'POST',
        ...multipart(
          Array.from({ length: 5 }, (_, i) => ({
            name: `${i}.txt`,
            data: Buffer.alloc(7 * 1024 * 1024),
          })),
        ),
      }),
    ).rejects.toThrow(/socket hang up|ECONNRESET|EPIPE/);
    expect(await exited).toBe(1);
    expect(stderr).toContain('Unexpected end of file');
  } finally {
    child.kill();
    await exited;
    rmSync(contentDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test('disconnect during an incomplete multipart request retains staging while the listener stays usable', async () => {
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-disconnect-contract-'));
  const home = mkdtempSync(join(tmpdir(), 'ok-disconnect-home-'));
  const child = fork(
    fileURLToPath(new URL('./skill-upload-process.test-helper.ts', import.meta.url)),
    [contentDir, home],
    {
      execArgv: ['--import', 'tsx', '--conditions=@inkeep/source'],
      silent: true,
      env: { ...process.env, TMPDIR: home, TMP: home, TEMP: home },
    },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdout?.resume();
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.once('message', (message) => {
        if (
          typeof message !== 'object' ||
          message === null ||
          !('port' in message) ||
          typeof message.port !== 'number'
        ) {
          reject(new Error('Upload fixture sent no port.'));
          return;
        }
        resolve(message.port);
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Upload fixture exited ${code}: ${stderr}`)));
    });
    const socket = connect(port, '127.0.0.1');
    socket.on('error', () => {});
    try {
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.write(
        [
          'POST /api/skill-upload HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Content-Type: multipart/form-data; boundary=partial-contract',
          'Content-Length: 100000',
          '',
          '--partial-contract',
          'Content-Disposition: form-data; name="file"; filename="SKILL.md"',
          '',
          markdown('aborted-contract'),
        ].join('\r\n'),
      );
      const staged = () => readdirSync(home).filter((name) => name.startsWith('ok-skill-upload-'));
      await vi.waitFor(() => expect(staged()).toHaveLength(1));
      const retainedStaging = staged();
      socket.destroy();
      const result = await rawRequest(port, '/api/skill-upload', {
        method: 'POST',
        ...multipart([]),
      });
      expect(result.status).toBe(400);
      expect(existsSync(join(contentDir, '.claude/skills/aborted-contract'))).toBe(false);
      await vi.waitFor(() => expect(staged()).toEqual(retainedStaging));
      expect(child.exitCode).toBeNull();
    } finally {
      socket.destroy();
    }
  } finally {
    child.kill();
    await exited;
    rmSync(contentDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test('upload without a project root rejects before method validation', async () => {
  const extension = createApiExtension({
    contentDir: root,
    hocuspocus: server.serverInstance.hocuspocus,
    sessionManager: server.serverInstance.sessionManager,
  });
  const request = makeSyntheticReq({ method: 'GET', url: '/api/skill-upload' });
  const { res, captured } = makeCaptureRes();
  try {
    await extension.onRequest({ request, response: res });
    expect(captured.status).toBe(400);
    expect(JSON.parse(captured.body)).toMatchObject({
      title: 'No project root resolved.',
      detail: 'NO_PROJECT_ROOT',
    });
    expect(captured.headers.allow).toBeUndefined();
  } finally {
    request.destroy();
  }
});

test('raw multipart keeps the first two hundred files and ignores oversized excess text fields', async () => {
  const name = 'raw-count-contract';
  const payload = multipart([
    { name: 'SKILL.md', data: markdown(name) },
    ...Array.from({ length: 199 }, (_, i) => ({ name: `note-${i}.txt`, data: `file ${i}` })),
    { name: 'beyond-limit.txt', data: 'not admitted' },
  ]);
  const fields = Buffer.from(
    Array.from(
      { length: 11 },
      (_, i) =>
        `--ok-import-contract-boundary\r\nContent-Disposition: form-data; name="field-${i}"\r\n\r\n${'x'.repeat(2049)}\r\n`,
    ).join(''),
  );
  const response = await rawRequest(server.port, '/api/skill-upload', {
    method: 'POST',
    headers: payload.headers,
    body: Buffer.concat([fields, payload.body]),
  });
  expect(response.status, response.body).toBe(200);
  const installed = join(root, '.claude/skills', name);
  expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe(markdown(name));
  expect(readFileSync(join(installed, 'note-198.txt'), 'utf8')).toBe('file 198');
  expect(existsSync(join(installed, 'beyond-limit.txt'))).toBe(false);
  const omittedSkill = await rawRequest(server.port, '/api/skill-upload', {
    method: 'POST',
    ...multipart([
      ...Array.from({ length: 200 }, (_, i) => ({ name: `note-${i}.txt`, data: 'x' })),
      { name: 'SKILL.md', data: markdown('beyond-count') },
    ]),
  });
  expect(omittedSkill.status, omittedSkill.body).toBe(404);
  expect(JSON.parse(omittedSkill.body).title).toBe('No SKILL.md found in the upload.');
  expect(existsSync(join(root, '.claude/skills/beyond-count'))).toBe(false);
});
