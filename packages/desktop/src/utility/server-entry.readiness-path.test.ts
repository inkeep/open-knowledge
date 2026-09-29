import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import type { UtilityLoadProbeRecord } from './server-entry-load-probe.test-helper.ts';

const PROBE_COUNT = 3;
const SUITE_LIVENESS_BUDGET_MS = 90_000;
const PROBE_LIVENESS_TIMEOUT_MS = Math.floor(SUITE_LIVENESS_BUDGET_MS / PROBE_COUNT);
const TEST_LIVENESS_TIMEOUT_MS = PROBE_LIVENESS_TIMEOUT_MS + 5_000;
const OK_PACKAGE_SPECIFIER_PREFIX = '@inkeep/open-knowledge';
const OK_DEBUG_ENV_PREFIX = 'OK_DEBUG_';

const utilityDir = fileURLToPath(new URL('.', import.meta.url));
const probePath = join(utilityDir, 'server-entry-load-probe.test-helper.ts');
const fixturePath = join(utilityDir, 'server-entry-load-probe.fixture.test-helper.ts');
const productionEntryPath = join(utilityDir, 'server-entry.ts');

const probeSandboxes: string[] = [];

afterAll(() => {
  for (const dir of probeSandboxes) rmSync(dir, { recursive: true, force: true });
});

function runLoadProbe(
  entryPath: string,
  extraEnv: Record<string, string> = {},
): UtilityLoadProbeRecord {
  const sandbox = mkdtempSync(join(tmpdir(), 'ok-utility-load-probe-'));
  probeSandboxes.push(sandbox);
  const recordPath = join(sandbox, 'record.json');
  const scrubbed: Record<string, string | undefined> = {};
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(OK_DEBUG_ENV_PREFIX)) scrubbed[name] = undefined;
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...scrubbed,
    HOME: sandbox,
    USERPROFILE: sandbox,
    ...extraEnv,
  };
  const spawned = spawnSync(process.execPath, [probePath, entryPath, recordPath], {
    encoding: 'utf-8',
    timeout: PROBE_LIVENESS_TIMEOUT_MS,
    env,
  });
  if (spawned.status !== 0) {
    throw new Error(
      `load probe exited with status=${spawned.status} signal=${spawned.signal} for ${entryPath}\nstderr: ${spawned.stderr}`,
    );
  }
  return JSON.parse(readFileSync(recordPath, 'utf-8')) as UtilityLoadProbeRecord;
}

function assertProbeImportedItsEntry(record: UtilityLoadProbeRecord): void {
  if (record.entryImportFailure === null) return;
  const unresolved = record.entryImportFailure.code === 'ERR_MODULE_NOT_FOUND';
  const remedy = unresolved
    ? ' This suite resolves @inkeep/open-knowledge, -core and -server through their production export conditions (dist), so those three packages must be built first. The desktop `test` turbo task supplies that through its `dependsOn: ["^build"]`; a bare `vitest run` in this package does not.'
    : '';
  throw new Error(
    `the load probe could not import ${record.entryPath}: ${record.entryImportFailure.message} (code=${record.entryImportFailure.code}).${remedy}`,
  );
}

function modulesLoadedBeforeParentPortListener(record: UtilityLoadProbeRecord): string[] {
  assertProbeImportedItsEntry(record);
  const listenerSeq = record.parentPortListenerRegisteredAtSeq;
  if (listenerSeq === null) {
    throw new Error(
      `${record.entryPath} never registered a parent-port message listener, so there is no ordering to judge; the probe recorded ${record.totalEventCount} loader events`,
    );
  }
  const urlToSpecifier = new Map<string, string>();
  for (const resolved of record.bareSpecifierResolves) {
    if (!urlToSpecifier.has(resolved.url)) urlToSpecifier.set(resolved.url, resolved.specifier);
  }
  const loadedEarly = new Set<string>();
  for (const load of record.moduleLoads) {
    if (load.seq >= listenerSeq) continue;
    loadedEarly.add(urlToSpecifier.get(load.url) ?? load.url);
  }
  return [...loadedEarly].sort();
}

function okPackagesLoadedBeforeParentPortListener(record: UtilityLoadProbeRecord): string[] {
  return modulesLoadedBeforeParentPortListener(record).filter((entry) =>
    entry.startsWith(OK_PACKAGE_SPECIFIER_PREFIX),
  );
}

describe('utility readiness critical path: what the process evaluates before it can act on a queued `init`', () => {
  test(
    'the probe reports a violation for a fixture that finishes an @inkeep/open-knowledge import before registering its parent-port listener',
    () => {
      const record = runLoadProbe(fixturePath, {
        OK_UTILITY_LOAD_PROBE_FIXTURE_MODE: 'import-before-listener',
      });
      assertProbeImportedItsEntry(record);
      expect(record.parentPortListenerRegisteredAtSeq).toEqual(expect.any(Number));
      expect(okPackagesLoadedBeforeParentPortListener(record)).toEqual([
        '@inkeep/open-knowledge-core/shadow-repo-layout',
      ]);
    },
    TEST_LIVENESS_TIMEOUT_MS,
  );

  test(
    'the probe reports no violation for a fixture that registers its parent-port listener before the same import',
    () => {
      const record = runLoadProbe(fixturePath, {
        OK_UTILITY_LOAD_PROBE_FIXTURE_MODE: 'listener-before-import',
      });
      assertProbeImportedItsEntry(record);
      expect(record.parentPortListenerRegisteredAtSeq).toEqual(expect.any(Number));
      expect(record.bareSpecifierResolves.map((event) => event.specifier)).toContain(
        '@inkeep/open-knowledge-core/shadow-repo-layout',
      );
      expect(okPackagesLoadedBeforeParentPortListener(record)).toEqual([]);
    },
    TEST_LIVENESS_TIMEOUT_MS,
  );

  test(
    'server-entry registers its parent-port message listener before it evaluates anything beyond its own cheap module scope',
    () => {
      const record = runLoadProbe(productionEntryPath);
      expect(record.moduleLoads.map((load) => load.url)).toContain(
        pathToFileURL(productionEntryPath).href,
      );
      expect(record.parentPortListenerRegisteredAtSeq).toEqual(expect.any(Number));
      expect(modulesLoadedBeforeParentPortListener(record)).toEqual([
        pathToFileURL(join(utilityDir, 'keyring-smoke.ts')).href,
        pathToFileURL(productionEntryPath).href,
        'node:fs/promises',
        'node:path',
      ]);
    },
    TEST_LIVENESS_TIMEOUT_MS,
  );
});
