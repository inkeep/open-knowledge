/**
 * Smoke test for the published JSON Schema artifact.
 *
 * Verifies that:
 *   1. The `dist/config-schema.json` artifact exists (so npm publish ships it
 *      via `package.json` `files: ['dist']`).
 *   2. The artifact compiles cleanly under ajv (so the URL the magic comment
 *      points at — `https://unpkg.com/@inkeep/open-knowledge@<MAJOR.MINOR>/dist/config-schema.json`
 *      — resolves to a working JSON Schema draft-07 doc that any LSP-aware
 *      editor can consume).
 *   3. A fixture matching the runtime `ConfigSchema` is accepted by the
 *      published artifact (same direction the IDE drives validation).
 *
 * The deeper schema-correctness contract (ajv ↔ ConfigSchema accept/reject
 * the same inputs across a fixture matrix) lives in
 * `packages/core/src/config/schema-jsonschema.test.ts`. THIS test only proves
 * the published artifact is current + ajv-compilable. If it goes stale,
 * `bun run --filter=@inkeep/open-knowledge build:schema` regenerates it.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, '..', '..', 'dist');
const PUBLISHED_SCHEMA_PATH = resolve(DIST, 'config-schema.json');
const VERSIONED_DIR = resolve(DIST, 'schemas', 'v0');
const VERSIONED_PROJECT_PATH = resolve(VERSIONED_DIR, 'config.project.schema.json');
const VERSIONED_USER_PATH = resolve(VERSIONED_DIR, 'config.user.schema.json');
const ALIAS_PROJECT_PATH = resolve(DIST, 'config.project.schema.json');
const ALIAS_USER_PATH = resolve(DIST, 'config.user.schema.json');

let schemaBuildNonce = 0;

async function ensurePublishedSchemas(): Promise<void> {
  // Turbo may run package build/test tasks in the same CI step; rebuild here so
  // assertions don't depend on a concurrently cleaned dist/ directory.
  schemaBuildNonce += 1;
  await import(`../../scripts/build-config-schema.mjs?test=${schemaBuildNonce}`);
}

describe('published dist/config-schema.json', () => {
  beforeEach(async () => {
    await ensurePublishedSchemas();
  });

  test('artifact exists at the path npm ships via files:["dist"]', () => {
    expect(existsSync(PUBLISHED_SCHEMA_PATH)).toBe(true);
  });

  test('versioned per-scope artifacts exist at dist/schemas/v0/ (canonical URLs)', () => {
    // `ok init` and writeConfigPatch's lazy first-write point YAML magic
    // comments at these paths. Bumping CONFIG_SCHEMA_MAJOR adds a new v<N>
    // dir; old majors stay published forever.
    expect(existsSync(VERSIONED_PROJECT_PATH)).toBe(true);
    expect(existsSync(VERSIONED_USER_PATH)).toBe(true);
  });

  test('back-compat per-scope aliases exist at dist root (pre-versioning magic comments)', () => {
    // Earlier scaffolds wrote URLs to dist root rather than the versioned
    // dir. We keep the root files forever so those YAMLs never lose
    // autocomplete.
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
    // project-only top-level sections
    expect(project.properties).toHaveProperty('content');
    expect(user.properties).not.toHaveProperty('content');
    // user-only top-level sections
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
    // Representative fixture exercising several sections at once. Every leaf
    // is valid against ConfigSchema; ajv must agree.
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
    // appearance.theme is enum 'light' | 'dark' | 'system'; pass an invalid
    // value to verify ajv rejects it.
    const fixture = { appearance: { theme: 'midnight' } };
    expect(validate(fixture)).toBe(false);
    expect(validate.errors?.length).toBeGreaterThan(0);
  });
});
