/**
 * Module-level snapshot of the current skill names (project + global), for
 * consumers that can't await — editor decoration passes classify `/name`
 * skill references synchronously. Lazily fetched, refreshed on the shared
 * `skills-changed` signal; `null` until the first fetch lands (callers treat
 * that as "classification unknown" and decorate nothing).
 */
import type { SkillScope } from '@inkeep/open-knowledge-core';
import { subscribeToSkillsChanged } from '@/lib/documents-events';
import { listSkills } from '@/lib/skills-api';

interface SkillNameInfo {
  scope: SkillScope;
  path: string;
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
        scoped[scope].set(sk.name, { scope: sk.scope, path: sk.path });
        // Project wins a name collision (matches the open/read rules).
        if (!out.has(sk.name)) out.set(sk.name, { scope: sk.scope, path: sk.path });
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
