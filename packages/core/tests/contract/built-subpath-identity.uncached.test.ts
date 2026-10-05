import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

const PACKAGE_ROOT = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const PACKAGE_URL = pathToFileURL(`${PACKAGE_ROOT}/`);
const PACKAGE_NAME = '@inkeep/open-knowledge-core';

const STATEFUL_SUBPATHS = {
  fieldRegistry: 'config/field-registry',
  ConfigSchema: 'config/schema',
  sharedExtensions: 'extensions/shared',
  FORM_WRITE_ORIGIN: 'bridge',
} as const;

type StatefulBinding = keyof typeof STATEFUL_SUBPATHS;
type ImportOrder = 'barrel-first' | 'subpaths-first';

interface ProbeReport {
  resolved: Record<string, string>;
  identical: Record<StatefulBinding, boolean>;
  metaThroughSubpathRegistry: { scope: string; reload: string } | null;
  metaThroughBarrelRegistry: { scope: string; reload: string } | null;
}

const packageJson: { exports: Record<string, { default: string }> } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

function builtTarget(subpath: string): URL {
  const key = subpath === '' ? '.' : `./${subpath}`;
  const target = packageJson.exports[key]?.default;
  if (target === undefined)
    throw new Error(`${PACKAGE_NAME} declares no default export for ${key}`);
  return new URL(target, PACKAGE_URL);
}

function probeScript(order: ImportOrder): string {
  const subpaths = Object.entries(STATEFUL_SUBPATHS).map(([binding, subpath]) => [
    binding,
    `${PACKAGE_NAME}/${subpath}`,
  ]);
  return `
const barrelSpecifier = ${JSON.stringify(PACKAGE_NAME)};
const subpaths = ${JSON.stringify(subpaths)};
const order = ${JSON.stringify(order)};
const viaSubpath = {};
let barrel;
if (order === 'barrel-first') barrel = await import(barrelSpecifier);
for (const [binding, specifier] of subpaths) viaSubpath[binding] = await import(specifier);
if (order === 'subpaths-first') barrel = await import(barrelSpecifier);
const leafPath = ['content', 'dir'];
const pick = (meta) => (meta ? { scope: meta.scope, reload: meta.reload } : null);
const report = {
  resolved: Object.fromEntries(
    [['barrel', barrelSpecifier], ...subpaths].map(([name, specifier]) => [name, import.meta.resolve(specifier)]),
  ),
  identical: Object.fromEntries(
    subpaths.map(([binding]) => [binding, viaSubpath[binding][binding] === barrel[binding]]),
  ),
  metaThroughSubpathRegistry: pick(
    viaSubpath.fieldRegistry.getFieldMeta(barrel.resolveLeafSchema(barrel.ConfigSchema, leafPath)),
  ),
  metaThroughBarrelRegistry: pick(
    barrel.getFieldMeta(barrel.resolveLeafSchema(viaSubpath.ConfigSchema.ConfigSchema, leafPath)),
  ),
};
process.stdout.write(JSON.stringify(report));
`;
}

function runFreshProcess(order: ImportOrder): ProbeReport {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== 'NODE_OPTIONS'),
  );
  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', probeScript(order)],
    { cwd: PACKAGE_ROOT, env, encoding: 'utf8' },
  );
  return JSON.parse(stdout);
}

describe('built core entries share one runtime across the barrel and its subpaths', () => {
  test('the emitted entries this check imports exist', () => {
    for (const subpath of ['', ...Object.values(STATEFUL_SUBPATHS)]) {
      const target = builtTarget(subpath);
      expect(
        existsSync(target),
        `${fileURLToPath(target)} is missing; build core first (pnpm --filter @inkeep/open-knowledge-core build)`,
      ).toBe(true);
    }
  });

  test.each<ImportOrder>(['barrel-first', 'subpaths-first'])(
    'a fresh process importing %s sees identical stateful bindings and shared schema metadata',
    (order) => {
      const report = runFreshProcess(order);

      expect(report.resolved.barrel).toBe(builtTarget('').href);
      for (const [binding, subpath] of Object.entries(STATEFUL_SUBPATHS)) {
        expect(report.resolved[binding], binding).toBe(builtTarget(subpath).href);
      }
      expect(report.identical).toEqual({
        fieldRegistry: true,
        ConfigSchema: true,
        sharedExtensions: true,
        FORM_WRITE_ORIGIN: true,
      });
      expect(report.metaThroughSubpathRegistry).toEqual({ scope: 'project', reload: 'boot' });
      expect(report.metaThroughBarrelRegistry).toEqual({ scope: 'project', reload: 'boot' });
    },
  );
});
