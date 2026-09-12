import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyComment, commentBodyLines, directivesFor, isMarkerHead } from './allowlist.mjs';
import { grammarFor } from './extractors.mjs';
import { isFresh, sourceDigest } from './freshness.mjs';
import {
  entriesFromManifest,
  PrecedentManifestError,
  PrecedentRegistry,
  precedentEntriesFrom,
  UnvalidatedPrecedentRegistry,
} from './precedents.mjs';
import { normalizeRelativePath, SUBJECT_ROOT, scopeForRoot } from './scope.mjs';
import { sanctionedTagsForPath } from './tag-scope.mjs';

export * from './allowlist.mjs';
export * from './config.mjs';
export * from './extract.mjs';
export * from './extract-hash.mjs';
export * from './extractors.mjs';
export * from './precedents.mjs';
export * from './rot.mjs';
export * from './scope.mjs';
export * from './tag-scope.mjs';

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

function readPrecedentsIfPresent(absPath) {
  try {
    return readFileSync(absPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new PrecedentManifestError(
      `could not be read (${error?.code ?? error?.message ?? 'read-failed'}).`,
      { source: absPath },
    );
  }
}

export function isUnvalidatedPrecedentRegistry(registry) {
  return registry instanceof UnvalidatedPrecedentRegistry;
}

export function readPrecedentManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(PRECEDENT_MANIFEST_PATH, 'utf8'));
  } catch (error) {
    throw new PrecedentManifestError(
      `could not be read or parsed as JSON (${error?.code ?? error?.message ?? 'read-failed'}).`,
      { source: PRECEDENT_MANIFEST_PATH },
    );
  }
  return entriesFromManifest(manifest, PRECEDENT_MANIFEST_PATH);
}

function unvalidatedRegistryFor(repoRoot, notify) {
  notify(
    `no-comments: ${repoRoot} carries no PRECEDENTS.md and is not the tree the shipped ` +
      'precedent manifest describes, so `precedent #N` citations there are admitted unvalidated. ' +
      "Open Knowledge's numbering has no authority over another repository.",
  );
  return new UnvalidatedPrecedentRegistry();
}

function precedentSourcePath(repoRoot) {
  return manifestDescribesRoot(repoRoot)
    ? PRECEDENT_MANIFEST_PATH
    : join(repoRoot, 'PRECEDENTS.md');
}

function readPrecedentRegistry(repoRoot, notify) {
  if (manifestDescribesRoot(repoRoot)) return new PrecedentRegistry(readPrecedentManifest());
  const precedentsPath = join(repoRoot, 'PRECEDENTS.md');
  const markdown = readPrecedentsIfPresent(precedentsPath);
  if (markdown === null) return unvalidatedRegistryFor(repoRoot, notify);
  return new PrecedentRegistry(precedentEntriesFrom(markdown, precedentsPath));
}

export function loadPrecedentRegistry(repoRoot, { notify = (line) => console.warn(line) } = {}) {
  const digest = sourceDigest(precedentSourcePath(repoRoot));
  const cached = precedentCache.get(repoRoot);
  if (isFresh(cached, digest)) return cached.registry;
  const registry = readPrecedentRegistry(repoRoot, notify);
  precedentCache.set(repoRoot, { registry, digest });
  return registry;
}

const REPORTABLE_KINDS = new Set(['line', 'block']);

const MARKER_LINE_HINT = {
  'c-family': 'A `//` marker is one line - use a `/* ... */` block for a multi-line marker.',
  'hash-family': 'Indent the continuation under the marker head so the two read as one marker.',
};

function lineSpan(comment) {
  return comment.text.split('\n').length;
}

function leadingIndent(comment) {
  return /^\s*/.exec(commentBodyLines(comment.text)[0] ?? '')[0].length;
}

function joinHeadedRuns(comments, source) {
  const runs = [];
  for (const comment of comments) {
    const head = runs[runs.length - 1];
    const joinable =
      head !== undefined &&
      comment.kind === 'line' &&
      head.kind === 'line' &&
      isMarkerHead(head.text) &&
      comment.line === head.line + lineSpan(head) &&
      comment.column === head.column &&
      leadingIndent(comment) > leadingIndent(head);
    if (!joinable) {
      runs.push(comment);
      continue;
    }
    runs[runs.length - 1] = {
      ...head,
      text: source.slice(head.start, comment.end),
      end: comment.end,
    };
  }
  return runs;
}

export function analyzeSource({ source, relPath, precedentRegistry, root = SUBJECT_ROOT, family }) {
  const path = normalizeRelativePath(relPath);
  const resolved = family === undefined ? scopeForRoot(root).familyFor(path) : family;
  const grammar = grammarFor(path, resolved);
  const extracted = grammar.extract(source).filter((comment) => REPORTABLE_KINDS.has(comment.kind));
  const comments =
    grammar.extractor === 'hash-family' ? joinHeadedRuns(extracted, source) : extracted;
  const sanctionedTags = sanctionedTagsForPath(path, root);
  const directives = directivesFor(grammar.extractor, grammar.fileClass);
  const violations = [];
  const kept = [];
  let previous = null;
  for (const comment of comments) {
    const verdict = classifyComment(comment, {
      precedentRegistry,
      jsdocTypes: grammar.fileClass === 'esm-script',
      sanctionedTags,
      directives,
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
        comment.line === previous.comment.line + lineSpan(previous.comment) &&
        comment.column === previous.comment.column;
      violations.push(
        continuationOfMarker
          ? { ...verdict, fix: `${MARKER_LINE_HINT[grammar.extractor]} ${verdict.fix}`, comment }
          : { ...verdict, comment },
      );
    }
    previous = { ...verdict, comment };
  }
  return { comments, violations, kept, extractor: grammar.extractor, fileClass: grammar.fileClass };
}

export function analyzeFile({ repoRoot, relPath }) {
  const path = normalizeRelativePath(relPath);
  if (!scopeForRoot(repoRoot).isInScope(path)) {
    return { skipped: true, comments: [], violations: [], kept: [] };
  }
  return {
    skipped: false,
    ...analyzeSource({
      source: readFileSync(join(repoRoot, path), 'utf8'),
      relPath: path,
      precedentRegistry: loadPrecedentRegistry(repoRoot),
      root: repoRoot,
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
