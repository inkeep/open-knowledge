/**
 * Persistence-time validation + LKG-backed revert for config docs.
 *
 * Three-layer defense-in-depth: this is L3 (server-side last line of
 * defense). L1 (Modal walker) and L2 (`writeConfigPatch` headless writer)
 * already validate before reaching here; L3 catches malicious/buggy clients,
 * schema drift, and external hand-edits that bypass L1/L2.
 *
 * On success, atomically writes Y.Text content to the resolved config path
 * (project or user-global). On failure, reverts Y.Text via
 * `CONFIG_VALIDATION_REVERT_ORIGIN` to the in-memory LKG cache and fires
 * `onConfigRejected` so the upstream CC1 emitter (`emitConfigValidationRejected`)
 * can broadcast to any connected Settings pane.
 *
 * Per-server-instance LKG cache: a `Map<docName, string>` holding the most
 * recent successfully-validated YAML string. Initialized on doc load by
 * reading the file from disk; falls back to schema-defaults serialized as
 * YAML when disk is missing, empty, or invalid (cold-start recovery).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
import { tracedMkdir, tracedRename, tracedUnlinkSync, tracedWriteFile } from './fs-traced.ts';
import { getLogger } from './logger.ts';
import { getMeter } from './telemetry.ts';

/**
 * Map a documentName to the OTel `config.scope` enum attribute.
 * Returns `undefined` for non-config docs (caller should never invoke this
 * helper for those; config-persistence's branches are isConfigDoc-gated).
 *
 * `__config__/okignore` reports as `'project'` because the file is per-
 * project and shares the project tab in Settings — re-using an existing
 * label value keeps the bounded set deterministic for Prometheus index
 * growth (current set: project, project-local, user).
 */
function configScopeAttr(documentName: string): WriteScope | undefined {
  if (documentName === CONFIG_DOC_NAME_PROJECT) return 'project';
  if (documentName === CONFIG_DOC_NAME_PROJECT_LOCAL) return 'project-local';
  if (documentName === CONFIG_DOC_NAME_USER) return 'user';
  if (documentName === CONFIG_DOC_NAME_OKIGNORE) return 'project';
  return undefined;
}

/**
 * Lazy-init OTel counter for okignore L3 rejections. Same pattern as
 * `frontmatter-telemetry.ts` and `api-extension.ts` — the meter binds against
 * whatever provider is registered when `add(1)` first fires, so the counter
 * works whether `initTelemetry()` ran before or after this module loaded.
 *
 * Bounded-cardinality discipline: the only allowed label is the
 * `error.code` enum (a single value today — `'OKIGNORE_INVALID'` — but the
 * label key is reserved so future codes don't break the metric).
 */
let _okignoreRejectionCounter: Counter | null = null;
function okignoreRejectionCounter(): Counter {
  _okignoreRejectionCounter ||= getMeter().createCounter('ok.config.ignore.rejection_total', {
    description: 'Count of okignore L3 rejections by error code.',
  });
  return _okignoreRejectionCounter;
}

/**
 * Drop the cached okignore rejection counter so the next call rebinds against
 * the currently-registered global MeterProvider. Test-only — production code
 * never needs this because the global provider is set once via `initTelemetry()`.
 */
export function __resetOkignoreTelemetryForTests(): void {
  _okignoreRejectionCounter = null;
}

/**
 * Emit one span event per Zod issue when validation fails with SCHEMA_INVALID.
 * Bounded enum attributes only on the parent span; per-issue paths land in
 * span events to keep cardinality bounded.
 *
 * The narrowing dance via `isKnownConfigError` is the canonical pattern for
 * the discriminated-union-plus-forward-compat-tail shape — without it, TS
 * sees `error.issues` as `unknown` because the tail variant doesn't carry it.
 */
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
  /** Project root — project config resolves to `<projectDir>/.ok/config.yml`. */
  projectDir: string;
  /**
   * Content directory — `__config__/okignore` resolves to `<contentDir>/.okignore`.
   * Defaults to `projectDir` when absent (the typical case where contentDir
   * and projectDir coincide).
   */
  contentDir?: string;
  /**
   * Per-server-instance LKG cache. Maps each well-known config doc name
   * (`__config__/project`, `__local__/project`, `__user__/config.yml`,
   * `__config__/okignore`) to the most recent successfully-validated body.
   * Cleared at server shutdown.
   */
  lkgCache: Map<string, string>;
  /**
   * Override `os.homedir()` for tests. User-global config resolves to
   * `<homedir>/.ok/global.yml`; tests use a tempdir override
   * so they don't touch the developer's real `~/`.
   */
  homedirOverride?: string;
  /**
   * Fired synchronously after a validation rejection completes (Y.Text
   * already reverted to LKG). Wired in standalone boot to
   * `cc1Broadcaster.emitConfigValidationRejected(docName, error)`.
   */
  onConfigRejected?: (docName: string, error: ConfigValidationError) => void;
  /**
   * No-project ephemeral single-file mode. When `true`, `storeConfigDoc`
   * is a no-op for `__config__/okignore` — that write targets
   * `<contentDir>/.okignore` (the user's real directory), the one
   * contentDir-pollution path of a split projectDir/contentDir boot.
   * In ephemeral mode the config Y.Docs aren't materialized, so this hook
   * never fires for them anyway; the flag makes the no-write invariant
   * structural.
   */
  ephemeral?: boolean;
}

/** Resolve the on-disk path for a well-known config doc name. */
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

/**
 * Schema-defaults serialized as YAML. Used as the LKG fallback when no
 * prior valid state exists (cold-start, disk broken, disk empty).
 *
 * Module-level memoized at first use because `ConfigSchema.parse({})`
 * runs every Zod default callback synchronously.
 */
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

/**
 * Validate a `.okignore` body. The library `npm:ignore` does NOT throw on
 * syntactically broken patterns (gitignore has essentially no formal syntax
 * errors per git's own spec), so the L3 rule is intentionally narrow:
 *
 *   - Empty body → accepted (cold-start, before any pattern is added).
 *   - Truly empty line (`""` between `\n`s) → accepted (round-tripped blank).
 *   - Comment line (`# …` after trim) → accepted (round-tripped metadata).
 *   - Whitespace-only line (`/^\s+$/` — non-empty but trims to empty) →
 *     rejected. The user typed a row, hit Enter, and committed a pattern
 *     that contains no useful pattern characters.
 *   - Anything else → accepted; client-side heuristic warnings flag the
 *     practical-mistake classes.
 */
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

/**
 * Per-doc-name validator dispatch. YAML config docs route through the
 * existing `validateConfigYaml`; the `__config__/okignore` text doc routes
 * through `validateOkignore`. Keeping `validateConfigYaml` UNTOUCHED is
 * load-bearing — the YAML+ConfigSchema path serves the existing two docs
 * and any change there has knock-on effects on `writeConfigPatch` callers.
 */
function validateConfigContent(documentName: string, content: string): ValidConfig | InvalidConfig {
  if (documentName === CONFIG_DOC_NAME_OKIGNORE) {
    return validateOkignore(content);
  }
  return validateConfigYaml(content);
}

/**
 * Cold-start LKG fallback when no prior valid state exists. YAML config
 * docs fall back to schema-defaults YAML; `__config__/okignore` falls back
 * to an empty string so the revert path always has a valid floor that
 * matches the Settings empty-state rendering.
 */
function defaultLkgFor(documentName: string): string {
  if (documentName === CONFIG_DOC_NAME_OKIGNORE) return '';
  return serializedDefaults();
}

/**
 * Parse + validate a YAML string against `ConfigSchema`. Empty input is
 * valid (parses to null → coerced to `{}` → defaults applied — same
 * convention as `writeConfigPatch`).
 */
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

/**
 * Seed a config doc's Y.Text from disk + initialize the LKG cache entry.
 * Idempotent: re-seeds only when Y.Text is empty.
 *
 * The seed transaction uses `CONFIG_VALIDATION_REVERT_ORIGIN`
 * (`skipStoreHooks: true`) so Hocuspocus does NOT fire `onStoreDocument`
 * for the load mutation — lazy file creation means admitting a doc must
 * never auto-write disk.
 *
 * LKG behavior:
 * - Disk valid + non-empty                → LKG = disk bytes
 * - Disk missing/empty/invalid (YAML)     → LKG = schema-defaults YAML
 * - Disk missing/empty/invalid (okignore) → LKG = '' (cold-start floor;
 *   `defaultLkgFor` returns `''` for okignore because empty body is a
 *   valid 'no patterns' state per `validateOkignore`).
 *
 * The disk-invalid case does NOT fire `onConfigRejected` from the load path
 * (`readConfigSafely` already sidelines broken user-global files at boot,
 * before the synthetic doc is admitted). The persistence-hook
 * `storeConfigDoc` will surface a rejection on the first invalid Y.Text
 * mutation.
 */
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
      console.warn(`[config] Could not read ${filePath}: ${detail}. Seeding with empty content.`);
      raw = '';
    }
  }

  const validation = validateConfigContent(documentName, raw);
  if (!validation.ok && raw.length > 0) {
    // Surface invalid disk content so operators see "your config has
    // errors" at boot rather than discovering it only via the L3 hook
    // when the next mutation triggers a revert. The Y.Text is still
    // seeded with the raw content so a UI can display + repair it.
    getLogger('config-persistence').warn(
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
}

async function atomicWriteConfig(absPath: string, content: string): Promise<void> {
  await tracedMkdir(dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.tmp.${crypto.randomUUID()}`;
  try {
    await tracedWriteFile(tmpPath, content, 'utf-8');
    await tracedRename(tmpPath, absPath);
  } catch (e) {
    try {
      tracedUnlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

/**
 * Outcome surfaced by `storeConfigDoc` for tests + telemetry.
 *
 * - `'persisted'`: validated successfully and written to disk; LKG updated.
 * - `'reverted'`: validation failed; Y.Text reverted to LKG; `onConfigRejected` fired.
 * - `'write-failed'`: validation passed but the disk write threw (disk full,
 *   permissions, parent dir replaced by file, etc.); `onConfigRejected` fired
 *   with `WRITE_ERROR`. Y.Text is NOT reverted (content was valid) and LKG is
 *   NOT updated, so the next mutation re-attempts the write naturally.
 * - `'reconciled'`: another writer (a different OK process) landed on the
 *   shared config file since our LKG was set; we imported their disk content
 *   into Y.Text under `CONFIG_FILE_WATCHER_ORIGIN` instead of clobbering.
 *   The user's most recent local mutation is dropped in favor of the other
 *   writer's value. Without this, two windows toggling Settings would lose
 *   updates silently.
 * - `'no-op'`: entry-gate matched (revert origin); for non-okignore docs
 *    (YAML), Y.Text empty (unconditional — empty YAML body is always
 *    treated as spurious); for `__config__/okignore`, Y.Text empty with
 *    LKG absent or at the empty-string cold-start floor; or content
 *    equals LKG.
 */
type StoreConfigDocOutcome = 'persisted' | 'reverted' | 'write-failed' | 'no-op' | 'reconciled';

/**
 * Persistence-time validation hook for a config doc (L3).
 *
 * Entry-gate at top: if `lastTransactionOrigin === CONFIG_VALIDATION_REVERT_ORIGIN`,
 * skip — belt-and-suspenders alongside the origin's `skipStoreHooks: true`.
 *
 * Two short-circuits prevent spurious writes:
 *  - Empty-body guard (doc-type dispatched):
 *    - non-okignore (YAML): empty Y.Text always no-ops; there is no UI path
 *      that empties a YAML body, so an empty Y.Text is treated as spurious.
 *    - `__config__/okignore`: empty Y.Text no-ops when LKG is absent or at
 *      the empty-string cold-start floor `loadConfigDoc` installs when no
 *      validly-persisted disk state exists (disk missing, empty, or
 *      invalid); with non-empty LKG the empty body is the user's intent
 *      (e.g. removed the last pattern) and falls through to the write path.
 *  - LKG-equality guard: content matches LKG → load path just seeded us
 *    from disk, no write needed.
 */
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
  // 'persisted' / 'reconciled' / 'no-op' → success; 'reverted' → reverted;
  // 'write-failed' → rejected. A reconciliation is a successful completion
  // of the hook (the cross-process race was caught and resolved).
  if (outcome === 'reverted') return 'reverted';
  if (outcome === 'write-failed') return 'rejected';
  return 'success';
}

async function storeConfigDocInner(
  document: Y.Doc,
  documentName: string,
  lastTransactionOrigin: unknown,
  ctx: ConfigPersistenceCtx,
): Promise<StoreConfigDocOutcome> {
  // belt: in no-project single-file mode, the `__config__/okignore` store
  // targets `<contentDir>/.okignore` (the user's real directory). That config
  // doc isn't materialized in ephemeral mode, so this never fires — but the
  // guard makes the no-user-dir-write invariant structural.
  if (ctx.ephemeral && documentName === CONFIG_DOC_NAME_OKIGNORE) return 'no-op';
  if (lastTransactionOrigin === CONFIG_VALIDATION_REVERT_ORIGIN) return 'no-op';

  const ytext = document.getText('source');
  const content = ytext.toString();

  const lkg = ctx.lkgCache.get(documentName);

  // Empty body is ambiguous and the meaning is doc-type-specific.
  if (content.length === 0) {
    // For YAML config docs (CONFIG_DOC_NAME_PROJECT / _PROJECT_LOCAL /
    // _USER): always no-op on empty body. The load path (`loadConfigDoc`)
    // is the only sanctioned path that should write a YAML file initially,
    // and there is no UI affordance that empties a previously-non-empty
    // YAML body — an empty YAML Y.Text is therefore always spurious.
    if (documentName !== CONFIG_DOC_NAME_OKIGNORE) return 'no-op';

    // For `__config__/okignore`: empty body has two distinct meanings:
    //  - LKG absent OR equal to the okignore cold-start floor (''):
    //    `loadConfigDoc` installs `''` when no validly-persisted disk
    //    state exists (disk missing, empty, or invalid). Empty Y.Text in
    //    this state means the load path found no valid content to seed —
    //    short-circuit
    //    so we don't lazily create a 0-byte `.okignore`.
    //  - LKG holds a non-empty prior value: empty Y.Text is the user's
    //    intent (e.g. they removed the last pattern via Settings). Fall
    //    through so the validator and atomic-write advance disk + LKG to
    //    '' and chokidar can fan the change back to ContentFilter.
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

  // Ensure the parent dir exists *before* acquiring the lock — the lockfile
  // sits next to the target config (e.g. `~/.ok/global.yml.lock`), so a
  // missing parent would fail `openSync(lockPath, 'wx')` with ENOENT
  // before lazy-first-write ever runs `atomicWriteConfig`'s own mkdir.
  // Failures here (EACCES, ENOSPC) must surface as `'write-failed'`
  // rather than propagate uncaught into Hocuspocus's `onStoreDocument`.
  try {
    await tracedMkdir(dirname(filePath), { recursive: true });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    getLogger('config-persistence').warn(
      { docName: documentName, path: filePath, err: e },
      `[config-persistence] could not create parent dir for ${filePath}: ${detail}`,
    );
    ctx.onConfigRejected?.(documentName, {
      code: 'WRITE_ERROR',
      detail: `Could not create parent directory for ${filePath}: ${detail}`,
    });
    return 'write-failed';
  }

  // Lock-protected disk section. Two open OK windows from different
  // projects each run their own Hocuspocus server with its own Y.Doc
  // for `__user__/config.yml`; both write to the shared `~/.ok/global.yml`.
  // Without serialization, writer B can read disk after writer A's
  // last-known LKG was set but before B observed A's write — B's Y.Text
  // is then stale, and B's atomic-write silently overwrites A's keys.
  // chokidar fans the disk back into Y.Text with ~300 ms latency, which
  // re-imports B's clobbered value into A and produces the persistent
  // cross-window divergence the user reports (theme reverts, editor mode
  // reverts).
  //
  // Inside the lock: re-read disk; if it diverged from our LKG, another
  // writer landed and our content is stale — validate the disk content
  // and, if valid, import it into Y.Text under CONFIG_FILE_WATCHER_ORIGIN
  // (`skipStoreHooks: true`, so this does NOT recurse) and report
  // 'reconciled'. If the disk has diverged but is INVALID (corrupted,
  // hand-edited typo, schema-incompatible), we must NOT import it — that
  // would poison `lkgCache` and create a stuck revert loop on the next
  // mutation. Instead, log and fall through to write our (already-validated)
  // content, which is the safe outcome.
  try {
    return await withFileLock(
      `${filePath}.lock`,
      async () => {
        let diskContent: string | null = null;
        try {
          diskContent = readFileSync(filePath, 'utf-8');
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            // EACCES / EIO / EMFILE / etc — don't silently fall through
            // to the write path. Falling through here would re-enable
            // the cross-window clobber (we'd overwrite
            // disk we couldn't observe).
            const detail = e instanceof Error ? e.message : String(e);
            getLogger('config-persistence').warn(
              { docName: documentName, path: filePath, err: e },
              `[config-persistence] could not read config for reconciliation: ${detail}`,
            );
            ctx.onConfigRejected?.(documentName, {
              code: 'WRITE_ERROR',
              detail: `Could not read config for reconciliation at ${filePath}: ${detail}`,
            });
            return 'write-failed';
          }
          // ENOENT: lazy first-write — leave null, fall through to write
        }

        if (diskContent !== null && lkg !== undefined && diskContent !== lkg) {
          const diskValidation = validateConfigContent(documentName, diskContent);
          if (diskValidation.ok) {
            document.transact(() => {
              if (ytext.length > 0) ytext.delete(0, ytext.length);
              ytext.insert(0, diskContent);
            }, CONFIG_FILE_WATCHER_ORIGIN);
            ctx.lkgCache.set(documentName, diskContent);
            getLogger('config-persistence').info(
              { docName: documentName, path: filePath },
              '[config-persistence] reconciled: external writer landed; imported disk into Y.Text',
            );
            return 'reconciled';
          }
          // Disk diverged but content is invalid — don't poison Y.Text or
          // LKG. Our content was already validated above the lock; writing
          // it here replaces the disk's broken state with valid bytes.
          getLogger('config-persistence').warn(
            { docName: documentName, path: filePath },
            '[config-persistence] disk diverged from LKG but contains invalid content; proceeding with local write',
          );
        }

        try {
          await atomicWriteConfig(filePath, content);
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          // Surface the write failure to operators in headless sessions
          // where no Settings pane is mounted to observe the
          // `onConfigRejected` callback. Disk-full / permissions /
          // parent-replaced-by-file are otherwise invisible — the L3 hook
          // returns silently and the next mutation re-attempts indefinitely.
          getLogger('config-persistence').warn(
            { docName: documentName, path: filePath, err: e },
            `[config-persistence] write-failed at ${filePath}: ${detail}`,
          );
          ctx.onConfigRejected?.(documentName, {
            code: 'WRITE_ERROR',
            detail: `Failed to persist config at ${filePath}: ${detail}`,
          });
          return 'write-failed';
        }
        ctx.lkgCache.set(documentName, content);
        return 'persisted';
      },
      {
        onWarn: (message, context) => {
          getLogger('config-persistence').warn(context, `[config-persistence] ${message}`);
        },
      },
    );
  } catch (e) {
    // `withFileLock` throws `FileLockTimeoutError` when the lockfile is
    // held past the acquire timeout (5s default) and the holder hasn't
    // exceeded the stale-lock threshold. Surfacing this as 'write-failed'
    // (vs. propagating into Hocuspocus's onStoreDocument) keeps the
    // persistence extension stable; the user's mutation is preserved in
    // Y.Text and re-attempts on next store. Any other thrown error is
    // unexpected and should propagate so the operator sees it.
    if (e instanceof FileLockTimeoutError) {
      getLogger('config-persistence').warn(
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

/**
 * Outcome surfaced by `applyExternalConfigChange` for tests + telemetry.
 *
 * - `'applied'`: external content was valid; Y.Text replaced under
 *   `CONFIG_FILE_WATCHER_ORIGIN`; LKG updated.
 * - `'rejected'`: external content failed validation; Y.Text NOT mutated;
 *   `onConfigRejected` fired so the caller can broadcast CC1.
 * - `'no-op'`: content equals LKG (self-write reflection or unchanged
 *   external read), OR the document was not loaded.
 */
type ApplyExternalConfigChangeOutcome = 'applied' | 'rejected' | 'no-op';

/**
 * Apply an externally-detected config file change.
 *
 * Called by the file-watcher orchestration when chokidar fires a change
 * event. Mirrors `storeConfigDoc` but inverted: disk → Y.Text rather than
 * Y.Text → disk.
 *
 * Self-write detection uses the LKG cache: when persistence writes content
 * `C` to disk, it sets `lkgCache[doc] = C`. When the watcher reads `C` back
 * (chokidar fires for OUR own write), this comparison short-circuits before
 * any Y.Text mutation. The residual race (rename completes before LKG
 * updates) is benign — Y.Text would be replaced with content it already
 * holds, which Yjs handles as an idempotent no-op delta.
 *
 * The Y.Text mutation runs under `CONFIG_FILE_WATCHER_ORIGIN`
 * (`skipStoreHooks: true`) so the persistence-hook does NOT re-write the
 * file we just read. Without this, every external edit would generate a
 * redundant disk write before the LKG-equality check fires next time.
 *
 * On invalid YAML or schema fail: Y.Text is NOT mutated (stays at LKG);
 * `onConfigRejected` fires so the caller can emit a CC1 broadcast for any
 * open Settings pane to surface the rejection toast.
 */
export function applyExternalConfigChange(
  document: Y.Doc | null,
  documentName: string,
  content: string,
  ctx: ConfigPersistenceCtx,
): ApplyExternalConfigChangeOutcome {
  if (!document) return 'no-op';

  const lkg = ctx.lkgCache.get(documentName);
  if (lkg !== undefined && lkg === content) return 'no-op';

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
    return 'rejected';
  }

  const ytext = document.getText('source');
  document.transact(() => {
    if (ytext.length > 0) ytext.delete(0, ytext.length);
    ytext.insert(0, content);
  }, CONFIG_FILE_WATCHER_ORIGIN);

  ctx.lkgCache.set(documentName, content);
  return 'applied';
}
