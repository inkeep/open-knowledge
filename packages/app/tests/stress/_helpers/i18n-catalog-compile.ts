import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { APP_PACKAGE_ROOT } from './seed-key.ts';

const COMPILE_SCRIPT = join(APP_PACKAGE_ROOT, 'scripts', 'compile-i18n-catalogs.ts');
const COMPILE_BUDGET_MS = 180_000;

export default function globalCompileI18nCatalogs(): void {
  const compiled = spawnSync(process.execPath, [COMPILE_SCRIPT], {
    cwd: APP_PACKAGE_ROOT,
    encoding: 'utf-8',
    timeout: COMPILE_BUDGET_MS,
  });
  if (compiled.error === undefined && compiled.status === 0) return;
  throw new Error(
    `could not compile the i18n catalogs before this run. Every dev server it boots sets OK_TEST_SKIP_I18N_COMPILE, so without this compile they would serve missing or stale src/locales/*/messages.json. node ${COMPILE_SCRIPT} exited ${String(compiled.status)}${compiled.signal ? ` on ${compiled.signal}` : ''}${compiled.error ? ` (${String(compiled.error)})` : ''}:\n${compiled.stderr ?? ''}${compiled.stdout ?? ''}`,
  );
}
