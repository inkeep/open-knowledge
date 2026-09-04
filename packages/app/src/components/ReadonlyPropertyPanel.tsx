import {
  type FrontmatterValue,
  inferType,
  readFmKeys,
  readFmRegionWithError,
} from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { PropertyDisclosure } from '@/components/PropertyDisclosure';
import { PropertyDisplayRow } from '@/components/PropertyDisplayRow';
import { ComplexValueWidget, isComplexValue, TYPE_ICON } from '@/components/PropertyWidgets';

export function ReadonlyPropertyPanel({ text }: { text: string }) {
  const { map } = readFmRegionWithError(text);
  const orderedKeys = readFmKeys(text);
  const renderKeys = orderedKeys.length > 0 ? orderedKeys : Object.keys(map);
  if (renderKeys.length === 0) return null;

  return (
    <PropertyDisclosure
      title={<Trans>Properties</Trans>}
      count={renderKeys.length}
      testId="readonly-property-panel"
      className="pt-4"
    >
      {renderKeys.map((key, idx) => {
        const value = map[key];
        if (value === undefined) return null;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: position-aware key for dup-name rows (matches PropertyPanel).
          <ReadonlyRow key={`${key}-${idx}`} keyName={key} value={value} />
        );
      })}
    </PropertyDisclosure>
  );
}

function ReadonlyRow({ keyName, value }: { keyName: string; value: FrontmatterValue }) {
  const Icon = TYPE_ICON[inferType(value)];
  return (
    <PropertyDisplayRow
      icon={<Icon className="size-3.5" />}
      label={keyName}
      testId="readonly-property-row"
      dataKey={keyName}
    >
      <ReadonlyValue keyName={keyName} value={value} />
    </PropertyDisplayRow>
  );
}

function ReadonlyValue({ keyName, value }: { keyName: string; value: FrontmatterValue }) {
  if (isComplexValue(value)) {
    return <ComplexValueWidget keyName={keyName} value={value} />;
  }
  const display = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').join(', ')
    : String(value);
  return (
    <div
      className="flex min-h-7 items-center px-2 py-1 text-sm break-words"
      data-testid="readonly-property-value"
      data-key={keyName}
    >
      {display}
    </div>
  );
}
