import { resolve } from 'node:path';
import { type Config, isProcessAlive, resolveLockDir } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { getInvocationCwd } from '../project-anchor.ts';
import { discoverLockDirs } from '../utils/process-scan.ts';
import { inspectLock } from './lock-state.ts';
import { runPs } from './ps.ts';
import {
  findLockDirByNumber,
  isStoppableState,
  runStop,
  type StopOutcome,
} from './stop-execution.ts';
import { buildStopV1, stopV1Failure } from './stop-v1.ts';

export {
  buildStopPlan,
  findLockDirByNumber,
  probeCollabClients,
  runStop,
} from './stop-execution.ts';

import type { V1Project, V1StopTarget } from './supervision-json-v1.ts';
import { addV1FormatOption, writeV1Document } from './supervision-json-v1-output.ts';

async function executeStop(lockDir: string, force: boolean): Promise<StopOutcome> {
  const outcome = await runStop({ lockDir, force });
  if (outcome.failed.length > 0 || outcome.declined !== undefined) process.exitCode = 1;
  return outcome;
}

export function formatNoTargetMessage(
  targetDir: string,
  otherRunningServers: number,
  opts: {
    listingFollows?: boolean;
  } = {},
): string {
  if (otherRunningServers === 0) {
    return `Nothing was running for ${targetDir}, and no other open-knowledge servers are running.`;
  }
  const agreement = otherRunningServers === 1 ? ' is' : 's are';
  const pointer = opts.listingFollows === true ? '' : ' — run `ok ps` to list them';
  return (
    `Nothing was running for ${targetDir}. ${otherRunningServers} other open-knowledge server` +
    `${agreement} running${pointer}.`
  );
}

async function countOtherRunningServers(exceptLockDir: string): Promise<number> {
  const lockDirs = await discoverLockDirs();
  let count = 0;
  for (const lockDir of lockDirs) {
    if (lockDir === exceptLockDir) continue;
    if (isStoppableState(inspectLock(lockDir, 'server'), isProcessAlive)) {
      count++;
    }
  }
  return count;
}

export function stopCommand(
  getConfig: () => Config,
  getV1Context?: () => { project: V1Project; failure: string | null },
): Command {
  return addV1FormatOption(
    new Command('stop')
      .description(
        'Stop open-knowledge server(s). With no argument: stops the server for the enclosing project — run it from anywhere inside the project. ' +
          'Pass a port number, a directory path, or "all" to target globally.',
      )
      .argument('[target...]', 'port number, directory path (spaces OK), or "all"')
      .option(
        '--force',
        'Stop even when editor windows or agents are still connected to the server',
      ),
  ).action(async (parts: string[], options: { force?: boolean; format?: string }) => {
    const force = options.force === true;
    const target = parts.length === 0 ? undefined : parts.join(' ');

    if (options.format === 'json-v1') {
      const context = getV1Context?.() ?? {
        project: { root: process.cwd(), resolution: 'cwd' as const },
        failure: null,
      };
      const kind: V1StopTarget['kind'] =
        target === undefined
          ? 'project'
          : target === 'all'
            ? 'all'
            : /^\d+$/.test(target)
              ? 'number'
              : 'path';
      const selector: V1StopTarget = { kind, value: target ?? null, projectRoot: null };
      if (context.failure !== null) {
        writeV1Document(stopV1Failure(selector, force, 'project-unavailable', context.failure));
        return;
      }
      try {
        writeV1Document(await buildStopV1({ target, force, projectRoot: context.project.root }));
      } catch (error) {
        writeV1Document(
          stopV1Failure(
            selector,
            force,
            'operation-failed',
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
      return;
    }

    if (target === undefined) {
      getConfig();
      const lockDir = resolveLockDir(process.cwd());
      const outcome = await runStop({ lockDir, force, log: () => {} });
      if (outcome.hadTargets) {
        if (outcome.stopped.length > 0) {
          const rendered = outcome.stopped
            .map((t) => `${t.name} (pid=${t.pid}, port=${t.port})`)
            .join(', ');
          console.log(`Stopped: ${rendered}`);
        }
        if (outcome.failed.length > 0 || outcome.declined !== undefined) process.exitCode = 1;
      } else {
        const others = await countOtherRunningServers(lockDir);
        console.log(formatNoTargetMessage(process.cwd(), others, { listingFollows: others > 0 }));
        if (others > 0) await runPs({});
      }
      return;
    }

    if (target === 'all') {
      const lockDirs = await discoverLockDirs();
      if (lockDirs.length === 0) {
        console.log('No running open-knowledge servers found.');
        return;
      }
      let stopped = 0;
      for (const lockDir of lockDirs) {
        if (!isStoppableState(inspectLock(lockDir, 'server'), isProcessAlive)) continue;
        await executeStop(lockDir, force);
        stopped++;
      }
      if (stopped === 0) console.log('No running open-knowledge servers found.');
      return;
    }

    if (/^\d+$/.test(target)) {
      const n = Number.parseInt(target, 10);
      const lockDir = await findLockDirByNumber(n);
      if (lockDir === null) {
        console.log(`No running open-knowledge server found with port or PID ${n}.`);
        return;
      }
      await executeStop(lockDir, force);
      return;
    }

    const targetDir = resolve(getInvocationCwd(), target);
    const lockDir = resolveLockDir(targetDir);
    const buffered: string[] = [];
    const outcome = await runStop({ lockDir, force, log: (msg) => buffered.push(msg) });
    if (outcome.failed.length > 0 || outcome.declined !== undefined) process.exitCode = 1;
    if (outcome.hadTargets) {
      for (const line of buffered) console.log(line);
    } else {
      console.log(formatNoTargetMessage(targetDir, await countOtherRunningServers(lockDir)));
    }
  });
}
