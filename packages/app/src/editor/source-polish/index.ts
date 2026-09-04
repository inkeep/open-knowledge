import type { Extension } from '@codemirror/state';
import { brokenRefField } from './broken-ref-field';
import { sourcePolishViewPlugin } from './view-plugin';

export function createSourcePolishExtension(): Extension {
  return [sourcePolishViewPlugin, brokenRefField];
}
