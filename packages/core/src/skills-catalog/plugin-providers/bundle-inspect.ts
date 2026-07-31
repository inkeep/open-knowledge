import { type Dirent, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginCapabilities } from './types.ts';

/** A dir counts as present-and-active when it exists and holds ≥1 entry. */
function nonEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

/** Max dir depth walked under `skills/` — real plugins nest one level by
 *  category (`skills/productivity/grill-me/SKILL.md`); a couple more guards
 *  against a pathological tree without an unbounded walk. */
const BUNDLED_SKILLS_MAX_DEPTH = 4;

/**
 * The bundled skills shipped in a cloned plugin repo. Every plugin harness
 * (Claude, Codex, Copilot, Gemini) keeps skills under a `skills/` dir, but the
 * skill dirs may sit DIRECTLY under it (`skills/grill-me/SKILL.md`) OR nested by
 * category (`skills/productivity/grill-me/SKILL.md`) — so this recursively finds
 * every `SKILL.md`/`SKILL.mdx` and returns its CONTAINING dir's basename (the
 * skill name discovery/import use). A plugin with no `skills/` dir, or one whose
 * skills carry no SKILL.md, returns [] and the caller treats it as "not a skill
 * bundle". Deduped + sorted.
 */
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
    // This dir IS a skill dir when it holds a SKILL.md — record its basename and
    // don't descend further (references/scripts under it aren't sub-skills).
    if (existsSync(join(current, 'SKILL.md')) || existsSync(join(current, 'SKILL.mdx'))) {
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

/**
 * Capability presence-flags for a cloned plugin repo — read-only disk facts,
 * never mapped or executed (the trust contract). Root-dir/file conventions that
 * hold across the plugin harnesses: `commands/`, `hooks/` or a `hooks.json`,
 * `.mcp.json` (or an inline `mcpServers` manifest field, checked by the caller),
 * `agents/`.
 */
export function inspectBundleCapabilities(dir: string): PluginCapabilities {
  return {
    commands: nonEmptyDir(join(dir, 'commands')),
    hooks: nonEmptyDir(join(dir, 'hooks')) || existsSync(join(dir, 'hooks.json')),
    mcp: existsSync(join(dir, '.mcp.json')),
    agents: nonEmptyDir(join(dir, 'agents')),
  };
}
