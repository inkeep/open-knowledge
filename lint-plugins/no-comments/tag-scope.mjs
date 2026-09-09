import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SANCTIONED_TAGS } from './allowlist.mjs';
import { UNSUPPORTED_GLOB_SYNTAX } from './config.mjs';
import { globToRegExp, normalizeRelativePath, SUBJECT_ROOT } from './scope.mjs';

export const TAG_SURFACE_FILENAME = 'no-comments.tag-globs.generated.json';
export const SUPPORTED_TAG_SURFACE_MAJOR = 1;

export class TagSurfaceError extends Error {
  constructor(message, { surfacePath, key }) {
    super(`${surfacePath}${key ? ` (${key})` : ''}: ${message}`);
    this.name = 'TagSurfaceError';
    this.surfacePath = surfacePath;
    this.key = key;
  }
}

function requireStringArray(value, { surfacePath, key }) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === '')) {
    throw new TagSurfaceError('must be an array of non-empty strings', { surfacePath, key });
  }
  return value;
}

export function parseTagSurfaces(text, { surfacePath }) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new TagSurfaceError(error.message, { surfacePath });
  }
  if (raw?.version !== SUPPORTED_TAG_SURFACE_MAJOR) {
    throw new TagSurfaceError(
      `unsupported version ${JSON.stringify(raw?.version)}; this predicate reads major ` +
        `${SUPPORTED_TAG_SURFACE_MAJOR}. Regenerate the artifact against this predicate.`,
      { surfacePath, key: 'version' },
    );
  }
  if (!Array.isArray(raw.surfaces) || raw.surfaces.length === 0) {
    throw new TagSurfaceError(
      'must list at least one consumer surface; an empty artifact strands every tag comment ' +
        'in the tree rather than scoping admission.',
      { surfacePath, key: 'surfaces' },
    );
  }
  return raw.surfaces.map((surface, index) => {
    const key = `surfaces[${index}]`;
    if (typeof surface?.id !== 'string' || surface.id === '') {
      throw new TagSurfaceError('needs an id naming the consumer', { surfacePath, key });
    }
    return {
      id: surface.id,
      tags: requireStringArray(surface.tags, { surfacePath, key: `${key}.tags` }),
      include: requireGlobArray(surface.include, { surfacePath, key: `${key}.include` }),
      exclude: requireGlobArray(surface.exclude ?? [], { surfacePath, key: `${key}.exclude` }),
    };
  });
}

function requireGlobArray(value, { surfacePath, key }) {
  const globs = requireStringArray(value, { surfacePath, key });
  for (const glob of globs) {
    if (!UNSUPPORTED_GLOB_SYNTAX.test(glob)) continue;
    throw new TagSurfaceError(
      `carries ${glob}, which the matcher does not implement. It compiles literals, * and ** ` +
        'only, so anything else would be read as a literal and scope tag admission to a surface ' +
        'the generator never named.',
      { surfacePath, key },
    );
  }
  return globs;
}

export function compileTagSurfaces(surfaces, { vocabulary = SANCTIONED_TAGS } = {}) {
  const compiled = surfaces.map((surface) => ({
    tags: surface.tags.filter((tag) => vocabulary.includes(tag)),
    include: surface.include.map(globToRegExp),
    exclude: surface.exclude.map(globToRegExp),
  }));
  return (relPath) => {
    const path = normalizeRelativePath(relPath);
    const admitted = new Set();
    for (const surface of compiled) {
      if (surface.exclude.some((pattern) => pattern.test(path))) continue;
      if (!surface.include.some((pattern) => pattern.test(path))) continue;
      for (const tag of surface.tags) admitted.add(tag);
    }
    return vocabulary.filter((tag) => admitted.has(tag));
  };
}

const NO_SURFACE = () => [];

function readTagSurfaces(root) {
  const surfacePath = join(root, TAG_SURFACE_FILENAME);
  let text;
  try {
    text = readFileSync(surfacePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return NO_SURFACE;
  }
  return compileTagSurfaces(parseTagSurfaces(text, { surfacePath }));
}

const matcherCache = new Map();

export function tagSurfaceMatcherForRoot(root) {
  const cached = matcherCache.get(root);
  if (cached) return cached;
  const matcher = readTagSurfaces(root);
  matcherCache.set(root, matcher);
  return matcher;
}

export function sanctionedTagsForPath(relPath, root = SUBJECT_ROOT) {
  return tagSurfaceMatcherForRoot(root)(relPath);
}
