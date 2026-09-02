import type { EditorId } from '../constants/editors.ts';
import type { SkillScope } from '../schemas/api/tags-search.ts';

export type SkillHostId = EditorId | 'agents';

export const SKILL_CANONICAL_PRECEDENCE: readonly SkillHostId[] = [
  'agents',
  'claude',
  'cursor',
  'codex',
  'opencode',
  'pi',
  'copilot',
];

export interface SkillOccurrence {
  readonly name: string;
  readonly scope: SkillScope;
  readonly editor: SkillHostId;
  readonly contentHash: string;
  readonly preferredSource?: boolean;
  readonly viaLink?: boolean;
}

export interface SkillIdentityGroup<T extends SkillOccurrence = SkillOccurrence> {
  readonly name: string;
  readonly scope: SkillScope;
  readonly contentHash: string;
  readonly canonical: T;
  readonly copies: readonly T[];
  readonly isFork: boolean;
}

function precedenceRank(editor: SkillHostId): number {
  const i = SKILL_CANONICAL_PRECEDENCE.indexOf(editor);
  return i === -1 ? SKILL_CANONICAL_PRECEDENCE.length : i;
}

const SEP = '|';

export function groupSkillsByIdentity<T extends SkillOccurrence>(
  occurrences: readonly T[],
): SkillIdentityGroup<T>[] {
  const byKey = new Map<string, T[]>();
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
      const real = Number(a.viaLink === true) - Number(b.viaLink === true);
      if (real !== 0) return real;
      const p = Number(b.preferredSource === true) - Number(a.preferredSource === true);
      if (p !== 0) return p;
      const r = precedenceRank(a.editor) - precedenceRank(b.editor);
      return r !== 0 ? r : a.editor.localeCompare(b.editor);
    });
    const canonical = sorted[0];
    if (!canonical) continue;
    groups.push({
      name: canonical.name,
      scope: canonical.scope,
      contentHash: canonical.contentHash,
      canonical,
      copies: sorted.slice(1),
      isFork: (hashesPerSkill.get(`${canonical.scope}${SEP}${canonical.name}`)?.size ?? 1) > 1,
    });
  }
  return groups.sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.name.localeCompare(b.name) ||
      a.contentHash.localeCompare(b.contentHash),
  );
}
