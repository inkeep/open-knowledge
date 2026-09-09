import { accessSync, constants, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { configFileDeclineDetail, configFileDeclineReason } from '../utils/config-file-error.ts';
import { escapeDisplayPath } from '../utils/escape-display-path.ts';

export type PiTrustResources =
  | { kind: 'none' }
  | { kind: 'shared'; paths: string[] }
  | { kind: 'unreadable'; error: string };

const PI_PROJECT_RESOURCES = [
  'settings.json',
  'prompts',
  'themes',
  'SYSTEM.md',
  'APPEND_SYSTEM.md',
];

class PiResourceInspectionError extends Error {
  override name = 'PiResourceInspectionError';
}

function readablePathExists(path: string): boolean {
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (error) {
    if (entry.isSymbolicLink() && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PiResourceInspectionError(configFileDeclineDetail('missing-symlink-target'), {
        cause: error,
      });
    }
    throw error;
  }
  accessSync(path, constants.R_OK | (stat.isDirectory() ? constants.X_OK : 0));
  return true;
}

function isOwnedSkillName(name: string): boolean {
  return name === 'open-knowledge' || name.startsWith('open-knowledge-');
}

export function inspectPiTrustResources(
  cwd: string,
  home: string,
  bridgePath: string,
): PiTrustResources {
  let inspecting = cwd;
  try {
    const project = realpathSync(cwd);
    let userHome: string;
    inspecting = home;
    try {
      userHome = realpathSync(home);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      userHome = resolve(home);
    }
    const globalSkills = join(userHome, '.agents', 'skills');
    const paths: string[] = [];
    for (const name of PI_PROJECT_RESOURCES) {
      inspecting = join(project, '.pi', name);
      if (readablePathExists(inspecting)) paths.push(inspecting);
    }
    inspecting = join(project, '.pi', 'extensions');
    if (readablePathExists(inspecting)) {
      for (const name of readdirSync(inspecting).sort()) {
        const path = join(inspecting, name);
        if (resolve(bridgePath) !== join(resolve(cwd), '.pi', 'extensions', name)) {
          paths.push(path);
        }
      }
    }
    for (const directory of [join(project, '.pi', 'skills'), join(project, '.agents', 'skills')]) {
      if (directory === globalSkills) continue;
      inspecting = directory;
      if (!readablePathExists(directory)) continue;
      for (const name of readdirSync(directory).sort()) {
        if (!isOwnedSkillName(name)) paths.push(join(directory, name));
      }
    }
    let ancestor = dirname(project);
    while (ancestor !== project) {
      inspecting = join(ancestor, '.agents', 'skills');
      if (inspecting !== globalSkills && readablePathExists(inspecting)) paths.push(inspecting);
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    return paths.length === 0 ? { kind: 'none' } : { kind: 'shared', paths: paths.sort() };
  } catch (error) {
    return {
      kind: 'unreadable',
      error: `Could not inspect Pi project resources at ${escapeDisplayPath(inspecting)}: ${error instanceof PiResourceInspectionError ? error.message : configFileDeclineDetail(configFileDeclineReason(error))}`,
    };
  }
}
