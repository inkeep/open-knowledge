import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UNSUPPORTED_GLOB_SYNTAX,
  loadScopeConfig,
  SCOPE_CONFIG_FILENAME,
  ScopeConfigError,
  ScopeConfigMissingError,
} from './config.mjs';
import { hashDialectsFor, hashDialectsWithoutReference } from './extract-hash.mjs';
import { GRAMMAR_EXTRACTORS } from './extractors.mjs';
import { isFresh, sourceDigest } from './freshness.mjs';

const REGEX_METACHARACTERS = /[.+^${}()|[\]\\]/g;

export function globToRegExp(glob) {
  if (UNSUPPORTED_GLOB_SYNTAX.test(glob)) {
    throw new Error(
      `unsupported glob syntax in ${glob}: this matcher implements only *, **, and literal segments. ` +
        'Compiling anything else to a literal or a live regex silently mis-scopes a unit; extend the matcher deliberately instead.',
    );
  }
  const segments = glob.split('/');
  let pattern = '^';
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    if (segment === '**') {
      pattern += isLast ? '.*' : '(?:.*/)?';
      return;
    }
    pattern += segment.replace(REGEX_METACHARACTERS, '\\$&').replace(/\*/g, '[^/]*');
    if (!isLast) pattern += '/';
  });
  return new RegExp(`${pattern}$`);
}

export function normalizeRelativePath(relPath) {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

const compile = (globs) => globs.map(globToRegExp);

function extensionOf(relPath) {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

function familiesByExtension(config) {
  const byExtension = new Map();
  for (const family of Object.values(config.families)) {
    for (const extension of family.extensions) {
      const claimed = byExtension.get(extension);
      if (claimed === undefined) {
        byExtension.set(extension, {
          extractor: family.extractor,
          extensions: new Set(family.extensions),
        });
        continue;
      }
      if (claimed.extractor !== family.extractor) {
        throw new ScopeConfigError({
          configPath: config.configPath,
          key: `families.${family.id}.extractor`,
          detail:
            `claims ${extension} for extractor ${family.extractor}, which another family already ` +
            `claims for ${claimed.extractor}. One extension reads under one grammar; two would ` +
            'make the extractor a coin flip over which family matched first.',
        });
      }
      for (const other of family.extensions) claimed.extensions.add(other);
    }
  }
  return new Map(
    [...byExtension].map(([extension, claim]) => [
      extension,
      { extractor: claim.extractor, extensions: [...claim.extensions] },
    ]),
  );
}

function assertGrammarContract(config) {
  const byExtension = new Map();
  for (const [id, family] of Object.entries(config.families)) {
    if (!GRAMMAR_EXTRACTORS.includes(family.extractor)) {
      throw new ScopeConfigError({
        configPath: config.configPath,
        key: `families.${id}.extractor`,
        detail:
          `names ${family.extractor}, which no extractor implements. The declared extractors are ` +
          `${GRAMMAR_EXTRACTORS.join(', ')}; a family the predicate cannot read would fail at the ` +
          'first file rather than here, where the config can still be corrected.',
      });
    }
    if (family.extractor === 'hash-family') {
      const unreadable = family.extensions.filter(
        (extension) => hashDialectsFor([extension])[0] === undefined,
      );
      if (unreadable.length > 0) {
        throw new ScopeConfigError({
          configPath: config.configPath,
          key: `families.${id}.extensions`,
          detail:
            `declare ${unreadable.join(', ')}, which no hash dialect reads. Each dialect ships ` +
            'with its own comment-position reference, so a file under an unregistered extension ' +
            'would be lexed under a neighbouring grammar rather than refused.',
        });
      }
      const unmeasured = hashDialectsWithoutReference(family.extensions);
      if (unmeasured.length > 0) {
        const unreferenced = family.extensions.filter((extension) =>
          unmeasured.includes(hashDialectsFor([extension])[0]),
        );
        throw new ScopeConfigError({
          configPath: config.configPath,
          key: `families.${id}.extensions`,
          detail:
            `resolve to the ${unmeasured.join(', ')} dialect, which carries no comment-position ` +
            'reference. A dialect ships with one so an oracle measures where it reads a comment; ' +
            'declaring this family would take gate verdicts, and strip ranges under --write, from ' +
            `a lexer nothing checks. Drop ${unreferenced.join(', ')} from this family until a ` +
            'reference lands, or contribute one upstream: the dialect table is DIALECTS in ' +
            'lint-plugins/no-comments/extract-hash.mjs, and its reference field is what this ' +
            'refusal reads.',
        });
      }
    }
    for (const extension of family.extensions) byExtension.set(extension, family.extractor);
  }
  config.units.forEach((unit, index) => {
    const family = config.families[unit.family];
    for (const file of unit.files) {
      const extension = extensionOf(file);
      if (extension === '' && family.extractor === 'c-family') {
        throw new ScopeConfigError({
          configPath: config.configPath,
          key: `units[${index}].files`,
          detail:
            `unit ${unit.id} lists ${file}, which carries no extension, under c-family. That ` +
            'extractor takes its file class from the extension, so an extensionless path silently ' +
            'reads as TypeScript; a shell hook listed here would report clean rather than being ' +
            'refused. Give the path an extension its family declares, or declare it under a ' +
            'family whose extractor matches its grammar.',
        });
      }
      if (extension === '') continue;
      const claimed = byExtension.get(extension);
      if (claimed === family.extractor) continue;
      throw new ScopeConfigError({
        configPath: config.configPath,
        key: `units[${index}].files`,
        detail:
          `unit ${unit.id} lists ${file}, whose extension ${extension} ${
            claimed === undefined
              ? 'no family claims'
              : `family extractor ${claimed} claims, while this unit declares ${family.extractor}`
          }. The unit would read it under ${family.extractor} regardless, and reading a file under ` +
          'the wrong grammar reports a clean file rather than refusing.',
      });
    }
    if (family.extractor !== 'hash-family') return;
    if (!unit.files.some((file) => extensionOf(file) === '')) return;
    const dialects = hashDialectsFor(family.extensions);
    if (dialects.length === 1) return;
    throw new ScopeConfigError({
      configPath: config.configPath,
      key: `families.${unit.family}.extensions`,
      detail:
        `resolve to ${dialects.length} hash dialects (${dialects.join(', ')}), and unit ${unit.id} ` +
        'carries an extensionless file whose dialect can only come from that set. A member with ' +
        'no extension of its own needs exactly one dialect to fall back to; split the family so ' +
        'each carries a single dialect.',
    });
  });
}

function compileScope(config) {
  assertGrammarContract(config);
  const excludeRes = compile(config.exclude);
  const includeRes = compile(config.include);
  const unitRes = config.units.map((unit) => ({
    id: unit.id,
    family: config.families[unit.family],
    regexes: compile(unit.include),
  }));
  const byExtension = familiesByExtension(config);
  const isExcluded = (relPath) => excludeRes.some((re) => re.test(normalizeRelativePath(relPath)));
  const isInScope = (relPath) => {
    const path = normalizeRelativePath(relPath);
    if (excludeRes.some((re) => re.test(path))) return false;
    return includeRes.some((re) => re.test(path));
  };
  const unitEntryFor = (relPath) => {
    const path = normalizeRelativePath(relPath);
    if (isExcluded(path)) return null;
    return unitRes.find((unit) => unit.regexes.some((re) => re.test(path))) ?? null;
  };
  return {
    config,
    isExcluded,
    isInScope,
    unitFor(relPath) {
      return unitEntryFor(relPath)?.id ?? null;
    },
    familyFor(relPath) {
      const path = normalizeRelativePath(relPath);
      const unit = unitEntryFor(path);
      if (unit !== null) {
        return { extractor: unit.family.extractor, extensions: unit.family.extensions };
      }
      return byExtension.get(extensionOf(path)) ?? null;
    },
    pruneDirectories: new Set(config.pruneDirectories),
  };
}

function canonicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export const SUBJECT_ROOT = canonicalPath(join(MODULE_DIR, '..', '..'));

const scopeCache = new Map();

export function scopeForRoot(root) {
  const key = canonicalPath(root);
  const configPath = join(root, SCOPE_CONFIG_FILENAME);
  const digest = sourceDigest(configPath);
  const cached = scopeCache.get(key);
  if (isFresh(cached, digest)) return cached.scope;
  const config = loadScopeConfig(root);
  if (config === null) {
    scopeCache.delete(key);
    throw new ScopeConfigMissingError({ root, configPath });
  }
  const scope = compileScope(config);
  scopeCache.set(key, { scope, digest });
  return scope;
}

export function diagnoseScope(root) {
  try {
    return { status: 'ok', root, scope: scopeForRoot(root) };
  } catch (error) {
    if (error instanceof ScopeConfigMissingError) {
      return {
        status: 'missing',
        root,
        configPath: error.configPath,
        message: error.message,
      };
    }
    if (error instanceof ScopeConfigError) {
      return {
        status: 'invalid',
        root,
        configPath: error.configPath,
        key: error.key,
        message: `scope-config: UNREADABLE. ${error.message}`,
      };
    }
    throw error;
  }
}

export function subjectScope() {
  return scopeForRoot(SUBJECT_ROOT);
}

export function isExcluded(relPath) {
  return subjectScope().isExcluded(relPath);
}

export function isInScope(relPath) {
  return subjectScope().isInScope(relPath);
}

export function unitFor(relPath) {
  return subjectScope().unitFor(relPath);
}

export function familyFor(relPath) {
  return subjectScope().familyFor(relPath);
}

function requireWalker({ readdirSync, statSync, lstatSync }) {
  for (const [name, fn] of [
    ['readdirSync', readdirSync],
    ['statSync', statSync],
    ['lstatSync', lstatSync],
  ]) {
    if (typeof fn === 'function') continue;
    throw new TypeError(
      `discovery needs a ${name}. lstatSync is what tells a symlink from a real entry, and ` +
        `statSync is what tells a link to a directory from a link to a file; substituting one for ` +
        `the other makes the symlink branch unreachable and silently widens the corpus to whatever ` +
        `the links point at.`,
    );
  }
}

export function discoverInScopeFilesWithSkips(repoRoot, options) {
  requireWalker(options);
  const { readdirSync, statSync, lstatSync } = options;
  const scope = scopeForRoot(repoRoot);
  const { isInScope: inScope, pruneDirectories } = scope;
  const found = new Set();
  const skips = [];
  const linksToDirectory = (abs) => {
    try {
      return statSync(abs).isDirectory();
    } catch {
      return false;
    }
  };
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir);
    } catch (error) {
      skips.push({ path: relDir, reason: error?.code ?? 'readdir-failed' });
      return;
    }
    for (const entry of entries) {
      if (pruneDirectories.has(entry)) continue;
      const abs = `${absDir}/${entry}`;
      const rel = relDir === '' ? entry : `${relDir}/${entry}`;
      let stat;
      try {
        stat = lstatSync(abs);
      } catch (error) {
        skips.push({ path: rel, reason: error?.code ?? 'stat-failed' });
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (inScope(rel)) skips.push({ path: rel, reason: 'symlink' });
        else if (linksToDirectory(abs)) skips.push({ path: rel, reason: 'symlink-directory' });
        continue;
      }
      if (stat.isDirectory()) walk(abs, rel);
      else if (inScope(rel)) found.add(rel);
    }
  };
  const walkRoots = new Set(scope.config.walkRoots);
  for (const entry of readdirSync(repoRoot)) {
    const isRoot = walkRoots.has(entry);
    if (!isRoot && !inScope(entry)) continue;
    const abs = `${repoRoot}/${entry}`;
    let stat;
    try {
      stat = lstatSync(abs);
    } catch (error) {
      skips.push({ path: entry, reason: error?.code ?? 'stat-failed' });
      continue;
    }
    if (stat.isSymbolicLink()) {
      skips.push({ path: entry, reason: 'symlink' });
      continue;
    }
    if (isRoot) walk(abs, entry);
    else if (!stat.isDirectory()) found.add(entry);
  }
  for (const unit of scope.config.units) {
    for (const file of unit.files) {
      if (found.has(file) || !inScope(file)) continue;
      const abs = `${repoRoot}/${file}`;
      let stat;
      try {
        stat = lstatSync(abs);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          skips.push({ path: file, reason: error?.code ?? 'stat-failed' });
        }
        continue;
      }
      if (stat.isSymbolicLink()) skips.push({ path: file, reason: 'symlink' });
      else if (stat.isFile()) found.add(file);
    }
  }
  skips.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files: [...found].sort(), skips, declaredAbsent: scope.config.declaredAbsent };
}

export function discoverInScopeFiles(repoRoot, options) {
  const { files, skips } = discoverInScopeFilesWithSkips(repoRoot, options);
  if (skips.length > 0) {
    const preview = skips
      .slice(0, 5)
      .map((skip) => `${skip.path} (${skip.reason})`)
      .join(', ');
    throw new Error(
      `discovery could not read ${skips.length} in-scope entr${skips.length === 1 ? 'y' : 'ies'}: ` +
        `${preview}${skips.length > 5 ? ', …' : ''}. A file that is not scanned is never counted ` +
        `as clean — fix the entry or use discoverInScopeFilesWithSkips to handle skips explicitly.`,
    );
  }
  return files;
}
