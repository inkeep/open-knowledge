// FIXTURE — drives `no-sentinel-signal-target.test.ts` via shell-out to
// `pnpm exec oxlint`. Not part of the main lint: `__fixtures__/` is in
// `oxlint.config.ts#ignorePatterns`; `__fixtures__/oxlint.fixtures.json`
// re-enables the rules for the test.
//
// 20 expected diagnostic fires, split by message branch:
//   literal target (10): P1 process.kill(0), P2 process.kill(1), P3 process.kill(-1),
//     P8 signalOwnedGroup(1), P9 signalOwnedPids([0, 1, -1]), P11 reapOwnedTree(1),
//     P12 signalOwnedGroup(1, …, process.kill) — a real sender passed explicitly,
//     P18 signalOwnedGroup(1, …, undefined), P19 signalOwnedGroup(1, …, void 0),
//     P20 reapOwnedTree(1, 500, undefined, undefined) — an explicit `undefined`
//     injects no sender, so it must not suppress
//   fallback target (4): P4 `pid ?? 0`, P5 `supervisor || -1`,
//     P10 signalOwnedPids([…, supervisor ?? -1]), P13 `-(pid ?? 0)`
//   parsed target (6): P6 Number(readFileSync(...)), P7 parseInt(...),
//     P14 `-Number(readFileSync(...))`, P15 Number.parseInt(...),
//     P16 Number.parseFloat(...), P17 parseFloat(...)
//
// Negatives (0 fires): the signal-0 liveness probe on pid 1 (boundary pair with
// P2), an `as number`-wrapped spawned pid, a group kill of a spawned pid
// (`-(child.pid as number)` and bare `-spawnedPid`), the ChildProcess handle, `kill` on
// a non-`process` object, the method in a type declaration, the seam with an injected
// recorder — including one threaded past an explicit `undefined` pollMs — a
// null-filtered pid list, a validated parsed pid, and `?? -1` outside a kill.
// Exact-equality (`toBe(20)` plus the per-branch counts) catches false-negative
// regressions and false-positive widenings alike.

type Signal = 'SIGKILL' | 'SIGTERM';
type SignalSender = (pid: number, signal: Signal) => void;
declare function readFileSync(path: string, encoding: 'utf8'): string;
declare function signalOwnedGroup(pid: number, signal: Signal, send?: SignalSender): boolean;
declare function signalOwnedPids(
  pids: readonly number[],
  signal: Signal,
  send?: SignalSender,
): number[];
declare function reapOwnedTree(
  rootPid: number,
  graceMs: number,
  pollMs?: number,
  send?: SignalSender,
): Promise<string>;
declare function isValidLockPid(value: unknown): value is number;
declare const pid: number | undefined;
declare const supervisor: number | null;
declare const descendant: number;
declare const spawnedPid: number;
declare const pidFile: string;
declare const raw: string;
declare const child: { pid?: number; kill(signal: Signal): boolean };
declare const killer: { kill(pid: number, signal: Signal): void };
declare const sender: { send: SignalSender };
declare const hit: { start?: number } | undefined;
declare const BODY: string;

// === Positive cases — must fire (20 total) ===

export const p1 = process.kill(0, 'SIGKILL');
export const p2 = process.kill(1, 'SIGTERM');
export const p3 = process.kill(-1, 'SIGKILL');
export const p4 = process.kill(pid ?? 0, 'SIGKILL');
export const p5 = process.kill(supervisor || -1, 'SIGKILL');
export const p6 = process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
export const p7 = process.kill(parseInt(raw, 10), 'SIGTERM');
export const p8 = signalOwnedGroup(1, 'SIGKILL');
export const p9 = signalOwnedPids([0, 1, -1], 'SIGKILL');
export const p10 = signalOwnedPids([descendant, spawnedPid, supervisor ?? -1], 'SIGKILL');
export const p11 = reapOwnedTree(1, 500);
export const p12 = signalOwnedGroup(1, 'SIGKILL', process.kill);
export const p13 = process.kill(-(pid ?? 0), 'SIGKILL');
export const p14 = process.kill(-Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
export const p15 = process.kill(Number.parseInt(raw, 10), 'SIGKILL');
export const p16 = process.kill(Number.parseFloat(raw), 'SIGTERM');
export const p17 = process.kill(parseFloat(raw), 'SIGKILL');
export const p18 = signalOwnedGroup(1, 'SIGKILL', undefined);
export const p19 = signalOwnedGroup(1, 'SIGKILL', void 0);
export const p20 = reapOwnedTree(1, 500, undefined, undefined);

// === Negative cases — must NOT fire ===

// (1) Signal 0 sends nothing — the liveness probe, even on pid 1 (boundary pair with P2).
export const n1 = process.kill(1, 0);
// (2-3) A spawned pid behind TS wrappers, singly and as its own process group.
export const n2 = process.kill(child.pid as number, 'SIGKILL');
export const n3 = process.kill(-(child.pid as number), 'SIGTERM');
// (4) The ChildProcess handle signals exactly that child.
export const n4 = child.kill('SIGKILL');
// (5) Same method name on a non-`process` object — different AST.
export const n5 = killer.kill(0, 'SIGKILL');
// (6) The method in a type declaration, not a call.
export interface Signaller {
  kill(pid: 0 | 1, signal: Signal): void;
}
// (7-8) The seam with an injected recorder — the guard test's sanctioned shape.
export const n7 = signalOwnedGroup(1, 'SIGKILL', sender.send);
export const n8 = signalOwnedPids([0, 1, -1], 'SIGKILL', sender.send);
// (9) A nullable pid filtered out instead of substituted.
export const n9 = signalOwnedPids(
  [descendant, spawnedPid, ...(supervisor === null ? [] : [supervisor])],
  'SIGKILL',
);
// (10) A parsed pid validated before it is signalled.
const parsed = Number(readFileSync(pidFile, 'utf8'));
export const n10 = isValidLockPid(parsed) ? process.kill(parsed, 'SIGKILL') : false;
// (11) `?? -1` outside a kill — an index, not a signal target.
export const n11 = BODY[hit?.start ?? -1];
// (12) The same group kill without the TS wrapper — a bare negated spawned pid.
export const n12 = process.kill(-spawnedPid, 'SIGKILL');
// (13) The seam's injected recorder threaded past an explicit `undefined` pollMs.
export const n13 = reapOwnedTree(1, 500, undefined, sender.send);
