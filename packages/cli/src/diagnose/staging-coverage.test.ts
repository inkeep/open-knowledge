import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { collectBundle, SECRET_SCRUB_EXTENSIONS } from './bundle.ts';
import { CONTENT_SUBDIRS_MASKED } from './bundle-redact.ts';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('staged-content coverage', () => {
  const TOP_LEVEL = {
    telemetry: 'masked',
    logs: 'masked',
    process: 'masked',
    'diagnostic-reports': 'masked',
    state: 'masked-separately',
    extra: 'raw-bytes-by-design',
  } as const;

  test('every masked subdir is declared, and every declared one is masked', () => {
    const declared = Object.entries(TOP_LEVEL)
      .filter(([, mode]) => mode === 'masked')
      .map(([dir]) => dir)
      .sort();
    expect([...CONTENT_SUBDIRS_MASKED].sort()).toEqual(declared);
  });

  test('the only unmasked staged directory is the declared binary exemption', () => {
    const unmasked = Object.entries(TOP_LEVEL)
      .filter(([, mode]) => mode === 'raw-bytes-by-design')
      .map(([dir]) => dir);
    expect(unmasked).toEqual(['extra']);
  });

  test('the secret-scrub extension set is exactly what is declared', () => {
    expect([...SECRET_SCRUB_EXTENSIONS].sort()).toEqual([
      '.ips',
      '.json',
      '.jsonl',
      '.lock',
      '.log',
      '.txt',
      '.yaml',
      '.yml',
    ]);
  });

  test('every text file family the masked subdirs stage is scrub-registered', () => {
    const stagedExtensions = {
      telemetry: ['.jsonl'],
      logs: ['.jsonl', '.log'],
      process: ['.json', '.txt'],
      'diagnostic-reports': ['.ips'],
    } as const;
    expect(Object.keys(stagedExtensions).sort()).toEqual([...CONTENT_SUBDIRS_MASKED].sort());
    for (const [dir, exts] of Object.entries(stagedExtensions)) {
      for (const ext of exts) {
        expect(SECRET_SCRUB_EXTENSIONS.has(ext), `${dir} stages ${ext}`).toBe(true);
      }
    }
  });

  test('collectBundle produces no top-level directory this file does not declare', async () => {
    const contentDir = mkdtempSync(resolve(tmpdir(), 'ok-staging-coverage-'));
    tmpDirs.push(contentDir);
    writeFileSync(join(contentDir, 'note.md'), '# note\n');

    const collected = await collectBundle({
      contentDir,
      deps: {
        fetchAgentPresence: async () => null,
        fetchAgentEffects: async () => null,
        fetchWatcherRecent: async () => null,
        readShadowHead: () => null,
        readCheckpointRefs: () => null,
        now: () => new Date('2026-05-28T14:22:01.000Z'),
        okVersion: () => '0.7.99',
        readDesktopEnv: () => null,
        readRuntime: () => ({ nodeVersion: 'v24.18.0', platform: 'darwin', arch: 'arm64' }),
        isOtlpPushEnabled: () => false,
      },
    });

    try {
      const produced = readdirSync(collected.stagingDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      expect(produced.length).toBeGreaterThan(0);
      for (const dir of produced) {
        expect(Object.keys(TOP_LEVEL), `staged directory "${dir}" is undeclared`).toContain(dir);
      }
    } finally {
      collected.cleanup();
    }
  });
});
