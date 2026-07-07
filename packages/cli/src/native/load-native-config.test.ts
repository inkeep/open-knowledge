import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { requireNativeConfigModule } from './load-native-config.ts';

/** Run `fn` with OK_DEBUG_NATIVE set and stderr captured; restore both after. */
function withCapturedStderr(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  const priorEnv = process.env.OK_DEBUG_NATIVE;
  let captured = '';
  process.env.OK_DEBUG_NATIVE = '1';
  // biome-ignore lint/suspicious/noExplicitAny: minimal stderr.write spy for the test.
  process.stderr.write = ((chunk: any) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
    if (priorEnv === undefined) delete process.env.OK_DEBUG_NATIVE;
    else process.env.OK_DEBUG_NATIVE = priorEnv;
  }
  return captured;
}

const BROKEN_BINARY_URL = 'file:///app/dist/cli.mjs';

function moduleNotFound(id: string): never {
  throw Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' });
}

/**
 * The resolver's contract is the resolution ORDER: bundled `dist/native/` first
 * (the published CLI + the packaged desktop's bundled CLI), then the workspace
 * package (dev/desktop-main), then null. These tests inject a fake module
 * requirer + module URL so the order is asserted without depending on whether a
 * `.node` happens to be built or installed on the host.
 */

const BUNDLED_MODULE_URL = 'file:///app/dist/cli.mjs';
const SENTINEL_BUNDLED = { source: 'bundled' };
const SENTINEL_WORKSPACE = { source: 'workspace' };

function bundledLoaderPath(moduleUrl: string): string {
  // Mirror the resolver's own join so the assertion tracks the real path shape.
  return fileURLToPath(moduleUrl).replace(/cli\.mjs$/, 'native/index.js');
}

describe('requireNativeConfigModule resolution order', () => {
  test('loads the dist-relative bundle first when present', () => {
    const expectedBundlePath = bundledLoaderPath(BUNDLED_MODULE_URL);
    let workspaceTried = false;

    const mod = requireNativeConfigModule({
      moduleUrl: BUNDLED_MODULE_URL,
      requireModule: (id) => {
        if (id === expectedBundlePath) return SENTINEL_BUNDLED;
        workspaceTried = true;
        return SENTINEL_WORKSPACE;
      },
    });

    expect(mod).toBe(SENTINEL_BUNDLED);
    // The bundled hit must short-circuit before the workspace fallback.
    expect(workspaceTried).toBe(false);
  });

  test('falls back to the workspace package when no bundled binary exists', () => {
    const mod = requireNativeConfigModule({
      moduleUrl: BUNDLED_MODULE_URL,
      requireModule: (id) => {
        if (id === '@inkeep/open-knowledge-native-config') return SENTINEL_WORKSPACE;
        throw new Error(`MODULE_NOT_FOUND: ${id}`);
      },
    });

    expect(mod).toBe(SENTINEL_WORKSPACE);
  });

  test('returns null when neither the bundle nor the workspace package resolves', () => {
    const mod = requireNativeConfigModule({
      moduleUrl: BUNDLED_MODULE_URL,
      requireModule: (id) => {
        throw new Error(`MODULE_NOT_FOUND: ${id}`);
      },
    });

    expect(mod).toBeNull();
  });

  test('computes the bundled path relative to the calling module dir', () => {
    const requested: string[] = [];

    requireNativeConfigModule({
      moduleUrl: 'file:///somewhere/else/dist/index.mjs',
      requireModule: (id) => {
        requested.push(id);
        if (id.endsWith('index.js')) return SENTINEL_BUNDLED;
        throw new Error(`MODULE_NOT_FOUND: ${id}`);
      },
    });

    expect(requested).toContain('/somewhere/else/dist/native/index.js');
  });
});

describe('broken-binary diagnostic (OK_DEBUG_NATIVE)', () => {
  test('surfaces a present-but-broken binary, distinct from the silent no-binary case', () => {
    // A binary that exists but fails to load throws a non-"module not found"
    // error (ABI / glibc / musl mismatch). Under OK_DEBUG_NATIVE it is surfaced.
    const captured = withCapturedStderr(() => {
      const mod = requireNativeConfigModule({
        moduleUrl: BROKEN_BINARY_URL,
        requireModule: () => {
          throw new Error('dlopen failed: wrong ELF class');
        },
      });
      expect(mod).toBeNull();
    });
    expect(captured).toContain('native-config');
    expect(captured).toContain('dlopen failed');
  });

  test('stays silent for the no-binary case even under OK_DEBUG_NATIVE', () => {
    // The expected no-prebuilt-binary platform: every require is MODULE_NOT_FOUND.
    const captured = withCapturedStderr(() => {
      const mod = requireNativeConfigModule({
        moduleUrl: BROKEN_BINARY_URL,
        requireModule: (id) => moduleNotFound(id),
      });
      expect(mod).toBeNull();
    });
    expect(captured).toBe('');
  });
});
