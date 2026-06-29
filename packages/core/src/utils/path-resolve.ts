
export interface BasenameIndex {
  add(path: string): void;
  remove(path: string): void;
  rename(oldPath: string, newPath: string): void;
  resolveEmbed(basename: string, sourcePath: string): string | null;
  clear(): void;
  snapshot(): ReadonlyMap<string, readonly string[]>;
  size(): number;
}

function normalizePath(p: string): string {
  let result = p;
  if (result.startsWith('./')) result = result.slice(2);
  if (result.startsWith('/')) result = result.slice(1);
  return result;
}

function basenameOf(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash === -1 ? p : p.slice(slash + 1);
}

function dirnameOf(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash === -1 ? '' : p.slice(0, slash);
}

function splitSegments(p: string): string[] {
  return p.split('/').filter((seg) => seg !== '');
}

function isInSubtree(subtreeDir: string, candidatePath: string): boolean {
  const candidateDir = dirnameOf(candidatePath);
  if (subtreeDir === '') return true;
  if (candidateDir === subtreeDir) return true;
  return candidateDir.startsWith(`${subtreeDir}/`);
}

function depthInSubtree(subtreeDir: string, candidatePath: string): number {
  const candidateDir = dirnameOf(candidatePath);
  if (subtreeDir === candidateDir) return 0;
  const trailing = subtreeDir === '' ? candidateDir : candidateDir.slice(subtreeDir.length + 1);
  return trailing === '' ? 0 : splitSegments(trailing).length;
}

function relativeHops(fromDir: string, toDir: string): number {
  const fromParts = splitSegments(fromDir);
  const toParts = splitSegments(toDir);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }
  return fromParts.length - common + (toParts.length - common);
}

export function createBasenameIndex(): BasenameIndex {
  const buckets = new Map<string, string[]>();

  function add(rawPath: string): void {
    const path = normalizePath(rawPath);
    if (path === '') return;
    const base = basenameOf(path);
    if (base === '') return;
    const key = base.toLowerCase();
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, [path]);
      return;
    }
    if (!bucket.includes(path)) bucket.push(path);
  }

  function remove(rawPath: string): void {
    const path = normalizePath(rawPath);
    const key = basenameOf(path).toLowerCase();
    const bucket = buckets.get(key);
    if (!bucket) return;
    const idx = bucket.indexOf(path);
    if (idx === -1) return;
    bucket.splice(idx, 1);
    if (bucket.length === 0) buckets.delete(key);
  }

  function rename(oldPath: string, newPath: string): void {
    remove(oldPath);
    add(newPath);
  }

  function resolveEmbed(basename: string, sourcePath: string): string | null {
    const key = basename.toLowerCase();
    const bucket = buckets.get(key);
    if (!bucket || bucket.length === 0) return null;
    if (bucket.length === 1) return bucket[0];

    const sourceDir = dirnameOf(normalizePath(sourcePath));
    const inSubtree: string[] = [];
    const outOfSubtree: string[] = [];
    for (const candidate of bucket) {
      if (isInSubtree(sourceDir, candidate)) inSubtree.push(candidate);
      else outOfSubtree.push(candidate);
    }

    const pickByDepth = (pool: string[]): string => {
      let best = pool[0];
      let bestDepth = depthInSubtree(sourceDir, best);
      for (let i = 1; i < pool.length; i++) {
        const candidate = pool[i];
        const depth = depthInSubtree(sourceDir, candidate);
        if (depth < bestDepth || (depth === bestDepth && candidate < best)) {
          best = candidate;
          bestDepth = depth;
        }
      }
      return best;
    };

    const pickByHops = (pool: string[]): string => {
      let best = pool[0];
      let bestHops = relativeHops(sourceDir, dirnameOf(best));
      for (let i = 1; i < pool.length; i++) {
        const candidate = pool[i];
        const hops = relativeHops(sourceDir, dirnameOf(candidate));
        if (hops < bestHops || (hops === bestHops && candidate < best)) {
          best = candidate;
          bestHops = hops;
        }
      }
      return best;
    };

    return inSubtree.length > 0 ? pickByDepth(inSubtree) : pickByHops(outOfSubtree);
  }

  function snapshot(): ReadonlyMap<string, readonly string[]> {
    const copy = new Map<string, readonly string[]>();
    for (const [key, paths] of buckets) copy.set(key, [...paths]);
    return copy;
  }

  function clear(): void {
    buckets.clear();
  }

  return {
    add,
    remove,
    rename,
    resolveEmbed,
    clear,
    snapshot,
    size: () => buckets.size,
  };
}
