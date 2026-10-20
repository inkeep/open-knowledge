import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function replaceBundleDir(sourceDir: string, skillPath: string): 'written' | 'overwritten' {
  const targetDir = dirname(skillPath);
  const action = existsSync(skillPath) ? 'overwritten' : 'written';
  if (action === 'written' && existsSync(targetDir)) {
    throw new Error(
      `Refusing to replace ${targetDir}: it exists but holds no SKILL.md, so it is not a bundle OpenKnowledge wrote. Move it aside and try again.`,
    );
  }
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(dirname(targetDir), { recursive: true });
  copyBundleContents(sourceDir, targetDir);
  return action;
}

function copyBundleContents(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyBundleContents(source, target);
    } else {
      copyFileSync(source, target);
    }
  }
}
