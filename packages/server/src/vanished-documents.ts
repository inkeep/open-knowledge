import { contentHash } from './version-hash.ts';

const EMPTY_CONTENT_HASH = contentHash('');

export const RECENT_CREATE_WINDOW_MS = 10_000;
export const VANISH_RECHECK_DELAY_MS = 1_000;

export const VANISH_OVERDUE_FAULT_LIMIT = 3;
export const VANISH_HOLD_LIMIT_MS = 30_000;
const RECENT_CREATE_LIMIT = 256;
const SHARED_LINE_FRACTION = 0.5;

interface FileFacts {
  readonly identity: string | undefined;
  readonly size: number | undefined;
  readonly modified: string | undefined;
}

export interface VanishedDocument extends FileFacts {
  readonly docName: string;
  readonly path: string;
  readonly hashes: ReadonlySet<string>;
  readonly text: string | undefined;
  readonly afterPass: number;
  readonly heldAt: number;
}

export interface RecentCreate extends FileFacts {
  readonly docName: string;
  readonly path: string;
  readonly hash: string;
  readonly at: number;
}

export interface CreateCandidate extends FileFacts {
  readonly docName: string;
  readonly hash: string;
  readonly content: string;
}

export type VanishPairing = 'same-name' | 'identity' | 'hash';
export type RecentCreatePairing = Exclude<VanishPairing, 'same-name'>;

function uniqueByHash<T>(entries: readonly T[], hasHash: (entry: T) => boolean): T | undefined {
  const found = entries.filter(hasHash);
  return found.length === 1 ? found[0] : undefined;
}

function nonBlankLines(text: string): Set<string> {
  const lines = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') lines.add(trimmed);
  }
  return lines;
}

export function sharesMostLines(left: string, right: string): boolean {
  const a = nonBlankLines(left);
  const b = nonBlankLines(right);
  let shared = 0;
  for (const line of a) if (b.has(line)) shared++;
  return shared > 0 && shared >= Math.max(a.size, b.size) * SHARED_LINE_FRACTION;
}

function unchangedFile(vanished: FileFacts, created: FileFacts): boolean {
  return (
    vanished.size !== undefined &&
    vanished.modified !== undefined &&
    created.size === vanished.size &&
    created.modified === vanished.modified
  );
}

function corroboratesIdentity(
  vanished: Pick<VanishedDocument, 'identity' | 'size' | 'modified' | 'text'>,
  created: FileFacts,
  content: string | undefined,
): boolean {
  if (vanished.identity === undefined || created.identity !== vanished.identity) return false;
  if (unchangedFile(vanished, created)) return true;
  return (
    vanished.text !== undefined && content !== undefined && sharesMostLines(vanished.text, content)
  );
}

export class VanishedDocuments {
  private readonly pending = new Map<string, VanishedDocument>();
  private readonly recentCreates = new Map<string, RecentCreate>();

  get size(): number {
    return this.pending.size;
  }

  hold(entry: VanishedDocument): void {
    this.pending.set(entry.docName, entry);
  }

  has(docName: string): boolean {
    return this.pending.has(docName);
  }

  release(docName: string): VanishedDocument | undefined {
    const entry = this.pending.get(docName);
    this.pending.delete(docName);
    return entry;
  }

  all(): VanishedDocument[] {
    return [...this.pending.values()];
  }

  matchCreate(
    candidate: CreateCandidate,
  ): { readonly vanished: VanishedDocument; readonly by: VanishPairing } | undefined {
    const sameName = this.pending.get(candidate.docName);
    if (sameName) return { vanished: sameName, by: 'same-name' };
    for (const entry of this.pending.values()) {
      if (corroboratesIdentity(entry, candidate, candidate.content)) {
        return { vanished: entry, by: 'identity' };
      }
    }
    if (candidate.hash === EMPTY_CONTENT_HASH) return undefined;
    const byHash = uniqueByHash([...this.pending.values()], (entry) =>
      entry.hashes.has(candidate.hash),
    );
    return byHash ? { vanished: byHash, by: 'hash' } : undefined;
  }

  dueAfter(pass: number): VanishedDocument[] {
    return this.all().filter((entry) => entry.afterPass < pass);
  }

  heldBefore(cutoff: number): VanishedDocument[] {
    return this.all().filter((entry) => entry.heldAt <= cutoff);
  }

  rememberCreate(create: RecentCreate): void {
    this.forgetCreatesBefore(create.at - RECENT_CREATE_WINDOW_MS);
    this.recentCreates.delete(create.docName);
    this.recentCreates.set(create.docName, create);
    for (const docName of this.recentCreates.keys()) {
      if (this.recentCreates.size <= RECENT_CREATE_LIMIT) break;
      this.recentCreates.delete(docName);
    }
  }

  private forgetCreatesBefore(cutoff: number): void {
    for (const [docName, create] of this.recentCreates) {
      if (create.at < cutoff) this.recentCreates.delete(docName);
    }
  }

  matchRecentCreate(
    vanished: Pick<
      VanishedDocument,
      'docName' | 'identity' | 'hashes' | 'size' | 'modified' | 'text'
    >,
    now: number,
    readContent: (create: RecentCreate) => string | undefined,
  ): { readonly create: RecentCreate; readonly by: RecentCreatePairing } | undefined {
    this.forgetCreatesBefore(now - RECENT_CREATE_WINDOW_MS);
    const candidates = [...this.recentCreates.values()].filter(
      (create) => create.docName !== vanished.docName,
    );
    let found: { create: RecentCreate; by: RecentCreatePairing } | undefined;
    for (const create of candidates) {
      if (vanished.identity === undefined || create.identity !== vanished.identity) continue;
      const content = unchangedFile(vanished, create) ? undefined : readContent(create);
      if (corroboratesIdentity(vanished, create, content)) {
        found = { create, by: 'identity' };
        break;
      }
    }
    if (!found) {
      const byHash = uniqueByHash(
        candidates.filter((create) => create.hash !== EMPTY_CONTENT_HASH),
        (create) => vanished.hashes.has(create.hash),
      );
      if (byHash) found = { create: byHash, by: 'hash' };
    }
    if (found) this.recentCreates.delete(found.create.docName);
    return found;
  }

  clear(): void {
    this.pending.clear();
    this.recentCreates.clear();
  }
}
