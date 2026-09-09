import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const PREDICATE_DIR = import.meta.dirname;
const SUBJECT_ROOT = resolve(PREDICATE_DIR, '..', '..');

export const SCOPE_CONFIG_NAME = 'no-comments.config.jsonc';

export const NO_CONFIG = Symbol('no scope config at this root');

const WORKING_CONFIG = {
  version: 1,
  families: { typescript: { extensions: ['.ts'], extractor: 'c-family' } },
  units: [{ id: 'app', family: 'typescript', roots: ['packages/*/src'] }],
  exclude: [],
};

export function configWith(overrides) {
  return { ...WORKING_CONFIG, ...overrides };
}

const roots = new Set();

export function createScratchRoot({ prefix = 'no-comments-lane-', config, files = {}, nest } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.add(base);
  const root = nest === undefined ? base : join(base, nest);
  mkdirSync(root, { recursive: true });
  cpSync(PREDICATE_DIR, join(root, 'lint-plugins/no-comments'), { recursive: true });
  if (config !== NO_CONFIG) {
    const text =
      config === undefined
        ? readFileSync(join(SUBJECT_ROOT, SCOPE_CONFIG_NAME), 'utf8')
        : typeof config === 'string'
          ? config
          : `${JSON.stringify(config, null, 2)}\n`;
    writeFileSync(join(root, SCOPE_CONFIG_NAME), text);
  }
  writeScratchFiles(root, files);
  return root;
}

function writeScratchFiles(root, files) {
  for (const [relPath, source] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, source);
  }
  return root;
}

export function removeScratchRoots() {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
}
