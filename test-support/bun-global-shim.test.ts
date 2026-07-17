import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bunFacade, installBunGlobal } from './bun-global-shim';

const selfPath = fileURLToPath(import.meta.url);
const selfDir = fileURLToPath(new URL('.', import.meta.url));

describe('Bun global facade', () => {
  test('installs globalThis.Bun (idempotently)', () => {
    installBunGlobal();
    expect((globalThis as Record<string, unknown>).Bun).toBe(bunFacade);
  });

  test('Bun.file reads text and reports existence on Node', async () => {
    const present = bunFacade.file(selfPath);
    expect(await present.exists()).toBe(true);
    expect(await present.text()).toContain('Bun global facade');
    expect(await bunFacade.file('/no/such/path/here.txt').exists()).toBe(false);
  });

  test('Bun.file.stat reports mtime on Node', async () => {
    const stats = await bunFacade.file(selfPath).stat();
    expect(typeof stats.mtimeMs).toBe('number');
    expect(stats.mtimeMs).toBeGreaterThan(0);
  });

  test('Bun.write writes bytes and creates parent directories on Node', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bun-write-facade-'));
    try {
      const target = join(root, 'nested', 'dir', 'out.txt');
      const written = await bunFacade.write(target, 'hello facade\n');
      expect(written).toBe(Buffer.byteLength('hello facade\n'));
      expect(await bunFacade.file(target).text()).toBe('hello facade\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Bun.Glob matches and scans on Node', () => {
    const glob = new bunFacade.Glob('**/*.test.ts');
    expect(glob.match('bun-global-shim.test.ts')).toBe(true);
    expect(glob.match('nested/dir/thing.test.ts')).toBe(true);
    expect(glob.match('bun-global-shim.ts')).toBe(false);

    const scanned = [...new bunFacade.Glob('*.test.ts').scanSync({ cwd: selfDir })];
    expect(scanned).toContain('bun-global-shim.test.ts');
    expect(scanned).not.toContain('fixtures/mockable.ts');
  });

  test('Bun.Glob skips dotfiles and dot-directories (default dot:false parity)', () => {
    const root = mkdtempSync(join(tmpdir(), 'bun-glob-dot-'));
    try {
      writeFileSync(join(root, 'visible.ts'), '');
      writeFileSync(join(root, '.hidden.ts'), '');
      mkdirSync(join(root, '.git'));
      writeFileSync(join(root, '.git', 'inside.ts'), '');
      mkdirSync(join(root, 'sub'));
      writeFileSync(join(root, 'sub', 'nested.ts'), '');

      const found = [...new bunFacade.Glob('**/*.ts').scanSync({ cwd: root })];
      // Visible files (including those in normal subdirs) are matched.
      expect(found).toContain('visible.ts');
      expect(found).toContain('sub/nested.ts');
      // Dotfiles and anything under a dot-directory are neither matched nor
      // descended into — matching real Bun.Glob's `dot: false` default.
      expect(found).not.toContain('.hidden.ts');
      expect(found).not.toContain('.git/inside.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Bun.TOML parses on Node', () => {
    expect(bunFacade.TOML.parse('a = 1\n[b]\nc = "x"')).toEqual({ a: 1, b: { c: 'x' } });
  });

  test('Bun.resolveSync ignores the development condition (matches bun production resolution)', () => {
    // micromark ships a `./dev/` build under its `development` export condition.
    // The Vitest worker runs with `--conditions development`, so a naive
    // require.resolve would land in `dev/`; bun's Bun.resolveSync resolves to
    // the production entry. The facade must match bun.
    const resolved = bunFacade.resolveSync('micromark', selfDir).replaceAll('\\', '/');
    expect(resolved).toContain('/node_modules/micromark/');
    expect(resolved).not.toContain('/micromark/dev/');
  });

  test('Bun.Transpiler compiles TypeScript and throws on a syntax error', () => {
    const transpiler = new bunFacade.Transpiler({ loader: 'ts' });
    const out = transpiler.transformSync('const x: number = 1;\nenum E { A, B }\n');
    // Type annotation erased; the enum lowered to real JavaScript.
    expect(out).not.toContain(': number');
    expect(out).toContain('E');
    expect(out).toContain('const x = 1');
    expect(() => transpiler.transformSync('const = ;')).toThrow();
  });

  test('which/sleep/spawnSync/gc behave on Node', async () => {
    expect(bunFacade.which('node')).toBeTruthy();

    const start = Date.now();
    await bunFacade.sleep(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(3);

    const result = bunFacade.spawnSync([process.execPath, '-e', 'process.stdout.write("hi")']);
    expect(result.success).toBe(true);
    expect(result.stdout.toString()).toBe('hi');

    expect(() => bunFacade.gc()).not.toThrow();
  });
});

describe('Bun.CryptoHasher', () => {
  // Published SHA-256 vector for the ASCII string "abc" — independent of the
  // node:crypto the facade wraps, so a wrong wiring (bad algorithm, dropped
  // data) fails against a real answer rather than tautologically agreeing.
  const SHA256_ABC_HEX = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  const SHA256_ABC_BASE64 = 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=';

  test('digests a known vector in hex and base64', () => {
    expect(new bunFacade.CryptoHasher('sha256').update('abc').digest('hex')).toBe(SHA256_ABC_HEX);
    expect(new bunFacade.CryptoHasher('sha256').update('abc').digest('base64')).toBe(
      SHA256_ABC_BASE64,
    );
  });

  test('.update() returns the hasher and accumulates across chained calls', () => {
    const hasher = new bunFacade.CryptoHasher('sha256');
    // Chainable: update must return the same instance.
    expect(hasher.update('a')).toBe(hasher);
    // Two separate updates of 'a' then 'bc' must digest identically to one 'abc'.
    expect(hasher.update('bc').digest('hex')).toBe(SHA256_ABC_HEX);
  });
});

describe('bun expect matchers', () => {
  test('toStartWith / toEndWith on strings', () => {
    expect('# heading').toStartWith('#');
    expect('# heading').not.toStartWith('=');
    expect('name.ts').toEndWith('.ts');
    expect('name.ts').not.toEndWith('.tsx');
  });

  test('toBeString / toBeFunction / toBeArray type guards', () => {
    expect('x').toBeString();
    expect(1).not.toBeString();
    expect(() => {}).toBeFunction();
    expect('x').not.toBeFunction();
    expect([1, 2]).toBeArray();
    expect({ length: 0 }).not.toBeArray();
  });

  test('toBeTrue / toBeFalse boolean identity', () => {
    expect(true).toBeTrue();
    expect(1).not.toBeTrue();
    expect(false).toBeFalse();
    expect(0).not.toBeFalse();
  });
});

test('self alias is defined for browser-targeting modules', () => {
  expect(self).toBe(globalThis);
});
