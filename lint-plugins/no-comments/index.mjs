import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyComment } from './allowlist.mjs';
import { extractComments, jsxModeForPath } from './extract.mjs';
import { parsePrecedentNumbers, UnvalidatedPrecedentRegistry } from './precedents.mjs';
import { isInScope, normalizeRelativePath } from './scope.mjs';

export * from './allowlist.mjs';
export * from './extract.mjs';
export * from './precedents.mjs';
export * from './rot.mjs';
export * from './scope.mjs';

const precedentCache = new Map();
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PRECEDENT_MANIFEST_PATH = join(MODULE_DIR, 'precedent-numbers.generated.json');

function canonicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

const MANIFEST_SUBJECT_ROOT = canonicalPath(join(MODULE_DIR, '..', '..'));

function manifestDescribesRoot(repoRoot) {
  return canonicalPath(repoRoot) === MANIFEST_SUBJECT_ROOT;
}

function readPrecedentsMarkdown(precedentsPath) {
  try {
    return readFileSync(precedentsPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  }
}

function requireNonEmpty(numbers, source) {
  if (numbers.size > 0) return numbers;
  throw new Error(
    `${source} parsed to zero precedent numbers. Refusing to validate citations ` +
      `against an empty set, which would classify every precedent #N citation as invalid and ` +
      `delete it. Check the file for conflict markers or reworded section headings.`,
  );
}

export function isUnvalidatedPrecedentRegistry(registry) {
  return registry instanceof UnvalidatedPrecedentRegistry;
}

function readPrecedentRegistry(repoRoot) {
  const precedentsPath = join(repoRoot, 'PRECEDENTS.md');
  const markdown = readPrecedentsMarkdown(precedentsPath);
  if (markdown !== null) return requireNonEmpty(parsePrecedentNumbers(markdown), precedentsPath);
  if (!manifestDescribesRoot(repoRoot)) return new UnvalidatedPrecedentRegistry();
  return requireNonEmpty(
    new Set(JSON.parse(readFileSync(PRECEDENT_MANIFEST_PATH, 'utf8'))),
    PRECEDENT_MANIFEST_PATH,
  );
}

export function loadPrecedentNumbers(repoRoot) {
  const cached = precedentCache.get(repoRoot);
  if (cached) return cached;
  const registry = readPrecedentRegistry(repoRoot);
  precedentCache.set(repoRoot, registry);
  return registry;
}

const MARKER_LINE_HINT =
  'A `//` marker is one line - use a `/* ... */` block for a multi-line marker.';

export function analyzeSource({ source, relPath, precedentNumbers }) {
  const path = normalizeRelativePath(relPath);
  const comments = extractComments(source, { jsx: jsxModeForPath(path) });
  const violations = [];
  const kept = [];
  let previous = null;
  for (const comment of comments) {
    const verdict = classifyComment(comment, {
      precedentNumbers,
      jsdocTypes: /\.(?:mjs|cjs|js)$/.test(path),
    });
    if (verdict.allowed) {
      kept.push({ comment, class: verdict.class, detail: verdict.detail });
    } else {
      const continuationOfMarker =
        verdict.class === 'prose' &&
        previous !== null &&
        previous.allowed &&
        previous.class === 'contract-marker' &&
        previous.comment.kind === 'line' &&
        comment.kind === 'line' &&
        comment.line === previous.comment.line + 1 &&
        comment.column === previous.comment.column;
      violations.push(
        continuationOfMarker
          ? { ...verdict, fix: `${MARKER_LINE_HINT} ${verdict.fix}`, comment }
          : { ...verdict, comment },
      );
    }
    previous = { ...verdict, comment };
  }
  return { comments, violations, kept };
}

export function analyzeFile({ repoRoot, relPath }) {
  const path = normalizeRelativePath(relPath);
  if (!isInScope(path)) return { skipped: true, comments: [], violations: [], kept: [] };
  return {
    skipped: false,
    ...analyzeSource({
      source: readFileSync(join(repoRoot, path), 'utf8'),
      relPath: path,
      precedentNumbers: loadPrecedentNumbers(repoRoot),
      }),
  };
}

export function describeViolation(violation) {
  return `${violation.class}: ${violation.detail}. ${violation.fix} See ${violation.docsUrl}`;
}

export function formatViolation(relPath, violation) {
  const { comment } = violation;
  return `${relPath}:${comment.line}:${comment.column}  ${describeViolation(violation)}`;
}
