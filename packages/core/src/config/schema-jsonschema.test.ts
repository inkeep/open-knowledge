import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, test } from 'vitest';
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
    // The palette fields are open, shape-constrained strings (not a closed
    // enum), so a saved-theme id the built-in registry never heard of validates
    // — and the published IDE schema must agree with runtime on that shape.
    name: 'appearance.colorThemeLight accepts a saved-theme id (open string)',
    input: { appearance: { colorThemeLight: 'saved-my-theme' } },
    shouldAccept: true,
  },
  {
    name: 'appearance.colorThemeLight rejects an id outside the grammar',
    input: { appearance: { colorThemeLight: 'Not A Theme' } },
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
    name: 'editor.previewTabs=false accepted',
    input: { editor: { previewTabs: false } },
    shouldAccept: true,
  },
  {
    name: 'editor.previewTabs string rejected',
    input: { editor: { previewTabs: 'false' } },
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
    name: 'autoSync.mode=pull accepted',
    input: { autoSync: { mode: 'pull' } },
    shouldAccept: true,
  },
  {
    name: 'autoSync.mode=sideways rejected',
    input: { autoSync: { mode: 'sideways' } },
    shouldAccept: false,
  },
  {
    name: 'autoSync.default=full (mode string) accepted',
    input: { autoSync: { default: 'full' } },
    shouldAccept: true,
  },
  {
    name: 'autoSync.default=true (legacy boolean seed) accepted',
    input: { autoSync: { default: true } },
    shouldAccept: true,
  },
  {
    name: 'autoSync.default=3 (outside boolean|mode union) rejected',
    input: { autoSync: { default: 3 } },
    shouldAccept: false,
  },
  {
    name: 'unknown top-level key passes (looseObject)',
    input: { future_feature: { enabled: true } },
    shouldAccept: true,
  },
  {
    // `server.host` is a removed key (REMOVED_KEYS), not a schema leaf — it
    // rides through the loose `server` section, which now also carries live
    // leaves (`server.port` etc. below).
    name: 'stale dropped fields pass via loose-mode',
    input: {
      sync: { pushIntervalSeconds: 30 },
      persistence: { debounceMs: 2000 },
      server: { host: 'localhost' },
      mcp: { autoStart: false },
    },
    shouldAccept: true,
  },
  {
    name: 'server.port in range accepted',
    input: { server: { port: 8080 } },
    shouldAccept: true,
  },
  {
    name: 'server.port out of range rejected',
    input: { server: { port: 0 } },
    shouldAccept: false,
  },
  {
    name: 'server.bind list accepted',
    input: { server: { bind: ['127.0.0.1', '::1'] } },
    shouldAccept: true,
  },
  {
    name: 'server.bind empty list rejected',
    input: { server: { bind: [] } },
    shouldAccept: false,
  },
  {
    name: 'server.externalUrl https URL accepted',
    input: { server: { externalUrl: 'https://kb.example.com' } },
    shouldAccept: true,
  },
  {
    name: 'server.externalUrl non-URL rejected',
    input: { server: { externalUrl: 'not a url' } },
    shouldAccept: false,
  },
  {
    // The protocol restriction must appear in the published JSON schema, not
    // just at runtime — otherwise a $schema-aware editor green-lights a scheme
    // (ftp:, javascript:) that ConfigSchema rejects at boot. externalUrl drives
    // CORS + URL issuance, so the divergence is security-relevant.
    name: 'server.externalUrl ftp:// rejected in both validators (protocol pattern serializes)',
    input: { server: { externalUrl: 'ftp://kb.example.com' } },
    shouldAccept: false,
  },
  {
    name: 'server.allowExternal boolean accepted',
    input: { server: { allowExternal: true } },
    shouldAccept: true,
  },
  {
    name: 'server.allowExternal string rejected',
    input: { server: { allowExternal: 'yes' } },
    shouldAccept: false,
  },
  {
    name: "server.idleShutdown 'off' accepted",
    input: { server: { idleShutdown: 'off' } },
    shouldAccept: true,
  },
  {
    name: 'server.idleShutdown duration accepted',
    input: { server: { idleShutdown: '30m' } },
    shouldAccept: true,
  },
  {
    name: 'server.idleShutdown unknown unit rejected',
    input: { server: { idleShutdown: '1d' } },
    shouldAccept: false,
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

  test('user schema exposes optional editor.previewTabs boolean with default true', () => {
    const editorSchema = jsonSchema.properties?.editor as {
      properties?: Record<string, { type?: string; default?: unknown }>;
      required?: string[];
    };
    expect(editorSchema.properties?.previewTabs).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(editorSchema.required ?? []).not.toContain('previewTabs');
  });
});

describe('loose-mode forgiveness', () => {
  test('config with stale dropped fields loads and resolves known values', () => {
    const result = ConfigSchema.safeParse({
      sync: { pushIntervalSeconds: 30, autoCommit: true },
      persistence: { debounceMs: 2000 },
      server: { host: 'example.dev' },
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

  test('lossCapture defaults to enabled with a rotation cap', () => {
    const config = ConfigSchema.parse({});
    expect(config.lossCapture.enabled).toBe(true);
    expect(config.lossCapture.maxBytes).toBe(12_582_912);
  });

  test('lossCapture.enabled=false preserved through parse', () => {
    const config = ConfigSchema.parse({ lossCapture: { enabled: false } });
    expect(config.lossCapture.enabled).toBe(false);
    // The sibling cap still resolves to its default even when enabled is overridden.
    expect(config.lossCapture.maxBytes).toBe(12_582_912);
  });

  test('lossCapture custom maxBytes preserved', () => {
    const config = ConfigSchema.parse({ lossCapture: { maxBytes: 4096 } });
    expect(config.lossCapture.maxBytes).toBe(4096);
    expect(config.lossCapture.enabled).toBe(true);
  });

  test('bridge.backgroundThrottle defaults to enabled', () => {
    const config = ConfigSchema.parse({});
    expect(config.bridge.backgroundThrottle.enabled).toBe(true);
  });

  test('bridge.backgroundThrottle.enabled=false preserved through parse', () => {
    const config = ConfigSchema.parse({ bridge: { backgroundThrottle: { enabled: false } } });
    expect(config.bridge.backgroundThrottle.enabled).toBe(false);
  });

  test('bridge.deferGuard defaults to enabled', () => {
    const config = ConfigSchema.parse({});
    expect(config.bridge.deferGuard.enabled).toBe(true);
  });

  test('bridge.deferGuard.enabled=false preserved through parse', () => {
    const config = ConfigSchema.parse({ bridge: { deferGuard: { enabled: false } } });
    expect(config.bridge.deferGuard.enabled).toBe(false);
  });

  test('bridge.lossDetector defaults to enabled', () => {
    const config = ConfigSchema.parse({});
    expect(config.bridge.lossDetector.enabled).toBe(true);
  });

  test('bridge.lossDetector.enabled=false preserved through parse', () => {
    const config = ConfigSchema.parse({ bridge: { lossDetector: { enabled: false } } });
    expect(config.bridge.lossDetector.enabled).toBe(false);
  });

  test('bridge.fixedPoint defaults to enabled', () => {
    const config = ConfigSchema.parse({});
    expect(config.bridge.fixedPoint.enabled).toBe(true);
  });

  test('bridge.fixedPoint.enabled=false preserved through parse', () => {
    const config = ConfigSchema.parse({ bridge: { fixedPoint: { enabled: false } } });
    expect(config.bridge.fixedPoint.enabled).toBe(false);
  });

  test('bridge.preDrain defaults to enabled', () => {
    const config = ConfigSchema.parse({});
    expect(config.bridge.preDrain.enabled).toBe(true);
  });

  test('bridge.preDrain.enabled=false preserved through parse', () => {
    const config = ConfigSchema.parse({ bridge: { preDrain: { enabled: false } } });
    expect(config.bridge.preDrain.enabled).toBe(false);
  });

  test('bridge.flushOnHide defaults to enabled', () => {
    const config = ConfigSchema.parse({});
    expect(config.bridge.flushOnHide.enabled).toBe(true);
  });

  test('bridge.flushOnHide.enabled=false preserved through parse', () => {
    const config = ConfigSchema.parse({ bridge: { flushOnHide: { enabled: false } } });
    expect(config.bridge.flushOnHide.enabled).toBe(false);
  });
});
