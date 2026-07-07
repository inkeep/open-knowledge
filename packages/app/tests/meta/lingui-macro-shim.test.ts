/**
 * Contract tests for the Bun-test Lingui macro shim.
 *
 * The shim (`tests/lingui-macro-shim.tsx`) is critical infrastructure — every
 * component test that imports a macro-wrapped module runs against it. These
 * tests lock its surface so a regression fails here, loudly and in isolation,
 * rather than surfacing as a confusing failure in some unrelated component
 * test that happens to exercise the broken path.
 *
 * Lives in `tests/meta/` (run by `test:integration`) — `*.test.*` is excluded
 * from `lingui extract` (see `lingui.config.ts`), so the macro-looking calls
 * below never reach the real catalog.
 */
import { describe, expect, test } from 'bun:test';
import { msg, Plural, plural, Select, select, Trans, t, useLingui } from '../lingui-macro-shim';

describe('lingui-macro-shim — @lingui/core/macro', () => {
  test('t / msg as a tagged template interpolate values', () => {
    const name = 'Ada';
    expect(t`Hello ${name}`).toBe('Hello Ada');
    expect(msg`Hello ${name}`).toBe('Hello Ada');
  });

  test('t / msg as a descriptor object return the message', () => {
    expect(t({ message: 'Back', comment: 'nav' })).toBe('Back');
    expect(msg({ message: 'Save', comment: 'toolbar' })).toBe('Save');
  });

  test('t descriptor interpolates {placeholder} values', () => {
    expect(t({ message: 'Hello {name}', values: { name: 'Ada' } })).toBe('Hello Ada');
  });

  test('t descriptor falls back to id when message is absent', () => {
    expect(t({ id: 'greeting.hello' })).toBe('greeting.hello');
  });

  test('t passes a plain string straight through (the t(msg`…`) shape)', () => {
    // The shim's `msg` returns a string (English passthrough), and real
    // code calls `t(msg`…`)` / `t(MESSAGE_MAP[key])` — so `t` reaches the
    // shim with a string and must return it verbatim, not `''`.
    expect(t(msg`Word wrap`)).toBe('Word wrap');
    expect(t('Already resolved')).toBe('Already resolved');
  });

  test('plural picks the branch and substitutes #', () => {
    expect(plural(1, { one: '# item', other: '# items' })).toBe('1 item');
    expect(plural(5, { one: '# item', other: '# items' })).toBe('5 items');
  });

  test('plural treats value=0 as other (English has no zero plural form)', () => {
    expect(plural(0, { one: '# item', other: '# items' })).toBe('0 items');
  });

  test('select picks the matching case, falling back to other', () => {
    expect(select('admin', { admin: 'Admin', other: 'User' })).toBe('Admin');
    expect(select('guest', { admin: 'Admin', other: 'User' })).toBe('User');
  });
});

describe('lingui-macro-shim — @lingui/react/macro', () => {
  test('useLingui exposes a working t and i18n', () => {
    const { t: lt, i18n } = useLingui();
    expect(lt`Hi ${'there'}`).toBe('Hi there');
    expect(typeof i18n).toBe('object');
  });

  test('useLingui()._ resolves a descriptor (no [object Object])', () => {
    const { _ } = useLingui();
    expect(_('Already a string')).toBe('Already a string');
    expect(_({ message: 'From descriptor' })).toBe('From descriptor');
    expect(_({ message: 'Hi {who}' }, { who: 'Ada' })).toBe('Hi Ada');
  });

  test('Trans / Plural / Select are component functions', () => {
    expect(typeof Trans).toBe('function');
    expect(typeof Plural).toBe('function');
    expect(typeof Select).toBe('function');
  });

  test('Trans renders its children passthrough', () => {
    const out = Trans({ children: 'hello world' }) as { props?: { children?: unknown } };
    expect(out?.props?.children).toBe('hello world');
  });

  test('Trans renders message + values when given the descriptor-prop form', () => {
    const out = Trans({ message: 'Hello {name}', values: { name: 'Ada' } }) as {
      props?: { children?: unknown };
    };
    expect(out?.props?.children).toBe('Hello Ada');
  });

  test('Plural substitutes # and selects the branch', () => {
    const out = Plural({ value: 3, one: '# message', other: '# messages' }) as {
      props?: { children?: unknown };
    };
    expect(out?.props?.children).toBe('3 messages');
  });
});
