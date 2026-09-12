import { describe, expect, test } from 'vitest';
import { expandBraces, parseScopeConfig, ScopeConfigError, stripJsonc } from './config.mjs';

const MINIMAL = {
  version: 1,
  families: { ts: { extensions: ['.ts'], extractor: 'c-family' } },
  units: [{ id: 'src', family: 'ts', roots: ['packages/**/src'] }],
  exclude: [],
};

const parse = (value) => parseScopeConfig(JSON.stringify(value), { configPath: '/t/cfg.jsonc' });

describe('stripJsonc', () => {
  test('blanks comments in place so JSON.parse reports the authored position', () => {
    const text = '{\n  // a line comment\n  "version": 1 /* trailing */\n}';
    const stripped = stripJsonc(text);
    expect(JSON.parse(stripped)).toEqual({ version: 1 });
    expect(stripped.split('\n')).toHaveLength(4);
  });

  test('leaves comment-shaped text inside strings alone', () => {
    const text = '{"a": "https://example.test/x", "b": "/* not a comment */"}';
    expect(JSON.parse(stripJsonc(text))).toEqual({
      a: 'https://example.test/x',
      b: '/* not a comment */',
    });
  });

  test('blanks by UTF-16 code unit, so an astral character does not shift the span', () => {
    const text = '{\n  // \u{1D106} comment\n  "a": "\u{1D106}"\n}';
    const stripped = stripJsonc(text);
    expect(stripped).toHaveLength(text.length);
    expect(JSON.parse(stripped)).toEqual({ a: '\u{1D106}' });
  });

  test('drops trailing commas an editor may leave behind', () => {
    expect(JSON.parse(stripJsonc('{"a": [1, 2,], "b": 3,}'))).toEqual({ a: [1, 2], b: 3 });
  });

  test('keeps a comma that only looks trailing because a string contains a brace', () => {
    expect(JSON.parse(stripJsonc('{"a": "x,}", "b": 1}'))).toEqual({ a: 'x,}', b: 1 });
  });
});

describe('expandBraces', () => {
  test('expands one alternation into one glob per member', () => {
    expect(expandBraces('**/*.fixture.{ts,tsx,mjs}')).toEqual([
      '**/*.fixture.ts',
      '**/*.fixture.tsx',
      '**/*.fixture.mjs',
    ]);
  });

  test('expands nested alternations to their cross product', () => {
    expect(expandBraces('{a,b}/{c,d}')).toEqual(['a/c', 'a/d', 'b/c', 'b/d']);
  });

  test('leaves a brace-free glob as a single member', () => {
    expect(expandBraces('packages/**/src/**/*.ts')).toEqual(['packages/**/src/**/*.ts']);
  });

  test('refuses an unbalanced brace rather than emitting it for the matcher to reject', () => {
    expect(() => expandBraces('a/{b,c')).toThrow(/unbalanced/);
  });
});

describe('membership derivation', () => {
  test('include is roots times the family extensions, never restated', () => {
    const config = parse({
      ...MINIMAL,
      families: { ts: { extensions: ['.ts', '.tsx'], extractor: 'c-family' } },
      units: [{ id: 'src', family: 'ts', roots: ['packages/**/src', 'docs'] }],
    });
    expect(config.include).toEqual([
      'packages/**/src/**/*.ts',
      'packages/**/src/**/*.tsx',
      'docs/**/*.ts',
      'docs/**/*.tsx',
    ]);
  });

  test('the repository root is the one non-recursive root', () => {
    const config = parse({
      ...MINIMAL,
      families: { cfg: { extensions: ['.ts', '.mts'], extractor: 'c-family' } },
      units: [{ id: 'root-configs', family: 'cfg', roots: ['.'] }],
    });
    expect(config.include).toEqual(['*.ts', '*.mts']);
  });

  test('explicit files are members whatever their extension', () => {
    const config = parse({
      ...MINIMAL,
      units: [
        { id: 'hooks', family: 'ts', roots: [], files: ['.husky/pre-push'], allowEmpty: true },
      ],
    });
    expect(config.include).toEqual(['.husky/pre-push']);
    expect(config.units[0].files).toEqual(['.husky/pre-push']);
  });

  test('walk roots are the first segment of each declared root', () => {
    const config = parse({
      ...MINIMAL,
      units: [
        { id: 'a', family: 'ts', roots: ['packages/**/src', '.github/scripts'] },
        { id: 'b', family: 'ts', roots: ['packages/**/tests', '.'] },
      ],
    });
    expect(config.walkRoots).toEqual(['.github', 'packages']);
  });

  test('a directory-name-shaped exclude becomes a walk prune, a path-shaped one does not', () => {
    const config = parse({
      ...MINIMAL,
      exclude: ['**/node_modules/**', '**/dist/**', 'packages/app/src/build/**', '**/*.d.ts'],
    });
    expect(config.pruneDirectories).toEqual(['dist', 'node_modules']);
  });

  test('brace forms in exclude expand at load so the matcher never sees a brace', () => {
    const config = parse({ ...MINIMAL, exclude: ['**/*.fixture.{ts,tsx}'] });
    expect(config.exclude).toEqual(['**/*.fixture.ts', '**/*.fixture.tsx']);
  });
});

describe('path-shaped values are canonical after load', () => {
  test('a leading ./ is stripped from roots, files and exclude alike', () => {
    const config = parse({
      ...MINIMAL,
      units: [
        {
          id: 'src',
          family: 'ts',
          roots: ['./packages/**/src'],
          files: ['./.husky/pre-push'],
        },
      ],
      exclude: ['.//**/dist/**'],
    });
    expect(config.units[0].roots).toEqual(['packages/**/src']);
    expect(config.units[0].files).toEqual(['.husky/pre-push']);
    expect(config.exclude).toEqual(['**/dist/**']);
    expect(config.include).toEqual(['packages/**/src/**/*.ts', '.husky/pre-push']);
  });

  test('a trailing slash on a root normalizes to the root without one', () => {
    const slashed = parse({
      ...MINIMAL,
      units: [{ id: 'src', family: 'ts', roots: ['packages/'] }],
    });
    const bare = parse({ ...MINIMAL, units: [{ id: 'src', family: 'ts', roots: ['packages'] }] });
    expect(slashed.units[0].roots).toEqual(['packages']);
    expect(slashed.include).toEqual(bare.include);
    expect(slashed.walkRoots).toEqual(bare.walkRoots);
    expect(slashed.declaredPaths).toEqual(bare.declaredPaths);
  });

  test('repeated slashes collapse', () => {
    const config = parse({
      ...MINIMAL,
      units: [{ id: 'src', family: 'ts', roots: ['packages//app//src'] }],
    });
    expect(config.units[0].roots).toEqual(['packages/app/src']);
  });

  test('every spelling of the repository root canonicalizes to the one the matcher reads', () => {
    for (const spelling of ['.', './', './/', './//']) {
      const config = parse({
        ...MINIMAL,
        units: [{ id: 'root', family: 'ts', roots: [spelling] }],
      });
      expect({ spelling, roots: config.units[0].roots }).toEqual({ spelling, roots: ['.'] });
      expect({ spelling, include: config.include }).toEqual({ spelling, include: ['*.ts'] });
      expect({ spelling, walkRoots: config.walkRoots }).toEqual({ spelling, walkRoots: [] });
      expect({ spelling, declared: config.declaredPaths }).toEqual({ spelling, declared: [] });
    }
  });

  test('canonicalization survives brace expansion, which can hide a ./ inside a member', () => {
    const config = parse({ ...MINIMAL, exclude: ['{./docs,packages/}/**'] });
    expect(config.exclude).toEqual(['docs/**', 'packages/**']);
  });
});

describe('a path that leaves the root is refused, not normalized', () => {
  const cases = [
    ['units[0].roots[0]', { roots: ['../sibling/src'] }, /\.\. segment/],
    ['units[0].roots[1]', { roots: ['packages', 'packages/../../escape'] }, /\.\. segment/],
    ['units[0].roots[0]', { roots: ['./../sibling'] }, /\.\. segment/],
    ['units[0].roots[0]', { roots: ['/abs/path'] }, /absolute path/],
    ['units[0].roots[0]', { roots: ['C:/abs/path'] }, /absolute path/],
    ['units[0].files[0]', { roots: ['packages'], files: ['../outside'] }, /\.\. segment/],
    ['units[0].files[0]', { roots: ['packages'], files: ['/etc/passwd'] }, /absolute path/],
  ];

  test.each(cases)('%s', (key, unit, detail) => {
    let thrown;
    try {
      parse({ ...MINIMAL, units: [{ id: 'src', family: 'ts', ...unit }] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ScopeConfigError);
    expect(thrown.key).toBe(key);
    expect(thrown.message).toMatch(detail);
    expect(thrown.message).toContain('/t/cfg.jsonc');
  });

  test('an escaping exclude is refused by its own key path', () => {
    let thrown;
    try {
      parse({ ...MINIMAL, exclude: ['**/dist/**', '../elsewhere/**'] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ScopeConfigError);
    expect(thrown.key).toBe('exclude[1]');
  });

  test('a .. that is only a filename prefix is an ordinary path', () => {
    const config = parse({ ...MINIMAL, exclude: ['packages/..hidden/**', 'a/..b'] });
    expect(config.exclude).toEqual(['packages/..hidden/**', 'a/..b']);
  });
});

describe('declared paths', () => {
  test('a glob-bearing root declares only its literal prefix, so existence stays checkable', () => {
    const config = parse({
      ...MINIMAL,
      units: [
        { id: 'a', family: 'ts', roots: ['packages/**/src', '.github/scripts', '.'] },
        { id: 'b', family: 'ts', roots: [], files: ['.husky/pre-push'], allowEmpty: true },
      ],
    });
    expect(config.declaredPaths).toEqual([
      { unit: 'a', kind: 'root', path: 'packages' },
      { unit: 'a', kind: 'root', path: '.github/scripts' },
      { unit: 'b', kind: 'file', path: '.husky/pre-push' },
    ]);
  });
});

describe('config errors name the file and the key', () => {
  const cases = [
    ['version', { ...MINIMAL, version: 2 }, /version/],
    ['version', { ...MINIMAL, version: '1' }, /version/],
    ['units[0].family', { ...MINIMAL, units: [{ id: 'x', family: 'nope', roots: ['a'] }] }, /nope/],
    ['units', { ...MINIMAL, units: [] }, /at least one/],
    ['units[1].id', { ...MINIMAL, units: [...MINIMAL.units, MINIMAL.units[0]] }, /duplicate/],
    [
      'families.ts.extensions[0]',
      { ...MINIMAL, families: { ts: { extensions: ['ts'], extractor: 'c-family' } } },
      /leading dot/,
    ],
    [
      'families.ts.extractor',
      { ...MINIMAL, families: { ts: { extensions: ['.ts'] } } },
      /extractor/,
    ],
    ['exclude', { ...MINIMAL, exclude: 'nope' }, /array/],
  ];

  test.each(cases)('%s', (key, value, detail) => {
    let thrown;
    try {
      parse(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ScopeConfigError);
    expect(thrown.configPath).toBe('/t/cfg.jsonc');
    expect(thrown.key).toBe(key);
    expect(thrown.message).toMatch(detail);
    expect(thrown.message).toContain('/t/cfg.jsonc');
  });

  test('a syntax error carries the config path', () => {
    expect(() => parseScopeConfig('{', { configPath: '/t/cfg.jsonc' })).toThrow(ScopeConfigError);
  });

  test('an unrecognized major is refused by name, not silently coerced', () => {
    expect(() => parse({ ...MINIMAL, version: 99 })).toThrow(/major 99/);
  });
});

describe('tolerance', () => {
  test('an unknown additive key under a recognized major loads and is reported', () => {
    const config = parse({ ...MINIMAL, futureKnob: { on: true } });
    expect(config.unknownKeys).toEqual(['futureKnob']);
    expect(config.include).toEqual(['packages/**/src/**/*.ts']);
  });

  test('an unknown key inside a unit is tolerated the same way', () => {
    const config = parse({
      ...MINIMAL,
      units: [{ id: 'src', family: 'ts', roots: ['packages/**/src'], futureKnob: 1 }],
    });
    expect(config.unknownKeys).toEqual(['units[0].futureKnob']);
  });
});
