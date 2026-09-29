import { execFileSync } from 'node:child_process';

export function createTagContainment({ cwd = process.cwd(), exec = execFileSync } = {}) {
  const containing = new Map();
  let tags;
  const readTags = (args) =>
    new Set(
      exec('git', ['for-each-ref', '--format=%(refname:strip=2)', ...args, 'refs/tags/'], {
        cwd,
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .filter(Boolean),
    );
  return (tag, sha) => {
    tags ??= readTags([]);
    if (!tags.has(tag))
      throw new Error(`Release tag ${tag} is absent from the checked-out history`);
    if (!containing.has(sha)) containing.set(sha, readTags(['--contains', sha]));
    return containing.get(sha).has(tag);
  };
}
