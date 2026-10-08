import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function actionFiles(root, dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return actionFiles(root, path);
    }
    return entry.isFile() && /^action\.ya?ml$/.test(entry.name) ? [path] : [];
  });
}

export function ciFiles(root) {
  const workflows = readdirSync(join(root, '.github', 'workflows'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => `.github/workflows/${entry.name}`);
  return [...new Set([...workflows, ...actionFiles(root, '.github')])].sort();
}
