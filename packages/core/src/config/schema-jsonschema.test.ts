import { describe, expect, test } from 'bun:test';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import { fieldRegistry } from './field-registry.ts';
import { ConfigSchema } from './schema.ts';

// Single shared Ajv instance for the equivalence fixture run.
function buildAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

const jsonSchema = z.toJSONSchema(ConfigSchema, {
  io: 'input',
  target: 'draft-7',
  metadata: fieldRegistry,
});

const ajv = buildAjv();
const validate = ajv.compile(jsonSchema);

interface Fixture {
  name: string;
  input: unknown;
  /** True if both validators should accept; false if both should reject. */
  shouldAccept: boolean;
}

// Representative coverage across leaves and section defaults. Both ajv (over
// the published JSON Schema) and ConfigSchema.safeParse must agree on every
// fixture — guards against `.transform()` / `.coerce()` slipping into the
// schema and silently breaking IDE/runtime equivalence.
const FIXTURES: Fixture[] = [
  { name: 'empty object — defaults fill in', input: {}, shouldAccept: true },
  {
    name: 'content section with dir set',
    input: { content: { dir: 'docs' } },
    shouldAccept: true,
  },
  {
    name: 'content with non-string dir rejected',
    input: { content: { dir: 12345 } },
    shouldAccept: false,
  },
  {
    name: 'appearance.theme=dark accepted',
    input: { appearance: { theme: 'dark' } },
    shouldAccept: true,
  },
  {
    name: 'appearance.theme=midnight rejected',
    input: { appearance: { theme: 'midnight' } },
    shouldAccept: false,
  },
  {
    name: 'editor.wordWrap=false accepted',
    input: { editor: { wordWrap: false } },
    shouldAccept: true,
  },
  {
    name: 'editor.wordWrap string rejected',
    input: { editor: { wordWrap: 'false' } },
    shouldAccept: false,
  },
  {
    name: 'appearance.preview.autoOpen=false accepted',
    input: { appearance: { preview: { autoOpen: false } } },
    shouldAccept: true,
  },
  {
    name: 'appearance.preview.autoOpen string rejected',
    input: { appearance: { preview: { autoOpen: 'banana' } } },
    shouldAccept: false,
  },
  // `folders` removed from ConfigSchema. Folder defaults
  // live in nested `<folder>/.ok/frontmatter.yml` files now.
  {
    name: 'telemetry.localSink.enabled=false accepted',
    input: { telemetry: { localSink: { enabled: false } } },
    shouldAccept: true,
  },
  {
    name: 'telemetry.localSink.enabled string rejected',
    input: { telemetry: { localSink: { enabled: 'true' } } },
    shouldAccept: false,
  },
  {
    name: 'telemetry.localSink.spans.maxBytes=4096 accepted',
    input: { telemetry: { localSink: { spans: { maxBytes: 4096 } } } },
    shouldAccept: true,
  },
  {
    name: 'telemetry.localSink.attributeDenylist accepts string array',
    input: { telemetry: { localSink: { attributeDenylist: ['x-custom-secret'] } } },
    shouldAccept: true,
  },
  {
    name: 'telemetry.localSink.attributeDenylist rejects non-string entries',
    input: { telemetry: { localSink: { attributeDenylist: [42] } } },
    shouldAccept: false,
  },
  {
    name: 'unknown top-level key passes (looseObject)',
    input: { future_feature: { enabled: true } },
    shouldAccept: true,
  },
  {
    name: 'stale dropped fields pass via loose-mode',
    input: {
      sync: { pushIntervalSeconds: 30 },
      persistence: { debounceMs: 2000 },
      server: { port: 3000, host: 'localhost' },
      mcp: { autoStart: false },
    },
    shouldAccept: true,
  },
];

describe('JSON Schema ↔ runtime equivalence', () => {
  test.each(FIXTURES)('$name → both validators agree', ({ input, shouldAccept }) => {
    const ajvAccept = validate(input);
    const zodAccept = ConfigSchema.safeParse(input).success;
    if (ajvAccept !== shouldAccept || zodAccept !== shouldAccept) {
      throw new Error(
        `Fixture disagreed (expected ${shouldAccept ? 'accept' : 'reject'}): ajv=${ajvAccept}, zod=${zodAccept}, ajvErrors=${JSON.stringify(validate.errors)}`,
      );
    }
    expect(ajvAccept).toBe(shouldAccept);
    expect(zodAccept).toBe(shouldAccept);
  });
});

describe('loose-mode forgiveness', () => {
  test('config with stale dropped fields loads and resolves known values', () => {
    const result = ConfigSchema.safeParse({
      sync: { pushIntervalSeconds: 30, autoCommit: true },
      persistence: { debounceMs: 2000 },
      server: { port: 3000, host: 'example.dev' },
      mcp: { autoStart: false },
      content: { dir: 'docs' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Defaults still resolve for known fields.
      expect(result.data.content.dir).toBe('docs');
      // Unknown top-level passes through into the loose-typed payload.
      expect((result.data as Record<string, unknown>).sync).toEqual({
        pushIntervalSeconds: 30,
        autoCommit: true,
      });
    }
  });

  test('appearance.theme defaults to UNSET', () => {
    const config = ConfigSchema.parse({});
    expect(config.appearance.theme).toBeUndefined();
  });

  test('editor.wordWrap defaults to true', () => {
    const config = ConfigSchema.parse({});
    expect(config.editor.wordWrap).toBe(true);
  });

  test('appearance.preview.autoOpen defaults to true', () => {
    const config = ConfigSchema.parse({});
    expect(config.appearance.preview.autoOpen).toBe(true);
  });

  test('appearance.preview.autoOpen preserves an explicit false', () => {
    const config = ConfigSchema.parse({ appearance: { preview: { autoOpen: false } } });
    expect(config.appearance.preview.autoOpen).toBe(false);
  });

  test('telemetry.localSink defaults to enabled with built-in caps + denylist', () => {
    const config = ConfigSchema.parse({});
    expect(config.telemetry.localSink.enabled).toBe(true);
    expect(config.telemetry.localSink.spans.maxBytes).toBe(52_428_800);
    expect(config.telemetry.localSink.logs.maxBytes).toBe(26_214_400);
    expect(config.telemetry.localSink.attributeDenylist).toEqual([
      'authorization',
      'auth.token',
      'auth.bearer',
      'cookie',
      'set-cookie',
      'x-api-key',
      'password',
      'secret',
    ]);
  });

  test('telemetry.localSink.enabled=false preserved through parse', () => {
    const config = ConfigSchema.parse({ telemetry: { localSink: { enabled: false } } });
    expect(config.telemetry.localSink.enabled).toBe(false);
    // Sibling defaults still resolve even when one leaf is overridden.
    expect(config.telemetry.localSink.spans.maxBytes).toBe(52_428_800);
  });

  test('telemetry.localSink custom maxBytes preserved', () => {
    const config = ConfigSchema.parse({
      telemetry: { localSink: { spans: { maxBytes: 1024 }, logs: { maxBytes: 2048 } } },
    });
    expect(config.telemetry.localSink.spans.maxBytes).toBe(1024);
    expect(config.telemetry.localSink.logs.maxBytes).toBe(2048);
  });

  test('telemetry.localSink.attributeDenylist replaces (does not merge with) defaults', () => {
    const config = ConfigSchema.parse({
      telemetry: { localSink: { attributeDenylist: ['x-internal-token'] } },
    });
    expect(config.telemetry.localSink.attributeDenylist).toEqual(['x-internal-token']);
  });
});
