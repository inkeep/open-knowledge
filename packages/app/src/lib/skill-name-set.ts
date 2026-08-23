/**
 * Module-level snapshot of the current skill names (project + global), for
 * consumers that can't await — editor decoration passes classify `/name`
 * skill references synchronously. Lazily fetched, refreshed on the shared
 * `skills-changed` signal; `null` until the first fetch lands (callers treat
 * that as "classification unknown" and decorate nothing).
 */
import type { SkillScope } from '@inkeep/open-knowledge-core';
import { hashFromDocName, hashFromSkillPreview } from '@/lib/doc-hash';
import { subscribeToSkillsChanged } from '@/lib/documents-events';
import { skillEntryLiveDocName } from '@/lib/managed-artifact-doc-name';
import { listSkills } from '@/lib/skills-api';

interface SkillNameInfo {
  scope: SkillScope;
  path: string;
  /** Managed built-in — read-only everywhere, so a `/name` reference must
   *  open the preview, never the live editable doc. */
  managed?: boolean;
  absolutePath?: string;
}
let merged: Map<string, SkillNameInfo> | null = null;
let byScope: Record<SkillScope, Map<string, SkillNameInfo>> | null = null;
let fetching = false;
let subscribed = false;

async function refresh(): Promise<void> {
  if (fetching) return;
  fetching = true;
  try {
    const scoped: Record<SkillScope, Map<string, SkillNameInfo>> = {
      project: new Map(),
      global: new Map(),
    };
    const out = new Map<string, SkillNameInfo>();
    for (const scope of ['project', 'global'] as const) {
      const res = await listSkills(scope);
      if (!res.ok) continue;
      for (const sk of res.skills) {
        const info: SkillNameInfo = {
          scope: sk.scope,
          path: sk.path,
          ...(sk.managed === true ? { managed: true } : {}),
          ...(sk.absolutePath !== undefined ? { absolutePath: sk.absolutePath } : {}),
        };
        scoped[scope].set(sk.name, info);
        // Project wins a name collision (matches the open/read rules).
        if (!out.has(sk.name)) out.set(sk.name, info);
      }
    }
    merged = out;
    byScope = scoped;
  } catch {
    // Keep the previous snapshot on a failed refresh.
  } finally {
    fetching = false;
  }
}

function ensureSubscribed(): void {
  if (!subscribed) {
    subscribed = true;
    subscribeToSkillsChanged(() => void refresh());
  }
}

/**
 * Navigation hash for a snapshot hit on a `/name` skill reference. A managed
 * BUILT-IN routes to the read-only preview — the same destination every other
 * surface (dock, palette) resolves for it — never the live editable doc.
 */
export function skillRefNavHashForHit(name: string, hit: SkillNameInfo): string {
  if (hit.managed === true && hit.absolutePath !== undefined) {
    const cut = Math.max(hit.absolutePath.lastIndexOf('/'), hit.absolutePath.lastIndexOf('\\'));
    return hashFromSkillPreview({
      flavor: 'builtin',
      source: cut > 0 ? hit.absolutePath.slice(0, cut) : hit.absolutePath,
      name,
      subtitle: '',
      level: hit.scope,
    });
  }
  return hashFromDocName(skillEntryLiveDocName({ scope: hit.scope, name, path: hit.path }));
}

/** Latest known merged skill-name map (project wins a collision), or null
 *  before the first fetch (which this call kicks off). */
export function getSkillNameSnapshot(): Map<string, SkillNameInfo> | null {
  ensureSubscribed();
  if (merged === null) void refresh();
  return merged;
}

/** Per-scope name map — the reference PICKER is same-scope only (a global
 *  skill referencing a project skill would break wherever that project isn't
 *  open; a project doc keeps its references within the project's own set). */
export function getSkillNamesForScope(scope: SkillScope): Map<string, SkillNameInfo> | null {
  ensureSubscribed();
  if (byScope === null) {
    void refresh();
    return null;
  }
  return byScope[scope];
}
