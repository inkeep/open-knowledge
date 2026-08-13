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
  resolveDefaultSkillHomeRel,
  resolveGlobalNativeSkillDir,
} from './in-place-skills.ts';
import { getLogger } from './logger.ts';
import { incrementManagedArtifactReconcile } from './metrics.ts';

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
  /**
   * Called immediately before the concurrent-writer reconcile replaces the live
   * artifact with the disk bytes. Mints the restore anchor for `liveContent`
   * (the reconcile transacts under `FILE_WATCHER_ORIGIN`, so neither undo stack
   * can reach it) and returns the paired-intake detector for the import, so the
   * discarded content reaches the loss ring instead of vanishing silently.
   *
   * Injected rather than imported for the same reason the reconciled-base
   * accessors are: the shadow repo, the loss ring, and the branch resolver all
   * live in `persistence.ts`, and importing them here would close a cycle.
   * Optional so a ctx built without that plumbing (unit rigs, ephemeral boots)
   * still reconciles — it just reconciles unanchored, which the
   * `managedArtifactReconcile` counter records.
   *
   * The detector is RETURNED rather than constructed here, which is why this
   * hook bundles two jobs where the document-path sibling
   * (`checkpointBeforeDivergenceRealign`) only checkpoints and lets its caller
   * build `detect` inline. That asymmetry is the DI boundary, not a style
   * choice: a `detect` reporter needs the loss ring, the site constant, and
   * `fnv1aDigest`, none of which this module can reach without the cycle the
   * seam exists to avoid. A follow-up site inside `persistence.ts` should
   * follow the realign shape; one outside it should follow this one.
   */
  beforeReconcileDivergence?: (
    document: Y.Doc,
    documentName: string,
    liveContent: string,
    diskContent: string,
  ) => DeriveLossDetectOptions | undefined;
}

/** Store outcome — surfaced for tests + telemetry. */
export type StoreManagedArtifactOutcome = 'persisted' | 'no-op' | 'reconciled' | 'write-failed';

// Only the two location fields gate path resolution. Narrowed (vs the full
// ManagedArtifactCtx) so callers that just need a path — e.g. the link-graph
// title/metadata readers — don't have to fabricate the store-cache + reconcile
// hooks they'll never consult.
type ManagedArtifactLocation = Pick<ManagedArtifactCtx, 'projectDir' | 'homedirOverride'>;

export function homeFor(ctx: Pick<ManagedArtifactCtx, 'homedirOverride'>): string {
  return ctx.homedirOverride ?? homedir();
}

/**
 * The `.ok/` artifact key + shadow-commit subject for a managed skill doc, so an
 * EDITOR-driven CRDT edit can be attributed + versioned exactly like the HTTP
 * `write`/`edit` path does via `attributeOkArtifactWrite`. The key must match the
 * timeline query's doc-key (`.ok/skills/<name>`, NOT the synthetic
 * `__skill__/...` doc name) and the subject carries the `skill-` action prefix
 * the timeline filters on.
 *
 * Returns `null` for anything unversioned: global skills live outside any
 * project shadow repo, and templates are content docs attributed on their own
 * path by the content store — neither resolves to a managed docKey here.
 */
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

/**
 * The shadow-repo paths for a managed skill doc, derived once so every
 * timeline-family subsystem (history pathspec + OkActor filter, version read,
 * diff, rollback) addresses the same key the write path commits under. The
 * synthetic `__skill__/...` doc name the editor uses never matches on disk —
 * this is the single translation point that bridges it. Templates resolve to
 * `{ managed: false }` here: their doc name IS their real committed content path,
 * so the ordinary `pathFor` translation applies with no managed detour.
 *
 *  - `{ managed: false }`             — not a managed-artifact name (ordinary doc)
 *  - `{ managed: true, versioned: false }` — global skill: lives outside any
 *      project shadow repo, so there is no version history to address
 *  - `{ managed: true, versioned: true, docKey, filePath }` — project skill:
 *      `docKey` (`.ok/skills/<name>`) drives OkActor matching; `filePath` (the
 *      bundle's `SKILL.md` leaf) is the content-root-relative git path commits
 *      actually touch.
 */
export function managedArtifactTimelinePaths(
  documentName: string,
):
  | { managed: false }
  | { managed: true; versioned: false }
  | { managed: true; versioned: true; docKey: string; filePath: string } {
  const parsed = parseManagedArtifactName(documentName);
  if (!parsed) return { managed: false };
  // `attr` is non-null only for a project skill (global skills are unversioned
  // above), whose committed leaf is the bundle's `SKILL.md`.
  const attr = managedArtifactContributorAttribution(documentName);
  if (!attr) return { managed: true, versioned: false };
  return {
    managed: true,
    versioned: true,
    docKey: attr.docKey,
    filePath: `${attr.docKey}/SKILL.md`,
  };
}

/**
 * The skills-root directories to watch for this ctx — GLOBAL only. Project
 * skills (`<contentDir>/.ok/skills/**`) are now real indexed content handled by
 * the content file-watcher (skills-as-content carve-out); watching them here too
 * would double-index every `SKILL.md`. Global skills live at
 * `<home>/.ok/skills`, OUTSIDE contentDir, so this dedicated watch stays their
 * only disk→doc reconcile path.
 *
 * Gated on the host dotdir ALREADY existing. The watcher `mkdir -p`s every root
 * it is handed, so the ungated vocabulary conjured `~/.codex`, `~/.copilot`,
 * `~/.cursor`, `~/.opencode`, `~/.pi` on a machine with none of those tools
 * installed — just by booting OK. OK never creates a harness home; an existing
 * dotdir means the tool IS installed, and creating its `skills/` leaf under it
 * is expected. A root that appears later is picked up on the next boot, and a
 * skill installed into it is materialized by the projection path regardless.
 */
export function managedArtifactSkillsRoots(ctx: ManagedArtifactCtx): string[] {
  const home = homeFor(ctx);
  return globalSkillGraphRoots(home).filter((abs) =>
    existsSync(resolve(home, skillRootActivationPath(relative(home, abs).split(sep).join('/')))),
  );
}

/**
 * Resolve the on-disk path for a managed skill doc name.
 *
 * Security: the name segment is OPEN (one per artifact), unlike the bounded
 * config-doc set, so the resolver guards on (1) the name slug grammar
 * (`SKILL_NAME_REGEX`), and (2) the resolved path staying within the expected
 * `.ok/skills` root. Any failure throws — a malformed name must never write
 * outside `.ok/`.
 *
 *  - skill → `<scope-root>/.ok/skills/<name>/SKILL.md`
 */
/** Bind an ext-less skill bundle-file base path to the real file on disk: `.md`
 *  preferred, `.mdx` fallback, default `.md` for a not-yet-created file. Shared
 *  by the managed and external (`__extskill__/`) bundle-file resolvers so both
 *  address the same real file. */
function resolveBundleFileOnDisk(baseNoExt: string): string {
  return existsSync(`${baseNoExt}.md`)
    ? `${baseNoExt}.md`
    : existsSync(`${baseNoExt}.mdx`)
      ? `${baseNoExt}.mdx`
      : `${baseNoExt}.md`;
}

/**
 * The bundle DIR a managed skill doc addresses — `<...>/<name>/`, the folder
 * holding SKILL.md and its `references/` + `scripts/` siblings. Split out of
 * {@link managedArtifactAbsPath} so the store path can ask "does this bundle
 * still exist?" without re-deriving the resolution order, which is subtle
 * enough that a second copy would drift.
 */
function managedSkillBundleDir(
  scope: ManagedArtifactScope,
  name: string,
  ctx: ManagedArtifactLocation,
): string | null {
  // Guard 1: slug grammar (rejects `..`, slashes, dots, uppercase, empty).
  if (!SKILL_NAME_REGEX.test(name) || name.length > 64) {
    throw new Error(`managedSkillBundleDir: invalid skill name: ${JSON.stringify(name)}`);
  }
  const base = scope === 'global' ? homeFor(ctx) : ctx.projectDir;
  if (scope !== 'global') {
    // Project managed-artifact docs are the legacy `.ok/skills` content path;
    // project skills open as content docs, so this branch is effectively dead
    // and the project store drains via the boot migration.
    return resolve(base, '.ok', 'skills', name);
  }
  // Store retirement: in-place ALWAYS wins. Resolve the native editor-dir
  // canonical (`~/.agents/skills/<name>`, `~/.claude/skills/<name>`, …) first;
  // fall back to a legacy `~/.ok/skills` resident ONLY to keep reading one not
  // yet drained; NEVER DEFAULT a fresh write to the store. Defaulting to the
  // store re-created the `.ok/skills` remnant on every stray global write (a
  // global doc autosaving after the skill was moved away, etc.) — a skill with
  // neither native nor store lands at the in-place default home instead.
  //
  // That redirect chose a better PATH for a stray write; it did not stop one.
  // Preventing the write is the store guard's job, not this resolver's — see
  // the bundle-existence check in `storeManagedArtifactDoc`.
  const native = resolveGlobalNativeSkillDir(base, name);
  const storeDir = resolve(base, '.ok', 'skills', name);
  if (native !== null) return native;
  if (existsSync(resolve(storeDir, 'SKILL.md'))) return storeDir;
  const homeRel = resolveDefaultSkillHomeRel(base, 'global');
  return homeRel === null ? null : resolve(base, homeRel, name);
}

/**
 * The dir that must ALREADY exist for a managed-artifact write to be legal: a
 * managed skill's bundle dir, or an external skill's registered dir.
 * Persistence may create dirs INSIDE one of these (a `references/` for a
 * not-yet-written bundle file) and must never create the container itself,
 * because that resurrects an artifact its owner deleted.
 *
 * The two skill classes lose their container through different doors — a
 * managed skill through `move-scope` / delete, an external skill through a
 * harness-side delete OK never sees. The external case does not even need the
 * re-open race the managed case does: the registry is in-memory,
 * `unregisterExternalSkill` is never called outside tests, and
 * `externalSkillAbsPath` resolves from the map without touching disk, so a
 * registered entry outlives its directory for the whole process. It is also the
 * worst place to get this wrong: the resurrected dir lands under a harness root
 * (`~/.claude/skills/…`) that OK does not own.
 *
 * Null means "nothing to bound" (an unparsable / unregistered doc name); those
 * are already short-circuited upstream.
 */
function managedArtifactContainerDir(
  documentName: string,
  ctx: ManagedArtifactLocation,
): string | null {
  const ext = parseExternalSkillDocName(documentName);
  if (ext !== null) {
    // `rel: null` addresses SKILL.md, so its parent IS the registered dir.
    const abs = externalSkillAbsPath(ext.name, null);
    return abs === null ? null : dirname(abs);
  }
  const parsed = parseManagedArtifactName(documentName);
  if (parsed === null || parsed.kind !== 'skill') return null;
  return managedSkillBundleDir(parsed.scope, parsed.name, ctx);
}

export function managedArtifactAbsPath(documentName: string, ctx: ManagedArtifactLocation): string {
  // Editable-unmanaged skill: the real on-disk path lives in the external-skill
  // registry (keyed by name), NOT under any `.ok/` root — so it resolves through
  // the containment-guarded `externalSkillAbsPath`, not the scope-typed parse
  // below. Throws if unregistered so readers (`resolveDocPath`) fall back.
  const ext = parseExternalSkillDocName(documentName);
  if (ext !== null) {
    const abs = externalSkillAbsPath(ext.name, ext.rel);
    if (abs === null) {
      throw new Error(`managedArtifactAbsPath: external skill not registered: ${documentName}`);
    }
    // A bundle-file doc name is ext-less (`references/x`); bind it to the real
    // file on disk exactly as the managed bundle branch below. SKILL.md
    // (`rel === null`) already resolves to a concrete path.
    return ext.rel === null ? abs : resolveBundleFileOnDisk(abs);
  }
  const parsed = parseManagedArtifactName(documentName);
  if (parsed === null || parsed.kind !== 'skill') {
    throw new Error(`managedArtifactAbsPath: not a managed skill doc name: ${documentName}`);
  }
  const skillDir = managedSkillBundleDir(parsed.scope, parsed.name, ctx);
  if (skillDir === null) {
    throw new Error(`managedArtifactAbsPath: no usable skill home for ${documentName}`);
  }
  let abs: string;
  if (parsed.rel === null) {
    abs = resolve(skillDir, 'SKILL.md');
  } else {
    // A bundle FILE (`rel`, ext-less). Reject `..` / empty segments, then bind
    // the ext-less doc name to the real file on disk (`.md` preferred, `.mdx`
    // fallback, default `.md` for a not-yet-created file).
    const relSegs = parsed.rel.split('/').filter((s) => s !== '' && s !== '.');
    if (relSegs.length === 0 || relSegs.some((s) => s === '..')) {
      throw new Error(`managedArtifactAbsPath: invalid skill file path for ${documentName}`);
    }
    abs = resolveBundleFileOnDisk(resolve(skillDir, ...relSegs));
  }
  // Guard 2: containment on the resolved path. Cheap defense-in-depth — the slug
  // grammar in `managedSkillBundleDir` (guard 1, which now runs a call earlier)
  // plus the `..` reject above already forbid escape, so this only fires if that
  // grammar is ever weakened.
  if (!abs.startsWith(skillDir + sep)) {
    throw new Error(`managedArtifactAbsPath: path escape for ${documentName}`);
  }
  return abs;
}

/**
 * Reverse of {@link managedArtifactAbsPath}: map an on-disk leaf path back to its
 * `__skill__/<scope>/<name>` doc name, or `null` when the path is not a
 * well-formed managed skill leaf. Used by the global-skills watcher (`<home>/.ok/`
 * is watcher-excluded, so disk edits reach a live global-skill doc only via the
 * explicit managed-artifact watch).
 *
 * Applies the same slug grammar as the forward resolver so a path with an
 * invalid name segment is rejected rather than routed to a malformed doc name.
 */
export function managedArtifactDocNameForPath(
  absPath: string,
  ctx: ManagedArtifactCtx,
): string | null {
  const norm = resolve(absPath);
  // Skill bundle files under ANY global skill root — the legacy `~/.ok/skills`
  // store AND every native user root (`~/.agents/skills`, `~/.claude/skills`,
  // …): global skills live in-place now, and the skills watcher watches all of
  // these roots, so the reverse mapping must cover them all or native-root
  // events are silently dropped (an open-but-empty `__skill__/global/...` doc
  // then never seeds when its file lands). Doc names are name-keyed, so every
  // root maps to the same doc. Project skills are content docs, reconciled by
  // the content watcher, never mapped to a `__skill__/project/...` name here.
  for (const root of globalSkillGraphRoots(homeFor(ctx))) {
    const globalSkillsRoot = resolve(root);
    if (!norm.startsWith(globalSkillsRoot + sep)) continue;
    const rel = norm.slice(globalSkillsRoot.length + 1).split(sep);
    const name = rel[0];
    if (name && SKILL_NAME_REGEX.test(name) && name.length <= 64 && rel.length >= 2) {
      const tail = rel.slice(1);
      // `<name>/SKILL.md` → the skill's SKILL doc.
      if (tail.length === 1 && tail[0] === 'SKILL.md') {
        return `${MANAGED_ARTIFACT_PREFIX_SKILL}global/${name}`;
      }
      // A `.md`/`.mdx` bundle file → its per-file live doc (ext-less). Other
      // files (scripts, binary) are not editable live docs → no doc mapping.
      const last = tail[tail.length - 1] ?? '';
      if (/\.mdx?$/i.test(last) && !tail.includes('..')) {
        const relNoExt = tail.join('/').replace(/\.mdx?$/i, '');
        return `${MANAGED_ARTIFACT_PREFIX_SKILL}global/${name}/${relNoExt}`;
      }
    }
    return null; // under a global skills root but not an editable md doc
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

  // Templates are content docs now (`<folder>/.ok/templates/<name>`), hydrated
  // via the normal content persistence path. The retired `__template__/...`
  // synthetic name is a tombstone — refuse to seed it so a stale client name
  // never becomes a SECOND CRDT doc competing with the content doc for one file
  // (double-doc corruption), and never mints a lineage epoch for a dead name.
  if (documentName.startsWith(MANAGED_ARTIFACT_PREFIX_TEMPLATE)) return;

  // Editable-unmanaged skill whose external dir was never registered (e.g. a
  // server restart dropped the in-memory registry): nothing to seed, no-op —
  // don't let `managedArtifactAbsPath` throw out of `onLoadDocument`.
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
 * One-time, best-effort out-of-tree backup of an editable-unmanaged skill's
 * current on-disk bytes, taken right before OK first overwrites the live harness
 * file. Editable-unmanaged skills have NO version history (that's a managed-only
 * benefit), so this snapshot is the data-safety floor: a bad edit to a shared
 * team skill stays recoverable. Keyed by skill name under `<home>/.ok/edit-
 * backups/`; skipped if a backup already exists (one-time). A backup failure is
 * swallowed — recoverability is a bonus, never a gate on the user's edit.
 *
 * ponytail: keyed by name, so two same-named skills from different harnesses
 * share one backup slot (first-editor wins). Fine for the borrower-fixing-a-typo
 * case; key by a dir hash if multi-harness same-name editing becomes real.
 */
/** Bounded per-doc stash cap for reconcile-discarded edits (R7 data-safety). */
const DISCARDED_EDIT_STASH_MAX = 5;

/**
 * R7 data-safety half: when a store RECONCILES (disk diverged, disk wins), the
 * user's in-buffer bytes are replaced — stash them out-of-tree first so "keep
 * mine" stays possible by hand even before the interactive prompt exists.
 * Bounded per doc (oldest pruned); best-effort — a stash failure never blocks
 * the reconcile.
 */
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
      } catch {
        // Prune failure is cosmetic.
      }
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
  // Only snapshot the SKILL.md (rel === null); bundle files are secondary.
  if (ext.rel !== null) return;
  try {
    if (!existsSync(filePath)) return; // nothing to snapshot (new file)
    const backupDir = resolve(homeFor(ctx), '.ok', 'edit-backups', ext.name);
    const backupPath = resolve(backupDir, 'SKILL.md.bak');
    if (existsSync(backupPath)) return; // one-time
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
  // Project skills persist through the content path; never write the dead
  // `__skill__/project/...` synthetic doc back to disk (see load guard).
  const parsedStore = parseManagedArtifactName(documentName);
  if (parsedStore?.kind === 'skill' && parsedStore.scope === 'project') return 'no-op';

  // Templates persist through the content path; never write the retired
  // `__template__/...` synthetic doc back to disk (see load guard) — that would
  // create a literal `__template__/...` file.
  if (documentName.startsWith(MANAGED_ARTIFACT_PREFIX_TEMPLATE)) return 'no-op';

  // Editable-unmanaged skill whose external dir isn't registered: nothing to
  // write back to (see load guard).
  const extStore = parseExternalSkillDocName(documentName);
  if (extStore && externalSkillAbsPath(extStore.name, extStore.rel) === null) return 'no-op';

  if (lastTransactionOrigin === FILE_WATCHER_ORIGIN) return 'no-op';

  const content = document.getText('source').toString();
  const lkg = ctx.lkgCache.get(documentName);
  if (content === lkg) return 'no-op';

  // A doc may only write INTO a container that still exists; it may never bring
  // one back. The mkdir below is recursive, so without this a live doc whose
  // artifact was deleted (or moved to the other scope) re-creates the container
  // and lands a lone file in it — for a skill that means no `references/` and
  // no `scripts/`, because persistence carries one doc and never the sibling
  // files. The half-bundle then reads as a real skill to every scanner.
  //
  // Closing the live docs is not sufficient on its own, which is why this sits
  // here rather than in the delete/move handlers: the client re-opens the doc
  // it still has on screen, re-syncs its copy (itself a mutation), and the
  // debounce fires against the old path afterwards. This stat is the last thing
  // between a stale doc and a resurrected artifact.
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
    // Ensure the parent dir exists BEFORE acquiring the lock — `withFileLock`
    // creates the SIBLING `<filePath>.lock`, so a missing parent is an ENOENT on
    // acquire, not a busy lock (config docs dodge this because `.ok/` is
    // pre-created at init). This mkdir is recursive and therefore able to
    // create a whole skill bundle, which is not its job: the guard above proves
    // the bundle already exists, leaving this to create only the dirs INSIDE
    // one (`references/` for a not-yet-written reference file). Keep the guard
    // and this call together — alone, this one resurrects deleted skills.
    await tracedMkdir(resolve(filePath, '..'), { recursive: true });
    // Data-safety floor for editable-unmanaged skills (no version history): the
    // FIRST time we're about to overwrite a live harness skill file, snapshot its
    // current bytes out-of-tree so a bad edit stays recoverable. One-time,
    // best-effort — a backup failure never blocks the edit (see helper).
    if (extStore) await backupExternalSkillOnce(filePath, extStore, ctx);
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
              { documentName, err: readErr },
              'store: pre-write disk read failed (non-ENOENT); proceeding to write',
            );
          }
          disk = null;
        }
        if (disk !== null && disk !== lkg && disk !== content) {
          // The reconcile discards whatever the author had live under an origin
          // neither undo stack can reach, so it owes a restore anchor and a
          // loss-ring breadcrumb before it touches the doc. The counter fires
          // here rather than inside the hook so a ctx with no shadow plumbing
          // still records that live content was replaced.
          incrementManagedArtifactReconcile();
          const detect = ctx.beforeReconcileDivergence?.(document, documentName, content, disk);
          // Disk wins; the user's bytes are about to be replaced in the live
          // buffer — stash them first (R7 data-safety). Distinct recovery
          // surface from the anchor above: a plain capped file backup that
          // survives a ctx with no shadow plumbing.
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
