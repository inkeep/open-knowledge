#!/usr/bin/env node

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
  execFileSync('git', ['-C', project, 'init', '-q']);
}

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
  let state = emptyState();
  if (existsSync(statePath)) {
    try {
      state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf-8')) };
    } catch {
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
