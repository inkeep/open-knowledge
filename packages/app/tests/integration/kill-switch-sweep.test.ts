import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigSchema, getLeafFieldMeta } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(HERE, '../../..');

interface MechanismRow {
  readonly leaf: string;
  readonly offFile: string;
  readonly offTitle: string;
  readonly onFile: string;
  readonly onTitle: string;
}

const KILL_SWITCHES: readonly MechanismRow[] = [
  {
    leaf: 'bridge.flushOnHide.enabled',
    offFile: 'app/src/editor/provider-pool-flush-on-hide.test.ts',
    offTitle: 'is inert when the kill-switch is off (no force-sync, no IDB commit)',
    onFile: 'app/src/editor/provider-pool-flush-on-hide.test.ts',
    onTitle: 'force-syncs the server AND commits IDB for a doc with a pending delta',
  },
  {
    leaf: 'bridge.backgroundThrottle.enabled',
    offFile: 'desktop/src/main/background-throttle.test.ts',
    offTitle: 'is inert when the kill-switch is OFF: applies the OS default despite pending work',
    onFile: 'desktop/src/main/background-throttle.test.ts',
    onTitle: 'keeps timers alive (setBackgroundThrottling false) when work is pending and enabled',
  },
  {
    leaf: 'lossCapture.enabled',
    offFile: 'app/tests/integration/loss-capture-killswitch.test.ts',
    offTitle: 'OFF (lossCapture.enabled: false): the same discard records nothing',
    onFile: 'app/tests/integration/loss-capture-killswitch.test.ts',
    onTitle:
      'ON (default): a discarded edit lands a content-free checkpoint-write event in the ring',
  },
];

const DEPRECATED_PREFIX = 'Deprecated';

function isDeprecatedLeaf(dotted: string): boolean {
  const meta = getLeafFieldMeta(ConfigSchema, dotted.split('.'));
  return meta?.description?.startsWith(DEPRECATED_PREFIX) ?? false;
}

function readPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((cur, key) => {
    if (cur !== null && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      return (cur as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function enumerateKillSwitchLeaves(): string[] {
  const parsed = ConfigSchema.parse({}) as Record<string, unknown>;
  const leaves: string[] = [];
  const bridge = parsed.bridge as Record<string, unknown> | undefined;
  if (bridge) {
    for (const key of Object.keys(bridge)) {
      const sub = bridge[key] as Record<string, unknown> | undefined;
      if (sub && typeof sub.enabled === 'boolean') leaves.push(`bridge.${key}.enabled`);
    }
  }
  const lossCapture = parsed.lossCapture as Record<string, unknown> | undefined;
  if (lossCapture && typeof lossCapture.enabled === 'boolean') leaves.push('lossCapture.enabled');
  return leaves.sort();
}

function fileContainsTitle(pkgRelPath: string, title: string): boolean {
  const abs = resolve(PACKAGES, pkgRelPath);
  const src = readFileSync(abs, 'utf-8');
  return src.includes(title);
}

describe('kill-switch sweep (H12)', () => {
  test('every live kill-switch leaf is a registered mechanism (fail-closed) and no rows are stale', () => {
    const declared = enumerateKillSwitchLeaves();
    const live = declared.filter((leaf) => !isDeprecatedLeaf(leaf));
    const registered = KILL_SWITCHES.map((m) => m.leaf).sort();

    expect(declared.length).toBeGreaterThanOrEqual(7);
    expect(live.length).toBeGreaterThanOrEqual(3);

    const unregistered = live.filter((leaf) => !registered.includes(leaf));
    expect(unregistered).toEqual([]);

    const stale = registered.filter((leaf) => !declared.includes(leaf));
    expect(stale).toEqual([]);
  });

  test('a leaf marked deprecated in the schema carries no behavioral pair, and is still accepted', () => {
    const deprecated = enumerateKillSwitchLeaves().filter(isDeprecatedLeaf);
    expect(deprecated).toEqual([
      'bridge.deferGuard.enabled',
      'bridge.fixedPoint.enabled',
      'bridge.lossDetector.enabled',
      'bridge.preDrain.enabled',
    ]);

    const registered = KILL_SWITCHES.map((m) => m.leaf);
    expect(deprecated.filter((leaf) => registered.includes(leaf))).toEqual([]);

    const parsed = ConfigSchema.parse({});
    for (const leaf of deprecated) expect(readPath(parsed, leaf)).toBe(true);
  });

  test.each(KILL_SWITCHES)('$leaf is default-ON and carries an OFF + ON behavioral pair', (m) => {
    const parsed = ConfigSchema.parse({});
    expect(readPath(parsed, m.leaf)).toBe(true);

    expect(fileContainsTitle(m.offFile, m.offTitle)).toBe(true);
    expect(fileContainsTitle(m.onFile, m.onTitle)).toBe(true);
  });

  test('the sweep bites: a planted uncovered leaf and a bogus title are both caught', () => {
    const declared = enumerateKillSwitchLeaves();
    const registered = KILL_SWITCHES.map((m) => m.leaf);
    const withPlant = [...declared, 'bridge.__planted_uncovered__.enabled'];
    expect(withPlant.filter((leaf) => !registered.includes(leaf))).toContain(
      'bridge.__planted_uncovered__.enabled',
    );

    expect(
      fileContainsTitle(
        KILL_SWITCHES[0].offFile,
        '__this title does not exist in the OFF test file__',
      ),
    ).toBe(false);
  });
});
