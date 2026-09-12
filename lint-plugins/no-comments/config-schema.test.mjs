import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  parseScopeConfig,
  SCOPE_CONFIG_FILENAME,
  SUPPORTED_CONFIG_MAJOR,
  stripJsonc,
  UNSUPPORTED_GLOB_SYNTAX,
} from './config.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MODULE_DIR, '..', '..');
const SCHEMA_PATH = join(MODULE_DIR, 'no-comments.config.schema.json');
const CONFIG_PATH = join(REPO_ROOT, SCOPE_CONFIG_FILENAME);

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const configText = readFileSync(CONFIG_PATH, 'utf8');

const ANNOTATION_KEYWORDS = new Set(['$ref', 'title', 'description', 'examples', 'default']);

const SUPPORTED_KEYWORDS = new Set([
  '$ref',
  '$schema',
  '$id',
  'title',
  'description',
  'type',
  'required',
  'anyOf',
  'minProperties',
  'properties',
  'additionalProperties',
  'minItems',
  'items',
  'enum',
  'minLength',
  'pattern',
  '$defs',
  'examples',
  'default',
]);

function validate(value, node = schema, path = '') {
  const errors = [];
  const at = (suffix) => (path === '' ? suffix : `${path}${suffix}`);
  const unsupported = Object.keys(node).filter((keyword) => !SUPPORTED_KEYWORDS.has(keyword));
  if (unsupported.length > 0) {
    throw new Error(
      `this validator implements ${[...SUPPORTED_KEYWORDS].sort().join(', ')} and the schema now ` +
        `uses ${unsupported.join(', ')} at ${at('') || '<root>'}. An unimplemented keyword is ` +
        'silently ignored, so the fidelity this test claims to pin would be fiction.',
    );
  }
  if (node.$ref) {
    const applied = Object.keys(node).filter((keyword) => !ANNOTATION_KEYWORDS.has(keyword));
    if (applied.length > 0) {
      throw new Error(
        `${at('') || '<root>'} places ${applied.join(', ')} beside a $ref. Draft 2020-12 applies ` +
          'such siblings and this validator does not, so the schema would assert more than the ' +
          'test can see; inline the constraint or extend this validator.',
      );
    }
    return validate(value, resolveRef(node.$ref), path);
  }
  if (Array.isArray(node.anyOf)) {
    const branches = node.anyOf.map((branch) => validate(value, branch, path));
    if (branches.every((branch) => branch.length > 0)) {
      errors.push(`${at('') || '<root>'} matches no anyOf branch: ${branches.flat().join('; ')}`);
    }
  }
  const isPlainObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (node.type === 'object' && !isPlainObject) {
    return [`${at('') || '<root>'} must be an object`];
  }
  if (node.type === 'array' && !Array.isArray(value)) return [`${at('')} must be an array`];
  if (isPlainObject) {
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${at(`.${key}`)} is required`);
    }
    if (typeof node.minProperties === 'number' && Object.keys(value).length < node.minProperties) {
      errors.push(`${at('') || '<root>'} needs at least ${node.minProperties} entries`);
    }
    for (const [key, member] of Object.entries(value)) {
      const child = node.properties?.[key] ?? node.additionalProperties;
      if (child === false) errors.push(`${at(`.${key}`)} is not an allowed key`);
      else if (child && child !== true) errors.push(...validate(member, child, at(`.${key}`)));
    }
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems) {
      errors.push(`${at('')} needs at least ${node.minItems} items`);
    }
    if (node.items !== undefined && node.items !== true) {
      value.forEach((item, index) => errors.push(...validate(item, node.items, at(`[${index}]`))));
    }
  }
  if (node.type === 'integer' && !Number.isInteger(value))
    errors.push(`${at('')} must be an integer`);
  if (node.type === 'string' && typeof value !== 'string')
    errors.push(`${at('')} must be a string`);
  if (node.type === 'boolean' && typeof value !== 'boolean')
    errors.push(`${at('')} must be a boolean`);
  if (node.enum && !node.enum.includes(value))
    errors.push(`${at('')} must be one of ${node.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (typeof node.minLength === 'number' && value.length < node.minLength) {
      errors.push(`${at('')} is shorter than ${node.minLength}`);
    }
    if (node.pattern && !new RegExp(node.pattern).test(value)) {
      errors.push(`${at('')} does not match ${node.pattern}`);
    }
  }
  return errors;
}

function resolveRef(ref) {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((node, segment) => node[segment], schema);
}

describe('the vendored schema an editor completes against', () => {
  test('the committed config declares it, by a path that resolves on disk', () => {
    const declared = JSON.parse(stripJsonc(configText)).$schema;
    expect(relative(REPO_ROOT, join(REPO_ROOT, declared))).toBe(
      relative(REPO_ROOT, SCHEMA_PATH).split('\\').join('/'),
    );
    expect(() => readFileSync(join(REPO_ROOT, declared), 'utf8')).not.toThrow();
  });

  test('the schema and the loader agree on which schema major is readable', () => {
    expect(schema.properties.version.enum).toEqual([SUPPORTED_CONFIG_MAJOR]);
  });

  test('the committed config validates against it', () => {
    expect(validate(JSON.parse(stripJsonc(configText)))).toEqual([]);
  });

  test('the validator is not vacuous: it rejects each shape the loader rejects', () => {
    const good = JSON.parse(stripJsonc(configText));
    const mutants = {
      'an extension that is a bare dot': {
        ...good,
        families: { ...good.families, dotless: { extensions: ['.'], extractor: 'c-family' } },
      },
      'a version the schema does not know': { ...good, version: 2 },
      'a missing units key': { ...good, units: undefined },
      'an extension with no leading dot': {
        ...good,
        families: { ts: { extensions: ['ts'], extractor: 'c-family' } },
      },
      'a family with no extractor': {
        ...good,
        families: { ts: { extensions: ['.ts'] } },
      },
      'an empty units array': { ...good, units: [] },
      'a unit with no id': { ...good, units: [{ family: 'typescript', roots: ['packages'] }] },
      'an exclude that is not an array': { ...good, exclude: '**/dist/**' },
      'a root that walks out of the repository root': {
        ...good,
        units: [{ id: 'escape', family: 'typescript', roots: ['../sibling/src'] }],
      },
      'a root that is an absolute path': {
        ...good,
        units: [{ id: 'absolute', family: 'typescript', roots: ['/etc'] }],
      },
      'an exclude that walks out of the repository root': {
        ...good,
        exclude: ['packages/../../elsewhere/**'],
      },
      'a unit that declares neither roots nor files': {
        ...good,
        units: [{ id: 'empty', family: 'typescript' }],
      },
      'a unit whose only membership key is an empty roots array': {
        ...good,
        units: [{ id: 'empty', family: 'typescript', roots: [] }],
      },
      'a unit whose only membership key is an empty files array': {
        ...good,
        units: [{ id: 'empty', family: 'typescript', files: [] }],
      },
      'an exclude entry that is an array, not a string': { ...good, exclude: [['dist']] },
      'a version that is an array, not an integer': { ...good, version: [1] },
    };
    for (const [label, mutant] of Object.entries(mutants)) {
      const scrubbed = JSON.parse(JSON.stringify(mutant));
      expect({ label, errors: validate(scrubbed).length > 0 }).toEqual({ label, errors: true });
      expect({ label, loader: throwsOnLoad(scrubbed) }).toEqual({ label, loader: true });
    }
  });

  test('every shape the loader accepts, the schema accepts too', () => {
    const good = JSON.parse(stripJsonc(configText));
    const accepted = {
      'a unit carried entirely by explicit files': {
        ...good,
        units: [{ id: 'hooks', family: 'shell', files: ['.husky/pre-commit'] }],
      },
      'a unit that declares both roots and files': {
        ...good,
        units: [{ id: 'both', family: 'shell', roots: ['scripts'], files: ['.husky/pre-commit'] }],
      },
      'a files entry whose extension its own family declares': {
        ...good,
        units: [{ id: 'app', family: 'esm-script', roots: ['scripts'], files: ['tools/one.mjs'] }],
      },
      'a unit that opts out of the non-vacuity floor': {
        ...good,
        units: [{ id: 'app', family: 'typescript', roots: ['packages/*/src'], allowEmpty: true }],
      },
    };
    for (const [label, shape] of Object.entries(accepted)) {
      const scrubbed = JSON.parse(JSON.stringify(shape));
      expect({ label, loader: throwsOnLoad(scrubbed) }).toEqual({ label, loader: false });
      expect({ label, errors: validate(scrubbed) }).toEqual({ label, errors: [] });
    }
  });

  test('the validator refuses to run against a keyword it does not implement', () => {
    expect(() => validate({}, { type: 'object', maxProperties: 1 })).toThrow(/maxProperties/);
    expect(() => validate({}, { type: 'object', maxProperties: 1 })).toThrow(/fiction/);
  });

  test('the validator refuses an applied keyword beside a $ref rather than ignoring it', () => {
    expect(() => validate('x', { $ref: '#/$defs/glob', minLength: 99 })).toThrow(/beside a \$ref/);
    expect(() => validate('x', { $ref: '#/$defs/glob', description: 'fine' })).not.toThrow();
  });

  test('every shape the schema accepts, the loader accepts too', () => {
    const good = JSON.parse(stripJsonc(configText));
    const schemaLegal = {
      'a brace alternation in roots': {
        ...good,
        units: [{ id: 'app', family: 'typescript', roots: ['packages/{app,core}/src'] }],
      },
      'a brace alternation in exclude': { ...good, exclude: ['**/{dist,build}/**'] },
      'a dot root': { ...good, units: [{ id: 'root', family: 'typescript', roots: ['.'] }] },
      'a trailing slash on a root': {
        ...good,
        units: [{ id: 'app', family: 'typescript', roots: ['packages/'] }],
      },
    };
    for (const [label, shape] of Object.entries(schemaLegal)) {
      const scrubbed = JSON.parse(JSON.stringify(shape));
      expect({ label, errors: validate(scrubbed) }).toEqual({ label, errors: [] });
      expect({ label, loader: throwsOnLoad(scrubbed) }).toEqual({ label, loader: false });
    }
  });

  test('every character the loader refuses in a glob, the schema refuses by name', () => {
    const printable = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index));
    const preExpansion = printable.filter(
      (char) => UNSUPPORTED_GLOB_SYNTAX.test(char) && char !== '{' && char !== '}',
    );
    expect(preExpansion.length).toBeGreaterThan(0);

    const good = JSON.parse(stripJsonc(configText));
    for (const char of preExpansion) {
      const scrubbed = JSON.parse(
        JSON.stringify({
          ...good,
          units: [{ id: 'probe', family: 'typescript', roots: [`packages/a${char}b/src`] }],
        }),
      );
      expect({ char, schema: validate(scrubbed).join('\n') }).toEqual({
        char,
        schema: expect.stringContaining('.units[0].roots[0] does not match'),
      });
      expect({ char, loader: throwsOnLoad(scrubbed) }).toEqual({ char, loader: true });
    }
  });
});

function throwsOnLoad(value) {
  try {
    parseScopeConfig(JSON.stringify(value), { configPath: CONFIG_PATH });
    return false;
  } catch {
    return true;
  }
}
