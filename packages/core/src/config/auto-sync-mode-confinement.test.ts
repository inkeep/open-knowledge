import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

// Cross-file contract: `autoSync.mode` is the single sync knob. The legacy
// `autoSync.enabled` boolean may only be READ by the derive path in
// `auto-sync-mode.ts` (or by call sites that pass it straight into those
// resolvers). Any other read re-creates the two-knob split where a
// non-mode-aware reader could treat "enabled" as permission to push for a
// pull-only project. Runtime tests cannot catch a future rogue read (it only
// misbehaves once shipped), so this structural sweep is the machine guard.
// When adding a legitimate new derive-path caller, extend ALLOWED_READERS.
const ALLOWED_READERS = new Set([
  'packages/core/src/config/auto-sync-mode.ts',
  'packages/app/src/hooks/use-worktree-autosync-notice.tsx',
]);

// Dotted / optional-chained reads: `autoSync.enabled`, `autoSync?.enabled`.
const LEGACY_READ = /autoSync\??\.\s*enabled/;
// Bracket-indexed reads: `autoSync['enabled']`, `autoSync["enabled"]`. Matched
// against the raw line (not the string-blanked `code`) because blanking would
// erase the literal key that is the signal. Known blind spot: a destructured
// read (`const { enabled } = autoSync`) still slips past — the codebase reads
// `enabled` by property access, so this is the pragmatic floor, not exhaustive.
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
      !entry.name.includes('.test.') &&
      !entry.name.includes('test-helper')
    ) {
      yield full;
    }
  }
}

describe('autoSync.enabled read confinement', () => {
  test('legacy enabled is only read by the mode-derive path', () => {
    const root = findSubtreeRoot();
    const offenders: string[] = [];
    const packagesDir = join(root, 'packages');
    for (const pkg of readdirSync(packagesDir)) {
      const src = join(packagesDir, pkg, 'src');
      let srcStat: ReturnType<typeof statSync>;
      try {
        srcStat = statSync(src);
      } catch {
        continue;
      }
      if (!srcStat.isDirectory()) continue;
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
          // Bracket reads keep their literal key, so match them on the raw line.
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
