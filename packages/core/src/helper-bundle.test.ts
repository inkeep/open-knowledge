import { describe, expect, test } from 'vitest';
import { DESKTOP_PRODUCTS } from './constants/product.ts';
import {
  HELPER_BUNDLE_NAME,
  HELPER_EXECUTABLE_NAME,
  resolveHelperBundleBinary,
} from './helper-bundle.ts';

const PARENT_APP = '/Applications/OpenKnowledge.app';
const PARENT_EXEC = `${PARENT_APP}/Contents/MacOS/OpenKnowledge`;
const HELPER_BINARY = `${PARENT_APP}/Contents/Frameworks/${HELPER_BUNDLE_NAME}/Contents/MacOS/${HELPER_EXECUTABLE_NAME}`;

describe('resolveHelperBundleBinary', () => {
  test('joins the helper-bundle path relative to the parent .app/Contents/MacOS', () => {
    expect(resolveHelperBundleBinary(PARENT_EXEC)).toBe(HELPER_BINARY);
  });

  test('handles a user-Applications path identically', () => {
    const userParent = '/Users/alex/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge';
    expect(resolveHelperBundleBinary(userParent)).toBe(
      `/Users/alex/Applications/OpenKnowledge.app/Contents/Frameworks/${HELPER_BUNDLE_NAME}/Contents/MacOS/${HELPER_EXECUTABLE_NAME}`,
    );
  });

  test('keys off the executable, so a renamed app bundle still resolves', () => {
    expect(
      resolveHelperBundleBinary('/Applications/Renamed.app/Contents/MacOS/OpenKnowledge Beta'),
    ).toBe(
      '/Applications/Renamed.app/Contents/Frameworks/OpenKnowledge Beta Server.app/Contents/MacOS/OpenKnowledge Beta Helper',
    );
  });

  test.each(Object.values(DESKTOP_PRODUCTS))(
    'matches the layout afterPack writes for $productName',
    ({ productName }) => {
      const app = `/Applications/${productName}.app`;
      expect(resolveHelperBundleBinary(`${app}/Contents/MacOS/${productName}`)).toBe(
        `${app}/Contents/Frameworks/${productName} Server.app/Contents/MacOS/${productName} Helper`,
      );
    },
  );
});
