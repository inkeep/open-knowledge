import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import {
  LINEAGE_EPOCH_KEY,
  MANAGED_ARTIFACT_PREFIX_SKILL,
  MANAGED_ARTIFACT_PREFIX_TEMPLATE,
  type ManagedArtifactScope,
  parseManagedArtifactName,
  SKILL_CONTENT_ROOT,
  SKILL_NAME_REGEX,
  TEMPLATE_NAME_REGEX,
} from '@inkeep/open-knowledge-core';
import {
  atomicWriteFile,
  FileLockTimeoutError,
  withFileLock,
} from '@inkeep/open-knowledge-core/server';
import type * as Y from 'yjs';
import { applyDiskContentToDoc, FILE_WATCHER_ORIGIN } from './external-change.ts';
import { tracedAtomicFs, tracedMkdir } from './fs-traced.ts';
import { getLogger } from './logger.ts';

const log = getLogger('managed-artifact-persistence');

export interface ManagedArtifactCtx {
  projectDir: string;
  homedirOverride?: string;
  lkgCache: Map<string, string>;
  setReconciledBase: (docName: string, content: string) => void;
  getReconciledBase: (docName: string) => string | undefined;
}

export type StoreManagedArtifactOutcome = 'persisted' | 'no-op' | 'reconciled' | 'write-failed';

type ManagedArtifactLocation = Pick<ManagedArtifactCtx, 'projectDir' | 'homedirOverride'>;

function homeFor(ctx: Pick<ManagedArtifactCtx, 'homedirOverride'>): string {
  return ctx.homedirOverride ?? homedir();
}

export function managedArtifactContributorAttribution(
  documentName: string,
): { docKey: string; subject: string } | null {
  const parsed = parseManagedArtifactName(documentName);
  if (parsed === null) return null;
  if (parsed.kind === 'skill') {
    if (parsed.scope !== 'project') return null; // global = unversioned
    return {
      docKey: `${SKILL_CONTENT_ROOT}/${parsed.name}`,
      subject: `skill-edit: ${parsed.name}/SKILL.md`,
    };
  }
  const folder = parsed.folder.replace(/\/$/, '');
  const docKey = `${folder ? `${folder}/` : ''}.ok/templates/${parsed.name}`;
  return { docKey, subject: `template-edit: ${docKey}.md` };
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
  const filePath = parsed.kind === 'skill' ? `${attr.docKey}/SKILL.md` : `${attr.docKey}.md`;
  return { managed: true, versioned: true, docKey: attr.docKey, filePath };
}

export function managedArtifactSkillsRoots(ctx: ManagedArtifactCtx): string[] {
  return [resolve(homeFor(ctx), '.ok', 'skills')];
}

export function managedArtifactAbsPath(documentName: string, ctx: ManagedArtifactLocation): string {
  const parsed = parseManagedArtifactName(documentName);
  if (parsed === null) {
    throw new Error(`managedArtifactAbsPath: not a managed-artifact doc name: ${documentName}`);
  }
  if (parsed.kind === 'template') {
    return templateAbsPath(parsed.folder, parsed.name, ctx, documentName);
  }
  if (!SKILL_NAME_REGEX.test(parsed.name) || parsed.name.length > 64) {
    throw new Error(`managedArtifactAbsPath: invalid skill name: ${JSON.stringify(parsed.name)}`);
  }
  const base = parsed.scope === 'global' ? homeFor(ctx) : ctx.projectDir;
  const skillsRoot = resolve(base, '.ok', 'skills');
  const abs = resolve(skillsRoot, parsed.name, 'SKILL.md');
  if (!abs.startsWith(skillsRoot + sep)) {
    throw new Error(`managedArtifactAbsPath: path escape for ${documentName}`);
  }
  return abs;
}

function normalizeTemplateFolder(folder: string): string {
  return folder.replace(/^\/+/, '').replace(/\/+$/, '');
}

function templateAbsPath(
  folder: string,
  name: string,
  ctx: Pick<ManagedArtifactCtx, 'projectDir'>,
  documentName: string,
): string {
  if (!TEMPLATE_NAME_REGEX.test(name) || name.length > 64) {
    throw new Error(`managedArtifactAbsPath: invalid template name: ${JSON.stringify(name)}`);
  }
  const folderRel = normalizeTemplateFolder(folder);
  if (folderRel.split('/').includes('..')) {
    throw new Error(`managedArtifactAbsPath: template folder escape for ${documentName}`);
  }
  const projectAbs = resolve(ctx.projectDir);
  const folderAbs = folderRel ? resolve(projectAbs, folderRel) : projectAbs;
  if (folderAbs !== projectAbs && !folderAbs.startsWith(projectAbs + sep)) {
    throw new Error(`managedArtifactAbsPath: template folder escape for ${documentName}`);
  }
  const templatesDir = resolve(folderAbs, '.ok', 'templates');
  const abs = resolve(templatesDir, `${name}.md`);
  if (!abs.startsWith(templatesDir + sep)) {
    throw new Error(`managedArtifactAbsPath: path escape for ${documentName}`);
  }
  return abs;
}

export function managedArtifactDocNameForPath(
  absPath: string,
  ctx: ManagedArtifactCtx,
): string | null {
  const norm = resolve(absPath);
  if (norm.endsWith(`${sep}SKILL.md`)) {
    const roots: ReadonlyArray<readonly [string, ManagedArtifactScope]> = [
      [resolve(homeFor(ctx), '.ok', 'skills'), 'global'],
    ];
    for (const [root, scope] of roots) {
      if (!norm.startsWith(root + sep)) continue;
      const rel = norm.slice(root.length + 1).split(sep);
      if (rel.length !== 2 || rel[1] !== 'SKILL.md') continue;
      const name = rel[0];
      if (!SKILL_NAME_REGEX.test(name) || name.length > 64) continue;
      return `${MANAGED_ARTIFACT_PREFIX_SKILL}${scope}/${name}`;
    }
    return null;
  }
  if (norm.endsWith('.md')) {
    const projectAbs = resolve(ctx.projectDir);
    if (norm !== projectAbs && !norm.startsWith(projectAbs + sep)) return null;
    const rel = norm === projectAbs ? '' : norm.slice(projectAbs.length + 1);
    const marker = `.ok${sep}templates${sep}`;
    const idx = rel.indexOf(marker);
    if (idx < 0) return null;
    if (idx > 0 && rel[idx - 1] !== sep) return null;
    const after = rel.slice(idx + marker.length);
    if (after.includes(sep) || !after.endsWith('.md')) return null; // single .md leaf
    const name = after.slice(0, -3);
    if (!TEMPLATE_NAME_REGEX.test(name) || name.length > 64) return null;
    const folderRel = idx === 0 ? '' : rel.slice(0, idx - 1);
    const folderEncoded = folderRel
      ? folderRel
          .split(sep)
          .map((s) => encodeURIComponent(s))
          .join('/')
      : '';
    return `${MANAGED_ARTIFACT_PREFIX_TEMPLATE}${folderEncoded ? `${folderEncoded}/` : ''}${encodeURIComponent(name)}`;
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

  const xmlFragment = document.getXmlFragment('default');
  if (xmlFragment.length > 0) return;

  const filePath = managedArtifactAbsPath(documentName, ctx);
  if (!existsSync(filePath)) return;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    log.warn({ documentName, err: (e as Error).message }, 'load: could not read; seeding empty');
    return;
  }

  document.transact(() => {
    applyDiskContentToDoc(document, raw, undefined, documentName);
    document.getMap('lifecycle').set(LINEAGE_EPOCH_KEY, crypto.randomUUID());
  }, FILE_WATCHER_ORIGIN);

  ctx.setReconciledBase(documentName, raw);
  ctx.lkgCache.set(documentName, raw);
}

export async function storeManagedArtifactDoc(
  document: Y.Doc,
  documentName: string,
  lastTransactionOrigin: unknown,
  ctx: ManagedArtifactCtx,
): Promise<StoreManagedArtifactOutcome> {
  const parsedStore = parseManagedArtifactName(documentName);
  if (parsedStore?.kind === 'skill' && parsedStore.scope === 'project') return 'no-op';

  if (lastTransactionOrigin === FILE_WATCHER_ORIGIN) return 'no-op';

  const content = document.getText('source').toString();
  const lkg = ctx.lkgCache.get(documentName);
  if (content === lkg) return 'no-op';

  const filePath = managedArtifactAbsPath(documentName, ctx);

  try {
    await tracedMkdir(resolve(filePath, '..'), { recursive: true });
    return await withFileLock(`${filePath}.lock`, async () => {
      if (existsSync(filePath)) {
        let disk: string | null = null;
        try {
          disk = readFileSync(filePath, 'utf-8');
        } catch (readErr) {
          if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.warn(
              { documentName, err: (readErr as Error).message },
              'store: pre-write disk read failed (non-ENOENT); proceeding to write',
            );
          }
          disk = null;
        }
        if (disk !== null && disk !== lkg && disk !== content) {
          document.transact(() => {
            applyDiskContentToDoc(document, disk, undefined, documentName);
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
    log.warn({ documentName, err: (e as Error).message }, 'store: write failed');
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
