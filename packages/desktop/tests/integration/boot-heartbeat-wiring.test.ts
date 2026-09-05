import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const indexTsPath = resolve(fileURLToPath(new URL('../../src/main/index.ts', import.meta.url)));
const src = readFileSync(indexTsPath, 'utf-8');

const FIX = (what: string): string =>
  `\n[boot-heartbeat] ${what}\n\n` +
  `The desktop smoke harness gives up when the app stops narrating for BOOT_LOG_STALL_MS.\n` +
  `That bound is only sound while main emits a line every SPAWN_WAIT_HEARTBEAT_MS from process\n` +
  `start until the first window is shown, which is what this wiring provides. Sever it and every\n` +
  `smoke test still passes — safeShow() marks the window shown before it calls onShown, inside a\n` +
  `warn-only try/catch — while a slow boot starts failing against a log that is silent by design.\n` +
  `Three earlier revisions of this PR shipped a heartbeat wired to only part of the boot path.\n`;

describe('global boot-heartbeat wiring (bypass-pin)', () => {
  test('the heartbeat is armed exactly once and is budgeted', () => {
    const arms = src.match(/\bstartBootHeartbeat\(/g) ?? [];
    expect(
      arms.length,
      FIX(`index.ts has ${arms.length} \`startBootHeartbeat(\` call(s); expected exactly 1.`),
    ).toBe(1);
    expect(
      /startBootHeartbeat\(\s*bootHeartbeatDeps\b[\s\S]{0,400}?maxBeats:\s*BOOT_HEARTBEAT_MAX_BEATS/.test(
        src,
      ),
      FIX(
        'the global heartbeat is no longer budgeted, so a boot parked on a modal narrates forever.',
      ),
    ).toBe(true);
  });

  test('it is stopped when the first window is shown', () => {
    const body = src.match(/function onFirstWindowShown\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(body, FIX('onFirstWindowShown() was not found in index.ts.')).not.toBe('');
    expect(
      body.includes('stopBootHeartbeat()'),
      FIX('onFirstWindowShown() does not call stopBootHeartbeat().'),
    ).toBe(true);
  });

  test('onFirstWindowShown is reachable from the show gate', () => {
    expect(
      /onShown:\s*\(\)\s*=>\s*onFirstWindowShown\(\)/.test(src),
      FIX('the show gate no longer routes onShown to onFirstWindowShown().'),
    ).toBe(true);
  });

  test('a boot that never shows a window still stops narrating, on every branch', () => {
    expect(
      /^app\.on\('will-quit', stopBootHeartbeat\);$/m.test(src),
      FIX(
        'the will-quit stop is not registered at module scope beside the arm, so branches that ' +
          'never call bootPrimaryInstance() (driver-boot-smoke, the single-instance-lock loser) ' +
          'quit with the heartbeat still armed.',
      ),
    ).toBe(true);
  });
});
