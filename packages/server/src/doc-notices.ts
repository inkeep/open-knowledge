import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type DocNoticeWire, DocNoticeWireSchema } from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import { getLocalDir } from './config/paths.ts';
import { docNameToRelativePath } from './doc-extensions.ts';
import { tracedMkdirSync, tracedRenameSync, tracedWriteFileSync } from './fs-traced.ts';
import { getLogger } from './logger.ts';
import { type ShadowHandle, shadowGit } from './shadow-repo.ts';

const log = getLogger('doc-notices');

const DOC_NOTICES_FILENAME = 'doc-notices.json';
const DOC_NOTICES_VERSION = 1;
const MAX_NOTICES = 200;
const MAX_ENTRIES_PER_NOTICE = 8;

type BothKeptNotice = Extract<DocNoticeWire, { kind: 'both-kept' }>;
type MovedNotice = Extract<DocNoticeWire, { kind: 'moved-to-history' }>;

export type DocNoticeEvent =
  | { kind: 'both-kept'; kept: BothKeptNotice['kept'] }
  | {
      kind: 'moved-to-history';
      side: MovedNotice['side'];
      reason: MovedNotice['reason'];
      entry: string;
    };

export interface DocNoticeSink {
  record(docName: string, branch: string, event: DocNoticeEvent): string | null;
  attachEntry(docName: string, id: string, entry: string): void;
}

export interface DocNoticeLedgerOptions {
  projectDir: string;
  contentDir: string;
  getShadow: () => ShadowHandle | null | undefined;
  isReady: () => boolean;
  signal: () => void;
}

const StoredNoticeSchema = z.object({
  branch: z.string().min(1),
  notice: DocNoticeWireSchema,
});
type StoredNotice = z.infer<typeof StoredNoticeSchema>;

const StoredFileSchema = z.object({
  version: z.literal(DOC_NOTICES_VERSION),
  notices: z.array(z.unknown()),
});

function keyOf(branch: string, docName: string): string {
  return `${branch}\u0000${docName}`;
}

function isNoticeDoc(docName: string): boolean {
  return !isSystemDoc(docName) && !isConfigDoc(docName);
}

export function docNoticesPath(projectDir: string): string {
  return join(getLocalDir(projectDir), DOC_NOTICES_FILENAME);
}

export class DocNoticeLedger implements DocNoticeSink {
  private readonly options: DocNoticeLedgerOptions;
  private readonly storePath: string;
  private readonly byKey = new Map<string, StoredNotice>();

  constructor(options: DocNoticeLedgerOptions) {
    this.options = options;
    this.storePath = docNoticesPath(options.projectDir);
    this.load();
  }

  record(docName: string, branch: string, event: DocNoticeEvent): string | null {
    if (!isNoticeDoc(docName)) return null;
    const key = keyOf(branch, docName);
    const existing = this.byKey.get(key)?.notice;
    const at = new Date().toISOString();
    const entry = event.kind === 'moved-to-history' ? event.entry : undefined;
    const common = {
      id: existing?.id ?? randomUUID(),
      docName,
      file: docNameToRelativePath(docName),
      firstAt: existing?.firstAt ?? at,
      lastAt: at,
      events: (existing?.events ?? 0) + 1,
      entries: [...(existing?.entries ?? []), ...(entry === undefined ? [] : [entry])].slice(
        -MAX_ENTRIES_PER_NOTICE,
      ),
    };
    const notice: DocNoticeWire =
      event.kind === 'both-kept'
        ? { ...common, kind: 'both-kept', kept: event.kept }
        : { ...common, kind: 'moved-to-history', side: event.side, reason: event.reason };
    this.byKey.delete(key);
    this.byKey.set(key, { branch, notice });
    for (const oldest of this.byKey.keys()) {
      if (this.byKey.size <= MAX_NOTICES) break;
      this.byKey.delete(oldest);
    }
    log.info(
      { docName, branch, kind: notice.kind, events: notice.events },
      `[doc-notices] notice ${notice.events === 1 ? 'raised' : 'updated'} (${notice.kind}): ${docName}`,
    );
    this.commit();
    return notice.id;
  }

  attachEntry(docName: string, id: string, entry: string): void {
    for (const [key, stored] of this.byKey) {
      if (stored.notice.docName !== docName || stored.notice.id !== id) continue;
      if (stored.notice.entries.includes(entry)) return;
      const entries = [...stored.notice.entries, entry].slice(-MAX_ENTRIES_PER_NOTICE);
      this.byKey.set(key, { ...stored, notice: { ...stored.notice, entries } });
      this.commit();
      return;
    }
  }

  async list(branch: string): Promise<DocNoticeWire[]> {
    if (this.options.isReady()) await this.withdrawStale(branch);
    return [...this.byKey.values()]
      .filter((stored) => stored.branch === branch)
      .map((stored) => stored.notice)
      .reverse();
  }

  private async withdrawStale(branch: string): Promise<void> {
    const onBranch = [...this.byKey].filter(([, stored]) => stored.branch === branch);
    const gone = onBranch.filter(([, stored]) => !this.fileExists(stored.notice.file));
    const left = await this.versionsLeftHistory(
      branch,
      onBranch.filter(([key]) => !gone.some(([goneKey]) => goneKey === key)),
    );
    const removed = [...gone, ...left].filter(([key, stored]) => this.byKey.get(key) === stored);
    for (const [key, stored] of removed) {
      this.byKey.delete(key);
      log.info(
        { docName: stored.notice.docName, branch },
        `[doc-notices] notice withdrawn: ${stored.notice.docName}`,
      );
    }
    if (removed.length > 0) this.commit();
  }

  dismiss(docName: string, id: string): boolean {
    if (!isNoticeDoc(docName)) return false;
    for (const [key, stored] of this.byKey) {
      if (stored.notice.docName !== docName || stored.notice.id !== id) continue;
      this.byKey.delete(key);
      log.info({ docName }, `[doc-notices] notice dismissed: ${docName}`);
      this.commit();
      return true;
    }
    return false;
  }

  private fileExists(file: string): boolean {
    return existsSync(join(this.options.contentDir, file));
  }

  private async versionsLeftHistory(
    branch: string,
    candidates: ReadonlyArray<[string, StoredNotice]>,
  ): Promise<Array<[string, StoredNotice]>> {
    const moved = candidates.filter(
      ([, stored]) => stored.notice.kind === 'moved-to-history' && stored.notice.entries.length > 0,
    );
    if (moved.length === 0) return [];
    const shadow = this.options.getShadow();
    if (!shadow) return [];
    let inHistory: Set<string>;
    try {
      const listing = await shadowGit(shadow).raw(
        'for-each-ref',
        '--format=%(objectname)',
        `refs/checkpoints/${branch}/`,
      );
      inHistory = new Set(listing.split('\n').filter((line) => line.length > 0));
    } catch (err) {
      log.warn({ err, branch }, '[doc-notices] could not list history entries; notices kept');
      return [];
    }
    return moved.filter(([, stored]) =>
      stored.notice.entries.every((entry) => !inHistory.has(entry)),
    );
  }

  private load(): void {
    if (!existsSync(this.storePath)) return;
    let file: z.infer<typeof StoredFileSchema>;
    try {
      const parsed = StoredFileSchema.safeParse(JSON.parse(readFileSync(this.storePath, 'utf-8')));
      if (!parsed.success) {
        log.warn({ path: this.storePath }, '[doc-notices] unrecognized notice file; dropped');
        return;
      }
      file = parsed.data;
    } catch (err) {
      log.warn({ err, path: this.storePath }, '[doc-notices] unreadable notice file; dropped');
      return;
    }
    for (const row of file.notices) {
      const stored = StoredNoticeSchema.safeParse(row);
      if (!stored.success || !isNoticeDoc(stored.data.notice.docName)) continue;
      this.byKey.set(keyOf(stored.data.branch, stored.data.notice.docName), stored.data);
    }
  }

  private commit(): void {
    const tmpPath = `${this.storePath}.tmp`;
    try {
      tracedMkdirSync(dirname(this.storePath), { recursive: true });
      tracedWriteFileSync(
        tmpPath,
        JSON.stringify({ version: DOC_NOTICES_VERSION, notices: [...this.byKey.values()] }),
        'utf-8',
      );
      tracedRenameSync(tmpPath, this.storePath);
    } catch (err) {
      log.error({ err }, '[doc-notices] failed to write the notice file; notices kept in memory');
    }
    this.options.signal();
  }
}
