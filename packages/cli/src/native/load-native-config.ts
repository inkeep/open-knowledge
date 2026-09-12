import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE_CONFIG_PACKAGE = '@inkeep/open-knowledge-native-config';

function isModuleNotFound(err: unknown): boolean {
  const code =
    err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
}

const MAX_CAUSE_DEPTH = 5;

export function describeValue(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  return `${typeof value} keys=[${Object.keys(value).join(',')}]`;
}

export function describeNativeFailure(context: string, err: unknown): string {
  const messages: string[] = [];
  const seen = new WeakSet<object>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  if (messages.length === 0) return `${context}: ${describeValue(err)}`;
  return `${context}: ${messages.reverse().slice(0, MAX_CAUSE_DEPTH).join(' -> ')}`;
}

export function debugNativeLoadFailure(context: string, err: unknown): void {
  if (!process.env.OK_DEBUG_NATIVE) return;
  process.stderr.write(`[ok] native-config ${describeNativeFailure(context, err)}\n`);
}

const BUNDLED_LOADER_SUBPATH = ['native', 'index.js'];

export interface NativeConfigResolver {
  requireModule: (id: string) => unknown;
  moduleUrl: string;
}

export function requireNativeConfigModule(
  resolver: Partial<NativeConfigResolver> = {},
  onLoadFailure: (context: string, err: unknown) => void = debugNativeLoadFailure,
): unknown | null {
  const moduleUrl = resolver.moduleUrl ?? import.meta.url;
  const requireModule = resolver.requireModule ?? createRequire(moduleUrl);

  try {
    const here = dirname(fileURLToPath(moduleUrl));
    return requireModule(join(here, ...BUNDLED_LOADER_SUBPATH));
  } catch (err) {
    if (!isModuleNotFound(err)) onLoadFailure('bundled loader failed to load', err);
  }

  try {
    return requireModule(NATIVE_CONFIG_PACKAGE);
  } catch (err) {
    if (!isModuleNotFound(err)) onLoadFailure('workspace addon failed to load', err);
    return null;
  }
}
