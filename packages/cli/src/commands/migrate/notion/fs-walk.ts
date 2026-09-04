import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      let isDir = false;
      let isFile = false;
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink()) {
          isFile = statSync(full).isFile();
        } else {
          isDir = st.isDirectory();
          isFile = st.isFile();
        }
      } catch {
        continue;
      }
      if (isDir) stack.push(full);
      else if (isFile) out.push(full);
    }
  }
  return out;
}
