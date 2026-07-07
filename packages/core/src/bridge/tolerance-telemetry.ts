import type { BridgeToleranceSignal } from './parse-equivalence.ts';

export type ToleranceClassSeverity = 'pm-model-caused' | 'parser-caused' | 'serializer-caused';

export interface ToleranceFireRecord {
  timestamp: string;
  className: BridgeToleranceSignal;
  documentName: string | undefined;
  codeUnitPosition: number;
  severity: ToleranceClassSeverity;
}

export type ToleranceTelemetryHook = (record: ToleranceFireRecord) => void;

const SEVERITY_BY_CLASS = {
  'emphasis-around-code': 'pm-model-caused',
  bom: 'parser-caused',
  crlf: 'parser-caused',
  'commonmark-escape': 'parser-caused',
  'leading-newline': 'parser-caused',
  'paragraph-continuation-indent': 'parser-caused',
  'doc-start-thematic': 'parser-caused',
  'block-separator-collapse': 'serializer-caused',
  'table-align-row-spacing': 'serializer-caused',
  'row-no-trailing-pipe': 'serializer-caused',
  'ordered-list-marker-number': 'serializer-caused',
  'list-indent-canonical': 'serializer-caused',
  'jsx-container-boundary-blank': 'serializer-caused',
  'trailing-whitespace': 'serializer-caused',
  'blank-line-collapse': 'serializer-caused',
  'trailing-newline': 'serializer-caused',
  'parse-equivalence': 'parser-caused',
} as const satisfies Record<BridgeToleranceSignal, ToleranceClassSeverity>;

export function classifySeverity(cls: BridgeToleranceSignal): ToleranceClassSeverity {
  return SEVERITY_BY_CLASS[cls];
}

export function findFirstDivergenceIndex(left: string, right: string): number {
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i++) {
    if (left.charCodeAt(i) !== right.charCodeAt(i)) return i;
  }
  if (left.length !== right.length) return len;
  return -1;
}

let hook: ToleranceTelemetryHook | null = null;

export function setToleranceTelemetryHook(h: ToleranceTelemetryHook | null): void {
  hook = h;
}

export function emitToleranceFire(
  classes: readonly BridgeToleranceSignal[],
  left: string,
  right: string,
  documentName: string | undefined,
): void {
  if (!hook || classes.length === 0) return;
  const codeUnitPosition = findFirstDivergenceIndex(left, right);
  const timestamp = new Date().toISOString();
  for (const cls of classes) {
    hook({
      timestamp,
      className: cls,
      documentName,
      codeUnitPosition,
      severity: classifySeverity(cls),
    });
  }
}
