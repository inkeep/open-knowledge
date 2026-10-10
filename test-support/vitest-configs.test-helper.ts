import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ConfigEnv } from 'vitest/config';
import { gitCleanEnv } from '../scripts/git-clean-env.mjs';

const CONFIG_FILENAME = /(?:^|\.)vite(st)?[\w.-]*\.config\.m?[jt]s$/;
const TEST_CONFIG_FILENAME = /(?:^|\.)vitest[\w.-]*\.config\.m?[jt]s$/;

const VITEST_CONFIG_ENV: ConfigEnv = {
  command: 'serve',
  mode: 'test',
  isPreview: false,
  isSsrBuild: false,
};

type ConfigOptions = {
  plugins?: unknown;
  extends?: unknown;
  test?: { name?: unknown; setupFiles?: unknown; projects?: unknown };
};

export type ProjectReading<Value> =
  | { kind: 'resolved'; project: string; values: readonly Value[] }
  | { kind: 'unresolved'; project: string; reference: string };

export const isTestConfig = (relPath: string): boolean =>
  TEST_CONFIG_FILENAME.test(basename(relPath));

export function trackedFiles(root: string, pathspecs: readonly string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: root,
    env: gitCleanEnv(),
    encoding: 'utf8',
  })
    .split('\0')
    .filter((relPath) => relPath !== '');
}

export function trackedConfigs(root: string): string[] {
  return trackedFiles(root, ['*.config.ts', '*.config.mts', '*.config.js', '*.config.mjs'])
    .filter((relPath) => CONFIG_FILENAME.test(basename(relPath)))
    .sort();
}

async function loadConfig(path: string): Promise<unknown> {
  const loaded: unknown = await import(pathToFileURL(path).href);
  const exported = (loaded as { default?: unknown }).default ?? loaded;
  return typeof exported === 'function' ? await exported(VITEST_CONFIG_ENV) : exported;
}

async function readProject<Value>(
  relPath: string,
  declared: readonly Value[],
  definition: unknown,
  index: number,
  valuesOf: (options: ConfigOptions) => readonly Value[] | Promise<readonly Value[]>,
): Promise<ProjectReading<Value>> {
  if (typeof definition === 'string') {
    return { kind: 'unresolved', project: `${relPath} project ${index}`, reference: definition };
  }
  const project = (await (typeof definition === 'function'
    ? definition(VITEST_CONFIG_ENV)
    : definition)) as ConfigOptions;
  const name = project.test?.name;
  const label = `${relPath} project ${typeof name === 'string' ? name : index}`;
  if (typeof project.extends === 'string') {
    return { kind: 'unresolved', project: label, reference: project.extends };
  }
  const inherited = project.extends === false ? [] : declared;
  return { kind: 'resolved', project: label, values: [...inherited, ...(await valuesOf(project))] };
}

export async function readConfigProjects<Value>(
  root: string,
  relPath: string,
  valuesOf: (options: ConfigOptions) => readonly Value[] | Promise<readonly Value[]>,
): Promise<Array<ProjectReading<Value>>> {
  const config = (await loadConfig(join(root, relPath))) as ConfigOptions;
  const declared = await valuesOf(config);
  const definitions = config.test?.projects;
  if (!Array.isArray(definitions))
    return [{ kind: 'resolved', project: relPath, values: declared }];
  return Promise.all(
    definitions.map((definition: unknown, index: number) =>
      readProject(relPath, declared, definition, index, valuesOf),
    ),
  );
}
