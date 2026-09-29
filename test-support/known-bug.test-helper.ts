const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

function failureMessage(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure);
  return message.replace(ANSI_ESCAPE, '');
}

export async function expectKnownBug(
  signature: RegExp,
  assertCorrectBehaviour: () => unknown,
): Promise<string> {
  let failure: unknown;
  let failed = false;
  try {
    await assertCorrectBehaviour();
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (!failed) {
    throw new Error(
      `known bug appears fixed: the correct assertion passed, so ${signature} no longer describes a failure. Remove the pin: keep the assertion, drop expectKnownBug and the known-bug tag, and close the issue.`,
    );
  }
  const message = failureMessage(failure);
  if (message.search(signature) === -1) throw failure;
  return message;
}
