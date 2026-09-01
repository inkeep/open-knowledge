import { describe, expect, test } from 'vitest';
import { parseDocument } from 'yaml';
import { isKnownConfigError } from './errors.ts';
import { detectRemovedKeys, REMOVED_KEYS, stripRemovedKeys } from './removed-keys.ts';

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

  test('showAllFiles redirect names the only-markdown view preference as its successor', () => {
    const entry = REMOVED_KEYS.find((k) => k.path.join('.') === 'appearance.sidebar.showAllFiles');
    expect(entry?.redirect).toContain('appearance.sidebar.showOnlyMarkdownFiles');
  });
});

describe('detectRemovedKeys', () => {
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
        expect(err.source).toBeUndefined();
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

  test('server.host redirect names the server.bind file key, not just the flag/env escape hatches', () => {
    const errors = detectRemovedKeys({ value: { server: { host: '0.0.0.0' } } });
    const entry = errors.find(
      (e) =>
        isKnownConfigError(e) && e.code === 'REMOVED_KEY' && e.path.join('.') === 'server.host',
    );
    expect(entry).toBeDefined();
    if (entry !== undefined && isKnownConfigError(entry) && entry.code === 'REMOVED_KEY') {
      expect(entry.redirect).toContain('server.bind');
      expect(entry.redirect).toContain('server.allowExternal');
    }
  });

  test('clean config yields no errors', () => {
    expect(detectRemovedKeys({ value: { content: { dir: 'docs' } } })).toEqual([]);
  });

  test('a key whose only sibling is current (not the removed leaf) is not flagged', () => {
    expect(detectRemovedKeys({ value: { upload: { somethingElse: 1 } } })).toEqual([]);
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
      expect(err.source?.line).toBe(2);
    }
  });

  test('non-object input yields no errors', () => {
    expect(detectRemovedKeys({ value: null })).toEqual([]);
    expect(detectRemovedKeys({ value: 'string' })).toEqual([]);
    expect(detectRemovedKeys({ value: [] })).toEqual([]);
  });
});

describe('stripRemovedKeys', () => {
  for (const entry of REMOVED_KEYS) {
    const dotted = entry.path.join('.');
    test(`strips ${dotted} and leaves siblings intact`, () => {
      const input = nest(entry.path, 'x');
      input.keep = 'me';
      const out = stripRemovedKeys(input);
      expect(detectRemovedKeys({ value: out })).toEqual([]);
      expect((out as Record<string, unknown>).keep).toBe('me');
    });
  }

  test('does not mutate the input', () => {
    const input: Record<string, unknown> = {
      folders: [{ path: 'x' }],
      content: { dir: 'docs' },
    };
    const out = stripRemovedKeys(input) as Record<string, unknown>;
    expect(input.folders).toBeDefined();
    expect(out.folders).toBeUndefined();
    expect(out.content).toEqual({ dir: 'docs' });
  });

  test('strips several keys in one pass, keeping live siblings under the same branch', () => {
    const input = {
      folders: [],
      server: { host: '0.0.0.0', openOnAgentEdit: true, keepMe: 1 },
      content: { dir: 'd' },
    };
    const out = stripRemovedKeys(input) as Record<string, unknown>;
    expect(out.folders).toBeUndefined();
    const server = out.server as Record<string, unknown>;
    expect(server.host).toBeUndefined();
    expect(server.openOnAgentEdit).toBeUndefined();
    expect(server.keepMe).toBe(1);
    expect(out.content).toEqual({ dir: 'd' });
  });

  test('non-object input is returned unchanged', () => {
    expect(stripRemovedKeys(null)).toBeNull();
    expect(stripRemovedKeys('s')).toBe('s');
    expect(stripRemovedKeys([1, 2])).toEqual([1, 2]);
  });

  test('a clean config is returned structurally unchanged', () => {
    expect(stripRemovedKeys({ content: { dir: 'docs' } })).toEqual({ content: { dir: 'docs' } });
  });
});
