/**
 * Read-only listing of the keyboard shortcuts available in the editor
 * and workspace, grouped by category from the shared shortcut registry.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { Badge } from '@/components/ui/badge';
import { Kbd } from '@/components/ui/kbd';
import {
  formatShortcutBinding,
  formatShortcutTextLabel,
  KEYBOARD_SHORTCUTS,
  SHORTCUT_CATEGORY_LABELS,
  SHORTCUT_CATEGORY_ORDER,
  type ShortcutBinding,
} from '@/lib/keyboard-shortcuts';
import { cn } from '@/lib/utils';

function ShortcutBindingChips({ binding }: { binding: ShortcutBinding }) {
  return formatShortcutBinding(binding)
    .split(' / ')
    .map((part, index) =>
      index === 0 ? (
        <Kbd key={`kbd-${part}`} aria-label={formatShortcutTextLabel(part)}>
          {part}
        </Kbd>
      ) : (
        <span key={`or-${part}`} className="inline-flex items-center gap-1.5">
          <span className="sr-only">
            <Trans> or </Trans>
          </span>
          <span aria-hidden="true"> / </span>
          <Kbd aria-label={formatShortcutTextLabel(part)}>{part}</Kbd>
        </span>
      ),
    );
}

export function HotkeysSection() {
  const { t } = useLingui();
  const titleId = 'settings-hotkeys-title';
  return (
    <section aria-labelledby={titleId} className="space-y-5" data-testid="settings-hotkeys">
      <div className="space-y-1">
        <h3 id={titleId} className="text-base font-semibold">
          <Trans>Hotkeys</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>Keyboard shortcuts available in the editor and workspace.</Trans>
        </p>
      </div>

      <div className="space-y-6" data-testid="settings-hotkeys-list">
        {SHORTCUT_CATEGORY_ORDER.map((category) => {
          const shortcuts = KEYBOARD_SHORTCUTS.filter((shortcut) => shortcut.category === category);
          if (shortcuts.length === 0) return null;

          return (
            <section key={category} aria-labelledby={`settings-hotkeys-${category}`}>
              <h4
                id={`settings-hotkeys-${category}`}
                className="mb-2 font-mono text-muted-foreground text-xs uppercase tracking-wide"
              >
                {t(SHORTCUT_CATEGORY_LABELS[category])}
              </h4>
              <ul
                aria-labelledby={`settings-hotkeys-${category}`}
                className="m-0 list-none overflow-hidden rounded-md border p-0"
              >
                {shortcuts.map((shortcut) => {
                  const shortcutTitleId = `settings-hotkey-${shortcut.id}-title`;
                  const shortcutDescriptionId = `settings-hotkey-${shortcut.id}-description`;
                  const bindingChipCount = shortcut.bindings.reduce(
                    (count, binding) => count + formatShortcutBinding(binding).split(' / ').length,
                    0,
                  );
                  const hasDenseBindings = bindingChipCount > 4;

                  return (
                    <li
                      key={shortcut.id}
                      aria-describedby={shortcutDescriptionId}
                      aria-labelledby={shortcutTitleId}
                      className={cn(
                        'grid gap-2 border-border border-b px-3 py-3 last:border-b-0',
                        hasDenseBindings
                          ? 'sm:grid-cols-1'
                          : 'sm:grid-cols-[minmax(0,1fr)_minmax(0,auto)]',
                      )}
                      data-testid={`settings-hotkey-${shortcut.id}`}
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-sm" id={shortcutTitleId}>
                            {t(shortcut.title)}
                          </p>
                          <Badge variant="gray">
                            <span className="sr-only">
                              <Trans>Scope: </Trans>
                            </span>
                            {t(shortcut.scope)}
                          </Badge>
                        </div>
                        <p className="text-muted-foreground text-sm" id={shortcutDescriptionId}>
                          {t(shortcut.description)}
                        </p>
                      </div>
                      <div
                        className={cn(
                          'flex min-w-0 max-w-full self-start content-start flex-wrap items-start gap-1.5',
                          hasDenseBindings ? 'sm:justify-start' : 'sm:max-w-[38rem] sm:justify-end',
                        )}
                      >
                        {shortcut.bindings.map((binding) => (
                          <ShortcutBindingChips
                            key={`${shortcut.id}-${binding.mac}-${binding.windowsLinux}`}
                            binding={binding}
                          />
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}
