/**
 * `ok <file>` single-file open flow — the body the argv pre-dispatch
 * (`single-file-dispatch.ts`) routes to.
 *
 * Computes a project-aware plan via the shared `prepareSingleFileOpen` (realpath
 * BEFORE detection), then delivers:
 *   - **Project mode** — reuse the existing `ok open` deep-link/browser path.
 *   - **No-project mode** — desktop deep-link (`openknowledge://open?file=…`,
 *     desktop owns the ephemeral server + temp dir for deterministic close
 *     teardown) when a bundle is installed; otherwise a browser fallback that
 *     boots an ephemeral single-file server IN THIS process (so Ctrl-C /
 *     process-exit tears it down) serving the React shell single-origin, opens
 *     a tab, and removes the temp projectDir on teardown.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  encodeDocName,
  prepareSingleFileOpen,
  SingleFileNotAFileError,
  SingleFileNotFoundError,
  SingleFileNotMarkdownError,
  type SingleFileOpenPlan,
} from '@inkeep/open-knowledge-server';
import { createRealDetectDeps, type DetectResult, detectDesktop } from './desktop-dispatch.ts';
import { createRealOpenDeps, runOpen } from './open.ts';

/**
 * Idle-shutdown threshold for an ephemeral single-file session — shorter than a
 * project server's 30 min, but floored well above a laptop-sleep / WiFi-flap
 * reconnect window so a momentary disconnect mid-view does not reap (and delete
 * the temp dir of) a session the user is still looking at.
 */
const EPHEMERAL_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;

/** Injectable surface so `cli.test.ts` can drive the dispatch matrix without a
 *  real desktop / server / browser. */
export interface SingleFileOpenDeps {
  prepare: (filePath: string) => SingleFileOpenPlan;
  /** Absolute desktop bundle path when one is installed, else null. */
  detectBundlePath: () => string | null;
  /** Hand a URL / `openknowledge://` deep link to the OS to open. */
  openTarget: (target: string) => void;
  /** Reuse `ok open`'s project-mode deep-link/browser path. Returns exit code. */
  runProjectOpen: (docName: string, projectRoot: string) => number;
  /** Browser fallback — boot an ephemeral single-file server + open a tab. */
  runBrowserOpen: (plan: Extract<SingleFileOpenPlan, { mode: 'ephemeral' }>) => Promise<void>;
  log: (message: string) => void;
  error: (message: string) => void;
}

/**
 * Copy `process.env` minus `ELECTRON_RUN_AS_NODE` — mirrors `ok open`. The CLI
 * wrapper sets that var so the bundled Electron binary runs as a Node host;
 * leaking it to the LaunchServices-spawned target would start it headless and
 * exit immediately.
 */
function scrubElectronRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

export function createRealSingleFileOpenDeps(
  detect: () => DetectResult = () => detectDesktop(createRealDetectDeps()),
): SingleFileOpenDeps {
  return {
    prepare: prepareSingleFileOpen,
    detectBundlePath: () => detect().bundlePath ?? null,
    openTarget: (target) => {
      const child = nodeSpawn('open', [target], {
        detached: true,
        stdio: 'ignore',
        env: scrubElectronRunAsNode(process.env),
      });
      child.unref();
    },
    runProjectOpen: (docName, projectRoot) =>
      runOpen(docName, { project: projectRoot }, createRealOpenDeps()),
    runBrowserOpen: (plan) => runSingleFileBrowserOpen(plan),
    log: (message) => process.stdout.write(`${message}\n`),
    error: (message) => process.stderr.write(`${message}\n`),
  };
}

/**
 * Open `filePath` (an absolute path) in the editor. Returns a process exit code
 * (0 opened, 1 error). Never throws for the typed user-facing errors — they
 * render a clean one-line message. The browser fallback does NOT resolve until
 * the session is torn down (it owns the foreground process), so callers should
 * `await` and not assume an immediate return.
 */
export async function runSingleFileOpen(
  filePath: string,
  deps: SingleFileOpenDeps,
): Promise<number> {
  let plan: SingleFileOpenPlan;
  try {
    plan = deps.prepare(filePath);
  } catch (err) {
    if (
      err instanceof SingleFileNotFoundError ||
      err instanceof SingleFileNotAFileError ||
      err instanceof SingleFileNotMarkdownError
    ) {
      deps.error(err.message);
      return 1;
    }
    throw err;
  }

  if (plan.mode === 'project') {
    // Reuse the existing `ok open` project-doc path (desktop deep-link →
    // browser fallback). Mostly unchanged behavior.
    return deps.runProjectOpen(plan.docName, plan.projectRoot);
  }

  // No-project ephemeral mode. Desktop owns the server lifecycle (deterministic
  // close-teardown), so when a bundle is installed we hand it the file via a
  // deep-link and let main run the ephemeral bootstrap (re-running
  // `prepareSingleFileOpen` on its side — idempotent — the safety net).
  const bundlePath = deps.detectBundlePath();
  if (bundlePath) {
    const deepLink = `openknowledge://open?file=${encodeURIComponent(plan.canonicalFilePath)}`;
    deps.openTarget(deepLink);
    deps.log(`Opening ${plan.singleDocRelPath} in the OpenKnowledge desktop app.`);
    return 0;
  }

  // No desktop bundle → browser fallback. Boots the ephemeral server in THIS
  // process so Ctrl-C / exit tears it down. Does not return until the
  // session ends.
  await deps.runBrowserOpen(plan);
  return 0;
}

/**
 * Resolve the bundled React shell `dist` directory — published `dist/public`
 * first, then the monorepo `app/dist`. Mirrors `ok ui`'s resolution so dev and
 * published builds agree.
 */
function resolveReactShellDistDir(): string | undefined {
  const cliDir = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
  const candidates = [
    resolve(cliDir, 'public'), // npm install: dist/public/
    resolve(cliDir, '../../app/dist'), // monorepo dev from src/
    resolve(cliDir, '../../../app/dist'), // monorepo dev from dist/
  ];
  return candidates.find((p) => existsSync(p));
}

/**
 * Browser fallback: boot an ephemeral single-file server in this process
 * (serving the React shell single-origin via `--react-shell-dist-dir`, so there
 * is exactly ONE process + one temp dir to reap), open a tab at the doc, and
 * tear the whole session down on Ctrl-C / SIGTERM / exit. The finite
 * idle-shutdown (`bootStartServer`'s 30-min default) is the backstop for a bare
 * tab-close that never reaches this process (weaker than desktop's
 * deterministic close, documented).
 */
async function runSingleFileBrowserOpen(
  plan: Extract<SingleFileOpenPlan, { mode: 'ephemeral' }>,
): Promise<void> {
  const { createEphemeralProjectDir } = await import('@inkeep/open-knowledge-server');
  const { loadConfig } = await import('../index.ts');
  const { bootStartServer, resolveHost } = await import('./start.ts');
  const { openBrowser } = await import('../utils/open-browser.ts');

  const reactShellDistDir = resolveReactShellDistDir();
  if (!reactShellDistDir) {
    process.stderr.write(
      'OpenKnowledge UI assets were not found. Reinstall @inkeep/open-knowledge, or build the app (`bun run build`) in a monorepo checkout.\n',
    );
    process.exit(1);
  }

  const projectDir = createEphemeralProjectDir(plan.contentDir);

  let tornDown = false;
  let booted: Awaited<ReturnType<typeof bootStartServer>> | undefined;
  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    try {
      await booted?.destroy();
    } catch {
      // best-effort — we're exiting anyway
    }
    try {
      await rm(projectDir, { recursive: true, force: true });
    } catch {
      // best-effort; the dir is in os.tmpdir (OS-reaped) regardless
    }
  };

  // Register signal teardown BEFORE boot: a Ctrl-C during `bootStartServer`
  // (slow on cold imports / NFS mounts) must still reap the temp dir and any
  // partially-started server. `teardown()` is idempotent and no-ops
  // `booted?.destroy()` when boot never returned a session.
  const onSignal = (): void => {
    void teardown().then(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const { config } = loadConfig(projectDir);
  const host = resolveHost({}, process.env as { HOST?: string | undefined });

  try {
    booted = await bootStartServer({
      config,
      cwd: projectDir,
      host,
      port: 0,
      projectDir,
      singleFile: plan.canonicalFilePath,
      serveContentAssets: true,
      reactShellDistDir,
      // Ephemeral sessions self-reap sooner than a project server (and their
      // idle-shutdown also removes the temp dir — see bootStartServer). Floored
      // above a sleep/reconnect window so a momentary disconnect mid-view does
      // not reap a session the user is still in.
      idleThresholdMs: EPHEMERAL_IDLE_SHUTDOWN_MS,
    });
  } catch (err) {
    // Boot failed — reap via the same idempotent teardown as the signal path
    // (it no-ops `booted?.destroy()` when boot never returned a session).
    await teardown();
    process.stderr.write(
      `Failed to open ${plan.singleDocRelPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const url = `http://${host}:${booted.port}/#/${encodeDocName(plan.docName)}`;
  // Headless mode (an agent boot-on-demand spawn, `OK_SINGLE_FILE_NO_OPEN=1`):
  // boot + register + serve the session, but do NOT open a browser on this host
  // — the caller (the MCP `preview_url` file branch) discovers the session and
  // navigates its own in-app browser to the URL.
  const headless = process.env.OK_SINGLE_FILE_NO_OPEN === '1';
  if (headless) {
    process.stdout.write(`Serving ${plan.singleDocRelPath} (headless) at: ${url}\n`);
  } else {
    process.stdout.write(`Opening ${plan.singleDocRelPath} in your browser: ${url}\n`);
    process.stdout.write('Press Ctrl-C to close the session.\n');
    openBrowser(url);
  }

  // Hold the process open: the listening HTTP server keeps the event loop alive,
  // and this never-resolving await keeps `runSingleFileOpen` from returning into
  // the caller's `process.exit`. Teardown is signal-driven (registered above);
  // window/tab close has no CLI signal — the finite idle-shutdown backstop reaps
  // that case.
  await new Promise<never>(() => {});
}
