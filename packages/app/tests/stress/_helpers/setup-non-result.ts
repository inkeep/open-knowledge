import type { TestInfo } from '@playwright/test';
import type { TestResult } from '@playwright/test/reporter';

export const SETUP_NON_RESULT_ANNOTATION = 'ok:setup-non-result';

export function declareSetupNonResult(testInfo: TestInfo, reason: string): void {
  testInfo.annotations.push({ type: SETUP_NON_RESULT_ANNOTATION, description: reason });
}

export function declaredSetupNonResultReasons(result: TestResult): Array<string | undefined> {
  return result.annotations
    .filter((annotation) => annotation.type === SETUP_NON_RESULT_ANNOTATION)
    .map((annotation) => annotation.description);
}
