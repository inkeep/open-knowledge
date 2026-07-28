import { describe, expect, test } from 'vitest';
import { classifySeverity, SEVERITY_STYLES } from './severity';

describe('classifySeverity', () => {
  test('unregistered-component reasons classify as info', () => {
    expect(classifySeverity('Unregistered component: DataViz')).toBe('info');
    expect(classifySeverity('Unregistered component: SomethingElse')).toBe('info');
  });

  test('render-error reasons classify as warn', () => {
    expect(classifySeverity('Render error in <Callout>: TypeError…')).toBe('warn');
    expect(classifySeverity('Render error in <Card>: undefined is not a function')).toBe('warn');
  });

  test('parse-failure reasons classify as error', () => {
    expect(
      classifySeverity('Unexpected closing slash `/` in tag, expected an open tag first'),
    ).toBe('error');
    expect(classifySeverity('Unmatched opening tag')).toBe('error');
  });

  test('undefined / empty reasons default to error (fail-safe)', () => {
    expect(classifySeverity(undefined)).toBe('error');
    expect(classifySeverity('')).toBe('error');
  });

  test('SEVERITY_STYLES covers all three levels', () => {
    expect(SEVERITY_STYLES.info.label).toBe('unknown');
    expect(SEVERITY_STYLES.warn.label).toBe('render error');
    expect(SEVERITY_STYLES.error.label).toBe('parse error');
  });
});
