import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginCapabilities } from './types.ts';

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function nonEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

const BUNDLED_SKILLS_MAX_DEPTH = 4;

export function enumerateBundledSkills(dir: string): string[] {
  const names = new Set<string>();
  const walk = (current: string, depth: number): void => {
    if (depth > BUNDLED_SKILLS_MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    if (isRegularFile(join(current, 'SKILL.md')) || isRegularFile(join(current, 'SKILL.mdx'))) {
      names.add(current.split('/').pop() ?? current);
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(current, e.name), depth + 1);
    }
  };
  walk(join(dir, 'skills'), 0);
  return [...names].sort();
}

export function inspectBundleCapabilities(dir: string): PluginCapabilities {
  return {
    commands: nonEmptyDir(join(dir, 'commands')),
    hooks: nonEmptyDir(join(dir, 'hooks')) || existsSync(join(dir, 'hooks.json')),
    mcp: existsSync(join(dir, '.mcp.json')) || existsSync(join(dir, 'mcp.json')),
    agents: nonEmptyDir(join(dir, 'agents')),
  };
}
