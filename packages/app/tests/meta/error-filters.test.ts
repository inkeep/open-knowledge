import { describe, expect, it } from 'vitest';
import { filterCriticalErrors } from '../stress/_helpers/error-filters';

describe('filterCriticalErrors', () => {
  const prebundled = 'http://localhost:5173/node_modules/.vite/deps/@codemirror_state.js';

  it('keeps a runtime exception reported from a pre-bundled chunk', () => {
    const entry = {
      type: 'error',
      text: 'Uncaught TypeError: EditorSelection.undirectionalRange is not a function',
      url: prebundled,
    };
    expect(filterCriticalErrors([entry])).toEqual([entry]);
  });

  it('still drops a genuine pre-bundle load failure', () => {
    expect(
      filterCriticalErrors([
        {
          type: 'error',
          text: 'Failed to load resource: the server responded with a status of 504',
          url: prebundled,
        },
        {
          type: 'error',
          text: 'GET /@vite/client net::ERR_ABORTED 404',
          url: 'http://localhost:5173/@vite/client',
        },
      ]),
    ).toEqual([]);
  });

  it('keeps an ordinary application error with no URL', () => {
    const entry = { type: 'uncaught', text: 'Cannot read properties of undefined' };
    expect(filterCriticalErrors([entry])).toEqual([entry]);
  });
});
