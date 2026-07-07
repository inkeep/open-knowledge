import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyUserDataDir } from './userdata-migration.ts';

/**
 * A minimal blob that `parseAppState` accepts (it requires `recentProjects` to
 * be an array; everything else defaults). The recent-project marker lets a test
 * assert the specific bytes carried across.
 */
function ourStateJson(markerPath: string): string {
  return JSON.stringify({
    recentProjects: [
      { path: markerPath, name: 'Marker', lastOpenedAt: '2026-01-01T00:00:00.000Z' },
    ],
    lastOpenedProject: markerPath,
  });
}

const NOOP_LOGGER = { event: () => {} };

describe('migrateLegacyUserDataDir', () => {
  let appSupport: string;
  let targetDir: string;
  let legacyDir: string;

  beforeEach(() => {
    // Stand in for `~/Library/Application Support`.
    appSupport = mkdtempSync(join(tmpdir(), 'ok-userdata-migrate-'));
    targetDir = join(appSupport, 'OpenKnowledge');
    legacyDir = join(appSupport, 'Open Knowledge');
  });

  afterEach(() => {
    rmSync(appSupport, { recursive: true, force: true });
  });

  function seedLegacy(stateJson: string | null, extra?: Record<string, string>): void {
    mkdirSync(legacyDir, { recursive: true });
    if (stateJson !== null) writeFileSync(join(legacyDir, 'state.json'), stateJson);
    for (const [name, contents] of Object.entries(extra ?? {})) {
      writeFileSync(join(legacyDir, name), contents);
    }
  }

  test('skips on non-darwin platforms (no fs changes)', async () => {
    seedLegacy(ourStateJson('/p'));
    const result = await migrateLegacyUserDataDir({
      userDataDir: targetDir,
      platform: 'win32',
      logger: NOOP_LOGGER,
    });
    expect(result.status).toBe('skipped-non-darwin');
    expect(existsSync(legacyDir)).toBe(true);
    expect(existsSync(targetDir)).toBe(false);
  });

  test('is dormant until the userData basename is the new name', async () => {
    // Pre-rename build: userData is still ".../Open Knowledge".
    seedLegacy(ourStateJson('/p'));
    const result = await migrateLegacyUserDataDir({
      userDataDir: legacyDir,
      platform: 'darwin',
      logger: NOOP_LOGGER,
    });
    expect(result.status).toBe('skipped-not-target-name');
    // Untouched.
    expect(existsSync(join(legacyDir, 'state.json'))).toBe(true);
  });

  test('skips when the target is already initialized (state.json present)', async () => {
    seedLegacy(ourStateJson('/legacy'));
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'state.json'), ourStateJson('/already-here'));
    const result = await migrateLegacyUserDataDir({
      userDataDir: targetDir,
      platform: 'darwin',
      logger: NOOP_LOGGER,
    });
    expect(result.status).toBe('skipped-already-initialized');
    // The legacy dir is left as an orphan (harmless); never adopted.
    expect(existsSync(join(legacyDir, 'state.json'))).toBe(true);
    // Target state untouched.
    expect(readFileSync(join(targetDir, 'state.json'), 'utf8')).toBe(ourStateJson('/already-here'));
  });

  test('skips when there is no legacy dir (fresh post-rename install)', async () => {
    const result = await migrateLegacyUserDataDir({
      userDataDir: targetDir,
      platform: 'darwin',
      logger: NOOP_LOGGER,
    });
    expect(result.status).toBe('skipped-no-legacy-dir');
  });

  test('does NOT adopt a foreign dir whose state.json is not our shape', async () => {
    // Another vendor's app named "Open Knowledge" wrote a non-OK state.json.
    const foreign = JSON.stringify({ theirApp: true, windows: [1, 2, 3] });
    seedLegacy(foreign);
    const result = await migrateLegacyUserDataDir({
      userDataDir: targetDir,
      platform: 'darwin',
      logger: NOOP_LOGGER,
    });
    expect(result.status).toBe('skipped-unrecognized-legacy');
    // Foreign data must be left completely intact — never copied, never deleted.
    expect(existsSync(join(legacyDir, 'state.json'))).toBe(true);
    expect(readFileSync(join(legacyDir, 'state.json'), 'utf8')).toBe(foreign);
    expect(existsSync(join(targetDir, 'state.json'))).toBe(false);
  });

  test('does NOT adopt a legacy dir with no state.json (cannot verify ownership)', async () => {
    seedLegacy(null, { 'some-cache': 'x' });
    const result = await migrateLegacyUserDataDir({
      userDataDir: targetDir,
      platform: 'darwin',
      logger: NOOP_LOGGER,
    });
    expect(result.status).toBe('skipped-unrecognized-legacy');
    expect(existsSync(legacyDir)).toBe(true);
  });

  test('migrates a verified-ours legacy dir, carries all files, and cleans up', async () => {
    const state = ourStateJson('/my/project');
    seedLegacy(state, { 'Local Storage': 'renderer-state', 'window-state.json': '{"bounds":1}' });
    const result = await migrateLegacyUserDataDir({
      userDataDir: targetDir,
      platform: 'darwin',
      logger: NOOP_LOGGER,
    });
    expect(result.status).toBe('migrated');
    // state.json + the sibling files landed in the new dir...
    expect(readFileSync(join(targetDir, 'state.json'), 'utf8')).toBe(state);
    expect(readFileSync(join(targetDir, 'Local Storage'), 'utf8')).toBe('renderer-state');
    expect(readFileSync(join(targetDir, 'window-state.json'), 'utf8')).toBe('{"bounds":1}');
    // ...and the legacy dir is fully removed (cleanup).
    expect(existsSync(legacyDir)).toBe(false);
  });

  test('preserves a pre-existing target file (path-install.json gotcha)', async () => {
    // The target dir already exists pre-migration because path-install.ts wrote
    // OpenKnowledge/path-install.json on a pre-rename build. That file MUST win.
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'path-install.json'), '{"version":1,"keep":"me"}');
    seedLegacy(ourStateJson('/p'), { 'path-install.json': '{"version":1,"stale":"legacy"}' });

    const result = await migrateLegacyUserDataDir({
      userDataDir: targetDir,
      platform: 'darwin',
      logger: NOOP_LOGGER,
    });
    expect(result.status).toBe('migrated');
    // The pre-existing target file is NOT overwritten by the legacy copy.
    expect(readFileSync(join(targetDir, 'path-install.json'), 'utf8')).toBe(
      '{"version":1,"keep":"me"}',
    );
    // state.json still carried across.
    expect(existsSync(join(targetDir, 'state.json'))).toBe(true);
    expect(existsSync(legacyDir)).toBe(false);
  });

  test("reports 'failed' (non-fatal) and preserves legacy data when the copy can't proceed", async () => {
    // Pre-create the target PATH as a regular FILE so mkdirSync(targetDir)
    // throws, exercising the outer catch / 'failed' path. The legacy dir is a
    // valid, ours-verified dir so we get past the identity gate first.
    seedLegacy(ourStateJson('/p'));
    writeFileSync(targetDir, 'not a directory');
    const result = await migrateLegacyUserDataDir({
      userDataDir: targetDir,
      platform: 'darwin',
      logger: NOOP_LOGGER,
    });
    expect(result.status).toBe('failed');
    // Nothing was deleted on the failure path — legacy data is recoverable.
    expect(existsSync(join(legacyDir, 'state.json'))).toBe(true);
  });

  test('is idempotent — a second run is a no-op skip', async () => {
    seedLegacy(ourStateJson('/p'));
    const first = await migrateLegacyUserDataDir({
      userDataDir: targetDir,
      platform: 'darwin',
      logger: NOOP_LOGGER,
    });
    expect(first.status).toBe('migrated');
    const second = await migrateLegacyUserDataDir({
      userDataDir: targetDir,
      platform: 'darwin',
      logger: NOOP_LOGGER,
    });
    expect(second.status).toBe('skipped-already-initialized');
    expect(existsSync(legacyDir)).toBe(false);
  });
});
