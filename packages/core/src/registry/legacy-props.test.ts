import { describe, expect, test } from 'vitest';
import { builtInComponents } from './built-ins.ts';
import { propDescription, resolveLegacyProps } from './legacy-props.ts';

function propsOf(componentName: string) {
  const meta = builtInComponents.find((component) => component.name === componentName);
  if (!meta) throw new Error(`no built-in component named ${componentName}`);
  return meta.props;
}

describe('resolveLegacyProps', () => {
  test('reads an older Mirror `anchor` as `name`', () => {
    expect(resolveLegacyProps(propsOf('Mirror'), { src: 'pricing', anchor: 'plans' })).toEqual({
      src: 'pricing',
      name: 'plans',
    });
  });

  test('reads an older MirrorSource `id` as `name`', () => {
    expect(resolveLegacyProps(propsOf('MirrorSource'), { id: 'plans' })).toEqual({
      name: 'plans',
    });
  });

  test('`name` wins when a doc carries both spellings', () => {
    expect(resolveLegacyProps(propsOf('MirrorSource'), { id: 'old', name: 'new' })).toEqual({
      name: 'new',
    });
  });

  test('keeps an `id` on a component that declares no older spelling', () => {
    expect(resolveLegacyProps(propsOf('Tabs'), { id: 'billing-tabs' })).toEqual({
      id: 'billing-tabs',
    });
  });

  test('leaves the values it was given unchanged', () => {
    const values = { src: 'pricing', anchor: 'plans' };
    resolveLegacyProps(propsOf('Mirror'), values);
    expect(values).toEqual({ src: 'pricing', anchor: 'plans' });
  });
});

describe('propDescription', () => {
  test('says which older spelling a renamed prop still accepts', () => {
    const name = propsOf('Mirror').find((prop) => prop.name === 'name');
    if (!name) throw new Error('no Mirror name prop');
    expect(propDescription(name)).toBe(
      'Name of the `<MirrorSource>` block in the source doc. Also read as `anchor`; write `name` instead.',
    );
  });

  test('leaves a prop without an older spelling as described', () => {
    const src = propsOf('Mirror').find((prop) => prop.name === 'src');
    if (!src) throw new Error('no Mirror src prop');
    expect(propDescription(src)).toBe(src.description);
  });
});
