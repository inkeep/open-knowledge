/**
 * `ok uninstall` — reverse OpenKnowledge's whole outside-project footprint as
 * completely as it can find it: credentials, PATH shim, editor MCP configs,
 * skill bundles, application data, stale locks, and the `~/.ok` machinery dir —
 * plus an offer to `deinit` recent projects. Leaves the user's markdown content
 * (and `~/.ok/skills`) alone unless `--purge-content`.
 *
 * Never self-deletes the app binary (a running process can't cleanly remove its
 * own executable, and the CLI may live inside the app bundle). Instead it
 * detects how OK was installed and prints the exact removal command.
 *
 * Safe by default: a preview/dry-run, a confirmation that defaults to NO, and
 * surgical removal that never clobbers a user's non-OK config.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { findEnclosingProjectRoot } from '@inkeep/open-knowledge-server';
import checkbox from '@inquirer/checkbox';
import { Command } from 'commander';
import { desktopUserDataDir, readDesktopRecentProjects } from '../integrations/desktop-state.ts';
import { readPathInstallMarker } from '../integrations/path-shim.ts';
import { accent, dim, error as errorColor, info, success, warning } from '../ui/colors.ts';
import { confirmDestructive } from '../ui/confirm.ts';
import { discoverLockDirs } from '../utils/process-scan.ts';
import { buildUninstallPlan, type RunRemovalDeps, runRemoval } from './removal-plan.ts';
import {
  formatRemovalOutcome,
  formatRemovalPlan,
  removalOutcomeToJson,
  removalPlanToJson,
} from './removal-render.ts';

// ---------------------------------------------------------------------------
// Install-method detection (detect + instruct; never self-delete)
// ---------------------------------------------------------------------------

export interface InstallMethod {
  method: 'app' | 'npm-global' | 'npx';
  label: string;
  /** The exact command / action the user should run to finish removal. */
  instruction: string;
}

/**
 * Detect how OK is installed and return the removal instruction for each method
 * found. Best-effort + informational — the command prints these but never runs
 * them. Multiple can be present (an app install AND an npm CLI).
 */
export function detectInstallMethods(
  home: string,
  argv1: string | undefined,
  runNpmLs: (args: string[]) => string | null = defaultNpmLs,
  exists: (path: string) => boolean = existsSync,
): InstallMethod[] {
  const methods: InstallMethod[] = [];

  for (const app of [
    '/Applications/OpenKnowledge.app',
    join(home, 'Applications', 'OpenKnowledge.app'),
  ]) {
    if (exists(app)) {
      methods.push({
        method: 'app',
        label: `OK Desktop (${app})`,
        instruction: `Move ${app} to the Trash (or: rm -rf "${app}")`,
      });
    }
  }

  const npmOut = runNpmLs(['ls', '-g', '--depth=0', '@inkeep/open-knowledge']);
  if (npmOut?.includes('@inkeep/open-knowledge@')) {
    methods.push({
      method: 'npm-global',
      label: 'npm global install',
      instruction: 'npm uninstall -g @inkeep/open-knowledge',
    });
  }

  if (argv1 && /[/\\]_npx[/\\]/.test(argv1)) {
    methods.push({
      method: 'npx',
      label: 'npx (ephemeral)',
      instruction:
        'Nothing to uninstall — npx runs from a temporary cache. (Optional: npm cache clean --force)',
    });
  }

  return methods;
}

function defaultNpmLs(args: string[]): string | null {
  try {
    return execFileSync('npm', args, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // npm absent, not a global install, or the probe timed out — treat as "not
    // installed via npm global".
    return null;
  }
}

/** A banner rule the app-removal callout is bracketed with, so the one manual
 *  step OK can't do for itself doesn't get lost in the removal log. */
const CALLOUT_RULE = '━'.repeat(64);

/**
 * The app-binary-removal instructions, rendered as a bracketed banner (OK never
 * deletes its own running binary). Printed LAST by `runUninstall` so it's
 * the final, most-visible thing on screen.
 */
function formatInstallInstructions(methods: InstallMethod[]): string {
  const lines: string[] = [
    warning(CALLOUT_RULE),
    accent('  One more step — remove the OpenKnowledge app itself'),
    dim("  (OpenKnowledge can't delete its own running binary — do this by hand.)"),
    '',
  ];
  if (methods.length === 0) {
    lines.push(dim('  Install method not detected. If you installed it, remove it via:'));
    lines.push(`    ${info('OK Desktop')} — move /Applications/OpenKnowledge.app to the Trash`);
    lines.push(`    ${info('npm global')} — npm uninstall -g @inkeep/open-knowledge`);
    lines.push(`    ${info('npx')} — nothing to remove (runs from a temporary cache)`);
  } else {
    for (const m of methods) {
      lines.push(`  ${info(m.label)}`);
      lines.push(`    ${m.instruction}`);
    }
  }
  lines.push(warning(CALLOUT_RULE));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Recent-projects selection
// ---------------------------------------------------------------------------

interface ProjectCandidate {
  path: string;
  /** True when a server is currently running for this project. */
  running: boolean;
  /** True when this is the project the user is standing in. */
  current: boolean;
}

/** projectRoot from a lock dir (`<root>/.ok/local` → `<root>`). */
function projectRootFromLockDir(lockDir: string): string {
  return resolve(lockDir, '..', '..');
}

/** True iff `dir` is an existing project with a `.ok/` dir. */
function isDeinitableProject(dir: string): boolean {
  return existsSync(join(dir, '.ok'));
}

export interface ResolveRecentProjectsInput {
  home: string;
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd: string;
  lockDirs: string[];
  yes?: boolean;
  allProjects?: boolean;
  dryRun?: boolean;
  isTTY?: boolean;
  /** Test hook for the interactive checkbox. */
  promptFn?: (candidates: ProjectCandidate[]) => Promise<string[]>;
  /** Test hook for the recent-projects reader. */
  readRecents?: (userDataDir: string) => Array<{ path: string }>;
  /** Test hook for the enclosing-project resolver. */
  findRoot?: typeof findEnclosingProjectRoot;
}

/**
 * Resolve which project roots to `deinit`. Candidates are the union of the
 * desktop recent-projects list, currently-running servers, and the project the
 * user is standing in — but per-project removal is OPT-IN, so none are selected
 * by default:
 *   - `--all-projects` → every candidate.
 *   - `--yes` (alone) / non-interactive / `--dry-run` → none (global only).
 *   - interactive → only the projects the user ticks (unchecked by default).
 *
 * This keeps `ok uninstall` from silently stripping a repo's committed config +
 * OK edit-history just because a server was running or the user was standing in
 * it; `ok deinit` is the per-project tool.
 */
export async function resolveRecentDeinitProjects(
  input: ResolveRecentProjectsInput,
): Promise<string[]> {
  const findRoot = input.findRoot ?? findEnclosingProjectRoot;
  const readRecents = input.readRecents ?? readDesktopRecentProjects;

  const currentRoot = findRoot(input.cwd)?.rootPath ?? null;
  const userDataDir = desktopUserDataDir({
    home: input.home,
    platformName: input.platform,
    env: input.env,
  });

  const recentPaths = new Set<string>();
  for (const p of readRecents(userDataDir)) recentPaths.add(resolve(p.path));
  const runningRoots = new Set(input.lockDirs.map(projectRootFromLockDir));
  for (const r of runningRoots) recentPaths.add(r);
  if (currentRoot) recentPaths.delete(currentRoot); // handled as the `current` candidate

  const candidates: ProjectCandidate[] = [];
  if (currentRoot && isDeinitableProject(currentRoot)) {
    candidates.push({ path: currentRoot, running: runningRoots.has(currentRoot), current: true });
  }
  for (const p of recentPaths) {
    if (!isDeinitableProject(p)) continue; // skip removed / non-OK dirs
    candidates.push({ path: p, running: runningRoots.has(p), current: false });
  }
  if (candidates.length === 0) return [];

  // Selection — per-project removal is OPT-IN. `ok uninstall` removes the global
  // footprint; deiniting a project also strips its committed `.ok/config.yml`,
  // MCP entries, and OK edit-history (`.git/ok/`), so it must never happen to a
  // repo the user didn't explicitly pick (they may still be using it — the
  // current dir and running servers included).
  if (input.allProjects) return candidates.map((c) => c.path); // explicit: all
  if (input.yes) return []; // `--yes` alone = global only; add `--all-projects` for projects
  if (input.dryRun) return []; // a plain run selects nothing by default
  const tty = input.isTTY ?? process.stdout.isTTY;
  if (!tty) return []; // non-interactive without a flag: touch no project repo
  const prompt = input.promptFn ?? defaultProjectCheckbox;
  return prompt(candidates);
}

async function defaultProjectCheckbox(candidates: ProjectCandidate[]): Promise<string[]> {
  return checkbox({
    message:
      'Also remove OpenKnowledge from these projects? (space to toggle; none selected by default)\n' +
      "  Removes each project's .ok/ config, editor MCP entries, and OK edit-history\n" +
      '  (.git/ok/). Your markdown content is kept — `ok start` re-adds OK later.\n',
    required: false,
    theme: { icon: { checked: '[x]', unchecked: '[ ]' } },
    choices: candidates.map((c) => ({
      name: `${c.path}${c.current ? '  (current)' : ''}${c.running ? '  (running — will be stopped)' : ''}`,
      value: c.path,
      checked: false,
    })),
  });
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** Injectable seams for `runUninstall` — a named interface (not an anonymous
 *  inline type), matching `RepairSkillsDeps` etc. */
interface UninstallDeps {
  discoverLockDirs?: () => Promise<string[]>;
  resolveRecentProjects?: typeof resolveRecentDeinitProjects;
  detectInstallMethods?: typeof detectInstallMethods;
  /**
   * RunRemoval deps — lets a test stub the machine-touching primitives
   * (keychain / embeddings / stop-server) so the `--yes` success path can be
   * exercised end-to-end without touching the real OS keychain.
   */
  runRemovalDeps?: RunRemovalDeps;
}

export interface UninstallOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  host?: string;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  purgeContent?: boolean;
  allProjects?: boolean;
  isTTY?: boolean;
  argv1?: string;
  confirmStream?: NodeJS.ReadableStream;
  deps?: UninstallDeps;
}

export interface UninstallResult {
  status: 'dry-run' | 'cancelled' | 'done' | 'failed';
  message: string;
  exitCode: number;
}

const URL_SCHEME_NOTE = dim(
  'The openknowledge:// URL scheme deregisters itself once the app is removed — no action needed.',
);

export async function runUninstall(opts: UninstallOptions = {}): Promise<UninstallResult> {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const cwd = resolve(opts.cwd ?? process.cwd());
  const host = opts.host ?? 'github.com';
  const purgeContent = opts.purgeContent ?? false;

  const discoverLocks = opts.deps?.discoverLockDirs ?? discoverLockDirs;
  const resolveRecents = opts.deps?.resolveRecentProjects ?? resolveRecentDeinitProjects;
  const detectInstall = opts.deps?.detectInstallMethods ?? detectInstallMethods;

  const lockDirs = await discoverLocks();
  const marker = readPathInstallMarker(home);
  const recentDeinitProjectRoots = await resolveRecents({
    home,
    platform,
    env,
    cwd,
    lockDirs,
    yes: opts.yes,
    allProjects: opts.allProjects,
    dryRun: opts.dryRun,
    isTTY: opts.isTTY,
  });

  const plan = buildUninstallPlan({
    home,
    platform,
    env,
    host,
    lockDirs,
    marker,
    recentDeinitProjectRoots,
    purgeContent,
  });

  const fallbackNote = dim(
    'Individual projects are only removed when you select them (or pass --all-projects). ' +
      'To remove OpenKnowledge from one project, run `ok deinit` inside it.',
  );
  // Detection runs `npm ls -g` — compute it only on the paths that render it
  // (dry-run + a confirmed run), never on a cancel/refuse.
  const binaryBlock = (): string =>
    formatInstallInstructions(detectInstall(home, opts.argv1 ?? process.argv[1]));

  if (opts.dryRun) {
    // The app-removal callout goes LAST so it doesn't get buried in the plan.
    const body = opts.json
      ? JSON.stringify(removalPlanToJson(plan), null, 2)
      : [
          accent('Would remove (dry-run — no changes made):'),
          '',
          formatRemovalPlan(plan),
          '',
          fallbackNote,
          '',
          binaryBlock(),
        ].join('\n');
    return { status: 'dry-run', message: body, exitCode: 0 };
  }

  if (opts.json && !opts.yes) {
    return {
      status: 'failed',
      message: `${errorColor('Error:')} --json requires --yes (or --dry-run) so there is no interactive prompt.`,
      exitCode: 1,
    };
  }

  if (!opts.yes) {
    const tty = opts.isTTY ?? process.stdout.isTTY;
    if (!tty) {
      return {
        status: 'cancelled',
        message: `${errorColor('Aborted:')} refusing to uninstall non-interactively without --yes.`,
        exitCode: 1,
      };
    }
    process.stderr.write(
      `${accent('This will remove OpenKnowledge from your machine:')}\n\n${formatRemovalPlan(plan)}\n\n${warning('This cannot be undone.')}\n\n`,
    );
    const confirmed = await confirmDestructive(
      `${accent('Remove all of the above?')} ${dim('[y/N] ')}`,
      opts.confirmStream,
    );
    if (!confirmed) {
      return { status: 'cancelled', message: dim('Cancelled. Nothing was removed.'), exitCode: 0 };
    }
  }

  const outcome = await runRemoval(plan, opts.deps?.runRemovalDeps);

  const parts = [
    opts.json
      ? JSON.stringify(removalOutcomeToJson('uninstall', outcome), null, 2)
      : formatRemovalOutcome(outcome),
  ];
  if (!opts.json) {
    // Minor notes first; then the success line; then the app-removal callout
    // LAST so the one manual step is the final, most-visible thing on screen.
    parts.push('', fallbackNote, URL_SCHEME_NOTE);
    if (outcome.failed.length === 0) {
      parts.push('', success("OpenKnowledge's files have been removed from this machine."));
    }
    parts.push('', binaryBlock());
  }

  return {
    status: outcome.failed.length > 0 ? 'failed' : 'done',
    message: parts.join('\n'),
    exitCode: outcome.failed.length > 0 ? 1 : 0,
  };
}

export function uninstallCommand(): Command {
  return new Command('uninstall')
    .description(
      'Remove OpenKnowledge from your machine — credentials, PATH entries, editor MCP configs, skill bundles, app data, and ~/.ok. Keeps your markdown content and your authored skills (~/.ok/skills) unless --purge-content. Detects the app install and prints how to remove it; never self-deletes.',
    )
    .option(
      '-y, --yes',
      'Skip the confirmation prompt (removes the global footprint only; add --all-projects to also deinit projects)',
    )
    .option('--dry-run', 'Print the removal plan and exit without changing anything')
    .option('--json', 'Emit a machine-readable plan/outcome (requires --yes or --dry-run)')
    .option('--purge-content', 'Also remove user-authored content (~/.ok/skills)')
    .option(
      '--all-projects',
      'Also deinit every recent/running project (by default no project is removed — you pick them interactively)',
    )
    .action(
      async (options: {
        yes?: boolean;
        dryRun?: boolean;
        json?: boolean;
        purgeContent?: boolean;
        allProjects?: boolean;
      }) => {
        const result = await runUninstall({
          yes: options.yes,
          dryRun: options.dryRun,
          json: options.json,
          purgeContent: options.purgeContent,
          allProjects: options.allProjects,
        });
        process.stdout.write(`${result.message}\n`);
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
      },
    );
}
