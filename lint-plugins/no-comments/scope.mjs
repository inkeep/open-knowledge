export const SCOPE_STRATA = [
  { id: 'packages-src', include: ['packages/**/src/**/*.ts', 'packages/**/src/**/*.tsx'] },
  { id: 'packages-tests', include: ['packages/**/tests/**/*.ts', 'packages/**/tests/**/*.tsx'] },
  { id: 'scripts', include: ['scripts/**/*.mjs'] },
  { id: 'github-scripts', include: ['.github/scripts/**/*.mjs'] },
  {
    id: 'docs',
    include: ['docs/**/*.ts', 'docs/**/*.tsx', 'docs/**/*.mts', 'docs/**/*.cts'],
  },
  { id: 'root-configs', include: ['*.ts', '*.mts', '*.cts'] },
  { id: 'lint-plugins', include: ['lint-plugins/**/*.mjs'] },
];

export const SCOPE_INCLUDE = SCOPE_STRATA.flatMap((stratum) => stratum.include);

export const SCOPE_EXCLUDE = [
  'packages/md-conformance/**',
  'packages/app/tests/fidelity/**',
  'packages/desktop/tests/lume-qa/**',
  'packages/app/src/locales/**',
  '**/*.private.*',
  '**/*.fixture.ts',
  '**/*.fixture.tsx',
  '**/*.fixture.mjs',
  '**/*.d.ts',
  '**/*.d.mts',
  '**/*.d.cts',
  '**/fixtures/**',
  '**/__fixtures__/**',
  'knip.config.ts',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
];

const REGEX_METACHARACTERS = /[.+^${}()|[\]\\]/g;

const UNSUPPORTED_GLOB_SYNTAX = /[?!{}[\]()]/;

export function globToRegExp(glob) {
  if (UNSUPPORTED_GLOB_SYNTAX.test(glob)) {
    throw new Error(
      `unsupported glob syntax in ${glob}: this matcher implements only *, **, and literal segments. ` +
        'Compiling anything else to a literal or a live regex silently mis-scopes a stratum; extend the matcher deliberately instead.',
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

const compile = (globs) => globs.map(globToRegExp);
const INCLUDE_RES = compile(SCOPE_INCLUDE);
const EXCLUDE_RES = compile(SCOPE_EXCLUDE);
const STRATUM_RES = SCOPE_STRATA.map((stratum) => ({
  id: stratum.id,
  regexes: compile(stratum.include),
}));

export function normalizeRelativePath(relPath) {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isExcluded(relPath) {
  const path = normalizeRelativePath(relPath);
  return EXCLUDE_RES.some((re) => re.test(path));
}

export function isInScope(relPath) {
  const path = normalizeRelativePath(relPath);
  if (EXCLUDE_RES.some((re) => re.test(path))) return false;
  return INCLUDE_RES.some((re) => re.test(path));
}

export function stratumFor(relPath) {
  const path = normalizeRelativePath(relPath);
  if (isExcluded(path)) return null;
  for (const stratum of STRATUM_RES) {
    if (stratum.regexes.some((re) => re.test(path))) return stratum.id;
  }
  return null;
}

const WALK_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.git',
  'coverage',
]);

const SCOPE_ROOTS = ['packages', 'scripts', '.github', 'docs', 'lint-plugins'];

function discoverInScopeFilesWithSkips(repoRoot, { readdirSync, lstatSync }) {
  const found = [];
  const skips = [];
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir);
    } catch (error) {
      skips.push({ path: relDir, reason: error?.code ?? 'readdir-failed' });
      return;
    }
    for (const entry of entries) {
      if (WALK_SKIP_DIRS.has(entry)) continue;
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
        if (isInScope(rel)) skips.push({ path: rel, reason: 'symlink' });
        continue;
      }
      if (stat.isDirectory()) walk(abs, rel);
      else if (isInScope(rel)) found.push(rel);
    }
  };
  for (const entry of readdirSync(repoRoot)) {
    const abs = `${repoRoot}/${entry}`;
    if (SCOPE_ROOTS.includes(entry)) {
      walk(abs, entry);
      continue;
    }
    if (isInScope(entry)) found.push(entry);
  }
  found.sort();
  skips.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files: found, skips };
}

export function discoverInScopeFiles(repoRoot, { readdirSync, statSync, lstatSync }) {
  const { files, skips } = discoverInScopeFilesWithSkips(repoRoot, {
    readdirSync,
    lstatSync: lstatSync ?? statSync,
  });
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
