import { useLingui } from '@lingui/react/macro';
import { Button } from '@/components/ui/button';

export function foldEditorsByPrimary<T extends { state: string; detected: boolean }>(
  editors: readonly T[],
  showAll: boolean,
): { shownEditors: T[]; hiddenCount: number } {
  const isPrimary = (editor: T): boolean => editor.state !== 'not-installed' || editor.detected;
  const primaryEditors = editors.filter(isPrimary);
  const foldable = primaryEditors.length > 0 && primaryEditors.length < editors.length;
  const shownEditors =
    !foldable || showAll
      ? [...editors].sort((a, b) => Number(isPrimary(b)) - Number(isPrimary(a)))
      : primaryEditors;
  return { shownEditors, hiddenCount: foldable ? editors.length - primaryEditors.length : 0 };
}

export function ShowMoreRow({
  hiddenCount,
  expanded,
  onToggle,
  testId,
}: {
  hiddenCount: number;
  expanded: boolean;
  onToggle: () => void;
  testId: string;
}) {
  const { t } = useLingui();
  if (hiddenCount === 0) return null;
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        aria-expanded={expanded}
        onClick={onToggle}
        className="w-full justify-center rounded-none font-normal text-muted-foreground text-xs"
        data-testid={testId}
      >
        {}
        {expanded ? t`Show less` : t`Show ${hiddenCount} more`}
      </Button>
    </li>
  );
}
