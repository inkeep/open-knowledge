import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { type DocNoticeWire, DocNoticeWireSchema } from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { isSystemDoc } from './cc1-broadcast.ts';
import { getLocalDir } from './config/paths.ts';
import { docNameToRelativePath } from './doc-extensions.ts';
import { tracedMkdirSync, tracedRenameSync, tracedWriteFileSync } from './fs-traced.ts';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';
import { type ShadowHandle, shadowGit } from './shadow-repo.ts';

const log = getLogger('doc-notices');

const DOC_NOTICES_FILENAME = 'doc-notices.json';
const DOC_NOTICES_VERSION = 1;
const MAX_NOTICES = 200;
export const NOTICE_WITHDRAW_AFTER_MS = 10_000;
const MAX_ENTRIES_PER_NOTICE = 8;

type BothKeptNotice = Extract<DocNoticeWire, { kind: 'both-kept' }>;
type MovedNotice = Extract<DocNoticeWire, { kind: 'moved-to-history' }>;
type HeldNotice = Extract<DocNoticeWire, { kind: 'save-held' }>;

export type MoveReason = MovedNotice['reason'];

export type DocNoticeEvent =
  | { kind: 'both-kept'; kept: BothKeptNotice['kept'] }
  | {
      kind: 'moved-to-history';
      side: MovedNotice['side'];
      reason: MoveReason;
      entry: string;
    }
  | {
      kind: 'moved-to-backup';
      side: MovedNotice['side'];
      reason: MoveReason;
      backup: string;
    }
  | { kind: 'save-held'; cause: HeldNotice['cause'] };

export interface DocNoticeSink {
  record(docName: string, branch: string, event: DocNoticeEvent): string | null;
  attachEntry(docName: string, id: string, entry: string): void;
  withdrawHeld(docName: string, branch: string): void;
}

export interface NoticeFile {
  readonly abs: string;
  readonly display: string;
}

export interface DocNoticeLedgerOptions {
  projectDir: string;
  contentDir: string;
  getShadow: () => ShadowHandle | null | undefined;
  isReady: () => boolean;
  signal: () => void;
  isHeld?: (docName: string) => boolean;
  isSaveHeld?: (docName: string) => boolean;
  now?: () => number;
  resolveFile?: (docName: string) => NoticeFile | null;
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

type NoticeSlot = 'kept' | 'held';

const NOTICE_SLOTS: readonly NoticeSlot[] = ['kept', 'held'];

function slotOf(kind: DocNoticeWire['kind']): NoticeSlot {
  return kind === 'save-held' ? 'held' : 'kept';
}

function keyOf(branch: string, docName: string, slot: NoticeSlot): string {
  return `${branch}\u0000${docName}\u0000${slot}`;
}

function isNoticeDoc(docName: string): boolean {
  return !isSystemDoc(docName);
}

export function docNoticesPath(projectDir: string): string {
  return join(getLocalDir(projectDir), DOC_NOTICES_FILENAME);
}

type NoticeCommon = Pick<
  DocNoticeWire,
  'id' | 'docName' | 'file' | 'firstAt' | 'lastAt' | 'events' | 'entries'
>;

function noticeOf(common: NoticeCommon, event: DocNoticeEvent): DocNoticeWire {
  switch (event.kind) {
    case 'both-kept':
      return { ...common, kind: 'both-kept', kept: event.kept };
    case 'moved-to-history':
      return { ...common, kind: 'moved-to-history', side: event.side, reason: event.reason };
    case 'moved-to-backup':
      return {
        ...common,
        kind: 'moved-to-backup',
        side: event.side,
        reason: event.reason,
        backup: event.backup,
      };
    case 'save-held':
      return { ...common, kind: 'save-held', cause: event.cause };
    default:
      return assertNeverNoticeEvent(event);
  }
}

function assertNeverNoticeEvent(event: never): never {
  throw new Error(`unhandled notice event: ${JSON.stringify(event)}`);
}

export class DocNoticeLedger implements DocNoticeSink {
  private readonly options: DocNoticeLedgerOptions;
  private readonly storePath: string;
  private readonly byKey = new Map<string, StoredNotice>();
  private readonly missingSince = new Map<string, number>();

  constructor(options: DocNoticeLedgerOptions) {
    this.options = options;
    this.storePath = docNoticesPath(options.projectDir);
    this.load();
  }

  record(docName: string, branch: string, event: DocNoticeEvent): string | null {
    if (!isNoticeDoc(docName)) return null;
    const key = keyOf(branch, docName, slotOf(event.kind));
    const existing = this.byKey.get(key)?.notice;
    if (
      event.kind === 'save-held' &&
      existing?.kind === 'save-held' &&
      existing.cause === event.cause
    ) {
      return existing.id;
    }
    const at = new Date().toISOString();
    const entry = event.kind === 'moved-to-history' ? event.entry : undefined;
    const common = {
      id: existing?.id ?? randomUUID(),
      docName,
      file: this.options.resolveFile?.(docName)?.display ?? docNameToRelativePath(docName),
      firstAt: existing?.firstAt ?? at,
      lastAt: at,
      events: (existing?.events ?? 0) + 1,
      entries: [...(existing?.entries ?? []), ...(entry === undefined ? [] : [entry])].slice(
        -MAX_ENTRIES_PER_NOTICE,
      ),
    };
    const notice = noticeOf(common, event);
    this.byKey.delete(key);
    this.missingSince.delete(key);
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

  withdrawHeld(docName: string, branch: string): void {
    const key = keyOf(branch, docName, 'held');
    if (!this.byKey.has(key)) return;
    this.byKey.delete(key);
    this.missingSince.delete(key);
    log.info({ docName, branch }, `[doc-notices] held-save notice withdrawn: ${docName}`);
    this.commit();
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

  rename(oldDocName: string, newDocName: string, branch: string, newFile?: string): void {
    if (!isNoticeDoc(oldDocName) || !isNoticeDoc(newDocName)) return;
    let moved = false;
    for (const slot of NOTICE_SLOTS) {
      const oldKey = keyOf(branch, oldDocName, slot);
      const stored = this.byKey.get(oldKey);
      if (!stored) continue;
      moved = true;
      this.byKey.delete(oldKey);
      this.missingSince.delete(oldKey);
      const newKey = keyOf(branch, newDocName, slot);
      this.byKey.delete(newKey);
      this.missingSince.delete(newKey);
      this.byKey.set(newKey, {
        branch,
        notice: {
          ...stored.notice,
          docName: newDocName,
          file: newFile ?? `${newDocName}${extname(stored.notice.file)}`,
        },
      });
    }
    if (!moved) return;
    log.info(
      { docName: newDocName, from: oldDocName, branch },
      `[doc-notices] notice followed a rename: ${oldDocName} -> ${newDocName}`,
    );
    this.commit();
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
    const gone: Array<[string, StoredNotice]> = [];
    const now = this.options.now?.() ?? Date.now();
    for (const [key, stored] of onBranch) {
      if (
        stored.notice.kind === 'save-held' &&
        this.options.isSaveHeld?.(stored.notice.docName) === false
      ) {
        gone.push([key, stored]);
        continue;
      }
      const presence = this.filePresence(stored.notice.docName, stored.notice.file);
      if (presence === 'present' || this.options.isHeld?.(stored.notice.docName) === true) {
        this.missingSince.delete(key);
      } else if (presence === 'missing') {
        const since = this.missingSince.get(key);
        if (since === undefined) this.missingSince.set(key, now);
        else if (now - since >= NOTICE_WITHDRAW_AFTER_MS) gone.push([key, stored]);
      }
    }
    const left = await this.versionsLeftHistory(
      branch,
      onBranch.filter(([key]) => !gone.some(([goneKey]) => goneKey === key)),
    );
    const removed = [...gone, ...left].filter(([key, stored]) => this.byKey.get(key) === stored);
    for (const [key, stored] of removed) {
      this.byKey.delete(key);
      this.missingSince.delete(key);
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
      this.missingSince.delete(key);
      log.info({ docName }, `[doc-notices] notice dismissed: ${docName}`);
      this.commit();
      return true;
    }
    return false;
  }

  private filePresence(docName: string, file: string): 'present' | 'missing' | 'unknown' {
    const abs = this.options.resolveFile?.(docName)?.abs ?? join(this.options.contentDir, file);
    try {
      statSync(abs);
      return 'present';
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
      log.warn({ err, code }, '[doc-notices] could not check a notice file; notice kept');
      return 'unknown';
    }
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
      this.byKey.set(
        keyOf(stored.data.branch, stored.data.notice.docName, slotOf(stored.data.notice.kind)),
        stored.data,
      );
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
