/**
 * Persistence for managed-artifact docs — skills (`__skill__/<scope>/<name>`).
 * The CRDT amendment makes these first-class CRDT documents that persist to
 * `.ok/`. Templates are ordinary content docs now (`<folder>/.ok/templates/<name>`,
 * hydrated by the content persistence path); the retired `__template__/…`
 * synthetic name survives here only as a load/store tombstone so a stale client
 * name never seeds a second doc or writes a literal `__template__/…` file.
 *
 * Shape: a HYBRID of the two existing persistence branches.
 *  - LOAD/STORE BODY mirrors the *document* branch (`persistence.ts`
 *    onLoadDocument), NOT the Y.Text-only config branch — managed-artifact docs
 *    are full XmlFragment+Y.Text docs (the observer bridge RUNS for them, so
 *    WYSIWYG works). Load is a paired-write under `FILE_WATCHER_ORIGIN`.
 *  - PATH RESOLUTION + atomic-write + file-lock + LKG + reconcile-on-concurrent
 *    mirror the *config* branch (`config-persistence.ts`) — these are `.ok/`
 *    files that a second OK window (or a hand/CLI edit) can race.
 *
 * Verbatim fidelity (precedent #38, Y.Text-is-truth): the store serializes the
 * body from `Y.Text('source')` — the raw source bytes — NEVER from the
 * XmlFragment (which would re-canonicalize the markdown that gets projected
 * verbatim into an agent's context). This is the single most load-bearing rule
 * in this module.
 *
 * Reconciled-base accessors are injected via ctx (not imported from
 * `persistence.ts`) to avoid a circular import — `persistence.ts` imports this
 * module for its third branch.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import {
  LEGACY_SKILL_STORE_ROOT,
  LINEAGE_EPOCH_KEY,
  MANAGED_ARTIFACT_PREFIX_SKILL,
  MANAGED_ARTIFACT_PREFIX_TEMPLATE,
  type ManagedArtifactScope,
  parseExternalSkillDocName,
  parseManagedArtifactName,
  SKILL_NAME_REGEX,
  skillRootActivationPath,
} from '@inkeep/open-knowledge-core';
import {
  atomicWriteFile,
  FileLockTimeoutError,
  withFileLock,
} from '@inkeep/open-knowledge-core/server';
import type * as Y from 'yjs';
import type { DeriveLossDetectOptions } from './bridge-loss-detector.ts';
import { applyDiskContentToDoc, FILE_WATCHER_ORIGIN } from './disk-content-intake.ts';
import { externalSkillAbsPath } from './external-skill-registry.ts';
import { tracedAtomicFs, tracedMkdir, tracedUnlinkSync } from './fs-traced.ts';
import {
  globalSkillGraphRoots,
  knownSkillRootsFor,
  resolveDefaultSkillHomeRel,
  resolveGlobalNativeSkillDir,
} from './in-place-skills.ts';
import { getLogger } from './logger.ts';
import { incrementManagedArtifactReconcile } from './metrics.ts';

const log = getLogger('managed-artifact-persistence');

export interface ManagedArtifactCtx {
  projectDir: string;
  homedirOverride?: string;
  lkgCache: Map<string, string>;
  setReconciledBase: (docName: string, content: string) => void;
  getReconciledBase: (docName: string) => string | undefined;
  beforeReconcileDivergence?: (
    document: Y.Doc,
    documentName: string,
    liveContent: string,
    diskContent: string,
  ) => DeriveLossDetectOptions | undefined;
}

export type StoreManagedArtifactOutcome = 'persisted' | 'no-op' | 'reconciled' | 'write-failed';

type ManagedArtifactLocation = Pick<ManagedArtifactCtx, 'projectDir' | 'homedirOverride'>;

export function homeFor(ctx: Pick<ManagedArtifactCtx, 'homedirOverride'>): string {
  return ctx.homedirOverride ?? homedir();
}

export function managedArtifactContributorAttribution(
  documentName: string,
): { docKey: string; subject: string } | null {
  const parsed = parseManagedArtifactName(documentName);
  if (parsed === null || parsed.kind !== 'skill' || parsed.scope !== 'project') return null;
  return {
    docKey: `${LEGACY_SKILL_STORE_ROOT}/${parsed.name}`,
    subject: `skill-edit: ${parsed.name}/SKILL.md`,
  };
}

export function managedArtifactTimelinePaths(
  documentName: string,
):
  | { managed: false }
  | { managed: true; versioned: false }
  | { managed: true; versioned: true; docKey: string; filePath: string } {
  const parsed = parseManagedArtifactName(documentName);
  if (!parsed) return { managed: false };
  const attr = managedArtifactContributorAttribution(documentName);
  if (!attr) return { managed: true, versioned: false };
  return {
    managed: true,
    versioned: true,
    docKey: attr.docKey,
    filePath: `${attr.docKey}/SKILL.md`,
  };
}

export function managedArtifactSkillsRoots(ctx: ManagedArtifactCtx): string[] {
  const home = homeFor(ctx);
  return globalSkillGraphRoots(home).filter((abs) =>
    existsSync(resolve(home, skillRootActivationPath(relative(home, abs).split(sep).join('/')))),
  );
}

function resolveBundleFileOnDisk(baseNoExt: string): string {
  return existsSync(`${baseNoExt}.md`)
    ? `${baseNoExt}.md`
    : existsSync(`${baseNoExt}.mdx`)
      ? `${baseNoExt}.mdx`
      : `${baseNoExt}.md`;
}

function managedSkillBundleDir(
  scope: ManagedArtifactScope,
  name: string,
  ctx: ManagedArtifactLocation,
  host: string | null = null,
): string | null {
  if (!SKILL_NAME_REGEX.test(name) || name.length > 64) {
    throw new Error(`managedSkillBundleDir: invalid skill name: ${JSON.stringify(name)}`);
  }
  if (host !== null && (!SKILL_NAME_REGEX.test(host) || host.length > 64)) {
    throw new Error(`managedSkillBundleDir: invalid host qualifier: ${JSON.stringify(host)}`);
  }
  const base = scope === 'global' ? homeFor(ctx) : ctx.projectDir;
  if (scope !== 'global') {
    return resolve(base, '.ok', 'skills', name);
  }
  if (host !== null) {
    const root = knownSkillRootsFor(base, 'global').find((r) => r.editor === host);
    return root === undefined ? null : resolve(base, root.root, name);
  }
  const native = resolveGlobalNativeSkillDir(base, name);
  const storeDir = resolve(base, '.ok', 'skills', name);
  if (native !== null) return native;
  if (existsSync(resolve(storeDir, 'SKILL.md'))) return storeDir;
  const homeRel = resolveDefaultSkillHomeRel(base, 'global');
  return homeRel === null ? null : resolve(base, homeRel, name);
}

function managedArtifactContainerDir(
  documentName: string,
  ctx: ManagedArtifactLocation,
): string | null {
  const ext = parseExternalSkillDocName(documentName);
  if (ext !== null) {
    const abs = externalSkillAbsPath(ext.name, null);
    return abs === null ? null : dirname(abs);
  }
  const parsed = parseManagedArtifactName(documentName);
  if (parsed === null || parsed.kind !== 'skill') return null;
  return managedSkillBundleDir(parsed.scope, parsed.name, ctx, parsed.host);
}

export function managedArtifactAbsPath(documentName: string, ctx: ManagedArtifactLocation): string {
  const ext = parseExternalSkillDocName(documentName);
  if (ext !== null) {
    const abs = externalSkillAbsPath(ext.name, ext.rel);
    if (abs === null) {
      throw new Error(`managedArtifactAbsPath: external skill not registered: ${documentName}`);
    }
    return ext.rel === null ? abs : resolveBundleFileOnDisk(abs);
  }
  const parsed = parseManagedArtifactName(documentName);
  if (parsed === null || parsed.kind !== 'skill') {
    throw new Error(`managedArtifactAbsPath: not a managed skill doc name: ${documentName}`);
  }
  const skillDir = managedSkillBundleDir(parsed.scope, parsed.name, ctx, parsed.host);
  if (skillDir === null) {
    throw new Error(`managedArtifactAbsPath: no usable skill home for ${documentName}`);
  }
  let abs: string;
  if (parsed.rel === null) {
    abs = resolve(skillDir, 'SKILL.md');
  } else {
    const relSegs = parsed.rel.split('/').filter((s) => s !== '' && s !== '.');
    if (relSegs.length === 0 || relSegs.some((s) => s === '..')) {
      throw new Error(`managedArtifactAbsPath: invalid skill file path for ${documentName}`);
    }
    abs = resolveBundleFileOnDisk(resolve(skillDir, ...relSegs));
  }
  if (!abs.startsWith(skillDir + sep)) {
    throw new Error(`managedArtifactAbsPath: path escape for ${documentName}`);
  }
  return abs;
}

export function managedArtifactDocNameForPath(
  absPath: string,
  ctx: ManagedArtifactCtx,
): string | null {
  const norm = resolve(absPath);
  const home = homeFor(ctx);
  const hostRoots = knownSkillRootsFor(home, 'global');
  for (const root of globalSkillGraphRoots(home)) {
    const globalSkillsRoot = resolve(root);
    if (!norm.startsWith(globalSkillsRoot + sep)) continue;
    const rel = norm.slice(globalSkillsRoot.length + 1).split(sep);
    const name = rel[0];
    if (name && SKILL_NAME_REGEX.test(name) && name.length <= 64 && rel.length >= 2) {
      const bundleDir = resolve(globalSkillsRoot, name);
      const defaultDir = resolveGlobalNativeSkillDir(home, name);
      let qualifier = '';
      if (defaultDir !== null && resolve(defaultDir) !== bundleDir) {
        const editor = hostRoots.find((r) => resolve(home, r.root) === globalSkillsRoot)?.editor;
        if (editor !== undefined) qualifier = `@${editor}`;
      }
      const tail = rel.slice(1);
      if (tail.length === 1 && tail[0] === 'SKILL.md') {
        return `${MANAGED_ARTIFACT_PREFIX_SKILL}global/${name}${qualifier}`;
      }
      const last = tail[tail.length - 1] ?? '';
      if (/\.mdx?$/i.test(last) && !tail.includes('..')) {
        const relNoExt = tail.join('/').replace(/\.mdx?$/i, '');
        return `${MANAGED_ARTIFACT_PREFIX_SKILL}global/${name}${qualifier}/${relNoExt}`;
      }
    }
    return null;
  }
  return null;
}

export function loadManagedArtifactDoc(
  document: Y.Doc,
  documentName: string,
  ctx: ManagedArtifactCtx,
): void {
  const parsed = parseManagedArtifactName(documentName);
  if (parsed?.kind === 'skill' && parsed.scope === 'project') return;

  if (documentName.startsWith(MANAGED_ARTIFACT_PREFIX_TEMPLATE)) return;

  const extParsed = parseExternalSkillDocName(documentName);
  if (extParsed && externalSkillAbsPath(extParsed.name, extParsed.rel) === null) return;

  const xmlFragment = document.getXmlFragment('default');
  if (xmlFragment.length > 0) return;

  const filePath = managedArtifactAbsPath(documentName, ctx);
  if (!existsSync(filePath)) return;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    log.warn({ documentName, err: e }, 'load: could not read; seeding empty');
    return;
  }

  document.transact(() => {
    applyDiskContentToDoc(document, raw, undefined, documentName);
    document.getMap('lifecycle').set(LINEAGE_EPOCH_KEY, crypto.randomUUID());
  }, FILE_WATCHER_ORIGIN);

  ctx.setReconciledBase(documentName, raw);
  ctx.lkgCache.set(documentName, raw);
}

const DISCARDED_EDIT_STASH_MAX = 5;

async function stashDiscardedEdit(
  documentName: string,
  content: string,
  ctx: Pick<ManagedArtifactCtx, 'homedirOverride'>,
): Promise<void> {
  try {
    const safe = documentName.replace(/[^A-Za-z0-9._-]+/g, '__');
    const dir = resolve(homeFor(ctx), '.ok', 'edit-backups', 'discarded', safe);
    await tracedMkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await atomicWriteFile(resolve(dir, `${stamp}.md`), content, { fs: tracedAtomicFs });
    const entries = readdirSync(dir).sort();
    for (const old of entries.slice(0, Math.max(0, entries.length - DISCARDED_EDIT_STASH_MAX))) {
      try {
        tracedUnlinkSync(resolve(dir, old));
      } catch {}
    }
  } catch (e) {
    log.warn({ documentName, err: e }, 'discarded-edit stash failed');
  }
}

async function backupExternalSkillOnce(
  filePath: string,
  ext: { name: string; rel: string | null },
  ctx: Pick<ManagedArtifactCtx, 'homedirOverride'>,
): Promise<void> {
  if (ext.rel !== null) return;
  try {
    if (!existsSync(filePath)) return;
    const backupDir = resolve(homeFor(ctx), '.ok', 'edit-backups', ext.name);
    const backupPath = resolve(backupDir, 'SKILL.md.bak');
    if (existsSync(backupPath)) return;
    await tracedMkdir(backupDir, { recursive: true });
    await atomicWriteFile(backupPath, readFileSync(filePath, 'utf-8'), { fs: tracedAtomicFs });
  } catch (e) {
    log.warn({ name: ext.name, err: e }, 'external-skill backup failed');
  }
}

/**
 * Persist a managed-artifact doc to disk. Serializes from `Y.Text('source')`
 * (verbatim — precedent #38). File-locked + atomic; reconciles instead of
 * clobbering when another writer changed the file since our LKG.
 *
 * Entry gate: a store whose last transaction was the load/reconcile import
 * (`FILE_WATCHER_ORIGIN`) is a no-op (don't write back what we just read).
 */
export async function storeManagedArtifactDoc(
  document: Y.Doc,
  documentName: string,
  lastTransactionOrigin: unknown,
  ctx: ManagedArtifactCtx,
): Promise<StoreManagedArtifactOutcome> {
  const parsedStore = parseManagedArtifactName(documentName);
  if (parsedStore?.kind === 'skill' && parsedStore.scope === 'project') return 'no-op';

  if (documentName.startsWith(MANAGED_ARTIFACT_PREFIX_TEMPLATE)) return 'no-op';

  const extStore = parseExternalSkillDocName(documentName);
  if (extStore && externalSkillAbsPath(extStore.name, extStore.rel) === null) return 'no-op';

  if (lastTransactionOrigin === FILE_WATCHER_ORIGIN) return 'no-op';

  const content = document.getText('source').toString();
  const lkg = ctx.lkgCache.get(documentName);
  if (content === lkg) return 'no-op';

  const containerDir = managedArtifactContainerDir(documentName, ctx);
  if (containerDir === null) return 'no-op';
  if (!existsSync(containerDir)) {
    log.warn(
      { documentName, containerDir },
      'store: artifact container is gone (deleted or moved); dropping the write rather than resurrecting it',
    );
    return 'no-op';
  }

  const filePath = managedArtifactAbsPath(documentName, ctx);

  try {
    await tracedMkdir(resolve(filePath, '..'), { recursive: true });
    if (extStore) await backupExternalSkillOnce(filePath, extStore, ctx);
    return await withFileLock(`${filePath}.lock`, async () => {
      if (existsSync(filePath)) {
        let disk: string | null = null;
        try {
          disk = readFileSync(filePath, 'utf-8');
        } catch (readErr) {
          if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.warn(
              { documentName, err: readErr },
              'store: pre-write disk read failed (non-ENOENT); proceeding to write',
            );
          }
          disk = null;
        }
        if (disk !== null && disk !== lkg && disk !== content) {
          incrementManagedArtifactReconcile();
          const detect = ctx.beforeReconcileDivergence?.(document, documentName, content, disk);
          await stashDiscardedEdit(documentName, content, ctx);
          document.transact(() => {
            applyDiskContentToDoc(document, disk, undefined, documentName, undefined, detect);
          }, FILE_WATCHER_ORIGIN);
          ctx.setReconciledBase(documentName, disk);
          ctx.lkgCache.set(documentName, disk);
          return 'reconciled';
        }
      }
      await atomicWriteFile(filePath, content, { fs: tracedAtomicFs });
      ctx.lkgCache.set(documentName, content);
      ctx.setReconciledBase(documentName, content);
      return 'persisted';
    });
  } catch (e) {
    if (e instanceof FileLockTimeoutError) {
      log.warn({ documentName }, 'store: file lock timeout; skipping write');
      return 'write-failed';
    }
    log.warn({ documentName, err: e }, 'store: write failed');
    return 'write-failed';
  }
}

export type ApplyExternalManagedArtifactChangeOutcome = 'applied' | 'no-op';

export function applyExternalManagedArtifactChange(
  document: Y.Doc | null,
  documentName: string,
  raw: string,
  ctx: ManagedArtifactCtx,
): ApplyExternalManagedArtifactChangeOutcome {
  if (!document) return 'no-op';
  const lkg = ctx.lkgCache.get(documentName);
  if (lkg !== undefined && lkg === raw) return 'no-op';
  document.transact(() => {
    applyDiskContentToDoc(document, raw, undefined, documentName);
  }, FILE_WATCHER_ORIGIN);
  ctx.setReconciledBase(documentName, raw);
  ctx.lkgCache.set(documentName, raw);
  return 'applied';
}
