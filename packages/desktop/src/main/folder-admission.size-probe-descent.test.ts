import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type DiscoverProjectResult, discoverProject } from './folder-admission.ts';
import { createBootBudgetDirSizeProbe } from './fs-walk-budget.ts';

const ANCESTOR_SIZE_CAP = 100;

let tmpRoot: string;
let fakeHome: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), 'ok-size-probe-descent-'));
  fakeHome = resolve(realpathSync(tmpRoot), 'home');
  mkdirSync(fakeHome, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function seedManagedAncestorWithLinkedBulk(bulkFileCount: number): string {
  const bulk = resolve(fakeHome, 'bulk');
  const ancestor = resolve(fakeHome, 'ancestor');
  const picked = resolve(ancestor, 'sub');
  mkdirSync(bulk, { recursive: true });
  mkdirSync(picked, { recursive: true });
  mkdirSync(resolve(ancestor, '.ok'), { recursive: true });
  writeFileSync(resolve(ancestor, '.ok/config.yml'), '$schema: x\n');
  for (let i = 0; i < bulkFileCount; i += 1) {
    writeFileSync(join(bulk, `f${i}.md`), '# x');
  }
  symlinkSync(
    bulk,
    resolve(ancestor, 'linked'),
    process.platform === 'win32' ? 'junction' : undefined,
  );
  return picked;
}

function seedManagedAncestorWithRealBulk(bulkFileCount: number): string {
  const ancestor = resolve(fakeHome, 'ancestor');
  const bulk = resolve(ancestor, 'bulk');
  const picked = resolve(ancestor, 'sub');
  mkdirSync(bulk, { recursive: true });
  mkdirSync(picked, { recursive: true });
  mkdirSync(resolve(ancestor, '.ok'), { recursive: true });
  writeFileSync(resolve(ancestor, '.ok/config.yml'), '$schema: x\n');
  for (let i = 0; i < bulkFileCount; i += 1) {
    writeFileSync(join(bulk, `f${i}.md`), '# x');
  }
  return picked;
}

async function discoverWithRealSizeProbe(picked: string): Promise<DiscoverProjectResult> {
  return discoverProject(picked, {
    homeDir: fakeHome,
    gitTopLevel: async () => null,
    dirSizeProbe: createBootBudgetDirSizeProbe(ANCESTOR_SIZE_CAP),
  });
}

describe('discoverProject — the ancestor size probe counts real directories only', () => {
  test('ancestor whose bulk hides behind a directory symlink still promotes silently', async () => {
    const picked = seedManagedAncestorWithLinkedBulk(ANCESTOR_SIZE_CAP + 50);

    const result = await discoverWithRealSizeProbe(picked);

    expect(result.kind).toBe('managed');
  });

  test('ancestor whose real directory bulk exceeds the cap requires confirmation', async () => {
    const picked = seedManagedAncestorWithRealBulk(ANCESTOR_SIZE_CAP + 50);

    const result = await discoverWithRealSizeProbe(picked);

    expect(result.kind).toBe('managed-requires-confirmation');
  });
});
