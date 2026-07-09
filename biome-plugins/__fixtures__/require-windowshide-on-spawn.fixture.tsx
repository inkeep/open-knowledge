// FIXTURE — drives `require-windowshide-on-spawn.test.ts` via shell-out to
// `bunx biome check`. Not part of the main lint (override scope keeps the rule
// off this fixture's path under normal `bun run lint`; the test explicitly
// invokes biome on this file path via the fixture self-include in the
// override's `includes[]`).
//
// 7 expected diagnostic fires (one per spawn that hides neither via
// `windowsHide: true` nor `withHiddenWindowsConsole(...)`):
//   P1 spawn, no options            P5 execSync, options w/o hide
//   P2 spawnSync, options w/o hide  P6 nodeSpawn, options w/o hide
//   P3 execFile, callback no opts   P7 execFileAsync, options w/o hide
//   P4 execFileSync, options w/o hide
//
// Negatives (0 fires): inline `windowsHide: true`, the `withHiddenWindowsConsole`
// helper (both the options-wrapping and the no-options `({})` forms), a member
// call (`deps.spawn` — different AST), a differently-named helper, and bare
// `exec` (intentionally outside the matcher). Exact-equality (`toBe(7)`)
// catches false-negative regressions (< 7) and false-positive widenings (> 7).

type Opts = Record<string, unknown>;
type Cb = (err: unknown) => void;
declare function spawn(cmd: string, args: string[], opts?: Opts): unknown;
declare function spawnSync(cmd: string, args: string[], opts?: Opts): unknown;
declare function exec(cmd: string, opts?: Opts): unknown;
declare function execSync(cmd: string, opts?: Opts): unknown;
declare function execFile(cmd: string, args: string[], opts?: Opts | Cb, cb?: Cb): unknown;
declare function execFileSync(cmd: string, args: string[], opts?: Opts): unknown;
declare function nodeSpawn(cmd: string, args: string[], opts?: Opts): unknown;
declare function execFileAsync(cmd: string, args: string[], opts?: Opts): unknown;
declare function withHiddenWindowsConsole<T extends object>(o: T): T & { windowsHide: true };
declare const deps: { spawn: (cmd: string, args: string[]) => unknown };
declare function mySpawnHelper(cmd: string, args: string[]): unknown;

// === Positive cases — must fire (7 total) ===

export const p1 = spawn('git', ['status']);
export const p2 = spawnSync('git', ['status'], { cwd: '.' });
export const p3 = execFile('git', ['status'], (_e: unknown) => {});
export const p4 = execFileSync('git', ['status'], { cwd: '.' });
export const p5 = execSync('git status', { cwd: '.' });
export const p6 = nodeSpawn('git', ['status'], { stdio: 'ignore' });
export const p7 = execFileAsync('git', ['status'], { cwd: '.' });

// === Negative cases — must NOT fire ===

// (1) Inline flag.
export const n1 = spawn('git', ['status'], { windowsHide: true });
// (2-3) The withHiddenWindowsConsole helper — options-wrapping and no-options forms.
export const n2 = spawnSync('git', ['status'], withHiddenWindowsConsole({ cwd: '.' }));
export const n3 = execFile('git', ['status'], withHiddenWindowsConsole({}), (_e: unknown) => {});
// (4) Member call — different AST; the real impl behind an injected `deps.spawn`
//     is the enforced site, not the injection point.
export const n4 = deps.spawn('git', ['status']);
// (5) A differently-named helper — the rule matches literal callee identifiers.
export const n5 = mySpawnHelper('git', ['status']);
// (6) Bare `exec` — intentionally outside the matcher (documented gap).
export const n6 = exec('git status');
