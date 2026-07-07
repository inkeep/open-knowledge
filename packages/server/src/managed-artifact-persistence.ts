/**
 * Persistence for managed-artifact docs — skills (`__skill__/<scope>/<name>`)
 * and templates (`__template__/<folderRel>/<name>`). The CRDT amendment
 * makes these first-class CRDT documents that persist to `.ok/`.
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
  /** Project root — project-scope artifacts resolve under `<projectDir>/.ok/`. */
  projectDir: string;
  /** Override `os.homedir()` for tests — global-scope artifacts resolve under `<home>/.ok/`. */
  homedirOverride?: string;
  /**
   * Per-server-instance last-known-good cache (the verbatim bytes last loaded
   * from or written to disk). Used for the store short-circuit + concurrent-
   * writer reconciliation. Shared with / parallel to the config LKG cache.
   */
  lkgCache: Map<string, string>;
  /** Injected from `persistence.ts` (avoids a circular import). */
  setReconciledBase: (docName: string, content: string) => void;
  getReconciledBase: (docName: string) => string | undefined;
}

/** Store outcome — surfaced for tests + telemetry. */
export type StoreManagedArtifactOutcome = 'persisted' | 'no-op' | 'reconciled' | 'write-failed';

// Only the two location fields gate path resolution. Narrowed (vs the full
// ManagedArtifactCtx) so callers that just need a path — e.g. the link-graph
// title/metadata readers — don't have to fabricate the store-cache + reconcile
// hooks they'll never consult.
type ManagedArtifactLocation = Pick<ManagedArtifactCtx, 'projectDir' | 'homedirOverride'>;

function homeFor(ctx: Pick<ManagedArtifactCtx, 'homedirOverride'>): string {
  return ctx.homedirOverride ?? homedir();
}

/**
 * The `.ok/` artifact key + shadow-commit subject for a managed-artifact doc, so
 * an EDITOR-driven CRDT edit can be attributed + versioned exactly like the HTTP
 * `write`/`edit` path does via `attributeOkArtifactWrite`. The key must match the
 * timeline query's doc-key (`.ok/skills/<name>` / `<folder>/.ok/templates/<name>`,
 * NOT the synthetic `__skill__/...` doc name) and the subject must carry the
 * `skill-`/`template-` action prefix the timeline filters on.
 *
 * Returns `null` for unversioned artifacts: global skills live outside any
 * project shadow repo, so there is nothing to version.
 */
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

/**
 * The shadow-repo paths for a managed-artifact doc, derived once so every
 * timeline-family subsystem (history pathspec + OkActor filter, version read,
 * diff, rollback) addresses the same key the write path commits under. The
 * synthetic `__skill__/...` / `__template__/...` doc name the editor uses never
 * matches on disk — this is the single translation point that bridges it.
 *
 *  - `{ managed: false }`             — not a managed-artifact name (ordinary doc)
 *  - `{ managed: true, versioned: false }` — global skill: lives outside any
 *      project shadow repo, so there is no version history to address
 *  - `{ managed: true, versioned: true, docKey, filePath }` — project skill /
 *      template: `docKey` (`.ok/skills/<name>` / `<folder>/.ok/templates/<name>`)
 *      drives OkActor matching; `filePath` (the SKILL.md / `<name>.md` leaf) is
 *      the content-root-relative git path commits actually touch.
 */
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

/**
 * The skills-root directories to watch for this ctx — GLOBAL only. Project
 * skills (`<contentDir>/.ok/skills/**`) are now real indexed content handled by
 * the content file-watcher (skills-as-content carve-out); watching them here too
 * would double-index every `SKILL.md`. Global skills live at
 * `<home>/.ok/skills`, OUTSIDE contentDir, so this dedicated watch stays their
 * only disk→doc reconcile path.
 */
export function managedArtifactSkillsRoots(ctx: ManagedArtifactCtx): string[] {
  return [resolve(homeFor(ctx), '.ok', 'skills')];
}

/**
 * Resolve the on-disk path for a managed-artifact doc name.
 *
 * Security: the name segment is OPEN (one per artifact), unlike the bounded
 * config-doc set, so the resolver guards on (1) the name slug grammar
 * (`SKILL_NAME_REGEX` / `TEMPLATE_NAME_REGEX`), (2) for templates, a folder that
 * stays under `projectDir` (no `..`), and (3) the resolved path staying within
 * the expected `.ok/{skills,templates}` root. Any failure throws — a malformed
 * name/folder must never write outside `.ok/`.
 *
 *  - skill    → `<scope-root>/.ok/skills/<name>/SKILL.md`
 *  - template → `<projectDir>/<folder>/.ok/templates/<name>.md`
 */
export function managedArtifactAbsPath(documentName: string, ctx: ManagedArtifactLocation): string {
  const parsed = parseManagedArtifactName(documentName);
  if (parsed === null) {
    throw new Error(`managedArtifactAbsPath: not a managed-artifact doc name: ${documentName}`);
  }
  if (parsed.kind === 'template') {
    return templateAbsPath(parsed.folder, parsed.name, ctx, documentName);
  }
  // Guard 1: slug grammar (rejects `..`, slashes, dots, uppercase, empty).
  if (!SKILL_NAME_REGEX.test(parsed.name) || parsed.name.length > 64) {
    throw new Error(`managedArtifactAbsPath: invalid skill name: ${JSON.stringify(parsed.name)}`);
  }
  const base = parsed.scope === 'global' ? homeFor(ctx) : ctx.projectDir;
  const skillsRoot = resolve(base, '.ok', 'skills');
  const abs = resolve(skillsRoot, parsed.name, 'SKILL.md');
  // Guard 2: containment on the resolved path. Cheap defense-in-depth — guard 1's
  // slug grammar already forbids escape, so this only fires if that grammar is
  // ever weakened. (Mirrors templateAbsPath's `startsWith(templatesDir + sep)`.)
  if (!abs.startsWith(skillsRoot + sep)) {
    throw new Error(`managedArtifactAbsPath: path escape for ${documentName}`);
  }
  return abs;
}

/** Normalize a project-root-relative folder (strip leading/trailing slashes). */
function normalizeTemplateFolder(folder: string): string {
  return folder.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Resolve `<projectDir>/<folder>/.ok/templates/<name>.md` with escape guards.
 * `folder` is project-root-relative (`''` = root, may be nested); `name` is the
 * `.md`-less filename.
 */
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

/**
 * Reverse of {@link managedArtifactAbsPath}: map an on-disk leaf path back to its
 * `__skill__/<scope>/<name>` or `__template__/<folderRel>/<name>` doc name, or
 * `null` when the path is not a well-formed managed-artifact leaf. Used by the
 * file-watcher (`.ok/` is watcher-excluded by default, so disk edits reach a
 * live doc only via the explicit managed-artifact watch).
 *
 * Applies the same slug grammar as the forward resolver so a path with an
 * invalid name segment is rejected rather than routed to a malformed doc name.
 */
export function managedArtifactDocNameForPath(
  absPath: string,
  ctx: ManagedArtifactCtx,
): string | null {
  const norm = resolve(absPath);
  // Skill: `<home>/.ok/skills/<name>/SKILL.md` — GLOBAL only. Project skills
  // are content docs now (`.ok/skills/<name>/SKILL`), reconciled by the content
  // watcher, never mapped to a `__skill__/project/...` synthetic name here.
  if (norm.endsWith(`${sep}SKILL.md`)) {
    const roots: ReadonlyArray<readonly [string, ManagedArtifactScope]> = [
      [resolve(homeFor(ctx), '.ok', 'skills'), 'global'],
    ];
    for (const [root, scope] of roots) {
      if (!norm.startsWith(root + sep)) continue;
      const rel = norm.slice(root.length + 1).split(sep);
      // Exactly `<name>/SKILL.md` — no nesting, no SKILL.md directly in the root.
      if (rel.length !== 2 || rel[1] !== 'SKILL.md') continue;
      const name = rel[0];
      if (!SKILL_NAME_REGEX.test(name) || name.length > 64) continue;
      // Slug grammar guarantees `encodeURIComponent(name) === name`.
      return `${MANAGED_ARTIFACT_PREFIX_SKILL}${scope}/${name}`;
    }
    return null;
  }
  // Template: `<projectDir>/<folderRel>/.ok/templates/<name>.md`.
  if (norm.endsWith('.md')) {
    const projectAbs = resolve(ctx.projectDir);
    if (norm !== projectAbs && !norm.startsWith(projectAbs + sep)) return null;
    const rel = norm === projectAbs ? '' : norm.slice(projectAbs.length + 1);
    const marker = `.ok${sep}templates${sep}`;
    const idx = rel.indexOf(marker);
    if (idx < 0) return null;
    // `.ok/templates/` must be a clean path boundary: at the start, or preceded
    // by a separator (so `x.ok/templates` can't false-match).
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

/**
 * Load a managed-artifact doc from disk into its Y.Doc — mirrors the document
 * onLoadDocument body (paired-write XmlFragment+Y.Text under
 * `FILE_WATCHER_ORIGIN`, reconciled-base = raw disk bytes). Lazy: a missing
 * file seeds nothing (admitting a doc never auto-creates disk).
 */
export function loadManagedArtifactDoc(
  document: Y.Doc,
  documentName: string,
  ctx: ManagedArtifactCtx,
): void {
  // Project skills are content docs now (`.ok/skills/<name>/SKILL`), hydrated via
  // the normal content persistence path. The `__skill__/project/...` synthetic
  // doc is dead — refuse to seed it from disk so it never becomes a SECOND CRDT
  // doc competing with the content doc for the same file (double-doc corruption).
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

  // Paired-write: Y.Text receives the FULL file (FM + body) verbatim so the
  // YAML region stays byte-faithful; XmlFragment derives. The paired origin's
  // structural short-circuit refreshes the baseline without dispatching a sync.
  document.transact(() => {
    applyDiskContentToDoc(document, raw, undefined, documentName);
    // Mint the doc's lineage epoch atomically with the seed (mirrors the content
    // persistence path in `persistence.ts`). Every seed-from-disk is a NEW Yjs
    // lineage — no Y-binary survives an unload, so the markdown is re-inserted
    // under fresh client IDs. Without an epoch, a client's IndexedDB-persisted
    // copy from a PRIOR lineage rejoins this fresh one on reconnect and Yjs
    // concatenates the two independent same-text insertions (the personal-skill
    // self-duplication). The epoch replicates in-band via the lifecycle map into
    // client IDB; `doc-lineage-guard` / the client attach-gate discard a stale
    // lineage's rows instead of merging them.
    document.getMap('lifecycle').set(LINEAGE_EPOCH_KEY, crypto.randomUUID());
  }, FILE_WATCHER_ORIGIN);

  ctx.setReconciledBase(documentName, raw);
  ctx.lkgCache.set(documentName, raw);
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
  // Project skills persist through the content path; never write the dead
  // `__skill__/project/...` synthetic doc back to disk (see load guard).
  const parsedStore = parseManagedArtifactName(documentName);
  if (parsedStore?.kind === 'skill' && parsedStore.scope === 'project') return 'no-op';

  if (lastTransactionOrigin === FILE_WATCHER_ORIGIN) return 'no-op';

  const content = document.getText('source').toString();
  const lkg = ctx.lkgCache.get(documentName);
  if (content === lkg) return 'no-op';

  const filePath = managedArtifactAbsPath(documentName, ctx);

  try {
    // Ensure the skill dir exists BEFORE acquiring the lock — `withFileLock`
    // creates `<filePath>.lock`, which would ENOENT for a brand-new skill whose
    // `.ok/skills/<name>/` dir doesn't exist yet (config docs dodge this because
    // `.ok/` is pre-created at init).
    await tracedMkdir(resolve(filePath, '..'), { recursive: true });
    return await withFileLock(`${filePath}.lock`, async () => {
      // Concurrent-writer reconcile: if disk diverged from our LKG (another OK
      // window / hand edit), import disk into the doc instead of clobbering.
      if (existsSync(filePath)) {
        let disk: string | null = null;
        try {
          disk = readFileSync(filePath, 'utf-8');
        } catch (readErr) {
          // ENOENT (file vanished between existsSync and read) is the benign
          // race — fall through and write. Anything else (EACCES/EISDIR/…) would
          // otherwise vanish: the store proceeds to atomicWrite, which fails and
          // returns 'write-failed' with no hint a READ preceded it. Log it.
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

/** Outcome of {@link applyExternalManagedArtifactChange}. */
export type ApplyExternalManagedArtifactChangeOutcome = 'applied' | 'no-op';

/**
 * Apply an external (disk) change to a live managed-artifact doc — the
 * file-watcher path for `.ok/skills/**​/SKILL.md` hand/CLI/cross-instance edits.
 * Imports disk bytes into the doc under `FILE_WATCHER_ORIGIN` (paired-write) and
 * refreshes the LKG + reconciled base.
 *
 * Self-write detection mirrors `applyExternalConfigChange`: when persistence
 * writes content `C` to disk it sets `lkgCache[doc] = C`; the watcher then reads
 * `C` back (chokidar fires for OUR own write) and this short-circuits before any
 * Y.Doc mutation. A `null` document (doc not currently open) is also a no-op —
 * the next open re-reads disk fresh via `loadManagedArtifactDoc`.
 */
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
