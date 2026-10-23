import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { describe, expect, test, vi } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';

const fixture = await vi.hoisted(async () => {
  const path = await vi.importActual<typeof import('node:path')>('node:path');
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const state = { directory: '' };
  return {
    path,
    fs,
    state,
    toHost: (file: string) =>
      path.resolve(state.directory, ...path.win32.relative('C:\\project', file).split('\\')),
  };
});

vi.mock('node:path', () => ({ ...fixture.path, ...fixture.path.win32 }));

vi.mock('node:fs', () => {
  const realpath = (file: string) =>
    fixture.path.win32.resolve(
      'C:\\project',
      fixture.path.relative(fixture.state.directory, fixture.fs.realpathSync(fixture.toHost(file))),
    );
  return {
    ...fixture.fs,
    existsSync: (file: string) => fixture.fs.existsSync(fixture.toHost(file)),
    lstatSync: (file: string) => fixture.fs.lstatSync(fixture.toHost(file)),
    statSync: (file: string) => fixture.fs.statSync(fixture.toHost(file)),
    realpathSync: Object.assign(realpath, { native: realpath }),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readFile: (file: string, encoding: BufferEncoding) =>
      fs.readFile(fixture.toHost(file), encoding),
  };
});

describe('GET /api/template with Node win32 paths', () => {
  test('does not inherit templates from a cancelled folder segment', async () => {
    const directory = fixture.fs.mkdtempSync(fixture.path.join(tmpdir(), 'ok-template-ancestry-'));
    fixture.state.directory = fixture.fs.realpathSync(directory);
    try {
      const templates = fixture.path.join(directory, 'Setup', '.ok', 'templates');
      fixture.fs.mkdirSync(templates, { recursive: true });
      fixture.fs.mkdirSync(fixture.path.join(directory, 'Results'));
      fixture.fs.writeFileSync(fixture.path.join(templates, 'setup-only.md'), '# Setup only\n');

      const extension = createApiExtension({
        hocuspocus: {} as Parameters<typeof createApiExtension>[0]['hocuspocus'],
        sessionManager: {} as Parameters<typeof createApiExtension>[0]['sessionManager'],
        contentDir: 'C:\\project',
        serverInstanceId: 'test-template-ancestry',
        getFileIndex: () => new Map(),
      });
      const server = createServer(async (request, response) => {
        await extension.nativeApi.dispatch(request, response);
      });
      try {
        const { baseUrl } = await listenOnLoopback(server);
        const local = await fetch(`${baseUrl}/api/template?name=setup-only&folder=Setup`);
        expect(local.status).toBe(200);
        expect(await local.json()).toMatchObject({ template: { body: '# Setup only\n' } });

        const target = await fetch(`${baseUrl}/api/template?name=setup-only&folder=Results`);
        expect(target.status).toBe(404);
        await target.json();

        const cancelled = await fetch(
          `${baseUrl}/api/template?name=setup-only&folder=${encodeURIComponent('Setup\\..\\Results')}`,
        );
        const body: unknown = await cancelled.json();
        expect(cancelled.status).toBe(404);
        expect(body).toMatchObject({ type: 'urn:ok:error:template-not-found' });
      } finally {
        await server[Symbol.asyncDispose]();
        await extension.shutdownLocalOps();
      }
    } finally {
      fixture.fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
