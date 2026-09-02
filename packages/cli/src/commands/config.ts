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

export const DROPPED_FIELD_PATHS: ReadonlyArray<readonly string[]> = [
  ['sync'],
  ['persistence', 'debounceMs'],
  ['persistence', 'maxDebounceMs'],
  ...REMOVED_KEYS.map((k) => k.path),
];

interface ValidateRunOpts {
  cwd?: string;
  loadConfigFn?: typeof loadConfig;
  readProjectLocalFn?: (cwd: string) => readonly ConfigDiagnostic[];
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

interface ValidateOutcome {
  ok: boolean;
}

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
    const readProjectLocal = opts.readProjectLocalFn ?? defaultReadProjectLocalDiagnostics;
    const projectLocalDiagnostics = readProjectLocal(opts.cwd ?? process.cwd());
    const allDiagnostics = [...diagnostics, ...projectLocalDiagnostics];
    const renderedSources = sources.length === 0 ? 'defaults only' : sources.join(', ');
    const degraded = allDiagnostics.filter((d) => d.code !== 'REMOVED_KEY');
    if (degraded.length === 0) {
      log(`✓ Configuration valid (sources: ${renderedSources})`);
    } else {
      log(
        `! Configuration loaded, but ${degraded.length} config layer(s) had issues ` +
          `(sources: ${renderedSources})`,
      );
    }
    for (const diagnostic of allDiagnostics) {
      log('');
      log(humanFormat(diagnostic));
    }
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
  found: string[];
  removed: string[];
  error?: string;
}

interface MigrateOutcome {
  outcomes: MigrateFileOutcome[];
  ok: boolean;
}

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
      if (o.error) continue;
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

const ADVERTISED_MIGRATE_SCOPES = 'project | project-local | user | all';

const ACCEPTED_MIGRATE_SCOPES: Record<MigrateScope, true> = {
  project: true,
  'project-local': true,
  user: true,
  both: true,
  all: true,
};

const VALID_MIGRATE_SCOPES: ReadonlySet<string> = new Set(Object.keys(ACCEPTED_MIGRATE_SCOPES));

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
      'Remove deprecated config fields from config.yml idempotently (every removed key in the registry — content.*, folders, appearance.editorModeDefault, server.host, etc. — plus the silently-dropped sync.*, persistence.*)',
    )
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
