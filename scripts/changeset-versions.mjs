import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXED_GROUP_ANCHOR = '@inkeep/open-knowledge';
const BUMP_RANK = { patch: 1, minor: 2, major: 3 };
const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function bumpSemver(version, type) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`Invalid version: ${version}`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  if (type === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Invalid bump type: ${type}`);
}

export function maxBumpType(bumpTypes) {
  let max = 'patch';
  for (const t of bumpTypes) {
    if (t && BUMP_RANK[t] > BUMP_RANK[max]) max = t;
  }
  return max;
}

export function fixedGroupOf(config) {
  const group = (config?.fixed ?? []).find((members) => members.includes(FIXED_GROUP_ANCHOR));
  return group ?? [FIXED_GROUP_ANCHOR];
}

export function loadChangesets(root = OK_ROOT) {
  const cliRequire = createRequire(
    createRequire(join(root, 'package.json')).resolve('@changesets/cli/package.json'),
  );
  const readerRequire = createRequire(cliRequire.resolve('@changesets/read'));
  return {
    read: cliRequire('@changesets/read').default,
    parse: readerRequire('@changesets/parse').default,
  };
}

export function maxReleaseType(releases) {
  let maxType = null;
  for (const { type } of releases) {
    if (BUMP_RANK[type] && (!maxType || BUMP_RANK[type] > BUMP_RANK[maxType])) maxType = type;
  }
  return maxType;
}
