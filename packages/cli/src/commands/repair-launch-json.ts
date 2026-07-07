/**
 * Startup sweep that rewrites stale OK-managed `.claude/launch.json` entries
 * forward to today's canonical published shape.
 *
 * Sibling of `repair-mcp-configs.ts`. Targets the single project-scoped
 * `.claude/launch.json` rather than the fan-out of editor host configs:
 * Claude Code Desktop's preview pane is the only consumer of this file
 * (read via `preview_start("open-knowledge-ui")`), so there is no user-
 * scope analogue and no per-editor iteration.
 *
 * Runs from `bootStartServer` (CLI `ok start`), alongside `repairMcpConfigs`.
 * Reads the existing `open-knowledge-ui` configuration entry, classifies it,
 * and re-invokes `scaffoldLaunchJson` only when the entry matches a legacy
 * bare-npx shape — anything else (version pin, dev mode, foreign customized
 * shape) is left untouched.
 *
 * Fail-soft. File read/write failures emit a structured event via the
 * injected logger and do not propagate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isObject } from '../utils/is-object.ts';
import {
  LAUNCH_CONFIG_NAME,
  LAUNCH_JSON_CANONICAL_ARGS,
  LAUNCH_UI_CHAIN_SENTINEL,
  type LaunchJsonResult,
  scaffoldLaunchJson,
} from './init.ts';

// Legacy npx-`ui` forms that `ok init` wrote before the recipe switched to
// the `# ok-ui-v1` `ok start` chain. All three launched a bare UI with no
// collab server — the exact worktree-hang the chain fixes — so they migrate
// forward. Includes the prior published `@latest ui` form (LAUNCH_JSON_CANONICAL_ARGS)
// and the two pre-`@latest` bare forms (which additionally triggered npm's
// engine-aware downgrade in `npm-pick-manifest`). Any OTHER npx shape (`@beta`,
// `@0.4.0`, a custom subcommand) is a deliberate user pin and is left alone.
const LEGACY_NPX_UI_FORMS: ReadonlyArray<readonly string[]> = [
  ['@inkeep/open-knowledge', 'ui'],
  ['-y', '@inkeep/open-knowledge', 'ui'],
  LAUNCH_JSON_CANONICAL_ARGS,
];

export type LaunchJsonEntryClassification = 'canonical' | 'legacy-bare' | 'preserved';

/**
 * Pure classifier for an existing launch.json configuration entry. Exported
 * for direct unit testing. Unlike MCP config repair, launch.json has no
 * namespace-ownership semantics, so custom command shapes are preserved.
 *
 * - `canonical` — the current `# ok-ui-v1` `/bin/sh` chain; no repair.
 * - `legacy-bare` — an earlier npx-`ui` shape (any of `LEGACY_NPX_UI_FORMS`)
 *   OR an older `# ok-ui-vN` chain we own but no longer ship; rewriting forward
 *   to the current chain unwedges the worktree-no-collab-server hang (and, for
 *   the bare-npx forms, npm's engine-aware stale-release downgrade).
 * - `preserved` — anything else: version-pinned npx, a foreign `/bin/sh`
 *   command, `node /path/cli.mjs` dev mode, custom command, foreign-customized
 *   args, or any shape we don't recognize. Left alone — preserving user intent
 *   matters more than aggressive normalization.
 */
export function classifyLaunchJsonEntry(
  entry: Record<string, unknown>,
): LaunchJsonEntryClassification {
  // The `/bin/sh` chain shapes (published + dev) carry a `# ok-ui-vN` sentinel
  // in `args[2]`. The current sentinel → canonical; an older one we own →
  // migrate forward. A `/bin/sh` entry WITHOUT an ok-ui sentinel is a user's
  // own command → preserved.
  if (entry.runtimeExecutable === '/bin/sh' && Array.isArray(entry.runtimeArgs)) {
    const chain = entry.runtimeArgs[2];
    if (typeof chain === 'string') {
      if (chain.includes(LAUNCH_UI_CHAIN_SENTINEL)) return 'canonical';
      if (/# ok-ui-v\d+/.test(chain)) return 'legacy-bare';
    }
    return 'preserved';
  }
  if (entry.runtimeExecutable === 'npx' && Array.isArray(entry.runtimeArgs)) {
    for (const form of LEGACY_NPX_UI_FORMS) {
      if (argsExactlyMatch(entry.runtimeArgs, form)) return 'legacy-bare';
    }
  }
  return 'preserved';
}

// Keep semantics in sync with `argsExactlyMatch` in `repair-mcp-configs.ts` —
// both classifiers depend on byte-exact argv matching for their canonical /
// legacy-bare predicates. If you need to change matching here (e.g.
// case-insensitive or order-insensitive), update the sibling in lockstep.
function argsExactlyMatch(actual: readonly unknown[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

export interface LaunchJsonRepairOutcome {
  configPath: string;
  /**
   * - `no-file` — `.claude/launch.json` does not exist (no `ok init`
   *   against Claude yet, or user removed it). Distinct from
   *   `no-entry` so diagnostics can tell "never wired up" apart from
   *   "user removed our entry."
   * - `no-entry` — file exists but contains no configuration named
   *   `open-knowledge-ui`; user-curated state, do not recreate.
   * - `read-failed` — file exists but couldn't be parsed (malformed JSON,
   *   non-object root, configurations not an array). Surfaced for
   *   diagnostics; treated as a no-op to avoid stomping on a file the
   *   user is mid-edit.
   * - `canonical` / `preserved` — entry exists and is in a shape we
   *   should not rewrite (see classifier docs).
   * - `repaired` — legacy bare-npx entry rewritten forward to canonical.
   * - `write-failed` — repair attempted but the file write failed
   *   (permissions, disk full, etc.).
   */
  outcome:
    | 'no-file'
    | 'no-entry'
    | 'read-failed'
    | 'canonical'
    | 'preserved'
    | 'repaired'
    | 'write-failed'
    | 'skipped-reclaim-disabled';
  error?: string;
}

export interface LaunchJsonRepairResult {
  outcome: LaunchJsonRepairOutcome;
  repairedCount: 0 | 1;
}

export interface LaunchJsonRepairLogEvent {
  event: string;
  /** Present on per-file events; absent on the sweep-level skip event. */
  configPath?: string;
  error?: string;
  reason?: string;
}

export interface LaunchJsonRepairContext {
  /** Absolute path to the project root. The sweep targets `<projectDir>/.claude/launch.json`. */
  projectDir: string;
  /** Sink for the structured per-file event. Default: stderr JSON-lines. */
  logger?: (event: LaunchJsonRepairLogEvent) => void;
  /**
   * Value of `process.env.OK_RECLAIM_DISABLE` — '1' short-circuits the sweep
   * with a structured `launch-json-repair-skipped` event. Mirrors the env
   * gate in the sibling MCP sweep and the new CLI `repairSkills` sweep.
   */
  reclaimDisableEnv?: string | null;
}

/**
 * Sweep `<projectDir>/.claude/launch.json` and rewrite a legacy bare-npx
 * `open-knowledge-ui` entry forward to today's canonical shape. Single-file
 * sweep — there is no fan-out and no user-scope analogue (launch.json is
 * project-local by Claude's design).
 *
 * Fail-soft. IO failures are captured in the returned outcome and emitted as
 * a structured event via the injected logger — neither propagates. The
 * default logger (`process.stderr.write`) does not throw; a caller that
 * injects a logger which CAN throw should defend at the call site, the same
 * way `bootStartServer` wraps the MCP repair sweep with an outer try/catch.
 */
export function repairLaunchJson(ctx: LaunchJsonRepairContext): LaunchJsonRepairResult {
  const logger = ctx.logger ?? defaultLogger;
  const configPath = join(ctx.projectDir, '.claude', 'launch.json');

  if (ctx.reclaimDisableEnv === '1') {
    logger({ event: 'launch-json-repair-skipped', reason: 'reclaim-disabled' });
    return {
      outcome: { configPath, outcome: 'skipped-reclaim-disabled' },
      repairedCount: 0,
    };
  }

  if (!existsSync(configPath)) {
    return { outcome: { configPath, outcome: 'no-file' }, repairedCount: 0 };
  }

  // Read-and-classify pass. We deliberately don't reuse `scaffoldLaunchJson`'s
  // read path: that helper conflates read with write and would auto-create
  // the entry on a malformed root, which is not what we want here. Repair
  // is forward-migration of existing entries only — never proactive creation.
  let parsed: unknown;
  try {
    const raw = readFileSync(configPath, 'utf-8').trim();
    parsed = raw ? JSON.parse(raw) : {};
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger({ event: 'launch-json-repair-read-failed', configPath, error });
    return { outcome: { configPath, outcome: 'read-failed', error }, repairedCount: 0 };
  }

  if (!isObject(parsed)) {
    // Symmetric with the JSON parse-error path above: emit the structured
    // event before returning `read-failed` so operators tailing stderr
    // JSON-lines see structurally-broken files surface, not just unparseable
    // ones.
    const error = 'launch.json root is not an object';
    logger({ event: 'launch-json-repair-read-failed', configPath, error });
    return {
      outcome: { configPath, outcome: 'read-failed', error },
      repairedCount: 0,
    };
  }

  const configs = parsed.configurations;
  if (!Array.isArray(configs)) {
    return { outcome: { configPath, outcome: 'no-entry' }, repairedCount: 0 };
  }

  const existing = configs.find(
    (c): c is Record<string, unknown> =>
      isObject(c) && (c as Record<string, unknown>).name === LAUNCH_CONFIG_NAME,
  );
  if (!existing) {
    return { outcome: { configPath, outcome: 'no-entry' }, repairedCount: 0 };
  }

  const classification = classifyLaunchJsonEntry(existing);
  if (classification === 'canonical') {
    return { outcome: { configPath, outcome: 'canonical' }, repairedCount: 0 };
  }
  if (classification === 'preserved') {
    return { outcome: { configPath, outcome: 'preserved' }, repairedCount: 0 };
  }

  // legacy-bare → rewrite via the canonical write path. `scaffoldLaunchJson`
  // owns the merge-and-replace semantics: it locates the entry by `name`,
  // replaces it with today's published-mode shape, and preserves any other
  // configurations alongside. `mode: 'published'` is correct here — the
  // sweep only fires from `bootStartServer` in production, never dev.
  const writeResult: LaunchJsonResult = scaffoldLaunchJson(ctx.projectDir, { mode: 'published' });
  if (writeResult.action === 'failed') {
    const error = writeResult.error ?? 'unknown write failure';
    logger({ event: 'launch-json-repair-write-failed', configPath, error });
    return { outcome: { configPath, outcome: 'write-failed', error }, repairedCount: 0 };
  }

  logger({ event: 'launch-json-repair-applied', configPath });
  return { outcome: { configPath, outcome: 'repaired' }, repairedCount: 1 };
}

function defaultLogger(event: LaunchJsonRepairLogEvent): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}
