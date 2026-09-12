#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG_REL = 'packages/server';
const TASK = '@inkeep/open-knowledge-server#test';

const RELATIVE_PATH_LITERAL = /'([^'\n]*\.\.\/[^'\n]*)'|"([^"\n]*\.\.\/[^"\n]*)"/g;

const ROOT_JOIN_CALL = /\bjoin\(\s*([A-Za-z_$][\w$]*ROOT[\w$]*)\s*,\s*([^)]*)\)/g;
const QUOTED_SEGMENT = /'([^'\n]*)'|"([^"\n]*)"/g;

const DEPENDENCY_CLOSURE_PREFIXES = ['packages/core/'];

export const KNOWN_UNSWEPT = {
  '../../oxlint.config.ts':
    'read inside test-support/read-ok-rules-config.test-helper.ts, which the walk does not enter',
  '../../lint-plugins/**':
    'same helper, plus fixture paths built from a bare root-relative constant',
  '../app/src/editor/observers.ts':
    'bridge-no-wallclock.test.ts reaches it via a lowercase repoRoot and a root-relative literal',
};

function walkTestFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTestFiles(full, out);
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function existsOnDisk(absolutePath) {
  try {
    statSync(absolutePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

export function escapingReads(okRoot = OK_ROOT) {
  const packageDir = join(okRoot, PKG_REL);
  const byTarget = new Map();
  for (const file of walkTestFiles(packageDir)) {
    const source = readFileSync(file, 'utf-8');
    for (const match of source.matchAll(RELATIVE_PATH_LITERAL)) {
      const literal = match[1] ?? match[2];
      const absolute = resolve(join(file, '..'), literal);
      const fromPackage = relative(packageDir, absolute);
      const fromOkRoot = relative(okRoot, absolute);
      const staysInsidePackage = !fromPackage.startsWith('..');
      const leavesTheSubtree = fromOkRoot.startsWith('..');
      const isAncestorOfPackage = !relative(absolute, packageDir).startsWith('..');
      if (staysInsidePackage || leavesTheSubtree || isAncestorOfPackage) continue;
      if (!existsOnDisk(absolute)) continue;
      if (!byTarget.has(fromOkRoot)) byTarget.set(fromOkRoot, new Set());
      byTarget.get(fromOkRoot).add(relative(packageDir, file));
    }

    for (const call of source.matchAll(ROOT_JOIN_CALL)) {
      const segments = [...call[2].matchAll(QUOTED_SEGMENT)].map((m) => m[1] ?? m[2]);
      if (segments.length === 0) continue;
      const absolute = resolve(okRoot, ...segments);
      const fromOkRoot = relative(okRoot, absolute);
      const fromPackage = relative(packageDir, absolute);
      if (fromOkRoot.startsWith('..')) continue;
      if (!fromPackage.startsWith('..')) continue;
      if (!relative(absolute, packageDir).startsWith('..')) continue;
      if (!existsOnDisk(absolute)) continue;
      if (!byTarget.has(fromOkRoot)) byTarget.set(fromOkRoot, new Set());
      byTarget.get(fromOkRoot).add(relative(packageDir, file));
    }
  }
  return byTarget;
}

function escapeGlobLiterals(glob) {
  return glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToAnchoredRegex(escaped) {
  const endsWithGlobstar = escaped.endsWith('/**');
  const body = endsWithGlobstar ? escaped.slice(0, -3) : escaped;
  const pattern =
    body
      .replace(/\*\*/g, '[SEGMENTS]')
      .replace(/\*/g, '[^/]*')
      .replace(/\[SEGMENTS\]/g, '.*') + (endsWithGlobstar ? '(?:/.*)?' : '');
  return new RegExp(`^${pattern}(/|$)`);
}

export function packageRelativeGlobCovers(entry, targetFromOkRoot, okRoot = OK_ROOT) {
  const fromOkRoot = relative(okRoot, resolve(join(okRoot, PKG_REL), entry));
  return globToAnchoredRegex(escapeGlobLiterals(fromOkRoot)).test(targetFromOkRoot);
}

export function uncoveredReads(okRoot = OK_ROOT) {
  const turbo = JSON.parse(readFileSync(join(okRoot, 'turbo.json'), 'utf-8'));
  const inputs = (turbo.tasks?.[TASK]?.inputs ?? []).filter(
    (entry) => !entry.startsWith('!') && entry !== '$TURBO_DEFAULT$',
  );
  const globalDependencies = turbo.globalDependencies ?? [];

  const uncovered = [];
  for (const [target, readers] of escapingReads(okRoot)) {
    const declaredAsInput = inputs.some((entry) =>
      packageRelativeGlobCovers(entry, target, okRoot),
    );
    const declaredGlobally = globalDependencies.some((entry) =>
      globalDependencyCovers(entry, target),
    );
    const reachedByDependencyBuild = DEPENDENCY_CLOSURE_PREFIXES.some((prefix) =>
      target.startsWith(prefix),
    );
    if (!declaredAsInput && !declaredGlobally && !reachedByDependencyBuild) {
      uncovered.push({ target, readers: [...readers] });
    }
  }
  return uncovered;
}

export function globalDependencyCovers(entry, target) {
  return globToAnchoredRegex(escapeGlobLiterals(entry)).test(target);
}

export function knownUnsweptWitness(glob) {
  return glob.replace(/\/\*\*$/, '');
}

export function missingKnownUnswept(okRoot = OK_ROOT) {
  const turbo = JSON.parse(readFileSync(join(okRoot, 'turbo.json'), 'utf-8'));
  const inputs = turbo.tasks?.[TASK]?.inputs ?? [];
  return Object.keys(KNOWN_UNSWEPT).filter((glob) => {
    const witness = relative(okRoot, resolve(join(okRoot, PKG_REL), knownUnsweptWitness(glob)));
    return !inputs.some(
      (entry) => entry === glob || packageRelativeGlobCovers(entry, witness, okRoot),
    );
  });
}

function main() {
  const swept = escapingReads().size;
  if (swept === 0) {
    console.error(
      '\ncheck:server-test-inputs FAILED\n\n' +
        'The sweep found ZERO cross-package reads, which this suite has never had.\n' +
        'That is a broken sweep reporting a thorough pass, not a clean tree.\n\n' +
        'Fix: check that packages/server/**/*.test.ts still resolves from the Open\n' +
        'Knowledge root - the usual causes are a wrong cwd, a moved test tree, or a\n' +
        'change away from the two literal forms the sweep recognises (a `../` path,\n' +
        'or join(<*ROOT*>, ...) composition). Do NOT lower the floor to clear this:\n' +
        'an empty corpus is the one result this guard cannot tell from success.\n',
    );
    process.exit(1);
  }

  const unswept = missingKnownUnswept();
  if (unswept.length > 0) {
    console.error(
      `\ncheck:server-test-inputs FAILED\n\n` +
        `These globs are required but sit in the sweep's BLIND SPOT, so their\n` +
        `deletion cannot be detected by derivation - they are pinned by name instead:\n\n` +
        unswept.map((g) => `  ${g}\n      ${KNOWN_UNSWEPT[g]}`).join('\n') +
        `\n\nRe-add them to \`${TASK}\`.inputs, or widen the sweep to see their readers\n` +
        `and drop them from KNOWN_UNSWEPT.\n`,
    );
    process.exit(1);
  }

  const uncovered = uncoveredReads();
  if (uncovered.length > 0) {
    const detail = uncovered
      .map(({ target, readers }) => `  ${target}\n      read by: ${readers.slice(0, 4).join(', ')}`)
      .join('\n');
    console.error(
      `\ncheck:server-test-inputs FAILED\n\n` +
        `${TASK} runs suites that read these paths from OUTSIDE packages/server, and\n` +
        `none is matched by its \`inputs\`, by \`globalDependencies\`, or by the \`^build\`\n` +
        `dependency closure. A change confined to one of them yields a cached PASS that\n` +
        `executed nothing, and the remote cache shares that answer with every cell.\n\n` +
        `${detail}\n\n` +
        `Fix: add a matching glob to \`${TASK}\`.inputs in public/open-knowledge/turbo.json.\n`,
    );
    process.exit(1);
  }
  console.log(
    `check:server-test-inputs: OK - ${swept} cross-package path(s) DERIVED from ` +
      `packages/server/**/*.test.ts (quoted '../' literals and statically resolvable ` +
      `join(<*ROOT*>, ...) calls) are declared inputs, plus ` +
      `${Object.keys(KNOWN_UNSWEPT).length} pinned by name because their readers use ` +
      `shapes this sweep does not recognise.`,
  );
}

if (import.meta.main) main();
