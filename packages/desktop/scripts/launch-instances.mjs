#!/usr/bin/env node
/**
 * Launch one or more isolated OpenKnowledge desktop instances in parallel (macOS).
 *
 * A bare second launch of the app can't run: Electron keys its single-instance
 * lock on the `userData` directory (and Chromium storage + recents live there),
 * so the second process fails `requestSingleInstanceLock()` and quits. Giving
 * each instance its own `--user-data-dir` yields a distinct lock AND isolated
 * storage, so N instances coexist. This is the only mechanism that works for the
 * PACKAGED app — `OK_INSTANCE` (a sibling dev-only env knob) is gated to
 * `!app.isPackaged` and does not apply here.
 *
 * Each instance opens its named project by pre-seeding that instance's own
 * `state.json` `lastOpenedProject` — the cold-start restore opens it. (An
 * `openknowledge://` URL in argv only routes via the second-instance path, so it
 * is NOT honored by a fresh primary instance; pre-seeding is the per-instance
 * targetable path. The `state.json` shape mirrors `AppState` in
 * `src/main/state-store.ts` — keep in sync if that schema changes.)
 *
 * Launches are STAGGERED: each instance is given time to acquire its project's
 * `<contentDir>/.ok/local/server.lock` before the next starts. Booting two at
 * the same millisecond races and drops one project to the Navigator.
 *
 * Usage:
 *   node scripts/launch-instances.mjs <name>=<projectPath> [<name>=<projectPath> ...]
 *   bun run desktop:instances -- work=~/code/proj-a review=~/code/proj-b
 *
 * Flags / env:
 *   --app <path>  (or OK_DESKTOP_APP)  path to the built .app
 *                 default: dist-desktop/mac-arm64/OpenKnowledge.app (run `bun run build:dir` first)
 *   --user-data-root <dir>  base dir for per-instance userData (default: ~/.ok/instances)
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

if (process.platform !== 'darwin') {
  console.error(
    'launch-instances: macOS only (uses `open`). The OpenKnowledge desktop is macOS-only.',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const pairs = [];
  let appPath = process.env.OK_DESKTOP_APP ?? null;
  let userDataRoot = join(homedir(), '.ok', 'instances');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--app') {
      appPath = argv[++i];
    } else if (arg === '--user-data-root') {
      userDataRoot = expandHome(argv[++i]);
    } else if (arg.includes('=')) {
      const idx = arg.indexOf('=');
      const name = arg.slice(0, idx);
      const project = arg.slice(idx + 1);
      if (!name || !project)
        throw new Error(`Bad instance spec "${arg}" (expected <name>=<projectPath>)`);
      pairs.push({ name, project: resolve(expandHome(project)) });
    } else {
      throw new Error(`Unrecognized argument "${arg}"`);
    }
  }
  return { pairs, appPath, userDataRoot };
}

function expandHome(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

function resolveAppPath(flagPath) {
  if (flagPath) {
    const abs = resolve(expandHome(flagPath));
    if (!existsSync(abs)) throw new Error(`--app path not found: ${abs}`);
    return abs;
  }
  // Default: the unsigned local build output, relative to this package.
  const pkgRoot = resolve(import.meta.dirname, '..');
  const candidate = join(pkgRoot, 'dist-desktop', 'mac-arm64', 'OpenKnowledge.app');
  if (!existsSync(candidate)) {
    throw new Error(
      `No built app at ${candidate}.\n` +
        `Build it first:  bun run build:dir   (from packages/desktop)\n` +
        `or pass an explicit --app <path> / set OK_DESKTOP_APP.`,
    );
  }
  return candidate;
}

function ensureGitRepo(project) {
  if (!existsSync(project)) mkdirSync(project, { recursive: true });
  if (existsSync(join(project, '.git'))) return;
  // openProject falls back to the Navigator on a non-git folder; init so the
  // project actually opens.
  execFileSync('git', ['-C', project, 'init', '-q']);
}

// Mirrors the required AppState fields in src/main/state-store.ts (schemaVersion 1).
function emptyState() {
  return {
    recentProjects: [],
    lastOpenedProject: null,
    versionPendingInstall: null,
    attemptedInstall: null,
    lastSeenVersion: null,
    lastSuccessfulCheckAt: null,
    stuckHintShown: false,
    dismissedRepairForBundle: null,
    projectSessions: {},
    schemaVersion: 1,
    lastUsedProjectParent: null,
    pendingWindowRestore: null,
    spellCheckEnabled: true,
  };
}

function seedState(userDataDir, project, name) {
  mkdirSync(userDataDir, { recursive: true });
  const statePath = join(userDataDir, 'state.json');
  // Merge into an existing state.json if present so we don't clobber fields this
  // script doesn't know about (forward-compatible with schema additions).
  let state = emptyState();
  if (existsSync(statePath)) {
    try {
      state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf-8')) };
    } catch {
      // Corrupt — overwrite with a clean minimal doc.
    }
  }
  const now = new Date().toISOString();
  const recents = Array.isArray(state.recentProjects) ? state.recentProjects : [];
  const withoutThis = recents.filter((r) => r && r.path !== project);
  state.recentProjects = [{ path: project, name, lastOpenedAt: now }, ...withoutThis].slice(0, 20);
  state.lastOpenedProject = project;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
}

function launch(appPath, userDataDir) {
  // `open -n` starts a NEW, detached instance that survives this process;
  // `--args` passes the Chromium `--user-data-dir` switch to it.
  const child = spawn('open', ['-n', appPath, '--args', `--user-data-dir=${userDataDir}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function waitForServerLock(project, timeoutMs = 30000) {
  const lock = join(project, '.ok', 'local', 'server.lock');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(lock)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const { pairs, appPath, userDataRoot } = parseArgs(process.argv.slice(2));
  if (pairs.length === 0) {
    console.error(
      'Usage: node scripts/launch-instances.mjs <name>=<projectPath> [<name>=<projectPath> ...]',
    );
    process.exit(2);
  }
  const app = resolveAppPath(appPath);
  console.log(`app: ${app}`);
  for (const { name, project } of pairs) {
    const userDataDir = isAbsolute(userDataRoot)
      ? join(userDataRoot, name)
      : resolve(userDataRoot, name);
    ensureGitRepo(project);
    seedState(userDataDir, project, name);
    launch(app, userDataDir);
    process.stdout.write(`launched "${name}" -> ${project}  (userData: ${userDataDir}) … `);
    const ready = await waitForServerLock(project);
    console.log(ready ? 'ready' : 'still booting (continuing)');
  }
  console.log(
    `\n${pairs.length} instance(s) launched. Each runs independently; quit a window to stop it.`,
  );
}

main().catch((err) => {
  console.error(`launch-instances: ${err.message}`);
  process.exit(1);
});
