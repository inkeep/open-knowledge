import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  type PtyHostOutgoingMessage,
  type PtyProcessLike,
  setupPtyHost,
} from '../../src/utility/pty-host.ts';

/**
 * Filesystem contract for the PRODUCTION support-file writer.
 *
 * The sibling suite (`pty-host.test.ts`) always injects `materializeSupportFile`,
 * so the default that ships — the one that actually calls `mkdir` and `write` —
 * is never exercised there. These tests deliberately leave the dep uninjected
 * and run against a real temp tree with real symlinks, because the property
 * under test (the resolved write location stays inside the project) is only
 * observable through the filesystem.
 *
 * `platform: 'win32'` is the logical launch platform the host is told to compose
 * for — the escape it must refuse is a Windows Git checkout with symlink support
 * — while the filesystem operations run natively on the host runner. Directory
 * junctions, which only exist on Windows, resolve through `realpath` exactly as
 * these directory symlinks do, so the segment walk covers them by construction.
 */

const SUPPORT_RELATIVE_PATH = '.ok/local/terminal/claude-settings-mcp-tools.json';
const REGISTRY_CONTENTS = '{"enabledMcpjsonServers":["open-knowledge"]}';

function makeInertPty(): PtyProcessLike {
  return {
    pid: 4242,
    onData() {},
    onExit() {},
    write() {},
    resize() {},
    kill() {},
    pause() {},
    resume() {},
  };
}

interface WriterHarness {
  spawnArgs: string[] | string | undefined;
  posted: PtyHostOutgoingMessage[];
  warnings: Record<string, unknown>[];
}

/** Drive one `create` through the host with the production writer in place. */
function materialize(cwd: string, relativePath = SUPPORT_RELATIVE_PATH): WriterHarness {
  let handler: ((event: { data: unknown }) => void) | null = null;
  const posted: PtyHostOutgoingMessage[] = [];
  const warnings: Record<string, unknown>[] = [];
  const spawnCalls: Array<string[] | string> = [];
  setupPtyHost({
    parentPort: {
      on(_event, h) {
        handler = h;
      },
      postMessage(value) {
        posted.push(value);
      },
    },
    spawn: (_file, args) => {
      spawnCalls.push(args);
      return makeInertPty();
    },
    env: { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    platform: 'win32',
    shellExists: () => false,
    pathProbe: () => null,
    listDirectory: () => [],
    logger: { warn: (o) => warnings.push(o), info: () => {} },
    // `materializeSupportFile` intentionally omitted — that is the subject.
  });
  handler?.({
    data: {
      type: 'create',
      ptyId: 'p1',
      cwd,
      cols: 80,
      rows: 24,
      launchCommand: {
        executable: 'claude',
        args: ['--settings', relativePath],
        supportFile: { kind: 'claude-settings', relativePath, contents: REGISTRY_CONTENTS },
      },
    },
  });
  return { spawnArgs: spawnCalls[0], posted, warnings };
}

let root: string;
let project: string;
let outside: string;

beforeEach(() => {
  // realpath the temp root: on macOS `/var` is a symlink to `/private/var`, so
  // an un-resolved root would make every containment assertion vacuous.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-support-file-')));
  project = join(root, 'project');
  outside = join(root, 'outside');
  mkdirSync(project, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The degradation the writer must fall through to when it refuses. */
function expectBareClaudeLaunch(h: WriterHarness): void {
  expect(h.posted.filter((m) => m.type === 'spawn-error')).toHaveLength(0);
  expect(h.spawnArgs).toBe('/K claude');
  expect(h.warnings.some((w) => w.event === 'pty-host-support-file-materialize-failed')).toBe(true);
}

function expectContainmentRefusal(h: WriterHarness): void {
  expectBareClaudeLaunch(h);
  expect(h.warnings).toContainEqual(
    expect.objectContaining({
      event: 'pty-host-support-file-materialize-failed',
      code: 'ERR_TERMINAL_SUPPORT_FILE_ESCAPE',
    }),
  );
  expect(h.posted).toContainEqual({
    type: 'shell-notice',
    ptyId: 'p1',
    notice: 'support-file-degraded',
    reason: 'containment-refused',
  });
}

function expectWriteFailure(h: WriterHarness): void {
  expectBareClaudeLaunch(h);
  expect(h.posted).toContainEqual({
    type: 'shell-notice',
    ptyId: 'p1',
    notice: 'support-file-degraded',
    reason: 'write-failed',
  });
}

describe('production support-file writer', () => {
  test('creates the settings file when nothing exists yet', () => {
    const h = materialize(project);

    const target = join(project, '.ok', 'local', 'terminal', 'claude-settings-mcp-tools.json');
    expect(readFileSync(target, 'utf8')).toBe(REGISTRY_CONTENTS);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(h.spawnArgs).toBe(`/K claude --settings ${SUPPORT_RELATIVE_PATH}`);
    expect(h.warnings.some((w) => w.event === 'pty-host-support-file-materialize-failed')).toBe(
      false,
    );
  });

  test('overwrites an existing regular settings file in place', () => {
    const dir = join(project, '.ok', 'local', 'terminal');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'claude-settings-mcp-tools.json'), '{"stale":true}');

    const h = materialize(project);

    expect(readFileSync(join(dir, 'claude-settings-mcp-tools.json'), 'utf8')).toBe(
      REGISTRY_CONTENTS,
    );
    expect(h.spawnArgs).toBe(`/K claude --settings ${SUPPORT_RELATIVE_PATH}`);
  });

  test('refuses when the terminal settings directory is a symlink out of the project', () => {
    const attackerDir = join(outside, 'attacker-dir');
    mkdirSync(attackerDir, { recursive: true });
    mkdirSync(join(project, '.ok', 'local'), { recursive: true });
    symlinkSync(attackerDir, join(project, '.ok', 'local', 'terminal'), 'dir');

    const h = materialize(project);

    expect(existsSync(join(attackerDir, 'claude-settings-mcp-tools.json'))).toBe(false);
    expectContainmentRefusal(h);
  });

  test('refuses when an ancestor segment is a symlink out of the project', () => {
    const attackerDir = join(outside, 'attacker-ok');
    mkdirSync(attackerDir, { recursive: true });
    symlinkSync(attackerDir, join(project, '.ok'), 'dir');

    const h = materialize(project);

    expect(existsSync(join(attackerDir, 'local'))).toBe(false);
    expectContainmentRefusal(h);
  });

  test('refuses to follow a leaf symlink onto an external file', () => {
    const victim = join(outside, 'victim.json');
    writeFileSync(victim, '{"user":"important"}');
    const dir = join(project, '.ok', 'local', 'terminal');
    mkdirSync(dir, { recursive: true });
    symlinkSync(victim, join(dir, 'claude-settings-mcp-tools.json'));

    const h = materialize(project);

    expect(readFileSync(victim, 'utf8')).toBe('{"user":"important"}');
    expectContainmentRefusal(h);
  });

  test('refuses a dangling leaf symlink rather than creating its target', () => {
    const victim = join(outside, 'not-yet-there.json');
    const dir = join(project, '.ok', 'local', 'terminal');
    mkdirSync(dir, { recursive: true });
    symlinkSync(victim, join(dir, 'claude-settings-mcp-tools.json'));

    const h = materialize(project);

    expect(existsSync(victim)).toBe(false);
    expectContainmentRefusal(h);
  });

  test('refuses a leaf symlink that stays inside the project', () => {
    // Even a contained symlink is refused: the writer owns this path outright,
    // so a link there is not a shape it authored and following it would let a
    // later re-point of the link redirect the next write.
    const inside = join(project, 'decoy.json');
    writeFileSync(inside, '{"inside":true}');
    const dir = join(project, '.ok', 'local', 'terminal');
    mkdirSync(dir, { recursive: true });
    symlinkSync(inside, join(dir, 'claude-settings-mcp-tools.json'));

    const h = materialize(project);

    expect(readFileSync(inside, 'utf8')).toBe('{"inside":true}');
    expectContainmentRefusal(h);
  });

  test('classifies a dangling directory symlink as a containment refusal', () => {
    mkdirSync(join(project, '.ok', 'local'), { recursive: true });
    symlinkSync(join(outside, 'missing'), join(project, '.ok', 'local', 'terminal'), 'dir');

    expectContainmentRefusal(materialize(project));
  });

  test('classifies a directory symlink cycle as a containment refusal', () => {
    mkdirSync(join(project, '.ok', 'local'), { recursive: true });
    const terminal = join(project, '.ok', 'local', 'terminal');
    symlinkSync(terminal, terminal, 'dir');

    expectContainmentRefusal(materialize(project));
  });

  test.skipIf(process.platform === 'win32')(
    'keeps a permission failure distinct from a containment refusal',
    () => {
      const locked = join(outside, 'locked');
      const target = join(locked, 'target');
      mkdirSync(target, { recursive: true });
      symlinkSync(target, join(project, '.ok'), 'dir');
      chmodSync(locked, 0o000);
      try {
        expectWriteFailure(materialize(project));
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  test('refuses when the project cwd itself does not resolve', () => {
    const h = materialize(join(root, 'no-such-project'));

    expectBareClaudeLaunch(h);
  });
});
