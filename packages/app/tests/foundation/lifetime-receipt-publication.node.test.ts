import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import lifetimeGlobalSetup from '../stress/_helpers/port-ownership/lifetime-global-setup.ts';

const publication = vi.hoisted(() => {
  const observations: Array<string | undefined> = [];
  return { runDir: '', observations };
});

vi.mock('node:child_process', async (importOriginal) => {
  const childProcess = await importOriginal<typeof import('node:child_process')>();
  return {
    ...childProcess,
    spawn: (_command: string, args: readonly string[]) => {
      const child = new EventEmitter();
      const receipt = { port: 43123, nonce: args[1], pid: 12345 };
      vi.stubGlobal('fetch', async () => new Response(receipt.nonce));
      queueMicrotask(() => child.emit('message', receipt));
      return child;
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      const [path] = args;
      if (typeof path === 'string' && dirname(path) === publication.runDir) {
        fs.closeSync(fs.openSync(path, 'w'));
        const receiptPath = join(publication.runDir, 'lifetime-receipt.json');
        publication.observations.push(
          fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath, 'utf8') : undefined,
        );
      }
      return fs.writeFileSync(...args);
    },
  };
});

describe('lifetime receipt publication', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (publication.runDir) rmSync(publication.runDir, { recursive: true, force: true });
    publication.runDir = '';
    publication.observations = [];
  });

  it('exposes the receipt only after its contents are complete', async () => {
    publication.runDir = mkdtempSync(join(tmpdir(), 'ok-lifetime-publication-'));
    vi.stubEnv('OK_PORT_OWNERSHIP_RUN_DIR', publication.runDir);
    vi.stubEnv('OK_PORT_OWNERSHIP_CALLER', 'lifetime-normal');
    await lifetimeGlobalSetup();

    expect(publication.observations).toEqual([undefined]);
    expect(
      JSON.parse(readFileSync(join(publication.runDir, 'lifetime-receipt.json'), 'utf8')),
    ).toMatchObject({
      port: expect.any(Number),
      nonce: expect.any(String),
      pid: expect.any(Number),
    });
  });
});
