import { describe, expect, test } from 'vitest';
import { parseDocument } from 'yaml';
import {
  detectCommittedProjectLocalKeys,
  formatIgnoredCommittedKey,
} from './committed-scope-diagnostics.ts';

function paths(value: unknown): string[] {
  return detectCommittedProjectLocalKeys({ value })
    .map((f) => f.path.join('.'))
    .sort();
}

describe('detectCommittedProjectLocalKeys', () => {
  test('flags a committed server.bind — the clone-breaking case — with the OK_BIND fix', () => {
    const findings = detectCommittedProjectLocalKeys({ value: { server: { bind: ['0.0.0.0'] } } });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toEqual(['server', 'bind']);
    expect(findings[0]?.envVar).toBe('OK_BIND');
  });

  test('flags a committed loopback bind too — placement, not value, is the fault', () => {
    expect(paths({ server: { bind: ['127.0.0.1'] } })).toEqual(['server.bind']);
  });

  test('flags committed exposure consent (server.allowExternal) with its env fix', () => {
    const findings = detectCommittedProjectLocalKeys({
      value: { server: { allowExternal: true } },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toEqual(['server', 'allowExternal']);
    expect(findings[0]?.envVar).toBe('OK_ALLOW_EXTERNAL');
  });

  test('flags a project-local leaf with no env surface, and omits envVar', () => {
    const findings = detectCommittedProjectLocalKeys({ value: { autoSync: { mode: 'full' } } });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toEqual(['autoSync', 'mode']);
    expect(findings[0]?.envVar).toBeUndefined();
  });

  test('flags nested project-local leaves (search + sidebar)', () => {
    expect(
      paths({
        search: { semantic: { enabled: true } },
        appearance: { sidebar: { showHiddenFiles: true } },
      }),
    ).toEqual(['appearance.sidebar.showHiddenFiles', 'search.semantic.enabled']);
  });

  test('does NOT flag project-scope keys (the committed, shared shape)', () => {
    expect(
      paths({
        content: { dir: 'docs' },
        server: { port: 8080, externalUrl: 'https://kb.example.com' },
      }),
    ).toEqual([]);
  });

  test('does NOT flag user-scope keys', () => {
    expect(paths({ slides: { enabled: true } })).toEqual([]);
  });

  test('ignores loose/unknown keys the schema does not register', () => {
    expect(paths({ chrome: { totallyUnknown: 42 }, notAConfigKey: true })).toEqual([]);
  });

  test('separates ignored project-local keys from in-scope siblings in one pass', () => {
    expect(
      paths({
        content: { dir: 'docs' },
        server: { port: 8080, bind: ['0.0.0.0'], allowExternal: true },
      }),
    ).toEqual(['server.allowExternal', 'server.bind']);
  });

  test('non-object / empty input yields no findings', () => {
    expect(detectCommittedProjectLocalKeys({ value: null })).toEqual([]);
    expect(detectCommittedProjectLocalKeys({ value: 'nope' })).toEqual([]);
    expect(detectCommittedProjectLocalKeys({ value: [] })).toEqual([]);
    expect(detectCommittedProjectLocalKeys({ value: {} })).toEqual([]);
  });

  test('attaches source location when doc + source supplied', () => {
    const source = 'server:\n  bind:\n    - 0.0.0.0\n';
    const doc = parseDocument(source);
    const findings = detectCommittedProjectLocalKeys({
      value: doc.toJSON(),
      file: '/tmp/.ok/config.yml',
      source,
      doc,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.source?.file).toBe('/tmp/.ok/config.yml');
    expect(findings[0]?.source?.line).toBeGreaterThanOrEqual(1);
  });
});

describe('formatIgnoredCommittedKey', () => {
  test('names the key, says it is ignored, and points at the per-machine fix + env var', () => {
    const msg = formatIgnoredCommittedKey({ path: ['server', 'bind'], envVar: 'OK_BIND' });
    expect(msg).toContain('server.bind');
    expect(msg).toContain('ignored');
    expect(msg).toContain('.ok/local/config.yml');
    expect(msg).toContain('OK_BIND');
  });

  test('omits the env hint when the leaf has no env surface', () => {
    const msg = formatIgnoredCommittedKey({ path: ['autoSync', 'mode'] });
    expect(msg).toContain('autoSync.mode');
    expect(msg).toContain('.ok/local/config.yml');
    expect(msg).not.toContain('OK_');
  });

  test('prefixes file:line:column when the finding was source-located', () => {
    const msg = formatIgnoredCommittedKey({
      path: ['server', 'bind'],
      envVar: 'OK_BIND',
      source: { file: '/repo/.ok/config.yml', line: 3, column: 5 },
    });
    expect(msg.startsWith('/repo/.ok/config.yml:3:5: ')).toBe(true);
    expect(msg).toContain('server.bind');
  });

  test('omits the location prefix when no source is attached', () => {
    const msg = formatIgnoredCommittedKey({ path: ['server', 'bind'], envVar: 'OK_BIND' });
    expect(msg.startsWith('server.bind')).toBe(true);
  });
});
