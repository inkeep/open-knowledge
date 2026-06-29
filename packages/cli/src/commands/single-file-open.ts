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

const EPHEMERAL_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;

/** Injectable surface so `cli.test.ts` can drive the dispatch matrix without a
 *  real desktop / server / browser. */
export interface SingleFileOpenDeps {
  prepare: (filePath: string) => SingleFileOpenPlan;
  detectBundlePath: () => string | null;
  openTarget: (target: string) => void;
  runProjectOpen: (docName: string, projectRoot: string) => number;
  runBrowserOpen: (plan: Extract<SingleFileOpenPlan, { mode: 'ephemeral' }>) => Promise<void>;
  log: (message: string) => void;
  error: (message: string) => void;
}

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
    return deps.runProjectOpen(plan.docName, plan.projectRoot);
  }

  const bundlePath = deps.detectBundlePath();
  if (bundlePath) {
    const deepLink = `openknowledge://open?file=${encodeURIComponent(plan.canonicalFilePath)}`;
    deps.openTarget(deepLink);
    deps.log(`Opening ${plan.singleDocRelPath} in the OpenKnowledge desktop app.`);
    return 0;
  }

  await deps.runBrowserOpen(plan);
  return 0;
}

function resolveReactShellDistDir(): string | undefined {
  const cliDir = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
  const candidates = [
    resolve(cliDir, 'public'), // npm install: dist/public/
    resolve(cliDir, '../../app/dist'), // monorepo dev from src/
    resolve(cliDir, '../../../app/dist'), // monorepo dev from dist/
  ];
  return candidates.find((p) => existsSync(p));
}

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
    } catch {}
    try {
      await rm(projectDir, { recursive: true, force: true });
    } catch {}
  };

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
      idleThresholdMs: EPHEMERAL_IDLE_SHUTDOWN_MS,
    });
  } catch (err) {
    await teardown();
    process.stderr.write(
      `Failed to open ${plan.singleDocRelPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const url = `http://${host}:${booted.port}/#/${encodeDocName(plan.docName)}`;
  const headless = process.env.OK_SINGLE_FILE_NO_OPEN === '1';
  if (headless) {
    process.stdout.write(`Serving ${plan.singleDocRelPath} (headless) at: ${url}\n`);
  } else {
    process.stdout.write(`Opening ${plan.singleDocRelPath} in your browser: ${url}\n`);
    process.stdout.write('Press Ctrl-C to close the session.\n');
    openBrowser(url);
  }

  await new Promise<never>(() => {});
}
