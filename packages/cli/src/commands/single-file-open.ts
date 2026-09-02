import { rm } from 'node:fs/promises';
import {
  encodeDocName,
  type PrepareSingleFileOpenOptions,
  prepareSingleFileOpen,
  SingleFileNotAFileError,
  SingleFileNotFoundError,
  SingleFileNotMarkdownError,
  type SingleFileOpenPlan,
  SingleFileProjectOverrideError,
} from '@inkeep/open-knowledge-server';
import type { SpawnDetachedScrubbedOutcome } from '../utils/detached-spawn.ts';
import {
  type OpenTargetOptions,
  openTargetFailureMessage,
  openTarget as openTargetReal,
} from '../utils/open-target.ts';
import { createRealDetectDeps, type DetectResult, detectDesktop } from './desktop-dispatch.ts';
import { createRealOpenDeps, runOpen } from './open.ts';

const EPHEMERAL_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;

export interface SingleFileOpenDeps {
  prepare: (filePath: string, options?: PrepareSingleFileOpenOptions) => SingleFileOpenPlan;
  detectBundlePath: () => string | null;
  openTarget: (
    target: string,
    options?: Pick<OpenTargetOptions, 'desktopBundlePath'>,
  ) => Promise<SpawnDetachedScrubbedOutcome>;
  runProjectOpen: (docName: string, projectRoot: string) => Promise<number>;
  runBrowserOpen: (plan: Extract<SingleFileOpenPlan, { mode: 'ephemeral' }>) => Promise<void>;
  log: (message: string) => void;
  error: (message: string) => void;
}

export function createRealSingleFileOpenDeps(
  detect: () => DetectResult = () => detectDesktop(createRealDetectDeps()),
): SingleFileOpenDeps {
  return {
    prepare: prepareSingleFileOpen,
    detectBundlePath: () => detect().bundlePath ?? null,
    openTarget: openTargetReal,
    runProjectOpen: (docName, projectRoot) =>
      runOpen(docName, { project: projectRoot }, createRealOpenDeps()),
    runBrowserOpen: (plan) => runSingleFileBrowserOpen(plan),
    log: (message) => process.stdout.write(`${message}\n`),
    error: (message) => process.stderr.write(`${message}\n`),
  };
}

export interface SingleFileOpenOptions {
  projectRoot?: string;
}

export async function runSingleFileOpen(
  filePath: string,
  deps: SingleFileOpenDeps,
  options: SingleFileOpenOptions = {},
): Promise<number> {
  let plan: SingleFileOpenPlan;
  try {
    plan = deps.prepare(filePath, { projectRoot: options.projectRoot });
  } catch (err) {
    if (
      err instanceof SingleFileNotFoundError ||
      err instanceof SingleFileNotAFileError ||
      err instanceof SingleFileNotMarkdownError ||
      err instanceof SingleFileProjectOverrideError
    ) {
      deps.error(err.message);
      return 1;
    }
    throw err;
  }

  if (plan.mode === 'project') {
    return await deps.runProjectOpen(plan.docName, plan.projectRoot);
  }

  const bundlePath = deps.detectBundlePath();
  if (bundlePath) {
    const deepLink = `openknowledge://open?file=${encodeURIComponent(plan.canonicalFilePath)}`;
    const outcome = await deps.openTarget(deepLink, { desktopBundlePath: bundlePath });
    if (!outcome.ok) {
      deps.error(
        `Could not open the OpenKnowledge desktop app: ${openTargetFailureMessage(
          outcome.reason,
          deepLink,
        )}.`,
      );
      return 1;
    }
    deps.log(`Opening ${plan.singleDocRelPath} in the OpenKnowledge desktop app.`);
    return 0;
  }

  await deps.runBrowserOpen(plan);
  return 0;
}

async function runSingleFileBrowserOpen(
  plan: Extract<SingleFileOpenPlan, { mode: 'ephemeral' }>,
): Promise<void> {
  const { createEphemeralProjectDir } = await import('@inkeep/open-knowledge-server');
  const { loadConfig } = await import('../index.ts');
  const { bootStartServer, resolveBundledReactShellDir, resolveHost } = await import('./start.ts');
  const { openBrowser } = await import('../utils/open-browser.ts');

  const reactShellDistDir = resolveBundledReactShellDir();
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
      await booted?.destroy('external-signal');
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
