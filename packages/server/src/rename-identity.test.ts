import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { aborted } from 'node:util';
import { expect, type TestContext, test, vi } from 'vitest';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

const identities = vi.hoisted(() => ({
  values: new Map<string, { exact: bigint; numeric: number }>(),
  observed: new Set<string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    statSync: (...args: Parameters<typeof original.statSync>) => {
      const result = original.statSync(...args);
      const identity = identities.values.get(String(args[0]));
      if (result !== undefined && identity !== undefined) {
        identities.observed.add(String(args[0]));
        Object.defineProperty(result, 'ino', {
          value: typeof result.ino === 'bigint' ? identity.exact : identity.numeric,
        });
      }
      return result;
    },
  };
});

async function renameCaseOnlyWithIdentities(
  { onTestFinished, signal }: TestContext,
  sourceIdentity: { exact: bigint; numeric: number },
  destinationIdentity: { exact: bigint; numeric: number },
): Promise<number> {
  onTestFinished(() => {
    identities.values.clear();
    identities.observed.clear();
  });
  const scratch = resolve(import.meta.dirname, '../tmp');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'rename-identity-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'note.md');
  const destination = join(root, 'NOTE.md');
  writeFileSync(source, '# Source\n');
  writeFileSync(destination, '# Target\n');
  const starting = bootCompositionRig(root);
  let pending: Promise<number> | undefined;
  onTestFinished(async () => {
    try {
      await (await starting).destroy();
    } finally {
      await Promise.allSettled([pending]);
    }
  });
  pending = (async () => {
    const server = await starting;
    signal.throwIfAborted();
    await Promise.race([server.ready, aborted(signal, server)]);
    signal.throwIfAborted();
    identities.values.set(source, sourceIdentity);
    identities.values.set(destination, destinationIdentity);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/rename-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'file', fromPath: 'note', toPath: 'NOTE' }),
      signal,
    });
    await response.text();
    expect(identities.observed).toEqual(new Set([source, destination]));
    return response.status;
  })();
  return await pending;
}

test.for([false, true])(
  'refuses distinct case-only targets with inode collision=%s',
  async (collision, context) => {
    const status = await renameCaseOnlyWithIdentities(
      context,
      {
        exact: collision ? 9851624185071827n : 11n,
        numeric: collision ? 9851624185071828 : 11,
      },
      {
        exact: collision ? 9851624185071829n : 13n,
        numeric: collision ? 9851624185071828 : 13,
      },
    );
    expect(status).toBe(409);
  },
);

test('admits a case-only rename when both spellings have the same exact identity', async (context) => {
  const shared = { exact: 9851624185071827n, numeric: 9851624185071828 };
  const status = await renameCaseOnlyWithIdentities(context, shared, shared);
  expect(status).toBe(200);
});
