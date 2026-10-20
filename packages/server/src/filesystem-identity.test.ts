import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createBasenameIndex } from '@inkeep/open-knowledge-core';
import { expect, onTestFinished, test, vi } from 'vitest';
import { seedBasenameIndex } from './asset-walk.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

const identities = vi.hoisted(() => ({
  values: new Map<string, { dev: bigint; ino: bigint; numericDev: number; numericIno: number }>(),
  observed: new Set<string>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const substitute = <T extends { dev: number | bigint; ino: number | bigint }>(
    path: string,
    result: T,
  ): T => {
    const identity = identities.values.get(path);
    if (identity) {
      identities.observed.add(path);
      Object.defineProperties(result, {
        dev: { value: typeof result.dev === 'bigint' ? identity.dev : identity.numericDev },
        ino: { value: typeof result.ino === 'bigint' ? identity.ino : identity.numericIno },
      });
    }
    return result;
  };
  return {
    ...original,
    lstat: async (...args: Parameters<typeof original.lstat>) =>
      substitute(String(args[0]), await original.lstat(...args)),
    stat: async (...args: Parameters<typeof original.stat>) =>
      substitute(String(args[0]), await original.stat(...args)),
  };
});

const cases = [
  {
    name: 'distinct numeric inodes',
    first: { dev: 7n, ino: 11n, numericDev: 7, numericIno: 11 },
    second: { dev: 7n, ino: 13n, numericDev: 7, numericIno: 13 },
  },
  {
    name: 'rounded numeric inodes',
    first: { dev: 7n, ino: 9851624185071827n, numericDev: 7, numericIno: 9851624185071828 },
    second: { dev: 7n, ino: 9851624185071829n, numericDev: 7, numericIno: 9851624185071828 },
  },
  {
    name: 'equal inodes on different devices',
    first: { dev: 7n, ino: 11n, numericDev: 7, numericIno: 11 },
    second: { dev: 9n, ino: 11n, numericDev: 9, numericIno: 11 },
  },
];

const scratch = resolve(import.meta.dirname, '../tmp');
mkdirSync(scratch, { recursive: true });

function boot(root: string): ReturnType<typeof bootCompositionRig> {
  const server = bootCompositionRig(root);
  onTestFinished(async () => {
    const [result] = await Promise.allSettled([server]);
    if (result.status === 'fulfilled') await result.value.destroy();
  });
  return server;
}

function fixture(): string {
  onTestFinished(() => {
    identities.values.clear();
    identities.observed.clear();
  });
  const root = mkdtempSync(join(scratch, 'filesystem-identity-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test.for(cases)('lists linked-folder documents with $name', async ({ first, second }) => {
  const root = fixture();
  const content = join(root, 'content');
  mkdirSync(join(content, 'real', 'sub'), { recursive: true });
  writeFileSync(join(content, 'real', 'note.md'), '# Note\n');
  utimesSync(join(content, 'real', 'note.md'), 1_700_000_000.12375, 1_700_000_000.12375);
  const expectedMetadata = statSync(join(content, 'real', 'note.md'));
  symlinkSync(join(content, 'real'), join(content, 'alias'), 'junction');
  symlinkSync(content, join(root, 'content-link'), 'junction');
  identities.values.set(join(content, 'real'), first);
  identities.values.set(join(content, 'real', 'note.md'), second);
  const server = await boot(join(root, 'content-link'));
  await server.ready;
  const response = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
  const body = await response.json();
  expect(identities.observed).toEqual(new Set(identities.values.keys()));
  expect(response.status).toBe(200);
  expect(body.documents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'document',
        docName: 'real/note',
        size: expectedMetadata.size,
        modified: expectedMetadata.mtime.toISOString(),
      }),
      expect.objectContaining({
        kind: 'document',
        docName: 'alias/note',
        targetPath: 'real/note.md',
      }),
    ]),
  );
});

test.for(cases)('lists general files and their links with $name', async ({ first, second }) => {
  const content = fixture();
  mkdirSync(join(content, 'real', 'sub'), { recursive: true });
  writeFileSync(join(content, 'real', 'note.txt'), 'Note\n');
  symlinkSync(join(content, 'real'), join(content, 'alias'), 'junction');
  symlinkSync(join(content, 'real', 'note.txt'), join(content, 'linked.txt'), 'file');
  identities.values.set(join(content, 'real'), first);
  identities.values.set(join(content, 'real', 'note.txt'), second);
  const server = await boot(content);
  await server.ready;
  const response = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
  const body = await response.json();
  expect(identities.observed).toEqual(new Set(identities.values.keys()));
  expect(response.status).toBe(200);
  expect(body.documents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'file', path: 'real/note.txt' }),
      expect.objectContaining({ kind: 'file', path: 'linked.txt', targetPath: 'real/note.txt' }),
    ]),
  );
});

test.for(cases)('seeds assets from distinct directories with $name', async ({ first, second }) => {
  const content = fixture();
  mkdirSync(join(content, 'a'));
  mkdirSync(join(content, 'b'));
  writeFileSync(join(content, 'a', 'first.png'), 'first');
  writeFileSync(join(content, 'b', 'second.png'), 'second');
  symlinkSync(join(content, 'a'), join(content, 'alias-a'), 'junction');
  symlinkSync(join(content, 'b'), join(content, 'alias-b'), 'junction');
  identities.values.set(join(content, 'a'), first);
  identities.values.set(join(content, 'b'), second);
  const index = createBasenameIndex();
  await seedBasenameIndex({ contentDir: content, basenameIndex: index });
  expect(identities.observed).toEqual(new Set(identities.values.keys()));
  expect(index.resolveEmbed('first.png', 'note.md')).toBe('a/first.png');
  expect(index.resolveEmbed('second.png', 'note.md')).toBe('b/second.png');
});

test.for(cases)('keeps distinct general-file sizes with $name', async ({ first, second }) => {
  const content = fixture();
  writeFileSync(join(content, 'first.txt'), 'a');
  writeFileSync(join(content, 'second.txt'), 'bb');
  identities.values.set(join(content, 'first.txt'), first);
  identities.values.set(join(content, 'second.txt'), second);
  const server = await boot(content);
  await server.ready;
  const response = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
  const body = await response.json();
  expect(identities.observed).toEqual(new Set(identities.values.keys()));
  expect(response.status).toBe(200);
  expect(body.documents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'file', path: 'first.txt', size: 1 }),
      expect.objectContaining({ kind: 'file', path: 'second.txt', size: 2 }),
    ]),
  );
});
