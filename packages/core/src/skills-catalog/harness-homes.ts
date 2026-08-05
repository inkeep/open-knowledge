/**
 * Per-harness skill-dir home map — where each agent keeps its installed skills.
 *
 * MIRRORS the agentskills.io / vercel-labs `skills` per-agent dir map (the
 * standard `skills.sh` fans out into 51 agents); OK does not invent its own.
 * Every entry is a USER-GLOBAL `~/.<host>/skills/<name>/SKILL.md` home except
 * Claude's plugin source, which is richer (provenance-carrying) and read by a
 * dedicated adapter. Adding a harness the ecosystem map gains is one line here.
 *
 * Read-only: these dirs are resolved under the user's home only; the enumerator
 * never follows a path that escapes its home. Note OK ALREADY writes the bare
 * dirs (`.claude/skills`, `.codex/skills`, …) via scope projection — they are
 * not read-only stores; this slice simply reads them. The one store OK must
 * never write is the Claude plugin cache (`~/.claude/plugins/**`).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ALL_EDITOR_IDS,
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_USER_SKILL_ROOT,
} from '../constants/editors.ts';
import { pluginProviderHomes } from './plugin-providers/registry.ts';
import type { PluginProviderId } from './plugin-providers/types.ts';

/** How a harness home is read. */
export type HarnessHome =
  | {
      readonly harness: string;
      readonly kind: 'plugin-provider';
      readonly provider: PluginProviderId;
      readonly dir: string;
    }
  | {
      readonly harness: string;
      readonly kind: 'skill-dir';
      readonly dir: string;
    };

/**
 * Resolve the harness homes for a given user home dir (defaults to the real
 * one; the param exists so tests can point at a fixture root). The Claude
 * plugin source is listed first so its rich provenance wins on cross-harness
 * de-dupe.
 */
export function harnessHomes(home: string = homedir()): HarnessHome[] {
  // The per-editor skill-dir homes derive from the canonical `EDITOR_USER_SKILL_ROOT`
  // map so a detectable editor is onboarded by one row there, not a hand-edit
  // here. The Claude plugin source and the vendor-neutral `.agents` hub are NOT
  // editor ids, so they bracket the derived list — plugins FIRST so its rich
  // provenance wins cross-harness de-dupe.
  const editorHomes = ALL_EDITOR_IDS.flatMap<HarnessHome>((id) => {
    const root = EDITOR_USER_SKILL_ROOT[id];
    return root === null
      ? []
      : [{ harness: id, kind: 'skill-dir', dir: join(home, ...root.split('/')) }];
  });
  return [
    ...pluginProviderHomes(home).map<HarnessHome>((providerHome) => ({
      kind: 'plugin-provider',
      ...providerHome,
    })),
    ...editorHomes,
    { harness: 'agents', kind: 'skill-dir', dir: join(home, '.agents', 'skills') },
  ];
}

/**
 * Every user-global directory a skill can legitimately live in: the harness
 * homes plus the `~/.ok/skills` store. Each segment is home-derived and
 * constant — nothing here comes from a caller — which is what lets the desktop
 * admit them as reveal roots without widening path containment to the whole
 * home dir.
 */
export function userGlobalSkillRoots(home: string = homedir()): string[] {
  return [...harnessHomes(home).map((h) => h.dir), join(home, '.ok', 'skills')];
}

/**
 * The PROJECT-scoped harness skill dirs — `<projectDir>/.<harness>/skills` for
 * every harness that keeps a bare project skill-dir layout. Derived from
 * `EDITOR_PROJECT_SKILL_ROOT`, not the user-home map: several hosts deliberately
 * use different paths at the two scopes. The Claude plugin cache remains a
 * user-global store and is never included here.
 */
export function projectHarnessHomes(projectDir: string): HarnessHome[] {
  return ALL_EDITOR_IDS.flatMap<HarnessHome>((id) => {
    const root = EDITOR_PROJECT_SKILL_ROOT[id];
    return root === null
      ? []
      : [{ harness: id, kind: 'skill-dir', dir: join(projectDir, ...root.split('/')) }];
  });
}
