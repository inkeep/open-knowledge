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

const FIRST_PARTY_GPL_PACKAGES = new Set([
  '@visimer/core',
  '@visimer/dom',
]);

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

const COPYRIGHT_LINE = /^(\([cC]\)\s+)?[Cc]opyright\s+(\([cC]\)\s+)?(\d{4}|\p{Lu})/u;

const TEMPLATE_TOKENS = /\[yyyy\]|\{yyyy\}|\[name of copyright owner\]/i;

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
        if (/^[-*•]/.test(next) || /^\S+ <\S+@\S+>/.test(next) || /^copyright\b/i.test(next)) {
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
    lines.push('```');
    lines.push(e.licenseText);
    lines.push('```');
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
    lines.push('```');
    lines.push(e.noticeText);
    lines.push('```');
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
    '```',
    'OpenAI Codex',
    'Copyright 2025 OpenAI',
    '```',
  ].join('\n');
}

const NATIVE_CONFIG_CRATE = 'open-knowledge-native-config';
const NATIVE_CONFIG_CARGO_LOCK = join(REPO_ROOT, 'packages', 'native-config', 'Cargo.lock');

const RUST_RUNTIME_CRATES = {
  bitflags: { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/bitflags/bitflags' },
  'cfg-if': { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/rust-lang/cfg-if' },
  ctor: { spdx: 'Apache-2.0 OR MIT', repo: 'https://github.com/mmastrac/linktime' },
  equivalent: { spdx: 'Apache-2.0 OR MIT', repo: 'https://github.com/indexmap-rs/equivalent' },
  futures: { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/rust-lang/futures-rs' },
  'futures-channel': { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/rust-lang/futures-rs' },
  'futures-core': { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/rust-lang/futures-rs' },
  'futures-executor': {
    spdx: 'MIT OR Apache-2.0',
    repo: 'https://github.com/rust-lang/futures-rs',
  },
  'futures-io': { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/rust-lang/futures-rs' },
  'futures-sink': { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/rust-lang/futures-rs' },
  'futures-task': { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/rust-lang/futures-rs' },
  'futures-util': { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/rust-lang/futures-rs' },
  hashbrown: { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/rust-lang/hashbrown' },
  indexmap: { spdx: 'Apache-2.0 OR MIT', repo: 'https://github.com/indexmap-rs/indexmap' },
  itoa: { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/dtolnay/itoa' },
  libloading: { spdx: 'ISC', repo: 'https://github.com/nagisa/rust_libloading' },
  memchr: { spdx: 'Unlicense OR MIT', repo: 'https://github.com/BurntSushi/memchr' },
  napi: { spdx: 'MIT', repo: 'https://github.com/napi-rs/napi-rs' },
  'napi-sys': { spdx: 'MIT', repo: 'https://github.com/napi-rs/napi-rs' },
  'nohash-hasher': {
    spdx: 'Apache-2.0 OR MIT',
    repo: 'https://github.com/paritytech/nohash-hasher',
  },
  'pin-project-lite': {
    spdx: 'Apache-2.0 OR MIT',
    repo: 'https://github.com/taiki-e/pin-project-lite',
  },
  'rustc-hash': { spdx: 'Apache-2.0 OR MIT', repo: 'https://github.com/rust-lang/rustc-hash' },
  serde: { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/serde-rs/serde' },
  serde_core: { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/serde-rs/serde' },
  serde_json: { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/serde-rs/json' },
  slab: { spdx: 'MIT', repo: 'https://github.com/tokio-rs/slab' },
  toml_datetime: { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/toml-rs/toml' },
  toml_edit: { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/toml-rs/toml' },
  toml_parser: { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/toml-rs/toml' },
  toml_writer: { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/toml-rs/toml' },
  'windows-link': { spdx: 'MIT OR Apache-2.0', repo: 'https://github.com/microsoft/windows-rs' },
  winnow: { spdx: 'MIT', repo: 'https://github.com/winnow-rs/winnow' },
  zmij: { spdx: 'MIT', repo: 'https://github.com/dtolnay/zmij' },
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

  const lines = [
    "The native harness-config addon's `.node` binaries statically link the Rust crates below. Each is redistributed under the license shown; every license here is MIT, Apache-2.0, or ISC, whose full texts are reproduced elsewhere in this document (for dual- or multi-licensed crates OpenKnowledge elects a reproduced license). Compile-time-only crates (proc-macros, build scripts) and test-only dev-dependencies are not listed — their code is not present in the distributed binary. Versions track `packages/native-config/Cargo.lock`.",
    '',
  ];
  for (const { name, version } of runtime) {
    const meta = RUST_RUNTIME_CRATES[name];
    lines.push(`- \`${name}@${version}\` — ${meta.spdx} — ${meta.repo}`);
  }
  return lines.join('\n');
}

function build() {
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
    '`@inkeep/open-knowledge` (npm CLI) and `@inkeep/open-knowledge-desktop` (Electron app) bundle source code from the third-party packages listed below. Each package is redistributed under its own license; the relevant copyright notice and license text are reproduced here as required.',
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

  push('## LGPL-3.0 — transitive optional binary', '');
  const lgplResolved = (grouped.get('LGPL') || []).find((e) => e.pkg.name === 'node-liblzma');
  push(
    `\`node-liblzma\`${
      lgplResolved ? `@${lgplResolved.pkg.version}` : ''
    } is an **optional** transitive dependency of \`just-bash\`, used by \`@inkeep/open-knowledge\` for sandboxed shell execution. The package is licensed under LGPL-3.0. For the npm CLI tarball, \`node-liblzma\` is not bundled — it is resolved from the public npm registry at install time on platforms where the native build succeeds. For the Electron desktop \`.app\`, whether the binary lands in \`Resources/app.asar.unpacked/\` depends on the build host's toolchain at packaging time; if present, the binary ships subject to LGPL-3.0 obligations. Upstream source: https://github.com/Manawyrm/node-liblzma. Corresponding source can be obtained from upstream per LGPL §6.`,
    '',
  );
  push('The full text of the GNU Lesser General Public License v3.0 follows.', '');
  push('```', LICENSE_TEXTS.lgpl3, '```', '');
  hr();

  push('## Apache License, Version 2.0', '');
  push(
    'The packages and vendored source in this section are licensed under the Apache License, Version 2.0. The full text of the license is reproduced once below and applies to every entry; per-package `NOTICE` file content is reproduced inline with each entry.',
    '',
  );
  push('```', LICENSE_TEXTS.apache, '```', '');
  for (const e of grouped.get('Apache-2.0') || []) {
    push(apacheEntry(e), '');
  }
  push(vendoredCodexEntry(), '');
  hr();

  push('## Bundled Rust crates (native-config addon)', '');
  push(bundledRustCratesSection(), '');
  hr();

  if (grouped.has('MIT')) {
    push('## MIT License', '');
    push(
      'Each package in this section is licensed under the MIT License. The full text of the permission notice is reproduced once below and applies to every entry; per-package copyright lines are listed inline.',
      '',
    );
    push('```', LICENSE_TEXTS.mit, '```', '');
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
    push('```', LICENSE_TEXTS.isc, '```', '');
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
    push('```', LICENSE_TEXTS.bsd3, '```', '');
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
    push('```', LICENSE_TEXTS.bsd2, '```', '');
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
    "The following MIT-licensed packages are patched in this repository via pnpm's `patchedDependencies` mechanism. Modifications are released under the same MIT license as the upstream package. Patch files live under `patches/` in the source repo; the bundled output of every shipped artifact incorporates the patched code.",
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

function main() {
  const generated = build();

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
  main();
}
