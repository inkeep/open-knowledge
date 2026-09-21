#!/usr/bin/env -S npx tsx
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPackSkills,
  buildSkillBundles,
  type SkillBundlePaths,
} from '../../server/scripts/build-skill-bundles.ts';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveSkillAssetPaths(packageRoot: string = PACKAGE_ROOT): SkillBundlePaths {
  return {
    skillsDir: join(packageRoot, '..', 'server', 'assets', 'skills'),
    distDir: join(packageRoot, 'dist', 'assets', 'skills'),
  };
}

export function composeSkillAssets(paths: SkillBundlePaths): string[] {
  return [
    ...buildSkillBundles(paths).map((composed) => composed.bundle),
    ...buildPackSkills(paths),
  ];
}

if (import.meta.main) {
  const paths = resolveSkillAssetPaths();
  const built = composeSkillAssets(paths);
  console.log(`[build-skill-assets] composed ${built.length} skill asset(s) → ${paths.distDir}`);
}
