#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function parseOverrideBlockLines(yamlText) {
  const out = [];
  const lines = yamlText.split('\n');
  let inBlock = false;
  for (const line of lines) {
    if (/^overrides:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    const m = line.match(
      /^\s+(?:'([^']+)'|"([^"]+)"|([^\s:'"#][^:]*?))\s*:\s*(?:'([^']+)'|"([^"]+)"|(\S+?))\s*(?:#.*)?$/,
    );
    if (!m) continue;
    out.push({ key: m[1] ?? m[2] ?? m[3], value: m[4] ?? m[5] ?? m[6] });
  }
  return out;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseExactOverrides(yamlText) {
  const out = new Map();
  for (const { key, value } of parseOverrideBlockLines(yamlText)) {
    if (key.includes('@', 1)) continue;
    if (!EXACT_VERSION.test(value)) continue;
    out.set(key, value);
  }
  return out;
}

export function rangeFloor(range) {
  const m = String(range)
    .trim()
    .match(/^(\^|~|>=|)\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
  return m ? m[2] : null;
}

export function compareVersions(a, b) {
  const split = (v) => {
    const [core, ...rest] = String(v).split('-');
    return [core.split('.').map(Number), rest.length ? rest.join('-') : null];
  };
  const [ac, apre] = split(a);
  const [bc, bpre] = split(b);
  for (let i = 0; i < 3; i++) {
    if (ac[i] !== bc[i]) return ac[i] - bc[i];
  }
  if (apre === bpre) return 0;
  if (apre === null) return 1;
  if (bpre === null) return -1;
  const ai = apre.split('.');
  const bi = bpre.split('.');
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    const x = ai[i];
    const y = bi[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
      continue;
    }
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function* installedManifests(pnpmDir) {
  let dirs;
  try {
    dirs = fs.readdirSync(pnpmDir);
  } catch {
    return;
  }
  for (const dir of dirs) {
    if (dir.startsWith('.')) continue;
    const nm = path.join(pnpmDir, dir, 'node_modules');
    let top;
    try {
      top = fs.readdirSync(nm);
    } catch {
      continue;
    }
    for (const entry of top) {
      let names = [entry];
      if (entry.startsWith('@')) {
        try {
          names = fs.readdirSync(path.join(nm, entry)).map((s) => `${entry}/${s}`);
        } catch {
          continue;
        }
      }
      for (const name of names) {
        try {
          yield JSON.parse(fs.readFileSync(path.join(nm, name, 'package.json'), 'utf8'));
        } catch {
        }
      }
    }
  }
}

export function parsePackagePatterns(yamlText) {
  const patterns = [];
  const unparsed = [];
  let inBlock = false;
  for (const line of yamlText.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = line.match(/^\s+-\s*(?:'([^']+)'|"([^"]+)"|([^'"#\s]+))\s*(?:#.*)?$/);
    if (m) patterns.push(m[1] ?? m[2] ?? m[3]);
    else if (trimmed.startsWith('-')) unparsed.push(trimmed);
  }
  return { patterns, unparsed };
}

export function expandPackagePattern(root, pattern) {
  if (pattern.startsWith('!')) return null;
  if (pattern.endsWith('/*')) {
    const parent = path.join(root, pattern.slice(0, -2));
    if (pattern.slice(0, -2).includes('*')) return null;
    try {
      return fs.readdirSync(parent).map((entry) => path.join(parent, entry));
    } catch {
      return [];
    }
  }
  if (pattern.includes('*')) return null;
  return [path.join(root, pattern)];
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function* workspaceManifests(root, yamlText, onUnknownPattern, onEmptyPattern) {
  const { patterns, unparsed } = parsePackagePatterns(yamlText);
  for (const line of unparsed) onUnknownPattern(line);
  const expansions = [];
  for (const pattern of patterns) {
    const dirs = expandPackagePattern(root, pattern);
    if (dirs === null) {
      onUnknownPattern(pattern);
      continue;
    }
    expansions.push([pattern, dirs]);
  }
  const rootManifest = readManifest(root);
  if (rootManifest) yield rootManifest;
  if (expansions.length === 0) onEmptyPattern('the packages: block itself');
  for (const [pattern, dirs] of expansions) {
    let members = 0;
    for (const dir of dirs) {
      const manifest = readManifest(dir);
      if (!manifest) continue;
      members += 1;
      yield manifest;
    }
    if (members === 0) onEmptyPattern(pattern);
  }
}

export const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

export const WORKSPACE_DEPENDENCY_FIELDS = [...DEPENDENCY_FIELDS, 'devDependencies'];

const byDependantThenDep = (a, b) => a.dependant.localeCompare(b.dependant) || a.dep.localeCompare(b.dep);

export function findFloorViolations(overrides, manifests, fields = DEPENDENCY_FIELDS) {
  const seen = new Set();
  const violations = [];
  for (const manifest of manifests) {
    for (const field of fields) {
      for (const [dep, range] of Object.entries(manifest?.[field] ?? {})) {
        if (field === 'peerDependencies' && manifest?.peerDependenciesMeta?.[dep]?.optional) continue;
        const pinned = overrides.get(dep);
        if (!pinned) continue;
        const floor = rangeFloor(range);
        if (!floor) continue;
        if (compareVersions(pinned, floor) >= 0) continue;
        const dependant = manifest.version ? `${manifest.name}@${manifest.version}` : manifest.name;
        const key = `${dependant} ${field} ${dep} ${range}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({
          dependant,
          field,
          dep,
          range,
          floor,
          pinned,
        });
      }
    }
  }
  return violations.sort(byDependantThenDep);
}

export function collectViolations(overrides, { installed, workspace }) {
  return [
    ...findFloorViolations(overrides, installed),
    ...findFloorViolations(overrides, workspace, WORKSPACE_DEPENDENCY_FIELDS),
  ].sort(byDependantThenDep);
}

function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
  if (!fs.existsSync(workspaceFile)) {
    console.error(`check-override-floors: no pnpm-workspace.yaml beside ${root}. The subtree layout moved.`);
    process.exit(1);
  }
  const workspaceYaml = fs.readFileSync(workspaceFile, 'utf8');
  const overrides = parseExactOverrides(workspaceYaml);
  const pnpmDir = path.join(root, 'node_modules', '.pnpm');
  if (!fs.existsSync(pnpmDir)) {
    console.error('check-override-floors: node_modules/.pnpm is missing. Run `pnpm install` first.');
    process.exit(1);
  }
  const unknownPatterns = [];
  const emptyPatterns = [];
  const installed = [...installedManifests(pnpmDir)];
  const workspace = [
    ...workspaceManifests(
      root,
      workspaceYaml,
      (p) => unknownPatterns.push(p),
      (p) => emptyPatterns.push(p),
    ),
  ];
  if (unknownPatterns.length > 0) {
    console.error(
      `check-override-floors: the packages: block declares ${unknownPatterns.join(', ')}, which this expander does not understand. It reads two shapes, \`dir/*\` and a bare \`dir\`, either quoted or bare and optionally followed by a comment. Teach it the shape or the repo's own floors go unchecked.`,
    );
    process.exit(1);
  }
  if (installed.length === 0) {
    console.error(`check-override-floors: read no package manifests under ${pnpmDir}. Refusing to report a pass.`);
    process.exit(1);
  }
  if (emptyPatterns.length > 0) {
    console.error(
      `check-override-floors: in ${workspaceFile}, ${emptyPatterns.join(' and ')} matched no workspace package. Those packages' floors left the corpus silently, and the workspace root alone declares none of the pinned packages. Refusing to report a pass.`,
    );
    process.exit(1);
  }
  const total = installed.length + workspace.length;
  const violations = collectViolations(overrides, { installed, workspace });
  if (violations.length === 0) {
    console.log(
      `check-override-floors: OK (${overrides.size} exact overrides checked against ${total} installed and workspace manifests, none below a declared floor)`,
    );
    return;
  }
  console.error('check-override-floors: an override pins a package below a floor a dependant declares.\n');
  for (const v of violations) {
    console.error(`  ${v.dependant}`);
    console.error(`    ${v.field}: ${v.dep}@${v.range} (floor ${v.floor}), override pins ${v.pinned}`);
  }
  console.error(
    '\nRaise the override in pnpm-workspace.yaml to satisfy the highest declared floor, then run `pnpm install`.',
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
