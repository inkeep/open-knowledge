import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const REQUIRED_CONDITIONS = ['types', 'default'];

const RELATIVE_IMPORT = /\bfrom\s*["'](\.\.?\/[^"']+)["']|\bimport\s*["'](\.\.?\/[^"']+)["']/g;

export function nestedRelativeImports(source) {
  const nested = [];
  for (const match of source.matchAll(RELATIVE_IMPORT)) {
    const specifier = match[1] ?? match[2];
    if (specifier.startsWith('../') || specifier.slice(2).includes('/')) nested.push(specifier);
  }
  return nested;
}

export function collectExportTargets(exportsMap) {
  const targets = [];

  const walk = (subpath, condition, node) => {
    if (typeof node === 'string') {
      targets.push({ subpath, condition, target: node });
      return;
    }
    if (Array.isArray(node)) {
      for (const element of node) walk(subpath, condition, element);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) walk(subpath, key, value);
  };

  if (exportsMap === null || typeof exportsMap !== 'object' || Array.isArray(exportsMap)) {
    return targets;
  }
  for (const [subpath, node] of Object.entries(exportsMap)) walk(subpath, 'default', node);
  return targets;
}

export function validateExportsTargets(exportsMap, fileExists, readTarget) {
  const errors = [];

  if (exportsMap === null || typeof exportsMap !== 'object' || Array.isArray(exportsMap)) {
    return ['package.json has no exports map'];
  }

  const subpaths = Object.entries(exportsMap);
  if (subpaths.length === 0) errors.push('package.json exports map is empty');

  for (const [subpath, node] of subpaths) {
    const conditions =
      node !== null && typeof node === 'object' && !Array.isArray(node) ? Object.keys(node) : [];
    for (const required of REQUIRED_CONDITIONS) {
      if (!conditions.includes(required)) {
        errors.push(`exports["${subpath}"] declares no "${required}" condition`);
      }
    }
  }

  const readJsTargets = new Set();
  for (const { subpath, condition, target } of collectExportTargets(exportsMap)) {
    if (!target.startsWith('./')) {
      errors.push(`exports["${subpath}"].${condition} is "${target}", not a "./" relative path`);
      continue;
    }
    if (!fileExists(target)) {
      errors.push(
        `exports["${subpath}"].${condition} points at ${target}, which is not a non-empty file on disk`,
      );
      continue;
    }
    if (/\.[cm]?js$/.test(target) && !readJsTargets.has(target)) {
      readJsTargets.add(target);
      const nested = nestedRelativeImports(readTarget(target));
      if (nested.length > 0) {
        errors.push(
          `exports["${subpath}"].${condition} target ${target} imports ${nested.join(', ')}; a JS entry's relative imports must all be flat siblings (an unbundled JS pass emits nested ones)`,
        );
      }
    }
  }

  return errors;
}

export function jsBelowDistTopLevel(distDir, listEntries = readdirSync) {
  return listEntries(distDir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /\.[cm]?js$/.test(entry.name) && entry.parentPath !== distDir,
    )
    .map((entry) => relative(distDir, join(entry.parentPath, entry.name)))
    .sort();
}

export function verifyExportsTargets(packageRoot = PACKAGE_ROOT) {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const errors = validateExportsTargets(
    packageJson.exports,
    (target) => {
      const absolute = join(packageRoot, target);
      if (!existsSync(absolute)) return false;
      const stats = statSync(absolute);
      return stats.isFile() && stats.size > 0;
    },
    (target) => readFileSync(join(packageRoot, target), 'utf8'),
  );

  const distDir = join(packageRoot, 'dist');
  const nestedJs = existsSync(distDir) ? jsBelowDistTopLevel(distDir) : [];
  if (nestedJs.length > 0) {
    errors.push(
      `dist carries JS below its top level (${nestedJs.join(', ')}); core's dist is contractually flat: a downstream consumer vendors a JS entry's transitive ./*.mjs closure by resolving every specifier against the dist root and writing each member back at that dist-relative path into a flat directory, so a nested member breaks that copy. This check is deliberately stricter than any one entry's closure: a nested chunk reachable only from another entry also reds`,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `${packageJson.name} exports targets are not all on disk or not flat. Run \`pnpm --filter ${packageJson.name} build\` and check tsdown's entry map against package.json exports.\n- ${errors.join('\n- ')}`,
    );
  }

  const subpathCount = Object.keys(packageJson.exports).length;
  const targetCount = collectExportTargets(packageJson.exports).length;
  console.log(
    `Exports targets verified (${subpathCount} subpaths, ${targetCount} condition targets on disk, JS targets flat).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  verifyExportsTargets();
}
