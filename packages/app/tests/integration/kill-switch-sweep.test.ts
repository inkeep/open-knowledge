import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigSchema } from '@inkeep/open-knowledge-core';
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
    leaf: 'bridge.deferGuard.enabled',
    offFile: 'server/src/derive-timing-guard.test.ts',
    offTitle: 'with the guard OFF the same drain stomps the keystroke',
    onFile: 'server/src/derive-timing-guard.test.ts',
    onTitle: 'an un-propagated WYSIWYG keystroke survives a drain-shaped re-derive',
  },
  {
    leaf: 'bridge.lossDetector.enabled',
    offFile: 'server/src/bridge-loss-detector.test.ts',
    offTitle: 'does not trip when the loss-detector kill-switch is off',
    onFile: 'server/src/bridge-loss-detector.test.ts',
    onTitle: 'checkpoints + emits a detector-trip when an apply arm drops content',
  },
  {
    leaf: 'bridge.fixedPoint.enabled',
    offFile: 'server/src/derive-fixed-point-backstop.test.ts',
    offTitle: 'kill-switch OFF: the loop churns unbounded with no trip; default-ON pinned',
    onFile: 'server/src/derive-fixed-point-backstop.test.ts',
    onTitle:
      'a normalize-equal-but-byte-different loop is not treated as converged and trips the backstop loudly',
  },
  {
    leaf: 'bridge.preDrain.enabled',
    offFile: 'server/src/derive-pre-drain.test.ts',
    offTitle: 'kill-switch OFF: the cross-block keystroke is NOT flushed (left for the floor)',
    onFile: 'server/src/derive-pre-drain.test.ts',
    onTitle:
      'CROSS-BLOCK undo: the pending keystroke survives in Y.Text and the re-derived fragment',
  },
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
    offTitle:
      'OFF (lossCapture.enabled: false): the guard still defers but the ring records nothing',
    onFile: 'app/tests/integration/loss-capture-killswitch.test.ts',
    onTitle: 'ON (default): a defer lands a content-free guard-defer event in the ring',
  },
];

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
  test('every kill-switch leaf in the schema is a registered mechanism (fail-closed) and no rows are stale', () => {
    const declared = enumerateKillSwitchLeaves();
    const registered = KILL_SWITCHES.map((m) => m.leaf).sort();

    expect(declared.length).toBeGreaterThanOrEqual(7);

    const unregistered = declared.filter((leaf) => !registered.includes(leaf));
    expect(unregistered).toEqual([]);

    const stale = registered.filter((leaf) => !declared.includes(leaf));
    expect(stale).toEqual([]);
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
