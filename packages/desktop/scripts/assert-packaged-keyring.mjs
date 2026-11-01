import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { checkPackagedApp, findPackagedApps } from './assert-packaged-helper-runs-as-node.mjs';

const marker = 'OK_KEYRING_PROBE:';
const source = `
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[1];
let mod;
try {
  mod = require(path.join(root, '@napi-rs', 'keyring'));
} catch (error) {
  console.log('${marker}' + JSON.stringify({ stage: 'load-error', code: error.code || null }));
  process.exit(1);
}
if (typeof mod.AsyncEntry !== 'function') throw new Error('missing AsyncEntry');
const bindings = Object.keys(require.cache).filter(p => /keyring[^/\\\\]*\\.node$/i.test(p)).map(p => fs.realpathSync(p));
console.log('${marker}' + JSON.stringify({ stage: 'loaded', bindings }));
`;

export function validateProbe(result, root, negative = false) {
  if (result.error || result.signal) throw new Error('Keyring probe did not complete');
  const lines = (result.stdout ?? '').split(/\r?\n/).filter((line) => line.startsWith(marker));
  if (lines.length !== 1) throw new Error('Keyring probe marker missing or duplicated');
  const data = JSON.parse(lines[0].slice(marker.length));
  if (negative) {
    if (result.status !== 1 || data.stage !== 'load-error')
      throw new Error('Missing-binding control did not fail at load');
    return;
  }
  if (
    result.status !== 0 ||
    data.stage !== 'loaded' ||
    !Array.isArray(data.bindings) ||
    data.bindings.length !== 1
  )
    throw new Error('Keyring binding did not load exactly once');
  const path = data.bindings[0];
  const rel = relative(root, path);
  if (
    !isAbsolute(path) ||
    !/^keyring.*\.node$/i.test(basename(path)) ||
    !rel ||
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rel)
  )
    throw new Error('Keyring binding is outside packaged tree');
}

function probe(executable, root) {
  return spawnSync(executable, ['-e', source, root], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '', NODE_OPTIONS: '' },
    encoding: 'utf8',
    timeout: 10000,
  });
}

function main(rootArg) {
  const root = resolve(rootArg);
  let executable;
  let resources;
  if (process.platform === 'darwin') {
    const apps = findPackagedApps(root);
    if (apps.length !== 1) throw new Error('Expected one packaged macOS app');
    const app = checkPackagedApp(apps[0]);
    if (app.problems.length) throw new Error(app.problems.join('; '));
    executable = app.helper;
    resources = join(apps[0], 'Contents', 'Resources');
  } else {
    const dir = join(root, process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked');
    resources = join(dir, 'resources');
    const candidates = readdirSync(dir).filter((name) =>
      process.platform === 'win32' ? name.endsWith('.exe') : name === 'openknowledge',
    );
    if (candidates.length !== 1) throw new Error('Expected one packaged executable');
    executable = join(dir, candidates[0]);
  }
  resources = realpathSync(resources);
  for (const tree of [
    join(resources, 'cli', 'node_modules'),
    join(resources, 'app.asar.unpacked', 'node_modules'),
  ]) {
    const actual = realpathSync(tree);
    const rel = relative(resources, actual);
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Package tree escapes artifact');
    if (!existsSync(join(actual, '@napi-rs', 'keyring', 'index.js')))
      throw new Error('Packaged keyring wrapper is missing');
    validateProbe(probe(executable, actual), actual);
  }
  const fixture = mkdtempSync(join(tmpdir(), 'ok-keyring-missing-'));
  try {
    const wrapper = join(fixture, '@napi-rs', 'keyring');
    cpSync(join(resources, 'cli', 'node_modules', '@napi-rs', 'keyring'), wrapper, {
      recursive: true,
      dereference: true,
    });
    for (const name of readdirSync(wrapper))
      if (name.endsWith('.node')) rmSync(join(wrapper, name));
    validateProbe(probe(executable, fixture), fixture, true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
  console.log(
    'Packaged keyring loads from both artifact trees; missing-binding control failed at load',
  );
}

if (import.meta.main) {
  const [root, label = root] = process.argv.slice(2);
  if (!root) {
    console.error('usage: assert-packaged-keyring.mjs <search-root> [label]');
    process.exitCode = 2;
  } else {
    try {
      main(root);
    } catch (error) {
      console.error(`::error::${label}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
