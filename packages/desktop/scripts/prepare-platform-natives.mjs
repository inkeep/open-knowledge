#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const PLATFORM_PACKAGES = {
  win32: ['win32-x64-msvc', 'win32-arm64-msvc'],
  linux: ['linux-x64-gnu', 'linux-arm64-gnu'],
};

const LOG_PREFIX = '[prepare-platform-natives]';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const STAGING_PREFIX = '.staging-keyring-';
const BLOCK = 512;

export class NativesError extends Error {}

function octalField(header, start, length) {
  const raw = header
    .subarray(start, start + length)
    .toString('latin1')
    .replace(/\0.*$/s, '')
    .trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) throw new NativesError(`archive rejected: bad octal field "${raw}"`);
  return Number.parseInt(raw, 8);
}

function stringField(header, start, length) {
  return header
    .subarray(start, start + length)
    .toString('utf8')
    .replace(/\0.*$/s, '');
}

function headerChecksumMatches(header) {
  const stored = octalField(header, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 32 : header[index];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

function strippedEntryPath(name) {
  const parts = name.split('/').filter((part) => part !== '' && part !== '.');
  if (name.startsWith('/') || parts.includes('..')) {
    throw new NativesError(`archive rejected: unsafe path "${name}"`);
  }
  return parts.slice(1).join('/');
}

export function readTarEntries(tar) {
  const files = new Map();
  let offset = 0;
  let pendingName = null;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!headerChecksumMatches(header)) {
      throw new NativesError(`archive rejected: bad header checksum at byte ${offset}`);
    }
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = octalField(header, 124, 12);
    const prefix = stringField(header, 345, 155);
    const headerName = prefix
      ? `${prefix}/${stringField(header, 0, 100)}`
      : stringField(header, 0, 100);
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    if (data.length !== size) throw new NativesError('archive rejected: truncated entry data');
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      pendingName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] ?? pendingName;
      continue;
    }
    if (type === 'L') {
      pendingName = data.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (type === 'g') continue;
    const name = pendingName ?? headerName;
    pendingName = null;
    if (type === '5') continue;
    if (type !== '0') {
      throw new NativesError(`archive rejected: unsupported entry type "${type}" for "${name}"`);
    }
    const path = strippedEntryPath(name);
    if (path === '') continue;
    if (files.has(path)) throw new NativesError(`archive rejected: duplicate entry "${path}"`);
    files.set(path, createHash('sha256').update(data).digest('hex'));
  }
  return files;
}

export function treeFiles(dir) {
  const files = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files.set(
          relative(dir, full).split(sep).join('/'),
          createHash('sha256').update(readFileSync(full)).digest('hex'),
        );
      } else throw new NativesError(`unexpected non-file "${relative(dir, full)}"`);
    }
  };
  walk(dir);
  return files;
}

function sameFiles(actual, expected) {
  if (actual.size !== expected.size) {
    return `${actual.size} file(s) on disk, ${expected.size} in the verified archive`;
  }
  for (const [path, digest] of expected) {
    if (!actual.has(path)) return `"${path}" is missing`;
    if (actual.get(path) !== digest) return `"${path}" differs from the verified archive`;
  }
  return null;
}

export function lockfileIntegrityFor(lockfile, pkgName, pkgVersion) {
  const at = lockfile.indexOf(`'${pkgName}@${pkgVersion}':`);
  if (at === -1) return null;
  return /integrity: (sha512-[A-Za-z0-9+/=]+)/.exec(lockfile.slice(at, at + 500))?.[1] ?? null;
}

function markerPathFor(repoRoot, pkgName) {
  return join(
    repoRoot,
    'node_modules',
    '.cache',
    'prepare-platform-natives',
    `${pkgName.replace('/', '__')}.json`,
  );
}

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), problem: null };
  } catch (error) {
    return { value: null, problem: error.code === 'ENOENT' ? null : error.message };
  }
}

export function installedState({ repoRoot, targetDir, pkgName, version, integrity }) {
  let stat;
  try {
    stat = lstatSync(targetDir);
  } catch (error) {
    return {
      valid: false,
      reason: error.code === 'ENOENT' ? 'missing' : `unreadable: ${error.message}`,
    };
  }
  if (stat.isSymbolicLink()) {
    let real;
    let store;
    try {
      real = realpathSync(targetDir);
      store = realpathSync(join(repoRoot, 'node_modules', '.pnpm')) + sep;
    } catch (error) {
      return {
        valid: false,
        reason: error.code === 'ENOENT' ? 'dangling link' : `link unreadable: ${error.message}`,
      };
    }
    const { value: manifest, problem } = readJson(join(real, 'package.json'));
    if (problem) return { valid: false, reason: `manifest unreadable: ${problem}` };
    if (real.startsWith(store) && manifest?.version === version) {
      return { valid: true, reason: 'pnpm-managed' };
    }
    return { valid: false, reason: 'a link outside the pnpm store or at another version' };
  }
  const { value: marker, problem } = readJson(markerPathFor(repoRoot, pkgName));
  if (problem) return { valid: false, reason: `completion marker unreadable: ${problem}` };
  if (!marker) return { valid: false, reason: 'no completion marker' };
  if (!integrity || marker.version !== version || marker.integrity !== integrity) {
    return { valid: false, reason: 'completion marker is for another version or archive' };
  }
  let actual;
  try {
    actual = treeFiles(targetDir);
  } catch (error) {
    return { valid: false, reason: error.message };
  }
  const mismatch = sameFiles(actual, new Map(Object.entries(marker.files ?? {})));
  return mismatch ? { valid: false, reason: mismatch } : { valid: true, reason: 'verified' };
}

function describeCause(error) {
  const cause = error?.cause;
  if (cause?.code) return `${cause.code}: ${cause.message}`;
  return cause?.message ?? error?.message ?? String(error);
}

async function fetchVerified({ fetchImpl, url, pkgName, version, integrity }) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new NativesError(`fetch ${url} failed: ${describeCause(error)}`);
  }
  if (!response.ok) {
    throw new NativesError(`fetch ${url} → HTTP ${response.status} ${response.statusText}`);
  }
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new NativesError(`fetch ${url} body read failed: ${describeCause(error)}`);
  }
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (actual !== integrity) {
    throw new NativesError(
      `${pkgName}@${version}: sha512 hash mismatch, expected ${integrity}, got ${actual}`,
    );
  }
  return bytes;
}

function defaultTarBin(platform) {
  return platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
}

export function extractWithTar(tarBin) {
  return (archivePath, destination) => {
    execFileSync(tarBin, ['-xzf', archivePath, '-C', destination, '--strip-components=1'], {
      stdio: 'inherit',
    });
  };
}

function removeIfPresent(path, log) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    log(`${LOG_PREFIX}   could not remove ${path}: ${error.code}`);
  }
}

function publish({ stagingDir, targetDir, markerPath, marker }) {
  try {
    rmSync(targetDir, { recursive: true, force: true });
  } catch (error) {
    throw new NativesError(`publish could not remove the previous target: ${error.message}`);
  }
  try {
    renameSync(stagingDir, targetDir);
  } catch (error) {
    throw new NativesError(`publish rename failed: ${error.message}`);
  }
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  } catch (error) {
    throw new NativesError(`publish marker write failed: ${error.message}`);
  }
}

async function prepareOne({
  repoRoot,
  napiDir,
  lockfile,
  suffix,
  version,
  registry,
  fetchImpl,
  extract,
  log,
}) {
  const pkgName = `@napi-rs/keyring-${suffix}`;
  const targetDir = join(napiDir, `keyring-${suffix}`);
  const integrity = lockfileIntegrityFor(lockfile, pkgName, version);
  const state = installedState({ repoRoot, targetDir, pkgName, version, integrity });
  if (state.valid) {
    log(`${LOG_PREFIX}   ${pkgName}@${version} present (${state.reason}) — skip`);
    return;
  }
  if (!integrity) {
    throw new NativesError(
      `${pkgName}@${version} has no integrity entry in pnpm-lock.yaml — refusing an unpinned registry fetch.`,
    );
  }
  log(`${LOG_PREFIX}   ${pkgName}@${version} ${state.reason} — fetching`);
  const url = new URL(`${pkgName}/-/keyring-${suffix}-${version}.tgz`, registry).href;
  const bytes = await fetchVerified({ fetchImpl, url, pkgName, version, integrity });
  let tar;
  try {
    tar = gunzipSync(bytes);
  } catch (error) {
    throw new NativesError(`archive rejected: gunzip ${error.code ?? 'failed'}: ${error.message}`);
  }
  const expected = readTarEntries(tar);
  const stagingDir = join(napiDir, `${STAGING_PREFIX}${suffix}-${process.pid}`);
  const archivePath = join(tmpdir(), `keyring-${suffix}-${version}-${process.pid}.tgz`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  try {
    writeFileSync(archivePath, bytes);
    try {
      extract(archivePath, stagingDir);
    } catch (error) {
      throw new NativesError(`${pkgName}@${version}: extraction failed: ${error.message}`);
    }
    const mismatch = sameFiles(treeFiles(stagingDir), expected);
    if (mismatch) {
      throw new NativesError(
        `${pkgName}@${version}: extraction does not match the verified archive: ${mismatch}`,
      );
    }
    publish({
      stagingDir,
      targetDir,
      markerPath: markerPathFor(repoRoot, pkgName),
      marker: { package: pkgName, version, integrity, files: Object.fromEntries(expected) },
    });
  } finally {
    removeIfPresent(archivePath, log);
    removeIfPresent(stagingDir, log);
  }
  log(`${LOG_PREFIX}   extracted ${pkgName}@${version} → ${targetDir}`);
}

export async function prepareNatives({
  repoRoot,
  platform = process.platform,
  registry = process.env.npm_config_registry || DEFAULT_REGISTRY,
  fetchImpl = fetch,
  extract = extractWithTar(defaultTarBin(platform)),
  checkOnly = false,
  log = console.log,
}) {
  const suffixes = PLATFORM_PACKAGES[platform];
  if (!suffixes) {
    log(
      `${LOG_PREFIX} platform=${platform} — no-op (win32/linux only; darwin uses prepare-universal.mjs).`,
    );
    return;
  }
  const napiDir = join(repoRoot, 'node_modules', '@napi-rs');
  const wrapperPkgJson = join(napiDir, 'keyring', 'package.json');
  if (!existsSync(wrapperPkgJson)) {
    throw new NativesError(
      `@napi-rs/keyring not present at ${wrapperPkgJson}. Run \`pnpm install\` first.`,
    );
  }
  const version = JSON.parse(readFileSync(wrapperPkgJson, 'utf8')).version;
  const lockfile = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
  log(`${LOG_PREFIX} target version: @napi-rs/keyring-* v${version}`);
  log(`${LOG_PREFIX} @napi-rs root: ${napiDir}`);
  for (const leftover of readdirSync(napiDir).filter((name) => name.startsWith(STAGING_PREFIX))) {
    removeIfPresent(join(napiDir, leftover), log);
  }
  const registryBase = registry.endsWith('/') ? registry : `${registry}/`;
  const invalid = [];
  for (const suffix of suffixes) {
    if (checkOnly) {
      const pkgName = `@napi-rs/keyring-${suffix}`;
      const integrity = lockfileIntegrityFor(lockfile, pkgName, version);
      const state = installedState({
        repoRoot,
        targetDir: join(napiDir, `keyring-${suffix}`),
        pkgName,
        version,
        integrity,
      });
      log(
        `${LOG_PREFIX}   ${pkgName}@${version}: ${state.valid ? 'verified' : 'NOT verified'} (${state.reason})`,
      );
      if (!state.valid) invalid.push(`${pkgName}@${version} (${state.reason})`);
      continue;
    }
    await prepareOne({
      repoRoot,
      napiDir,
      lockfile,
      suffix,
      version,
      registry: registryBase,
      fetchImpl,
      extract,
      log,
    });
  }
  if (invalid.length > 0) {
    throw new NativesError(`keyring prebuilds not verified: ${invalid.join('; ')}`);
  }
  log(`${LOG_PREFIX} all target-platform keyring prebuilds present.`);
}

if (import.meta.main) {
  try {
    await prepareNatives({
      repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
      checkOnly: process.argv.includes('--check'),
    });
  } catch (error) {
    console.error(`${LOG_PREFIX}   ${error instanceof NativesError ? error.message : error.stack}`);
    process.exitCode = 1;
  }
}
