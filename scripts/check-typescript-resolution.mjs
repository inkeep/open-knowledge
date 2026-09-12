#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { expandPackagePattern, parsePackagePatterns } from './check-override-floors.mjs';
import { readJsoncOrError } from './read-jsonc.mjs';

export const GATE_LINE = '7.0';
export const SHIM_LINE = '6.0';

const VERSION_LINE = /^(\d+\.\d+)\./;

export function versionLine(version) {
  const m = VERSION_LINE.exec(String(version ?? ''));
  return m ? m[1] : null;
}

export function checkRoot({ binVersion, shimVersion, tsserverBytes }) {
  const violations = [];
  if (versionLine(binVersion) !== GATE_LINE) {
    violations.push(
      `the root \`tsc\` bin reports ${binVersion ?? 'nothing'}, not ${GATE_LINE}.x. The @typescript/native alias is what puts the Go compiler on the root bin path; without it a root-level \`pnpm exec tsc\` silently checks on the shim.`,
    );
  }
  if (versionLine(shimVersion) !== SHIM_LINE) {
    violations.push(
      `the root \`typescript\` package is ${shimVersion ?? 'absent'}, not ${SHIM_LINE}.x. That dependency exists only to supply lib/tsserver.js to typescript-language-server; TypeScript 7 ships no tsserver, so dropping or bumping it sends every language server to a machine-global fallback.`,
    );
  } else if (!(tsserverBytes > 0)) {
    violations.push(
      'the root typescript/lib/tsserver.js is missing or empty. The @typescript/typescript6 compat shim has this shape and is why it cannot be used here.',
    );
  }
  return violations;
}

export function checkMember({ name, dir, declaredRange, resolvedVersion, binVersion, scripts }) {
  const violations = [];
  const where = `${name} (${dir})`;
  if (declaredRange) {
    if (versionLine(resolvedVersion) !== GATE_LINE) {
      violations.push(
        `${where} declares typescript ${declaredRange} but resolves ${resolvedVersion ?? 'nothing'}, not ${GATE_LINE}.x.`,
      );
    }
    if (versionLine(binVersion) !== GATE_LINE) {
      violations.push(
        `${where} runs a \`tsc\` reporting ${binVersion ?? 'nothing'}, not ${GATE_LINE}.x.`,
      );
    }
    return violations;
  }
  const tscScripts = Object.entries(scripts ?? {}).filter(([, body]) =>
    /(^|[\s&|;(])(?:[^\s&|;()]*\/)?(tsc|tsgo)(\s|$)/.test(String(body)),
  );
  for (const [script, body] of tscScripts) {
    violations.push(
      `${where} runs \`tsc\` in its \`${script}\` script (${body}) without declaring typescript. The binary then resolves by walking up to the workspace root, so this gate checks on whatever the root's @typescript/native alias happens to be rather than on a version this package declares, and any typescript API it imports resolves to the root's ${SHIM_LINE}.x language-server shim instead.`,
    );
  }
  return violations;
}

export const SOURCE_CONDITION = '@inkeep/source';

export function checkConditions({ baseConditions, declarationBuild }) {
  const violations = [];
  for (const file of declarationBuild.missing) {
    violations.push(
      `${file} does not exist, but its package.json points a types entry at an emitted declaration. Nothing resets the base's source condition for that emit, so this gate cannot see whether the published file resolves for an npm consumer.`,
    );
  }
  if (
    !Array.isArray(baseConditions) ||
    baseConditions.length !== 1 ||
    baseConditions[0] !== SOURCE_CONDITION
  ) {
    violations.push(
      `the base tsconfig declares customConditions ${JSON.stringify(baseConditions ?? null)}, not ["${SOURCE_CONDITION}"]. That condition is what makes a leaf typecheck resolve a sibling to its src rather than to a dist that may not exist yet; dropping it turns every per-package \`tsc --noEmit\` into a build-first command without any of them changing.`,
    );
  }
  for (const [file, conditions] of declarationBuild.configs) {
    if (!Array.isArray(conditions) || conditions.length !== 0) {
      violations.push(
        `${file} declares customConditions ${JSON.stringify(conditions ?? null)}, not []. A config that emits a published declaration must reset the base's source condition, or it bakes ../<sibling>/src/*.ts paths into the emitted .d.mts and the published file stops resolving for an npm consumer.`,
      );
    }
  }
  return violations;
}

export const BASE_TSCONFIG = 'tsconfig.json';
export const RESET_TSCONFIGS = ['tsconfig.build.json', 'tsconfig.check.json'];
export function outputDirRules(gitignoreText) {
  const names = new Set();
  const prefixes = [];
  const anchored = new Set();
  for (const raw of gitignoreText.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!') || !line.endsWith('/'))
      continue;
    const rooted = line.startsWith('/');
    const pattern = line.replace(/^\//, '').slice(0, -1);
    if (rooted || pattern.includes('/')) {
      if (!pattern.includes('*')) anchored.add(pattern);
      continue;
    }
    if (pattern.endsWith('-*')) prefixes.push(pattern.slice(0, -1));
    else if (!pattern.includes('*')) names.add(pattern);
  }
  return { names, prefixes, anchored };
}

export const NESTED_BUILD_OUTPUTS = ['packages/native-config/target'];

function outputDirRulesForRoot(root) {
  const gitignore = path.join(root, '.gitignore');
  const rules = outputDirRules(fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '');
  for (const p of NESTED_BUILD_OUTPUTS) rules.anchored.add(p);
  return rules;
}

function skipsDirectory(rules, name, relativePath) {
  return (
    rules.names.has(name) ||
    rules.prefixes.some((prefix) => name.startsWith(prefix)) ||
    rules.anchored.has(relativePath)
  );
}
const CANONICAL_RESET_DIRS = [
  { label: 'packages/<package>', matches: (dir) => /^packages\/[^/]+$/.test(dir) },
  {
    label: 'packages/md-conformance/md-audit',
    matches: (dir) => dir === 'packages/md-conformance/md-audit',
  },
  { label: 'docs', matches: (dir) => dir === 'docs' },
];
const isCanonicalResetDir = (dir) => CANONICAL_RESET_DIRS.some((d) => d.matches(dir));

export function checkTsconfigConditions(sites, asserted = []) {
  const elsewhere = new Set(asserted);
  const violations = [];
  for (const [file, conditions] of sites) {
    if (file === BASE_TSCONFIG || elsewhere.has(file)) continue;
    const name = file.split('/').pop();
    const dir = file.slice(0, -(name.length + 1));
    if (RESET_TSCONFIGS.includes(name) && !isCanonicalResetDir(dir)) {
      violations.push(
        `${file} declares customConditions ${JSON.stringify(conditions ?? null)} but sits outside the canonical locations a reset may live in (${CANONICAL_RESET_DIRS.map((d) => d.label).join(' or ')}); a reset is only recognised there, so move it or drop the key.`,
      );
      continue;
    }
    if (RESET_TSCONFIGS.includes(name)) {
      if (Array.isArray(conditions) && conditions.length === 0) continue;
      violations.push(
        `${file} declares customConditions ${JSON.stringify(conditions ?? null)}, not []. A ${name} exists to reset the base's source condition for a program that has to resolve siblings from their built declarations, so any other value there sends that program back to ../<sibling>/src while still carrying the name of a reset config.`,
      );
      continue;
    }
    violations.push(
      `${file} declares customConditions ${JSON.stringify(conditions ?? null)}. A child tsconfig REPLACES the base array rather than merging with it, so this key moves its whole program off the base's ["${SOURCE_CONDITION}"] resolution and onto dist, and neither the base check nor the declaration build config check can see it from ${BASE_TSCONFIG} and the build configs alone. Only the root ${BASE_TSCONFIG} may declare the source condition, and only a ${RESET_TSCONFIGS.join(' or ')} may reset it to []; delete the key here.`,
    );
  }
  return violations;
}

const DTS_KEY = /\bdts:\s*/g;
const DTS_LITERAL = /^(?:false|true)\b/;
const UNBUNDLE_BINDING = /\bunbundle:\s*(false|true)\b/;
const BUILD_TSCONFIG_BINDING = /tsconfig:\s*['"`](?:\.\/)?tsconfig\.build\.json['"`]/;
const DEFINE_CONFIG_CALL = 'defineConfig(';

export const CONFIG_ABSENT = Symbol('tsdown.config.ts does not exist');

function stringEnd(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
      i += 2;
      let open = 1;
      while (i < text.length && open > 0) {
        const c = text[i];
        if (c === '"' || c === "'" || c === '`') {
          i = stringEnd(text, i);
          continue;
        }
        if (c === '{') open += 1;
        else if (c === '}') open -= 1;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return text.length;
}

function blankComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      const start = i;
      while (i < text.length && text[i] !== '\n') i += 1;
      out += ' '.repeat(i - start);
      continue;
    }
    if (c === '/' && d === '*') {
      const start = i;
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, text.length);
      for (let k = start; k < i; k += 1) out += text[k] === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function objectEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = stringEnd(text, i) - 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

export function dtsBindings(text) {
  const bindings = [];
  DTS_KEY.lastIndex = 0;
  let match = DTS_KEY.exec(text);
  while (match !== null) {
    const start = match.index + match[0].length;
    if (text[start] === '{') {
      const end = objectEnd(text, start);
      if (end === null) break;
      bindings.push(text.slice(start, end));
      DTS_KEY.lastIndex = end;
    } else {
      const literal = DTS_LITERAL.exec(text.slice(start));
      if (literal !== null) {
        bindings.push(literal[0]);
        DTS_KEY.lastIndex = start + literal[0].length;
      }
    }
    match = DTS_KEY.exec(text);
  }
  return bindings;
}

function splitConfigEntries(code) {
  const call = code.indexOf(DEFINE_CONFIG_CALL);
  if (call === -1) return null;
  let i = call + DEFINE_CONFIG_CALL.length;
  while (i < code.length && /\s/.test(code[i])) i += 1;
  if (code[i] !== '[') return null;
  const texts = [];
  let depth = 0;
  let start = i + 1;
  for (let j = i; j < code.length; j += 1) {
    const c = code[j];
    if (c === '"' || c === "'" || c === '`') {
      j = stringEnd(code, j) - 1;
      continue;
    }
    if (c === '[' || c === '{' || c === '(') {
      depth += 1;
      continue;
    }
    if (c === ']' || c === '}' || c === ')') {
      depth -= 1;
      if (depth === 0) {
        const tail = code.slice(start, j);
        if (tail.trim() !== '') texts.push(tail);
        return texts;
      }
      continue;
    }
    if (c === ',' && depth === 1) {
      texts.push(code.slice(start, j));
      start = j + 1;
    }
  }
  return null;
}

function configEntries(source) {
  const code = blankComments(source);
  const texts = splitConfigEntries(code);
  const describe = (text, label) => {
    const bindings = dtsBindings(text);
    const unbundle = UNBUNDLE_BINDING.exec(text);
    return { label, text, bindings, unbundle: unbundle ? unbundle[1] : null };
  };
  if (texts === null) return [describe(code, null)];
  return texts.map((text, index) => describe(text, `[${index}]`));
}

export function declarationEmitEntries(emitConfigs) {
  const entries = [];
  for (const [file, source] of emitConfigs ?? []) {
    if (typeof source !== 'string') continue;
    for (const entry of configEntries(source)) {
      entries.push({
        file,
        label: entry.label,
        dts: entry.bindings[0] ?? null,
        unbundle: entry.unbundle,
      });
    }
  }
  return entries;
}

export function unbundleCensus(emitConfigs) {
  const entries = declarationEmitEntries(emitConfigs);
  const counted = (value) => entries.filter((entry) => entry.unbundle === value).length;
  return `${entries.length} build entries across them, unbundle true on ${counted('true')} and false on ${counted('false')} and unbound on ${counted(null)}`;
}

export function checkDeclarationEmit(emitConfigs) {
  const violations = [];
  for (const [file, source] of emitConfigs) {
    if (source === CONFIG_ABSENT) {
      violations.push(
        `${file} does not exist, but its package.json points a types entry at an emitted declaration and it builds with tsdown. Nothing then binds that emit to tsconfig.build.json, so this gate cannot see which tsconfig the published declaration was produced under. Refusing to report a pass on a config that is not there.`,
      );
      continue;
    }
    if (typeof source !== 'string') {
      violations.push(
        `${file} could not be read, so this gate cannot tell which tsconfig its declaration emit runs under. Refusing to report a pass on a config it never inspected.`,
      );
      continue;
    }
    for (const entry of configEntries(source)) {
      const where = entry.label === null ? file : `${file} entry ${entry.label}`;
      if (entry.bindings.length === 0) {
        violations.push(
          `${where} binds no dts option, so its declaration emit inherits the base tsconfig and its source condition. tsdown auto-enables the emit per entry when the package declares types, so an entry that binds nothing is not an entry that emits nothing. Bind dts to { tsconfig: 'tsconfig.build.json' }, or to false where that entry emits no declaration.`,
        );
        continue;
      }
      for (const binding of entry.bindings) {
        if (binding === 'false') continue;
        if (!BUILD_TSCONFIG_BINDING.test(binding)) {
          violations.push(
            `${where} emits declarations with dts: ${binding}, which runs the declaration build under the base tsconfig. That config declares the source condition, so the emitted .d.mts resolves siblings from ../<sibling>/src and stops resolving for an npm consumer. The manifest and tsconfig.build.json checks above both stay green through this, which is why it is asserted here.`,
          );
        }
      }
    }
  }
  return violations;
}

export function declarationEmitConfigs(
  root,
  dirs,
  read = readJson,
  readText = readTextOrNull,
  exists = fs.existsSync,
) {
  const entries = [];
  for (const dir of dirs) {
    const manifest = read(path.join(dir, 'package.json'));
    if (!needsDeclarationBuildConfig(manifest)) continue;
    if (!usesTsdown(manifest)) continue;
    const file = `${path.relative(root, dir).split(path.sep).join('/')}/tsdown.config.ts`;
    const absolute = path.join(root, file);
    if (!exists(absolute)) {
      entries.push([file, CONFIG_ABSENT]);
      continue;
    }
    entries.push([file, readText(absolute)]);
  }
  return entries;
}

function usesTsdown(manifest) {
  return Boolean(manifest?.devDependencies?.tsdown ?? manifest?.dependencies?.tsdown);
}

function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function conditionMap(target) {
  return target && typeof target === 'object' && !Array.isArray(target) ? target : null;
}

function sourceConditionWins(target) {
  const conditions = conditionMap(target);
  return conditions !== null && Object.keys(conditions)[0] === SOURCE_CONDITION;
}

function declaresSourceCondition(node) {
  if (!node || typeof node !== 'object') return false;
  if (!Array.isArray(node) && SOURCE_CONDITION in node) return true;
  return Object.values(node).some(declaresSourceCondition);
}

export function sourceConditionSites(manifest) {
  const exports = manifest?.exports;
  if (!exports || (typeof exports !== 'object' && typeof exports !== 'string')) return null;
  if (typeof exports === 'object' && Object.keys(exports).length === 0) return null;
  const map = conditionMap(exports);
  const subpaths =
    map && Object.keys(map).some((key) => key.startsWith('.'))
      ? Object.entries(map)
      : [['.', exports]];
  const name = manifest.name ?? '(unnamed package)';
  if (typeof manifest.private !== 'boolean') {
    return { name, unclassified: true, total: subpaths.length, missing: [], present: [] };
  }
  return {
    name,
    private: manifest.private,
    total: subpaths.length,
    missing: subpaths.filter(([, target]) => !sourceConditionWins(target)).map(([key]) => key),
    present: subpaths.filter(([, target]) => declaresSourceCondition(target)).map(([key]) => key),
  };
}

export function checkSourceCondition(sites) {
  const violations = [];
  if (sites.length === 0) {
    violations.push(
      `no workspace package declares an \`exports\` field, so the source-condition half of the declaration contract would be asserted against an empty corpus. Refusing to report a pass.`,
    );
    return violations;
  }
  for (const site of sites) {
    if (site.unclassified) {
      violations.push(
        `${site.name} declares an \`exports\` field with ${site.total} subpaths but no explicit \`private\` field, so this gate cannot tell which half of the contract applies to it. A private package must resolve every subpath through the "${SOURCE_CONDITION}" condition first, as a conditions map that leads with it, and a published one must carry it on none, and those are opposite requirements. Declare \`private\` rather than leaving this gate to guess.`,
      );
      continue;
    }
    if (site.private && site.missing.length > 0) {
      violations.push(
        `${site.name} is private and ${site.missing.length} of its ${site.total} \`exports\` subpaths (${site.missing.join(', ')}) do not resolve through the "${SOURCE_CONDITION}" condition: each one either omits it, orders another condition ahead of it, is a bare string with no conditions at all, or is a fallback array, whose members this gate does not rank. Conditional exports match in key order and TypeScript always matches \`types\`, so a leaf typecheck of a consumer resolves those subpaths to a built declaration instead of to src, needs a build first, and can pass against a stale dist.`,
      );
    }
    if (!site.private && site.present.length > 0) {
      violations.push(
        `${site.name} is published and ${site.present.length} of its \`exports\` subpaths (${site.present.join(', ')}) declare the "${SOURCE_CONDITION}" condition. That condition points at src, which is not in the published tarball, so any consumer that enables it resolves to files npm never shipped.`,
      );
    }
  }
  return violations;
}

export function collectViolations(
  root,
  members,
  conditions,
  emitConfigs,
  sourceSites,
  tsconfigSites = [],
) {
  return [
    ...checkRoot(root),
    ...members.flatMap((member) => checkMember(member)),
    ...(conditions ? checkConditions(conditions) : []),
    ...checkTsconfigConditions(
      tsconfigSites,
      (conditions?.declarationBuild?.configs ?? []).map(([file]) => file),
    ),
    ...checkDeclarationEmit(emitConfigs),
    ...checkSourceCondition(sourceSites),
  ];
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function binVersionOf(dir) {
  const bin = path.join(
    dir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );
  if (!fs.existsSync(bin)) return null;
  try {
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    const m = /Version\s+(\S+)/.exec(out);
    return m ? m[1] : out.trim();
  } catch {
    return null;
  }
}

const EMITTED_DECLARATION = /\.d\.[cm]?ts$/;
const EMITTED_JS = /^.+\/[^/]+\.[cm]?js$/;
const NESTED_DECLARATION = /^.+\/[^/]+\.d\.[cm]?ts$/;

export const NON_TSC_DECLARATIONS = new Set(['@inkeep/open-knowledge-native-config']);

function stringLeaves(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (node && typeof node === 'object')
    for (const value of Object.values(node)) stringLeaves(value, out);
  return out;
}

export function publishesDeclarations(manifest) {
  if (NON_TSC_DECLARATIONS.has(manifest?.name)) return false;
  return declarationTargets(manifest).some((target) => EMITTED_DECLARATION.test(target));
}

export function staleNonTscListing(manifest) {
  if (!NON_TSC_DECLARATIONS.has(manifest?.name)) return null;
  const emitted = declarationTargets(manifest).filter((target) => NESTED_DECLARATION.test(target));
  if (emitted.length === 0) return null;
  return `${manifest.name} is listed in NON_TSC_DECLARATIONS but now points a types entry at an emitted declaration (${emitted.join(', ')}); remove it from NON_TSC_DECLARATIONS so its declaration build config is checked like every other publisher's.`;
}

export function emitsAdjacentDeclaration(manifest) {
  return declarationTargets(manifest).some((target) => EMITTED_JS.test(target));
}

export function needsDeclarationBuildConfig(manifest) {
  return publishesDeclarations(manifest) || emitsAdjacentDeclaration(manifest);
}

export function declarationTargets(manifest) {
  return stringLeaves([
    manifest?.exports,
    manifest?.types,
    manifest?.typings,
    manifest?.publishConfig?.exports,
    manifest?.publishConfig?.types,
    manifest?.publishConfig?.typings,
  ]).map((value) => value.replace(/^\.\//, ''));
}

export function declarationBuildConfigs(
  root,
  dirs,
  read = readJson,
  exists = fs.existsSync,
  readConfig = readJsoncOrError,
) {
  const configs = [];
  const missing = [];
  const blind = [];
  for (const dir of dirs) {
    const manifest = read(path.join(dir, 'package.json'));
    const stale = staleNonTscListing(manifest);
    if (stale !== null) blind.push(stale);
    if (!needsDeclarationBuildConfig(manifest)) continue;
    const file = `${path.relative(root, dir).split(path.sep).join('/')}/tsconfig.build.json`;
    const absolute = path.join(root, file);
    if (!exists(absolute)) {
      missing.push(file);
      continue;
    }
    const parsed = readConfig(absolute);
    if (!parsed.ok) {
      blind.push(parsed.reason);
      continue;
    }
    configs.push([file, parsed.value?.compilerOptions?.customConditions ?? null]);
  }
  return { configs, missing, blind };
}

const TSCONFIG_NAME = /^tsconfig[^/]*\.json$/;

export function tsconfigFiles(root, readdir = fs.readdirSync, rules = outputDirRulesForRoot(root)) {
  const files = [];
  const blind = [];
  const relative = (dir) => path.relative(root, dir).split(path.sep).join('/') || '.';
  const walk = (dir) => {
    let entries;
    try {
      entries = readdir(dir, { withFileTypes: true });
    } catch (error) {
      blind.push(
        `${relative(dir)} could not be listed (${error.message}), so a tsconfig that redirects its program to dist resolution could sit there unseen.`,
      );
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name.startsWith('.') ||
          skipsDirectory(rules, entry.name, relative(path.join(dir, entry.name)))
        )
          continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (TSCONFIG_NAME.test(entry.name)) files.push(relative(path.join(dir, entry.name)));
    }
  };
  walk(root);
  return { files: files.sort(), blind };
}

export function tsconfigConditions(root, files, readConfig = readJsoncOrError) {
  const sites = [];
  const blind = [];
  for (const file of files) {
    const parsed = readConfig(path.join(root, ...file.split('/')));
    if (!parsed.ok) {
      blind.push(parsed.reason);
      continue;
    }
    const options = parsed.value?.compilerOptions;
    if (options && typeof options === 'object' && 'customConditions' in options) {
      sites.push([file, options.customConditions]);
    }
  }
  return { sites, blind };
}

export function probeMember(dir, readManifest = readJson) {
  const manifest = readManifest(path.join(dir, 'package.json'));
  if (!manifest?.name) {
    return {
      blind: `the package.json at ${dir} is unparseable or declares no name, so this package cannot be probed`,
    };
  }
  const declaredRange =
    manifest.devDependencies?.typescript ?? manifest.dependencies?.typescript ?? null;
  return {
    name: manifest.name,
    dir,
    declaredRange,
    resolvedVersion:
      readJson(path.join(dir, 'node_modules', 'typescript', 'package.json'))?.version ?? null,
    binVersion: declaredRange ? binVersionOf(dir) : null,
    scripts: manifest.scripts ?? null,
  };
}

export function memberDirs(root, yamlText, onUnparsed, onEmptyPattern) {
  const { patterns, unparsed } = parsePackagePatterns(yamlText);
  for (const line of unparsed) onUnparsed(line);
  const dirs = [];
  for (const pattern of patterns) {
    const expanded = expandPackagePattern(root, pattern);
    if (expanded === null) {
      onUnparsed(pattern);
      continue;
    }
    const withManifest = expanded.filter((dir) => fs.existsSync(path.join(dir, 'package.json')));
    if (withManifest.length === 0) onEmptyPattern(pattern);
    dirs.push(...withManifest);
  }
  if (patterns.length === 0) onEmptyPattern('the packages: block itself');
  return [...new Set(dirs)].sort();
}

export function evaluate({
  root,
  rootSource = null,
  rootProbe,
  members,
  gated,
  baseConditions,
  declarationBuild,
  emitConfigs,
  sourceSites,
  tsconfigs = { files: [], sites: [] },
}) {
  const violations = collectViolations(
    rootProbe,
    members,
    { baseConditions, declarationBuild },
    emitConfigs,
    sourceSites,
    tsconfigs.sites,
  );
  if (violations.length === 0) {
    return {
      code: 0,
      violations,
      err: [],
      out: [
        `check-typescript-resolution: OK at ${root}${rootSource === null ? '' : ` [from ${rootSource}]`} (root tsc ${rootProbe.binVersion} over a ${rootProbe.shimVersion} tsserver shim; ${gated.length} of ${members.length} workspace packages declare typescript and all run ${GATE_LINE}.x; base customConditions ["${SOURCE_CONDITION}"] with every one of the ${declarationBuild.configs.length} packages that publish an emitted declaration resetting it, and every one of the ${emitConfigs.length} tsdown configs among them emitting declarations through that reset config, per entry (${unbundleCensus(emitConfigs)}); ${sourceSites.length} packages declare an \`exports\` field and each resolves through the source condition first, or not at all, exactly as its publication status requires; of the ${tsconfigs.files.length} tsconfig files under the root, customConditions appears only in the base ${BASE_TSCONFIG} and in ${RESET_TSCONFIGS.join(' or ')} configs that reset it)`,
      ],
    };
  }
  return {
    code: 1,
    violations,
    out: [],
    err: [
      'check-typescript-resolution: the declaration and compiler contract this workspace declares does not hold.\n',
      ...violations.map((violation) => `  ${violation}`),
      `\nA compiler-version violation is usually a stale install: run \`pnpm install\` from ${root}, and declare typescript in any package that was added rather than letting resolution walk up to the root shim. A customConditions violation is a tsconfig edit, and the remedy differs by which one fired: the base tsconfig must declare \`customConditions: ["@inkeep/source"]\` so leaf typechecks resolve siblings from source; each declaration build config must extend that base and reset \`customConditions: []\` so the published surface resolves from built declarations instead; a declaration build config that is missing entirely must be added; and every other tsconfig under the root must carry no customConditions key of its own, since a child replaces the base array rather than adding to it. A dts violation is a tsdown edit: bind \`dts\` to \`{ tsconfig: 'tsconfig.build.json' }\` so the declaration emit runs under the reset config rather than the base. Do not answer a base-tsconfig violation by setting \`[]\` there, which is the opposite of what it asks.`,
    ],
  };
}

function main() {
  const rootSource = process.env.OK_RESOLUTION_ROOT ? 'OK_RESOLUTION_ROOT' : null;
  const root = process.env.OK_RESOLUTION_ROOT
    ? path.resolve(process.env.OK_RESOLUTION_ROOT)
    : path.resolve(import.meta.dirname, '..');
  const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
  if (!fs.existsSync(workspaceFile)) {
    console.error(
      `check-typescript-resolution: no pnpm-workspace.yaml beside ${root}. The subtree layout moved.`,
    );
    process.exit(1);
  }
  const blind = [];
  const dirs = memberDirs(
    root,
    fs.readFileSync(workspaceFile, 'utf8'),
    (line) => blind.push(`unrecognised packages: entry ${JSON.stringify(line)}`),
    (pattern) => blind.push(`packages: pattern ${JSON.stringify(pattern)} matched no package.json`),
  );
  const probed = dirs.map((dir) => probeMember(dir));
  for (const entry of probed) {
    if (entry.blind) blind.push(entry.blind);
  }
  if (blind.length > 0) {
    console.error(
      `check-typescript-resolution: cannot enumerate the workspace, so a package could be checked on the wrong compiler unseen. Refusing to report a pass.\n\n  ${blind.join('\n  ')}`,
    );
    process.exit(1);
  }
  const members = probed;
  const gated = members.filter((member) => member.declaredRange);
  if (gated.length === 0) {
    console.error(
      'check-typescript-resolution: no workspace package declares typescript. Refusing to report a pass on an empty corpus.',
    );
    process.exit(1);
  }
  const rootProbe = {
    binVersion: binVersionOf(root),
    shimVersion:
      readJson(path.join(root, 'node_modules', 'typescript', 'package.json'))?.version ?? null,
    tsserverBytes: (() => {
      try {
        return fs.statSync(path.join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js'))
          .size;
      } catch {
        return 0;
      }
    })(),
  };
  const declarationBuild = declarationBuildConfigs(root, dirs);
  const baseTsconfig = readJsoncOrError(path.join(root, BASE_TSCONFIG));
  const listed = tsconfigFiles(root);
  const declared = tsconfigConditions(root, listed.files);
  const unreadable = [
    ...new Set([
      ...declarationBuild.blind,
      ...(baseTsconfig.ok ? [] : [baseTsconfig.reason]),
      ...listed.blind,
      ...declared.blind,
    ]),
  ];
  if (unreadable.length > 0) {
    console.error(
      `check-typescript-resolution: cannot read a tsconfig this gate has to inspect, so a resolution violation could pass unseen. Refusing to report a pass.\n\n  ${unreadable.join('\n  ')}`,
    );
    process.exit(1);
  }
  if (declarationBuild.configs.length === 0 && declarationBuild.missing.length === 0) {
    console.error(
      'check-typescript-resolution: no workspace package publishes an emitted declaration, so the declaration-build condition reset would be asserted against an empty set. Refusing to report a pass.',
    );
    process.exit(1);
  }
  const baseConditions = baseTsconfig.value?.compilerOptions?.customConditions ?? null;
  const sourceSites = dirs
    .map((dir) => sourceConditionSites(readJson(path.join(dir, 'package.json'))))
    .filter((site) => site !== null);
  const emitConfigs = declarationEmitConfigs(root, dirs);
  if (emitConfigs.length === 0) {
    console.error(
      'check-typescript-resolution: none of the packages that publish an emitted declaration has a tsdown.config.ts, so the declaration-emit assertion would run against an empty set. Refusing to report a pass.',
    );
    process.exit(1);
  }
  const { code, out, err } = evaluate({
    root,
    rootSource,
    rootProbe,
    members,
    gated,
    baseConditions,
    declarationBuild,
    emitConfigs,
    sourceSites,
    tsconfigs: { files: listed.files, sites: declared.sites },
  });
  for (const line of out) console.log(line);
  for (const line of err) console.error(line);
  if (code !== 0) process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
