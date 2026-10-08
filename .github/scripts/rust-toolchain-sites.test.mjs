import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { ciDocuments, rustToolchainSites } from './rust-toolchain-sites.test-helper.mjs';

const OK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = '.github/workflows/fixture.yml';
const ACTION = '.github/composite-actions/fixture/action.yml';

const inWorkflow = (fields, job) => [
  {
    file: WORKFLOW,
    document: {
      on: 'push',
      ...fields,
      jobs: { build: { 'runs-on': 'ubuntu-latest', steps: [{ run: 'make' }], ...job } },
    },
  },
];
const inStep = (...steps) => inWorkflow({}, { steps });
const inAction = (step) => [
  { file: ACTION, document: { name: 'fixture', runs: { using: 'composite', steps: [step] } } },
];
const PIN = { RUSTUP_TOOLCHAIN: '1.95.0' };

describe('no workflow or composite action under .github names a Rust toolchain', () => {
  const documents = ciDocuments(OK_ROOT);
  const { commands, findings } = rustToolchainSites(documents);

  test('the sweep read workflows, composite actions and a toolchain acquisition', () => {
    expect(documents.filter(({ file }) => file.startsWith('.github/workflows/'))).not.toEqual([]);
    expect(documents.filter(({ file }) => /\/action\.ya?ml$/.test(file))).not.toEqual([]);
    expect(
      commands.filter(({ command }) => /^rustup toolchain install(?: |$)/.test(command)),
    ).not.toEqual([]);
  });

  test('a toolchain planted into a real acquisition step is reported there, once', () => {
    const acquisition = commands.find(({ command }) =>
      /^rustup toolchain install(?: |$)/.test(command),
    );
    const planted = structuredClone(documents);
    const { document } = planted.find(({ file }) => file === acquisition.file);
    const step = document.jobs[acquisition.job].steps.find(
      (candidate) => candidate.name === acquisition.step,
    );
    step.run = step.run.replace('rustup toolchain install', 'rustup toolchain install 1.95.0');
    expect(rustToolchainSites(planted).findings).toEqual([
      expect.objectContaining({
        file: acquisition.file,
        job: acquisition.job,
        step: acquisition.step,
        kind: 'command',
        detail: expect.stringContaining('names 1.95.0'),
      }),
    ]);
  });

  test('no workflow, job or step names one', () => {
    expect(
      findings,
      'rust-toolchain.toml at the Open Knowledge root declares the toolchain; a job acquires it with a bare `rustup toolchain install` run in the tree it builds',
    ).toEqual([]);
  });
});

const atStep = (kind) => ({ file: WORKFLOW, job: 'build', step: 'plant', kind });

describe('the rule reports each place a CI file names a Rust toolchain, once', () => {
  test.each([
    [
      'dtolnay/rust-toolchain with no inputs',
      inStep({ name: 'plant', uses: 'dtolnay/rust-toolchain@stable' }),
      atStep('action'),
    ],
    [
      'dtolnay/rust-toolchain with toolchain: 1.95.0',
      inStep({
        name: 'plant',
        uses: 'dtolnay/rust-toolchain@29eef336d9b2848a0b548edc03f92a220660cdb8',
        with: { toolchain: '1.95.0' },
      }),
      atStep('action'),
    ],
    [
      'another action given a toolchain input',
      inStep({
        name: 'plant',
        uses: 'actions-rust-lang/setup-rust-toolchain@v1',
        with: { toolchain: '1.95.0', cache: false },
      }),
      atStep('action'),
    ],
    [
      'RUSTUP_TOOLCHAIN in the workflow env',
      inWorkflow({ env: PIN }, {}),
      { file: WORKFLOW, job: null, step: null, kind: 'env' },
    ],
    [
      'RUSTUP_TOOLCHAIN in a job env',
      inWorkflow({}, { env: PIN }),
      { file: WORKFLOW, job: 'build', step: null, kind: 'env' },
    ],
    [
      "RUSTUP_TOOLCHAIN in a job container's env",
      inWorkflow({}, { container: { image: 'rust:1', env: PIN } }),
      { file: WORKFLOW, job: 'build', step: null, kind: 'env' },
    ],
    [
      'RUSTUP_TOOLCHAIN in a step env',
      inStep({ name: 'plant', run: 'cargo build', env: PIN }),
      atStep('env'),
    ],
    [
      'RUSTUP_TOOLCHAIN in a composite action step env',
      inAction({ name: 'plant', shell: 'bash', run: 'cargo build', env: PIN }),
      { file: ACTION, job: null, step: 'plant', kind: 'env' },
    ],
    ['cargo +1.95.0 build', inStep({ name: 'plant', run: 'cargo +1.95.0 build' }), atStep('command')],
    [
      'rustup default stable',
      inStep({ name: 'plant', run: 'rustup default stable' }),
      atStep('command'),
    ],
    [
      'rustup toolchain install 1.95.0',
      inStep({ name: 'plant', run: 'rustup toolchain install 1.95.0' }),
      atStep('command'),
    ],
  ])('%s', (_form, documents, expected) => {
    expect(rustToolchainSites(documents).findings).toEqual([expect.objectContaining(expected)]);
  });

  test.each([
    ['rustup install 1.95.0', 'names 1.95.0'],
    ['rustup update stable', 'names stable'],
    ['rustup run 1.95.0 cargo build', 'names 1.95.0'],
    ['rustup override set 1.95.0', 'names 1.95.0'],
    ['rustup override set --path packages/native-config 1.95.0', 'names 1.95.0'],
    ['rustup toolchain install --profile minimal -c rustfmt 1.95.0', 'names 1.95.0'],
    ['rustup -q toolchain install 1.95.0', 'names 1.95.0'],
    ['rustup +nightly show', 'names +nightly'],
    ['rustup component add --toolchain nightly rustfmt', 'names nightly'],
    ['rustup target add --toolchain=1.95.0 x86_64-unknown-linux-musl', 'names 1.95.0'],
    ['rustfmt +nightly --check src/lib.rs', 'names +nightly'],
    ['"$HOME/.cargo/bin/cargo" +1.95.0 build', 'names +1.95.0'],
    ['cargo.exe +1.95.0 build', 'names +1.95.0'],
    ['pnpm exec cargo +1.95.0 build', 'names +1.95.0'],
    ['rustup toolchain install \\\n  1.95.0', 'names 1.95.0'],
    ['rustup toolchain install ${{ matrix.rust }}', 'names ${{ matrix.rust }}'],
    ['cargo +${{ matrix.rust }} build', 'names +${{ matrix.rust }}'],
    ['rustup show && cargo +1.95.0 build', 'names +1.95.0'],
    ['echo "build #1" && cargo +1.95.0 build', 'names +1.95.0'],
    ['echo ${#PATH}; cargo +1.95.0 build', 'names +1.95.0'],
    ['RUSTUP_TOOLCHAIN=1.95.0 cargo build', 'sets RUSTUP_TOOLCHAIN'],
    ['export RUSTUP_TOOLCHAIN=1.95.0', 'sets RUSTUP_TOOLCHAIN'],
    ['echo "RUSTUP_TOOLCHAIN=1.95.0" >> "$GITHUB_ENV"', 'sets RUSTUP_TOOLCHAIN'],
    ["$env:RUSTUP_TOOLCHAIN = '1.95.0'", 'sets RUSTUP_TOOLCHAIN'],
  ])('a run step: %s', (run, naming) => {
    expect(rustToolchainSites(inStep({ name: 'plant', run })).findings).toEqual([
      expect.objectContaining({ ...atStep('command'), detail: expect.stringContaining(naming) }),
    ]);
  });
});

describe('the rule stays quiet where a CI file names no toolchain', () => {
  test('an action input named tool, and a step named for a toolchain', () => {
    const documents = [
      {
        file: WORKFLOW,
        document: {
          on: 'push',
          jobs: {
            build: {
              'runs-on': 'ubuntu-latest',
              steps: [
                {
                  name: 'Install cargo-zigbuild',
                  uses: 'taiki-e/install-action@v2',
                  with: { tool: 'cargo-zigbuild' },
                },
                { name: 'Cache Corepack toolchain', uses: 'actions/cache@v4', with: { path: 'p' } },
              ],
            },
          },
        },
      },
    ];
    expect(rustToolchainSites(documents).findings).toEqual([]);
  });

  test('an acquisition step, Rust commands that select nothing, and comments that mention dtolnay', () => {
    const documents = [
      {
        file: WORKFLOW,
        document: parse(`
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      # dtolnay/rust-toolchain@stable installed the toolchain here
      - name: Install the declared Rust toolchain
        run: |
          # dtolnay/rust-toolchain ran rustup default stable, then cargo +stable build
          rustup toolchain install
          rustup toolchain install --no-self-update
          rustup toolchain install --no-self-update --profile minimal -c rustfmt -t x86_64-unknown-linux-musl
          rustup target add x86_64-unknown-linux-musl
          rustup show
          rustc -vV
          cargo test --manifest-path packages/native-config/Cargo.toml
`),
      },
    ];
    const { commands, findings } = rustToolchainSites(documents);
    expect(commands.map(({ command }) => command)).toEqual([
      'rustup toolchain install',
      'rustup toolchain install --no-self-update',
      'rustup toolchain install --no-self-update --profile minimal -c rustfmt -t x86_64-unknown-linux-musl',
      'rustup target add x86_64-unknown-linux-musl',
      'rustup show',
      'rustc -vV',
      'cargo test --manifest-path packages/native-config/Cargo.toml',
    ]);
    expect(findings).toEqual([]);
  });

  test('run steps that redirect, clear or read the toolchain variable, and bare rustup commands', () => {
    const runs = [
      'rustup toolchain install --no-self-update 2>&1 | tee install.log',
      'rustup toolchain install --no-self-update > install.log',
      'rustup toolchain install --no-self-update && rustc -vV',
      'rustup toolchain install --default --no-self-update',
      'rustup update',
      'rustup update --no-self-update',
      'rustup default',
      'unset RUSTUP_TOOLCHAIN',
      'env -u RUSTUP_TOOLCHAIN cargo build',
      'test -z "$RUSTUP_TOOLCHAIN" && rustc -vV',
    ];
    const { commands, findings } = rustToolchainSites(
      inStep(...runs.map((run, index) => ({ name: `quiet ${index + 1}`, run }))),
    );
    expect(new Set(commands.map(({ step }) => step))).toEqual(
      new Set(runs.map((_run, index) => `quiet ${index + 1}`)),
    );
    expect(findings).toEqual([]);
  });

  test('env maps that set other Rust variables', () => {
    const others = { RUSTUP_HOME: '/opt/rustup', CARGO_INCREMENTAL: '0', RUSTUP_TOOLCHAIN_X: '1' };
    const documents = [
      ...inWorkflow(
        { env: others },
        {
          env: others,
          container: { image: 'rust:1', env: others },
          steps: [{ name: 'build', run: 'cargo build', env: others }],
        },
      ),
      ...inAction({ name: 'build', shell: 'bash', run: 'cargo build', env: others }),
    ];
    expect(rustToolchainSites(documents).findings).toEqual([]);
  });
});

describe('the rule refuses input it cannot judge', () => {
  test('an empty file list', () => {
    expect(() => rustToolchainSites([])).toThrow(/no workflow or action was given/);
  });

  test('a file that is neither a workflow nor an action', () => {
    expect(() =>
      rustToolchainSites([{ file: '.github/workflows/empty.yml', document: null }]),
    ).toThrow(/\.github\/workflows\/empty\.yml is neither a workflow \(no jobs\) nor an action/);
  });
});
