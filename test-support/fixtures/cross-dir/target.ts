/** Fixture module for the shim's CROSS-DIRECTORY mock.module self-test. Its
 * real export is replaced when a helper in this same directory (not the test's
 * directory) mocks it via a relative specifier, exercising callerFile/absolutize. */
export function greet(): string {
  return 'real';
}
