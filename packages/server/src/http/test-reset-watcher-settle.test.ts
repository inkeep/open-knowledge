import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { BootedServer } from '../boot.ts';
import { bootCompositionRig } from '../composition-rig.test-helper.ts';
import {
  forgetNativeSubscriptions,
  latestNativeSubscriptionOn,
  nativeSubscriptionCount,
  nativeSubscriptionOn,
  refuseNativeSubscriptions,
} from '../parcel-watcher-double.test-helper.ts';

vi.mock('@parcel/watcher', async () => {
  const { parcelWatcherModule } = await import('../parcel-watcher-double.test-helper.ts');
  return parcelWatcherModule;
});

const KEPT = '# Kept\n';

const servers: BootedServer[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.destroy();
  forgetNativeSubscriptions();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serverWithTestDoc(): Promise<{ server: BootedServer; contentDir: string }> {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-reset-settle-')));
  scratch.push(contentDir);
  writeFileSync(join(contentDir, 'test-doc.md'), KEPT);
  const server = await bootCompositionRig(contentDir, { enableTestRoutes: true });
  servers.push(server);
  await server.ready;
  return { server, contentDir };
}

function postServerReset(server: BootedServer): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/test-reset?scope=server`, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
  });
}

function fencesIn(contentDir: string): string[] {
  return readdirSync(join(contentDir, '.ok')).filter((name) =>
    name.startsWith('watcher-settle-fence-'),
  );
}

test('a server-scope reset runs once the watcher has handled its settle fence', async () => {
  const { server, contentDir } = await serverWithTestDoc();

  const reset = postServerReset(server);
  await expect.poll(() => fencesIn(contentDir)).toHaveLength(1);
  const [fence] = fencesIn(contentDir);
  expect(readFileSync(join(contentDir, 'test-doc.md'), 'utf-8')).toBe(KEPT);
  await nativeSubscriptionOn(contentDir).deliver([
    { type: 'create', path: join(contentDir, '.ok', fence) },
  ]);
  const response = await reset;

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ scope: 'server' });
  expect(readFileSync(join(contentDir, 'test-doc.md'), 'utf-8')).toBe('');
  expect(fencesIn(contentDir)).toEqual([]);
});

test('after a watcher error, a server-scope reset runs on the new subscription once it is live', async () => {
  const { server, contentDir } = await serverWithTestDoc();
  const failure = `inotify_add_watch on '${join(contentDir, 'guides')}' failed: No space left on device`;
  await nativeSubscriptionOn(contentDir).deliver([], new Error(failure));
  await expect.poll(() => nativeSubscriptionCount(contentDir)).toBe(2);

  const reset = postServerReset(server);
  await expect.poll(() => fencesIn(contentDir)).toHaveLength(1);
  const [fence] = fencesIn(contentDir);
  await latestNativeSubscriptionOn(contentDir).deliver([
    { type: 'create', path: join(contentDir, '.ok', fence) },
  ]);
  const response = await reset;

  expect(response.status).toBe(200);
  expect(readFileSync(join(contentDir, 'test-doc.md'), 'utf-8')).toBe('');
  expect(fencesIn(contentDir)).toEqual([]);
});

test('while the watcher cannot subscribe again after an error, a server-scope reset answers with that error and resets nothing', async () => {
  const { server, contentDir } = await serverWithTestDoc();
  const failure = `inotify_add_watch on '${join(contentDir, 'guides')}' failed: No space left on device`;
  refuseNativeSubscriptions(contentDir, 3);
  await nativeSubscriptionOn(contentDir).deliver([], new Error(failure));

  const response = await postServerReset(server);

  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({
    type: 'urn:ok:error:internal-server-error',
    title: 'The server-scope reset did not run, because the file watcher could not settle.',
    detail: `the file watcher is subscribing again after an error and cannot settle until it is back: ${failure}`,
  });
  expect(nativeSubscriptionCount(contentDir)).toBe(1);
  expect(readFileSync(join(contentDir, 'test-doc.md'), 'utf-8')).toBe(KEPT);
  expect(fencesIn(contentDir)).toEqual([]);
});
