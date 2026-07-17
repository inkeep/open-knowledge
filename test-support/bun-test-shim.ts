/**
 * `bun:test` compatibility shim for Vitest 4.
 *
 * Aliased in the shared vitest base config (`resolve.alias['bun:test']` -> this
 * file), so every `import { ... } from 'bun:test'` resolves here unchanged while
 * packages are migrated. Re-exports the exact surface Open Knowledge's suites
 * import from `bun:test` (the 14 symbols across all packages: the hooks +
 * `expect`/`describe`/`test`/`it`, plus `spyOn`, `mock`, `jest`, `vi`, the
 * `Mock` type, and `setDefaultTimeout`), mapping each to its Vitest equivalent.
 *
 * Known behavioral divergences the mapping cannot hide:
 *  - `mock.module(path, factory)`: bun patches the module registry AND retro-
 *    patches live bindings of already-imported modules. The `vi.doMock` facade
 *    below only affects modules imported AFTER the call via dynamic `import()`;
 *    static imports already evaluated keep their real bindings. Files relying on
 *    retro-patching are rewritten to the mock-then-dynamic-import pattern during
 *    their package's flip.
 *  - `vi.doMock` resolves the mocked specifier against the CALLING module, which
 *    through this shim is the shim file rather than the test. For relative
 *    specifiers the facade absolutizes the path against the real caller (derived
 *    from the stack) before delegating. For BARE package specifiers it registers
 *    the mock against the calling test module directly (see `mockBareSpecifier`)
 *    so the specifier resolves through the same Vite base the system-under-test
 *    uses — under pnpm's isolated node_modules a package can otherwise resolve to
 *    a different physical copy from the shim's location (a root hard-copy) than
 *    from the test's package (the `.pnpm` store copy), and the two keys never
 *    match.
 *
 * Future work (tracked, not optional): codemod the suite off this shim — rewrite
 * `from 'bun:test'` imports to `from 'vitest'` and `Bun.*` calls to their Node
 * equivalents — then delete both shims. This shim leans on a Vitest-internal
 * mocker (`globalThis.__vitest_mocker__`), so run the codemod BEFORE the next
 * Vitest major bump; each major is a chance for that internal to move, and the
 * canary in the self-test is the trip-wire that forces the decision.
 */
import fs from 'node:fs';
import { vi, it as viIt, test as viTest } from 'vitest';

export type { Mock } from 'vitest';
export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  vi,
} from 'vitest';

/**
 * bun:test exposes `test.if(cond)` / `it.if(cond)` — register the case only when
 * `cond` is truthy. Vitest spells the same conditional `runIf`, so add an `.if`
 * alias to the re-exported callables. Suites typecheck against bun-types (which
 * declares `.if`), so only the runtime value is missing. Additive and idempotent
 * on Vitest's shared test/it singleton.
 */
for (const target of [viTest, viIt]) {
  const t = target as unknown as {
    if?: (c: unknown) => unknown;
    runIf: (c: unknown) => unknown;
  };
  if (typeof t.if !== 'function') t.if = (c: unknown) => t.runIf(Boolean(c));
}

export { viIt as it, viTest as test };

export const spyOn: typeof vi.spyOn = vi.spyOn.bind(vi);

/**
 * bun:test's `setSystemTime(date?)` mocks only the wall clock (Date.now / new
 * Date), leaving timers real. Map it to Vitest fake timers scoped to `Date` so
 * the suites' time-travel assertions (e.g. pending-intent expiry) behave the
 * same; a no-arg call restores the real clock, matching bun's reset semantics.
 */
export function setSystemTime(now?: Date | number): void {
  if (now === undefined) {
    vi.useRealTimers();
    return;
  }
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
}

type AnyFn = (...args: unknown[]) => unknown;

/** The first stack frame outside this shim = the test module that called us. */
function callerFile(): string | undefined {
  const stack = new Error().stack ?? '';
  for (const line of stack.split('\n').slice(1)) {
    const match = line.match(/(?:file:\/\/)?(\/[^\s()]+?):\d+:\d+/);
    // Skip frames inside the shim module itself (but NOT the shim's own
    // self-test, whose path ends `bun-test-shim.test.ts`).
    if (match?.[1] && !match[1].endsWith('bun-test-shim.ts')) return match[1];
  }
  return undefined;
}

function absolutize(specifier: string): string {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return specifier;
  const caller = callerFile();
  if (!caller) {
    // Without the caller we cannot absolutize; the unresolved relative
    // specifier gets keyed against this shim, so the mock silently misses the
    // test's dynamic import. Surface it rather than fail a downstream assertion
    // with no trace back to the resolution gap.
    console.warn(
      `[bun-test-shim] mock.module('${specifier}'): caller file unresolved; mock may not apply`,
    );
    return specifier;
  }
  const base = new URL(specifier, `file://${caller}`).pathname;
  // vitest keys the module registry by the fully-resolved path (with
  // extension); a bare `./foo` would not match the `./foo.ts` the subsequent
  // dynamic import resolves to, so probe the real on-disk file.
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* candidate does not exist — try the next extension */
    }
  }
  return base;
}

/**
 * Vitest's mocker instance for this environment (the same object the injected
 * `vi.mock`/`vi.doMock` compiler hints talk to). `queueMock(rawId, importer,
 * factory)` registers a mock resolving `rawId` against `importer`; going through
 * it lets us set the importer to the test module rather than this shim.
 */
interface VitestMocker {
  queueMock: (rawId: string, importer: string, factory: () => unknown) => void;
}
function getMocker(): VitestMocker | undefined {
  return (globalThis as { __vitest_mocker__?: VitestMocker }).__vitest_mocker__;
}

/** A relative specifier is resolved on-disk against the caller (see absolutize). */
function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Register a bare-package mock against the calling test module. `vi.doMock` keys
 * the mock relative to whoever calls it — here always this shim — so under
 * pnpm's isolated node_modules the shim can resolve a package to a different
 * physical copy than the test's own package does, and the mock silently misses
 * the SUT's dynamic `import('<pkg>')`. Resolving against the test module (the
 * importer Vitest would use had the test called `vi.doMock` directly) keys the
 * mock through the exact Vite resolver base the SUT imports through, so aliases
 * and export conditions stay identical on both sides. Falls back to `vi.doMock`
 * if the internal mocker is unavailable, preserving prior behavior.
 */
function mockBareSpecifier(path: string, factory: () => unknown): void {
  const mocker = getMocker();
  const importer = callerFile();
  if (mocker && importer) {
    mocker.queueMock(path, importer, () => factory());
    return;
  }
  // Degraded path: the internal mocker or the caller frame is unavailable, so
  // the mock keys against this shim instead of the test module — under pnpm's
  // isolated node_modules that can resolve to a different physical copy and
  // silently miss the SUT's import. Observable so the gap is diagnosable.
  console.warn(
    `[bun-test-shim] mock.module('${path}'): ${mocker ? 'caller file' : 'vitest mocker'} unavailable; falling back to vi.doMock (mock may miss under pnpm)`,
  );
  vi.doMock(path, factory as () => Promise<unknown>);
}

const mockFn = ((fn?: AnyFn) => vi.fn(fn)) as ((fn?: AnyFn) => ReturnType<typeof vi.fn>) & {
  module: (path: string, factory: () => unknown) => void;
  restore: () => void;
  clearAllMocks: () => void;
};

mockFn.module = (path: string, factory: () => unknown) => {
  if (isRelative(path)) {
    vi.doMock(absolutize(path), factory as () => Promise<unknown>);
    return;
  }
  mockBareSpecifier(path, factory);
};
mockFn.restore = () => {
  vi.restoreAllMocks();
};
mockFn.clearAllMocks = () => {
  vi.clearAllMocks();
};

export const mock = mockFn;

/**
 * bun's `setDefaultTimeout` raises the default budget for both tests and hooks;
 * `vi.setConfig` is the Vitest equivalent that governs the rest of the file.
 */
export function setDefaultTimeout(ms: number): void {
  vi.setConfig({ testTimeout: ms, hookTimeout: ms });
}

export const jest = {
  fn: vi.fn.bind(vi),
  spyOn: vi.spyOn.bind(vi),
  restoreAllMocks: () => vi.restoreAllMocks(),
  clearAllMocks: () => vi.clearAllMocks(),
  useFakeTimers: () => vi.useFakeTimers(),
  useRealTimers: () => vi.useRealTimers(),
  advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
  advanceTimersByTimeAsync: (ms: number) => vi.advanceTimersByTimeAsync(ms),
  runAllTimers: () => vi.runAllTimers(),
  runAllTimersAsync: () => vi.runAllTimersAsync(),
  runOnlyPendingTimers: () => vi.runOnlyPendingTimers(),
  runOnlyPendingTimersAsync: () => vi.runOnlyPendingTimersAsync(),
  advanceTimersToNextTimer: () => vi.advanceTimersToNextTimer(),
  clearAllTimers: () => vi.clearAllTimers(),
  getTimerCount: () => vi.getTimerCount(),
  setSystemTime: (time?: number | Date) => vi.setSystemTime(time),
  getRealSystemTime: () => vi.getRealSystemTime(),
};
