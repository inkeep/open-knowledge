import type { Reporter, TestError } from '@playwright/test/reporter';
import FinalFailureAnnotations from '../../../../test-support/playwright-final-failure-annotations.ts';

const _reporter: Reporter = new FinalFailureAnnotations();
void _reporter;

type ReadErrorField = keyof Parameters<FinalFailureAnnotations['onError']>[0];
const _everyReadErrorFieldIsPlaywrights: [Exclude<ReadErrorField, keyof TestError>] extends [never]
  ? true
  : false = true;
void _everyReadErrorFieldIsPlaywrights;
