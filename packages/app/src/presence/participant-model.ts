import type { AgentPresenceEntry } from '@inkeep/open-knowledge-core';
import type { AwarenessState, AwarenessUser } from './identity.ts';

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
