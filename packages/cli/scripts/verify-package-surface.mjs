import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const REQUIRED_PACK_FILES = ['README.md', 'dist/LICENSE', 'dist/THIRD_PARTY_NOTICES.md'];

export const REQUIRED_KEYWORDS = ['knowledge-base', 'markdown', 'local-first', 'mcp', 'ai', 'cli'];

export function validatePackageSurface(packageJson, packEntries) {
  const errors = [];
  const pack = Array.isArray(packEntries) ? packEntries[0] : undefined;
  const packedFiles = new Set(pack?.files?.map((file) => file.path) ?? []);

  if (!pack) errors.push('npm pack returned no package entry');
  for (const file of REQUIRED_PACK_FILES) {
    if (!packedFiles.has(file)) errors.push(`packed artifact is missing ${file}`);
  }

  if (typeof packageJson.description !== 'string' || packageJson.description.trim().length < 40) {
    errors.push('package description must be at least 40 characters');
  }
  if (packageJson.homepage !== 'https://openknowledge.ai') {
    errors.push('package homepage must be https://openknowledge.ai');
  }

  const keywords = new Set(Array.isArray(packageJson.keywords) ? packageJson.keywords : []);
  for (const keyword of REQUIRED_KEYWORDS) {
    if (!keywords.has(keyword)) errors.push(`package keywords are missing ${keyword}`);
  }

  return errors;
}

export function verifyPackageSurface(packageRoot = PACKAGE_ROOT) {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const packEntries = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--dry-run', '--ignore-scripts'], {
      cwd: packageRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
  const errors = validatePackageSurface(packageJson, packEntries);

  if (errors.length > 0) {
    throw new Error(`Package surface verification failed:\n- ${errors.join('\n- ')}`);
  }

  console.log(`Package surface verified (${packEntries[0].files.length} packed files).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  verifyPackageSurface();
}
