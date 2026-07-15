/**
 * Unit tests for native markdownlint config discovery against a real temp dir:
 * the `.markdownlint.*` precedence chain, per-format parsing (JSON / JSONC /
 * YAML), loud handling of malformed files, `extends` chain flattening with
 * its guards (package refs, escapes, cycles), and the per-dir cascade
 * (markdownlint-cli2 semantics: nearest file governs wholesale).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverMarkdownlintConfig,
  readOwnNativeRules,
  resolveNativeMarkdownlintConfig,
} from './markdownlint-discovery.ts';

let dir: string;

function write(name: string, content: string): void {
  const abs = join(dir, name);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-mdl-discovery-')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('discoverMarkdownlintConfig', () => {
  test('returns null when no native file exists', () => {
    expect(discoverMarkdownlintConfig(dir)).toBeNull();
  });

  test('reads a .markdownlint.json file', () => {
    write(
      '.markdownlint.json',
      JSON.stringify({ MD013: false, MD033: { allowed_elements: ['br'] } }),
    );
    expect(discoverMarkdownlintConfig(dir)).toEqual({
      rules: { MD013: false, MD033: { allowed_elements: ['br'] } },
      file: '.markdownlint.json',
      problems: [],
    });
  });

  test('reads a .markdownlint.yaml file', () => {
    write('.markdownlint.yaml', 'MD013: false\nMD007:\n  indent: 4\n');
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({ MD013: false, MD007: { indent: 4 } });
  });

  test('strips comments from a .markdownlint.jsonc file', () => {
    write('.markdownlint.jsonc', '{\n  // line height\n  "MD013": false /* off */\n}\n');
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({ MD013: false });
  });

  test('strips the `$schema` meta key (never reaches the rules object)', () => {
    write(
      '.markdownlint.json',
      JSON.stringify({
        $schema:
          'https://raw.githubusercontent.com/DavidAnson/markdownlint/main/schema/.markdownlint.jsonc',
        MD013: false,
      }),
    );
    const found = discoverMarkdownlintConfig(dir);
    expect(found?.rules).toEqual({ MD013: false });
    expect(found?.problems).toEqual([]);
  });

  test('jsonc wins over json when both exist (precedence)', () => {
    write('.markdownlint.json', JSON.stringify({ MD013: true }));
    write('.markdownlint.jsonc', '{ "MD013": false }');
    const found = discoverMarkdownlintConfig(dir);
    expect(found?.file).toBe('.markdownlint.jsonc');
    expect(found?.rules).toEqual({ MD013: false });
  });

  test('a malformed file yields rules null + a loud problem, not silence', () => {
    write('.markdownlint.json', '{ not valid json');
    const found = discoverMarkdownlintConfig(dir);
    expect(found?.rules).toBeNull();
    expect(found?.problems).toEqual([expect.stringContaining('malformed markdownlint config')]);
  });

  test('a malformed-file problem carries the parser detail, not just the verdict', () => {
    write('.markdownlint.json', '{ not valid json');
    const found = discoverMarkdownlintConfig(dir);
    // jsonc-parser's error code + offset, bounded to one line.
    expect(found?.problems[0]).toMatch(/malformed markdownlint config: .+ \(.+at offset \d+\)/);
  });

  test('tolerates trailing commas in .markdownlint.jsonc (full JSONC)', () => {
    write('.markdownlint.jsonc', '{\n  "MD013": false,\n  "MD041": false,\n}\n');
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({ MD013: false, MD041: false });
  });

  test('tolerates a leading BOM (jsonc-parser flags it as an error but parses fine)', () => {
    write('.markdownlint.json', '\uFEFF{ "MD013": false }');
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({ MD013: false });
  });

  test('rejects a half-parseable file rather than linting with a partial config', () => {
    // jsonc-parser error-recovers to `{ MD013: false }` here; the missing
    // colon must classify the file malformed, not silently drop MD041.
    write('.markdownlint.jsonc', '{ "MD013": false, "MD041" }');
    expect(discoverMarkdownlintConfig(dir)?.rules).toBeNull();
  });

  test('an executable config is detected, declined, and loudly reported', () => {
    write('.markdownlint.cjs', 'module.exports = { MD013: false };');
    const found = discoverMarkdownlintConfig(dir);
    expect(found?.rules).toBeNull();
    expect(found?.problems).toEqual([
      expect.stringContaining('executable markdownlint config detected but not executed'),
    ]);
  });
});

describe('extends resolution', () => {
  test('flattens a relative-path extends chain, child keys winning', () => {
    write('base.json', JSON.stringify({ MD013: true, MD041: false }));
    write('.markdownlint.json', JSON.stringify({ extends: './base.json', MD013: false }));
    const found = discoverMarkdownlintConfig(dir);
    expect(found?.rules).toEqual({ MD013: false, MD041: false });
    expect(found?.problems).toEqual([]);
  });

  test('extends resolves relative to the extending FILE, transitively', () => {
    write('shared/root.json', JSON.stringify({ MD041: false }));
    write('shared/mid.json', JSON.stringify({ extends: './root.json', MD013: true }));
    write('.markdownlint.json', JSON.stringify({ extends: './shared/mid.json', MD010: false }));
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({
      MD041: false,
      MD013: true,
      MD010: false,
    });
  });

  test('declines a package-name extends with a loud problem, keeping own keys', () => {
    write(
      '.markdownlint.json',
      JSON.stringify({ extends: 'markdownlint/style/relaxed', MD013: false }),
    );
    const found = discoverMarkdownlintConfig(dir);
    expect(found?.rules).toEqual({ MD013: false });
    expect(found?.problems).toEqual([expect.stringContaining('package extends is not supported')]);
  });

  test('refuses an extends target that escapes the project root', () => {
    write('.markdownlint.json', JSON.stringify({ extends: '../outside.json', MD013: false }));
    const found = discoverMarkdownlintConfig(dir);
    expect(found?.rules).toEqual({ MD013: false });
    expect(found?.problems).toEqual([
      expect.stringContaining('refusing extends target outside the project'),
    ]);
  });

  test('breaks an extends cycle with a problem instead of hanging', () => {
    write('a.json', JSON.stringify({ extends: './b.json', MD013: false }));
    write('b.json', JSON.stringify({ extends: './a.json', MD041: false }));
    write('.markdownlint.json', JSON.stringify({ extends: './a.json' }));
    const found = discoverMarkdownlintConfig(dir);
    // a + b both contribute their own keys; the cycle back to a is cut.
    expect(found?.rules).toEqual({ MD013: false, MD041: false });
    expect(found?.problems).toEqual([expect.stringContaining('extends cycle')]);
  });

  test('refuses an extends target whose SYMLINK realpath escapes the project', () => {
    // Lexically inside the boundary, physically outside: the realpath guard
    // (not the lexical one) must catch it.
    const outside = mkdtempSync(join(tmpdir(), 'ok-mdl-outside-'));
    try {
      writeFileSync(join(outside, 'evil.json'), JSON.stringify({ MD041: false }), 'utf-8');
      symlinkSync(join(outside, 'evil.json'), join(dir, 'linked.json'));
      write('.markdownlint.json', JSON.stringify({ extends: './linked.json', MD013: false }));
      const found = discoverMarkdownlintConfig(dir);
      expect(found?.rules).toEqual({ MD013: false });
      expect(found?.problems).toEqual([
        expect.stringContaining('refusing extends target outside the project'),
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a missing extends target is a problem, own keys survive', () => {
    write('.markdownlint.json', JSON.stringify({ extends: './nope.json', MD013: false }));
    const found = discoverMarkdownlintConfig(dir);
    expect(found?.rules).toEqual({ MD013: false });
    expect(found?.problems).toEqual([expect.stringContaining('cannot read')]);
  });

  test('a cannot-read problem carries the underlying errno detail', () => {
    write('.markdownlint.json', JSON.stringify({ extends: './nope.json', MD013: false }));
    const found = discoverMarkdownlintConfig(dir);
    expect(found?.problems[0]).toMatch(/cannot read .*nope\.json: .*ENOENT/);
  });

  test('extends: null means no inheritance (markdownlint semantics), not a problem', () => {
    write('.markdownlint.json', JSON.stringify({ extends: null, MD013: false }));
    const found = discoverMarkdownlintConfig(dir);
    expect(found?.rules).toEqual({ MD013: false });
    expect(found?.problems).toEqual([]);
  });
});

describe('resolveNativeMarkdownlintConfig (per-dir cascade, cli2 semantics)', () => {
  test('nearest file on the doc→root walk governs, WHOLESALE (no per-rule merge)', () => {
    write('.markdownlint.json', JSON.stringify({ MD013: false, MD041: false }));
    write('notes/.markdownlint.json', JSON.stringify({ MD010: false }));
    mkdirSync(join(dir, 'notes/deep'), { recursive: true });
    const near = resolveNativeMarkdownlintConfig(join(dir, 'notes/deep'), dir);
    // The folder file replaces the root file entirely — MD013/MD041 do NOT leak in.
    expect(near?.rules).toEqual({ MD010: false });
    expect(near?.file).toBe(join('notes', '.markdownlint.json'));
  });

  test('falls back to the root file when no nearer file exists', () => {
    write('.markdownlint.json', JSON.stringify({ MD013: false }));
    mkdirSync(join(dir, 'a/b'), { recursive: true });
    expect(resolveNativeMarkdownlintConfig(join(dir, 'a/b'), dir)?.rules).toEqual({ MD013: false });
  });

  test('returns null when nothing governs (no upward search above the root)', () => {
    mkdirSync(join(dir, 'a'), { recursive: true });
    expect(resolveNativeMarkdownlintConfig(join(dir, 'a'), dir)).toBeNull();
  });

  test('a subfolder inherits the root config the native way: explicit extends', () => {
    write('.markdownlint.json', JSON.stringify({ MD013: false, MD041: false }));
    write(
      'notes/.markdownlint.json',
      JSON.stringify({ extends: '../.markdownlint.json', MD010: false }),
    );
    mkdirSync(join(dir, 'notes'), { recursive: true });
    expect(resolveNativeMarkdownlintConfig(join(dir, 'notes'), dir)?.rules).toEqual({
      MD013: false,
      MD041: false,
      MD010: false,
    });
  });

  test('a docDir outside the root clamps to the root', () => {
    write('.markdownlint.json', JSON.stringify({ MD013: false }));
    expect(resolveNativeMarkdownlintConfig(join(dir, '..'), dir)?.rules).toEqual({ MD013: false });
  });
});

describe('readOwnNativeRules', () => {
  test('returns null for a malformed file (write surface may rebuild it)', () => {
    write('.markdownlint.json', '{ not valid json');
    expect(readOwnNativeRules(dir)).toBeNull();
  });

  test('returns the raw bytes alongside the parsed keys', () => {
    const raw = '{\n  // keep\n  "MD013": false\n}\n';
    write('.markdownlint.jsonc', raw);
    const own = readOwnNativeRules(dir);
    expect(own?.rules).toEqual({ MD013: false });
    expect(own?.raw).toBe(raw);
  });

  // Root reads any file regardless of mode, so the permission probe only
  // proves the rethrow when the process isn't privileged.
  test.if(process.getuid?.() !== 0)(
    'THROWS on a filesystem read failure — an unreadable file is not "no rules"',
    () => {
      write('.markdownlint.json', JSON.stringify({ MD013: false }));
      chmodSync(join(dir, '.markdownlint.json'), 0o000);
      try {
        expect(() => readOwnNativeRules(dir)).toThrow();
      } finally {
        chmodSync(join(dir, '.markdownlint.json'), 0o644);
      }
    },
  );
});
