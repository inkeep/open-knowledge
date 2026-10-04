import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { beforeAll, describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, '..', '..', 'dist');
const PUBLISHED_SCHEMA_PATH = resolve(DIST, 'config-schema.json');
const VERSIONED_DIR = resolve(DIST, 'schemas', 'v0');
const VERSIONED_PROJECT_PATH = resolve(VERSIONED_DIR, 'config.project.schema.json');
const VERSIONED_USER_PATH = resolve(VERSIONED_DIR, 'config.user.schema.json');
const ALIAS_PROJECT_PATH = resolve(DIST, 'config.project.schema.json');
const ALIAS_USER_PATH = resolve(DIST, 'config.user.schema.json');

describe('published dist/config-schema.json', () => {
  beforeAll(() => {
    if (!existsSync(PUBLISHED_SCHEMA_PATH)) {
      throw new Error(
        `${PUBLISHED_SCHEMA_PATH} is absent: these tests read the schema files the CLI build publishes, so generate them with pnpm run build:schema in packages/cli (the CLI build includes that step, and turbo runs the CLI build before this package's tests).`,
      );
    }
  });

  test('versioned per-scope artifacts exist at dist/schemas/v0/ (canonical URLs)', () => {
    expect(existsSync(VERSIONED_PROJECT_PATH)).toBe(true);
    expect(existsSync(VERSIONED_USER_PATH)).toBe(true);
  });

  test('back-compat per-scope aliases exist at dist root (pre-versioning magic comments)', () => {
    expect(existsSync(ALIAS_PROJECT_PATH)).toBe(true);
    expect(existsSync(ALIAS_USER_PATH)).toBe(true);
  });

  test('per-scope artifacts disjointly cover scope-specific fields', () => {
    const project = JSON.parse(readFileSync(VERSIONED_PROJECT_PATH, 'utf-8')) as {
      properties?: Record<string, unknown>;
    };
    const user = JSON.parse(readFileSync(VERSIONED_USER_PATH, 'utf-8')) as {
      properties?: Record<string, unknown>;
    };
    expect(project.properties).toHaveProperty('content');
    expect(user.properties).not.toHaveProperty('content');
    expect(user.properties).toHaveProperty('appearance');
    expect(user.properties).toHaveProperty('editor');
    expect(project.properties).not.toHaveProperty('appearance');
    expect(project.properties).not.toHaveProperty('editor');
  });

  test('artifact is JSON-parsable + declares draft-07', () => {
    const raw = readFileSync(PUBLISHED_SCHEMA_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { $schema?: string; type?: string };
    expect(parsed.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(parsed.type).toBe('object');
  });

  test('ajv compiles the published artifact without errors', () => {
    const raw = readFileSync(PUBLISHED_SCHEMA_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as object;
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    expect(() => ajv.compile(parsed)).not.toThrow();
  });

  test('ajv accepts a fixture matching the runtime ConfigSchema shape', () => {
    const raw = readFileSync(PUBLISHED_SCHEMA_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as object;
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(parsed);
    const fixture = {
      content: { dir: '.', include: ['**/*.md'], exclude: [] },
      mcp: { autoStart: true, tools: { search: { maxResults: 50 } } },
      appearance: { theme: 'dark' },
      editor: { wordWrap: false },
      folders: [{ match: 'specs/**', frontmatter: { description: 'Specs' } }],
    };
    const ok = validate(fixture);
    if (!ok) {
      throw new Error(`ajv rejected fixture: ${JSON.stringify(validate.errors, null, 2)}`);
    }
    expect(ok).toBe(true);
  });

  test('ajv rejects a fixture violating a leaf type', () => {
    const raw = readFileSync(PUBLISHED_SCHEMA_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as object;
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(parsed);
    const fixture = { appearance: { theme: 'midnight' } };
    expect(validate(fixture)).toBe(false);
    expect(validate.errors?.length).toBeGreaterThan(0);
  });
});
