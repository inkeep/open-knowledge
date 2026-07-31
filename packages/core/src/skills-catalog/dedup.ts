/**
 * Content-hash identity dedup for in-place skills (identity + fork guard).
 *
 * A skill can appear in several editor dirs (`.claude/skills/foo`, `.codex/skills/foo`).
 * Two questions must be answered WITHOUT ever merging skills that are only
 * incidentally same-named:
 *  - Same (scope, name) AND same content → ONE skill, one tracked identity: a
 *    canonical (precedence winner) plus copies. This is what dedup collapses.
 *  - Same (scope, name) but DIFFERENT content → a FORK: two genuinely different
 *    skills that happen to share a name. NEVER auto-merged, NEVER auto-distributed
 *    over each other (the data-loss guard from design-review S1).
 *
 * Identity key is `(scope, name, contentHash)`, not `name` alone — a project `foo`
 * and a global `foo` are different skills too. This module is the pure decision
 * core; enumerate-time hashing + fan-out wiring consume it.
 */

import type { EditorId } from '../constants/editors.ts';
import type { SkillScope } from '../schemas/api/tags-search.ts';

/**
 * A skill-dir host: an editor id, or `'agents'` for the vendor-neutral
 * `.agents/skills` hub (a first-class in-place host with no `EditorId` of its
 * own — spec R14).
 */
export type SkillHostId = EditorId | 'agents';

/**
 * Canonical-selection precedence. A reversible tiebreaker used ONLY to
 * pick which host dir is the tracked canonical among SAME-hash copies of one
 * skill — never to unify distinct-hash forks. Earlier = wins. `agents` leads:
 * the vendor-neutral hub is the copy other hosts sync FROM, so among identical
 * copies it is the natural source of truth.
 */
export const SKILL_CANONICAL_PRECEDENCE: readonly SkillHostId[] = [
  'agents',
  'claude',
  'cursor',
  'codex',
  'opencode',
  'pi',
  'copilot',
];

/** One on-disk skill occurrence, pre-hashed. */
export interface SkillOccurrence {
  /** Skill name (bundle dir basename). Slash-free and space-free by grammar. */
  readonly name: string;
  /** Project vs global — part of identity: a project `foo` and a global `foo` are
   *  DIFFERENT skills and must never dedup or fork against each other. */
  readonly scope: SkillScope;
  /** The host whose dir this occurrence lives in (editor, or the `.agents` hub). */
  readonly editor: SkillHostId;
  /** sha256 (or equivalent) over the bundle's content — the dedup identity. */
  readonly contentHash: string;
  /** User-chosen source (sticky relocation choice): wins canonical election
   *  over the static precedence order. */
  readonly preferredSource?: boolean;
  /** True when this occurrence is a SYMLINK on disk. A symlink can NEVER be
   *  elected canonical — the canonical must be a real directory (the movers
   *  rename/remove the canonical path, and renaming a link instead of the real
   *  folder is how a skill's last real copy dies). Overrides preferredSource. */
  readonly viaLink?: boolean;
}

/** A deduplicated skill identity: one canonical + its same-content copies. */
export interface SkillIdentityGroup<T extends SkillOccurrence = SkillOccurrence> {
  readonly name: string;
  readonly scope: SkillScope;
  readonly contentHash: string;
  /** The precedence-winning occurrence — the ONE tracked/versioned identity. */
  readonly canonical: T;
  /** Other occurrences with identical content — pure delivery copies. */
  readonly copies: readonly T[];
  /**
   * True when another group shares this (scope, name) with a DIFFERENT hash — i.e.
   * this skill has a same-named sibling that is NOT a copy of it. Both are real and
   * both surface; fan-out must never distribute one over the other.
   */
  readonly isFork: boolean;
}

function precedenceRank(editor: SkillHostId): number {
  const i = SKILL_CANONICAL_PRECEDENCE.indexOf(editor);
  // Unlisted editors sort after listed ones, in a stable order by id.
  return i === -1 ? SKILL_CANONICAL_PRECEDENCE.length : i;
}

/** Map/group key delimiter. `|` cannot appear in a name, scope, or hex hash. */
const SEP = '|';

/**
 * Group occurrences into deduplicated skill identities. Same `(scope, name,
 * contentHash)` collapses to one group (canonical by {@link SKILL_CANONICAL_PRECEDENCE},
 * rest copies); same (scope, name) with different hashes yields SEPARATE groups,
 * each flagged `isFork` so callers never auto-merge or cross-distribute them (S1).
 */
export function groupSkillsByIdentity<T extends SkillOccurrence>(
  occurrences: readonly T[],
): SkillIdentityGroup<T>[] {
  const byKey = new Map<string, T[]>();
  // Fork detection is per (scope, name): how many distinct hashes share it.
  const hashesPerSkill = new Map<string, Set<string>>();

  for (const occ of occurrences) {
    const skillKey = `${occ.scope}${SEP}${occ.name}`;
    const key = `${skillKey}${SEP}${occ.contentHash}`;
    let members = byKey.get(key);
    if (!members) {
      members = [];
      byKey.set(key, members);
    }
    members.push(occ);
    let hashes = hashesPerSkill.get(skillKey);
    if (!hashes) {
      hashes = new Set();
      hashesPerSkill.set(skillKey, hashes);
    }
    hashes.add(occ.contentHash);
  }

  const groups: SkillIdentityGroup<T>[] = [];
  for (const members of byKey.values()) {
    const sorted = [...members].sort((a, b) => {
      // SAFETY FIRST: a real directory always beats a symlink — even a sticky
      // user preference pointing at a link is ignored (electing a link as
      // canonical lets the movers rename the link and orphan the real bytes).
      const real = Number(a.viaLink === true) - Number(b.viaLink === true);
      if (real !== 0) return real;
      // A user-chosen source outranks static precedence (sticky relocation).
      const p = Number(b.preferredSource === true) - Number(a.preferredSource === true);
      if (p !== 0) return p;
      const r = precedenceRank(a.editor) - precedenceRank(b.editor);
      return r !== 0 ? r : a.editor.localeCompare(b.editor);
    });
    const canonical = sorted[0];
    if (!canonical) continue; // unreachable: byKey values are non-empty by construction
    groups.push({
      name: canonical.name,
      scope: canonical.scope,
      contentHash: canonical.contentHash,
      canonical,
      copies: sorted.slice(1),
      isFork: (hashesPerSkill.get(`${canonical.scope}${SEP}${canonical.name}`)?.size ?? 1) > 1,
    });
  }
  // Stable output: by scope, name, then hash.
  return groups.sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.name.localeCompare(b.name) ||
      a.contentHash.localeCompare(b.contentHash),
  );
}
