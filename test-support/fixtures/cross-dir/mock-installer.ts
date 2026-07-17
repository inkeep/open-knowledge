import { mock } from 'bun:test';

/**
 * Calls `mock.module` with a specifier relative to THIS file's directory, not
 * the test's. The mock resolves correctly only if the shim's `callerFile()`
 * walks the stack to this module and `absolutize()` resolves `./target` against
 * this directory — so a test that mocks from here and imports the target from
 * its own (different) directory proves the relative-path resolution.
 */
export function installCrossDirTargetMock(): void {
  mock.module('./target', () => ({ greet: () => 'mocked-cross-dir' }));
}
