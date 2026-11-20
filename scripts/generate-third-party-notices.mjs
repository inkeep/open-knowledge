#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);

const SHIPPING_WORKSPACES = [
  'packages/cli',
  'packages/server',
  'packages/core',
  'packages/app',
  'packages/desktop',
];

const WORKSPACE_NAME_PREFIX = '@inkeep/open-knowledge';

const LICENSE_FILENAMES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'COPYING',
  'COPYING.md',
  'COPYING.txt',
  'LICENSE-MIT',
  'LICENSE.MIT',
];

const NOTICE_FILENAMES = [
  'NOTICE',
  'NOTICE.md',
  'NOTICE.txt',
  'NOTICE.markdown',
  'NOTICE.rst',
  'NOTICES',
];

const args = argv.slice(2);
const CHECK_MODE = args.includes('--check');
const outIdx = args.indexOf('--out');
const OUT_PATH =
  outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md');

function byteCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function loadLicenseText(name) {
  return readFileSync(join(SCRIPT_DIR, 'license-texts', `${name}.txt`), 'utf8').trim();
}
function loadLicenseTexts() {
  return {
    mit: loadLicenseText('mit'),
    isc: loadLicenseText('isc'),
    apache: loadLicenseText('apache-2.0'),
    bsd2: loadLicenseText('bsd-2-clause'),
    bsd3: loadLicenseText('bsd-3-clause'),
    lgpl3: loadLicenseText('lgpl-3.0'),
    ofl: loadLicenseText('ofl-1.1'),
    gpl2: loadLicenseText('gpl-2.0'),
    liberation: loadLicenseText('liberation-1'),
    zstd: loadLicenseText('zstd-bsd-3-clause'),
    gpl3: readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf8').trim(),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadPatchedDeps() {
  const workspaceYaml = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const block = workspaceYaml.match(/^patchedDependencies:\n((?:[ \t]+\S.*\n?)+)/m);
  const patches = {};
  if (block) {
    for (const line of block[1].split('\n')) {
      const entry = line.match(/^\s+(['"]?)(.+?)\1:\s+(\S+)\s*$/);
      if (entry) patches[entry[2]] = entry[3];
    }
  }
  return Object.entries(patches)
    .map(([nameVersion, patchFile]) => {
      const at = nameVersion.lastIndexOf('@');
      return {
        name: nameVersion.slice(0, at),
        version: nameVersion.slice(at + 1),
        patchFile,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  while (dir.length >= REPO_ROOT.length) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isWorkspacePkg(pkg) {
  return pkg.name && pkg.name.startsWith(WORKSPACE_NAME_PREFIX);
}

function isPlatformRestricted(pkg) {
  if (Array.isArray(pkg.os) && pkg.os.length > 0) return true;
  if (Array.isArray(pkg.cpu) && pkg.cpu.length > 0) return true;
  return false;
}

function requiredPeerDependencies(pkg) {
  const meta = pkg.peerDependenciesMeta || {};
  return Object.fromEntries(
    Object.entries(pkg.peerDependencies || {}).filter(
      ([name]) => !name.startsWith('@types/') && !meta[name]?.optional,
    ),
  );
}

function collectClosure() {
  const visitedDirs = new Set();
  const queue = [];

  for (const ws of SHIPPING_WORKSPACES) {
    queue.push(join(REPO_ROOT, ws));
  }

  const collected = [];

  while (queue.length > 0) {
    const pkgDir = queue.shift();
    if (visitedDirs.has(pkgDir)) continue;
    visitedDirs.add(pkgDir);

    let pkg;
    try {
      pkg = readJson(join(pkgDir, 'package.json'));
    } catch {
      continue;
    }

    if (!isWorkspacePkg(pkg) && pkg.name && pkg.version && !isPlatformRestricted(pkg)) {
      collected.push({ dir: pkgDir, pkg });
    }

    const deps = {
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...requiredPeerDependencies(pkg),
    };

    for (const depName of Object.keys(deps)) {
      if (depName.startsWith(WORKSPACE_NAME_PREFIX)) continue;
      const depDir = resolvePackageDir(depName, pkgDir);
      if (!depDir) continue;
      if (visitedDirs.has(depDir)) continue;
      queue.push(depDir);
    }
  }

  return collected;
}

function findFileCaseInsensitive(dir, candidates) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const lookup = new Map();
  for (const e of entries) lookup.set(e.toLowerCase(), e);
  for (const cand of candidates) {
    const found = lookup.get(cand.toLowerCase());
    if (found) return join(dir, found);
  }
  return null;
}

function readTextOrNull(path) {
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim();
  } catch {
    return null;
  }
}

function readLicenseText(pkgDir) {
  return readTextOrNull(findFileCaseInsensitive(pkgDir, LICENSE_FILENAMES));
}

function readNoticeText(pkgDir) {
  return readTextOrNull(findFileCaseInsensitive(pkgDir, NOTICE_FILENAMES));
}

const FIRST_PARTY_GPL_PACKAGES = new Set(['@visimer/core', '@visimer/dom']);

const SPDX_OVERRIDES = {
  khroma: 'MIT',
};

function normalizeSpdx(licenseField, pkgName) {
  if (!licenseField) {
    if (pkgName && Object.hasOwn(SPDX_OVERRIDES, pkgName)) return SPDX_OVERRIDES[pkgName];
    return 'UNKNOWN';
  }
  if (typeof licenseField === 'string') return licenseField.trim();
  if (Array.isArray(licenseField)) {
    return licenseField
      .map((l) => (typeof l === 'string' ? l : l.type || JSON.stringify(l)))
      .join(' OR ');
  }
  if (typeof licenseField === 'object') return licenseField.type || JSON.stringify(licenseField);
  return String(licenseField);
}

const MAX_COPYRIGHT_BLOCKS = 4;

const COPYRIGHT_SIGN = String.raw`\([cC]\)|©`;

const COPYRIGHT_LINE = new RegExp(
  String.raw`^(?:\([cC]\)\s+)?[Cc]opyright\s+(?:${COPYRIGHT_SIGN}|\d{4}|\p{Lu})`,
  'u',
);

const COPYRIGHT_MARKS = new RegExp(`[Cc]opyright|${COPYRIGHT_SIGN}`, 'g');

const TEMPLATE_TOKENS =
  /[[{<]\s*(?:yyyy|year|fullname|name of copyright owner|name of author)\s*[\]}>]/i;

function extractCopyrights(licenseText) {
  if (!licenseText) return [];
  const lines = licenseText.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length && blocks.length < MAX_COPYRIGHT_BLOCKS) {
    const line = lines[i].trim();
    if (COPYRIGHT_LINE.test(line)) {
      const block = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '') {
        const next = lines[j].trim();
        if (
          /^(Permission|Redistribution|This Font|This license|This software|This program|This module|All rights|The above|Licensed|License|Released under|Subject to|See the)/i.test(
            next,
          )
        ) {
          break;
        }
        if (
          /^[-*•]/.test(next) ||
          /^\S+ <\S+@\S+>/.test(next) ||
          /\(\S+@\S+\)\s*$/.test(next) ||
          /^copyright\b/i.test(next)
        ) {
          block.push(next);
          j++;
        } else {
          break;
        }
      }
      const joined = block.join(' ');
      if (!TEMPLATE_TOKENS.test(joined)) {
        blocks.push(joined);
      }
      i = j;
    } else {
      i++;
    }
  }
  return blocks;
}

function normalizeRepoUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let u = url.trim();

  const shortcutMatch = u.match(/^(github|gitlab|bitbucket):(.+)$/);
  if (shortcutMatch) {
    const [, host, path] = shortcutMatch;
    const domain = {
      github: 'github.com',
      gitlab: 'gitlab.com',
      bitbucket: 'bitbucket.org',
    }[host];
    return `https://${domain}/${path.replace(/\.git$/, '')}`;
  }

  if (/^[\w-]+\/[\w.-]+$/.test(u)) {
    return `https://github.com/${u.replace(/\.git$/, '')}`;
  }

  u = u.replace(/^git\+/, '');
  u = u.replace(/^ssh:\/\/git@/, 'https://');
  u = u.replace(/^git@([^:]+):/, 'https://$1/');
  u = u.replace(/^git:\/\//, 'https://');
  u = u.replace(/\.git$/, '');
  return u;
}

function homepageOf(pkg) {
  if (pkg.homepage && typeof pkg.homepage === 'string') return pkg.homepage;
  const repo = pkg.repository;
  if (!repo) return null;
  const url = typeof repo === 'string' ? repo : repo.url;
  return normalizeRepoUrl(url);
}

function categorize(spdx) {
  const stripped = spdx.replace(/[()]/g, '').trim();
  const orParts = stripped
    .split(/\s+OR\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const s =
    orParts.length > 1
      ? [...orParts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(' OR ')
      : stripped;

  if (/^MIT AND Zlib$/i.test(s)) return 'MIT';

  if (/\bMIT\b/i.test(s) && /\bCC0-1\.0\b/i.test(s)) return 'MIT';
  if (/\bMIT\b/i.test(s) && /\bWTFPL\b/i.test(s)) return 'MIT';
  if (/\bMPL-2\.0\b/i.test(s) && /\bApache-2\.0\b/i.test(s)) return 'Apache-2.0';
  if (/\bWTFPL\b/i.test(s) && /\bISC\b/i.test(s)) return 'ISC';
  if (/\bBSD-2-Clause\b/i.test(s) && /\bMIT\b/i.test(s)) return 'BSD-2-Clause';
  if (/^Apache-2\.0 OR MIT$/i.test(s)) return 'MIT';
  if (/^MIT$/i.test(s)) return 'MIT';
  if (/^Apache-2\.0$/i.test(s)) return 'Apache-2.0';
  if (/^ISC$/i.test(s)) return 'ISC';
  if (/^BSD-3-Clause$/i.test(s)) return 'BSD-3-Clause';
  if (/^BSD-2-Clause$/i.test(s)) return 'BSD-2-Clause';
  if (/^OFL-1\.1$/i.test(s)) return 'OFL-1.1';
  if (/^MPL-2\.0$/i.test(s)) return 'MPL-2.0';
  if (/^BlueOak-1\.0\.0$/i.test(s)) return 'BlueOak-1.0.0';
  if (/^0BSD$/i.test(s)) return '0BSD';
  if (/^WTFPL$/i.test(s)) return 'WTFPL';
  if (/^Unlicense$/i.test(s)) return 'Unlicense';
  if (/^Python-2\.0$/i.test(s)) return 'Python-2.0';
  if (/^CC-BY-4\.0$/i.test(s)) return 'CC-BY-4.0';
  if (/^CC0-1\.0$/i.test(s)) return 'CC0-1.0';
  if (/^LGPL/i.test(s)) return 'LGPL';
  if (/^GPL/i.test(s)) return 'GPL';
  return 'OTHER';
}

function packageHeader(pkg) {
  return `### \`${pkg.name}@${pkg.version}\``;
}

function shortEntry(e) {
  const lines = [packageHeader(e.pkg)];
  const home = homepageOf(e.pkg);
  if (home) lines.push(`Homepage: ${home}`);
  const cps = extractCopyrights(e.licenseText);
  lines.push('');
  if (cps.length > 0) {
    for (const cp of cps) lines.push(cp);
  } else if (!e.licenseText) {
    lines.push(
      '_(No LICENSE file in package; SPDX identifier in `package.json` is the sole declared grant.)_',
    );
  } else {
    lines.push(
      '_(LICENSE file present but no auto-extractable copyright line; refer to the package source for canonical attribution.)_',
    );
  }
  return lines.join('\n');
}

function fullLicenseEntry(e) {
  const lines = [packageHeader(e.pkg)];
  const home = homepageOf(e.pkg);
  if (home) lines.push(`Homepage: ${home}`);
  lines.push('');
  if (e.licenseText) {
    lines.push(fenced(e.licenseText));
  } else {
    lines.push('_(LICENSE file not present in package; see homepage.)_');
  }
  return lines.join('\n');
}

function apacheEntry(e) {
  const lines = [packageHeader(e.pkg)];
  const home = homepageOf(e.pkg);
  if (home) lines.push(`Homepage: ${home}`);
  const cps = extractCopyrights(e.licenseText);
  lines.push('');
  if (cps.length > 0) {
    for (const cp of cps) lines.push(cp);
  } else {
    lines.push(
      '_(LICENSE template present but no copyright line filled in; refer to the package source for canonical attribution.)_',
    );
  }
  if (e.noticeText) {
    lines.push('');
    lines.push('NOTICE:');
    lines.push('');
    lines.push(fenced(e.noticeText));
  }
  return lines.join('\n');
}

function vendoredCodexEntry() {
  return [
    '### OpenAI Codex (vendored into `packages/native-config`)',
    'Homepage: https://github.com/openai/codex',
    '',
    'Copyright 2025 OpenAI',
    '',
    "The native harness-config addon contains Rust code derived from OpenAI Codex's `toml_edit`-based config-edit implementation, adapted to an insert-only single-entry upsert. The Apache License, Version 2.0 reproduced above applies. Derived files and their upstream origins:",
    '',
    '- `src/document_helpers.rs` — from `codex-rs/core/src/config/edit/document_helpers.rs`',
    '- `src/mcp_edit.rs` — adapted from `codex-rs/core/src/config/edit.rs` (insert-only, not `replace_mcp_servers`)',
    '- `src/path_resolve.rs` — from `codex-rs/utils/path-utils/src/lib.rs`',
    '- `src/mcp_edit_conformance_tests.rs` — ported from `codex-rs/core/src/config/edit_tests.rs`',
    '',
    'NOTICE:',
    '',
    fenced('OpenAI Codex\nCopyright 2025 OpenAI'),
  ].join('\n');
}

const NATIVE_CONFIG_CRATE = 'open-knowledge-native-config';
const NATIVE_CONFIG_CARGO_LOCK = join(REPO_ROOT, 'packages', 'native-config', 'Cargo.lock');

const RUST_RUNTIME_CRATES = {
  bitflags: { license: 'MIT OR Apache-2.0', repository: 'https://github.com/bitflags/bitflags' },
  'cfg-if': { license: 'MIT OR Apache-2.0', repository: 'https://github.com/rust-lang/cfg-if' },
  ctor: { license: 'Apache-2.0 OR MIT', repository: 'https://github.com/mmastrac/linktime' },
  equivalent: {
    license: 'Apache-2.0 OR MIT',
    repository: 'https://github.com/indexmap-rs/equivalent',
  },
  futures: { license: 'MIT OR Apache-2.0', repository: 'https://github.com/rust-lang/futures-rs' },
  'futures-channel': {
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/rust-lang/futures-rs',
  },
  'futures-core': {
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/rust-lang/futures-rs',
  },
  'futures-executor': {
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/rust-lang/futures-rs',
  },
  'futures-io': {
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/rust-lang/futures-rs',
  },
  'futures-sink': {
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/rust-lang/futures-rs',
  },
  'futures-task': {
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/rust-lang/futures-rs',
  },
  'futures-util': {
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/rust-lang/futures-rs',
  },
  hashbrown: { license: 'MIT OR Apache-2.0', repository: 'https://github.com/rust-lang/hashbrown' },
  indexmap: { license: 'Apache-2.0 OR MIT', repository: 'https://github.com/indexmap-rs/indexmap' },
  itoa: { license: 'MIT OR Apache-2.0', repository: 'https://github.com/dtolnay/itoa' },
  libloading: {
    license: 'ISC',
    repository: 'https://github.com/nagisa/rust_libloading',
    copyright: 'Copyright © 2015, Simonas Kazlauskas',
  },
  memchr: {
    license: 'Unlicense OR MIT',
    repository: 'https://github.com/BurntSushi/memchr',
    copyright: 'Copyright (c) 2015 Andrew Gallant',
  },
  napi: {
    license: 'MIT',
    repository: 'https://github.com/napi-rs/napi-rs',
    copyright: 'Copyright (c) 2020-present LongYinan',
  },
  'napi-sys': {
    license: 'MIT',
    repository: 'https://github.com/napi-rs/napi-rs',
    copyright: 'Copyright (c) 2020-present LongYinan',
  },
  'nohash-hasher': {
    license: 'Apache-2.0 OR MIT',
    repository: 'https://github.com/paritytech/nohash-hasher',
  },
  'pin-project-lite': {
    license: 'Apache-2.0 OR MIT',
    repository: 'https://github.com/taiki-e/pin-project-lite',
  },
  'rustc-hash': {
    license: 'Apache-2.0 OR MIT',
    repository: 'https://github.com/rust-lang/rustc-hash',
  },
  serde: { license: 'MIT OR Apache-2.0', repository: 'https://github.com/serde-rs/serde' },
  serde_core: { license: 'MIT OR Apache-2.0', repository: 'https://github.com/serde-rs/serde' },
  serde_json: { license: 'MIT OR Apache-2.0', repository: 'https://github.com/serde-rs/json' },
  slab: {
    license: 'MIT',
    repository: 'https://github.com/tokio-rs/slab',
    copyright: 'Copyright (c) 2019 Carl Lerche',
  },
  toml_datetime: { license: 'MIT OR Apache-2.0', repository: 'https://github.com/toml-rs/toml' },
  toml_edit: { license: 'MIT OR Apache-2.0', repository: 'https://github.com/toml-rs/toml' },
  toml_parser: { license: 'MIT OR Apache-2.0', repository: 'https://github.com/toml-rs/toml' },
  toml_writer: { license: 'MIT OR Apache-2.0', repository: 'https://github.com/toml-rs/toml' },
  'windows-link': {
    license: 'MIT OR Apache-2.0',
    repository: 'https://github.com/microsoft/windows-rs',
  },
  winnow: { license: 'MIT', repository: 'https://github.com/winnow-rs/winnow', copyright: null },
  zmij: { license: 'MIT', repository: 'https://github.com/dtolnay/zmij', copyright: null },
};

const RUST_COMPILE_TIME_CRATES = new Set([
  'convert_case',
  'futures-macro',
  'napi-build',
  'napi-derive',
  'napi-derive-backend',
  'proc-macro2',
  'quote',
  'semver',
  'serde_derive',
  'syn',
  'unicode-ident',
  'unicode-segmentation',
]);

const RUST_DEV_CRATES = new Set([
  'errno',
  'fastrand',
  'getrandom',
  'libc',
  'linux-raw-sys',
  'once_cell',
  'r-efi',
  'rustix',
  'tempfile',
  'windows-sys',
]);

function parseCargoLockPackages(lockPath) {
  const text = readFileSync(lockPath, 'utf8');
  const pkgs = [];
  for (const block of text.split('[[package]]').slice(1)) {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name && version) pkgs.push({ name, version });
  }
  return pkgs;
}

const REPRODUCED_CRATE_LICENSES = ['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause'];

const REPRODUCED_CRATE_LICENSE_LIST = `${REPRODUCED_CRATE_LICENSES.slice(0, -1).join(', ')} or ${REPRODUCED_CRATE_LICENSES.at(-1)}`;

function licenseAlternatives(expression) {
  const tokens = expression.replaceAll('/', ' OR ').match(/[()]|[^\s()]+/g) ?? [];
  let at = 0;
  const operand = () => {
    if (tokens[at] === '(') {
      at += 1;
      const inner = anyOf();
      at += 1;
      return inner;
    }
    const id = tokens[at];
    at += 1;
    if (tokens[at] !== 'WITH') return [[id]];
    const exception = tokens[at + 1];
    at += 2;
    return [[`${id} WITH ${exception}`]];
  };
  const allOf = () => {
    let alternatives = operand();
    while (tokens[at] === 'AND') {
      at += 1;
      const right = operand();
      alternatives = alternatives.flatMap((left) => right.map((ids) => [...left, ...ids]));
    }
    return alternatives;
  };
  const anyOf = () => {
    let alternatives = allOf();
    while (tokens[at] === 'OR') {
      at += 1;
      alternatives = [...alternatives, ...allOf()];
    }
    return alternatives;
  };
  return anyOf();
}

function crateAttributionProblem(crate) {
  const reproducible = licenseAlternatives(crate.license).filter((ids) =>
    ids.every((id) => REPRODUCED_CRATE_LICENSES.includes(id)),
  );
  if (reproducible.length === 0) return 'no license this document reproduces';
  if (reproducible.some((ids) => ids.every((id) => id === 'Apache-2.0'))) return null;
  if ('copyright' in crate) return null;
  return 'no recorded `copyright`, which every license this document reproduces for it requires';
}

function assertCratesAttributable(crates, source) {
  const problems = crates.flatMap((crate) => {
    const problem = crateAttributionProblem(crate);
    return problem ? [`${crate.name}@${crate.version} (${crate.license}): ${problem}`] : [];
  });
  if (problems.length > 0) {
    throw new Error(
      `${source} lists crates this document cannot attribute: ${problems.join('; ')}. ` +
        "Copy each crate's copyright line from its license file into `copyright`, or set it to null when the file names no holder. " +
        `A crate that cannot be distributed under ${REPRODUCED_CRATE_LICENSE_LIST} alone needs its other license texts reproduced in this document before it ships.`,
    );
  }
}

function holderSuffix(crate) {
  if (crate.copyright === null) return ' — (the license file names no copyright holder)';
  return crate.copyright ? ` — ${crate.copyright}` : '';
}

function bundledRustCratesSection() {
  if (!existsSync(NATIVE_CONFIG_CARGO_LOCK)) {
    throw new Error(
      `Cargo.lock not found at ${NATIVE_CONFIG_CARGO_LOCK} — cannot attribute the ` +
        'native-config addon Rust crates.',
    );
  }
  const pkgs = parseCargoLockPackages(NATIVE_CONFIG_CARGO_LOCK).filter(
    (p) => p.name !== NATIVE_CONFIG_CRATE,
  );

  const unclassified = [];
  for (const { name } of pkgs) {
    const matches =
      Number(name in RUST_RUNTIME_CRATES) +
      Number(RUST_COMPILE_TIME_CRATES.has(name)) +
      Number(RUST_DEV_CRATES.has(name));
    if (matches !== 1) unclassified.push(`${name} (in ${matches} of 3 sets)`);
  }
  if (unclassified.length > 0) {
    throw new Error(
      'native-config Cargo.lock has crates not classified exactly once in ' +
        'scripts/generate-third-party-notices.mjs (RUST_RUNTIME_CRATES / ' +
        `RUST_COMPILE_TIME_CRATES / RUST_DEV_CRATES):\n  ${unclassified.join('\n  ')}\n` +
        'Classify each: runtime-linked → attribute in RUST_RUNTIME_CRATES; ' +
        'proc-macro/build → RUST_COMPILE_TIME_CRATES; test-only → RUST_DEV_CRATES.',
    );
  }

  const runtime = pkgs
    .filter((p) => p.name in RUST_RUNTIME_CRATES)
    .sort((a, b) => byteCompare(a.name, b.name) || byteCompare(a.version, b.version));
  assertCratesAttributable(
    runtime.map((p) => ({ ...p, ...RUST_RUNTIME_CRATES[p.name] })),
    'RUST_RUNTIME_CRATES in scripts/generate-third-party-notices.mjs',
  );

  const lines = [
    `The native harness-config addon's \`.node\` binaries statically link the Rust crates below. Each is redistributed under the license shown; every license here is ${REPRODUCED_CRATE_LICENSE_LIST}, whose full texts are reproduced elsewhere in this document (for dual- or multi-licensed crates OpenKnowledge elects a reproduced license). A crate with no Apache-2.0 option shows the copyright line from its license file. Compile-time-only crates (proc-macros, build scripts) and test-only dev-dependencies are not listed — their code is not present in the distributed binary. Versions track \`packages/native-config/Cargo.lock\`.`,
    '',
  ];
  for (const { name, version } of runtime) {
    const meta = RUST_RUNTIME_CRATES[name];
    lines.push(
      `- \`${name}@${version}\` — ${meta.license} — ${meta.repository}${holderSuffix(meta)}`,
    );
  }
  return lines.join('\n');
}

function fenced(text) {
  const runs = text.match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return [fence, text, fence].join('\n');
}

const FONT_FILE = /\.(?:woff2?|ttf|otf|eot|pfb)$/i;

const EXCALIDRAW_FONT_DIR = (family) => new RegExp(`^dist/(?:dev|prod)/fonts/${family}/`);

const FONTS_IN_PACKAGES = {
  katex: [
    {
      family: 'KaTeX fonts',
      files: /(?:^|\/)fonts\//,
      license: 'OFL-1.1',
      notice: [
        'Copyright (c) 2009-2010, Design Science, Inc. (<www.mathjax.org>)',
        'Copyright (c) 2014-2018 Khan Academy (<www.khanacademy.org>),',
        'with Reserved Font Names KaTeX_AMS, KaTeX_Caligraphic, KaTeX_Fraktur, KaTeX_Main, KaTeX_Math, KaTeX_SansSerif, KaTeX_Script, KaTeX_Size1, KaTeX_Size2, KaTeX_Size3, KaTeX_Size4 and KaTeX_Typewriter.',
      ],
    },
  ],
  '@excalidraw/excalidraw': [
    {
      family: 'Assistant',
      files: EXCALIDRAW_FONT_DIR('Assistant'),
      license: 'OFL-1.1',
      notice: [
        'Copyright 2020 The Assistant Project Authors (https://github.com/hafontia/Assistant).',
        "Copyright 2010 The Source Sans Pro Authors (https://github.com/adobe-fonts/source-sans-pro), with Reserved Font Name 'Source'. Source is a trademark of Adobe Systems Incorporated in the United States and/or other countries.",
      ],
    },
    {
      family: 'Cascadia Code',
      files: EXCALIDRAW_FONT_DIR('Cascadia'),
      license: 'OFL-1.1',
      notice: [
        'Copyright (c) 2019 - Present, Microsoft Corporation, with Reserved Font Name Cascadia Code.',
      ],
    },
    {
      family: 'Comic Shanns',
      files: EXCALIDRAW_FONT_DIR('ComicShanns'),
      license: 'MIT',
      notice: [
        'Copyright (c) 2018 Shannon Miwa',
        'Copyright (c) 2023 Jesus Gonzalez',
        'Copyright (c) 2023 Rodrigo Batista de Moraes',
        'Copyright (c) 2024 Fini Jastrow',
        'Copyright (c) 2024 Kyle Beechly',
      ],
    },
    {
      family: 'Excalifont',
      files: EXCALIDRAW_FONT_DIR('Excalifont'),
      license: 'OFL-1.1',
      notice: [
        'Copyright (c) 2024 by Excalidraw. All rights reserved.',
        'Excalifont is a trademark of Excalidraw.',
      ],
    },
    {
      family: 'Liberation Sans 1.05',
      files: EXCALIDRAW_FONT_DIR('Liberation'),
      license: 'LIBERATION-1',
      notice: [
        'Digitized data copyright (c) 2007 Ascender Corporation. All rights reserved.',
        'Copyright (c) 2007 Red Hat, Inc. All rights reserved. LIBERATION is a trademark of Red Hat, Inc.',
      ],
    },
    {
      family: 'Lilita One',
      files: EXCALIDRAW_FONT_DIR('Lilita'),
      license: 'OFL-1.1',
      notice: [
        'Copyright (c) 2011 Juan Montoreano (juan@remolacha.biz), with Reserved Font Names "Lilita One"',
      ],
    },
    {
      family: 'Nunito',
      files: EXCALIDRAW_FONT_DIR('Nunito'),
      license: 'OFL-1.1',
      notice: ['Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito)'],
    },
    {
      family: 'Virgil',
      files: EXCALIDRAW_FONT_DIR('Virgil'),
      license: 'OFL-1.1',
      notice: ['Copyright (c) 2011 by Your Own Font Foundry. All rights reserved.'],
    },
    {
      family: 'Xiaolai SC',
      files: EXCALIDRAW_FONT_DIR('Xiaolai'),
      license: 'OFL-1.1',
      notice: [
        'Copyright 2020-2024 LXGW (https://github.com/lxgw/kose-font)',
        'Copyright 2014 Nozomi Seto (https://ja.osdn.net/projects/setofont/)',
      ],
    },
  ],
};

const FONT_PACKAGES_NOT_SHIPPED = new Set(['pdfjs-dist']);

const FONT_LICENSE_TERMS = {
  'OFL-1.1':
    'SIL Open Font License, Version 1.1; the license text is reproduced at the end of this section.',
  MIT: 'MIT License; the permission notice is reproduced in the MIT License section of this document.',
  'LIBERATION-1':
    'Liberation font software license agreement: GNU GPL version 2 with the exceptions the agreement sets out. The agreement is reproduced at the end of this section and the GPL version 2 text in its own section. Upstream source: https://github.com/liberationfonts/liberation-1.7-fonts/blob/29a6b7d3e06db1539af34f5cee9a2d688c98e641/releases/liberation-fonts-1.05.tar.gz.',
};

function listFontFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listFontFiles(path, base, out);
    else if (FONT_FILE.test(entry.name)) out.push(relative(base, path).split('\\').join('/'));
  }
  return out.sort(byteCompare);
}

function classifyEmbeddedFonts(entries) {
  const credited = [];
  const unclassified = [];
  for (const e of entries) {
    if (e.category === 'OFL-1.1' || FONT_PACKAGES_NOT_SHIPPED.has(e.pkg.name)) continue;
    const files = listFontFiles(e.dir);
    if (files.length === 0) continue;
    const families = FONTS_IN_PACKAGES[e.pkg.name] || [];
    const used = new Set();
    for (const file of files) {
      const family = families.find((f) => f.files.test(file));
      if (family) used.add(family);
      else unclassified.push(`${e.pkg.name}@${e.pkg.version}: ${file}`);
    }
    if (used.size > 0) {
      credited.push({ pkg: e.pkg, families: families.filter((f) => used.has(f)) });
    }
  }
  if (unclassified.length > 0) {
    throw new Error(
      'Font files ship inside packages whose license entry does not cover them:\n  ' +
        `${unclassified.join('\n  ')}\n` +
        'Add the font family to FONTS_IN_PACKAGES in scripts/generate-third-party-notices.mjs, ' +
        "with the copyright and license from the font's name table or its upstream project, or " +
        'add the package to FONT_PACKAGES_NOT_SHIPPED when no build copies its fonts.',
    );
  }
  return credited;
}

function embeddedFontsSection(credited, texts) {
  const lines = [
    '## Fonts shipped inside other packages',
    '',
    "The packages below are listed elsewhere in this document under their package license, but the fonts they ship carry their own copyright notices and licenses, reproduced here. The React app frontend serves these fonts from `packages/cli/dist/public/`, and the desktop app also carries KaTeX's package in `app.asar`.",
    '',
  ];
  for (const { pkg, families } of credited) {
    lines.push(`### Fonts in \`${pkg.name}\` ${pkg.version}`, '');
    for (const f of families) {
      lines.push(`**${f.family}** — ${FONT_LICENSE_TERMS[f.license]}`, '');
      lines.push(fenced(f.notice.join('\n')), '');
    }
  }
  const licenses = new Set(credited.flatMap(({ families }) => families.map((f) => f.license)));
  if (licenses.has('OFL-1.1')) {
    lines.push('### SIL Open Font License, Version 1.1', '', fenced(texts.ofl), '');
  }
  if (licenses.has('LIBERATION-1')) {
    lines.push('### Liberation font software license agreement', '', fenced(texts.liberation), '');
  }
  return { text: lines.join('\n'), needsGpl2: licenses.has('LIBERATION-1') };
}

function zstdEntry(entry, texts) {
  const version = entry.pkg['mongodb:zstd_version'];
  if (!version) {
    throw new Error(
      `${entry.pkg.name}@${entry.pkg.version} no longer declares the zstd version it compiles ` +
        "(`mongodb:zstd_version` in its package.json). Read the version from the package's build " +
        'scripts and update zstdEntry in scripts/generate-third-party-notices.mjs.',
    );
  }
  return [
    `### \`zstd@${version}\`, compiled into \`${entry.pkg.name}\` ${entry.pkg.version}`,
    'Homepage: https://github.com/facebook/zstd',
    '',
    "Licensed under BSD-3-Clause OR GPL-2.0-only; OpenKnowledge distributes it under the BSD 3-Clause License, reproduced below from zstd's LICENSE. The zstd library is statically linked into the addon binary, which the macOS desktop app ships in `Contents/Resources/app.asar.unpacked/` and `Contents/Resources/cli/dist/assets/`. The npm CLI tarball and the Windows and Linux desktop packages do not include it.",
    '',
    fenced(texts.zstd),
  ].join('\n');
}

function readNoticesSnapshot(pkgName, version, missingRemedy) {
  const snapshotName = `${pkgName.replace(/^@/, '').replace('/', '-')}-${version}.json`;
  const relPath = `scripts/notices-data/${snapshotName}`;
  const snapshotPath = join(SCRIPT_DIR, 'notices-data', snapshotName);
  if (!existsSync(snapshotPath)) {
    throw new Error(`No snapshot for ${pkgName}@${version} at ${relPath}. ${missingRemedy}`);
  }
  const snapshot = readJson(snapshotPath);
  if (snapshot.package !== pkgName || snapshot.version !== version) {
    throw new Error(
      `${relPath} records ${snapshot.package}@${snapshot.version}, not ${pkgName}@${version}. ` +
        'Set its `package` and `version` to the release its records were read from, and name the file after that release.',
    );
  }
  return { snapshot, relPath };
}

function keyringEntry(entry) {
  const { snapshot, relPath } = readNoticesSnapshot(
    entry.pkg.name,
    entry.pkg.version,
    'Its .node binaries statically link Rust crates that must be attributed. Check out ' +
      'https://github.com/Brooooooklyn/keyring-node at the matching tag and follow the `derivation` ' +
      'field of the previous snapshot to write a new one.',
  );
  assertCratesAttributable(snapshot.crates, relPath);
  const lines = [
    `### Rust crates and C libraries in \`${entry.pkg.name}\` ${entry.pkg.version}`,
    `Homepage: ${snapshot.source}`,
    '',
    `The keyring addon's \`.node\` binaries statically link the Rust crates below, resolved from the addon's \`Cargo.lock\` for the targets whose binaries the desktop packages bundle (${snapshot.targets.join(', ')}). Each is redistributed under ${REPRODUCED_CRATE_LICENSE_LIST}, whose full texts are reproduced elsewhere in this document; for a crate offered under several licenses OpenKnowledge elects one of those. A crate with no Apache-2.0 option shows the copyright line from its license file. Compile-time-only crates are not listed.`,
    '',
  ];
  for (const crate of snapshot.crates) {
    lines.push(
      `- \`${crate.name}@${crate.version}\` — ${crate.license} — ${crate.repository}${holderSuffix(crate)}`,
    );
  }
  for (const lib of snapshot.vendoredC) {
    lines.push(
      '',
      `\`${lib.name}@${lib.version}\` is compiled from source into the ${lib.targets.join(' and ')} binaries by \`${lib.vendoredBy}\`. It is licensed under ${lib.license}; OpenKnowledge distributes it under ${lib.elected}, whose text is reproduced in its own section. Corresponding source: ${lib.source} (the crate's \`vendor/dbus\` directory). The source files compiled into the binaries carry these copyright notices:`,
      '',
      fenced(lib.copyrights.join('\n')),
    );
    for (const notice of lib.notices) {
      lines.push('', `\`${notice.file}\` also carries this notice:`, '', fenced(notice.text));
    }
  }
  return lines.join('\n');
}

function shippedVersionsOf(entries, name) {
  return entries
    .filter((e) => e.pkg.name === name)
    .sort((a, b) => byteCompare(a.pkg.version, b.pkg.version));
}

function nativeLibrariesSection(entries, texts) {
  const keyrings = shippedVersionsOf(entries, '@napi-rs/keyring');
  const parts = [
    ...shippedVersionsOf(entries, '@mongodb-js/zstd').map((e) => zstdEntry(e, texts)),
    ...keyrings.map(keyringEntry),
  ];
  if (parts.length === 0) return null;
  return {
    text: [
      '## Libraries compiled into bundled native addons',
      '',
      'The native addons below are listed elsewhere in this document under their package license. Their binaries also contain the libraries listed here, compiled in from source.',
      '',
      parts.join('\n\n'),
    ].join('\n'),
    needsGpl2: keyrings.length > 0,
  };
}

function parseGrammarNotice(text) {
  const byFile = new Map();
  for (const chunk of text.split(/^={100,}$/m)) {
    const body = chunk.split(/^-{100,}$/m);
    if (body.length < 2) continue;
    const header = body[0];
    const files = /^Files:\s+(.+)$/m.exec(header)?.[1];
    if (!files) continue;
    const block = {
      licenseUrl: /^License:\s+(\S+)/m.exec(header)?.[1] ?? null,
      spdx: /^SPDX:\s+(\S+)/m.exec(header)?.[1] ?? 'NOASSERTION',
      text: body.slice(1).join('\n').replace(/\r\n/g, '\n').trim(),
    };
    for (const file of files.split(',')) byFile.set(file.trim().replace(/\.json$/, ''), block);
  }
  return byFile;
}

const SHIKI_TM_GRAMMARS = {
  '3.23.0': '1.31.0',
};

const NODE_LIBLZMA_COPYRIGHT = {
  '2.2.0': 'Copyright (C) 2014-2015 Olivier Orabona <olivier.orabona@gmail.com>',
};

function nodeLiblzmaCopyright(pkg) {
  const line = NODE_LIBLZMA_COPYRIGHT[pkg.version];
  if (!line) {
    throw new Error(
      `node-liblzma@${pkg.version} has no recorded copyright line. Its LICENSE names no holder, so read ` +
        'the notice from its source headers (src/bindings/module.cpp) and add it to NODE_LIBLZMA_COPYRIGHT ' +
        'in scripts/generate-third-party-notices.mjs. The desktop About panel and `ok --version` repeat it.',
    );
  }
  return line;
}

const LICENSE_STEWARD = /Free Software Foundation, Inc\./;

function namesHolder(block) {
  return /\p{L}/u.test(block.replace(COPYRIGHT_MARKS, ''));
}

function grammarCopyrights(text) {
  return extractCopyrights(text).filter(
    (block) => !LICENSE_STEWARD.test(block) && namesHolder(block),
  );
}

function isNoticeLine(line) {
  return COPYRIGHT_LINE.test(line) || TEMPLATE_TOKENS.test(line);
}

function licenseWording(text) {
  return text
    .split('\n')
    .filter((line) => !isNoticeLine(line.trim()))
    .join(' ')
    .replace(/[[{<][^\]}>]{0,80}[\]}>]/g, '[]')
    .replace(/\s+/g, ' ')
    .trim();
}

const COMMIT_IN_URL = /\/(?:blob|tree)\/([0-9a-f]{40})(?:\/|$)/;

function commitProblem(field, statedUrl, source) {
  const sourceCommit = COMMIT_IN_URL.exec(source)?.[1];
  if (!sourceCommit) {
    return `cannot be checked, because tm-grammars records no commit in its source ${source}; teach commitProblem in scripts/generate-third-party-notices.mjs how to pin that source`;
  }
  if (COMMIT_IN_URL.exec(statedUrl)?.[1] !== sourceCommit) {
    return `reads ${field} at a commit other than the one tm-grammars records (${sourceCommit})`;
  }
  return null;
}

function invalidGrammarRecord(record, source) {
  if (record === null || typeof record !== 'object') return 'is not an object';
  if (typeof record.url !== 'string') return 'has no `url`';
  if (record.license !== null && (typeof record.text !== 'string' || record.text.trim() === '')) {
    return 'names a license but quotes no `text`';
  }
  return record.via
    ? commitProblem('`via`', record.via, source)
    : commitProblem('`url`', record.url, source);
}

function invalidNoticeRecord(record, source) {
  if (record === null || typeof record !== 'object') return 'is not an object';
  if (typeof record.url !== 'string') return 'has no `url`';
  if (typeof record.text !== 'string' || record.text.trim() === '') return 'quotes no `text`';
  return commitProblem('`url`', record.url, source);
}

const UNUSABLE_RECORD_REMEDY =
  "Re-read each from the grammar's source repository at the commit tm-grammars records, as the snapshot's `derivation` fields describe.";

function upstreamGrammarLicenses(tmVersion, names, records, recorded, relPath) {
  const missing = names.filter((name) => !Object.hasOwn(recorded, name));
  if (missing.length > 0) {
    throw new Error(
      `tm-grammars@${tmVersion} collects no license for ${missing.join(', ')}, and ` +
        `${relPath} records none from their upstream repositories. Read each ` +
        "grammar's source repository at the commit tm-grammars records and add its license there, " +
        'following the `derivation` field of the previous snapshot.',
    );
  }
  const invalid = names
    .map((name) => [name, invalidGrammarRecord(recorded[name], records.get(name).source)])
    .filter(([, problem]) => problem);
  if (invalid.length > 0) {
    throw new Error(
      `${relPath} has unusable records: ` +
        `${invalid.map(([name, problem]) => `${name} ${problem}`).join('; ')}. ${UNUSABLE_RECORD_REMEDY}`,
    );
  }
  return new Map(names.map((name) => [name, recorded[name]]));
}

function upstreamGrammarNotices(shipped, records, recorded, relPath) {
  const invalid = Object.keys(recorded)
    .map((name) => [
      name,
      shipped.includes(name)
        ? invalidNoticeRecord(recorded[name], records.get(name).source)
        : 'names a grammar this Shiki release does not ship; correct the name or remove the record',
    ])
    .filter(([, problem]) => problem);
  if (invalid.length > 0) {
    throw new Error(
      `${relPath} has unusable NOTICE records: ` +
        `${invalid.map(([name, problem]) => `${name} ${problem}`).join('; ')}. ${UNUSABLE_RECORD_REMEDY}`,
    );
  }
  return new Map(Object.entries(recorded));
}

async function shikiGrammarsSection(entries, texts) {
  const langsEntries = shippedVersionsOf(entries, '@shikijs/langs');
  if (langsEntries.length === 0) return null;
  if (langsEntries.length > 1) {
    throw new Error(
      `Several versions of @shikijs/langs ship (${langsEntries.map((e) => e.pkg.version).join(', ')}), ` +
        'but shikiGrammarsSection in scripts/generate-third-party-notices.mjs credits grammars from a single ' +
        'tm-grammars release. Resolve one version, or credit each version from its own tm-grammars release.',
    );
  }
  const [langs] = langsEntries;
  const tmDir = resolvePackageDir('tm-grammars', REPO_ROOT);
  if (!tmDir) {
    throw new Error(
      `${langs.pkg.name}@${langs.pkg.version} ships TextMate grammars, but tm-grammars is not installed. ` +
        'It is a root devDependency pinned to the version that Shiki release builds its grammars from; run `pnpm install`.',
    );
  }
  const tmPkg = readJson(join(tmDir, 'package.json'));
  const builtFrom = SHIKI_TM_GRAMMARS[langs.pkg.version];
  if (builtFrom !== tmPkg.version) {
    throw new Error(
      `${langs.pkg.name}@${langs.pkg.version} builds its grammars from ` +
        `${builtFrom ? `tm-grammars@${builtFrom}` : 'a tm-grammars release SHIKI_TM_GRAMMARS does not record'}, ` +
        `but tm-grammars@${tmPkg.version} is installed. Record the tm-grammars version this Shiki release lists in ` +
        'its pnpm-lock.yaml in SHIKI_TM_GRAMMARS in scripts/generate-third-party-notices.mjs, pin the root ' +
        'tm-grammars devDependency to it, then regenerate.',
    );
  }
  const { grammars, injections } = await import('tm-grammars');
  const records = new Map([...grammars, ...injections].map((g) => [g.name, g]));
  const distDir = join(langs.dir, 'dist');
  const shipped = readdirSync(distDir)
    .filter((f) => f.endsWith('.mjs') && f !== 'index.mjs')
    .filter((f) => readFileSync(join(distDir, f), 'utf8').includes('JSON.parse('))
    .map((f) => f.slice(0, -'.mjs'.length))
    .sort(byteCompare);
  if (shipped.length === 0) {
    throw new Error(
      `No grammar modules found in ${langs.pkg.name}@${langs.pkg.version}/dist. Its layout has changed; ` +
        'update how shikiGrammarsSection in scripts/generate-third-party-notices.mjs finds the shipped grammars.',
    );
  }
  const unknown = shipped.filter((name) => !records.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `${langs.pkg.name}@${langs.pkg.version} ships grammars with no record in tm-grammars@${tmPkg.version}: ` +
        `${unknown.join(', ')}. Pin the root tm-grammars devDependency to the version this Shiki release ` +
        'lists in its pnpm-lock.yaml, then regenerate.',
    );
  }
  const notice = parseGrammarNotice(readFileSync(join(tmDir, 'NOTICE'), 'utf8'));
  const groups = new Map();
  const undeclared = [];
  for (const name of shipped) {
    const block = notice.get(name);
    if (!block) {
      undeclared.push(name);
      continue;
    }
    if (!groups.has(block)) groups.set(block, []);
    groups.get(block).push(name);
  }
  const unmatched = undeclared.filter((name) => records.get(name).license);
  if (unmatched.length > 0) {
    throw new Error(
      `tm-grammars@${tmPkg.version} records a license for ${unmatched.map((n) => `${n} (${records.get(n).license})`).join(', ')}, ` +
        'but no NOTICE block names their files. Its NOTICE format has changed; update parseGrammarNotice in ' +
        'scripts/generate-third-party-notices.mjs.',
    );
  }
  const { snapshot, relPath } = readNoticesSnapshot(
    'tm-grammars',
    tmPkg.version,
    "It records the licenses tm-grammars does not collect and the NOTICE files of the Apache-2.0 grammars' upstream repositories. " +
      "Read each grammar's source repository at the commit tm-grammars records, following the `derivation` fields of the previous snapshot, to write a new one.",
  );
  const upstream = upstreamGrammarLicenses(
    tmPkg.version,
    undeclared.filter((name) => records.get(name).source),
    records,
    snapshot.grammars,
    relPath,
  );
  const notices = upstreamGrammarNotices(shipped, records, snapshot.notices.grammars, relPath);
  const quoted = new Map();
  for (const [name, record] of upstream) {
    if (record.license === null) continue;
    const key = `${record.license}\n${record.text}`;
    if (!quoted.has(key)) {
      const block = { spdx: record.license, licenseUrl: null, text: record.text };
      quoted.set(key, block);
      groups.set(block, []);
    }
    groups.get(quoted.get(key)).push(name);
  }
  const sources = `Copyright notices and license texts are taken from \`tm-grammars\` ${tmPkg.version}, which collects them, except for a grammar whose entry links where its license is stated. tm-grammars collects none for those, so each license statement is quoted from its upstream repository at the commit tm-grammars records: from the file linked, or from the files the quote names when the link is to the repository. A grammar its upstream repository calls a port of another project, and that states no license of its own, is credited under that project's license, with a link to the statement naming the port. An Apache-2.0 grammar whose upstream repository has a NOTICE file at the commit tm-grammars records also shows that file's text, quoted from the file linked.`;
  const lines = [
    '## TextMate grammars bundled by Shiki',
    '',
    `\`${langs.pkg.name}\` ${langs.pkg.version} ships the TextMate grammars below for syntax highlighting. Each grammar listed under a \`License:\` line comes from its own upstream project under that license. ${sources} The MIT, ISC and Apache-2.0 texts are reproduced in their sections of this document, and the GPL-3.0 text, under which the GPL-3.0 grammars' upstream authors license them, is the shipped LICENSE file. Every other license text is reproduced with its grammars, as is any MIT license text or statement that names no copyright holder and any Apache-2.0 or GPL-3.0 text that differs from the standard one.`,
    '',
  ];
  const sortedGroups = [...groups.entries()].sort(([, a], [, b]) => byteCompare(a[0], b[0]));
  const standardWording = new Map([
    ['Apache-2.0', licenseWording(texts.apache)],
    ['GPL-3.0', licenseWording(texts.gpl3)],
  ]);
  for (const [block, names] of sortedGroups) {
    lines.push(`### Grammars: ${names.map((n) => `\`${n}\``).join(', ')}`);
    const license =
      block.spdx === 'NOASSERTION'
        ? 'no SPDX identifier upstream; the license text follows'
        : block.spdx;
    lines.push(`License: ${license}${block.licenseUrl ? ` — ${block.licenseUrl}` : ''}`, '');
    for (const name of names) {
      const record = upstream.get(name);
      const stated = !record?.license
        ? ''
        : record.via
          ? `; a port of the project whose license is stated in ${record.url} (${record.via})`
          : `; license stated in ${record.url}`;
      lines.push(`- \`${name}\` — ${records.get(name).source}${stated}`);
    }
    lines.push('');
    const copyrights = grammarCopyrights(block.text);
    const wording = licenseWording(block.text);
    const reproducedElsewhere =
      block.spdx === 'MIT'
        ? copyrights.length > 0
        : wording !== '' && standardWording.get(block.spdx)?.includes(wording);
    if (!reproducedElsewhere) lines.push(fenced(block.text));
    else if (copyrights.length > 0) lines.push(...copyrights);
    else
      lines.push(
        '_(The upstream license text is the standard text and names no copyright holder.)_',
      );
    lines.push('');
    for (const name of names) {
      const notice = notices.get(name);
      if (notice) lines.push(`NOTICE of \`${name}\` (${notice.url}):`, '', fenced(notice.text), '');
    }
  }
  const unlicensed = [...upstream.keys()].filter((name) => upstream.get(name).license === null);
  if (unlicensed.length > 0) {
    lines.push('### Grammars with no license upstream', '');
    lines.push(
      'At the commits linked, the upstream repositories of these grammars have no license file, no license field in package.json, and no license or copyright statement in a README or the grammar file. They are listed with their sources for attribution.',
      '',
    );
    for (const name of unlicensed) lines.push(`- \`${name}\` — ${records.get(name).source}`);
    lines.push('');
  }
  const unsourced = undeclared.filter((name) => !records.get(name).source);
  if (unsourced.length > 0) {
    lines.push('### Grammars with no upstream source', '');
    lines.push(`tm-grammars ${tmPkg.version} records no upstream project for these grammars.`, '');
    for (const name of unsourced) lines.push(`- \`${name}\``);
    lines.push('');
  }
  return lines.join('\n');
}

async function build() {
  const LICENSE_TEXTS = loadLicenseTexts();
  const collected = collectClosure();

  const seenKeys = new Set();
  const grouped = new Map();
  for (const { dir, pkg } of collected) {
    if (!pkg.name || !pkg.version) continue;
    const key = `${pkg.name}@${pkg.version}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const spdx = normalizeSpdx(pkg.license || pkg.licenses, pkg.name);
    const category = FIRST_PARTY_GPL_PACKAGES.has(pkg.name) ? 'FIRST_PARTY_GPL' : categorize(spdx);
    const entry = {
      pkg,
      dir,
      spdx,
      category,
      licenseText: readLicenseText(dir),
      noticeText: readNoticeText(dir),
    };
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(entry);
  }
  for (const arr of grouped.values()) {
    arr.sort((a, b) => byteCompare(a.pkg.name, b.pkg.name));
  }

  const lines = [];
  const push = (...xs) => lines.push(...xs);
  const hr = () => push('---', '');

  push('# Third-Party Notices', '');
  push(
    '`@inkeep/open-knowledge` (npm CLI) and `@inkeep/open-knowledge-desktop` (Electron app) bundle source code from the third-party packages listed below, each redistributed under its own license. Some of these packages also carry material under separate terms, credited in its own section: fonts under "Fonts shipped inside other packages", libraries compiled into native addons under "Libraries compiled into bundled native addons", and syntax grammars under "TextMate grammars bundled by Shiki", which also lists the grammars that have no license upstream. Where a license requires its copyright notice and license text to accompany the software, they are reproduced here.',
    '',
  );
  push(
    'This file is generated. **Do not edit by hand.** Regenerate with `pnpm run notices` from the repo root, then commit the result.',
    '',
  );
  hr();

  if (grouped.has('OFL-1.1')) {
    push('## SIL Open Font License (OFL-1.1) — bundled fonts', '');
    push(
      'The font packages below are bundled into the React app frontend (`packages/cli/dist/public/assets/*.woff2`) and require the full OFL-1.1 license text to ship with any distribution that contains them. The Reserved Font Names cannot be used in derivative font names.',
      '',
    );
    for (const e of grouped.get('OFL-1.1')) {
      push(fullLicenseEntry(e), '');
    }
    hr();
  }

  push('## LGPL-3.0 — transitive optional dependency', '');
  const liblzmaEntries = [...grouped.values()].flat().filter((e) => e.pkg.name === 'node-liblzma');
  const lgplResolved = liblzmaEntries.find((e) => e.category === 'LGPL');
  if (!lgplResolved) {
    const found =
      liblzmaEntries.length > 0
        ? liblzmaEntries
            .map(
              (e) => `node-liblzma@${e.pkg.version} is licensed ${e.spdx} (category ${e.category})`,
            )
            .join(', ')
        : 'node-liblzma is not in the shipped dependency closure';
    throw new Error(
      `${found}, but the LGPL-3.0 section of scripts/generate-third-party-notices.mjs states that it ships under LGPL-3.0. ` +
        'Rewrite that section to what ships now, then regenerate.',
    );
  }
  push(
    `\`node-liblzma\`@${lgplResolved.pkg.version} is an **optional** transitive dependency of \`just-bash\`, used by \`@inkeep/open-knowledge\` for sandboxed shell execution. The package is licensed under LGPL-3.0. Its JavaScript is bundled into the CLI's \`dist/\` (the \`lzma-*.mjs\` modules), so it ships in the npm CLI tarball and in every desktop package, which copies that \`dist/\`. The desktop packages also carry the \`node-liblzma\` package itself: the Windows and Linux packages inside \`app.asar\`, and the macOS app unpacked, with its separately loaded native addon, in \`Contents/Resources/app.asar.unpacked/node_modules/node-liblzma/\`. The addon contains no liblzma code of its own: it resolves liblzma at run time (the arm64 build links Homebrew's \`xz\`), so it loads only where that library is installed. The npm CLI tarball and the Windows and Linux desktop packages do not include the addon. Corresponding source for the bundled JavaScript and the addon: ${homepageOf(lgplResolved.pkg)}/tree/v${lgplResolved.pkg.version}.`,
    '',
  );
  push(nodeLiblzmaCopyright(lgplResolved.pkg), '');
  push('The full text of the GNU Lesser General Public License v3.0 follows.', '');
  push(fenced(LICENSE_TEXTS.lgpl3), '');
  hr();

  push('## Apache License, Version 2.0', '');
  push(
    'The packages and vendored source in this section are licensed under the Apache License, Version 2.0. The full text of the license is reproduced once below and applies to every entry; per-package `NOTICE` file content is reproduced inline with each entry.',
    '',
  );
  push(fenced(LICENSE_TEXTS.apache), '');
  for (const e of grouped.get('Apache-2.0') || []) {
    push(apacheEntry(e), '');
  }
  push(vendoredCodexEntry(), '');
  hr();

  push('## Bundled Rust crates (native-config addon)', '');
  push(bundledRustCratesSection(), '');
  hr();

  const shippedEntries = [...grouped.values()].flat();
  const nativeLibraries = nativeLibrariesSection(shippedEntries, LICENSE_TEXTS);
  if (nativeLibraries) {
    push(nativeLibraries.text, '');
    hr();
  }
  const credited = classifyEmbeddedFonts(shippedEntries).sort((a, b) =>
    byteCompare(a.pkg.name, b.pkg.name),
  );
  const fonts = credited.length > 0 ? embeddedFontsSection(credited, LICENSE_TEXTS) : null;
  if (fonts) {
    push(fonts.text);
    hr();
  }
  if (nativeLibraries?.needsGpl2 || fonts?.needsGpl2) {
    push('## GNU General Public License, version 2', '');
    push(
      'The libraries and fonts above that are distributed under the GNU GPL version 2, or version 2 or later, are covered by the text below.',
      '',
    );
    push(fenced(LICENSE_TEXTS.gpl2), '');
    hr();
  }
  const grammars = await shikiGrammarsSection(shippedEntries, LICENSE_TEXTS);
  if (grammars) {
    push(grammars);
    hr();
  }

  if (grouped.has('MIT')) {
    push('## MIT License', '');
    push(
      'Each package in this section is licensed under the MIT License. The full text of the permission notice is reproduced once below and applies to every entry; per-package copyright lines are listed inline.',
      '',
    );
    push(fenced(LICENSE_TEXTS.mit), '');
    for (const e of grouped.get('MIT')) {
      push(shortEntry(e), '');
    }
    hr();
  }

  if (grouped.has('ISC')) {
    push('## ISC License', '');
    push(
      'Each package in this section is licensed under the ISC License. The full text of the permission notice is reproduced once below and applies to every entry; per-package copyright lines are listed inline.',
      '',
    );
    push(fenced(LICENSE_TEXTS.isc), '');
    for (const e of grouped.get('ISC')) {
      push(shortEntry(e), '');
    }
    hr();
  }

  if (grouped.has('BSD-3-Clause')) {
    push('## BSD 3-Clause License', '');
    push(
      'Each package in this section is licensed under the BSD 3-Clause License. The full text of the conditions, disclaimer, and non-endorsement clause is reproduced once below and applies to every entry; per-package copyright lines are listed inline.',
      '',
    );
    push(fenced(LICENSE_TEXTS.bsd3), '');
    for (const e of grouped.get('BSD-3-Clause')) {
      push(shortEntry(e), '');
    }
    hr();
  }

  if (grouped.has('BSD-2-Clause')) {
    push('## BSD 2-Clause License', '');
    push(
      'Each package in this section is licensed under the BSD 2-Clause License. The full text of the conditions and disclaimer is reproduced once below and applies to every entry; per-package copyright lines are listed inline.',
      '',
    );
    push(fenced(LICENSE_TEXTS.bsd2), '');
    for (const e of grouped.get('BSD-2-Clause')) {
      push(shortEntry(e), '');
    }
    hr();
  }

  if (grouped.has('MPL-2.0')) {
    push('## Mozilla Public License 2.0', '');
    push(
      'Used at build time only — not bundled into shipped artifacts. Listed for traceability.',
      '',
    );
    for (const e of grouped.get('MPL-2.0')) {
      push(shortEntry(e), '');
    }
    hr();
  }

  const PERMISSIVE_NO_ATTR = ['BlueOak-1.0.0', '0BSD', 'WTFPL', 'Unlicense', 'CC0-1.0'];
  const noAttrEntries = [];
  for (const cat of PERMISSIVE_NO_ATTR) {
    if (grouped.has(cat)) noAttrEntries.push(...grouped.get(cat));
  }
  if (noAttrEntries.length > 0) {
    noAttrEntries.sort((a, b) => byteCompare(a.pkg.name, b.pkg.name));
    push('## Other permissive licenses', '');
    push(
      'The following packages are under licenses that do not require attribution (BlueOak-1.0.0, 0BSD, WTFPL, Unlicense, CC0-1.0). Listed for completeness and traceability.',
      '',
    );
    for (const e of noAttrEntries) {
      push(`- \`${e.pkg.name}@${e.pkg.version}\` — ${e.spdx}`);
    }
    push('');
    hr();
  }

  if (grouped.has('CC-BY-4.0')) {
    push('## Creative Commons Attribution 4.0 International (CC-BY-4.0)', '');
    push(
      'The data files below are licensed under CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/legalcode). Each entry preserves its copyright and license URI per §3(a)(1). Note: CC-BY-4.0 §5 disclaims warranties; the licensor offers the work as-is.',
      '',
    );
    for (const e of grouped.get('CC-BY-4.0')) {
      push(shortEntry(e), '');
    }
    hr();
  }

  if (grouped.has('Python-2.0')) {
    push('## Python Software Foundation License (Python-2.0)', '');
    push(
      'The packages below are licensed under the PSF License v2 (https://docs.python.org/3/license.html#psf-license). Each entry preserves its copyright notice. The license disclaims warranties and limits liability per its terms; refer to upstream for the full text.',
      '',
    );
    for (const e of grouped.get('Python-2.0')) {
      push(shortEntry(e), '');
    }
    hr();
  }

  if (grouped.has('FIRST_PARTY_GPL')) {
    push('## Inkeep first-party packages (GPL-3.0-or-later)', '');
    push(
      'The packages below are authored and published by Inkeep and are licensed under GPL-3.0-or-later, the same license as OpenKnowledge itself (see the repository LICENSE for the full text). They are listed for completeness; they are not third-party material.',
      '',
    );
    for (const e of grouped.get('FIRST_PARTY_GPL')) {
      push(shortEntry(e), '');
    }
    hr();
  }

  push('## Patched dependencies', '');
  push(
    "The following packages are patched in this repository via pnpm's `patchedDependencies` mechanism. Modifications are released under each upstream package's license. Patch files live under `patches/` in the source repo; the bundled output of every shipped artifact incorporates the patched code.",
    '',
  );
  push('| Package | Patch file |');
  push('| --- | --- |');
  for (const p of loadPatchedDeps()) {
    push(`| \`${p.name}@${p.version}\` | \`${p.patchFile}\` |`);
  }
  push('');
  hr();

  const callouts = [];
  for (const cat of ['OTHER', 'GPL', 'LGPL']) {
    if (grouped.has(cat)) callouts.push(...grouped.get(cat));
  }
  const filteredCallouts = callouts.filter((e) => e.pkg.name !== 'node-liblzma');
  if (filteredCallouts.length > 0) {
    filteredCallouts.sort((a, b) => byteCompare(a.pkg.name, b.pkg.name));
    push('## Other licenses (audit needed)', '');
    push(
      'The generator did not auto-categorize the following packages. Each requires individual review before next-release ship.',
      '',
    );
    for (const e of filteredCallouts) {
      push(`- \`${e.pkg.name}@${e.pkg.version}\` — ${e.spdx}`);
    }
    push('');
    hr();
  }
  build.lastAuditCount = filteredCallouts.length;

  push(
    '_Regenerate with `pnpm run notices`. The generator at `scripts/generate-third-party-notices.mjs` walks the production-dep closure of `packages/{cli,server,core,app,desktop}` and emits attribution for every package that ends up bundled into a shipped artifact._',
    '',
  );

  return lines.join('\n');
}

async function main() {
  const generated = await build();

  function computeHeaderDiff(existing, fresh) {
    const headerOf = (s) => new Set(s.split('\n').filter((l) => /^### `[^@]+@[^`]+`$/.test(l)));
    const a = headerOf(existing);
    const b = headerOf(fresh);
    const added = [...b].filter((h) => !a.has(h)).sort();
    const removed = [...a].filter((h) => !b.has(h)).sort();
    return { added, removed };
  }

  if (CHECK_MODE) {
    if (!existsSync(OUT_PATH)) {
      console.error(`THIRD_PARTY_NOTICES.md not found at ${OUT_PATH}`);
      console.error('Run `pnpm run notices` to regenerate.');
      exit(1);
    }
    const existing = readFileSync(OUT_PATH, 'utf8');
    if (existing !== generated) {
      const { added, removed } = computeHeaderDiff(existing, generated);
      console.error(
        `${relative(REPO_ROOT, OUT_PATH)} is out of date with the resolved dependency tree.`,
      );
      console.error('');
      if (added.length > 0) {
        console.error(`Added (${added.length}):`);
        for (const h of added.slice(0, 25)) console.error(`  + ${h.replace(/^### /, '')}`);
        if (added.length > 25) console.error(`  + ... and ${added.length - 25} more`);
        console.error('');
      }
      if (removed.length > 0) {
        console.error(`Removed (${removed.length}):`);
        for (const h of removed.slice(0, 25)) console.error(`  - ${h.replace(/^### /, '')}`);
        if (removed.length > 25) console.error(`  - ... and ${removed.length - 25} more`);
        console.error('');
      }
      if (added.length === 0 && removed.length === 0) {
        console.error(
          'No package list changes — license text, copyright extraction, or section structure differs.',
        );
        console.error('');
      }
      console.error('Run `pnpm run notices` to regenerate, then commit the result.');
      exit(1);
    }
    console.log(`${relative(REPO_ROOT, OUT_PATH)} is up to date.`);
  } else {
    writeFileSync(OUT_PATH, generated);
    console.log(
      `Wrote ${relative(REPO_ROOT, OUT_PATH)} (${Buffer.byteLength(generated, 'utf8')} bytes).`,
    );
  }

  if (build.lastAuditCount > 0 && process.env.OK_NOTICES_ALLOW_AUDIT_BUCKET !== '1') {
    console.error('');
    console.error(
      `Audit-needed bucket is non-empty (${build.lastAuditCount} package(s) with unrecognized SPDX).`,
    );
    console.error(
      'Review and either (a) add explicit handling in `categorize()` and re-run, or (b) re-run with `OK_NOTICES_ALLOW_AUDIT_BUCKET=1` after auditing.',
    );
    exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
