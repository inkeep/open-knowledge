import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { launchOwnedWorkerServer } from '../stress/_helpers/reuse/owned-dev-server.ts';
import { APP_PACKAGE_ROOT } from '../stress/_helpers/seed-key.ts';

const LABEL = 'lost-owner-s0';
const LIFETIME_LOSS =
  'worker server lifetime closed without completed release (code=1, signal=null)';
const LAUNCH_TIMEOUT_MS = 60_000;
const saved = { TMPDIR: process.env.TMPDIR, NODE_OPTIONS: process.env.NODE_OPTIONS };
const scratchDirs: string[] = [];

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function viteCacheDirsOf(label: string): string[] {
  const modules = join(APP_PACKAGE_ROOT, 'node_modules');
  if (!existsSync(modules)) return [];
  return readdirSync(modules).filter((name) => name.startsWith(`.vite-${label}-`));
}

describe('an owned server whose lifetime owner is lost before it releases', () => {
  test(
    'the real lifetime’s loss fails the launch, the release that follows reports the same loss instead of throwing, and nothing the launch created is left',
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-owned-lost-owner-')));
      scratchDirs.push(root);
      const tmp = join(root, 'tmp');
      mkdirSync(tmp);
      process.env.TMPDIR = tmp;
      process.env.NODE_OPTIONS = `--require=${join(root, 'no-such-preload.cjs')}`;

      const failure = await launchOwnedWorkerServer({
        label: LABEL,
        workerServerEnv: {},
        serving: { kind: 'dev-server' },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      const lines = (failure as Error).message.split('\n');
      expect(lines[0]).toBe(LIFETIME_LOSS);
      expect(lines.at(-1)).toBe(
        `--- cleanup after this failure did not complete: ${LIFETIME_LOSS} ---`,
      );
      expect(readdirSync(tmp)).toEqual([]);
      expect(viteCacheDirsOf(LABEL)).toEqual([]);
    },
    LAUNCH_TIMEOUT_MS,
  );
});
