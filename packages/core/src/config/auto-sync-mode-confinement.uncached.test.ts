import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isTestOnlySourceFile } from '../../../../test-support/test-only-source-file.mjs';

const ALLOWED_READERS = new Set([
  'packages/core/src/config/auto-sync-mode.ts',
  'packages/app/src/hooks/use-worktree-autosync-notice.tsx',
]);

const LEGACY_READ = /autoSync\??\.\s*enabled/;
const LEGACY_READ_BRACKET = /autoSync\s*\[\s*['"]enabled['"]\s*\]/;
const STRING_LITERAL = /'[^']*'|"[^"]*"|`[^`]*`/g;

function findSubtreeRoot(): string {
  let dir = resolve(__dirname);
  for (let i = 0; i < 10; i++) {
    try {
      statSync(join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      dir = resolve(dir, '..');
    }
  }
  throw new Error(`pnpm-workspace.yaml not found walking up from ${__dirname}`);
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* sourceFiles(full);
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !isTestOnlySourceFile(entry.name) &&
      !entry.name.includes('test-helper')
    ) {
      yield full;
    }
  }
}

const PACKAGES_WITHOUT_SOURCE = new Set(['plugin']);

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function packagesWithoutSource(packagesDir: string): string[] {
  return readdirSync(packagesDir)
    .filter((name) => existsSync(join(packagesDir, name, 'package.json')))
    .filter(
      (name) => !isDirectory(join(packagesDir, name, 'src')) && !PACKAGES_WITHOUT_SOURCE.has(name),
    )
    .sort();
}

describe('autoSync.enabled read confinement', () => {
  test('every package with a manifest has a src directory, or is a manifest-only package', () => {
    expect(
      packagesWithoutSource(join(findSubtreeRoot(), 'packages')),
      'packages with a package.json but no src directory: this check would skip their source, so ' +
        'give the package a src directory, or add it to PACKAGES_WITHOUT_SOURCE if it carries no source',
    ).toEqual([]);
  });

  test('names a package with a manifest and no src, and not a manifest-only package or a leftover directory (planted positive)', () => {
    const packagesDir = mkdtempSync(join(tmpdir(), 'ok-auto-sync-packages-'));
    try {
      mkdirSync(join(packagesDir, 'with-src', 'src'), { recursive: true });
      writeFileSync(join(packagesDir, 'with-src', 'package.json'), '{}\n');
      mkdirSync(join(packagesDir, 'without-src'));
      writeFileSync(join(packagesDir, 'without-src', 'package.json'), '{}\n');
      mkdirSync(join(packagesDir, 'plugin'));
      writeFileSync(join(packagesDir, 'plugin', 'package.json'), '{}\n');
      mkdirSync(join(packagesDir, 'leftover', 'node_modules'), { recursive: true });
      expect(packagesWithoutSource(packagesDir)).toEqual(['without-src']);
    } finally {
      rmSync(packagesDir, { recursive: true, force: true });
    }
  });

  test('legacy enabled is only read by the mode-derive path', () => {
    const root = findSubtreeRoot();
    const offenders: string[] = [];
    const packagesDir = join(root, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const src = join(packagesDir, pkg, 'src');
      if (!isDirectory(src)) continue;
      for (const file of sourceFiles(src)) {
        const rel = relative(root, file);
        if (ALLOWED_READERS.has(rel)) continue;
        const lines = readFileSync(file, 'utf-8').split('\n');
        lines.forEach((line, idx) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            return;
          }
          const code = line.replace(STRING_LITERAL, "''").split('//')[0];
          const rawCode = line.split('//')[0];
          if (LEGACY_READ.test(code) || LEGACY_READ_BRACKET.test(rawCode)) {
            offenders.push(`${rel}:${idx + 1}: ${trimmed}`);
          }
        });
      }
    }
    expect(
      offenders,
      'autoSync.enabled must only be read by the derive path (auto-sync-mode.ts resolvers). ' +
        'Route new readers through resolveLocalAutoSyncMode/resolveEffectiveAutoSyncMode, ' +
        'or extend ALLOWED_READERS only for call sites that feed those resolvers directly.',
    ).toEqual([]);
  });
});
