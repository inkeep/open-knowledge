import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ResolvedConfig } from 'vite';

export type TestServerLoadedInputs = Readonly<Record<string, string | null>>;

type RestartInputConfig = Pick<
  ResolvedConfig,
  'configFile' | 'configFileDependencies' | 'envDir' | 'mode'
>;

export function viteRestartInputs({
  configFile,
  configFileDependencies,
  envDir,
  mode,
}: RestartInputConfig): string[] {
  // UPSTREAM(vite@8.0.0): Vite restarts on the env files getEnvFilesForMode lists, which it does not export; keep these names equal to it
  const envFiles =
    envDir === false
      ? []
      : ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`].map((name) =>
          join(envDir, name),
        );
  const config = configFile === undefined ? [] : [configFile];
  return [...new Set([...config, ...configFileDependencies, ...envFiles])].sort();
}

function contentDigest(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return `unreadable (${code ?? String(error)})`;
  }
}

export function digestLoadedInputs(paths: Iterable<string>): TestServerLoadedInputs {
  return Object.fromEntries([...paths].sort().map((path) => [path, contentDigest(path)]));
}

export function parseTestServerLoadedInputs(value: unknown): TestServerLoadedInputs | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  const wellFormed = entries.every(
    ([path, digest]) => isAbsolute(path) && (digest === null || typeof digest === 'string'),
  );
  return wellFormed ? (Object.fromEntries(entries) as TestServerLoadedInputs) : undefined;
}

export function changedLoadedInputs(loaded: TestServerLoadedInputs): string[] {
  const current = digestLoadedInputs(Object.keys(loaded));
  return Object.keys(loaded)
    .filter((path) => loaded[path] !== current[path])
    .sort();
}
