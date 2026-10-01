#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix as pathPosix } from 'node:path';
import { resolveHelperBundleBinary } from '@inkeep/open-knowledge-core/helper-bundle';

export const HELPER_PROBE_TIMEOUT_MS = 10_000;

const HELPER_PROBE_SOURCE = 'console.log("ok-helper-node-mode", process.versions.node)';
const NODE_MODE_LINE = /ok-helper-node-mode\s+(\d+\.\d+\.\d+)/;

function listDir(path) {
  try {
    return readdirSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function bundleExecutable(bundle) {
  const plist = pathPosix.join(bundle, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return null;
  const name = readFileSync(plist, 'utf8').match(
    /<key>CFBundleExecutable<\/key>\s*<string>([^<]*)<\/string>/,
  )?.[1];
  return name === undefined ? null : pathPosix.join(bundle, 'Contents', 'MacOS', name);
}

export function findPackagedApps(searchRoot) {
  return listDir(searchRoot)
    .filter((name) => name.startsWith('mac-'))
    .flatMap((subdir) =>
      listDir(pathPosix.join(searchRoot, subdir))
        .filter((name) => name.endsWith('.app'))
        .map((name) => pathPosix.join(searchRoot, subdir, name)),
    )
    .sort();
}

export function probeHelper(helper) {
  return spawnSync(helper, ['-e', HELPER_PROBE_SOURCE], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: HELPER_PROBE_TIMEOUT_MS,
  });
}

export function helperProbeProblems(result) {
  if (result.error && result.error.code !== 'ETIMEDOUT') {
    return [`it could not be run: ${result.error.message}`];
  }
  const problems = [];
  if (result.error) problems.push(`it did not exit within ${HELPER_PROBE_TIMEOUT_MS} ms`);
  else if (result.signal !== null) problems.push(`it was killed by ${result.signal}`);
  else if (result.status !== 0) problems.push(`it exited ${result.status}`);
  if (!NODE_MODE_LINE.test(result.stdout)) {
    problems.push(
      `its stdout lacks the "ok-helper-node-mode <version>" line: ${JSON.stringify(result.stdout.slice(-200))}`,
    );
  }
  if (result.stderr !== '') {
    problems.push(`it wrote to stderr: ${JSON.stringify(result.stderr.slice(-400))}`);
  }
  return problems;
}

export function checkPackagedApp(app, probe = probeHelper) {
  const executable = bundleExecutable(app);
  if (executable === null) {
    return { app, problems: [`${app} has no Contents/Info.plist naming its CFBundleExecutable`] };
  }
  const frameworks = pathPosix.join(app, 'Contents', 'Frameworks');
  const servers = listDir(frameworks).filter((name) => name.endsWith(' Server.app'));
  if (servers.length !== 1) {
    return {
      app,
      problems: [
        `${app} holds ${servers.length} "* Server.app" helper bundles in Contents/Frameworks, ` +
          `not exactly one: ${servers.join(', ') || 'none'}`,
      ],
    };
  }
  const server = pathPosix.join(frameworks, servers[0]);
  const helper = bundleExecutable(server);
  if (helper === null) {
    return {
      app,
      problems: [`${server} has no Contents/Info.plist naming its CFBundleExecutable`],
    };
  }
  if (!existsSync(helper)) {
    return {
      app,
      helper,
      problems: [
        `${server} names ${helper}, which does not exist: afterPack.mjs clones Electron's helper ` +
          'stub into that slot when it packages for darwin',
      ],
    };
  }
  const problems = [];
  const resolved = resolveHelperBundleBinary(executable);
  if (resolved !== helper) {
    problems.push(
      `the spawn site's resolver maps ${executable} to ${resolved}, not to the packaged helper ${helper}`,
    );
  }
  const result = probe(helper);
  for (const problem of helperProbeProblems(result)) {
    problems.push(`${helper} under ELECTRON_RUN_AS_NODE=1: ${problem}`);
  }
  return { app, helper, nodeVersion: result.stdout?.match(NODE_MODE_LINE)?.[1], problems };
}

function main([searchRoot, label = searchRoot]) {
  if (!searchRoot) {
    console.error('usage: assert-packaged-helper-runs-as-node.mjs <search-root> [label]');
    return 2;
  }
  const apps = findPackagedApps(searchRoot);
  if (apps.length === 0) {
    console.error(
      `::error::${label}: no packaged mac-*/*.app under ${searchRoot}, so the detached-server ` +
        'helper was not checked. Package the macOS app (electron-builder --mac --dir) and point ' +
        'this check at its output directory.',
    );
    return 1;
  }
  let failed = false;
  for (const app of apps) {
    const { helper, nodeVersion, problems } = checkPackagedApp(app);
    if (problems.length > 0) {
      failed = true;
      for (const problem of problems) console.error(`::error::${label}: ${problem}`);
    } else {
      console.log(
        `packaged helper OK (${label}): ${helper} runs as Node ${nodeVersion} under ` +
          'ELECTRON_RUN_AS_NODE=1, and the spawn-site resolver lands on it',
      );
    }
  }
  if (failed) return 1;
  console.log(`packaged helper: ${apps.length} app(s) checked under ${searchRoot}`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
