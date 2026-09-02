import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const README = join(dirname(fileURLToPath(import.meta.url)), 'README.md');
const SECTION = '## Violation classes';

export function documentedViolationClasses() {
  const lines = readFileSync(README, 'utf8').split('\n');
  const start = lines.indexOf(SECTION);
  if (start === -1) throw new Error(`README.md has no "${SECTION}" section`);

  const classes = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const heading = /^### (\S+)$/.exec(line);
    if (heading) classes.push(heading[1]);
  }
  if (classes.length === 0) throw new Error(`README.md's "${SECTION}" section documents none`);
  return classes;
}
