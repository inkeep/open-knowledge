export {};

if (process.platform === 'win32' && process.env.OK_TEST_WINDOWS_PROCESS_START_READER === '1') {
  const { registerWindowsProcessStartReader } = await import(
    '../../../cli/src/commands/holder-process-start.ts'
  );
  registerWindowsProcessStartReader();
}
