import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Recursively list file paths under `root`, skipping any entry whose name starts
 * with a dot. That single rule excludes `.ok/`, `.git/`, and all dotfiles — the
 * directories the migration must never touch (server state, VCS). Unreadable
 * directories and entries are skipped rather than throwing. Symlinks to files
 * are included; symlinks to directories are never descended into — following
 * one that points at an ancestor would cycle the walk forever.
 */
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
