import { existsSync, mkdirSync, mkdtempSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BuildOptions,
  type PrebuiltManifest,
  type PrebuiltServingDecision,
  prebuiltManifest,
  prebuiltServingDecision,
} from '../../../foundation/test-server-inputs.ts';
import {
  discardUnlessInUse,
  holdPrebuiltBuildUse,
  type PrebuiltBuildUse,
  withPrebuiltBuildMutation,
} from './prebuilt-build-use.ts';
import { discardDirectory, outputDigests } from './prebuilt-output-fs.ts';
import { PREBUILT_MANIFEST_FILE, readPrebuiltManifest } from './prebuilt-serving.ts';

export type BuildPrebuiltDist = (distDir: string) => Promise<void>;

export type PrebuiltDevApp = {
  readonly outputDir: string;
  readonly distDir: string;
  readonly manifest: PrebuiltManifest;
  readonly decision: PrebuiltServingDecision;
  readonly built: boolean;
  readonly use: PrebuiltBuildUse;
};

const LATEST_FILE = 'latest.json';
const RETIRING_PREFIX = '.retiring-';

function prebuiltDevApp(
  outputDir: string,
  manifest: PrebuiltManifest,
  decision: PrebuiltServingDecision,
  built: boolean,
  use: PrebuiltBuildUse,
): PrebuiltDevApp {
  return { outputDir, distDir: join(outputDir, 'dist'), manifest, decision, built, use };
}

function servesManifest(outputDir: string, manifest: PrebuiltManifest): boolean {
  return prebuiltServingDecision(
    readPrebuiltManifest(join(outputDir, PREBUILT_MANIFEST_FILE)),
    manifest,
  ).serve;
}

function occupiedByAnotherDirectory(error: unknown): boolean {
  const { code } = error as NodeJS.ErrnoException;
  return code === 'ENOTEMPTY' || code === 'EEXIST';
}

function retireOutput(outRoot: string, digest: string): void {
  const retiring = mkdtempSync(join(outRoot, `${RETIRING_PREFIX}${digest.slice(0, 12)}-`));
  renameSync(join(outRoot, digest), join(retiring, digest));
  discardDirectory(retiring);
}

function landOrJoin(
  outRoot: string,
  staging: string,
  manifest: PrebuiltManifest,
): 'landed' | 'joined' {
  const outputDir = join(outRoot, manifest.digest);
  if (existsSync(outputDir) && servesManifest(outputDir, manifest)) return 'joined';
  return withPrebuiltBuildMutation(outRoot, manifest.digest, () => {
    if (existsSync(outputDir)) {
      if (servesManifest(outputDir, manifest)) return 'joined';
      retireOutput(outRoot, manifest.digest);
    }
    try {
      renameSync(staging, outputDir);
      return 'landed';
    } catch (error) {
      if (occupiedByAnotherDirectory(error) && servesManifest(outputDir, manifest)) return 'joined';
      throw error;
    }
  });
}

function recordLatest(outRoot: string, manifest: PrebuiltManifest): void {
  const pending = join(outRoot, `.${LATEST_FILE}.${process.pid}`);
  writeFileSync(pending, JSON.stringify(manifest));
  renameSync(pending, join(outRoot, LATEST_FILE));
}

function discardUnusedOutputs(outRoot: string, keep: ReadonlySet<string>): void {
  for (const digest of outputDigests(outRoot)) {
    if (keep.has(digest)) continue;
    discardUnlessInUse(outRoot, digest, () => {
      if (existsSync(join(outRoot, digest))) retireOutput(outRoot, digest);
    });
  }
}

async function serveOrBuild(
  outRoot: string,
  manifest: PrebuiltManifest,
  build: BuildPrebuiltDist,
  use: PrebuiltBuildUse,
): Promise<PrebuiltDevApp> {
  const outputDir = join(outRoot, manifest.digest);
  const recorded = readPrebuiltManifest(join(outputDir, PREBUILT_MANIFEST_FILE));
  const latest = readPrebuiltManifest(join(outRoot, LATEST_FILE));
  const previous = latest?.digest === manifest.digest ? undefined : latest;
  const decision = prebuiltServingDecision(recorded ?? previous, manifest);
  if (decision.serve) return prebuiltDevApp(outputDir, manifest, decision, false, use);

  mkdirSync(outRoot, { recursive: true });
  const staging = mkdtempSync(join(outRoot, `.staging-${manifest.digest.slice(0, 12)}-`));
  try {
    const distDir = join(staging, 'dist');
    await build(distDir);
    if (statSync(join(distDir, 'index.html'), { throwIfNoEntry: false })?.isFile() !== true) {
      throw new Error(`the prebuilt DEV app build wrote no index.html under ${distDir}`);
    }
    writeFileSync(join(staging, PREBUILT_MANIFEST_FILE), JSON.stringify(manifest));
    if (landOrJoin(outRoot, staging, manifest) === 'joined') {
      return prebuiltDevApp(outputDir, manifest, decision, false, use);
    }
  } finally {
    discardDirectory(staging);
  }
  discardUnusedOutputs(
    outRoot,
    new Set(latest === undefined ? [manifest.digest] : [manifest.digest, latest.digest]),
  );
  recordLatest(outRoot, manifest);
  return prebuiltDevApp(outputDir, manifest, decision, true, use);
}

export async function resolvePrebuiltDevApp(request: {
  readonly okRoot: string;
  readonly outRoot: string;
  readonly options: BuildOptions;
  readonly build: BuildPrebuiltDist;
}): Promise<PrebuiltDevApp> {
  const { okRoot, outRoot, options, build } = request;
  const manifest = prebuiltManifest(okRoot, options);
  const use = holdPrebuiltBuildUse(outRoot, manifest.digest);
  try {
    return await serveOrBuild(outRoot, manifest, build, use);
  } catch (error) {
    use.release();
    throw error;
  }
}
