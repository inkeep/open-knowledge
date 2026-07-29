/**
 * Composition sweep index (H13) — every shipped loss-hardening mechanism is
 * observed IN COMPOSITION (the whole drain/server/client running, effect visible
 * through a surface), not merely unit-tested in isolation. Module coverage is not
 * composition coverage.
 *
 * This index enumerates the shipped mechanisms and FAILS if any lacks a
 * registered composition row, or a row's test is missing. Each row is classified
 * by the highest ACHIEVABLE rung:
 *   - `booted-server`  — real `createServer` boot, effect observed through a
 *                        public surface (HTTP / `getServerState` / the ring on
 *                        disk), no internal guard import. The ideal.
 *   - `real-drain-rig` — the real `setupServerObservers` drain via the shared
 *                        bridge-race rig (real production code, full composition),
 *                        used where the trigger cannot be staged through a pure
 *                        public HTTP path.
 *   - `client-rig`     — the real client `ProviderPool` + a restartable server;
 *                        the client recycle path has no server-side public surface.
 *   - `desktop-unit`   — Electron main-process predicate; there is no R-server
 *                        surface for it.
 *
 * Fidelity residuals (carried per SPEC §9.5, NOT claimed as public coverage):
 *   §9.5(1) — the re-derive backstop's echo/oscillation topology and the
 *             sustained-defer exhaustion trigger are not organically reachable
 *             through a pure public HTTP path; the real-drain rig is their rung.
 *   §9.5(3) — the desktop background-throttle behavioral observable rides the
 *             REQUIRED desktop-smoke CI tier (promoted 2026-06-26), which
 *             currently contains no throttle test; only its keying predicate is
 *             merge-gated at the unit rung.
 * The named R7 row — typed content persists while the B re-derive loop is frozen
 * — is present at the real-drain rig rung.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigSchema } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
// .../packages/app/tests/integration → .../packages
const PACKAGES = resolve(HERE, '../../..');

type Rung = 'booted-server' | 'real-drain-rig' | 'client-rig' | 'desktop-unit';

interface CompositionRow {
  /** Stable mechanism key (matches SHIPPED_MECHANISMS). */
  readonly mechanism: string;
  /** Package-relative path of the composition test. */
  readonly file: string;
  /** Distinctive substring of the composition test's title. */
  readonly title: string;
  readonly rung: Rung;
  /** Required for non-`booted-server` rungs: why a pure public row is not reached. */
  readonly residual?: string;
}

/**
 * The canonical set of shipped loss-hardening mechanisms. A mechanism here with
 * no composition row (below) fails the sweep; a row for a mechanism not here is
 * stale.
 */
const SHIPPED_MECHANISMS = [
  'defer-guard',
  'defer-exhaustion',
  'loss-detector',
  'paired-intake-detect',
  'fixed-point-backstop',
  'loss-capture-ring',
  'checkpoint-restore-floor',
  'durable-replay-outbox',
  'flush-on-hide',
  'desktop-background-throttle',
  'pre-drain',
] as const;

const COMPOSITION_ROWS: readonly CompositionRow[] = [
  {
    mechanism: 'defer-guard',
    file: 'app/tests/integration/derive-timing-guard-full-flow.test.ts',
    title: 'the config-wired guard preserves an un-propagated keystroke on the real server',
    rung: 'booted-server',
  },
  {
    mechanism: 'defer-exhaustion',
    file: 'server/src/derive-timing-exhaustion.test.ts',
    title: 'sustained deferral preserves the keystroke until the guard force-resolves loudly',
    rung: 'real-drain-rig',
    residual:
      '§9.5(1): the sustained-defer exhaustion trigger is not stageable through a pure public HTTP path.',
  },
  {
    mechanism: 'loss-detector',
    file: 'app/tests/integration/bridge-loss-injection.test.ts',
    title: 'agent-write overwrite of un-propagated content trips the detector and checkpoints',
    rung: 'booted-server',
  },
  {
    // The disk-intake vector, deliberately NOT the agent-write test the
    // `loss-detector` row above already anchors: the two reporter hand-offs are
    // independently droppable, so one shared row would certify both while only
    // one is observed.
    mechanism: 'paired-intake-detect',
    file: 'app/tests/integration/bridge-loss-injection.test.ts',
    title: 'an out-of-band disk edit over un-propagated content trips the detector and checkpoints',
    rung: 'booted-server',
  },
  {
    mechanism: 'fixed-point-backstop',
    file: 'server/src/derive-fixed-point-backstop.test.ts',
    title:
      'typing during a freeze persists — the user-edit path and Y.Text stay live while the B loop is frozen',
    rung: 'real-drain-rig',
    residual:
      '§9.5(1): the backstop echo/oscillation topology is not reachable at the public rung; the real production drain is its rung.',
  },
  {
    mechanism: 'loss-capture-ring',
    file: 'app/tests/integration/loss-capture-killswitch.test.ts',
    title: 'ON (default): a defer lands a content-free guard-defer event in the ring',
    rung: 'booted-server',
  },
  {
    mechanism: 'checkpoint-restore-floor',
    file: 'app/tests/integration/silent-checkpoint-restore.test.ts',
    title: 'a silent extension-less checkpoint surfaces in history, reads back, and restores',
    rung: 'booted-server',
  },
  {
    mechanism: 'durable-replay-outbox',
    file: 'app/tests/integration/replay-outbox-durable.test.ts',
    title:
      'unsynced edit survives the same-tab recycle and its durable outbox is written then consumed',
    rung: 'client-rig',
    residual:
      'The client ProviderPool recycle path has no server-side public surface; the composition rung is the real client pool + a restartable server.',
  },
  {
    mechanism: 'flush-on-hide',
    file: 'app/tests/integration/editor-lifecycle-flush.test.ts',
    title: 'force-sync flush lands a pending delta on the SERVER (IDB-only would not)',
    rung: 'booted-server',
  },
  {
    mechanism: 'desktop-background-throttle',
    file: 'desktop/src/main/background-throttle.test.ts',
    title: 'keeps timers alive (setBackgroundThrottling false) when work is pending and enabled',
    rung: 'desktop-unit',
    residual:
      '§9.5(3): Electron main-process mechanism — the behavioral observable rides the required desktop-smoke CI tier, which contains no throttle test today; only the keying predicate is merge-gated here.',
  },
  {
    mechanism: 'pre-drain',
    file: 'app/tests/integration/pre-drain-composition.test.ts',
    title: 'cross-block keystroke survives a paired derive while a client reconnects and resyncs',
    rung: 'booted-server',
  },
];

/**
 * Every kill-switch this project ships, read off the PRODUCTION config schema
 * at runtime rather than restated here, mapped to the mechanism it gates.
 *
 * `SHIPPED_MECHANISMS` and `COMPOSITION_ROWS` are both hand-maintained, so
 * comparing them only against each other cannot notice a mechanism left out of
 * BOTH. This is the external anchor: adding a kill-switch to `ConfigSchema`
 * without registering its mechanism here fails the sweep. The four mechanisms
 * with no kill-switch (`defer-exhaustion` is a bound inside the defer guard;
 * `paired-intake-detect` rides the loss detector's classification registry;
 * `checkpoint-restore-floor` and `durable-replay-outbox` are unconditional
 * recovery floors) are necessarily absent from this map.
 */
const KILL_SWITCH_MECHANISM: Readonly<Record<string, string>> = {
  lossCapture: 'loss-capture-ring',
  'bridge.backgroundThrottle': 'desktop-background-throttle',
  'bridge.deferGuard': 'defer-guard',
  'bridge.lossDetector': 'loss-detector',
  'bridge.fixedPoint': 'fixed-point-backstop',
  'bridge.preDrain': 'pre-drain',
  'bridge.flushOnHide': 'flush-on-hide',
};

interface ZodLike {
  shape?: Record<string, ZodLike>;
  def?: { innerType?: ZodLike };
}

/** Unwrap `.default()` / `.optional()` wrappers to reach the object's shape. */
function objectShape(node: ZodLike | undefined): Record<string, ZodLike> | undefined {
  let cur = node;
  for (let i = 0; cur && i < 8; i++) {
    if (cur.shape) return cur.shape;
    cur = cur.def?.innerType;
  }
  return undefined;
}

/**
 * Kill-switch paths declared in the schema SHAPE.
 *
 * Deliberately not `ConfigSchema.parse({})`: the `bridge` node carries a
 * hand-written `.default({...})` literal, so parsing an empty config returns
 * that literal's keys and a newly declared switch missing from it would slip
 * through. The shape is the declaration itself.
 */
function shippedKillSwitchPaths(): string[] {
  const root = objectShape(ConfigSchema as unknown as ZodLike) ?? {};
  const paths: string[] = [];
  if (root.lossCapture) paths.push('lossCapture');
  for (const key of Object.keys(objectShape(root.bridge) ?? {})) paths.push(`bridge.${key}`);
  return paths.sort();
}

/** Mechanisms in `shipped` with no row in `rows`. The sweep's actual predicate. */
function uncoveredMechanisms(
  shipped: readonly string[],
  rows: readonly { readonly mechanism: string }[],
): string[] {
  const covered = new Set(rows.map((r) => r.mechanism));
  return shipped.filter((m) => !covered.has(m));
}

/** Rows naming a mechanism that is no longer shipped. */
function staleRows(
  shipped: readonly string[],
  rows: readonly { readonly mechanism: string }[],
): string[] {
  const live = new Set(shipped);
  return rows.map((r) => r.mechanism).filter((m) => !live.has(m));
}

interface ResolvedCompositionTest {
  /** A `test(...)`/`it(...)` declaration whose title contains the substring. */
  declared: boolean;
  /** That declaration carries a `.skip` / `.todo` / `.fails` modifier. */
  disabled: boolean;
  /** `expect(` calls between the declaration and the next one — a live body. */
  assertions: number;
}

/** Drop comment lines so a title quoted in a docblock never satisfies a row. */
function stripCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*/'));
    })
    .join('\n');
}

/**
 * Resolve a row's title to a real, ENABLED, non-empty test declaration.
 *
 * A raw `source.includes(title)` is satisfied by the title appearing anywhere —
 * in a docblock, in a `test.skip(...)`, or above a body that has been gutted —
 * so a registered composition test could be switched off and the index would
 * still certify it.
 */
function resolveCompositionTest(pkgRelPath: string, title: string): ResolvedCompositionTest {
  const src = stripCommentLines(readFileSync(resolve(PACKAGES, pkgRelPath), 'utf-8'));
  const decl = /(?<![.\w])(?:test|it)((?:\.\w+)*)\s*\(\s*(['"`])([\s\S]*?)\2/g;
  const declarations: Array<{ modifiers: string; title: string; end: number }> = [];
  for (const m of src.matchAll(decl)) {
    declarations.push({
      modifiers: m[1] ?? '',
      title: (m[3] ?? '').replace(/\s+/g, ' ').trim(),
      end: (m.index ?? 0) + m[0].length,
    });
  }
  const needle = title.replace(/\s+/g, ' ').trim();
  const hitIndex = declarations.findIndex((d) => d.title.includes(needle));
  if (hitIndex === -1) return { declared: false, disabled: false, assertions: 0 };
  const hit = declarations[hitIndex] as (typeof declarations)[number];
  const next = declarations[hitIndex + 1];
  const body = src.slice(hit.end, next ? next.end : src.length);
  return {
    declared: true,
    disabled: /\.(skip|todo|fails|skipIf)\b/.test(hit.modifiers),
    assertions: (body.match(/\bexpect\s*\(/g) ?? []).length,
  };
}

describe('composition sweep index (H13)', () => {
  test('every shipped mechanism has a composition row (fail-closed) and no rows are stale', () => {
    const shipped = [...SHIPPED_MECHANISMS].sort();
    expect(uncoveredMechanisms(shipped, COMPOSITION_ROWS)).toEqual([]);
    expect(staleRows(shipped, COMPOSITION_ROWS)).toEqual([]);
  });

  /**
   * The external anchor. Both literals above are hand-maintained IN THIS FILE,
   * so on their own they cannot notice a mechanism omitted from both. The
   * production config schema enumerates every kill-switch independently.
   *
   */
  test('every kill-switch in the production config schema maps to a covered mechanism', () => {
    const paths = shippedKillSwitchPaths();
    // Guard-the-guard: the schema read must actually find the switches.
    expect(paths.length).toBeGreaterThanOrEqual(7);

    const unregistered = paths.filter((p) => KILL_SWITCH_MECHANISM[p] === undefined);
    expect(unregistered).toEqual([]);

    const mechanisms = paths.map((p) => KILL_SWITCH_MECHANISM[p] as string);
    // Each gated mechanism is a shipped mechanism...
    expect(mechanisms.filter((m) => !SHIPPED_MECHANISMS.includes(m as never))).toEqual([]);
    // ...and carries a composition row.
    expect(uncoveredMechanisms(mechanisms, COMPOSITION_ROWS)).toEqual([]);

    // No mapping survives its switch being removed from the schema.
    const live = new Set(paths);
    expect(Object.keys(KILL_SWITCH_MECHANISM).filter((p) => !live.has(p))).toEqual([]);
  });

  test.each(COMPOSITION_ROWS)('$mechanism ($rung) has a registered composition test', (row) => {
    const resolved = resolveCompositionTest(row.file, row.title);
    // The title resolves to a real test declaration, that declaration is not
    // switched off, and its body still asserts something. A substring match
    // alone certifies a skipped or gutted test just as happily.
    expect(resolved.declared).toBe(true);
    expect(resolved.disabled).toBe(false);
    expect(resolved.assertions).toBeGreaterThan(0);
    // Every non-public rung must justify why a pure public-surface row is not
    // reached — the honest carry, never a silent gap.
    if (row.rung !== 'booted-server') {
      expect(row.residual && row.residual.length > 0).toBe(true);
    }
  });

  test('the typing-during-freeze-persists row is present', () => {
    const freeze = COMPOSITION_ROWS.find((r) => r.mechanism === 'fixed-point-backstop');
    expect(freeze).toBeDefined();
    if (!freeze) return;
    expect(freeze.title).toContain('typing during a freeze persists');
    const resolved = resolveCompositionTest(freeze.file, freeze.title);
    expect(resolved.declared).toBe(true);
    expect(resolved.disabled).toBe(false);
    expect(resolved.assertions).toBeGreaterThan(0);
  });

  test('the sweep bites: an uncovered mechanism, a stale row, a bogus title, and a disabled test', () => {
    // Drive the SAME predicates the real cases call, not inline restatements of
    // them — a defect in the real filter has to be visible to its own check.
    const withNewMechanism = [...SHIPPED_MECHANISMS, '__planted_uncovered_mechanism__'];
    expect(uncoveredMechanisms(withNewMechanism, COMPOSITION_ROWS)).toEqual([
      '__planted_uncovered_mechanism__',
    ]);
    expect(
      staleRows(SHIPPED_MECHANISMS, [...COMPOSITION_ROWS, { mechanism: '__planted_stale_row__' }]),
    ).toEqual(['__planted_stale_row__']);

    const firstRow = COMPOSITION_ROWS[0] as (typeof COMPOSITION_ROWS)[number];
    expect(
      resolveCompositionTest(firstRow.file, '__this composition title does not exist__').declared,
    ).toBe(false);

    // And the resolver's own discriminators, against this file's fixtures below.
    const self = 'app/tests/integration/composition-sweep-index.test.ts';
    expect(resolveCompositionTest(self, 'planted disabled composition fixture')).toMatchObject({
      declared: true,
      disabled: true,
    });
    expect(
      resolveCompositionTest(self, 'planted assertion-free composition fixture'),
    ).toMatchObject({ declared: true, disabled: false, assertions: 0 });
  });

  // Fixtures for the resolver's discriminators above. A registered composition
  // test that is switched off, or whose body has been gutted, must not read as
  // covered — these two prove the resolver can tell.
  /**
   * above reads back statically, to prove the resolver reports a `.skip`ped
   * composition test as disabled rather than covered. Running it would defeat
   * its only purpose.
   */
  test.skip('planted disabled composition fixture', () => {
    expect(true).toBe(true);
  });
  /**
   * Deliberately assertion-free — the sweep above reads it back statically to
   * prove a gutted body does not read as covered.
   *
   */
  test('planted assertion-free composition fixture', () => {
    return;
  });
});
