import { isTestOnlySourceFile } from '../../../test-support/test-only-source-file.mjs';

declare const path: string;
declare const suffix: string;

export const p01 = path.endsWith('.test.ts');
export const p02 = !path.endsWith('.test.tsx');
export const p03 = path.endsWith('.test-helper.ts');
export const p04 = path.endsWith('.type-tests.ts');
// biome-ignore lint/complexity/useLiteralKeys: the fixture exercises a computed method name
export const p05 = path['endsWith'](`.test.ts`);
export const p06 = path?.endsWith('.test.ts');
export const p07 = path.includes('.test.');
export const p08 = path.includes('.test-helper.');
export const p09 = path.includes('.type-tests.');
export const p10 = /\.test\.tsx?$/.test(path);
export const p11 = /\.type-tests\.ts$/.exec(path);
export const p12 = path.match(/\.test-helper\.ts$/);
export const p13 = path.search(/\.test\.(?:ts|tsx)$/);
export const p14 = path.endsWith('.e2e.ts');
export const p15 = path.includes('.e2e.');

export const n01 = isTestOnlySourceFile(path);
export const n02 = isTestOnlySourceFile(path, 'vitest');
export const n03 = path.endsWith('.ts');
export const n04 = path.endsWith('.d.ts');
export const n05 = path.endsWith('named.test.ts');
export const n06 = path.includes('tests/');
export const n07 = path.endsWith(suffix);
export const n08 = /\.tsx?$/.test(path);
export const n09 = path.replace(/\.test\.ts$/, '');
export const n10 = "path.endsWith('.test.ts')";
export const n11 = /named\.test\.ts$/.test(path);
export const n12 = path.endsWith('.test.ts.bak');
export const n13 = /\.test\.[cm]?[jt]sx?$/.test(path);
