export function serializeEveryFieldExceptCallerSuppliedPathsUnderTheFileKey(
  value: unknown,
  callerSuppliedPaths: readonly string[],
): string {
  const supplied = new Set(callerSuppliedPaths);
  return JSON.stringify(value, (key, val) =>
    key === 'file' && typeof val === 'string' && supplied.has(val) ? undefined : val,
  );
}
