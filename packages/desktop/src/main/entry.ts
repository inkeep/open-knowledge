import { app } from 'electron';
import {
  parseDesktopUninstallResultArgs,
  UNINSTALL_PROGRESS_ARG,
  UNINSTALL_RESULT_ARG,
} from './desktop-uninstall-result.ts';

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
