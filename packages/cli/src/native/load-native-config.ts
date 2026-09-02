import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE_CONFIG_PACKAGE = '@inkeep/open-knowledge-native-config';

function isModuleNotFound(err: unknown): boolean {
  const code =
    err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
}

export function debugNativeLoadFailure(context: string, err: unknown): void {
  if (!process.env.OK_DEBUG_NATIVE) return;
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[ok] native-config ${context}: ${message}\n`);
}

const BUNDLED_LOADER_SUBPATH = ['native', 'index.js'];

export interface NativeConfigResolver {
  requireModule: (id: string) => unknown;
  moduleUrl: string;
}

export function requireNativeConfigModule(
  resolver: Partial<NativeConfigResolver> = {},
): unknown | null {
  const moduleUrl = resolver.moduleUrl ?? import.meta.url;
  const requireModule = resolver.requireModule ?? createRequire(moduleUrl);

  try {
    const here = dirname(fileURLToPath(moduleUrl));
    return requireModule(join(here, ...BUNDLED_LOADER_SUBPATH));
  } catch (err) {
    if (!isModuleNotFound(err)) debugNativeLoadFailure('bundled loader failed to load', err);
  }

  try {
    return requireModule(NATIVE_CONFIG_PACKAGE);
  } catch (err) {
    if (!isModuleNotFound(err)) debugNativeLoadFailure('workspace addon failed to load', err);
    return null;
  }
}
