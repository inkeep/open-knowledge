import { describe, expect, test } from 'vitest';
import { getDescriptor } from '../registry/index.ts';
import { prepareJsxProps } from './jsx-render-contract.ts';

describe('prepareJsxProps', () => {
  test('contains a real legacy rename that crosses the text budget', () => {
    const descriptor = getDescriptor('MirrorSource');
    const value = 'x'.repeat(999996);
    const allowed = prepareJsxProps({ props: { id: value } }, descriptor);
    expect(allowed.error).toBeNull();
    expect(allowed.props.name).toBe(value);
    expect(prepareJsxProps({ props: { id: `${value}xx` } }, descriptor)).toEqual({
      props: {},
      error: 'Component props exceed the rendering budget',
    });
  });

  test('includes inline body text before validating transformed props', () => {
    const result = prepareJsxProps(
      { props: { id: 'x'.repeat(999989), children: 'a' } },
      getDescriptor('MirrorSource'),
      true,
    );
    expect(result).toEqual({ props: {}, error: 'Component props exceed the rendering budget' });
  });

  test('keeps ordinary inline text children while preserving block content holes', () => {
    const attrs = { props: { type: 'warning', children: 'Keep this body' } };
    const descriptor = getDescriptor('Callout');
    expect(prepareJsxProps(attrs, descriptor, true)).toEqual({
      props: { type: 'warning', children: 'Keep this body' },
      error: null,
    });
    expect(prepareJsxProps(attrs, descriptor)).toEqual({ props: { type: 'warning' }, error: null });
  });
});
