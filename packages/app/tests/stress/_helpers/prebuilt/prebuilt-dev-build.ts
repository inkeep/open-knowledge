import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { watchForSilence } from '../../../../../../test-support/child-silence-bound.test-helper.ts';
import { PREBUILT_OUT_DIR_ENV } from '../../../../src/build/prebuilt-dev-contract.ts';
import { APP_PACKAGE_ROOT } from '../seed-key.ts';
import { killGroup } from '../server-process.ts';
import { type PrebuiltDevApp, resolvePrebuiltDevApp } from './prebuilt-dev-app.ts';
import { PREBUILT_BUILD_OPTIONS } from './prebuilt-serving.ts';

export const OK_ROOT = join(APP_PACKAGE_ROOT, '..', '..');

export const PREBUILT_OUT_ROOT = join(
  APP_PACKAGE_ROOT,
  'node_modules',
  '.cache',
  'ok-prebuilt-dev',
);

const OUTPUT_TAIL_CHARS = 8_000;

export const BUILD_STEP_SILENCE_MS = 300_000;

export type BuildStep = {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly inherits?: (name: string) => boolean;
};

function inheritedEnv(inherits: (name: string) => boolean): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => inherits(name)));
}

const notViteVariable = (name: string): boolean => !name.startsWith('VITE_');

export function runBuildStep(step: BuildStep): Promise<void> {
  const { label, command, args, env, inherits = () => true } = step;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: APP_PACKAGE_ROOT,
      detached: true,
      env: { ...inheritedEnv(inherits), ...env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const endGroup = () => {
      killGroup(child, 'SIGKILL');
    };
    let silent = false;
    const releaseSilence = watchForSilence(
      [child.stdout, child.stderr],
      BUILD_STEP_SILENCE_MS,
      () => {
        silent = true;
        endGroup();
      },
    );
    process.once('exit', endGroup);
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const settle = () => {
      releaseSilence();
      process.off('exit', endGroup);
    };
    child.once('error', (error) => {
      settle();
      reject(error);
    });
    child.once('close', (code, signal) => {
      settle();
      if (silent) {
        reject(
          new Error(
            `${label} printed nothing for ${BUILD_STEP_SILENCE_MS / 1000} s, so this run stopped it and every process in its process group; its last output:\n${output}`,
          ),
        );
      } else if (code === 0) resolve();
      else reject(new Error(`${label} exited with ${code ?? signal}\n${output}`));
    });
  });
}

function runPnpm(
  label: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<void> {
  return runBuildStep({ label, command: 'pnpm', args, env });
}

export function prebuiltBuildStep(distDir: string): BuildStep {
  return {
    label: 'the prebuilt DEV app build',
    command: 'pnpm',
    args: [
      'exec',
      'vite',
      'build',
      '--config',
      PREBUILT_BUILD_OPTIONS.config,
      '--mode',
      PREBUILT_BUILD_OPTIONS.mode,
    ],
    env: { NODE_ENV: PREBUILT_BUILD_OPTIONS.nodeEnv, [PREBUILT_OUT_DIR_ENV]: distDir },
    inherits: notViteVariable,
  };
}

export function buildPrebuiltDist(distDir: string): Promise<void> {
  return runBuildStep(prebuiltBuildStep(distDir));
}

export async function preparePrebuiltDevApp(): Promise<PrebuiltDevApp> {
  await runPnpm('predev for the prebuilt DEV app', ['run', 'predev'], {
    OK_TEST_SKIP_I18N_COMPILE: '1',
  });
  return resolvePrebuiltDevApp({
    okRoot: OK_ROOT,
    outRoot: PREBUILT_OUT_ROOT,
    options: PREBUILT_BUILD_OPTIONS,
    build: buildPrebuiltDist,
  });
}
