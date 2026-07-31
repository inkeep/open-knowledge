/**
 * `ok config` command — inspect and maintain OpenKnowledge config files.
 *
 * Subcommands:
 *   - `validate` — load merged config (defaults → user → project) and report
 *     conformance, plus a reporting-only read of the project-local layer that
 *     the merge deliberately excludes. Exit 0 on success, exit 1 with
 *     source-located errors on failure. Success message goes to stderr (stdout
 *     is reserved for structured CI output, of which we emit none).
 *   - `migrate` — codemod removing deprecated fields (`sync.*`,
 *     `persistence.{debounceMs,maxDebounceMs}`, `server.port`, plus every
 *     entry in the shared removed-key registry) idempotently. Funnels through
 *     `writeConfigPatch` so atomic-write + Zod safeParse invariants apply
 *     automatically.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  type ConfigDiagnostic,
  type ConfigPatch,
  humanFormat,
  REMOVED_KEYS,
  type WriteScope,
} from '@inkeep/open-knowledge-core';
import {
  readConfigSafely,
  resolveConfigPath,
  writeConfigPatch,
} from '@inkeep/open-knowledge-core/server';
import { Command } from 'commander';
import { parseDocument } from 'yaml';
import { loadConfig } from '../config/loader.ts';

/**
 * Dotted-path tuples the engine no longer reads, stripped idempotently by the
 * codemod. Two groups:
 *
 * 1. Silently-dropped sections that never carried a user contract — `sync`
 *    collapses to a single key delete (all 7 subfields with it);
 *    `persistence.{debounceMs, maxDebounceMs}` and `server.port` are
 *    field-level deletes leaving their parent sections intact. These produce
 *    no `REMOVED_KEY` error; the codemod only tidies them away.
 * 2. Every entry in the shared removed-key registry — these DO hard-error on
 *    load, so sourcing them here keeps the "run `ok config migrate`" hint in
 *    each redirect truthful. `content.{include, exclude}` patterns must be
 *    recreated in `.okignore` manually; the codemod only removes the keys.
 */
export const DROPPED_FIELD_PATHS: ReadonlyArray<readonly string[]> = [
  ['sync'],
  ['persistence', 'debounceMs'],
  ['persistence', 'maxDebounceMs'],
  ['server', 'port'],
  ...REMOVED_KEYS.map((k) => k.path),
];

interface ValidateRunOpts {
  cwd?: string;
  loadConfigFn?: typeof loadConfig;
  /**
   * Reporting-only read of the project-local layer. Its own seam beside
   * `loadConfigFn` because `loadConfig` does not merge that layer, so a test
   * stubbing the loader would otherwise fall through to the real filesystem.
   */
  readProjectLocalFn?: (cwd: string) => readonly ConfigDiagnostic[];
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

interface ValidateOutcome {
  ok: boolean;
}

/**
 * Read `.ok/local/config.yml` for reporting only. `sideline: false` so
 * describing a corrupt layer never renames a user's file, and the parsed value
 * is discarded — this layer is deliberately outside `loadConfig`'s merge.
 */
function defaultReadProjectLocalDiagnostics(cwd: string): readonly ConfigDiagnostic[] {
  return readConfigSafely({
    absPath: resolveConfigPath('project-local', cwd),
    sideline: false,
  }).diagnostics;
}

export function runValidate(opts: ValidateRunOpts = {}): ValidateOutcome {
  const log = opts.log ?? ((msg) => console.error(msg));
  const error = opts.error ?? ((msg) => console.error(msg));
  const load = opts.loadConfigFn ?? loadConfig;
  try {
    const { sources, diagnostics, sidelined } = load(opts.cwd);
    // `loadConfig` merges two layers (user + committed project) and so can only
    // ever report on those two. `.ok/local/config.yml` is what
    // `readLinkPreviewsEnabled`, `readProjectLocalSemanticConfig`, and the
    // project-local `autoSync.mode` all read, so a `validate` blind to it hands
    // a user with a dead key there a ✓ and no way to find it without a running
    // server. Read it here purely for reporting: `sideline: false` so a corrupt
    // layer is described and never renamed, and the value is deliberately
    // discarded so `loadConfig`'s two-layer merge contract is untouched.
    const readProjectLocal = opts.readProjectLocalFn ?? defaultReadProjectLocalDiagnostics;
    const projectLocalDiagnostics = readProjectLocal(opts.cwd ?? process.cwd());
    const allDiagnostics = [...diagnostics, ...projectLocalDiagnostics];
    const renderedSources = sources.length === 0 ? 'defaults only' : sources.join(', ');
    // A removed key leaves the file usable, so it does not qualify the headline.
    // Every other code does: the layer's content was not honored, and claiming
    // "valid" sends a user who skims for the checkmark away believing nothing
    // is wrong. The label stays code-agnostic because this bucket mixes causes
    // — YAML_PARSE read fine but has a syntax error, SCHEMA_INVALID parsed but
    // failed validation, only UNREADABLE could not be read at all. `humanFormat`
    // below names the actual cause per layer.
    const degraded = allDiagnostics.filter((d) => d.code !== 'REMOVED_KEY');
    if (degraded.length === 0) {
      log(`✓ Configuration valid (sources: ${renderedSources})`);
    } else {
      log(
        `! Configuration loaded, but ${degraded.length} config layer(s) had issues ` +
          `(sources: ${renderedSources})`,
      );
    }
    // Removed keys no longer block loading, but the user should still see each
    // one and its migration path. Rendered with source location + replacement
    // guidance by humanFormat.
    for (const diagnostic of allDiagnostics) {
      log('');
      log(humanFormat(diagnostic));
    }
    // Loading an unreadable file renames it aside so OK can boot on defaults.
    // Say so — a command named `validate` that quarantines a file without a
    // word about it reads as the file having vanished.
    for (const { from, to } of sidelined) {
      log('');
      log(`Moved ${from} aside to ${to} so defaults could be used. Restore it once fixed.`);
    }
    return { ok: true };
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return { ok: false };
  }
}

/**
 * Requested migration scope. The three `WriteScope` values each name one
 * config file; `all` fans out to every layer; `both` is a supported legacy
 * alias covering project + user only (project-local excluded), so existing
 * invocations keep their exact reach.
 */
type MigrateScope = WriteScope | 'both' | 'all';

interface MigrateRunOpts {
  cwd?: string;
  scope?: MigrateScope;
  dryRun?: boolean;
  homedirOverride?: string;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  writeConfigPatchFn?: typeof writeConfigPatch;
}

interface MigrateFileOutcome {
  path: string;
  scope: WriteScope;
  /** Dotted paths that exist in the file. */
  found: string[];
  /** Dotted paths actually removed (== found unless dry-run or write failed). */
  removed: string[];
  /** Set when the file is unparseable or writeConfigPatch returned an error. */
  error?: string;
}

interface MigrateOutcome {
  outcomes: MigrateFileOutcome[];
  ok: boolean;
}

/**
 * Discover which dropped field paths exist in a YAML file via parseDocument's
 * `hasIn`. Returns the dotted-path strings for fields that ARE present (so
 * the migrator can build a patch only for those — keeps `appliedPaths` honest
 * + lets the run summary report exact counts). Throws on unparseable YAML —
 * the user must fix the file before migration runs.
 */
function findDroppedFields(absPath: string): string[] {
  const raw = readFileSync(absPath, 'utf-8');
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(`Could not parse ${absPath}: ${doc.errors.map((e) => e.message).join('; ')}`);
  }
  const present: string[] = [];
  for (const path of DROPPED_FIELD_PATHS) {
    if (doc.hasIn(path)) {
      present.push(path.join('.'));
    }
  }
  return present;
}

function isMutableObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Build the null-clear patch for a list of dropped paths. Cast to `ConfigPatch`
 * because the dropped fields are intentionally out-of-schema. At the runtime
 * layer, `applyPatchToDocument`'s null-walker calls `deleteIn` for each leaf
 * — works regardless of whether the path is in the schema.
 */
/**
 * Test-only re-export. Internal helper; subject to change without notice.
 */
export const buildClearPatchForTest = (paths: ReadonlyArray<readonly string[]>): ConfigPatch =>
  buildClearPatch(paths);

function buildClearPatch(paths: ReadonlyArray<readonly string[]>): ConfigPatch {
  const root: Record<string, unknown> = {};
  for (const path of paths) {
    let cur: Record<string, unknown> = root;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i] as string;
      const existing = cur[key];
      const next = isMutableObject(existing) ? existing : {};
      cur[key] = next;
      cur = next;
    }
    cur[path[path.length - 1] as string] = null;
  }
  return root as unknown as ConfigPatch;
}

/**
 * Expand a requested scope into the concrete config files to process, in
 * layer order. `all` covers every layer; `both` covers project + user only —
 * project-local is deliberately excluded so existing `both` invocations keep
 * their exact reach.
 */
function fileScopesForScope(scope: MigrateScope): WriteScope[] {
  switch (scope) {
    case 'project':
      return ['project'];
    case 'project-local':
      return ['project-local'];
    case 'user':
      return ['user'];
    case 'both':
      return ['project', 'user'];
    case 'all':
      return ['project', 'project-local', 'user'];
  }
}

export async function runMigrate(opts: MigrateRunOpts = {}): Promise<MigrateOutcome> {
  const log = opts.log ?? ((msg) => console.log(msg));
  const error = opts.error ?? ((msg) => console.error(msg));
  // Matches the command's `--scope` default. Two defaults that disagree would
  // make a programmatic call reach different files than the CLI invocation the
  // removed-key redirects tell users to run.
  const scope = opts.scope ?? 'all';
  const dryRun = opts.dryRun ?? false;
  const cwd = opts.cwd ?? process.cwd();
  const writePatch = opts.writeConfigPatchFn ?? writeConfigPatch;

  const targets = fileScopesForScope(scope).map((fileScope) => ({
    scope: fileScope,
    absPath: resolveConfigPath(fileScope, cwd, opts.homedirOverride),
  }));

  const outcomes: MigrateFileOutcome[] = [];
  let allOk = true;

  for (const { scope: targetScope, absPath } of targets) {
    if (!existsSync(absPath)) {
      outcomes.push({ path: absPath, scope: targetScope, found: [], removed: [] });
      continue;
    }
    let found: string[];
    try {
      found = findDroppedFields(absPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      outcomes.push({ path: absPath, scope: targetScope, found: [], removed: [], error: msg });
      allOk = false;
      continue;
    }
    if (found.length === 0 || dryRun) {
      outcomes.push({
        path: absPath,
        scope: targetScope,
        found,
        removed: [],
      });
      continue;
    }
    const presentTuples = DROPPED_FIELD_PATHS.filter((p) => found.includes(p.join('.')));
    const patch = buildClearPatch(presentTuples);
    const result = await writePatch({
      cwd,
      scope: targetScope,
      patch,
      homedirOverride: opts.homedirOverride,
    });
    if (!result.ok) {
      outcomes.push({
        path: absPath,
        scope: targetScope,
        found,
        removed: [],
        error: humanFormat(result.error),
      });
      allOk = false;
      continue;
    }
    outcomes.push({ path: absPath, scope: targetScope, found, removed: found });
  }

  // Errors always surface (even when no fields were found across other files);
  // missing them when totalFound === 0 would silently swallow parse failures.
  for (const o of outcomes) {
    if (o.error) {
      error(`✗ ${o.path}: ${o.error}`);
    }
  }

  const hasErrors = outcomes.some((o) => o.error !== undefined);
  const totalFound = outcomes.reduce((s, o) => s + o.found.length, 0);
  if (totalFound === 0 && !hasErrors) {
    log('No deprecated fields found.');
  } else if (totalFound > 0) {
    for (const o of outcomes) {
      if (o.error) continue; // already reported
      if (o.found.length === 0) {
        log(`  ${o.path}: no deprecated fields`);
      } else if (dryRun) {
        log(`[dry-run] ${o.path}: would remove ${o.found.length} field(s): ${o.found.join(', ')}`);
      } else {
        log(`✓ ${o.path}: removed ${o.removed.length} field(s): ${o.removed.join(', ')}`);
      }
    }
  }

  return { outcomes, ok: allOk };
}

/**
 * Scopes surfaced in `--scope` help and the invalid-scope error. `both` is a
 * supported alias, intentionally omitted here so it is accepted but not
 * advertised.
 */
const ADVERTISED_MIGRATE_SCOPES = 'project | project-local | user | all';

/**
 * Every accepted `--scope` value, including the unadvertised `both` alias.
 * Keyed by `MigrateScope` so widening that union without accepting the new
 * value here is a compile error rather than a confusing "Invalid --scope"
 * rejection of a type-valid input.
 */
const ACCEPTED_MIGRATE_SCOPES: Record<MigrateScope, true> = {
  project: true,
  'project-local': true,
  user: true,
  both: true,
  all: true,
};

/**
 * Membership view over the same source. Deliberately keyed by `string`: the
 * value being tested is untrusted CLI input, and a set narrowed to
 * `MigrateScope` could not accept it as an argument in the first place.
 */
const VALID_MIGRATE_SCOPES: ReadonlySet<string> = new Set(Object.keys(ACCEPTED_MIGRATE_SCOPES));

/**
 * Whether the CLI-wide startup notice should announce removed-key findings for
 * this invocation.
 *
 * False for the `config` command family, which owns that reporting: `validate`
 * renders the findings as its result and `migrate` is the act of removing them.
 * Announcing them first would print every finding twice.
 */
export function shouldAnnounceRemovedKeys(subcommandName: string | undefined): boolean {
  return subcommandName !== 'config';
}

export function configCommand(): Command {
  const cmd = new Command('config').description(
    'Inspect and maintain OpenKnowledge configuration files',
  );

  cmd
    .command('validate')
    .description('Validate the merged config (defaults → user → project)')
    .action(() => {
      const outcome = runValidate({});
      if (!outcome.ok) {
        process.exitCode = 1;
      }
    });

  cmd
    .command('migrate')
    .description(
      'Remove deprecated config fields from config.yml idempotently (every removed key in the registry — content.*, folders, appearance.editorModeDefault, server.host, etc. — plus the silently-dropped sync.*, persistence.*, server.port)',
    )
    // Defaults to `all` so the bare `ok config migrate` that every removed-key
    // redirect tells the user to run actually reaches the layer their dead key
    // sits in, project-local included. `both` stays accepted as the legacy
    // project+user reach. Widening the default is safe because the codemod only
    // ever deletes registry keys, is idempotent, and honors --dry-run.
    .option('--scope <scope>', `Which scope to migrate: ${ADVERTISED_MIGRATE_SCOPES}`, 'all')
    .option('--dry-run', 'Preview without writing', false)
    .action(async (subOpts) => {
      const rawScope = String(subOpts.scope);
      if (!VALID_MIGRATE_SCOPES.has(rawScope)) {
        console.error(`Invalid --scope: ${rawScope}. Expected: ${ADVERTISED_MIGRATE_SCOPES}`);
        process.exitCode = 2;
        return;
      }
      const outcome = await runMigrate({
        scope: rawScope as MigrateScope,
        dryRun: subOpts.dryRun as boolean,
      });
      if (!outcome.ok) {
        process.exitCode = 1;
      }
    });

  return cmd;
}
