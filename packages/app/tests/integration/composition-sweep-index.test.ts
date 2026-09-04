import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigSchema } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(HERE, '../../..');

type Rung = 'booted-server' | 'real-drain-rig' | 'client-rig' | 'desktop-unit';

interface CompositionRow {
  readonly mechanism: string;
  readonly file: string;
  readonly title: string;
  readonly rung: Rung;
  readonly residual?: string;
}

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

function objectShape(node: ZodLike | undefined): Record<string, ZodLike> | undefined {
  let cur = node;
  for (let i = 0; cur && i < 8; i++) {
    if (cur.shape) return cur.shape;
    cur = cur.def?.innerType;
  }
  return undefined;
}

function shippedKillSwitchPaths(): string[] {
  const root = objectShape(ConfigSchema as unknown as ZodLike) ?? {};
  const paths: string[] = [];
  if (root.lossCapture) paths.push('lossCapture');
  for (const key of Object.keys(objectShape(root.bridge) ?? {})) paths.push(`bridge.${key}`);
  return paths.sort();
}

function uncoveredMechanisms(
  shipped: readonly string[],
  rows: readonly { readonly mechanism: string }[],
): string[] {
  const covered = new Set(rows.map((r) => r.mechanism));
  return shipped.filter((m) => !covered.has(m));
}

function staleRows(
  shipped: readonly string[],
  rows: readonly { readonly mechanism: string }[],
): string[] {
  const live = new Set(shipped);
  return rows.map((r) => r.mechanism).filter((m) => !live.has(m));
}

interface ResolvedCompositionTest {
  declared: boolean;
  disabled: boolean;
  assertions: number;
}

function stripCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*/'));
    })
    .join('\n');
}

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

  test('every kill-switch in the production config schema maps to a covered mechanism', () => {
    const paths = shippedKillSwitchPaths();
    expect(paths.length).toBeGreaterThanOrEqual(7);

    const unregistered = paths.filter((p) => KILL_SWITCH_MECHANISM[p] === undefined);
    expect(unregistered).toEqual([]);

    const mechanisms = paths.map((p) => KILL_SWITCH_MECHANISM[p] as string);
    expect(mechanisms.filter((m) => !SHIPPED_MECHANISMS.includes(m as never))).toEqual([]);
    expect(uncoveredMechanisms(mechanisms, COMPOSITION_ROWS)).toEqual([]);

    const live = new Set(paths);
    expect(Object.keys(KILL_SWITCH_MECHANISM).filter((p) => !live.has(p))).toEqual([]);
  });

  test.each(COMPOSITION_ROWS)('$mechanism ($rung) has a registered composition test', (row) => {
    const resolved = resolveCompositionTest(row.file, row.title);
    expect(resolved.declared).toBe(true);
    expect(resolved.disabled).toBe(false);
    expect(resolved.assertions).toBeGreaterThan(0);
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

    const self = 'app/tests/integration/composition-sweep-index.test.ts';
    expect(resolveCompositionTest(self, 'planted disabled composition fixture')).toMatchObject({
      declared: true,
      disabled: true,
    });
    expect(
      resolveCompositionTest(self, 'planted assertion-free composition fixture'),
    ).toMatchObject({ declared: true, disabled: false, assertions: 0 });
  });

  test.skip('planted disabled composition fixture', () => {
    expect(true).toBe(true);
  });
  test('planted assertion-free composition fixture', () => {
    return;
  });
});
