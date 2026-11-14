import { test } from '@playwright/test';

test('fails then skips its retry', () => {
  test.skip(test.info().retry > 0, 'the failed attempt left the skip condition');
  throw new Error('the first attempt failed');
});

test('fails then passes its retry', () => {
  if (test.info().retry === 0) throw new Error('the first attempt failed');
});

test('fails as expected', () => {
  test.fail();
  throw new Error('the expected failure');
});

test('skips from the start', () => {
  test.skip(true, 'this case is not applicable');
});

test('changes its expectation without meeting either', () => {
  test.fail(test.info().retry === 0);
  if (test.info().retry > 0) throw new Error('the retry was expected to pass');
});

test('meets a changed failure expectation on retry', () => {
  test.fail(test.info().retry > 0);
  throw new Error('only the retry was expected to fail');
});

test('passes its only try', () => {});

test('fails every try', () => {
  throw new Error('every attempt failed');
});
