import { describe, expect, test } from 'bun:test';
import { parseDocument } from 'yaml';
import { isKnownConfigError } from './errors.ts';
import { detectRemovedKeys, REMOVED_KEYS } from './removed-keys.ts';

/** Build a nested object `{ a: { b: <leaf> } }` from a dotted path. */
function nest(path: readonly string[], leaf: unknown): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cur[path[i] as string] = next;
    cur = next;
  }
  cur[path[path.length - 1] as string] = leaf;
  return root;
}

describe('REMOVED_KEYS registry', () => {
  test('every entry has a non-empty path and redirect', () => {
    expect(REMOVED_KEYS.length).toBeGreaterThan(0);
    for (const entry of REMOVED_KEYS) {
      expect(entry.path.length).toBeGreaterThan(0);
      expect(entry.redirect.length).toBeGreaterThan(0);
    }
  });

  test('includes the headline previously-silent keys', () => {
    const dotted = REMOVED_KEYS.map((k) => k.path.join('.'));
    expect(dotted).toContain('folders');
    expect(dotted).toContain('appearance.editorModeDefault');
  });

  test('paths are unique', () => {
    const dotted = REMOVED_KEYS.map((k) => k.path.join('.'));
    expect(new Set(dotted).size).toBe(dotted.length);
  });
});

describe('detectRemovedKeys', () => {
  // Table-driven: every registry entry, in isolation, must be detected and
  // carry its own redirect.
  for (const entry of REMOVED_KEYS) {
    const dotted = entry.path.join('.');
    test(`detects ${dotted}`, () => {
      const errors = detectRemovedKeys({ value: nest(entry.path, 'x') });
      expect(errors).toHaveLength(1);
      const [err] = errors;
      expect(err?.code).toBe('REMOVED_KEY');
      if (err !== undefined && isKnownConfigError(err) && err.code === 'REMOVED_KEY') {
        expect(err.path).toEqual(entry.path);
        expect(err.redirect).toBe(entry.redirect);
        expect(err.source).toBeUndefined(); // value-only mode
      }
    });
  }

  test('a config carrying several removed keys reports all of them in one pass', () => {
    const errors = detectRemovedKeys({
      value: {
        folders: [{ path: 'x/**' }],
        server: { host: '0.0.0.0' },
        appearance: { editorModeDefault: 'source' },
      },
    });
    const paths = errors.map((e) =>
      isKnownConfigError(e) && e.code === 'REMOVED_KEY' ? e.path.join('.') : '',
    );
    expect(paths).toContain('folders');
    expect(paths).toContain('server.host');
    expect(paths).toContain('appearance.editorModeDefault');
  });

  test('clean config yields no errors', () => {
    expect(detectRemovedKeys({ value: { content: { dir: 'docs' } } })).toEqual([]);
  });

  test('a key whose only sibling is current (not the removed leaf) is not flagged', () => {
    // upload.maxBytes is removed, but a config with only upload.<other> must
    // not false-positive — detection is leaf-exact.
    expect(detectRemovedKeys({ value: { upload: { somethingElse: 1 } } })).toEqual([]);
    // telemetry.localSink.*.maxBytes is a CURRENT key; the removed one is
    // upload.maxBytes specifically.
    expect(
      detectRemovedKeys({ value: { telemetry: { localSink: { spans: { maxBytes: 4096 } } } } }),
    ).toEqual([]);
  });

  test('attaches source location (value node) when doc + source supplied', () => {
    const source = 'preview:\n  baseUrl: https://example.test\n';
    const doc = parseDocument(source);
    const errors = detectRemovedKeys({ value: doc.toJSON(), file: '/tmp/config.yml', source, doc });
    expect(errors).toHaveLength(1);
    const [err] = errors;
    if (err !== undefined && isKnownConfigError(err) && err.code === 'REMOVED_KEY') {
      expect(err.source?.file).toBe('/tmp/config.yml');
      // locateIssue points at the value node — `baseUrl`'s value is on line 2.
      expect(err.source?.line).toBe(2);
    }
  });

  test('non-object input yields no errors', () => {
    expect(detectRemovedKeys({ value: null })).toEqual([]);
    expect(detectRemovedKeys({ value: 'string' })).toEqual([]);
    expect(detectRemovedKeys({ value: [] })).toEqual([]);
  });
});
