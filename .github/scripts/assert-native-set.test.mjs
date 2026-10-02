import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  assertNativeSet,
  CLI_NATIVE_DIR,
  expectedBinaries,
  NATIVE_CONFIG_DIR,
  parsePlatforms,
  RECOVERY_SECTION,
  stagingVerdict,
} from './assert-native-set.mjs';

const OK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = fileURLToPath(new URL('./assert-native-set.mjs', import.meta.url));
const REAL_NATIVE_CONFIG = join(OK_ROOT, NATIVE_CONFIG_DIR);
const napi = JSON.parse(readFileSync(join(REAL_NATIVE_CONFIG, 'package.json'), 'utf8')).napi;
const requireFromNativeConfig = createRequire(join(REAL_NATIVE_CONFIG, 'package.json'));
const { parseTriple } = await import(
  pathToFileURL(requireFromNativeConfig.resolve('@napi-rs/cli')).href
);
const EVERY_PLATFORM = ['mac', 'windows', 'linux'];
const DARWIN_ARM64 = { platform: 'darwin', arch: 'arm64' };
const expected = (platforms) =>
  expectedBinaries({ napi, parseTriple, mode: 'platforms', platforms });
const ALL = expected(EVERY_PLATFORM);
const WINDOWS = expected(['windows']);
const LINUX = expected(['linux']);
const RUNNER = `${process.platform}-${process.arch}`;
const SINGLE_TARGET_RUNNERS = {
  'darwin-arm64': 'native-config.darwin-arm64.node',
  'darwin-x64': 'native-config.darwin-x64.node',
  'win32-arm64': 'native-config.win32-arm64-msvc.node',
  'win32-x64': 'native-config.win32-x64-msvc.node',
};
const RUNNER_BINARY = SINGLE_TARGET_RUNNERS[RUNNER];

const scratches = [];

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratches.push(dir);
  return dir;
}

function tree(binaries, { declared = napi, shipped = binaries } = {}) {
  const root = scratch('ok-native-set-');
  mkdirSync(join(root, NATIVE_CONFIG_DIR), { recursive: true });
  mkdirSync(join(root, CLI_NATIVE_DIR), { recursive: true });
  writeFileSync(join(root, NATIVE_CONFIG_DIR, 'package.json'), JSON.stringify({ napi: declared }));
  for (const name of binaries)
    writeFileSync(join(root, NATIVE_CONFIG_DIR, name), `bytes of ${name}`);
  for (const name of shipped)
    copyFileSync(join(root, NATIVE_CONFIG_DIR, name), join(root, CLI_NATIVE_DIR, name));
  return root;
}

const without = (names, ...dropped) => names.filter((name) => !dropped.includes(name));
const undeclaring = (os) => ({
  ...napi,
  targets: napi.targets.filter((target) => parseTriple(target).platform !== os),
});
const NO_WINDOWS_TARGET = `no declared napi target in ${NATIVE_CONFIG_DIR}/package.json is for windows`;

const check = (root, platforms = EVERY_PLATFORM) =>
  assertNativeSet({ root, mode: 'platforms', platforms, parseTriple });
const checkHost = (root, host = DARWIN_ARM64) =>
  assertNativeSet({ root, mode: 'host', parseTriple, host });
const verdict = (root, { serves, requires }) =>
  stagingVerdict({ root, serves, requires, parseTriple });

describe('the expected set comes from native-config’s declared napi targets', () => {
  test('every platform’s declared targets, named the way napi names them', () => {
    expect(ALL).toEqual([
      'native-config.darwin-arm64.node',
      'native-config.darwin-x64.node',
      'native-config.linux-arm64-gnu.node',
      'native-config.linux-arm64-musl.node',
      'native-config.linux-x64-gnu.node',
      'native-config.linux-x64-musl.node',
      'native-config.win32-arm64-msvc.node',
      'native-config.win32-x64-msvc.node',
    ]);
  });

  test('each release platform owns the declared targets of its operating system', () => {
    expect(expected(['mac'])).toEqual([
      'native-config.darwin-arm64.node',
      'native-config.darwin-x64.node',
    ]);
    expect(WINDOWS).toEqual([
      'native-config.win32-arm64-msvc.node',
      'native-config.win32-x64-msvc.node',
    ]);
    expect(LINUX).toEqual([
      'native-config.linux-arm64-gnu.node',
      'native-config.linux-arm64-musl.node',
      'native-config.linux-x64-gnu.node',
      'native-config.linux-x64-musl.node',
    ]);
  });

  test('host mode keeps the one declared target this runner builds', () => {
    expect(expectedBinaries({ napi, parseTriple, mode: 'host', host: DARWIN_ARM64 })).toEqual([
      'native-config.darwin-arm64.node',
    ]);
  });

  test('host mode refuses a runner that two declared targets match, as gnu and musl do on Linux', () => {
    expect(() =>
      expectedBinaries({
        napi,
        parseTriple,
        mode: 'host',
        host: { platform: 'linux', arch: 'x64' },
      }),
    ).toThrow('host mode needs exactly one declared napi target for linux-x64; found 2');
  });

  test('a newly declared target joins its platform’s set without editing any workflow', () => {
    const declared = { ...napi, targets: [...napi.targets, 'riscv64gc-unknown-linux-gnu'] };
    const { errors } = check(tree(ALL, { declared }), ['linux']);
    expect(errors).toEqual([
      `${NATIVE_CONFIG_DIR}/native-config.linux-riscv64-gnu.node is missing`,
      `${CLI_NATIVE_DIR}/native-config.linux-riscv64-gnu.node is missing`,
    ]);
  });

  test('a declared target for an operating system no release platform packages is refused', () => {
    const declared = { ...napi, targets: [...napi.targets, 'x86_64-unknown-freebsd'] };
    expect(() =>
      expectedBinaries({ napi: declared, parseTriple, mode: 'platforms', platforms: ['linux'] }),
    ).toThrow(
      'napi target x86_64-unknown-freebsd is for freebsd, which no release platform (mac, windows, linux) packages',
    );
  });

  test('a platform that owns no declared target is refused by name, not passed with zero binaries', () => {
    expect(check(tree(LINUX, { declared: undeclaring('win32') }), ['windows', 'linux'])).toEqual({
      lines: [],
      errors: [`cannot derive the expected native set: ${NO_WINDOWS_TARGET}`],
    });
    expect(check(tree(LINUX, { declared: undeclaring('win32') }), ['linux']).errors).toEqual([]);
  });

  test('a platform list names only mac, windows and linux, and none means no platform', () => {
    expect(parsePlatforms('windows,linux')).toEqual(['windows', 'linux']);
    expect(parsePlatforms('none')).toEqual([]);
    expect(() => parsePlatforms('')).toThrow('platforms needs a comma-separated list');
    expect(() => parsePlatforms('linux,toString')).toThrow('unknown platform toString');
  });
});

describe('the assertion', () => {
  test('passes an exact, non-empty, identical set and prints each file’s name, size and sha256', () => {
    const { errors, lines } = check(tree(ALL));
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(16);
    expect(lines[0]).toMatch(
      /^native-set packages\/native-config\/native-config\.darwin-arm64\.node \d+ [0-9a-f]{64}$/,
    );
  });

  test('reds when one binary is missing from what the CLI ships', () => {
    const shipped = without(ALL, 'native-config.win32-arm64-msvc.node');
    expect(check(tree(ALL, { shipped })).errors).toEqual([
      `${CLI_NATIVE_DIR}/native-config.win32-arm64-msvc.node is missing`,
    ]);
  });

  test('reds when one binary is empty', () => {
    const root = tree(ALL);
    truncateSync(join(root, CLI_NATIVE_DIR, 'native-config.linux-x64-gnu.node'), 0);
    expect(check(root).errors).toEqual([
      `${CLI_NATIVE_DIR}/native-config.linux-x64-gnu.node is empty`,
      `${CLI_NATIVE_DIR}/native-config.linux-x64-gnu.node differs from ${NATIVE_CONFIG_DIR}/native-config.linux-x64-gnu.node`,
    ]);
  });

  test('reds when the CLI ships different bytes of the same size than native-config holds', () => {
    const root = tree(ALL);
    const shipped = join(root, CLI_NATIVE_DIR, 'native-config.darwin-x64.node');
    const original = readFileSync(shipped, 'utf8');
    writeFileSync(shipped, `${original.slice(0, -1)}!`);
    expect(check(root).errors).toEqual([
      `${CLI_NATIVE_DIR}/native-config.darwin-x64.node differs from ${NATIVE_CONFIG_DIR}/native-config.darwin-x64.node`,
    ]);
  });

  test('reds on a binary no declared target names, such as one left over in the workspace', () => {
    const extra = [...ALL, 'native-config.leftover.node'];
    expect(check(tree(extra)).errors).toEqual([
      `${NATIVE_CONFIG_DIR}/native-config.leftover.node is not a declared napi target`,
      `${CLI_NATIVE_DIR}/native-config.leftover.node is not a declared napi target`,
    ]);
  });

  test('reds when a set cannot be read', () => {
    const root = tree(ALL);
    rmSync(join(root, CLI_NATIVE_DIR), { recursive: true });
    expect(check(root).errors).toEqual([
      expect.stringMatching(/^cannot read packages\/cli\/dist\/native: ENOENT/),
    ]);
  });

  test('checks only the packaged platforms’ sets, and tolerates another platform’s declared binaries', () => {
    expect(check(tree(LINUX), ['linux']).errors).toEqual([]);
    expect(check(tree(ALL), ['linux']).errors).toEqual([]);
    expect(
      check(tree(without(LINUX, 'native-config.linux-arm64-musl.node')), ['linux']).errors,
    ).toEqual([
      `${NATIVE_CONFIG_DIR}/native-config.linux-arm64-musl.node is missing`,
      `${CLI_NATIVE_DIR}/native-config.linux-arm64-musl.node is missing`,
    ]);
  });

  test('host mode reds on staged binaries a host-only build must not carry', () => {
    expect(checkHost(tree(['native-config.darwin-arm64.node'])).errors).toEqual([]);
    expect(checkHost(tree(ALL)).errors).toHaveLength(14);
  });

  test('reds when native-config declares no targets', () => {
    expect(check(tree(ALL, { declared: null })).errors).toEqual([
      `cannot derive the expected native set: ${NATIVE_CONFIG_DIR}/package.json declares no napi binaryName and targets`,
    ]);
  });

  test.skipIf(!RUNNER_BINARY)(
    'host mode with no host given reads this runner, which builds one declared target',
    () => {
      const root = tree([RUNNER_BINARY]);
      expect(assertNativeSet({ root, mode: 'host', parseTriple }).errors).toEqual([]);
    },
  );

  test.skipIf(process.platform !== 'linux')(
    'host mode with no host given refuses this Linux runner, where gnu and musl both match',
    () => {
      const root = tree(ALL);
      expect(assertNativeSet({ root, mode: 'host', parseTriple }).errors).toEqual([
        `cannot derive the expected native set: host mode needs exactly one declared napi target for ${RUNNER}; found 2`,
      ]);
    },
  );
});

describe('the staging verdict', () => {
  const staged = (names) => tree(names, { shipped: [] });

  test('a gap in a required platform refuses the cut, and a complete set packages it', () => {
    const gap = verdict(staged(without(ALL, 'native-config.win32-arm64-msvc.node')), {
      serves: ['windows', 'linux'],
      requires: EVERY_PLATFORM,
    });
    expect(gap.refusals).toEqual([
      { platform: 'windows', missing: ['native-config.win32-arm64-msvc.node'] },
    ]);
    expect(gap.drops).toEqual([]);

    const complete = verdict(staged(ALL), {
      serves: ['windows', 'linux'],
      requires: EVERY_PLATFORM,
    });
    expect(complete).toEqual({ packaged: ['windows', 'linux'], refusals: [], drops: [] });
  });

  test('a gap in a platform that is not required drops that platform, and the cut proceeds for the rest', () => {
    const gap = verdict(staged(without(ALL, 'native-config.win32-x64-msvc.node')), {
      serves: ['windows', 'linux'],
      requires: ['mac', 'linux'],
    });
    expect(gap).toEqual({
      packaged: ['linux'],
      refusals: [],
      drops: [{ platform: 'windows', missing: ['native-config.win32-x64-msvc.node'] }],
    });

    const complete = verdict(staged(ALL), {
      serves: ['windows', 'linux'],
      requires: ['mac', 'linux'],
    });
    expect(complete).toEqual({ packaged: ['windows', 'linux'], refusals: [], drops: [] });
  });

  test('a linux-only QA dispatch passes with the Linux set, and refuses when a Linux binary is missing', () => {
    const linuxOnly = { serves: ['linux'], requires: ['linux'] };
    expect(verdict(staged(LINUX), linuxOnly)).toEqual({
      packaged: ['linux'],
      refusals: [],
      drops: [],
    });
    expect(
      verdict(staged(without(LINUX, 'native-config.linux-arm64-gnu.node')), linuxOnly),
    ).toEqual({
      packaged: [],
      refusals: [{ platform: 'linux', missing: ['native-config.linux-arm64-gnu.node'] }],
      drops: [],
    });
  });

  test('an empty staged binary counts as missing', () => {
    const root = staged(LINUX);
    truncateSync(join(root, NATIVE_CONFIG_DIR, 'native-config.linux-x64-musl.node'), 0);
    expect(verdict(root, { serves: ['linux'], requires: ['linux'] }).refusals).toEqual([
      { platform: 'linux', missing: ['native-config.linux-x64-musl.node'] },
    ]);
  });

  test('a served or required platform that owns no declared target is refused by name', () => {
    expect(() =>
      verdict(staged(ALL), { serves: ['windows', 'linux'], requires: ['mac'] }),
    ).not.toThrow();
    const windowsless = tree(ALL, { declared: undeclaring('win32'), shipped: [] });
    expect(() => verdict(windowsless, { serves: ['windows', 'linux'], requires: ['mac'] })).toThrow(
      NO_WINDOWS_TARGET,
    );
    expect(() => verdict(windowsless, { serves: ['linux'], requires: ['mac', 'windows'] })).toThrow(
      NO_WINDOWS_TARGET,
    );
  });

  test('a zero-byte binary of a dropped platform fails neither the verdict nor the assertion of what it packaged', () => {
    const root = tree(ALL);
    for (const dir of [NATIVE_CONFIG_DIR, CLI_NATIVE_DIR]) {
      truncateSync(join(root, dir, 'native-config.win32-x64-msvc.node'), 0);
    }
    const { packaged, refusals, drops } = verdict(root, {
      serves: ['windows', 'linux'],
      requires: ['mac', 'linux'],
    });
    expect(refusals).toEqual([]);
    expect(drops).toEqual([
      { platform: 'windows', missing: ['native-config.win32-x64-msvc.node'] },
    ]);
    expect(packaged).toEqual(['linux']);
    expect(check(root, packaged).errors).toEqual([]);
    expect(check(root, ['windows', 'linux']).errors).toEqual([
      `${NATIVE_CONFIG_DIR}/native-config.win32-x64-msvc.node is empty`,
      `${CLI_NATIVE_DIR}/native-config.win32-x64-msvc.node is empty`,
    ]);
  });

  test('with nothing staged, required platforms refuse and the rest are dropped', () => {
    expect(verdict(staged([]), { serves: ['windows', 'linux'], requires: ['mac'] })).toEqual({
      packaged: [],
      refusals: [],
      drops: [
        { platform: 'windows', missing: WINDOWS },
        { platform: 'linux', missing: LINUX },
      ],
    });
    expect(
      verdict(staged([]), { serves: ['windows', 'linux'], requires: ['mac', 'windows'] }).refusals,
    ).toEqual([{ platform: 'windows', missing: WINDOWS }]);
  });
});

describe('as the workflow runs it', () => {
  const withParser = (root) => {
    symlinkSync(
      join(REAL_NATIVE_CONFIG, 'node_modules'),
      join(root, NATIVE_CONFIG_DIR, 'node_modules'),
    );
    return root;
  };
  const { NODE_PATH: _pnpmShimPath, ...workflowEnv } = process.env;
  const run = (root, args, { script = SCRIPT, env = {} } = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...workflowEnv, ...env },
    });
  const outputs = (root) => {
    const files = {
      GITHUB_OUTPUT: join(root, 'output'),
      GITHUB_STEP_SUMMARY: join(root, 'summary'),
    };
    for (const file of Object.values(files)) writeFileSync(file, '');
    return files;
  };
  const staged = (serves, requires) => [
    'staged',
    '--serves',
    serves,
    '--requires',
    requires,
    '--reason',
    'staged from run 1',
    '--recovery',
    `Re-run the prebuild, then resume per RELEASES.md '${RECOVERY_SECTION}'.`,
  ];

  test('exits 0 on the exact set and 1 with an error annotation on a missing binary', () => {
    const exact = run(withParser(tree(ALL)), ['platforms', 'mac,windows,linux']);
    const short = run(withParser(tree(ALL, { shipped: ALL.slice(1) })), [
      'platforms',
      'mac,windows,linux',
    ]);
    expect(exact.status).toBe(0);
    expect(exact.stdout).toContain('native-set ok: 8 binaries for mac, windows, linux present');
    expect(short.status).toBe(1);
    expect(short.stdout).toContain(`::error::native-set: ${CLI_NATIVE_DIR}/${ALL[0]} is missing`);
  });

  test('a refusal names the recovery section', () => {
    const short = run(withParser(tree(ALL, { shipped: ALL.slice(1) })), [
      'platforms',
      'mac,windows,linux',
    ]);
    expect(short.stdout).toContain(`resume per RELEASES.md '${RECOVERY_SECTION}'`);
  });

  test('still asserts when it is run through a symlinked path', () => {
    const linked = join(scratch('ok-native-set-link-'), 'scripts');
    symlinkSync(dirname(SCRIPT), linked, 'dir');
    const short = run(
      withParser(tree(ALL, { shipped: ALL.slice(1) })),
      ['platforms', 'mac,windows,linux'],
      {
        script: join(linked, 'assert-native-set.mjs'),
      },
    );
    expect(short.status).toBe(1);
    expect(short.stdout).toContain(`::error::native-set: ${CLI_NATIVE_DIR}/${ALL[0]} is missing`);
  });

  test('exits 1 when napi’s target parser cannot be loaded, instead of asserting nothing', () => {
    const result = run(tree(ALL), ['platforms', 'mac,windows,linux']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("::error::cannot load napi's target parser");
  });

  test('exits 1 on an unknown mode, or a platforms mode with no list, instead of asserting nothing', () => {
    const unknown = run(withParser(tree(ALL)), ['some']);
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toContain('mode must be one of host, platforms, staged');
    const unset = run(withParser(tree(ALL)), ['platforms', '']);
    expect(unset.status).toBe(1);
    expect(unset.stdout).toContain('platforms needs a comma-separated list');
  });

  test.skipIf(!RUNNER_BINARY)(
    'a host run through the entry point passes the binary this runner builds',
    () => {
      const result = run(withParser(tree([RUNNER_BINARY])), ['host']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('native-set ok: 1 binaries for host present');
    },
  );

  test('the staging verdict writes the packaged platforms, warns loudly on a drop and refuses a required gap', () => {
    const dropRoot = withParser(
      tree(without(ALL, 'native-config.win32-x64-msvc.node'), { shipped: [] }),
    );
    const dropFiles = outputs(dropRoot);
    const drop = run(dropRoot, staged('windows,linux', 'mac,linux'), { env: dropFiles });
    expect(drop.status).toBe(0);
    expect(drop.stdout).toContain(
      '::warning::DEGRADED CUT: windows is not a required platform, and its staged native-config set is missing native-config.win32-x64-msvc.node (staged from run 1), so windows is not packaged or shipped this cut.',
    );
    expect(readFileSync(dropFiles.GITHUB_OUTPUT, 'utf8')).toBe('platforms=linux\n');
    expect(readFileSync(dropFiles.GITHUB_STEP_SUMMARY, 'utf8')).toContain('Degraded cut: windows');

    const gapRoot = withParser(
      tree(without(ALL, 'native-config.win32-x64-msvc.node'), { shipped: [] }),
    );
    const gapFiles = outputs(gapRoot);
    const gap = run(gapRoot, staged('windows,linux', 'mac,windows,linux'), {
      env: gapFiles,
    });
    expect(gap.status).toBe(1);
    expect(gap.stdout).toContain(
      `::error::native-set: windows is a required platform, and its staged native-config set is missing native-config.win32-x64-msvc.node (staged from run 1). Re-run the prebuild, then resume per RELEASES.md '${RECOVERY_SECTION}'.`,
    );
    expect(gap.stdout).not.toContain('::warning::');
    expect(readFileSync(gapFiles.GITHUB_OUTPUT, 'utf8')).toBe('');
  });

  test('the staging verdict exits 1 naming a served platform that owns no declared target', () => {
    const root = withParser(tree(ALL, { declared: undeclaring('win32'), shipped: [] }));
    const files = outputs(root);
    const result = run(root, staged('windows,linux', 'mac'), { env: files });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`::error::native-set: ${NO_WINDOWS_TARGET}`);
    expect(readFileSync(files.GITHUB_OUTPUT, 'utf8')).toBe('');
  });

  test('the staging verdict writes none when every platform it serves is dropped', () => {
    const root = withParser(tree([], { shipped: [] }));
    const files = outputs(root);
    const result = run(root, staged('windows,linux', 'mac'), { env: files });
    expect(result.status).toBe(0);
    expect(readFileSync(files.GITHUB_OUTPUT, 'utf8')).toBe('platforms=none\n');
  });
});
