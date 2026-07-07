/**
 * `ok config` command — inspect and maintain OpenKnowledge config files.
 *
 * Subcommands:
 *   - `validate` — load merged config (defaults → user → project) and report
 *     conformance. Exit 0 on success, exit 1 with source-located errors on
 *     failure. Success message goes to stderr (stdout is reserved for
 *     structured CI output, of which we emit none).
 *   - `migrate` — codemod removing deprecated fields (`sync.*`,
 *     `persistence.{debounceMs,maxDebounceMs}`, `server.port`, plus every
 *     entry in the shared removed-key registry) idempotently. Funnels through
 *     `writeConfigPatch` so atomic-write + Zod safeParse invariants apply
 *     automatically.
 */

import { existsSync, readFileSync } from 'node:fs';
import { type ConfigPatch, humanFormat, REMOVED_KEYS } from '@inkeep/open-knowledge-core';
import { resolveConfigPath, writeConfigPatch } from '@inkeep/open-knowledge-core/server';
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
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

interface ValidateOutcome {
  ok: boolean;
}

export function runValidate(opts: ValidateRunOpts = {}): ValidateOutcome {
  const log = opts.log ?? ((msg) => console.error(msg));
  const error = opts.error ?? ((msg) => console.error(msg));
  const load = opts.loadConfigFn ?? loadConfig;
  try {
    const { sources } = load(opts.cwd);
    const renderedSources = sources.length === 0 ? 'defaults only' : sources.join(', ');
    log(`✓ Configuration valid (sources: ${renderedSources})`);
    return { ok: true };
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return { ok: false };
  }
}

interface MigrateRunOpts {
  cwd?: string;
  scope?: 'project' | 'user' | 'both';
  dryRun?: boolean;
  homedirOverride?: string;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  writeConfigPatchFn?: typeof writeConfigPatch;
}

interface MigrateFileOutcome {
  path: string;
  scope: 'project' | 'user';
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

export async function runMigrate(opts: MigrateRunOpts = {}): Promise<MigrateOutcome> {
  const log = opts.log ?? ((msg) => console.log(msg));
  const error = opts.error ?? ((msg) => console.error(msg));
  const scope = opts.scope ?? 'both';
  const dryRun = opts.dryRun ?? false;
  const cwd = opts.cwd ?? process.cwd();
  const writePatch = opts.writeConfigPatchFn ?? writeConfigPatch;

  const targets: Array<{ scope: 'project' | 'user'; absPath: string }> = [];
  if (scope === 'project' || scope === 'both') {
    targets.push({
      scope: 'project',
      absPath: resolveConfigPath('project', cwd, opts.homedirOverride),
    });
  }
  if (scope === 'user' || scope === 'both') {
    targets.push({
      scope: 'user',
      absPath: resolveConfigPath('user', cwd, opts.homedirOverride),
    });
  }

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
    .option('--scope <scope>', 'Which scope to migrate: project | user | both', 'both')
    .option('--dry-run', 'Preview without writing', false)
    .action(async (subOpts) => {
      const scope = subOpts.scope as 'project' | 'user' | 'both';
      if (scope !== 'project' && scope !== 'user' && scope !== 'both') {
        console.error(`Invalid --scope: ${scope}. Expected: project | user | both`);
        process.exitCode = 2;
        return;
      }
      const outcome = await runMigrate({
        scope,
        dryRun: subOpts.dryRun as boolean,
      });
      if (!outcome.ok) {
        process.exitCode = 1;
      }
    });

  return cmd;
}
