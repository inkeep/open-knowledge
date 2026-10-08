import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const guardModule = join(packageDir, 'toolchain_guard.rs');

function toolchainBinary(name) {
  const which = spawnSync('rustup', ['which', name], { cwd: packageDir, encoding: 'utf8' });
  if (which.error?.code === 'ENOENT') return name;
  assert.equal(which.status, 0, `rustup which ${name} failed: ${which.stderr}`);
  return which.stdout.trim();
}

function declaration(channel) {
  return `[toolchain]\nchannel = "${channel}"\nprofile = "minimal"\n`;
}

describe('the declared Rust toolchain guard', () => {
  let root;
  let cargo;
  let rustc;
  let release;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'native-config-toolchain-guard-'));
    cargo = toolchainBinary('cargo');
    rustc = toolchainBinary('rustc');
    const version = spawnSync(rustc, ['-vV'], { encoding: 'utf8' });
    assert.equal(version.status, 0, `${rustc} -vV failed: ${version.stderr}`);
    release = version.stdout.match(/^release: (\S+)$/m)?.[1];
    assert.match(release ?? '', /^\d+\.\d+\.\d+$/, `${rustc} is not a stable release`);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function guardedCrate(declared) {
    const workspace = mkdtempSync(join(root, 'workspace-'));
    if (declared !== null) writeFileSync(join(workspace, 'rust-toolchain.toml'), declared);
    const crate = join(workspace, 'packages', 'guarded');
    mkdirSync(join(crate, 'src'), { recursive: true });
    writeFileSync(
      join(crate, 'Cargo.toml'),
      '[package]\nname = "guarded"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[workspace]\n',
    );
    writeFileSync(join(crate, 'src', 'lib.rs'), '');
    writeFileSync(
      join(crate, 'build.rs'),
      `#[path = ${JSON.stringify(guardModule)}]\nmod toolchain_guard;\n\nfn main() {\n    toolchain_guard::require_declared_rustc();\n}\n`,
    );
    return { workspace, crate };
  }

  function build({ workspace, crate }, ...flags) {
    const result = spawnSync(
      cargo,
      [
        'build',
        '--offline',
        '--color',
        'never',
        '--target-dir',
        join(workspace, 'target'),
        ...flags,
      ],
      { cwd: crate, encoding: 'utf8', env: { ...process.env, RUSTC: rustc } },
    );
    assert.equal(result.error, undefined, `${cargo} build did not run: ${result.error}`);
    return result;
  }

  function assertRefused(result, ...reasons) {
    assert.equal(
      typeof result.status,
      'number',
      `cargo build ended without a status: ${result.signal}`,
    );
    assert.notEqual(result.status, 0, `cargo build passed:\n${result.stderr}`);
    for (const reason of reasons)
      assert.ok(
        result.stderr.includes(reason),
        `missing ${JSON.stringify(reason)} in:\n${result.stderr}`,
      );
  }

  function anotherRelease() {
    const [major, minor, patch] = release.split('.');
    return `${major}.${minor}.${Number(patch) + 1}`;
  }

  test('refuses a compiler whose release differs from the declared channel, naming both', () => {
    const other = anotherRelease();
    const result = build(guardedCrate(declaration(other)));
    assertRefused(result, `rustc ${release} is not the declared Rust release ${other}`);
  });

  test('builds when the declared channel is the compiler release, and asks cargo to re-check', () => {
    const result = build(guardedCrate(declaration(release)), '-vv');
    assert.equal(result.status, 0, result.stderr);
    const directives = `${result.stdout}${result.stderr}`.split('\n').flatMap((line) => {
      const at = line.indexOf('cargo:');
      return at === -1 ? [] : [line.slice(at).trimEnd()];
    });
    assert.equal(
      directives.filter((directive) =>
        /^cargo:rerun-if-changed=.*rust-toolchain\.toml$/.test(directive),
      ).length,
      1,
      directives.join('\n'),
    );
    assert.ok(
      directives.includes('cargo:rerun-if-env-changed=RUSTUP_TOOLCHAIN'),
      directives.join('\n'),
    );
  });

  test('refuses the stable channel, which names no exact release', () => {
    const result = build(guardedCrate(declaration('stable')));
    assertRefused(
      result,
      'the declared channel "stable" is not an exact MAJOR.MINOR.PATCH release',
    );
  });

  test('refuses a channel that names only a minor release', () => {
    const minorOnly = release.split('.').slice(0, 2).join('.');
    const result = build(guardedCrate(declaration(minorOnly)));
    assertRefused(
      result,
      `the declared channel "${minorOnly}" is not an exact MAJOR.MINOR.PATCH release`,
    );
  });

  test('refuses a build with no declaration, naming the file it looked for', () => {
    const result = build(guardedCrate(null));
    assertRefused(result, 'cannot read the Rust toolchain declaration', 'declared channel: none');
    assert.match(result.stderr, /^\s*declaration: .*rust-toolchain\.toml$/m);
  });

  test('reads the channel only from the toolchain table', () => {
    const result = build(guardedCrate(`[profile]\nchannel = "${release}"\n`));
    assertRefused(result, 'the Rust toolchain declaration names no channel under [toolchain]');
  });

  test('reads a declaration checked out with CRLF line endings', () => {
    const result = build(guardedCrate(declaration(release).replaceAll('\n', '\r\n')));
    assert.equal(result.status, 0, result.stderr);
  });

  test('checks the declaration again when it changes after a green build', () => {
    const crate = guardedCrate(declaration(release));
    const first = build(crate);
    assert.equal(first.status, 0, first.stderr);
    const other = anotherRelease();
    writeFileSync(join(crate.workspace, 'rust-toolchain.toml'), declaration(other));
    assertRefused(build(crate), `rustc ${release} is not the declared Rust release ${other}`);
  });
});
