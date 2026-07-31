import { Trans, useLingui } from '@lingui/react/macro';
import { ListPlus } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Toolbar "Add properties" affordance. PropertyPanel only mounts in WYSIWYG mode
 * (gated in EditorActivityPool), so callers hide this in source mode — clicking
 * it there would fire a CustomEvent with no listener (an unresponsive-UI no-op).
 * Source-mode users edit frontmatter directly in the CodeMirror YAML.
 */
export function AddPropertiesButton({
  onAddProperty,
  className,
}: {
  onAddProperty: () => void;
  className?: string;
}) {
  const { t } = useLingui();
  return (
    <Tooltip>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t`Add properties`}
        onClick={onAddProperty}
        data-testid="add-properties-button"
        className={className}
        asChild
      >
        <TooltipTrigger>
          <ListPlus />
        </TooltipTrigger>
      </Button>
      <TooltipContent side="bottom">
        <Trans>Add properties</Trans>
      </TooltipContent>
    </Tooltip>
  );
}
