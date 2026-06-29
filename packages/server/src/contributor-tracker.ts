interface ActorMetadata {
  principalId?: string;
  agentType?: string;
  clientName?: string;
  clientVersion?: string;
  label?: string;
}

export interface ContributorEntry {
  writerId: string;
  displayName: string;
  colorSeed: string;
  docs: Set<string>;
  subjectOverride?: string;
  actor?: ActorMetadata;
  summaries: string[];
  previousPaths: Array<{ from: string; to: string }>;
}

let pendingContributors = new Map<string, ContributorEntry>();

export function recordContributor(
  docName: string,
  writerId: string,
  displayName: string,
  colorSeed?: string,
  subjectOverride?: string,
  actor?: ActorMetadata,
  summary?: string,
  previousPaths?: Array<{ from: string; to: string }>,
): void {
  let entry = pendingContributors.get(writerId);
  if (!entry) {
    entry = {
      writerId,
      displayName,
      colorSeed: colorSeed ?? displayName,
      docs: new Set(),
      subjectOverride,
      actor,
      summaries: [],
      previousPaths: [],
    };
    pendingContributors.set(writerId, entry);
  }
  entry.docs.add(docName);
  if (subjectOverride !== undefined) {
    entry.subjectOverride = subjectOverride;
  }
  if (actor !== undefined) {
    const merged: ActorMetadata = entry.actor ?? {};
    if (actor.principalId !== undefined) merged.principalId = actor.principalId;
    if (actor.agentType !== undefined) merged.agentType = actor.agentType;
    if (actor.clientName !== undefined) merged.clientName = actor.clientName;
    if (actor.clientVersion !== undefined) merged.clientVersion = actor.clientVersion;
    if (actor.label !== undefined) merged.label = actor.label;
    entry.actor = merged;
  }
  if (typeof summary === 'string' && summary.length > 0) {
    entry.summaries.push(summary);
  }
  if (previousPaths && previousPaths.length > 0) {
    for (const pair of previousPaths) entry.previousPaths.push(pair);
  }
}

export function swapContributors(): Map<string, ContributorEntry> {
  const snapshot = pendingContributors;
  pendingContributors = new Map();
  return snapshot;
}

export function restoreContributors(snapshot: Map<string, ContributorEntry>): void {
  for (const [writerId, entry] of snapshot) {
    let live = pendingContributors.get(writerId);
    if (!live) {
      live = {
        writerId,
        displayName: entry.displayName,
        colorSeed: entry.colorSeed,
        docs: new Set(),
        actor: entry.actor,
        summaries: [],
        previousPaths: [],
      };
      pendingContributors.set(writerId, live);
    }
    for (const doc of entry.docs) live.docs.add(doc);
    if (entry.summaries.length > 0) {
      live.summaries = [...entry.summaries, ...live.summaries];
    }
    if (entry.previousPaths.length > 0) {
      live.previousPaths = [...entry.previousPaths, ...live.previousPaths];
    }
  }
}

export function formatContributorsFrom(snapshot: Map<string, ContributorEntry>): string {
  if (snapshot.size === 0) return '';
  const lines: string[] = [''];
  for (const entry of snapshot.values()) {
    const payload: {
      v: 1;
      id: string;
      name: string;
      colorSeed: string;
      docs: string[];
      summaries?: string[];
    } = {
      v: 1,
      id: entry.writerId,
      name: entry.displayName,
      colorSeed: entry.colorSeed,
      docs: [...entry.docs],
    };
    if (entry.summaries.length > 0) payload.summaries = [...entry.summaries];
    lines.push(`ok-contributors: ${JSON.stringify(payload)}`);
  }
  return lines.join('\n');
}

export function __resetContributorsForTests(): void {
  swapContributors();
}

export function __formatContributorsForTests(): string {
  const snapshot = swapContributors();
  const formatted = formatContributorsFrom(snapshot);
  restoreContributors(snapshot);
  return formatted;
}

export function formatContributors(): string {
  return formatContributorsFrom(pendingContributors);
}

export function restoreContributorEntry(writerId: string, entry: ContributorEntry): void {
  let live = pendingContributors.get(writerId);
  if (!live) {
    live = {
      writerId,
      displayName: entry.displayName,
      colorSeed: entry.colorSeed,
      docs: new Set(),
      actor: entry.actor,
      summaries: [],
      previousPaths: [],
    };
    pendingContributors.set(writerId, live);
  }
  for (const doc of entry.docs) live.docs.add(doc);
  if (entry.summaries.length > 0) {
    live.summaries = [...entry.summaries, ...live.summaries];
  }
  if (entry.previousPaths.length > 0) {
    live.previousPaths = [...entry.previousPaths, ...live.previousPaths];
  }
}

export function clearContributors(): void {
  pendingContributors.clear();
}

export function contributorCount(): number {
  return pendingContributors.size;
}

export function hasContributor(writerId: string): boolean {
  return pendingContributors.has(writerId);
}
