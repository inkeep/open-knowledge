import type { ConnectionCell, ConnectionsView } from './connections.ts';
import { type PrerequisiteBlocker, requiresExplicitConsent } from './fold.ts';
import type { AgentId, IntegrationPiece, PathId, SatisfierId, SatisfierScope } from './ids.ts';
import type { Installability } from './schema.ts';
import type { SatisfierKind, SurfaceState } from './vocabulary.ts';

export const INTENT_DESIRES = ['present', 'absent'] as const;
export type IntentDesire = (typeof INTENT_DESIRES)[number];

export interface ApplyIntent {
  readonly satisfierId: SatisfierId;
  readonly desired: IntentDesire;
}

export const PLAN_STEP_ORIGINS = ['requested', 'prerequisite'] as const;
export type PlanStepOrigin = (typeof PLAN_STEP_ORIGINS)[number];

export interface PlannedStep {
  readonly satisfierId: SatisfierId;
  readonly agentId: AgentId;
  readonly piece: IntegrationPiece;
  readonly scope: SatisfierScope;
  readonly kind: SatisfierKind;
  readonly pathId?: PathId;
  readonly desired: IntentDesire;
  readonly origin: PlanStepOrigin;
  readonly dependsOn: readonly SatisfierId[];
  readonly state: SurfaceState;
  readonly installability: Installability;
  readonly alreadyInDesiredState: boolean;
}

export const PLAN_CONFLICT_KINDS = [
  'malformed-intent',
  'unknown-satisfier',
  'blocked-satisfier',
  'contradictory-intents',
  'unresolved-shared-copy',
  'prerequisite-unavailable',
  'prerequisite-removed',
  'prerequisite-cycle',
] as const;
export type PlanConflictKind = (typeof PLAN_CONFLICT_KINDS)[number];

export interface PlanConflict {
  readonly kind: PlanConflictKind;
  readonly satisfierIds: readonly SatisfierId[];
  readonly agentIds: readonly AgentId[];
  readonly pathId?: PathId;
  readonly blockedReason?: PrerequisiteBlocker;
}

export interface IntentPlan {
  readonly steps: readonly PlannedStep[];
  readonly conflicts: readonly PlanConflict[];
  readonly withheld: readonly SatisfierId[];
}

const EMPTY_PLAN: IntentPlan = { steps: [], conflicts: [], withheld: [] };

interface Draft {
  readonly cell: ConnectionCell;
  readonly desired: IntentDesire;
  readonly origin: PlanStepOrigin;
  readonly seq: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDesire(value: unknown): value is IntentDesire {
  return typeof value === 'string' && (INTENT_DESIRES as readonly string[]).includes(value);
}

function indexCells(view: ConnectionsView | null | undefined): Map<string, ConnectionCell> {
  const index = new Map<string, ConnectionCell>();
  if (!isRecord(view) || !Array.isArray(view.rows)) return index;

  for (const row of view.rows) {
    if (!isRecord(row) || !Array.isArray(row.scopes)) continue;
    for (const group of row.scopes) {
      if (!isRecord(group) || !Array.isArray(group.cells)) continue;
      for (const cell of group.cells) {
        if (isRecord(cell) && typeof cell.satisfierId === 'string') {
          index.set(cell.satisfierId, cell as unknown as ConnectionCell);
        }
      }
    }
  }

  return index;
}

function cellsOverPath(cells: Iterable<ConnectionCell>, path: PathId): ConnectionCell[] {
  return [...cells].filter((cell) => cell.pathId === path);
}

class Planner {
  private readonly cells: Map<string, ConnectionCell>;
  private readonly drafts = new Map<SatisfierId, Draft>();
  private readonly conflicts: PlanConflict[] = [];
  private seq = 0;

  constructor(view: ConnectionsView | null | undefined) {
    this.cells = indexCells(view);
  }

  private conflict(input: {
    kind: PlanConflictKind;
    satisfierIds: readonly SatisfierId[];
    agentIds?: readonly AgentId[];
    pathId?: PathId;
    blockedReason?: PrerequisiteBlocker;
  }): void {
    const agentIds: AgentId[] = [];
    for (const id of input.satisfierIds) {
      const agent = this.cells.get(id)?.agentId;
      if (agent !== undefined && !agentIds.includes(agent)) agentIds.push(agent);
    }
    for (const agent of input.agentIds ?? []) {
      if (!agentIds.includes(agent)) agentIds.push(agent);
    }

    this.conflicts.push({
      kind: input.kind,
      satisfierIds: input.satisfierIds,
      agentIds,
      ...(input.pathId === undefined ? {} : { pathId: input.pathId }),
      ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
    });
  }

  admit(intents: readonly ApplyIntent[] | null | undefined): void {
    if (!Array.isArray(intents)) return;

    for (const intent of intents) {
      if (
        !isRecord(intent) ||
        typeof intent.satisfierId !== 'string' ||
        !isDesire(intent.desired)
      ) {
        this.conflict({ kind: 'malformed-intent', satisfierIds: [] });
        continue;
      }

      const id = intent.satisfierId as SatisfierId;
      const cell = this.cells.get(id);
      if (cell === undefined) {
        this.conflict({ kind: 'unknown-satisfier', satisfierIds: [id] });
        continue;
      }
      const reason = cell.disabledReason;
      if (
        reason !== null &&
        reason !== 'not-installable' &&
        (intent.desired === 'present' || reason === 'foreign')
      ) {
        this.conflict({ kind: 'blocked-satisfier', satisfierIds: [id], blockedReason: reason });
        continue;
      }

      const existing = this.drafts.get(id);
      if (existing === undefined) {
        this.drafts.set(id, {
          cell,
          desired: intent.desired,
          origin: 'requested',
          seq: this.seq++,
        });
        continue;
      }
      if (existing.desired !== intent.desired) {
        this.conflict({ kind: 'contradictory-intents', satisfierIds: [id] });
      }
    }
  }

  expandPrerequisites(): void {
    const queue = [...this.drafts.values()].filter((draft) => draft.desired === 'present');
    const seen = new Set<SatisfierId>();

    while (queue.length > 0) {
      const draft = queue.shift();
      if (draft === undefined) continue;
      if (seen.has(draft.cell.satisfierId)) continue;
      seen.add(draft.cell.satisfierId);

      const dependentId = draft.cell.satisfierId;
      const options = draft.cell.unmetPrerequisites;
      if (options.length > 0 && !options.some((id) => this.drafts.has(id))) {
        const blocked: { id: SatisfierId; reason: PrerequisiteBlocker }[] = [];
        const available: ConnectionCell[] = [];

        for (const prerequisiteId of options) {
          const cell = this.cells.get(prerequisiteId);
          if (cell === undefined) {
            this.conflict({
              kind: 'unknown-satisfier',
              satisfierIds: [prerequisiteId, dependentId],
            });
            continue;
          }
          if (cell.disabledReason !== null) {
            blocked.push({ id: prerequisiteId, reason: cell.disabledReason });
            continue;
          }
          if (requiresExplicitConsent(cell.state)) {
            blocked.push({ id: prerequisiteId, reason: 'foreign-replaceable' });
            continue;
          }
          available.push(cell);
        }

        const chosen = preferredPrerequisite(available);
        const filled = chosen !== undefined;
        if (chosen !== undefined) {
          const added: Draft = {
            cell: chosen,
            desired: 'present',
            origin: 'prerequisite',
            seq: this.seq++,
          };
          this.drafts.set(chosen.satisfierId, added);
          queue.push(added);
        }

        if (!filled) {
          for (const { id, reason } of blocked) {
            this.conflict({
              kind: 'prerequisite-unavailable',
              satisfierIds: [id, dependentId],
              blockedReason: reason,
            });
          }
        }
      }
    }
  }

  checkSharedCopies(): void {
    const drafts = [...this.drafts.values()];

    const byPath = new Map<PathId, Draft[]>();
    for (const draft of drafts) {
      const path = draft.cell.pathId;
      if (path === undefined) continue;
      const group = byPath.get(path);
      if (group === undefined) byPath.set(path, [draft]);
      else group.push(draft);
    }

    for (const [path, group] of byPath) {
      if (group.length < 2) continue;
      if (group.every((draft) => draft.desired === group[0]?.desired)) continue;
      this.conflict({
        kind: 'contradictory-intents',
        satisfierIds: group.map((draft) => draft.cell.satisfierId),
        pathId: path,
      });
    }

    for (const draft of drafts) {
      if (draft.desired !== 'absent') continue;
      const { cell } = draft;
      const path = cell.pathId;
      if (path !== undefined && cell.sharedWith.length > 0) {
        const peers = cellsOverPath(this.cells.values(), path).filter(
          (candidate) => candidate.satisfierId !== cell.satisfierId,
        );
        this.reportStrandedPeers(cell, peers, cell.sharedWith, path);
      }
      if (cell.sharedFolderWith.length > 0) {
        this.reportStrandedPeers(cell, this.folderPeersOf(cell), cell.sharedFolderWith);
      }
    }
  }

  private folderPeersOf(cell: ConnectionCell): ConnectionCell[] {
    return [...this.cells.values()].filter(
      (candidate) =>
        candidate.satisfierId !== cell.satisfierId &&
        candidate.piece === cell.piece &&
        candidate.scope === cell.scope &&
        cell.sharedFolderWith.includes(candidate.agentId),
    );
  }

  private reportStrandedPeers(
    cell: ConnectionCell,
    peers: readonly ConnectionCell[],
    sharedWith: readonly AgentId[],
    pathId?: PathId,
  ): void {
    const stranded = peers
      .filter((peer) => peer.checked)
      .filter((peer) => this.drafts.get(peer.satisfierId)?.desired !== 'absent')
      .map((peer) => peer.satisfierId);

    const invisible = sharedWith.filter((agent) => !peers.some((peer) => peer.agentId === agent));

    if (stranded.length === 0 && invisible.length === 0) return;
    this.conflict({
      kind: 'unresolved-shared-copy',
      satisfierIds: [cell.satisfierId, ...stranded],
      agentIds: invisible,
      ...(pathId === undefined ? {} : { pathId }),
    });
  }

  private anotherPrerequisiteHolds(draft: Draft, removedId: SatisfierId): boolean {
    return draft.cell.prerequisites.some((memberId) => {
      if (memberId === removedId) return false;
      const drafted = this.drafts.get(memberId);
      if (drafted !== undefined) return drafted.desired === 'present';
      return this.cells.get(memberId)?.checked === true;
    });
  }

  order(): { steps: PlannedStep[]; blocked: Set<SatisfierId> } {
    const dependsOn = new Map<SatisfierId, SatisfierId[]>();
    for (const id of this.drafts.keys()) dependsOn.set(id, []);

    const link = (before: SatisfierId, after: SatisfierId): void => {
      const edges = dependsOn.get(after);
      if (edges !== undefined && !edges.includes(before)) edges.push(before);
    };

    for (const draft of this.drafts.values()) {
      const id = draft.cell.satisfierId;
      for (const prerequisiteId of draft.cell.prerequisites) {
        const other = this.drafts.get(prerequisiteId);
        if (other === undefined) continue;

        if (draft.desired === 'present' && other.desired === 'present') {
          link(prerequisiteId, id);
        } else if (draft.desired === 'absent' && other.desired === 'absent') {
          link(id, prerequisiteId);
        } else if (
          draft.desired === 'present' &&
          other.desired === 'absent' &&
          !this.anotherPrerequisiteHolds(draft, prerequisiteId)
        ) {
          this.conflict({ kind: 'prerequisite-removed', satisfierIds: [prerequisiteId, id] });
        }
      }
    }

    const ordered: Draft[] = [];
    const placed = new Set<SatisfierId>();
    const pending = [...this.drafts.values()].sort((a, b) => a.seq - b.seq);

    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const draft of pending) {
        const id = draft.cell.satisfierId;
        if (placed.has(id)) continue;
        const edges = dependsOn.get(id) ?? [];
        if (!edges.every((edge) => placed.has(edge))) continue;
        ordered.push(draft);
        placed.add(id);
        progressed = true;
      }
    }

    const looping = pending.filter((draft) => !placed.has(draft.cell.satisfierId));
    if (looping.length > 0) {
      this.conflict({
        kind: 'prerequisite-cycle',
        satisfierIds: looping.map((draft) => draft.cell.satisfierId),
      });
    }

    const steps = ordered.map((draft) => this.toStep(draft, dependsOn));
    return { steps, blocked: new Set(looping.map((draft) => draft.cell.satisfierId)) };
  }

  private toStep(draft: Draft, dependsOn: Map<SatisfierId, SatisfierId[]>): PlannedStep {
    const { cell } = draft;
    return {
      satisfierId: cell.satisfierId,
      agentId: cell.agentId,
      piece: cell.piece,
      scope: cell.scope,
      kind: cell.kind,
      ...(cell.pathId === undefined ? {} : { pathId: cell.pathId }),
      desired: draft.desired,
      origin: draft.origin,
      dependsOn: dependsOn.get(cell.satisfierId) ?? [],
      state: cell.state,
      installability: cell.installability,
      alreadyInDesiredState: cell.checked === (draft.desired === 'present'),
    };
  }

  finish(ordered: { steps: PlannedStep[]; blocked: Set<SatisfierId> }): IntentPlan {
    const withheld = new Set<SatisfierId>(ordered.blocked);
    for (const conflict of this.conflicts) {
      for (const id of conflict.satisfierIds) {
        if (this.drafts.has(id)) withheld.add(id);
      }
    }
    if (this.conflicts.length > 0) {
      for (const id of this.drafts.keys()) withheld.add(id);
    }

    for (const step of ordered.steps) {
      if (step.dependsOn.some((id) => withheld.has(id))) withheld.add(step.satisfierId);
    }

    return {
      steps: ordered.steps.filter((step) => !withheld.has(step.satisfierId)),
      conflicts: this.conflicts,
      withheld: [...withheld],
    };
  }
}

function prerequisiteRank(cell: ConnectionCell): number {
  const borrowed = cell.sharedWith.length > 0 ? 2 : 0;
  const needsFollowup = cell.consentClass === 'none' ? 0 : 1;
  return borrowed + needsFollowup;
}

export function preferredPrerequisite(
  candidates: readonly ConnectionCell[],
): ConnectionCell | undefined {
  let best: ConnectionCell | undefined;
  for (const cell of candidates) {
    if (best === undefined || prerequisiteRank(cell) < prerequisiteRank(best)) best = cell;
  }
  return best;
}

export function planIntents(
  intents: readonly ApplyIntent[] | null | undefined,
  view: ConnectionsView | null | undefined,
): IntentPlan {
  if (!Array.isArray(intents) || intents.length === 0) return EMPTY_PLAN;

  const planner = new Planner(view);
  planner.admit(intents);
  planner.expandPrerequisites();
  planner.checkSharedCopies();
  return planner.finish(planner.order());
}
