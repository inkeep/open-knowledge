import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import {
  addConfigSpanEvent,
  CONFIG_DOC_NAME_OKIGNORE,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  type ConfigIssue,
  ConfigSchema,
  type ConfigValidationError,
  isKnownConfigError,
  type WriteScope,
  withConfigSpan,
  withConfigSpanSync,
} from '@inkeep/open-knowledge-core';
import {
  atomicTempPath,
  FileLockTimeoutError,
  resolveConfigPath,
  withFileLock,
} from '@inkeep/open-knowledge-core/server';
import type { Counter } from '@opentelemetry/api';
import { parseDocument, stringify } from 'yaml';
import type * as Y from 'yjs';
import {
  CONFIG_FILE_WATCHER_ORIGIN,
  CONFIG_VALIDATION_REVERT_ORIGIN,
} from './config-edit-origin.ts';
import type { FileObservation } from './disk-receipts.ts';
import { tracedMkdir, tracedRename, tracedUnlinkSync, tracedWriteFile } from './fs-traced.ts';
import { getLogger } from './logger.ts';
import { type KeptCopy, keepNoEngineVersion, type MergeHistoryRecorder } from './merge-history.ts';
import { incrementConfigOutsideChange, incrementStoreRestatRefused } from './metrics.ts';
import { heldFor, heldNotUtf8, type SaveHold } from './save-hold.ts';
import {
  readObservedText,
  restatFile,
  StoreRestatFailedError,
  StoreRestatRefusedError,
} from './store-compare.ts';
import { getMeter } from './telemetry.ts';

const log = getLogger('config-persistence');

function configScopeAttr(documentName: string): WriteScope | undefined {
  if (documentName === CONFIG_DOC_NAME_PROJECT) return 'project';
  if (documentName === CONFIG_DOC_NAME_PROJECT_LOCAL) return 'project-local';
  if (documentName === CONFIG_DOC_NAME_USER) return 'user';
  if (documentName === CONFIG_DOC_NAME_OKIGNORE) return 'project';
  return undefined;
}

let _okignoreRejectionCounter: Counter | null = null;
function okignoreRejectionCounter(): Counter {
  _okignoreRejectionCounter ||= getMeter().createCounter('ok.config.ignore.rejection_total', {
    description: 'Count of okignore L3 rejections by error code.',
  });
  return _okignoreRejectionCounter;
}

export function __resetOkignoreTelemetryForTests(): void {
  _okignoreRejectionCounter = null;
}

function emitSchemaInvalidIssueEvents(error: ConfigValidationError): void {
  if (!isKnownConfigError(error)) return;
  if (error.code !== 'SCHEMA_INVALID') return;
  for (const issue of error.issues as ConfigIssue[]) {
    addConfigSpanEvent('config.validation.issue', {
      'issue.path': issue.path.map((p) => String(p)).join('.'),
      'issue.message': issue.message,
    });
  }
}

export interface ConfigPersistenceCtx {
  projectDir: string;
  contentDir?: string;
  lkgCache: Map<string, string>;
  homedirOverride?: string;
  onConfigRejected?: (docName: string, error: ConfigValidationError) => void;
  ephemeral?: boolean;
  agreedDisk: Map<string, string>;
  history: Pick<MergeHistoryRecorder, 'saveNoEngine' | 'noticeNoEngine'> | null;
}

const MAX_CONFIG_ROUNDS = 3;

function keepConfigVersion(
  documentName: string,
  side: 'ours' | 'theirs',
  bytes: string,
  ctx: ConfigPersistenceCtx,
): Promise<KeptCopy | null> {
  return keepNoEngineVersion(
    ctx.history,
    ctx.homedirOverride ?? homedir(),
    ctx.contentDir ?? ctx.projectDir,
    documentName,
    { side, bytes },
    'config',
    basename(configDocAbsPath(documentName, ctx)),
  );
}

function agreedOf(documentName: string, ctx: ConfigPersistenceCtx): string | undefined {
  return ctx.agreedDisk.get(documentName) ?? ctx.lkgCache.get(documentName);
}

function agreeWithDisk(documentName: string, content: string, ctx: ConfigPersistenceCtx): void {
  ctx.lkgCache.set(documentName, content);
  ctx.agreedDisk.set(documentName, content);
}

function holdsUnsavedEdit(
  documentName: string,
  live: string,
  outside: string,
  ctx: ConfigPersistenceCtx,
): boolean {
  if (live.length === 0 && documentName !== CONFIG_DOC_NAME_OKIGNORE) return false;
  return (
    live !== outside &&
    live !== agreedOf(documentName, ctx) &&
    live !== ctx.lkgCache.get(documentName)
  );
}

async function saveDisplacedEdits(
  document: Y.Doc,
  documentName: string,
  outside: string,
  ctx: ConfigPersistenceCtx,
): Promise<KeptCopy[] | 'held' | 'deferred'> {
  const ytext = document.getText('source');
  const copies: KeptCopy[] = [];
  for (let attempt = 0; attempt < MAX_CONFIG_ROUNDS; attempt++) {
    const live = ytext.toString();
    if (!holdsUnsavedEdit(documentName, live, outside, ctx)) return copies;
    const copy = await keepConfigVersion(documentName, 'ours', live, ctx);
    if (copy === null) return 'held';
    copies.push(copy);
    if (ytext.toString() === live) return copies;
  }
  return 'deferred';
}

function noticeDisplacedEdits(
  documentName: string,
  copies: readonly KeptCopy[],
  ctx: ConfigPersistenceCtx,
): void {
  for (const copy of copies) ctx.history?.noticeNoEngine(documentName, 'ours', 'config', copy);
}

function outsideDecoding(
  documentName: string,
  content: string,
  ctx: ConfigPersistenceCtx,
): 'lossless' | 'moved-on' | 'not-utf8' {
  if (!content.includes('\uFFFD')) return 'lossless';
  const read = readObservedText(configDocAbsPath(documentName, ctx));
  if (read.kind !== 'read' || read.text !== content) return 'moved-on';
  return read.lossless ? 'lossless' : 'not-utf8';
}

const intakeChains = new WeakMap<Map<string, string>, Map<string, Promise<unknown>>>();

function replaceLiveConfig(document: Y.Doc, content: string): void {
  const ytext = document.getText('source');
  document.transact(() => {
    if (ytext.length > 0) ytext.delete(0, ytext.length);
    ytext.insert(0, content);
  }, CONFIG_FILE_WATCHER_ORIGIN);
}

export function configDocAbsPath(documentName: string, ctx: ConfigPersistenceCtx): string {
  if (documentName === CONFIG_DOC_NAME_PROJECT) {
    return resolveConfigPath('project', ctx.projectDir, ctx.homedirOverride);
  }
  if (documentName === CONFIG_DOC_NAME_PROJECT_LOCAL) {
    return resolveConfigPath('project-local', ctx.projectDir, ctx.homedirOverride);
  }
  if (documentName === CONFIG_DOC_NAME_USER) {
    return resolveConfigPath('user', ctx.projectDir, ctx.homedirOverride);
  }
  if (documentName === CONFIG_DOC_NAME_OKIGNORE) {
    return resolve(ctx.contentDir ?? ctx.projectDir, '.okignore');
  }
  throw new Error(`configDocAbsPath: not a config doc name: ${documentName}`);
}

let cachedDefaultsYaml: string | null = null;
function serializedDefaults(): string {
  if (cachedDefaultsYaml === null) {
    cachedDefaultsYaml = stringify(ConfigSchema.parse({}));
  }
  return cachedDefaultsYaml;
}

interface ValidConfig {
  readonly ok: true;
}
interface InvalidConfig {
  readonly ok: false;
  readonly error: ConfigValidationError;
}

function validateOkignore(content: string): ValidConfig | InvalidConfig {
  if (content.length === 0) return { ok: true };
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.length === 0) continue;
    if (/^\s+$/.test(line)) {
      return {
        ok: false,
        error: {
          code: 'OKIGNORE_INVALID',
          detail: 'Whitespace-only pattern is not allowed.',
          lineNumber: i + 1,
        },
      };
    }
  }
  return { ok: true };
}

function validateConfigContent(documentName: string, content: string): ValidConfig | InvalidConfig {
  if (documentName === CONFIG_DOC_NAME_OKIGNORE) {
    return validateOkignore(content);
  }
  return validateConfigYaml(content);
}

function defaultLkgFor(documentName: string): string {
  if (documentName === CONFIG_DOC_NAME_OKIGNORE) return '';
  return serializedDefaults();
}

function validateConfigYaml(content: string): ValidConfig | InvalidConfig {
  const parsed = parseDocument(content);
  if (parsed.errors.length > 0) {
    return {
      ok: false,
      error: {
        code: 'YAML_PARSE',
        detail: parsed.errors.map((e) => e.message).join('; '),
      },
    };
  }
  const merged = parsed.toJSON() ?? {};
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: 'SCHEMA_INVALID',
        issues: result.error.issues.map((iss) => ({
          path: iss.path.map((seg) =>
            typeof seg === 'symbol' ? String(seg) : (seg as string | number),
          ),
          message: iss.message,
          issueCode: iss.code,
        })),
      },
    };
  }
  return { ok: true };
}

export function loadConfigDoc(
  document: Y.Doc,
  documentName: string,
  ctx: ConfigPersistenceCtx,
): void {
  const ytext = document.getText('source');
  if (ytext.length > 0) return;

  const filePath = configDocAbsPath(documentName, ctx);
  let raw = '';
  if (existsSync(filePath)) {
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log.warn(
        { path: filePath, err: e },
        `[config-persistence] Could not read ${filePath}: ${detail}. Seeding with empty content.`,
      );
      raw = '';
    }
  }

  const validation = validateConfigContent(documentName, raw);
  if (!validation.ok && raw.length > 0) {
    log.warn(
      { docName: documentName, path: filePath },
      `[config-persistence] loadConfigDoc seeding invalid content for ${documentName} into Y.Text — first mutation will revert to LKG`,
    );
  }

  document.transact(() => {
    if (raw.length > 0) ytext.insert(0, raw);
  }, CONFIG_VALIDATION_REVERT_ORIGIN);

  if (validation.ok && raw.length > 0) {
    ctx.lkgCache.set(documentName, raw);
  } else {
    ctx.lkgCache.set(documentName, defaultLkgFor(documentName));
  }
  ctx.agreedDisk.set(documentName, raw);
}

async function atomicWriteConfig(
  absPath: string,
  content: string,
  observation: FileObservation | null,
): Promise<void> {
  await tracedMkdir(dirname(absPath), { recursive: true });
  const tmpPath = atomicTempPath(absPath);
  try {
    await tracedWriteFile(tmpPath, content, 'utf-8');
    const restat = restatFile(absPath, observation);
    if (restat.kind === 'failed') throw new StoreRestatFailedError(absPath, restat.error);
    if (restat.kind === 'moved') throw new StoreRestatRefusedError(absPath);
    await tracedRename(tmpPath, absPath);
  } catch (e) {
    try {
      tracedUnlinkSync(tmpPath);
    } catch {}
    throw e;
  }
}

export type StoreConfigDocOutcome =
  | 'persisted'
  | 'reverted'
  | 'write-failed'
  | 'no-op'
  | 'reconciled'
  | SaveHold;

export async function storeConfigDoc(
  document: Y.Doc,
  documentName: string,
  lastTransactionOrigin: unknown,
  ctx: ConfigPersistenceCtx,
): Promise<StoreConfigDocOutcome> {
  return withConfigSpan(
    'config.persist',
    { 'config.scope': configScopeAttr(documentName), 'config.transport': 'fs' },
    async (span) => {
      const outcome = await storeConfigDocInner(document, documentName, lastTransactionOrigin, ctx);
      span.setAttribute('config.outcome', persistOutcomeAttr(outcome));
      return outcome;
    },
  );
}

function persistOutcomeAttr(outcome: StoreConfigDocOutcome): 'success' | 'reverted' | 'rejected' {
  if (outcome === 'reverted') return 'reverted';
  if (outcome === 'write-failed' || typeof outcome === 'object') return 'rejected';
  return 'success';
}

async function storeConfigDocInner(
  document: Y.Doc,
  documentName: string,
  lastTransactionOrigin: unknown,
  ctx: ConfigPersistenceCtx,
): Promise<StoreConfigDocOutcome> {
  if (ctx.ephemeral && documentName === CONFIG_DOC_NAME_OKIGNORE) return 'no-op';
  if (lastTransactionOrigin === CONFIG_VALIDATION_REVERT_ORIGIN) return 'no-op';

  const ytext = document.getText('source');
  const content = ytext.toString();

  const lkg = ctx.lkgCache.get(documentName);

  if (content.length === 0) {
    if (documentName !== CONFIG_DOC_NAME_OKIGNORE) return 'no-op';

    if (lkg === undefined || lkg === '') return 'no-op';
  }

  if (lkg !== undefined && content === lkg) return 'no-op';

  const scope = configScopeAttr(documentName);
  const validation = withConfigSpanSync(
    'config.validate',
    { 'config.scope': scope, 'config.validation.layer': 'L3' },
    (validateSpan) => {
      const r = validateConfigContent(documentName, content);
      validateSpan.setAttribute('config.outcome', r.ok ? 'success' : 'rejected');
      if (!r.ok) emitSchemaInvalidIssueEvents(r.error);
      return r;
    },
  );
  if (!validation.ok) {
    await withConfigSpan(
      'config.revert',
      { 'config.scope': scope, 'config.outcome': 'reverted' },
      async () => {
        const fallbackLkg = lkg ?? defaultLkgFor(documentName);
        document.transact(() => {
          if (ytext.length > 0) ytext.delete(0, ytext.length);
          ytext.insert(0, fallbackLkg);
        }, CONFIG_VALIDATION_REVERT_ORIGIN);
        if (lkg === undefined) {
          ctx.lkgCache.set(documentName, fallbackLkg);
        }
        if (documentName === CONFIG_DOC_NAME_OKIGNORE && isKnownConfigError(validation.error)) {
          okignoreRejectionCounter().add(1, { 'error.code': validation.error.code });
        }
        ctx.onConfigRejected?.(documentName, validation.error);
      },
    );
    return 'reverted';
  }

  const filePath = configDocAbsPath(documentName, ctx);

  try {
    await tracedMkdir(dirname(filePath), { recursive: true });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log.warn(
      { docName: documentName, path: filePath, err: e },
      `[config-persistence] could not create parent dir for ${filePath}: ${detail}`,
    );
    ctx.onConfigRejected?.(documentName, {
      code: 'WRITE_ERROR',
      detail: `Could not create parent directory for ${filePath}: ${detail}`,
    });
    return 'write-failed';
  }

  try {
    return await withFileLock(
      `${filePath}.lock`,
      async () => {
        const writeFailed = (e: unknown, detail: string): StoreConfigDocOutcome => {
          log.warn(
            { docName: documentName, path: filePath, err: e },
            `[config-persistence] write-failed at ${filePath}: ${detail}`,
          );
          ctx.onConfigRejected?.(documentName, {
            code: 'WRITE_ERROR',
            detail: `Failed to persist config at ${filePath}: ${detail}`,
          });
          return 'write-failed';
        };
        const writeOurs = async (
          observation: FileObservation | null,
        ): Promise<'written' | 'moved' | StoreConfigDocOutcome> => {
          try {
            await atomicWriteConfig(filePath, content, observation);
            return 'written';
          } catch (e) {
            if (e instanceof StoreRestatRefusedError) {
              incrementStoreRestatRefused();
              return 'moved';
            }
            return writeFailed(e, e instanceof Error ? e.message : String(e));
          }
        };

        for (let round = 0; round < MAX_CONFIG_ROUNDS; round++) {
          const read = readObservedText(filePath);
          if (read.kind === 'failed') {
            const detail = read.error instanceof Error ? read.error.message : String(read.error);
            log.warn(
              { docName: documentName, path: filePath, err: read.error },
              `[config-persistence] could not read config for reconciliation: ${detail}`,
            );
            ctx.onConfigRejected?.(documentName, {
              code: 'WRITE_ERROR',
              detail: `Could not read config for reconciliation at ${filePath}: ${detail}`,
            });
            return 'write-failed';
          }
          const diskContent = read.kind === 'read' ? read.text : null;
          const agreed = agreedOf(documentName, ctx);

          if (diskContent !== null && agreed !== undefined && diskContent !== agreed) {
            if (read.kind === 'read' && !read.lossless) {
              incrementConfigOutsideChange('store', 'held-not-utf8');
              log.info(
                { docName: documentName, path: filePath },
                '[config-persistence] the file changed outside to bytes that are not valid UTF-8; nothing was applied or written',
              );
              return heldNotUtf8(filePath, read.observation);
            }
            const diskValidation = validateConfigContent(documentName, diskContent);
            if (diskValidation.ok) {
              const displaced = await saveDisplacedEdits(document, documentName, diskContent, ctx);
              if (displaced === 'held') {
                incrementConfigOutsideChange('store', 'held-no-history-or-backup');
                log.warn(
                  { docName: documentName, path: filePath },
                  '[config-persistence] a valid outside version landed but the unsaved edit could not be kept in history or the backup folder; nothing was applied or written',
                );
                return heldFor('no-history-or-backup');
              }
              if (displaced === 'deferred') {
                incrementConfigOutsideChange('store', 'deferred');
                log.warn(
                  { docName: documentName, path: filePath },
                  '[config-persistence] a valid outside version landed while the settings kept changing here; it was not applied, and the edits displaced so far were kept in history or the backup folder',
                );
                return heldFor('edits-changing');
              }
              if (displaced.length > 0) {
                const again = readObservedText(filePath);
                if (again.kind !== 'read' || again.text !== diskContent) continue;
              }
              replaceLiveConfig(document, diskContent);
              agreeWithDisk(documentName, diskContent, ctx);
              noticeDisplacedEdits(documentName, displaced, ctx);
              incrementConfigOutsideChange(
                'store',
                displaced.length > 0 ? 'applied-displaced' : 'applied',
              );
              log.info(
                { docName: documentName, path: filePath },
                '[config-persistence] reconciled: external writer landed; imported disk into Y.Text',
              );
              return 'reconciled';
            }
            const copy = await keepConfigVersion(documentName, 'theirs', diskContent, ctx);
            if (copy === null) {
              incrementConfigOutsideChange('store', 'held-no-history-or-backup');
              log.warn(
                { docName: documentName, path: filePath },
                '[config-persistence] an invalid outside version landed and could not be kept in history or the backup folder; it was not written over',
              );
              return heldFor('no-history-or-backup');
            }
            const again = readObservedText(filePath);
            if (again.kind !== 'read' || again.text !== diskContent) continue;
            const written = await writeOurs(again.observation);
            if (written === 'moved') continue;
            if (written !== 'written') return written;
            agreeWithDisk(documentName, content, ctx);
            ctx.history?.noticeNoEngine(documentName, 'theirs', 'config', copy);
            incrementConfigOutsideChange('store', 'invalid-kept-live');
            log.warn(
              { docName: documentName, path: filePath, keptIn: copy.where },
              '[config-persistence] disk diverged from LKG but contains invalid content; it was kept in history or the backup folder and the local write landed',
            );
            return 'persisted';
          }

          const written = await writeOurs(read.kind === 'read' ? read.observation : null);
          if (written === 'moved') continue;
          if (written !== 'written') return written;
          agreeWithDisk(documentName, content, ctx);
          return 'persisted';
        }
        incrementConfigOutsideChange('store', 'held-exhausted');
        log.warn(
          { docName: documentName, path: filePath, rounds: MAX_CONFIG_ROUNDS },
          '[config-persistence] the file kept changing outside while it was being saved; nothing more was written',
        );
        return heldFor('keeps-changing');
      },
      {
        onWarn: (message, context) => {
          log.warn(context, `[config-persistence] ${message}`);
        },
      },
    );
  } catch (e) {
    if (e instanceof FileLockTimeoutError) {
      log.warn(
        { docName: documentName, path: filePath, err: e },
        `[config-persistence] lock timeout at ${filePath}: ${e.message}`,
      );
      ctx.onConfigRejected?.(documentName, {
        code: 'WRITE_ERROR',
        detail: e.message,
      });
      return 'write-failed';
    }
    throw e;
  }
}

export function resetConfigDocForTest(
  document: Y.Doc | null,
  documentName: string,
  ctx: ConfigPersistenceCtx,
): void {
  try {
    tracedUnlinkSync(configDocAbsPath(documentName, ctx));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  ctx.lkgCache.delete(documentName);
  ctx.agreedDisk.delete(documentName);
  if (document === null) return;
  const ytext = document.getText('source');
  if (ytext.length > 0) {
    document.transact(() => {
      ytext.delete(0, ytext.length);
    }, CONFIG_VALIDATION_REVERT_ORIGIN);
  }
  loadConfigDoc(document, documentName, ctx);
}

type ApplyExternalConfigChangeOutcome = 'applied' | 'rejected' | 'no-op' | 'held';

export function isConfigEcho(
  documentName: string,
  content: string,
  ctx: ConfigPersistenceCtx,
): boolean {
  return ctx.lkgCache.get(documentName) === content || ctx.agreedDisk.get(documentName) === content;
}

export function applyExternalConfigChange(
  document: Y.Doc | null,
  documentName: string,
  content: string,
  ctx: ConfigPersistenceCtx,
): Promise<ApplyExternalConfigChangeOutcome> {
  let chains = intakeChains.get(ctx.lkgCache);
  if (chains === undefined) {
    chains = new Map();
    intakeChains.set(ctx.lkgCache, chains);
  }
  const previous = chains.get(documentName) ?? Promise.resolve();
  const run = previous.then(() => takeInConfigChange(document, documentName, content, ctx));
  const settled = run.catch(() => {});
  chains.set(documentName, settled);
  void settled.then(() => {
    if (chains.get(documentName) === settled) chains.delete(documentName);
  });
  return run;
}

async function takeInConfigChange(
  document: Y.Doc | null,
  documentName: string,
  content: string,
  ctx: ConfigPersistenceCtx,
): Promise<ApplyExternalConfigChangeOutcome> {
  if (!document) return 'no-op';

  if (isConfigEcho(documentName, content, ctx)) return 'no-op';

  const decoded = outsideDecoding(documentName, content, ctx);
  if (decoded === 'moved-on') return 'no-op';
  if (decoded === 'not-utf8') {
    incrementConfigOutsideChange('intake', 'held-not-utf8');
    log.warn(
      { docName: documentName },
      '[config-persistence] the file changed outside to bytes that are not valid UTF-8; nothing was applied',
    );
    return 'held';
  }

  const scope = configScopeAttr(documentName);
  const validation = withConfigSpanSync(
    'config.validate',
    { 'config.scope': scope, 'config.validation.layer': 'L3' },
    (validateSpan) => {
      const r = validateConfigContent(documentName, content);
      validateSpan.setAttribute('config.outcome', r.ok ? 'success' : 'rejected');
      if (!r.ok) emitSchemaInvalidIssueEvents(r.error);
      return r;
    },
  );
  if (!validation.ok) {
    if (documentName === CONFIG_DOC_NAME_OKIGNORE && isKnownConfigError(validation.error)) {
      okignoreRejectionCounter().add(1, { 'error.code': validation.error.code });
    }
    ctx.onConfigRejected?.(documentName, validation.error);
    incrementConfigOutsideChange('intake', 'rejected');
    return 'rejected';
  }

  const displaced = await saveDisplacedEdits(document, documentName, content, ctx);
  if (displaced === 'held') {
    incrementConfigOutsideChange('intake', 'held-no-history-or-backup');
    log.warn(
      { docName: documentName },
      '[config-persistence] a valid outside version landed but the unsaved edit could not be kept in history or the backup folder; it was not applied',
    );
    return 'held';
  }
  if (displaced === 'deferred') {
    incrementConfigOutsideChange('intake', 'deferred');
    log.warn(
      { docName: documentName },
      '[config-persistence] a valid outside version landed while the settings kept changing here; it was not applied, and the edits displaced so far were kept in history or the backup folder',
    );
    return 'held';
  }

  replaceLiveConfig(document, content);
  agreeWithDisk(documentName, content, ctx);
  noticeDisplacedEdits(documentName, displaced, ctx);
  incrementConfigOutsideChange('intake', displaced.length > 0 ? 'applied-displaced' : 'applied');
  return 'applied';
}
