import { existsSync, readFileSync } from 'node:fs';
import { app } from 'electron';
import {
  parseDesktopUninstallResultArgs,
  UNINSTALL_PROGRESS_ARG,
  UNINSTALL_RESULT_ARG,
} from './desktop-uninstall-result.ts';
import { isExecutableFileSync } from './executable-file.ts';
import { clearAmbientCapsBeforeBoot } from './linux-ambient-caps.ts';

clearAmbientCapsBeforeBoot({
  platform: process.platform,
  uid: process.getuid?.() ?? -1,
  env: process.env,
  readProcStatus: () => readFileSync('/proc/self/status', 'utf8'),
  exists: existsSync,
  isExecutable: (path) => isExecutableFileSync(path),
  execPath: process.execPath,
  argv: process.argv,
  execve: process.execve?.bind(process),
});

if (process.argv.includes(UNINSTALL_RESULT_ARG) || process.argv.includes(UNINSTALL_PROGRESS_ARG)) {
  const options = parseDesktopUninstallResultArgs(process.argv);
  if (options === null) {
    process.stderr.write(
      'Invalid uninstall handoff arguments: expected an absolute profile, a supported locale, and one progress or result mode.\n',
    );
    app.exit(1);
  } else {
    for (const path of ['appData', 'userData', 'sessionData', 'logs', 'crashDumps'] as const) {
      app.setPath(path, options.profile);
    }
    const { runDesktopUninstallResultWindow } = await import(
      './desktop-uninstall-result-window.ts'
    );
    void runDesktopUninstallResultWindow(options);
  }
} else {
  await import('./index.ts');
}
