import { expect, test, vi } from 'vitest';
import { describeBoth } from './fixtures/mock-consumer';
import * as subject from './fixtures/mock-subject';

vi.mock('./fixtures/mock-subject', () => ({ alpha: 'mocked-alpha' }));

test('a partial vi.mock factory links, and the importer reads its mocked binding', () => {
  expect(describeBoth()).toBe('mocked-alpha+undefined');
});

test('a binding the partial factory omits reads undefined in the browser, where the Node mock runner throws', () => {
  expect(Object.keys(subject).sort()).toEqual(['alpha', 'beta']);
  expect(subject.beta).toBeUndefined();
});
