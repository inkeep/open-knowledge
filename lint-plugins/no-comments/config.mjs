import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractComments } from './extract.mjs';

export const SCOPE_CONFIG_FILENAME = 'no-comments.config.jsonc';

const SCOPE_CONFIG_SCHEMA_PATH = 'lint-plugins/no-comments/no-comments.config.schema.json';

export const SUPPORTED_CONFIG_MAJOR = 1;

export class ScopeConfigError extends Error {
  constructor({ configPath, key, detail }) {
    super(`${configPath}: ${key ? `${key}: ` : ''}${detail}`);
    this.name = 'ScopeConfigError';
    this.configPath = configPath;
    this.key = key;
    this.detail = detail;
  }
}

export class ScopeConfigMissingError extends Error {
  constructor({ root, configPath }) {
    super(
      `scope-config: NOT FOUND at ${root}. The predicate reads its scope from a ${SCOPE_CONFIG_FILENAME} ` +
        'at the root it is pointed at; enumerating a tree with none would silently apply another ' +
        "repository's scope to it. " +
        `Write one at ${configPath}: it validates against ${SCOPE_CONFIG_SCHEMA_PATH} beside this ` +
        `predicate, whose own ${SCOPE_CONFIG_FILENAME} is a working example.`,
    );
    this.name = 'ScopeConfigMissingError';
    this.root = root;
    this.configPath = configPath;
  }
}

export function stripJsonc(text) {
  let blanked = '';
  let cursor = 0;
  for (const comment of extractComments(text, { jsx: false })) {
    blanked += text.slice(cursor, comment.start);
    blanked += text.slice(comment.start, comment.end).replace(/[^\n]/g, ' ');
    cursor = comment.end;
  }
  blanked += text.slice(cursor);

  let stripped = '';
  let inString = false;
  for (let index = 0; index < blanked.length; index += 1) {
    const char = blanked[index];
    if (inString) {
      stripped += char;
      if (char === '\\') {
        index += 1;
        stripped += blanked[index] ?? '';
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      stripped += char;
      continue;
    }
    if (char === ',') {
      let ahead = index + 1;
      while (ahead < blanked.length && /\s/.test(blanked[ahead])) ahead += 1;
      stripped += blanked[ahead] === '}' || blanked[ahead] === ']' ? ' ' : char;
      continue;
    }
    stripped += char;
  }
  return stripped;
}

export function expandBraces(glob) {
  const open = glob.indexOf('{');
  if (open === -1) {
    if (glob.includes('}')) throw new Error(`unbalanced brace in glob ${glob}`);
    return [glob];
  }
  let depth = 0;
  for (let index = open; index < glob.length; index += 1) {
    if (glob[index] === '{') depth += 1;
    else if (glob[index] === '}') depth -= 1;
    if (depth !== 0) continue;
    const body = glob.slice(open + 1, index);
    const members = splitTopLevel(body);
    if (glob[open - 1] === '\\') {
      throw new Error(
        `escaped brace in glob ${glob}. Only comma alternations are implemented, and an escaped ` +
          'brace is a literal everywhere else; expanding it here would govern a set the config ' +
          'never named.',
      );
    }
    if (body.includes('\\')) {
      throw new Error(
        `escaped character in the brace body of glob ${glob}. Only comma alternations are ` +
          'implemented, and the reference expanders treat a backslash as an escape, so splitting ' +
          'on the comma it protects would govern a set the config never named.',
      );
    }
    if (members.length === 1 && members[0].includes('..')) {
      throw new Error(
        `sequence expression in glob ${glob}. Only comma alternations are implemented; a range ` +
          'here compiles to a pattern that matches nothing rather than the paths it names.',
      );
    }
    if (members.length < 2) {
      throw new Error(
        `${body === '' ? 'empty brace' : 'single-member brace'} in glob ${glob}. Only comma ` +
          'alternations are implemented; every other reference treats this as a literal, so ' +
          'expanding it away silently governs a different directory than the one written.',
      );
    }
    const head = glob.slice(0, open);
    const tail = glob.slice(index + 1);
    return members.flatMap((member) => expandBraces(`${head}${member}${tail}`));
  }
  throw new Error(`unbalanced brace in glob ${glob}`);
}

function splitTopLevel(body) {
  const members = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '{') depth += 1;
    else if (body[index] === '}') depth -= 1;
    else if (body[index] === ',' && depth === 0) {
      members.push(body.slice(start, index));
      start = index + 1;
    }
  }
  members.push(body.slice(start));
  return members;
}

const CONFIG_KEYS = new Set(['$schema', 'version', 'families', 'units', 'exclude']);
const FAMILY_KEYS = new Set(['extensions', 'extractor']);
const UNIT_KEYS = new Set(['id', 'family', 'roots', 'files', 'allowEmpty']);
const DIRECTORY_SHAPED_EXCLUDE = /^\*\*\/([^/*]+)\/\*\*$/;

const REPOSITORY_ROOT = '.';

const ABSOLUTE_PATH = /^(?:[/\\]|[A-Za-z]:[/\\])/;

function canonicalizeConfigPath(value, key, fail) {
  if (ABSOLUTE_PATH.test(value)) {
    fail(
      key,
      `is the absolute path ${JSON.stringify(value)}. Every path here is relative to the root the ` +
        'predicate is pointed at, and an absolute one names a location that root does not own. ' +
        'Normalizing it would have to guess which prefix to drop, and guessing wrong moves a whole ' +
        'unit somewhere nobody declared, so an absolute path is refused rather than rewritten.',
    );
  }
  let path = value.replace(/\/{2,}/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  path = path.replace(/\/+$/, '');
  if (path === '' || path === REPOSITORY_ROOT) return REPOSITORY_ROOT;
  if (path.split('/').includes('..')) {
    fail(
      key,
      `walks out of the root with a .. segment (${JSON.stringify(value)}). Discovery only ever ` +
        'descends from the root, so a path that leaves it can never name a member; resolving the ' +
        '.. would silently retarget the unit at a tree this config does not govern, so it is ' +
        'refused rather than rewritten.',
    );
  }
  return path;
}

export function parseScopeConfig(text, { configPath }) {
  const fail = (key, detail) => {
    throw new ScopeConfigError({ configPath, key, detail });
  };
  let raw;
  try {
    raw = JSON.parse(stripJsonc(text));
  } catch (error) {
    fail(undefined, `is not parseable as JSONC (${error.message})`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(undefined, 'must be a JSON object');
  }
  if (!Number.isInteger(raw.version)) {
    fail('version', 'must be an integer naming the schema major this file is written against');
  }
  if (raw.version !== SUPPORTED_CONFIG_MAJOR) {
    fail(
      'version',
      `declares schema major ${raw.version}; this predicate reads major ${SUPPORTED_CONFIG_MAJOR}. ` +
        'Upgrade the predicate rather than loading a shape it cannot represent.',
    );
  }

  const unknownKeys = Object.keys(raw).filter((key) => !CONFIG_KEYS.has(key));
  const families = readFamilies(raw.families, fail, unknownKeys);
  const exclude = readGlobList(raw.exclude, 'exclude', fail);
  const units = readUnits(raw.units, families, fail, unknownKeys);

  const include = units.flatMap((unit) => unit.include);

  return {
    version: raw.version,
    configPath,
    families,
    units,
    exclude,
    include,
    unknownKeys,
    walkRoots: [
      ...new Set(
        units
          .flatMap((unit) => unit.roots)
          .filter((root) => root !== REPOSITORY_ROOT)
          .map(firstSegment),
      ),
    ].sort(),
    pruneDirectories: [
      ...new Set(
        exclude
          .map((glob) => DIRECTORY_SHAPED_EXCLUDE.exec(glob)?.[1])
          .filter((name) => name !== undefined),
      ),
    ].sort(),
    declaredPaths: units.flatMap((unit) => [
      ...unit.roots
        .map((root) => literalPrefix(root))
        .filter((prefix) => prefix !== REPOSITORY_ROOT)
        .map((prefix) => ({ unit: unit.id, kind: 'root', path: prefix })),
      ...unit.files.map((file) => ({ unit: unit.id, kind: 'file', path: file })),
    ]),
  };
}

function includeGlobFor(root, extension) {
  return root === REPOSITORY_ROOT ? `*${extension}` : `${root}/**/*${extension}`;
}

function firstSegment(root) {
  return root.split('/')[0];
}

function literalPrefix(root) {
  const literal = [];
  for (const segment of root.split('/')) {
    if (segment.includes('*')) break;
    literal.push(segment);
  }
  return literal.length === 0 ? REPOSITORY_ROOT : literal.join('/');
}

function readFamilies(value, fail, unknownKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('families', 'must be an object mapping a family id to its extensions and extractor');
  }
  const families = {};
  for (const [id, family] of Object.entries(value)) {
    if (family === null || typeof family !== 'object' || Array.isArray(family)) {
      fail(`families.${id}`, 'must be an object');
    }
    const extensions = family.extensions;
    if (!Array.isArray(extensions) || extensions.length === 0) {
      fail(`families.${id}.extensions`, 'must be a non-empty array of file extensions');
    }
    extensions.forEach((extension, index) => {
      if (typeof extension !== 'string' || !extension.startsWith('.') || extension.length < 2) {
        fail(
          `families.${id}.extensions[${index}]`,
          'must be a file extension with a leading dot and at least one character after it, got ' +
            JSON.stringify(extension),
        );
      }
    });
    if (typeof family.extractor !== 'string' || family.extractor === '') {
      fail(`families.${id}.extractor`, 'must name the extractor that reads this grammar family');
    }
    unknownKeys.push(
      ...Object.keys(family)
        .filter((key) => !FAMILY_KEYS.has(key))
        .map((key) => `families.${id}.${key}`),
    );
    families[id] = { id, extensions: [...extensions], extractor: family.extractor };
  }
  return families;
}

function readUnits(value, families, fail, unknownKeys) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('units', 'must be an array carrying at least one unit');
  }
  const seen = new Set();
  return value.map((unit, index) => {
    const at = `units[${index}]`;
    if (unit === null || typeof unit !== 'object' || Array.isArray(unit))
      fail(at, 'must be an object');
    if (typeof unit.id !== 'string' || unit.id === '')
      fail(`${at}.id`, 'must be a non-empty string');
    if (seen.has(unit.id)) fail(`${at}.id`, `duplicate unit id ${unit.id}`);
    seen.add(unit.id);
    if (!Object.hasOwn(families, unit.family)) {
      fail(
        `${at}.family`,
        `names family ${JSON.stringify(unit.family)}, which no families entry declares`,
      );
    }
    const roots = readGlobList(unit.roots, `${at}.roots`, fail, { allowEmpty: true });
    const files =
      unit.files === undefined
        ? []
        : readGlobList(unit.files, `${at}.files`, fail, {
            allowEmpty: true,
            expand: false,
            wildcards: false,
          });
    if (roots.length === 0 && files.length === 0) {
      fail(`${at}.roots`, 'a unit with no roots and no files can never discover anything');
    }
    if (unit.allowEmpty !== undefined && typeof unit.allowEmpty !== 'boolean') {
      fail(`${at}.allowEmpty`, 'must be a boolean');
    }
    unknownKeys.push(
      ...Object.keys(unit)
        .filter((key) => !UNIT_KEYS.has(key))
        .map((key) => `${at}.${key}`),
    );
    return {
      id: unit.id,
      family: unit.family,
      roots,
      files,
      allowEmpty: unit.allowEmpty === true,
      include: [
        ...roots.flatMap((root) =>
          families[unit.family].extensions.map((extension) => includeGlobFor(root, extension)),
        ),
        ...files,
      ],
    };
  });
}

export const UNSUPPORTED_GLOB_SYNTAX = /[?!{}[\]()]/;

function assertLiteralPath(entry) {
  if (!entry.includes('*')) return;
  throw new Error(
    `wildcard in ${entry}. A files entry names one path: discovery stats it literally, so a ` +
      'wildcard never adds a member, while the matcher still routes anything it matches into ' +
      "this unit's family. That reads a file under a grammar its own extension did not choose, " +
      'which reports it clean rather than refusing. Name each path, or declare a root.',
  );
}

function assertSupportedGlobSyntax(glob) {
  if (!UNSUPPORTED_GLOB_SYNTAX.test(glob)) return;
  throw new Error(
    `unsupported glob syntax in ${glob}. The matcher implements literals, * and ** only, so a ` +
      'character class, a single-character wildcard, a negation, a group or an unexpanded brace ' +
      'would be read as a literal rather than refused, and the unit would govern a set nobody ' +
      'declared.',
  );
}

function readGlobList(
  value,
  key,
  fail,
  { allowEmpty = false, expand = true, wildcards = true } = {},
) {
  if (value === undefined && allowEmpty) return [];
  if (!Array.isArray(value)) fail(key, 'must be an array of globs');
  value.forEach((glob, index) => {
    if (typeof glob !== 'string' || glob === '')
      fail(`${key}[${index}]`, 'must be a non-empty string');
  });
  let expanded;
  try {
    expanded = value.map((glob) => {
      const members = expand ? expandBraces(glob) : [glob];
      for (const member of members) {
        assertSupportedGlobSyntax(member);
        if (!wildcards) assertLiteralPath(member);
      }
      return members;
    });
  } catch (error) {
    fail(key, error.message);
  }
  return expanded.flatMap((members, index) =>
    members.map((member) => canonicalizeConfigPath(member, `${key}[${index}]`, fail)),
  );
}

export function loadScopeConfig(
  root,
  { readFileSync = nodeReadFileSync, existsSync = nodeExistsSync } = {},
) {
  const configPath = join(root, SCOPE_CONFIG_FILENAME);
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ScopeConfigError({
      configPath,
      detail: `could not be read (${error?.code ?? error?.message ?? 'unknown error'})`,
    });
  }
  const config = parseScopeConfig(text, { configPath });
  return {
    ...config,
    root,
    declaredAbsent: config.declaredPaths.filter(({ path }) => !existsSync(join(root, path))),
  };
}

export function unitsRequiringFiles(config) {
  if (!Array.isArray(config?.declaredAbsent)) {
    throw new TypeError(
      'unitsRequiringFiles needs a config carrying declaredAbsent, which only loadScopeConfig ' +
        'computes; a parseScopeConfig result has never stat-ed the tree, so every declared path ' +
        'would read as present.',
    );
  }
  const key = ({ unit, kind, path }) => `${unit}\u0000${kind}\u0000${path}`;
  const absent = new Set(config.declaredAbsent.map(key));
  return config.units
    .filter((unit) => !unit.allowEmpty)
    .filter((unit) => {
      const declared = config.declaredPaths.filter((entry) => entry.unit === unit.id);
      return !(declared.length > 0 && declared.every((entry) => absent.has(key(entry))));
    })
    .map((unit) => unit.id);
}
