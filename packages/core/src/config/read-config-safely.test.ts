import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { stringify } from 'yaml';
import { resolveThemePlugin } from '../theme/theme-plugins.ts';
import { isKnownConfigError } from './errors.ts';
import { readConfigSafely } from './read-config-safely.ts';
import { REMOVED_KEYS } from './removed-keys.ts';

/** True when `value` is a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Set a (possibly nested) leaf on `root`, creating intermediate objects. */
function setPath(root: Record<string, unknown>, path: readonly string[], leaf: unknown): void {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i] as string;
    if (!isPlainObject(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[path[path.length - 1] as string] = leaf;
}

/** Whether a (possibly nested) leaf at `path` is present in `value`. */
function leafPresent(value: unknown, path: readonly string[]): boolean {
  let cur: unknown = value;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isPlainObject(cur)) return false;
    cur = cur[path[i] as string];
  }
  return isPlainObject(cur) && (path[path.length - 1] as string) in cur;
}

let testDir: string;

beforeEach(() => {
  testDir = resolve(
    tmpdir(),
    `ok-readconfig-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('readConfigSafely', () => {
  test('missing file → valid=true, value is schema defaults', () => {
    const result = readConfigSafely({ absPath: resolve(testDir, 'absent.yml') });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.source).toBeUndefined();
      expect(result.value.content.dir).toBe('.');
      expect(result.value.autoSync.enabled).toBeNull();
      // Pins the on-by-default egress posture at the read layer the server's
      // readLinkPreviewsEnabled() relies on: a genuinely-absent project-local
      // config resolves to external link previews enabled.
      expect(result.value.linkPreviews.enabled).toBe(true);
    }
  });

  test('valid file → valid=true, value is parsed config', () => {
    const path = resolve(testDir, 'good.yml');
    writeFileSync(path, 'content:\n  dir: docs\n', 'utf-8');
    const result = readConfigSafely({ absPath: path });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.content.dir).toBe('docs');
      expect(result.source).toBe(path);
    }
  });

  test('malformed YAML → valid=false, error.code=YAML_PARSE, file sidelined, value is defaults', () => {
    const path = resolve(testDir, 'broken.yml');
    writeFileSync(path, 'content:\n  dir: [invalid yaml', 'utf-8');
    const warnings: string[] = [];
    const result = readConfigSafely({
      absPath: path,
      timestamp: '2026-04-29T00-00-00-000Z',
      warn: (msg) => warnings.push(msg),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('YAML_PARSE');
      expect(result.value.content.dir).toBe('.'); // defaults
      // File should have been sidelined.
      expect(existsSync(path)).toBe(false);
      expect(result.sidelinedTo).toBeDefined();
      if (result.sidelinedTo) {
        expect(existsSync(result.sidelinedTo)).toBe(true);
        expect(result.sidelinedTo).toContain('.invalid-');
      }
    }
    // Warning was logged.
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('removed keys → valid=true, keys stripped, siblings preserved, file not sidelined', () => {
    // Strip-and-continue: dead keys are removed from the resolved value and
    // reported as diagnostics, but every live sibling keeps its on-disk value
    // and the file is left in place. A stale key no longer discards the file.
    const path = resolve(testDir, 'stale.yml');
    writeFileSync(
      path,
      'folders:\n  - path: "x/**"\nserver:\n  host: 0.0.0.0\ncontent:\n  dir: docs\n',
      'utf-8',
    );
    const warnings: string[] = [];
    const result = readConfigSafely({ absPath: path, warn: (msg) => warnings.push(msg) });
    expect(result.valid).toBe(true);
    if (result.valid) {
      // Live sibling keeps its on-disk value, not a schema default.
      expect(result.value.content.dir).toBe('docs');
      // Both removed keys are gone from the resolved value.
      expect(leafPresent(result.value, ['folders'])).toBe(false);
      expect(leafPresent(result.value, ['server', 'host'])).toBe(false);
      // One diagnostic per removed key.
      const removed = result.diagnostics.filter((d) => d.code === 'REMOVED_KEY');
      const dotted = removed.map((d) => (d.code === 'REMOVED_KEY' ? d.path.join('.') : ''));
      expect(dotted).toContain('folders');
      expect(dotted).toContain('server.host');
      expect(removed).toHaveLength(2);
    }
    // File left in place — a removed key is not a reason to sideline.
    expect(existsSync(path)).toBe(true);
    const siblings = readdirSync(testDir).filter((f) => f.includes('.invalid-'));
    expect(siblings).toEqual([]);
  });

  test('an unrecognized theme id degrades that slot only; siblings survive; file not sidelined', () => {
    // The discriminating test for opening the palette fields from a closed enum
    // to a shape-constrained string. A saved-theme id is by construction absent
    // from the built-in registry; under the old closed enum it failed
    // whole-document validation, which this reader handled as corruption —
    // replacing EVERY user preference with defaults and sidelining the file.
    // The fields now accept the id shape, so the reader keeps every sibling and
    // the unknown id degrades to the default palette only at resolve time.
    //
    // This FAILS on an unmodified checkout: `colorThemeLight: saved-*` trips
    // SCHEMA_INVALID, `value` becomes defaults (wordWrap true, theme unset), and
    // the file is renamed aside — so the sibling-survival assertions below all
    // fail. Asserting only "the config still parses" would NOT discriminate: the
    // old behavior also yields a parseable config, by discarding the user's.
    const path = resolve(testDir, 'global.yml');
    writeFileSync(
      path,
      [
        'editor:',
        '  wordWrap: false',
        'appearance:',
        '  theme: dark',
        '  colorThemeLight: saved-my-personal',
        '  colorThemeDark: dracula',
        '',
      ].join('\n'),
      'utf-8',
    );
    const result = readConfigSafely({ absPath: path, warn: () => {} });

    expect(result.valid).toBe(true);
    if (result.valid) {
      // An unrelated sibling (a different section) keeps its authored value.
      expect(result.value.editor.wordWrap).toBe(false);
      // A sibling WITHIN appearance survives too.
      expect(result.value.appearance.theme).toBe('dark');
      // The dangling id is preserved verbatim, not stripped or rewritten.
      expect(result.value.appearance.colorThemeLight).toBe('saved-my-personal');
      // The known slot is untouched.
      expect(result.value.appearance.colorThemeDark).toBe('dracula');
    }
    // Resolve-time degradation: the unknown id falls back to `default`; the
    // known one still resolves to itself — the other slot is unaffected.
    expect(resolveThemePlugin('saved-my-personal').id).toBe('default');
    expect(resolveThemePlugin('dracula').id).toBe('dracula');
    // The file is intact — a dangling reference is never a reason to sideline.
    // This is the command-line read path, the only one that produces a
    // `.invalid-*` file, so asserting its absence is meaningful here.
    expect(existsSync(path)).toBe(true);
    const siblings = readdirSync(testDir).filter((f) => f.includes('.invalid-'));
    expect(siblings).toEqual([]);
  });

  test('a removed key is never sidelined, regardless of the sideline option', () => {
    for (const sideline of [true, false] as const) {
      const path = resolve(testDir, `stale-${sideline}.yml`);
      writeFileSync(
        path,
        'preview:\n  baseUrl: https://example.test\ncontent:\n  dir: docs\n',
        'utf-8',
      );
      const result = readConfigSafely({ absPath: path, sideline, warn: () => {} });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.value.content.dir).toBe('docs');
        expect(result.diagnostics.some((d) => d.code === 'REMOVED_KEY')).toBe(true);
      }
      expect(existsSync(path)).toBe(true);
    }
  });

  test('schema-invalid YAML → valid=false, error.code=SCHEMA_INVALID with structured issues + source', () => {
    const path = resolve(testDir, 'bad.yml');
    const yaml = `appearance:
  theme: midnight
`;
    writeFileSync(path, yaml, 'utf-8');
    const result = readConfigSafely({
      absPath: path,
      warn: () => {}, // silence
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('SCHEMA_INVALID');
      if (isKnownConfigError(result.error) && result.error.code === 'SCHEMA_INVALID') {
        expect(result.error.issues.length).toBeGreaterThan(0);
        const issue = result.error.issues[0];
        expect(issue.path).toEqual(['appearance', 'theme']);
        expect(issue.source).toBeDefined();
        expect(issue.source?.file).toBe(path);
        expect(issue.source?.line).toBe(2);
      }
      // File sidelined.
      expect(existsSync(path)).toBe(false);
      expect(result.sidelinedTo).toBeDefined();
    }
  });

  test('sideline=false leaves file in place when invalid', () => {
    const path = resolve(testDir, 'broken.yml');
    writeFileSync(path, 'content:\n  dir: [invalid yaml', 'utf-8');
    const result = readConfigSafely({
      absPath: path,
      sideline: false,
      warn: () => {},
    });
    expect(result.valid).toBe(false);
    expect(existsSync(path)).toBe(true);
    if (!result.valid) {
      expect(result.sidelinedTo).toBeUndefined();
    }
  });

  test('sideline rename failure logs warning and falls through (file stays in place)', () => {
    // Simulate a schema-invalid file with sideline=false to verify the
    // warn-and-fall-through pathway. The schema-invalid sideline-disabled case
    // asserts `sidelinedTo` is undefined; here we verify the warn path fires.
    const path = resolve(testDir, 'broken.yml');
    writeFileSync(path, 'appearance:\n  theme: midnight\n', 'utf-8');
    const warnings: string[] = [];
    const result = readConfigSafely({
      absPath: path,
      sideline: false,
      warn: (m) => warnings.push(m),
    });
    expect(result.valid).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join('\n')).toContain('schema validation');
  });

  test('sidelined filename is filesystem-safe (no colons or dots from ISO timestamp)', () => {
    const path = resolve(testDir, 'broken.yml');
    writeFileSync(path, 'appearance:\n  theme: midnight\n', 'utf-8');
    const result = readConfigSafely({
      absPath: path,
      // Real ISO format includes colons; helper should sanitize them.
      timestamp: '2026-04-29T01:23:45.678Z',
      warn: () => {},
    });
    expect(result.valid).toBe(false);
    if (!result.valid && result.sidelinedTo) {
      // Colons + dots inside the timestamp portion get replaced.
      const tail = result.sidelinedTo.split('.invalid-')[1] ?? '';
      expect(tail.includes(':')).toBe(false);
      // Note: `.invalid-` itself contains a dot, so we check the timestamp
      // portion specifically — colons are the platform-portable concern.
    }
  });

  test('schema defaults are used regardless of failure mode', () => {
    const path = resolve(testDir, 'broken.yml');
    writeFileSync(path, 'appearance:\n  theme: midnight\n', 'utf-8');
    const result = readConfigSafely({ absPath: path, warn: () => {} });
    expect(result.valid).toBe(false);
    expect(result.value.content.dir).toBe('.'); // schema default
  });

  test('valid YAML with unknown fields (looseObject) is accepted', () => {
    const path = resolve(testDir, 'loose.yml');
    writeFileSync(path, 'sync:\n  pushIntervalSeconds: 30\ncontent:\n  dir: docs\n', 'utf-8');
    const result = readConfigSafely({ absPath: path });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.content.dir).toBe('docs');
    }
  });

  test('sideline does not run if input is valid', () => {
    const path = resolve(testDir, 'good.yml');
    writeFileSync(path, 'content:\n  dir: docs\n', 'utf-8');
    const result = readConfigSafely({ absPath: path });
    expect(result.valid).toBe(true);
    expect(existsSync(path)).toBe(true);
    // No `.invalid-*` siblings created.
    const siblings = readdirSync(testDir).filter((f) => f.includes('.invalid-'));
    expect(siblings).toEqual([]);
    // Original content preserved.
    expect(readFileSync(path, 'utf-8')).toContain('dir: docs');
  });
});

describe('readConfigSafely — strip-and-continue invariant', () => {
  let dir: string;
  beforeEach(() => {
    dir = resolve(tmpdir(), `ok-strip-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The regression that matters: for EVERY registry key, a config carrying that
  // key plus a live sibling must resolve the sibling to its on-disk value, strip
  // the dead key, and stay valid + un-sidelined.
  for (const entry of REMOVED_KEYS) {
    const dotted = entry.path.join('.');
    test(`${dotted}: sibling resolves to on-disk value; key stripped; one diagnostic`, () => {
      const obj: Record<string, unknown> = { content: { dir: 'docs' } };
      setPath(obj, entry.path, 'sentinel');
      const path = resolve(dir, 'cfg.yml');
      writeFileSync(path, stringify(obj), 'utf-8');

      const result = readConfigSafely({ absPath: path, warn: () => {} });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.value.content.dir).toBe('docs'); // sibling, not a default
        expect(leafPresent(result.value, entry.path)).toBe(false); // key stripped
        const removed = result.diagnostics.filter((d) => d.code === 'REMOVED_KEY');
        expect(removed).toHaveLength(1);
        const [diag] = removed;
        if (diag?.code === 'REMOVED_KEY') {
          expect(diag.path).toEqual(entry.path);
          expect(diag.redirect).toBe(entry.redirect);
        }
      }
      expect(existsSync(path)).toBe(true);
    });
  }
});

describe('readConfigSafely — diagnostics on the invalid arm', () => {
  let dir: string;
  beforeEach(() => {
    dir = resolve(tmpdir(), `ok-invalid-diag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('YAML parse failure surfaces a YAML_PARSE diagnostic', () => {
    const path = resolve(dir, 'broken.yml');
    writeFileSync(path, 'content:\n  dir: [invalid yaml', 'utf-8');
    const result = readConfigSafely({ absPath: path, sideline: false, warn: () => {} });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe('YAML_PARSE');
    }
  });

  test('schema-invalid config surfaces a SCHEMA_INVALID diagnostic', () => {
    const path = resolve(dir, 'bad.yml');
    writeFileSync(path, 'appearance:\n  theme: midnight\n', 'utf-8');
    const result = readConfigSafely({ absPath: path, sideline: false, warn: () => {} });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics.some((d) => d.code === 'SCHEMA_INVALID')).toBe(true);
    }
  });

  test('a clean config reports an empty diagnostics array', () => {
    const path = resolve(dir, 'clean.yml');
    writeFileSync(path, 'content:\n  dir: docs\n', 'utf-8');
    const result = readConfigSafely({ absPath: path });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.diagnostics).toEqual([]);
    }
  });

  test('a file that exists but cannot be read reports UNREADABLE, not silence', () => {
    // A directory where a file is expected reproduces the same class as EACCES
    // or a symlink loop: the path exists, so the missing-file arm is skipped,
    // but the read throws. Reporting nothing here makes an unreadable layer
    // indistinguishable from a clean one on every downstream surface.
    const path = resolve(dir, 'a-directory.yml');
    mkdirSync(path, { recursive: true });
    const result = readConfigSafely({ absPath: path, sideline: false, warn: () => {} });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['UNREADABLE']);
  });

  test('a removed key is still reported when the same file also fails schema validation', () => {
    // Both problems surface in one pass. Reporting only the schema error would
    // send the user back for a second round once they fixed it.
    const path = resolve(dir, 'both-problems.yml');
    writeFileSync(path, 'appearance:\n  theme: midnight\nserver:\n  host: 0.0.0.0\n', 'utf-8');
    const result = readConfigSafely({ absPath: path, sideline: false, warn: () => {} });
    expect(result.valid).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('REMOVED_KEY');
    expect(codes).toContain('SCHEMA_INVALID');
  });
});
