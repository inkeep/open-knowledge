/** Fixture module for the shim's mock.module self-test. Its real export is
 * replaced by the mock-then-dynamic-import path exercised in the test. */
export function greet(): string {
  return 'real';
}
