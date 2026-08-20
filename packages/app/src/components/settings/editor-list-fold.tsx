/**
 * The one ranking contract for Settings editor lists — user-global
 * (`AiToolsSection`) and project (`ProjectAiToolsSection`) consume the same
 * fold so the two scopes can never rank the same machine differently.
 *
 * Yours first, the rest folded. A row is primary when OK has WIRED it
 * (`installed`, `foreign`, or `unmanageable` — its config file exists, which is
 * what makes the tool real), or when the editor is detected.
 *
 * Detection ORDERS but never CLAIMS. That is one rule across every agent list:
 * the external-apps group lets its probe pick a row's default, these lists let
 * the probe pick a row's position, and neither prints an assertion of presence
 * on the row. No surface prints `Detected on this machine`, precisely so the
 * signal can stay useful for ranking without being read as a fact.
 *
 * The signal is a probe of the machine — a CLI on the login-shell PATH, or the
 * app the OS says owns the URL scheme — and it answers "is this tool here",
 * not "did the user set it up with us". Those are different questions, so
 * ranking is the most it earns. A row it lifts still shows `How to set up`,
 * never a presence claim.
 */

import { useLingui } from '@lingui/react/macro';
import { Button } from '@/components/ui/button';

export function foldEditorsByPrimary<T extends { state: string; detected: boolean }>(
  editors: readonly T[],
  showAll: boolean,
): { shownEditors: T[]; hiddenCount: number } {
  const isPrimary = (editor: T): boolean => editor.state !== 'not-installed' || editor.detected;
  const primaryEditors = editors.filter(isPrimary);
  // Nothing configured and nothing detected would otherwise fold the entire list
  // away and leave an empty box under the heading. A fold that hides everything
  // is not a fold.
  const foldable = primaryEditors.length > 0 && primaryEditors.length < editors.length;
  const shownEditors =
    !foldable || showAll
      ? [...editors].sort((a, b) => Number(isPrimary(b)) - Number(isPrimary(a)))
      : primaryEditors;
  return { shownEditors, hiddenCount: foldable ? editors.length - primaryEditors.length : 0 };
}

/** The fold's disclosure row. Renders nothing when the list isn't foldable. */
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
        {/* Never names what the probe thinks of the hidden rows: an
            "N not found" label would reassert the same unbacked detection
            claim this surface removed, one line lower. The noun is left off
            to reuse the Configure agents msgid verbatim — a counted noun
            would need plural forms in every locale to buy a word the "MCP
            connections" heading above already supplies. */}
        {expanded ? t`Show less` : t`Show ${hiddenCount} more`}
      </Button>
    </li>
  );
}
