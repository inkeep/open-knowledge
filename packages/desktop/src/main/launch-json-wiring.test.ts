import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAUNCH_UI_CHAIN_V1 } from '@inkeep/open-knowledge';
import { checkAndRepairLaunchJsonOnProjectOpen } from './launch-json-wiring.ts';

const EXE = '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';
// Current canonical recipe — the `# ok-ui-v1` `/bin/sh` chain that runs
// `ok start`, the exact shape `scaffoldLaunchJson('published')` writes.
const CANONICAL_UI = {
  runtimeExecutable: '/bin/sh',
  runtimeArgs: ['-l', '-c', LAUNCH_UI_CHAIN_V1],
  port: 39848,
  autoPort: true,
};

function project() {
  return mkdtempSync(join(tmpdir(), 'ok-launch-json-'));
}

describe('checkAndRepairLaunchJsonOnProjectOpen — force-write posture', () => {
  test('no file → creates fresh launch.json with the OK entry', async () => {
    const dir = project();
    const events: Array<Record<string, unknown>> = [];
    const result = await checkAndRepairLaunchJsonOnProjectOpen({
      projectDir: dir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      logger: { event: (e) => events.push(e) },
    });
    expect(result.status).toBe('created');
    const path = join(dir, '.claude', 'launch.json');
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.configurations[0]).toMatchObject({
      name: 'open-knowledge-ui',
      ...CANONICAL_UI,
    });
    expect(events.some((e) => e.event === 'launch-json-wiring-repair-created')).toBe(true);
  });

  test('blank file → rewritten with the OK entry (no error)', async () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'));
    const path = join(dir, '.claude', 'launch.json');
    writeFileSync(path, '');
    const result = await checkAndRepairLaunchJsonOnProjectOpen({
      projectDir: dir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
    });
    // scaffoldLaunchJson treats blank as {} and creates a fresh configurations
    // array — surfaced as 'created' because the entry didn't exist beforehand.
    expect(result.status).toBe('created');
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.configurations[0].name).toBe('open-knowledge-ui');
    expect(parsed.configurations[0]).toMatchObject(CANONICAL_UI);
  });

  test('already-canonical file → still merged (idempotent, no on-disk diff)', async () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'));
    const path = join(dir, '.claude', 'launch.json');
    // Seed with the exact shape scaffoldLaunchJson writes (incl. its
    // `LAUNCH_JSON_PORT` constant) so the second-write byte diff is zero.
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          version: '0.2.0',
          configurations: [
            {
              name: 'open-knowledge-ui',
              ...CANONICAL_UI,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const before = readFileSync(path, 'utf8');
    const result = await checkAndRepairLaunchJsonOnProjectOpen({
      projectDir: dir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
    });
    expect(result.status).toBe('merged');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('file without OK entry → entry added, siblings preserved', async () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'));
    const path = join(dir, '.claude', 'launch.json');
    writeFileSync(
      path,
      JSON.stringify({ configurations: [{ name: 'other', runtimeExecutable: 'node' }] }),
    );
    const result = await checkAndRepairLaunchJsonOnProjectOpen({
      projectDir: dir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
    });
    // scaffoldLaunchJson's contract: action='created' when the OK entry didn't
    // exist before, action='merged' when an OK entry was already present and
    // got replaced. So new-entry-into-existing-file is 'created', not 'merged'.
    expect(result.status).toBe('created');
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.configurations).toHaveLength(2);
    expect(parsed.configurations[0].name).toBe('other');
    expect(parsed.configurations[1]).toMatchObject({
      name: 'open-knowledge-ui',
      ...CANONICAL_UI,
    });
  });

  test('stale OK entry → rewritten to canonical ok-start chain; siblings preserved', async () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'));
    const path = join(dir, '.claude', 'launch.json');
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: '0.0.1',
          configurations: [
            { name: 'other', runtimeExecutable: 'node' },
            {
              name: 'open-knowledge-ui',
              runtimeExecutable: '/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh',
              runtimeArgs: ['ui'],
            },
          ],
        },
        null,
        2,
      ),
    );
    const result = await checkAndRepairLaunchJsonOnProjectOpen({
      projectDir: dir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
    });
    expect(result.status).toBe('merged');
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.configurations[0].name).toBe('other');
    expect(parsed.configurations[1]).toMatchObject({
      name: 'open-knowledge-ui',
      ...CANONICAL_UI,
    });
  });

  test('corrupt JSON → failed (no backup-and-rewrite for launch.json — siblings outweigh recovery)', async () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'launch.json'), '{ invalid json');
    const events: Array<Record<string, unknown>> = [];
    const result = await checkAndRepairLaunchJsonOnProjectOpen({
      projectDir: dir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      logger: { event: (e) => events.push(e) },
    });
    expect(result.status).toBe('failed');
    expect(events.some((e) => e.event === 'launch-json-wiring-repair-write-failed')).toBe(true);
  });

  test('non-object root → failed', async () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'launch.json'), '[1, 2, 3]');
    const result = await checkAndRepairLaunchJsonOnProjectOpen({
      projectDir: dir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
    });
    expect(result.status).toBe('failed');
  });

  test('skipped on non-darwin', async () => {
    const dir = project();
    const result = await checkAndRepairLaunchJsonOnProjectOpen({
      projectDir: dir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'linux',
    });
    expect(result.status).toBe('skipped');
  });

  test('skipped in dev-mode without OK_M6B_FORCE', async () => {
    const dir = project();
    const result = await checkAndRepairLaunchJsonOnProjectOpen({
      projectDir: dir,
      executablePath: EXE,
      isPackaged: false,
      platform: 'darwin',
    });
    expect(result.status).toBe('skipped');
    expect(existsSync(join(dir, '.claude', 'launch.json'))).toBe(false);
  });

  test('OK_RECLAIM_DISABLE=1 short-circuits', async () => {
    const dir = project();
    const result = await checkAndRepairLaunchJsonOnProjectOpen({
      projectDir: dir,
      executablePath: EXE,
      isPackaged: true,
      platform: 'darwin',
      reclaimDisableEnv: '1',
    });
    expect(result.status).toBe('skipped');
    expect(existsSync(join(dir, '.claude', 'launch.json'))).toBe(false);
  });
});
