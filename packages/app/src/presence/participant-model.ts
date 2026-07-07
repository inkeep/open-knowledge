import type { AgentPresenceEntry } from '@inkeep/open-knowledge-core';
import type { AwarenessState, AwarenessUser } from './identity.ts';

/**
 * A human participant — publishes per-doc awareness (name, color, icon,
 * cursor position, mode). Cursors are rendered by `@tiptap/extension-
 * collaboration-cursor`.
 *
 * `tabCount` is 1 for non-deduped entries and ≥2 when multiple clientIds
 * share the same `principalId` (multi-tab dedupe for git-config users). The
 * tooltip in PresenceBar uses this to show "Name · N tabs" when N > 1.
 */
export interface HumanParticipant {
  kind: 'human';
  clientId: number;
  user: AwarenessUser;
  mode: AwarenessState['mode'];
  tabCount: number;
}

/**
 * An agent participant — publishes presence via the `__system__` Y.Doc's
 * `agentPresence` map (never per-doc awareness; see precedent #3).
 * `presence` carries everything the bar needs: displayName, icon, color,
 * currentDoc, mode, ts.
 */
export interface AgentParticipant {
  kind: 'agent';
  agentId: string;
  presence: AgentPresenceEntry;
}

export type Participant = HumanParticipant | AgentParticipant;

/**
 * Shallow-compare two Participant arrays across the render-affecting
 * fields. Intentionally skips `presence.ts` because the timestamp shifts
 * on every `touchMode` call (mode-flip → same render output) without
 * changing what the bar looks like. Used to short-circuit the 1 Hz TTL
 * tick's `setState` when no peer actually changed — React Compiler cannot
 * elide this because every tick produces a fresh object reference.
 *
 * `user.principalId` is not compared directly; principalId changes are
 * covered indirectly because color is seeded from principalId — a
 * principalId transition (e.g. boot-race resolution) always changes color.
 */
export function participantsEqual(a: Participant[], b: Participant[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.kind !== y.kind) return false;
    if (x.kind === 'human' && y.kind === 'human') {
      if (x.clientId !== y.clientId || x.mode !== y.mode || x.tabCount !== y.tabCount) return false;
      const u = x.user;
      const v = y.user;
      if (u.name !== v.name || u.color !== v.color || u.icon !== v.icon) return false;
    } else if (x.kind === 'agent' && y.kind === 'agent') {
      if (x.agentId !== y.agentId) return false;
      const p = x.presence;
      const q = y.presence;
      if (
        p.displayName !== q.displayName ||
        p.icon !== q.icon ||
        p.color !== q.color ||
        p.currentDoc !== q.currentDoc ||
        p.mode !== q.mode
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Dedupe `HumanParticipant[]` by `principalId`, collapsing multiple entries
 * that share the same eligible principalId into one with `tabCount` set to
 * the group size. Eligible means `typeof principalId === 'string' && principalId.length > 0`.
 *
 * Tie-break: the entry with the lowest `clientId` is the representative.
 * Output order matches the position of each group's representative (lowest-clientId
 * entry) in the input. When the representative is NOT the first-occurring entry for
 * that principalId, earlier non-representative entries are skipped and the group
 * appears at the representative's position. Ineligible entries (no principalId or
 * empty string) pass through as-is with `tabCount === 1`.
 */
export function dedupeHumansByPrincipalId(humans: HumanParticipant[]): HumanParticipant[] {
  const groups = new Map<string, HumanParticipant[]>();
  for (const h of humans) {
    const pid = h.user.principalId;
    if (typeof pid === 'string' && pid.length > 0) {
      const g = groups.get(pid);
      if (g) g.push(h);
      else groups.set(pid, [h]);
    }
  }

  const reps = new Map<string, { repClientId: number; count: number }>();
  for (const [pid, group] of groups) {
    const repClientId = group.reduce((min, h) => Math.min(min, h.clientId), Infinity);
    reps.set(pid, { repClientId, count: group.length });
  }

  const result: HumanParticipant[] = [];
  for (const h of humans) {
    const pid = h.user.principalId;
    if (typeof pid === 'string' && pid.length > 0) {
      const info = reps.get(pid);
      if (info && info.repClientId === h.clientId) {
        result.push({ ...h, tabCount: info.count });
      }
    } else {
      result.push({ ...h, tabCount: 1 });
    }
  }

  return result;
}
